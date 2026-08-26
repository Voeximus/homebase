// Homebase bank feed — one multiplexed Plaid function (READ-ONLY).
//
// Actions (POST { action, ... }):
//   link_token — make a Link token (browser opens Link). connection_id ⇒ update mode.
//   exchange   — public_token → access_token (stored in Vault) → discover accounts → first sync.
//   sync       — pull /transactions/sync, reconcile, write posted rows + bank-truth balances.
//
// The Plaid secret and the bank access_token live server-side ONLY — never sent
// to the browser. Triggers that hit `sync`: the Plaid webhook (real-time, app
// closed — see plaid-webhook), the daily pg_cron job, and a client "refresh".
//
// AUTHORIZATION: every request must pass denyUnlessCaller() — a signed-in
// household user, or an internal service-role call. `verify_jwt = true` alone is
// NOT an authorization check: it accepts the publishable key, which ships in the
// public browser bundle, so it left `disconnect` (a service-role hard delete of
// the entire ledger) reachable by anyone on the internet. See _shared/callerAuth.ts.
//
// Categorization reuses your full trained library (categorizeData + classify +
// learned merchant_rules); low-confidence rows are flagged needs_review for the
// existing one-tap clarify UI. Only "variable" living spend is inserted.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcile, type NormalRow, type PlaidTxn } from "../_shared/plaidSync.ts";
import { classify, classifyCredit, isPaycheck, merchantKey, matchRecurringName, type LearnedRules } from "../_shared/categorize.ts";
import { denyUnlessCaller } from "../_shared/callerAuth.ts";

const PLAID_ENV = Deno.env.get("PLAID_ENV") ?? "sandbox";
const PLAID_BASE = `https://${PLAID_ENV}.plaid.com`;
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
const PLAID_REDIRECT_URI = Deno.env.get("PLAID_REDIRECT_URI"); // set in production (OAuth)

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

async function plaid(path: string, body: Record<string, unknown>) {
  const r = await fetch(PLAID_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`plaid ${path} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const contentKey = (r: NormalRow) =>
  `${r.date}|${r.amount.toFixed(2)}|${merchantKey(r.description)}`;

// Which balance is "truth": for checking/savings the spendable (available)
// balance — what's actually there after pending holds, matching what you see in
// the bank app; for a credit card the current balance — the amount owed.
function pickBalance(a: any): number {
  const b = a.balances ?? {};
  if (a.type === "depository") return b.available ?? b.current ?? 0;
  return b.current ?? b.available ?? 0;
}

// The "still processing" hold: for a checking/savings account it's the gap
// between the posted (current) and spendable (available) balance — i.e. the
// pending debits the bank is holding but hasn't itemized to us yet. Cards put
// pending charges straight into their current balance, so there's no separate
// hold to surface there → 0.
function pickHold(a: any): number {
  const b = a.balances ?? {};
  if (a.type !== "depository") return 0;
  if (b.current == null || b.available == null) return 0;
  return Math.max(0, Number(b.current) - Number(b.available));
}

// Resolve a bill payment to its idempotent appliesTo. Attributes to the bill
// CYCLE the payment settles: the earliest due date it lands on/before, or at most
// GRACE days after — so an early payment (Jun 30 toward a Jul-17 bill) rolls to
// the NEXT cycle, while on-time/slightly-late stays on the current one. MIRROR of
// billCycleFor in src/lib/schedule.ts — keep the two in step.
function billAppliesTo(rec: { id: string; dueDays?: number[] }, date: string) {
  const [py, pm, pd] = date.split("-").map(Number);
  const rawDays = rec.dueDays && rec.dueDays.length ? rec.dueDays : [pd];
  const days = [...rawDays].sort((a, b) => a - b); // stable ordinal for installmentIndex
  const GRACE_MS = 7 * 86400000;
  const pay = Date.UTC(py, pm - 1, pd);
  const cands: { y: number; m: number; day: number; idx: number; due: number }[] = [];
  for (const off of [0, 1]) {
    const y = pm - 1 + off >= 12 ? py + 1 : py;
    const m0 = (pm - 1 + off) % 12;
    const dim = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
    days.forEach((dd, idx) => {
      const day = Math.min(dd, dim);
      cands.push({ y, m: m0, day, idx, due: Date.UTC(y, m0, day) });
    });
  }
  cands.sort((a, b) => a.due - b.due);
  const c = cands.find((k) => pay <= k.due + GRACE_MS) ?? cands[cands.length - 1];
  const monthKey = `${c.y}-${String(c.m + 1).padStart(2, "0")}`;
  // Cycle identity keys on the installment ORDINAL (idx), not the derived day — so a
  // manual "paid" row (posting-day) and its feed twin (due-day) collapse to the SAME
  // cycle instead of drifting into a double-count. See installmentIndexForDay below.
  return { kind: "bill", recurringId: rec.id, monthKey, day: c.day, installmentIndex: c.idx, settled: true } as const;
}

// Is a recurring row live on the date a payment posted? A week of slack on each
// edge, matching the GRACE window billAppliesTo uses, so paying a few days either
// side of a window boundary still resolves to the right bill.
function liveOnDate(r: { starts_on?: string | null; ends_on?: string | null }, iso: string): boolean {
  const shift = (d: string, days: number) => {
    const t = Date.parse(d + "T00:00:00Z");
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
  };
  if (r.starts_on && iso < shift(r.starts_on, -7)) return false;
  if (r.ends_on && iso > shift(r.ends_on, 7)) return false;
  return true;
}

// Which installment slot (ordinal in the sorted due_days) a STORED applies_to.day
// belongs to — so the paidBill seed keys old/manual rows the SAME way billAppliesTo
// keys incoming feed rows. Single-due-day bills always → 0 (one settled per cycle);
// multi-due-day bills (Mom on the 15th & 30th) keep their two installments distinct.
function installmentIndexForDay(dueDays: number[] | undefined | null, day: number): number {
  const days = (dueDays && dueDays.length ? [...dueDays] : [day]).sort((a, b) => a - b);
  if (days.length <= 1) return 0;
  let best = 0, bestGap = Infinity;
  days.forEach((d, i) => {
    const g = Math.abs(d - day);
    if (g < bestGap) { bestGap = g; best = i; }
  });
  return best;
}

// Last-resort match for a payment the categorizer KNOWS is a bill (kind:"bill")
// but whose descriptor name-matched no recurring row. Snap to an UNPAID out-bill
// only when it's unambiguous: a scheduled due day within ±3 of the posted day AND
// an amount within $15 (or 15%). If two bills could fit (e.g. similar amounts a
// few days apart) we return null and let it fall to "needs review" rather than
// risk attributing the payment to the wrong bill — false positives are costlier
// than a one-tap fix on this live, no-sandbox ledger.
function matchBillByDayAmount(
  recs: any[],
  date: string,
  amount: number,
  paidBill: Set<string>,
): any | null {
  const monthKey = date.slice(0, 7);
  const postDay = parseInt(date.slice(8, 10), 10);
  const candidates: any[] = [];
  for (const r of recs) {
    const days: number[] = Array.isArray(r.due_days) && r.due_days.length ? r.due_days : [];
    if (!days.length) continue; // need a scheduled day — never auto-settle on amount alone
    const nearest = days.reduce((b, d) => (Math.abs(d - postDay) < Math.abs(b - postDay) ? d : b), days[0]);
    if (Math.abs(nearest - postDay) > 3) continue;
    if (paidBill.has(`${r.id}|${monthKey}|${nearest}`)) continue;
    // Coerce the DB numeric (arrives as a string) so the amount filter actually
    // runs. NEVER auto-settle on day proximity alone — a bill with no modeled
    // amount (0/null) is skipped. Fixed bills must match tightly — a $21.62 sub
    // can't absorb a $10.59 one — while variable bills keep generous slack.
    const ramt = Number(r.amount);
    if (!(ramt > 0)) continue;
    const amtGap = Math.abs(amount - ramt);
    const tol = r.variable ? Math.max(15, 0.15 * ramt) : Math.max(2, 0.03 * ramt);
    if (amtGap > tol) continue;
    candidates.push(r);
  }
  return candidates.length === 1 ? candidates[0] : null; // only when unambiguous
}

// --- actions ------------------------------------------------------------------

async function linkToken(p: any) {
  const body: Record<string, unknown> = {
    user: { client_user_id: String(p.owner ?? "homebase") },
    client_name: "Homebase",
    country_codes: ["US"],
    language: "en",
  };
  if (p.connection_id) {
    const { data: token, error } = await admin.rpc("get_connection_token", { p_conn_id: p.connection_id });
    if (error) throw new Error("get_connection_token: " + error.message);
    body.access_token = token; // update mode (reconnect)
  } else {
    body.products = ["transactions"];
  }
  if (PLAID_REDIRECT_URI) body.redirect_uri = PLAID_REDIRECT_URI; // required for OAuth banks
  const webhook = Deno.env.get("PLAID_WEBHOOK_URL");
  if (webhook) body.webhook = webhook; // Plaid pings this on new transactions
  const r = await plaid("/link/token/create", body);
  return json({ link_token: r.link_token });
}

// Point every existing linked item at our webhook URL, so new charges trigger a
// near-instant sync + push (idempotent — safe to re-run).
async function setWebhook() {
  const url = Deno.env.get("PLAID_WEBHOOK_URL");
  if (!url) return json({ error: "PLAID_WEBHOOK_URL not set" }, 400);
  const { data: conns } = await admin.from("bank_connections").select("id");
  const out: Record<string, unknown>[] = [];
  for (const c of conns ?? []) {
    const { data: token } = await admin.rpc("get_connection_token", { p_conn_id: c.id });
    if (!token) {
      out.push({ id: c.id, error: "no token" });
      continue;
    }
    try {
      await plaid("/item/webhook/update", { access_token: token, webhook: url });
      out.push({ id: c.id, ok: true });
    } catch (e) {
      out.push({ id: c.id, error: String((e as Error)?.message ?? e).slice(0, 150) });
    }
  }
  return json({ set: out });
}

async function exchange(p: any) {
  const ex = await plaid("/item/public_token/exchange", { public_token: p.public_token });

  const { data: connId, error } = await admin.rpc("store_connection", {
    p_owner: p.owner ?? "Joint",
    p_provider: "plaid",
    p_institution: p.institution ?? "Bank",
    p_item_id: ex.item_id,
    p_access_token: ex.access_token,
  });
  if (error) throw new Error("store_connection: " + error.message);

  const acc = await plaid("/accounts/get", { access_token: ex.access_token });
  let order = 100;
  for (const a of acc.accounts) {
    await admin.from("accounts").insert({
      name: a.official_name || a.name,
      owner: p.owner ?? "Joint",
      last4: a.mask ?? null,
      type: a.subtype || a.type || "checking",
      balance: pickBalance(a),
      sort_order: order++,
      connection_id: connId,
      provider_account_id: a.account_id,
      balance_synced_at: new Date().toISOString(),
    });
  }

  const result = await syncConnection(connId as unknown as string);
  return json({ connection_id: connId, accounts: acc.accounts.length, ...result });
}

async function syncConnection(connId: string, force = false) {
  try {
    const { data: token, error: tErr } = await admin.rpc("get_connection_token", { p_conn_id: connId });
    if (tErr) throw new Error("get_connection_token: " + tErr.message);
    if (!token) throw new Error("no token for connection " + connId);

    // a manual Refresh nudges Plaid to re-pull from the bank (async, rate-limited)
    if (force) await plaid("/transactions/refresh", { access_token: token }).catch((e) => console.warn("refresh:", String(e)));

    // load the trained categorizer rules (a learned one-tap answer wins first)
    const { data: rules } = await admin
      .from("merchant_rules")
      .select("pattern, kind, category_id, bill_name");
    const learned: LearnedRules = {};
    for (const r of rules ?? []) {
      learned[r.pattern] = { kind: r.kind, categoryId: r.category_id ?? undefined, billName: r.bill_name ?? undefined };
    }

    // active recurring bills (to match feed bill-payments to) + already-recorded
    // bill installments (so we never double-mark a manual / prior-import / re-sync one)
    const { data: recRows } = await admin
      .from("recurring")
      .select("id, name, due_days, amount, direction, variable, category_id, starts_on, ends_on")
      .eq("active", true);
    // Only out-direction bills are payment targets (never match a paycheck/transfer).
    const outRecs = (recRows ?? []).filter((r: any) => r.direction === "out");

    // Feed-tracked NON-bank debts (Affirm, Mom-China): a feed outflow whose
    // description contains the debt's track_pattern is a payment on it. We record
    // it (appliesTo=debt) and later recompute balance = baseline − sum(payments).
    // select("*") so a deploy BEFORE schema_v14 just yields no track_pattern → the
    // list is empty and tracking stays dormant (no broken query).
    const { data: debtRows } = await admin.from("debts").select("*");
    // Armed = pattern + a FIXED baseline + a since-date, and NOT a bank-linked card
    // (those are owned by the v12 trigger). tracked_baseline must be present — never
    // fall back to the live balance, or the recompute would re-subtract every sync.
    const trackedDebts = (debtRows ?? []).filter(
      (d: any) => d.track_pattern && d.tracked_baseline != null && !d.provider_account_id,
    );
    const matchTrackedDebt = (desc: string) => {
      const up = (desc || "").toUpperCase();
      return trackedDebts.find((d: any) => up.includes(String(d.track_pattern).toUpperCase()));
    };
    const { data: paidRows } = await admin
      .from("transactions")
      .select("applies_to, provider_txn_id")
      .not("applies_to", "is", null);
    // Map recurringId → its due_days so we can key a stored bill row on its
    // installment ordinal (stable) rather than its drift-prone posting day.
    const dueDaysById: Record<string, number[] | undefined> = {};
    for (const r of outRecs) dueDaysById[r.id as string] = (r.due_days ?? undefined) as number[] | undefined;
    const cycleKey = (at: any) =>
      `${at.recurringId}|${at.monthKey}|${at.installmentIndex ?? installmentIndexForDay(dueDaysById[at.recurringId], at.day)}`;
    const paidBill = new Set<string>();
    const seenProviderIds = new Set<string>();
    for (const t of paidRows ?? []) {
      const at = (t as any).applies_to;
      if (at?.kind === "bill") paidBill.add(cycleKey(at));
      if ((t as any).provider_txn_id) seenProviderIds.add((t as any).provider_txn_id);
    }

    // fresh balances + our account map
    const accResp = await plaid("/accounts/get", { access_token: token });
    const balByProv: Record<string, number> = {};
    const holdByProv: Record<string, number> = {};
    for (const a of accResp.accounts) {
      balByProv[a.account_id] = pickBalance(a);
      holdByProv[a.account_id] = pickHold(a);
    }

    const { data: ourAccts } = await admin
      .from("accounts")
      .select("id, provider_account_id")
      .eq("connection_id", connId);
    const acctIdByProv: Record<string, string> = {};
    for (const a of ourAccts ?? []) {
      if (a.provider_account_id) acctIdByProv[a.provider_account_id] = a.id;
    }

    // pull the sync delta from the stored cursor
    const { data: conn } = await admin.from("bank_connections").select("cursor").eq("id", connId).single();
    let cursor: string | undefined = conn?.cursor ?? undefined;
    const added: PlaidTxn[] = [], modified: PlaidTxn[] = [], removed: { transaction_id: string }[] = [];
    for (let page = 0; page < 50; page++) {
      const s = await plaid("/transactions/sync", { access_token: token, cursor });
      added.push(...s.added);
      modified.push(...s.modified);
      removed.push(...s.removed);
      cursor = s.next_cursor;
      if (!s.has_more) break;
    }

    // Arm the content-level dedup guard (it was built and then never passed in,
    // so nothing was guarding anything). The DB's unique index is scoped to
    // (provider, provider_txn_id) and therefore only stops the SAME Plaid item
    // re-delivering a row. It cannot see the duplicate that actually hurts: the
    // app's only bank-link path mints a NEW item — `link_token`'s connection_id
    // branch is unreachable from the UI, so "Connect a bank" is the whole
    // vocabulary for fixing a stale login — and a new item re-delivers the entire
    // history under NEW ids. Unarmed, that inserted a SECOND copy of every
    // charge: variable spend and income double, and tracked-debt payments double,
    // which then drives those debt balances TOO LOW through the baseline − paid
    // recompute below. The same gap re-fed any row already entered by hand or by
    // CSV/PDF import.
    //
    // What goes in the set, and why the scope is this narrow:
    //   • rows with NO provider_txn_id — hand-entered / imported: the overlap case
    //   • feed rows this connection does NOT own — the older item after a re-link
    //   • but NEVER this connection's own feed rows: they are already covered by
    //     the unique index, and their keys would make a SECOND genuinely identical
    //     charge (two same-price fills at the same station on one day, arriving in
    //     different syncs) look like a duplicate and vanish from spend
    //   • posted only: a pending row is display-only and excluded from budget
    //     math, so letting a stale one absorb a posted charge would HIDE money
    // knownProviderIds carries every id we already store — reconcile skips the
    // content check for those, which is what keeps a cursor-reset re-pull a heal
    // instead of a no-op.
    const postedDelta = [...added, ...modified].filter((t) => !t.pending);
    const existingKeys = new Set<string>();
    const knownProviderIds = new Set<string>();
    if (postedDelta.length) {
      const dates = postedDelta.map((t) => t.date).sort();
      const ourAcctIds = new Set((ourAccts ?? []).map((a: any) => a.id));
      // Page explicitly: PostgREST caps a select (1000 rows by default) and
      // truncates SILENTLY, and a first sync can span 24 months — a half-armed
      // guard would look like it worked and still double part of the history.
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: prior, error: dErr } = await admin
          .from("transactions")
          .select("date, amount, type, description, account_id, provider_txn_id, status")
          .gte("date", dates[0])
          .lte("date", dates[dates.length - 1])
          .range(from, from + PAGE - 1);
        // Fail CLOSED. A scan we can't trust means we can't tell a new charge from
        // a re-delivered one, and the cursor isn't persisted until the end, so the
        // next sync simply re-pulls the same delta. A retried sync beats a doubled
        // ledger.
        if (dErr) throw new Error("dedup scan: " + dErr.message);
        for (const r of prior ?? []) {
          if (r.provider_txn_id) knownProviderIds.add(r.provider_txn_id as string);
          if (r.status !== "posted") continue;
          if (r.provider_txn_id && ourAcctIds.has(r.account_id)) continue;
          // Signed the way NormalRow is (− = spend) and merchant-keyed the way
          // importStatement's dupeKey is, so all three write paths agree on what
          // "the same purchase" means.
          const signed = r.type === "income" ? Number(r.amount) : -Number(r.amount);
          existingKeys.add(`${r.date}|${signed.toFixed(2)}|${merchantKey(r.description ?? "")}`);
        }
        if ((prior?.length ?? 0) < PAGE) break;
      }
    }

    const ops = reconcile({ added, modified, removed }, contentKey, existingKeys, knownProviderIds);
    if (ops.absorbed.length) {
      // Never silent: an absorb means the bank's copy was dropped in favour of a
      // row already in the ledger, and that has to be readable in the logs.
      console.log(
        `dedup: absorbed ${ops.absorbed.length} already-in-ledger row(s) — ` +
          ops.absorbed
            .map((r) => `${r.date} ${r.amount.toFixed(2)} ${r.description}`)
            .join("; ")
            .slice(0, 500),
      );
    }

    // group posted rows: living-spend by account, and BILL payments (matched to a
    // recurring) recorded as appliesTo=bill so they auto-mark paid + log the real
    // amount. Income / transfers (skip) are dropped.
    const postedByAcct: Record<string, any[]> = {};
    const billByAcct: Record<string, any[]> = {};
    for (const row of ops.upsertPosted) {
      // Incoming money: capture real income so it's VISIBLE and a reimbursement
      // payback can be matched against it. Internal transfers between our OWN
      // accounts are the same dollars moving (not new money) → drop. Balance comes
      // from the bank's reported figure, so inserting income never distorts it.
      if (row.amount > 0) {
        if (classifyCredit(row.description) === "transfer") continue;
        (postedByAcct[row.accountId] ??= []).push({
          provider_txn_id: row.providerTxnId,
          provider_account_id: row.accountId,
          date: row.date,
          amount: Math.abs(row.amount),
          type: "income",
          category_id: isPaycheck(row.description) ? "paycheck" : "other-income",
          description: row.description,
          raw_description: row.raw,
          needs_review: false,
        });
        continue;
      }
      // A payment on a feed-tracked debt (Affirm / Mom-China via Remitly). Only
      // OUTFLOWS (− in our sign convention) count — a refund must never reduce
      // the debt. Recorded settled (out of the budget); the debt balance is
      // recomputed from the sum of these below.
      const td = row.amount < 0 ? matchTrackedDebt(row.description) : undefined;
      const c = classify(row.description, row.amount, learned, row.raw);
      if (!td && c.kind === "skip") continue;
      if (td || c.kind === "bill") {
        // Resolve to a recurring row tolerant of name drift (normalized / merchant
        // key). If the categorizer NAMED a bill but it doesn't resolve to a row,
        // that's a modeling gap → fall through to needs_review (below) rather than
        // risk the blind day+amount heuristic auto-settling the WRONG bill. Reserve
        // that heuristic for a payment the categorizer couldn't name at all.
        //
        // A tracked debt used to `continue` here BEFORE this ran, so a charge that
        // is BOTH a tracked debt and a modeled monthly bill only ever settled the
        // debt. Cherry is exactly that (debts.track_pattern 'CHERRY' + a $151.72
        // monthly recurring row): August's payment landed, the debt dropped, and
        // the Bills tab still showed Cherry unpaid for the month. Now the two are
        // merged into ONE applies_to that carries both links.
        // The blind day+amount heuristic stays reserved for a payment the
        // categorizer knows is a BILL but couldn't name. A tracked debt whose
        // classification is "skip" (Affirm, Remitly) must never reach it — it
        // would let an unrelated bill of a similar size on a nearby day absorb a
        // debt payment.
        // Narrow to bills whose window actually covers this payment before
        // matching. Two car-insurance rows both answer to "Car insurance" — one
        // running to 30 Nov 2026, its replacement starting 1 Feb 2027 — and only
        // the window separates them. A week of slack on each edge so an early or
        // slightly late payment still finds its bill.
        const liveRecs = outRecs.filter((r: any) => liveOnDate(r, row.date));
        const matched =
          matchRecurringName(c.billName, liveRecs) ??
          matchRecurringName(c.billName, outRecs) ??
          (c.kind === "bill" && !c.billName
            ? matchBillByDayAmount(outRecs, row.date, Math.abs(row.amount), paidBill)
            : null);
        // A bill payment inherits its bill's category (housing / utilities / …)
        // rather than the flat "other" it used to get. That matters most for the
        // extra-payment path below, which carries no applies_to and is therefore
        // GRADED — an extra Verizon payment must land in `utilities` (outside the
        // discretionary envelope by design), not in the $125/mo Misc line.
        const billCat = (matched?.category_id as string | undefined) ?? c.appCategory ?? "other";
        if (matched) {
          const rec = { id: matched.id as string, dueDays: (matched.due_days ?? undefined) as number[] | undefined };
          const at = billAppliesTo(rec, row.date);
          const key = `${rec.id}|${at.monthKey}|${at.installmentIndex}`;
          // This installment is already recorded (manual entry, prior import, or
          // an earlier catch-up payment in the same cycle) and this is NOT that
          // same feed row re-syncing.
          //
          // This used to `continue` — the row was discarded outright, written
          // nowhere, with no trace anywhere in the app. It cost real visibility:
          // Verizon was paid twice in August ($209.45 on the 3rd catching up, then
          // $93.03 on the 24th) and the second payment simply did not exist in the
          // ledger. Same for two of the three $6 parking charges. Money that left
          // the account must always be recorded. It just must not settle a cycle
          // that is already settled — so it keeps the bill's category, carries no
          // applies_to, and is flagged for a look.
          if (paidBill.has(key) && !seenProviderIds.has(row.providerTxnId)) {
            // Never silent. This row is being re-routed away from the bill it
            // named, which is a reclassification, and every reclassification has
            // to be readable in the logs — the same rule the dedup absorb follows.
            console.log(
              `extra payment: ${row.date} ${Math.abs(row.amount).toFixed(2)} ${row.description} ` +
                `— ${matched.name} ${at.monthKey} was already settled; recorded as spending, not as the bill`,
            );
            (postedByAcct[row.accountId] ??= []).push({
              provider_txn_id: row.providerTxnId,
              provider_account_id: row.accountId,
              date: row.date,
              amount: Math.abs(row.amount),
              type: "expense",
              category_id: billCat,
              description: row.description,
              raw_description: row.raw,
              needs_review: true,
            });
            continue;
          }
          (billByAcct[row.accountId] ??= []).push({
            provider_txn_id: row.providerTxnId,
            provider_account_id: row.accountId,
            date: row.date,
            amount: Math.abs(row.amount),
            type: "expense",
            category_id: billCat,
            description: row.description,
            raw_description: row.raw,
            applies_to: td ? { ...at, debtId: td.id } : at,
            needs_review: false,
          });
          paidBill.add(key);
          continue;
        }
        // A tracked debt with no matching bill row keeps its debt-only shape.
        if (td) {
          (billByAcct[row.accountId] ??= []).push({
            provider_txn_id: row.providerTxnId,
            provider_account_id: row.accountId,
            date: row.date,
            amount: Math.abs(row.amount),
            type: "expense",
            category_id: "other",
            description: row.description,
            raw_description: row.raw,
            applies_to: { kind: "debt", debtId: td.id, settled: true },
            needs_review: false,
          });
          continue;
        }
        // bill rule matched but no such recurring row → treat as variable "other"
        (postedByAcct[row.accountId] ??= []).push({
          provider_txn_id: row.providerTxnId,
          provider_account_id: row.accountId,
          date: row.date,
          amount: Math.abs(row.amount),
          type: "expense",
          category_id: "other",
          description: row.description,
          raw_description: row.raw,
          needs_review: true,
        });
        continue;
      }
      // variable living spend
      (postedByAcct[row.accountId] ??= []).push({
        provider_txn_id: row.providerTxnId,
        provider_account_id: row.accountId,
        date: row.date,
        amount: Math.abs(row.amount),
        type: "expense",
        category_id: c.appCategory ?? "other",
        description: row.description,
          raw_description: row.raw,
        needs_review: c.confidence === "low",
        // At a multi-department merchant the category above is a GUESS, so it may
        // seed a new row but must never overwrite one that already has an answer.
        // Without this a re-sync silently re-decides months of history at once.
        keep_category: c.ambiguous === true,
      });
    }

    // write each of our accounts atomically (balance + its posted rows);
    // reverses are global, sent once on the first call (delete is idempotent).
    let reverseSent = false;
    for (const provId of Object.keys(acctIdByProv)) {
      const { error } = await admin.rpc("apply_bank_sync", {
        p_account_id: acctIdByProv[provId],
        p_provider: "plaid",
        p_reported_balance: balByProv[provId] ?? null,
        p_balance_date: new Date().toISOString(),
        p_posted: [...(postedByAcct[provId] ?? []), ...(billByAcct[provId] ?? [])],
        p_reverse: reverseSent ? [] : ops.reverse,
      });
      if (error) throw new Error("apply_bank_sync: " + error.message);
      // display-only "still processing" hold (separate from the atomic money write)
      await admin
        .from("accounts")
        .update({ pending_hold: holdByProv[provId] ?? 0 })
        .eq("id", acctIdByProv[provId]);
      reverseSent = true;
    }

    // If the connection has no mapped accounts, the loop above never ran — flush
    // any pending reversals directly so Plaid `removed` ids aren't lost.
    if (!reverseSent && ops.reverse.length) {
      const { error } = await admin.rpc("apply_bank_sync", {
        p_account_id: null,
        p_provider: "plaid",
        p_reported_balance: null,
        p_balance_date: new Date().toISOString(),
        p_posted: [],
        p_reverse: ops.reverse,
      });
      if (error) throw new Error("apply_bank_sync (reverse flush): " + error.message);
    }

    // Recompute each feed-tracked debt as baseline − sum(its recorded payments
    // since tracked_since). A SET from a recompute (not a decrement) — idempotent
    // across re-syncs and self-correcting if a payment is later reversed. Runs
    // AFTER apply_bank_sync so the new debt-payment rows are already persisted.
    // Skips bank-linked debts (those are owned by the card→debt trigger).
    for (const d of trackedDebts) {
      // Sum on applies_to->>debtId (the debt link), NOT ->>kind — a tracked-debt
      // payment is recorded settled:true so the ledger/recategorize UI never shows
      // it, but keying off the stable debtId means even a hypothetical edit can't
      // silently drop it from the sum. For a tracked debt, only the feed writes a
      // row with this debtId (manual payDebtExtra is guarded off), so this is exact.
      const { data: pays } = await admin
        .from("transactions")
        .select("amount")
        .eq("type", "expense")
        .gte("date", d.tracked_since ?? "1970-01-01")
        .filter("applies_to->>debtId", "eq", d.id);
      const paid = (pays ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
      const newBal = Math.max(0, Number(d.tracked_baseline) - paid); // baseline guaranteed non-null
      if (Number(d.balance) !== newBal) {
        await admin.from("debts").update({ balance: newBal }).eq("id", d.id);
      }
    }

    // --- pending (still-processing) charges -----------------------------------
    // Show charges the instant Plaid sees them, before they post. status='pending'
    // ledger rows: DISPLAY-ONLY (the balance stays bank-truth `available`, which
    // already nets pending holds; the app excludes pending from budget/anomaly
    // math). When a pending charge posts, Plaid links the posted txn to it via
    // pending_transaction_id → reconcile puts that id in pendingRemove → we delete
    // the pending row and the posted path inserts the real one (no double-count).
    // No bill/debt matching here — that runs on the posted row.
    //
    // We delete-then-insert (avoids ON CONFLICT on the partial provider index).
    // The delete is HARD-SCOPED to status='pending' so it can NEVER remove a real
    // posted transaction.
    const removeIds = [...new Set([...ops.pendingRemove, ...ops.pendingUpsert.map((r) => r.providerTxnId)])];
    if (removeIds.length) {
      await admin
        .from("transactions")
        .delete()
        .eq("provider", "plaid")
        .eq("status", "pending")
        .in("provider_txn_id", removeIds);
    }
    const pendingRows: any[] = [];
    for (const row of ops.pendingUpsert) {
      const acctId = acctIdByProv[row.accountId];
      if (!acctId) continue;
      if (row.amount >= 0) continue; // outflows (spend) only — skip pending credits
      const c = classify(row.description, row.amount, learned, row.raw);
      if (c.kind === "skip") continue;
      pendingRows.push({
        date: row.date,
        amount: Math.abs(row.amount),
        type: "expense",
        category_id: c.appCategory ?? "other",
        description: row.description,
          raw_description: row.raw,
        account_id: acctId,
        provider: "plaid",
        provider_txn_id: row.providerTxnId,
        provider_account_id: row.accountId,
        status: "pending",
        needs_review: c.confidence === "low",
      });
    }
    // A plain INSERT, not an upsert. The comment above was describing what this
    // was SUPPOSED to do: the only unique index on (provider, provider_txn_id) is
    // partial, PostgREST renders onConflict with no WHERE predicate, and Postgres
    // then refuses that index as the arbiter — so the statement died at PLAN time
    // with 42P10 on every sync, conflict or not, and no pending row was ever
    // written. The "processing" badge could not appear for any charge while the
    // sync still reported ok. The delete above is hard-scoped to provider='plaid'
    // + status='pending' + these exact ids (removeIds contains every pendingUpsert
    // id), so nothing survives for this insert to collide with.
    let pendingErr: string | null = null;
    if (pendingRows.length) {
      const { error: pErr } = await admin.from("transactions").insert(pendingRows);
      // Deliberately NOT a throw: `cursor` is persisted below, so aborting here
      // would replay this identical delta forever and wedge the connection —
      // strictly worse than losing a display-only row. Make it visible instead.
      if (pErr) {
        pendingErr = `pending insert: ${pErr.message}`;
        console.warn(pendingErr);
      }
    }

    await admin
      .from("bank_connections")
      .update({
        cursor,
        last_sync_at: new Date().toISOString(),
        // The money write succeeded, so the connection is healthy — but this
        // update used to null last_error unconditionally, which is what let the
        // pending failure above stay invisible for as long as it did.
        status: "ok",
        last_error: pendingErr ? pendingErr.slice(0, 400) : null,
        consecutive_failures: 0,
      })
      .eq("id", connId);

    // Summary of what landed this sync — the webhook uses it to push a phone
    // notification ("$X · Merchant"). Posted spend + bills + pending charges.
    const newRows = [
      ...Object.values(postedByAcct).flat(),
      ...Object.values(billByAcct).flat(),
      ...pendingRows,
    ]
      // Income (paychecks/refunds) isn't a charge — keep it out of the "new charge" push.
      .filter((r: any) => r.type !== "income")
      .map((r: any) => ({ description: r.description, amount: r.amount, pending: r.status === "pending" }));

    return {
      posted: ops.upsertPosted.length,
      pending: ops.pendingUpsert.length,
      reversed: ops.reverse.length,
      absorbed: ops.absorbed.length, // already-in-ledger rows the dedup guard held back
      newRows,
    };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const { data: cf } = await admin
      .from("bank_connections")
      .select("consecutive_failures")
      .eq("id", connId)
      .single();
    await admin
      .from("bank_connections")
      .update({
        status: "error",
        last_error: msg.slice(0, 400),
        consecutive_failures: (cf?.consecutive_failures ?? 0) + 1,
      })
      .eq("id", connId);
    throw e;
  }
}

async function syncAll(p: any) {
  if (p.connection_id) return json(await syncConnection(p.connection_id, p.force));
  const { data: conns } = await admin.from("bank_connections").select("id");
  const out: Record<string, unknown>[] = [];
  for (const c of conns ?? []) {
    try {
      out.push({ id: c.id, ...(await syncConnection(c.id, p.force)) });
    } catch (e) {
      out.push({ id: c.id, error: String((e as Error)?.message ?? e) });
    }
  }
  return json({ synced: out });
}

// Remove a connection and everything it owns (its accounts + their feed rows +
// pending). A real "disconnect bank" feature — and the cleanup for sandbox tests.
async function disconnect(p: any) {
  const conn = p.connection_id;
  if (!conn) return json({ error: "connection_id required" }, 400);
  const { data: accts } = await admin.from("accounts").select("id").eq("connection_id", conn);
  const ids = (accts ?? []).map((a: any) => a.id);
  if (ids.length) await admin.from("transactions").delete().in("account_id", ids);
  await admin.from("accounts").delete().eq("connection_id", conn);
  await admin.from("bank_connections").delete().eq("id", conn);
  return json({ disconnected: conn, accounts_removed: ids.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // BEFORE the body is read: an unauthorized caller must never reach an action.
  const denied = await denyUnlessCaller(req, admin, CORS);
  if (denied) return denied;
  try {
    const payload = await req.json();
    switch (payload.action) {
      case "link_token": return await linkToken(payload);
      case "exchange": return await exchange(payload);
      case "sync": return await syncAll(payload);
      case "set_webhook": return await setWebhook();
      case "disconnect": return await disconnect(payload);
      default: return json({ error: `unknown action: ${payload.action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
