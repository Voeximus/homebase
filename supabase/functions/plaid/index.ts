// Homebase bank feed — one multiplexed Plaid function (READ-ONLY).
//
// Actions (POST { action, ... }):
//   link_token — make a Link token (browser opens Link). connection_id ⇒ update mode.
//   exchange   — public_token → access_token (stored in Vault) → discover accounts → first sync.
//   sync       — pull /transactions/sync, reconcile, write posted rows + bank-truth balances.
//   repaired   — after Link in update mode: clear 'needs_reauth' and sync (2026-10-26).
//   disconnect — hard-delete a login's accounts and history; needs confirm = connection_id.
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
import {
  carryCorrection,
  reconcile,
  type CarriedCorrection,
  type PendingCorrection,
  type PlaidTxn,
} from "../_shared/plaidSync.ts";
import {
  billLiveOnPaymentDate,
  billsPayableFrom,
  classify,
  classifyCredit,
  creditCategory,
  creditHistoryFrom,
  forExistingRow,
  isPaycheck,
  matchBillForCharge,
  sharedAccountIds,
  type CreditHistory,
  type LearnedRules,
} from "../_shared/categorize.ts";
import { handNoteToRetire, holderOf, type CycleHolder, type PaidScanRow } from "../_shared/handNote.ts";
import { mayLinkByShape, mayLinkFromAnotherAccount, mayTakeOver, type ChargeStanding } from "../_shared/chargeStanding.ts";
import { pendingFields } from "../_shared/pendingRow.ts";
import { creditFlags, seedFlags, spendHistoryDescriptions } from "../_shared/seedOnly.ts";
import {
  armDedupGuard,
  claimStatementCopy,
  contentKey,
  dedupScanWindow,
  type DedupScanRow,
  type StatementCopy,
} from "../_shared/dedupGuard.ts";
import { readAllPages } from "../_shared/readAllPages.ts";
import { CREDIT_TRANSFER_REASON, droppedLine, uniqueByBankId, type DroppedLineRow } from "../_shared/droppedLines.ts";
import { healthAfterFailure, healthAfterSync } from "../_shared/itemHealth.ts";
import { denyUnlessCaller } from "../_shared/callerAuth.ts";
import { armedTrackedDebts, closedDebtPayment, closedTrackedDebts, trackedDebtFor } from "../_shared/trackedDebts.ts";

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

// Categories a budget LINE claims — i.e. money that gets graded against an
// envelope. Mirrors LEAN_VARIABLE in src/lib/plan.ts; a bill payment must never
// land in one of these. Kept as a literal because edge functions do not share
// src/lib (see ACCOUNTANT_BRIEF rule 11).
const GRADED_CATS = new Set([
  "groceries", "transport", "dining", "shopping", "health",
  "subscriptions", "entertainment", "housing", "pets", "other", "kids",
]);

// contentKey and the loop that arms the duplicate guard live in _shared/dedupGuard.ts
// since 2026-10-10, unchanged, so a test can hold them — see that file for why.

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

// "Is a recurring row live on the date a payment posted?" lived here as liveOnDate until
// 2026-10-24. It is billLiveOnPaymentDate in _shared/categorize.ts now, unchanged, so
// the app's audit narrows bills by the same window this sync does (src/lib/billMatch.ts).

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
    // paidBill is keyed on the installment ORDINAL, not the due day (see
    // cycleKey). Probing with `nearest` — a day, 1–31 — meant this guard could
    // only ever match a single-installment bill due on the 1st, by coincidence.
    // Everywhere else it silently passed, and the heuristic was free to settle a
    // cycle another payment had already claimed.
    if (paidBill.has(`${r.id}|${monthKey}|${installmentIndexForDay(days, nearest)}`)) continue;
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
      // known_amount and cadence since 2026-10-24: a bill paid from another account links
      // only inside the amount band of what one charge toward it should be
      // (billPerCharge in categorize.ts), and those are the two columns that decide it.
      .select("id, name, due_days, amount, known_amount, cadence, direction, variable, category_id, starts_on, ends_on, account_id")
      .eq("active", true);
    // Only out-direction bills are payment targets (never match a paycheck/transfer).
    const outRecs = (recRows ?? []).filter((r: any) => r.direction === "out");

    // The household's shared accounts — the ones owned "Joint" — because a bill paid
    // from an account other than its own links only when one side is shared (see
    // matchBillForCharge). Read across every connection, not just this one: a bill can
    // be set on an account another bank login owns. A failed read leaves the set empty,
    // which switches the cross-account link off and keeps today's behaviour exactly.
    const { data: ownerRows, error: ownerErr } = await admin.from("accounts").select("id, owner");
    if (ownerErr) console.warn("accounts owner read:", ownerErr.message, "— bills link from their own account only this sync");
    const sharedAccts = sharedAccountIds(ownerErr ? [] : ((ownerRows ?? []) as { id: string; owner: string | null }[]));

    // Feed-tracked NON-bank debts (Affirm, Mom-China): a feed outflow whose
    // description contains the debt's track_pattern is a payment on it. We record
    // it (appliesTo=debt) and later recompute balance = baseline − sum(payments).
    // select("*") so a deploy BEFORE schema_v14 just yields no track_pattern → the
    // list is empty and tracking stays dormant (no broken query).
    const { data: debtRows } = await admin.from("debts").select("*");
    // Armed = pattern + a FIXED baseline + a since-date, NOT a bank-linked card (those
    // are owned by the v12 trigger), and — since 2026-10-25 — NOT CLOSED: a paid-off
    // loan whose pattern is the lender's name would take the payments on a new loan from
    // the same lender. The rule and why it is shaped this way: _shared/trackedDebts.ts.
    // Every place below that credits a payment to a debt, or recomputes a debt's
    // balance from its payments, goes through this one list.
    const trackedDebts = armedTrackedDebts(debtRows as any[] | null);
    const matchTrackedDebt = (desc: string) => trackedDebtFor(trackedDebts, desc);
    // The closed ones that would otherwise be armed. They credit nothing and are never
    // recomputed; they are read only so that a payment one of them alone matches is
    // RECORDED instead of dropped (closedDebtPayment, below and in _shared/trackedDebts.ts).
    const closedDebts = closedTrackedDebts(debtRows as any[] | null);
    // Every row already linked to a bill, debt or goal — the record of which bill
    // cycles are settled. This was one unpaged, unordered select with no error
    // check, so two quiet failures were open at once. Past 1,000 linked rows,
    // PostgREST would have returned an arbitrary 1,000 of them, and a cycle missing
    // from paidBill reads as UNPAID: the next payment toward it settles it a second
    // time instead of being recorded as an extra payment. And a failed read came
    // back as no rows at all, which reads as "nothing is paid" — the same double
    // settlement for every bill at once. Paged under a total order now, and a read
    // that fails stops the sync before anything is written (the cursor is only
    // saved at the end, so the next run retries the same delta).
    //
    // More columns since 2026-10-24, so a month held by a hand-made "(already paid)"
    // note can be told from one a real payment holds (handNote.ts). The extra columns
    // are read, never written from here.
    const paidRows = await readAllPages("paid cycles", () =>
      admin
        .from("transactions")
        .select("id, type, amount, provider, account_id, status, applies_to, provider_txn_id, user_categorized, flow_override, splits")
        .not("applies_to", "is", null)
    );
    // Map recurringId → its due_days so we can key a stored bill row on its
    // installment ordinal (stable) rather than its drift-prone posting day.
    const dueDaysById: Record<string, number[] | undefined> = {};
    for (const r of outRecs) dueDaysById[r.id as string] = (r.due_days ?? undefined) as number[] | undefined;
    const cycleKey = (at: any) =>
      `${at.recurringId}|${at.monthKey}|${at.installmentIndex ?? installmentIndexForDay(dueDaysById[at.recurringId], at.day)}`;
    const paidBill = new Set<string>();
    const seenProviderIds = new Set<string>();
    // WHO holds each bill month, beside the bare "it is held" of paidBill — so a month
    // held by a hand note alone can give way to the bank's own charge (handNote.ts).
    // Expenses only, the way the app's checks count a month's payments.
    const cycleHolders = new Map<string, CycleHolder[]>();
    // The link each stored bank row already carries, by its bank id (2026-10-25), so a
    // re-sent row this sync once linked from another account is written back as it is,
    // and one it never linked is not linked now — see chargeStanding.ts.
    const storedLinkById = new Map<string, unknown>();
    for (const t of paidRows) {
      const at = (t as any).applies_to;
      if ((t as any).provider_txn_id) storedLinkById.set(String((t as any).provider_txn_id), at);
      if (at?.kind === "bill") {
        const key = cycleKey(at);
        paidBill.add(key);
        if ((t as any).type === "expense") {
          (cycleHolders.get(key) ?? cycleHolders.set(key, []).get(key)!).push(holderOf(t as PaidScanRow));
        }
      }
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
    // (2026-10-26: "Connect a bank" now repairs the tapping phone's own login when it
    // needs signing in again, in update mode, through that connection_id branch — see
    // repairTarget in src/lib/plaidClient.ts — so the commonest re-link no longer mints a
    // new item. A person can still link the same bank a second time — while nothing is
    // marked broken, or from a phone that is not the login's owner's — and this guard is
    // what stands in that gap.)
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
    let existingKeys = new Set<string>();
    let knownProviderIds = new Set<string>();
    let copies: StatementCopy[] = [];
    if (postedDelta.length) {
      // Three days wider than the delta at each end since 2026-10-10: a statement copy
      // (record_only, no provider) is matched up to three days from the bank's date, so
      // the scan has to reach that far or the copy is never seen. See dedupScanWindow.
      const scanWindow = dedupScanWindow(postedDelta.map((t) => t.date));
      const ourAcctIds = new Set((ourAccts ?? []).map((a: any) => a.id));
      // Page explicitly: PostgREST caps a select (1000 rows by default) and
      // truncates SILENTLY, and a first sync can span 24 months — a half-armed
      // guard would look like it worked and still double part of the history.
      //
      // And page under a TOTAL order. This paged with .range() and no .order(),
      // and without an order Postgres is free to return the rows in a different
      // sequence for each page — so across pages one row could come back twice
      // and another not at all, and a row that never came back is a key the guard
      // never armed: exactly the half-armed guard the paging was added to prevent,
      // only now it would also look like it had read everything. readAllPages
      // applies (date desc, id), which ends in the primary key.
      //
      // Fail CLOSED. A scan we can't trust means we can't tell a new charge from
      // a re-delivered one, and the cursor isn't persisted until the end, so the
      // next sync simply re-pulls the same delta. A retried sync beats a doubled
      // ledger. (readAllPages throws on an error rather than returning a short list.)
      const prior = await readAllPages("dedup scan", () =>
        admin
          .from("transactions")
          .select("date, amount, type, description, account_id, provider_txn_id, status, record_only")
          .gte("date", scanWindow.from)
          .lte("date", scanWindow.to)
      );
      // Signed the way NormalRow is (− = spend) and merchant-keyed the way
      // importStatement's dupeKey is, so all three write paths agree on what
      // "the same purchase" means. The loop is armDedupGuard (_shared/dedupGuard.ts),
      // lifted out on 2026-10-10 so a test can hold it. A STATEMENT COPY — a record_only
      // row with no provider, written by the statement import or by the write door's
      // finance.add_history_row — is armed as a copy rather than an exact key, and is
      // matched a few days either side and in the statement's wording too: those two
      // drifts are exactly how such a row differs from the bank's own delivery of it,
      // and an exact-only match let a cursor reset or a re-link put it in twice.
      ({ existingKeys, knownProviderIds, copies } = armDedupGuard(prior as DedupScanRow[], ourAcctIds));
    }

    const ops = reconcile(
      { added, modified, removed },
      contentKey,
      existingKeys,
      knownProviderIds,
      (row) => claimStatementCopy(copies, row),
    );
    if (ops.absorbed.length) {
      // Never silent: an absorb means the bank's copy was dropped in favour of a
      // row already in the ledger, and that has to be readable in the logs — and
      // how many of them a statement copy took, since that match is the looser one.
      const byCopy = copies.filter((c) => c.claimed).length;
      console.log(
        `dedup: absorbed ${ops.absorbed.length} already-in-ledger row(s)` +
          (byCopy ? ` (${byCopy} by a statement copy within a few days)` : "") +
          " — " +
          ops.absorbed
            .map((r) => `${r.date} ${r.amount.toFixed(2)} ${r.description}`)
            .join("; ")
            .slice(0, 500),
      );
    }

    // What a person already said about the pending rows this sync is about to
    // replace — read NOW, before anything is written, because two writes below
    // delete those rows: apply_bank_sync's reverse list (Plaid sends a pending id in
    // `removed` when it posts) and the pending section's delete-then-insert. FOUND
    // 2026-10-09: the Firestone repair, filed as `car` by hand while pending, came
    // back as `other` the day it posted. See carryCorrection in plaidSync.ts for
    // what carries and what deliberately does not.
    //
    // Two kinds of replacement: a posted row naming its pending row through
    // pending_transaction_id, and a pending row the bank re-sent under the same id
    // (deleted and re-inserted below). Only rows carrying an answer are read.
    // Chunked so the id list stays a sane URL length; paged and ordered anyway,
    // because a short read here would lose an answer without a sound.
    //
    // splits is read too, and a row with one counts as answered whatever its
    // user_categorized says. FOUND 2026-10-09 in review: without it a split pending
    // charge reached its posted row as one category, locked as answered — see the
    // split paragraph of carryCorrection.
    const carryFrom = [
      ...new Set([
        ...ops.upsertPosted.map((r) => r.pendingTxnId).filter((id): id is string => !!id),
        ...ops.pendingUpsert.map((r) => r.providerTxnId),
      ]),
    ];
    const corrections = new Map<string, PendingCorrection>();
    for (let i = 0; i < carryFrom.length; i += 100) {
      const ids = carryFrom.slice(i, i + 100);
      const rows = await readAllPages("pending corrections", () =>
        admin
          .from("transactions")
          .select("provider_txn_id, category_id, user_categorized, flow_override, splits")
          .eq("provider", "plaid")
          .eq("status", "pending")
          .in("provider_txn_id", ids)
          .or("user_categorized.eq.true,flow_override.not.is.null,splits.not.is.null")
      );
      for (const r of rows) {
        corrections.set(r.provider_txn_id as string, {
          categoryId: (r.category_id as string | null) ?? null,
          userCategorized: r.user_categorized === true,
          flowOverride: (r.flow_override as string | null) ?? null,
          splits: r.splits ?? null,
        });
      }
    }

    // Which of this delta's charges the ledger ALREADY holds, read before the loop below
    // decides anything new for them (2026-10-25, see _shared/chargeStanding.ts). The two
    // things the sync learned on 2026-10-24 — linking a bill paid from another account,
    // and a bank charge taking a month from a hand note — are for charges ARRIVING. A row
    // the bank re-sends (Plaid's `modified`, or everything after a cursor reset) is
    // written by apply_bank_sync with `applies_to = coalesce(existing, new)` and no
    // user_categorized guard, so a link decided for it here would land on a row a person
    // may already have answered. The takeover checked this after the loop; the
    // cross-account link did not check it at all, and that was the gap.
    //
    // The dedup scan's ids cover the delta's own dates (three days wider at each end), so
    // they answer for most rows at no cost. Only an outflow they do not cover is asked
    // about, by id — which is every genuinely new charge, and a stored one whose date the
    // bank has moved. A stored PENDING row with the same id counts as stored, on purpose:
    // it may carry a person's answer too, and then the sync keeps today's behaviour.
    //
    // A failed read THROWS, like every read before the first write: nothing has been
    // written, the cursor is only saved at the end, and the next sync replays this delta.
    // Read as "nothing is stored" instead, it would link exactly the rows it must not.
    const storedIds = new Set<string>(knownProviderIds);
    const askLedger = [
      ...new Set(ops.upsertPosted.filter((r) => r.amount < 0 && !storedIds.has(r.providerTxnId)).map((r) => r.providerTxnId)),
    ];
    for (let i = 0; i < askLedger.length; i += 100) {
      const ids = askLedger.slice(i, i + 100);
      const rows = await readAllPages("stored charges", () =>
        admin.from("transactions").select("provider_txn_id").eq("provider", "plaid").in("provider_txn_id", ids)
      );
      for (const r of rows) storedIds.add(String(r.provider_txn_id));
    }
    const standingOf = (row: (typeof ops.upsertPosted)[number]): ChargeStanding => ({
      isNew: !storedIds.has(row.providerTxnId),
      answered: !!row.pendingTxnId && corrections.has(row.pendingTxnId),
      mapped: !!acctIdByProv[row.accountId],
      storedLink: storedLinkById.get(row.providerTxnId) ?? null,
    });

    // The categorizer's answer for one posted outflow, AS THE LOOP BELOW USES IT — and,
    // for a bill named only by the SHAPE of the line (an ACH transfer read as the car
    // payment, SHAPE_BILL_RULES), the bill it settles, or null.
    //
    // That answer is seed-only (2026-10-26, in review). It links a charge only at the
    // bill's own figure to the cent, from an account the bill may be paid from, and only
    // a charge ARRIVING — or one already stored with that same link (mayLinkByShape in
    // _shared/chargeStanding.ts). Every other charge it names — another size, or a stored
    // row with no such link — is filed with `before`, the categorizer without that rule,
    // which is exactly what this sync wrote before it. The first version sent those to
    // the named-bill-with-no-row path instead, which rewrote a stored row's category to
    // `other` and flagged it: a new rule re-deciding history.
    //
    // A tracked-debt payment keeps the shape answer either way: the debt is credited by
    // its pattern whatever the categorizer says, as before.
    //
    // One function, asked by the spend history and the loop alike, so the two cannot
    // disagree about which rows are written as spending.
    const postedAnswer = (row: (typeof ops.upsertPosted)[number]) => {
      const c = classify(row.description, row.amount, learned, row.raw);
      if (!(c.kind === "bill" && c.billAmountGate)) return { c, shapeHit: null };
      const live = outRecs.filter((r: any) => billLiveOnPaymentDate(r, row.date));
      let shapeHit = matchBillForCharge(c.billName, live, acctIdByProv[row.accountId] ?? null, row.amount, sharedAccts, true);
      if (shapeHit && !mayLinkByShape(standingOf(row), String(shapeHit.bill.id), shapeHit.fromAnotherAccount)) {
        shapeHit = null;
      }
      const td = row.amount < 0 ? matchTrackedDebt(row.description) : undefined;
      return { c: shapeHit || td ? c : forExistingRow(c), shapeHit };
    };

    // What the household's own money OUT says about money coming IN — creditCategory
    // reads it to tell a refund or a payback from earnings (2026-10-25). Read only when
    // this sync carries a credit that could be one; a paycheck or a transfer never asks.
    // A failed read fails OPEN, on purpose: every credit is then filed exactly as it was
    // before that rule, which is a figure that was already being lived with, and a sync
    // is not worth losing over it. The price, named: a credit filed other-income in a
    // sync whose read failed keeps other-income on every later re-sync too (creditFlags
    // keeps a credit's category), so that one row needs a person to call it a refund.
    //
    // The history is the ledger's money out PLUS this sync's own (spendHistoryDescriptions,
    // 2026-10-25 in review): a purchase and its refund arriving in the same delta must
    // see each other, or the refund is filed as earnings for good. A delta row counts
    // when this sync is about to write it as spending — the same test the posted and
    // pending loops below apply.
    //
    // That includes a payment only a CLOSED debt matches, which the posted loop now
    // RECORDS as a bill payment instead of dropping it (closedDebtPayment). FOUND
    // 2026-10-25 when this change and the closed-debt one were joined: each was built on
    // its own, so this test still asked the loop's old question. That payment was written
    // as spending but left out of the history, and a refund from the same lender in the
    // same delta was filed as earnings for good. Asked with the loop's own arguments, so
    // it answers exactly as the loop will (tests/syncSeams.test.ts).
    let creditHistory: CreditHistory | undefined;
    if (
      [...ops.upsertPosted, ...ops.pendingUpsert].some(
        (r) => r.amount > 0 && classifyCredit(r.description) === "income" && !isPaycheck(r.description),
      )
    ) {
      try {
        const spent = await readAllPages("spend history", () =>
          admin.from("transactions").select("description").eq("type", "expense")
        );
        creditHistory = creditHistoryFrom([
          ...spendHistoryDescriptions(
            spent.map((r: any) => r.description as string | null),
            ops.upsertPosted,
            (r) =>
              !!matchTrackedDebt(r.description) ||
              postedAnswer(r).c.kind !== "skip" ||
              !!closedDebtPayment(closedDebts, r.description, seenProviderIds.has(r.providerTxnId))?.record,
          ),
          ...spendHistoryDescriptions([], ops.pendingUpsert, (r) => pendingFields(r, learned)?.type === "expense"),
        ]);
      } catch (e) {
        console.warn("spend history (credits filed as before):", String((e as Error)?.message ?? e));
      }
    }

    // A SEED-ONLY answer (Classification.seedOnly — a taught rule reached through a
    // near spelling, added 2026-10-25) may file a NEW row but must not move one the
    // ledger already has: "a guess may seed a row, never re-decide one" (schema_v26).
    // apply_bank_sync already keeps the category when told to (keep_category), but it
    // always takes needs_review from what is sent — so a re-delivered row would have
    // its review flag cleared under a category the rule never set. So the flag such a
    // row already carries is read here and sent back unchanged. A row not found is new.
    // Fails CLOSED like the reads above: a wrong guess here re-decides history.
    const seedOnlyIds = ops.upsertPosted
      .filter((r) => r.amount < 0 && classify(r.description, r.amount, learned, r.raw).seedOnly)
      .map((r) => r.providerTxnId);
    const storedReview = new Map<string, boolean>();
    for (let i = 0; i < seedOnlyIds.length; i += 100) {
      const ids = seedOnlyIds.slice(i, i + 100);
      const rows = await readAllPages("seed-only rows", () =>
        admin
          .from("transactions")
          .select("provider_txn_id, needs_review")
          .eq("provider", "plaid")
          .eq("status", "posted")
          .in("provider_txn_id", ids)
      );
      for (const r of rows) storedReview.set(r.provider_txn_id as string, r.needs_review === true);
    }

    // group posted rows: living-spend by account, and BILL payments (matched to a
    // recurring) recorded as appliesTo=bill so they auto-mark paid + log the real
    // amount. Income / transfers (skip) are dropped.
    const postedByAcct: Record<string, any[]> = {};
    const billByAcct: Record<string, any[]> = {};
    // Bank charges that will take a bill month from a hand note, decided in the loop
    // and settled straight after it (they need two reads the loop cannot wait on). Each
    // carries BOTH shapes: the linked row, and the extra-payment row it falls back to if
    // the note cannot be removed — which is exactly what this sync wrote before.
    const takeovers: {
      acct: string;
      note: CycleHolder;
      bill: string;
      linked: any;
      fallback: any;
      fallbackTo: Record<string, any[]>;
    }[] = [];
    const retiring = new Set<string>();
    // Every posted line this loop leaves out of the ledger, written to dropped_lines after
    // the ledger write (2026-10-26, _shared/droppedLines.ts). These were bare `continue`s:
    // the line went nowhere, so a rule that dropped real money did it without a sound.
    // Only a line the ledger does NOT already hold counts — a stored row the bank re-sends
    // and the categorizer now skips stays in the ledger as it is, so it is not "dropped".
    // And only from an account the app holds: an account taken out of the app is not
    // written at all, by choice, and listing its lines would argue with that choice.
    const dropped: DroppedLineRow[] = [];
    const noteDropped = (row: (typeof ops.upsertPosted)[number], reason: string) => {
      if (storedIds.has(row.providerTxnId)) return;
      const acct = acctIdByProv[row.accountId];
      if (!acct) return;
      const d = droppedLine(row, acct, reason);
      if (d) dropped.push(d);
    };
    for (const row of ops.upsertPosted) {
      // Incoming money: capture real income so it's VISIBLE and a reimbursement
      // payback can be matched against it. Internal transfers between our OWN
      // accounts are the same dollars moving (not new money) → drop. Balance comes
      // from the bank's reported figure, so inserting income never distorts it.
      if (row.amount > 0) {
        if (classifyCredit(row.description) === "transfer") {
          noteDropped(row, CREDIT_TRANSFER_REASON);
          continue;
        }
        // Paycheck, refund or other income — see creditCategory. Its refund rules are
        // seed-only, so a credit already in the ledger keeps the category it has
        // (creditFlags in _shared/seedOnly.ts says why that covers other-income too).
        const credit = creditCategory(row.description, row.raw, creditHistory);
        const creditSeed = creditFlags(credit.categoryId);
        (postedByAcct[row.accountId] ??= []).push({
          provider_txn_id: row.providerTxnId,
          provider_account_id: row.accountId,
          date: row.date,
          amount: Math.abs(row.amount),
          type: "income",
          // "salary", not "paycheck": salary is the id DEFAULT_CATEGORIES defines
          // and the id both recurring income rows already use. "paycheck" existed
          // in no catalog, so $33,033.19 of income was displayed under a fallback
          // label with a fallback colour.
          category_id: credit.categoryId,
          description: row.description,
          raw_description: row.raw,
          needs_review: creditSeed.needs_review,
          keep_category: creditSeed.keep_category,
        });
        continue;
      }
      // A payment on a feed-tracked debt (Affirm / Mom-China via Remitly). Only
      // OUTFLOWS (− in our sign convention) count — a refund must never reduce
      // the debt. Recorded settled (out of the budget); the debt balance is
      // recomputed from the sum of these below.
      const td = row.amount < 0 ? matchTrackedDebt(row.description) : undefined;
      const { c, shapeHit } = postedAnswer(row);
      if (!td && c.kind === "skip") {
        // A payment that only a CLOSED debt's pattern matches. FOUND in review
        // 2026-10-25, on live data, before the change that stopped arming closed debts
        // shipped: the categorizer files the lender's payments as skip, so once the
        // closed loan was no longer armed, a payment on a NEW loan from the same lender
        // would have fallen through to this `continue` and been written nowhere — not
        // credited, not spending, gone from the ledger, and its pending row deleted as
        // it posted. Such a payment is recorded now, as a bill
        // payment flagged for a look and linked to nothing; a charge that already
        // carries a link (the closed loan's own old payments, re-sent) is left exactly
        // as it is. Every other skip row is dropped as before. The rule and why:
        // closedDebtPayment in _shared/trackedDebts.ts.
        const gone =
          row.amount < 0
            ? closedDebtPayment(closedDebts, row.description, seenProviderIds.has(row.providerTxnId))
            : null;
        if (!gone?.record) {
          // Dropped, as before — and now written down, with the categorizer's own reason.
          noteDropped(row, c.reason || "left out by the categorizer");
          continue;
        }
        // Never silent, like the extra-payment path below: a row the categorizer would
        // have dropped is being written, and that has to be readable in the logs.
        console.log(
          `closed debt: ${row.date} ${Math.abs(row.amount).toFixed(2)} ${row.description} ` +
            `matches ${(gone.debt as any).name ?? "a closed debt"}, which is closed; recorded as a bill payment for a look`,
        );
        (postedByAcct[row.accountId] ??= []).push({
          provider_txn_id: row.providerTxnId,
          provider_account_id: row.accountId,
          date: row.date,
          amount: Math.abs(row.amount),
          type: "expense",
          description: row.description,
          raw_description: row.raw,
          ...gone.record,
        });
        continue;
      }
      if (td || c.kind === "bill") {
        // Resolve to a recurring row tolerant of name drift (normalized / merchant
        // key). If the categorizer NAMED a bill but it doesn't resolve to a row,
        // that's a modeling gap → fall through to needs_review (below) rather than
        // risk the blind day+amount heuristic auto-settling the WRONG bill. Reserve
        // that heuristic for a payment the categorizer couldn't name at all — a
        // tracked debt classified "skip" (Affirm, Remitly) must never reach it, or
        // an unrelated bill of a similar size on a nearby day would absorb a debt
        // payment.
        //
        // A tracked debt used to `continue` BEFORE any of this ran, so a charge
        // that is BOTH a tracked debt and a modeled monthly bill only ever settled
        // the debt. Cherry is exactly that (debts.track_pattern 'CHERRY' plus a
        // $151.72 monthly recurring row): August's payment landed, the debt
        // dropped, and the Bills tab still showed Cherry unpaid for the month. The
        // two links are merged into one applies_to now.
        //
        // Narrowing to bills whose window covers the payment date comes first,
        // because two car-insurance rows both answer to "Car insurance" — one
        // running to 30 Nov 2026, its replacement starting 1 Feb 2027 — and only
        // the window separates them.
        // Only bills whose window covers this payment can be settled by it. The
        // window filter used to be followed by `?? matchRecurringName(c.billName,
        // outRecs)` — a fallback across EVERY row, which simply undid the filter
        // it had just been handed. A $120 payment to Gino's mother on 2026-09-02
        // therefore settled the "Mom" bill for September, a bill whose starts_on
        // is 2026-11-01: no September installment can render, so the claim
        // attaches to nothing, and the $120 also drops out of the budget (rows
        // with an applies_to are never graded).
        //
        // A payment toward a bill that has not started is not a settlement — it
        // is either real spending or a sign the MODEL is wrong about when the
        // bill begins. Both of those want a human, so it falls through to the
        // needs-review path instead of quietly claiming a cycle.
        const liveRecs = outRecs.filter((r: any) => billLiveOnPaymentDate(r, row.date));
        // And only bills paid FROM THIS ACCOUNT. The name matcher never asked whose
        // money it was, so Gino's own Claude Pro charge settled Xinyan's Claude Pro
        // bill in September — see billsPayableFrom. Narrowing here covers both match
        // paths below, and the day-and-amount fallback is the one that needs it most:
        // over 120 days its only fresh link would have been a $16.17 bubble-tea
        // charge settling the Sam's Club membership.
        const chargeAcct = acctIdByProv[row.accountId] ?? null;
        const payable = billsPayableFrom(liveRecs, chargeAcct);
        // …FIRST. Since 2026-10-24 a NAMED bill payment that matches nothing on its own
        // account looks at the bills set on the household's other accounts, because the
        // household pays from whichever account has the money: the car insurance came
        // out of two accounts and never linked once, and an electric bill paid from the
        // joint account never linked while the bill named another. matchBillForCharge
        // keeps the own-account match exactly as it was and allows the other only on the
        // name AND the amount band, with a shared account on one side — so the Claude Pro
        // shape above stays shut. The day-and-amount guess below never crosses accounts.
        // A bill the categorizer named from the SHAPE of the line — an ACH transfer as the
        // car payment (2026-10-26, SHAPE_BILL_RULES) — was decided by postedAnswer above:
        // the bill it settles at its own amount to the cent, or (as a tracked-debt payment
        // only) none. Any other charge it named reaches here as its `before` answer.
        let named = c.billAmountGate
          ? shapeHit
          : matchBillForCharge(c.billName, liveRecs, chargeAcct, row.amount, sharedAccts);
        // …and only for a charge ARRIVING (2026-10-25, chargeStanding.ts): a stored row the
        // bank re-sends keeps the shape it has — linked only if it already is, to this
        // bill — and a charge whose pending row a person answered keeps their answer. Both
        // fall to exactly what this sync did before the fallback existed.
        if (named?.fromAnotherAccount && !mayLinkFromAnotherAccount(standingOf(row), String(named.bill.id))) {
          named = null;
        }
        if (named?.fromAnotherAccount) {
          // Never silent: the self-check's paid-from-its-own-account will flag this
          // payment so a person can move the bill — and this line says why it linked.
          console.log(
            `bill from another account: ${row.date} ${Math.abs(row.amount).toFixed(2)} ${row.description} ` +
              `— paid ${named.bill.name}, which is set on a different account`,
          );
        }
        const matched =
          named?.bill ??
          (c.kind === "bill" && !c.billName
            ? matchBillByDayAmount(payable, row.date, Math.abs(row.amount), paidBill)
            : null);
        // A bill payment inherits its bill's category (housing / utilities / …)
        // rather than the flat "other" it used to get. That matters most for the
        // extra-payment path below, which carries no applies_to and is therefore
        // GRADED — an extra Verizon payment must land in `utilities` (outside the
        // discretionary envelope by design), not in the $125/mo Misc line.
        // The category an EXTRA payment carries. It cannot simply inherit the
        // bill's own category: 8 of the 16 active bills carry "other", and "other"
        // IS the $125/mo Misc line — so inheriting it would grade a second rent or
        // card payment as discretionary spending, which is the opposite of the
        // intent. `bills` is on no budget line and is listed in
        // OUTSIDE_BUDGET_CASH_CATS, so the money stays visible and still cuts what
        // can go at the debt, without being graded against an envelope.
        const inherited = (matched?.category_id as string | undefined) ?? c.appCategory;
        const billCat = inherited && !GRADED_CATS.has(inherited) ? inherited : "bills";
        if (matched) {
          const rec = { id: matched.id as string, dueDays: (matched.due_days ?? undefined) as number[] | undefined };
          const at = billAppliesTo(rec, row.date);
          const key = `${rec.id}|${at.monthKey}|${at.installmentIndex}`;
          // The row as it is written when it SETTLES this bill month.
          const linked = {
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
          };
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
            // …unless it is also a payment on a tracked debt. The debt balance is
            // recomputed as baseline − sum(payments carrying its debtId), so
            // dropping that link would leave the second payment of a month
            // uncredited and the debt reading high. It keeps the debt-only shape:
            // credited, out of the budget, and not settling an already-settled
            // bill cycle.
            const extra = td
              ? {
                  provider_txn_id: row.providerTxnId,
                  provider_account_id: row.accountId,
                  date: row.date,
                  amount: Math.abs(row.amount),
                  type: "expense",
                  category_id: billCat,
                  description: row.description,
                  raw_description: row.raw,
                  applies_to: { kind: "debt", debtId: td.id, settled: true },
                  needs_review: false,
                }
              : {
                  provider_txn_id: row.providerTxnId,
                  provider_account_id: row.accountId,
                  date: row.date,
                  amount: Math.abs(row.amount),
                  type: "expense",
                  category_id: billCat,
                  description: row.description,
                  raw_description: row.raw,
                  needs_review: true,
                };
            const extraTo = td ? billByAcct : postedByAcct;
            // UNLESS what holds the month is a hand-made "(already paid)" note alone,
            // for this same amount (2026-10-24, see _shared/handNote.ts). Then this,
            // the bank's own charge, is the payment the note stood in for: it takes the
            // month, and the note is removed straight after this loop. Decided here,
            // settled there — both shapes travel, so a note that cannot be removed
            // leaves this row exactly as the line below would have written it.
            //
            // Only a charge that may take anything at all (chargeStanding.ts): new to the
            // ledger, its pending row unanswered, and from an account this sync writes —
            // a charge from an account `accounts` does not hold is never written below,
            // so a note removed for it would leave the month paid by nothing.
            const note = mayTakeOver(standingOf(row))
              ? handNoteToRetire(cycleHolders.get(key), row.amount, matched.variable, retiring)
              : null;
            if (note) {
              retiring.add(note.id);
              takeovers.push({ acct: row.accountId, note, bill: `${matched.name} ${at.monthKey}`, linked, fallback: extra, fallbackTo: extraTo });
              // Held by this charge from here on, so a second one in the same delta is
              // an extra payment and never a second takeover.
              cycleHolders.set(key, [{ id: row.providerTxnId, handNote: false, amount: Math.abs(row.amount) }]);
              continue;
            }
            // Never silent. This row is being re-routed away from the bill it
            // named, which is a reclassification, and every reclassification has
            // to be readable in the logs — the same rule the dedup absorb follows.
            console.log(
              `extra payment: ${row.date} ${Math.abs(row.amount).toFixed(2)} ${row.description} ` +
                `— ${matched.name} ${at.monthKey} was already settled; recorded as spending, not as the bill`,
            );
            (extraTo[row.accountId] ??= []).push(extra);
            continue;
          }
          (billByAcct[row.accountId] ??= []).push(linked);
          paidBill.add(key);
          cycleHolders.set(key, [{ id: row.providerTxnId, handNote: false, amount: Math.abs(row.amount) }]);
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
      //
      // A seed-only answer files a new row; a row already in the ledger keeps its
      // category (keep_category) and the review flag it already carries (read above).
      // See _shared/seedOnly.ts.
      //
      // At a multi-department merchant the category is a GUESS, so it may seed a new
      // row but must never overwrite one that already has an answer. Without
      // keep_category a re-sync silently re-decides months of history at once.
      const flags = seedFlags(c, c.seedOnly ? storedReview.get(row.providerTxnId) : undefined);
      (postedByAcct[row.accountId] ??= []).push({
        provider_txn_id: row.providerTxnId,
        provider_account_id: row.accountId,
        date: row.date,
        amount: Math.abs(row.amount),
        type: "expense",
        category_id: c.appCategory ?? "other",
        description: row.description,
          raw_description: row.raw,
        needs_review: flags.needs_review,
        keep_category: flags.keep_category,
      });
    }

    // --- a hand note gives way to the bank's own charge (2026-10-24) -------------
    // The takeovers the loop above decided on. The loop only ever queues a charge that
    // is NEW to the ledger, whose pending row nobody answered, from an account this sync
    // writes (mayTakeOver — the "stored charges" read above, which moved there from
    // here on 2026-10-25 so the cross-account link could ask it too). One thing is left
    // to settle here, FAILING CLOSED to the extra-payment row this sync has always
    // written:
    //
    //   The note must still be the note. It is removed only by its id AND only while it
    //   is still a hand note nobody has answered — no bank, no account, a settled bill
    //   link, no hand category, flow or split — so a person who touched it in the
    //   seconds since the read keeps it. Anything other than exactly one row removed
    //   takes over nothing.
    //
    // The note goes BEFORE the charge is written below. If the write then fails, the
    // sync throws and the cursor is not saved, so the next sync replays this delta and
    // finds the month free: the charge links the ordinary way. Written the other way
    // round, a failure in between would leave the note and the charge both claiming
    // the month for good.
    //
    // A note removed here has no undo token — the sync is no person's request — so its
    // whole row goes in the log line, enough to put it back by hand.
    //
    // KNOWN AND ACCEPTED (review, 2026-10-25): two syncs of one bank login running at
    // the same moment — a webhook landing during the scheduled pull — can both decide
    // the same takeover. One removes the note and links the charge; the other removes
    // nothing, falls back, and upserts the extra-payment shape onto that same charge.
    // apply_bank_sync keeps the existing link (coalesce), so the month stays paid once
    // and no money moves; the charge just comes back flagged for review, and a person's
    // "looks right" clears it. Nothing here locks a sync, and this is not worth the
    // first lock.
    if (takeovers.length) {
      for (const tk of takeovers) {
        let retired = false;
        // Belt and braces for the loop's own gate: only an account this sync writes.
        if (acctIdByProv[tk.acct]) {
          const { data: gone, error: goneErr } = await admin
            .from("transactions")
            .delete()
            .eq("id", tk.note.id)
            .eq("type", "expense")
            .is("provider", null)
            .is("account_id", null)
            .eq("applies_to->>kind", "bill")
            .eq("applies_to->>settled", "true")
            .or("user_categorized.is.null,user_categorized.eq.false")
            .is("flow_override", null)
            .is("splits", null)
            // record_only too since 2026-10-25: a statement import's note gives way like
            // a tapped one (handNote.ts), and putting it back means putting back the flag.
            .select("id, date, amount, description, category_id, applies_to, record_only, created_at, person");
          if (goneErr) console.warn("hand note takeover:", goneErr.message);
          retired = !goneErr && (gone ?? []).length === 1;
          if (retired) {
            console.log(
              `hand note retired: ${tk.bill} is paid by ${tk.linked.date} ${Number(tk.linked.amount).toFixed(2)} ` +
                `${tk.linked.description}; removed the note ${JSON.stringify(gone![0])}`,
            );
          }
        }
        if (retired) {
          (billByAcct[tk.acct] ??= []).push(tk.linked);
        } else {
          console.log(
            `extra payment: ${tk.linked.date} ${Number(tk.linked.amount).toFixed(2)} ${tk.linked.description} ` +
              `— ${tk.bill} is held by a hand note that stays; recorded as spending, not as the bill`,
          );
          (tk.fallbackTo[tk.acct] ??= []).push(tk.fallback);
        }
      }
    }

    // Carry a person's answer from each pending row onto the posted row that
    // replaces it. The decision is carryCorrection's (plaidSync.ts), and it runs
    // AFTER the bill and debt matching above on purpose: a posted row the sync has
    // just matched to a bill or debt carries an applies_to by now, and that match
    // wins over a carried category.
    //
    // Two writes, because apply_bank_sync writes only some columns. The category
    // and needs_review ride in the row itself, so they land in the same atomic
    // insert as the charge. user_categorized, flow_override and splits are not
    // columns that function writes, so they follow in an update straight after it
    // (below).
    //
    // needs_review is the patch's own, not always false: a split that no longer
    // adds up to the posted charge carries no category and sets needs_review TRUE,
    // so the posted row asks again instead of passing for answered.
    const pendingOf = new Map<string, string>();
    for (const r of ops.upsertPosted) if (r.pendingTxnId) pendingOf.set(r.providerTxnId, r.pendingTxnId);
    const carried: { providerTxnId: string; patch: CarriedCorrection }[] = [];
    const carriedFrom = new Set<string>();
    for (const row of [...Object.values(postedByAcct).flat(), ...Object.values(billByAcct).flat()]) {
      const from = pendingOf.get(row.provider_txn_id);
      const patch = carryCorrection(row, from ? corrections.get(from) : undefined);
      if (!patch || !from) continue;
      if (patch.category_id !== undefined) row.category_id = patch.category_id;
      if (patch.needs_review !== undefined) row.needs_review = patch.needs_review;
      carried.push({ providerTxnId: row.provider_txn_id, patch });
      carriedFrom.add(from);
    }
    // A pending row whose answer is being carried must outlive the write that
    // carries it. Plaid usually lists a posted charge's pending id in `removed`,
    // which would delete that row inside apply_bank_sync — before the update below
    // has run. If that update then failed, the sync would retry (the cursor is only
    // saved at the end) and find the pending row already gone, so the answer would
    // be lost on the retry instead of on the first try. Held back from the reverse
    // list here, those rows are deleted by the pending section further down, whose
    // delete covers every id in `removed` anyway and is scoped to status='pending'.
    const reverse = ops.reverse.filter((id) => !carriedFrom.has(id));

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
        p_reverse: reverseSent ? [] : reverse,
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
    if (!reverseSent && reverse.length) {
      const { error } = await admin.rpc("apply_bank_sync", {
        p_account_id: null,
        p_provider: "plaid",
        p_reported_balance: null,
        p_balance_date: new Date().toISOString(),
        p_posted: [],
        p_reverse: reverse,
      });
      if (error) throw new Error("apply_bank_sync (reverse flush): " + error.message);
    }

    // The lines this sync left out of the ledger, written down (2026-10-26, schema_v47).
    // AFTER the ledger write, and never able to fail the sync: the money is already
    // recorded, and a missing table (v47 not run yet) only costs this record. An upsert on
    // the bank's id, so a re-sync of the same line writes the same row, not a second one.
    //
    // Two kinds of line come back OUT of the table, so it never lists something that is
    // not dropped: one the ledger now holds (a rule changed and this sync wrote it), and
    // one the bank withdrew (Plaid's `removed`). Both deletes are by the bank's id only.
    //
    // One row per bank id first (uniqueByBankId): a line Plaid lists in both `added` and
    // `modified` would otherwise make Postgres refuse its whole batch. And a batch that
    // fails does not stop the next one (2026-10-26, in review) — each is its own record.
    try {
      const lines = uniqueByBankId(dropped);
      for (let i = 0; i < lines.length; i += 100) {
        const { error: dErr } = await admin
          .from("dropped_lines")
          .upsert(lines.slice(i, i + 100), { onConflict: "provider_txn_id" });
        if (dErr) console.warn(`dropped lines ${i + 1}–${Math.min(i + 100, lines.length)} (not recorded this sync):`, dErr.message);
      }
      if (lines.length) {
        console.log(
          `dropped: left ${lines.length} line(s) out of the ledger — ` +
            lines
              .map((d) => `${d.date} ${d.direction} ${d.amount.toFixed(2)} (${d.reason})`)
              .join("; ")
              .slice(0, 500),
        );
      }
      const written = [
        ...Object.values(postedByAcct).flat(),
        ...Object.values(billByAcct).flat(),
      ].map((r: any) => String(r.provider_txn_id));
      const gone = [...new Set([...written, ...ops.reverse])];
      for (let i = 0; i < gone.length; i += 100) {
        const { error: gErr } = await admin.from("dropped_lines").delete().in("provider_txn_id", gone.slice(i, i + 100));
        if (gErr) console.warn(`dropped lines ${i + 1}–${Math.min(i + 100, gone.length)} (clean-up skipped this sync):`, gErr.message);
      }
    } catch (e) {
      console.warn("dropped lines:", String((e as Error)?.message ?? e));
    }

    // The rest of each carried answer: the flags apply_bank_sync does not write.
    //
    // Each half is guarded on the POSTED row's own state, so a carry can never
    // overwrite an answer given to the posted row itself. A carry normally happens
    // once, because the pending row is deleted in the same sync. But a retried sync
    // replays the whole delta, and the bank re-sends a posted charge (in `modified`)
    // still naming its pending id — so if that pending row is still there for any
    // reason, the carry runs again, possibly after a person has re-filed the posted
    // row. The newer answer is the one that stands: the same reason apply_bank_sync
    // never overwrites a user_categorized row's category.
    //
    // A failure THROWS. The cursor is only saved at the end, so the next sync
    // replays this delta, the upsert above is idempotent, and the pending row —
    // held back from the reverse list — is still there to read the answer from. A
    // retried sync beats a correction that silently did not happen.
    //
    // A carried split rides in the same update as user_categorized, never on its
    // own: the slices and the flag that protects them land together or not at all.
    for (const { providerTxnId, patch } of carried) {
      if (patch.user_categorized) {
        const answer: Record<string, unknown> = {
          category_id: patch.category_id,
          user_categorized: true,
          needs_review: false,
        };
        if (patch.splits) answer.splits = patch.splits;
        const { error } = await admin
          .from("transactions")
          .update(answer)
          .eq("provider", "plaid")
          .eq("provider_txn_id", providerTxnId)
          .eq("status", "posted")
          .or("user_categorized.is.null,user_categorized.eq.false");
        if (error) throw new Error("carry correction: " + error.message);
      }
      if (patch.flow_override) {
        const { error } = await admin
          .from("transactions")
          .update({ flow_override: patch.flow_override })
          .eq("provider", "plaid")
          .eq("provider_txn_id", providerTxnId)
          .eq("status", "posted")
          .is("flow_override", null);
        if (error) throw new Error("carry correction: " + error.message);
      }
    }
    if (carried.length) console.log(`carried ${carried.length} answer(s) from a pending row to its posted row`);

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
    // Any answer a person gave the pending row has already been carried onto the
    // posted one above (carryCorrection) — or, for a split that no longer adds up
    // to the posted charge, turned into a question on it — so deleting it here
    // loses nothing silently.
    // No bill/debt matching here — that runs on the posted row.
    //
    // We delete-then-insert (avoids ON CONFLICT on the partial provider index).
    // The delete is HARD-SCOPED to status='pending' so it can NEVER remove a real
    // posted transaction.
    const removeIds = [...new Set([...ops.pendingRemove, ...ops.pendingUpsert.map((r) => r.providerTxnId)])];
    // This delete used to be one unchecked call. It now also retires the pending
    // rows held back from apply_bank_sync's reverse list above (their answers were
    // carried), so a failure here would leave those holds on screen beside the
    // charges that replaced them — the double row this whole section exists to
    // prevent. So it throws, as apply_bank_sync does when ITS delete fails: the
    // cursor is not saved, the next sync replays the delta, and every write before
    // this one is idempotent.
    //
    // And it is chunked, because checking it made its size matter. removeIds holds
    // every posted id in the delta too, and a cursor reset or a first sync is
    // hundreds of them — one `in` list that long is a URL the gateway can refuse.
    // Unchecked, such a refusal would have passed in silence and left every pending
    // row in the batch on screen; checked and unchunked, it would fail every large
    // sync. A hundred ids per call is the same chunk the corrections read uses.
    for (let i = 0; i < removeIds.length; i += 100) {
      const { error: rmErr } = await admin
        .from("transactions")
        .delete()
        .eq("provider", "plaid")
        .eq("status", "pending")
        .in("provider_txn_id", removeIds.slice(i, i + 100));
      if (rmErr) throw new Error("pending delete: " + rmErr.message);
    }
    const pendingRows: any[] = [];
    for (const row of ops.pendingUpsert) {
      const acctId = acctIdByProv[row.accountId];
      if (!acctId) continue;
      // What the row is — or whether it is written at all — is pendingFields'
      // decision (_shared/pendingRow.ts), lifted out of here so a test can reach
      // it. That is also where internal transfers are dropped, both directions.
      const f = pendingFields(row, learned, creditHistory);
      if (!f) continue;
      const pendingRow: Record<string, unknown> = {
        date: row.date,
        amount: f.amount,
        type: f.type,
        category_id: f.category_id,
        description: row.description,
        raw_description: row.raw,
        account_id: acctId,
        provider: "plaid",
        provider_txn_id: row.providerTxnId,
        provider_account_id: row.accountId,
        status: "pending",
        needs_review: f.needs_review,
        // Spelled out at their column defaults, never left off. This is ONE bulk
        // insert, and supabase-js sends a bulk insert with the union of every row's
        // keys as its column list and fills a key a row lacks with NULL. So the
        // moment one row below carries user_categorized, every row that omitted it
        // would insert NULL into a NOT NULL column and the whole batch would fail.
        user_categorized: false,
        flow_override: null,
        splits: null,
      };
      // A pending row the bank re-sent under the same id is deleted and inserted
      // again just above, so an answer given to it would be lost the same way the
      // Firestone one was at posting. A pending row has no applies_to, so whatever
      // a person said carries — a split only while it still adds up to the amount
      // the bank re-sent (a restaurant hold is often re-sent with the tip on it),
      // and otherwise the row asks again; see carryCorrection. This is a direct
      // insert, not apply_bank_sync, so every carried column lands in the same
      // statement.
      const patch = carryCorrection({ amount: f.amount }, corrections.get(row.providerTxnId));
      if (patch) Object.assign(pendingRow, patch);
      pendingRows.push(pendingRow);
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

    // --- re-label rows already in the ledger -----------------------------------
    // Every rule in the categorizer only ever reached charges that had not been
    // imported yet. A rule written today fixed tomorrow's Geico charge and left
    // yesterday's sitting in Misc forever — which is exactly what happened: the
    // Car insurance rule shipped hours after the $295.29 payment landed, so the
    // ledger filed it as "Other / needs review" AND the Car insurance bill went on
    // reading unpaid, at the same time, from the same charge.
    //
    // Plaid's delta feed cannot fix this on its own: it only re-sends rows that
    // changed at the bank, and a row from three weeks ago never comes back. So ask
    // the question directly — run today's categorizer over the recent ledger and
    // correct whatever it now answers differently.
    //
    // Scope is deliberately narrow, because a sweep that can do more can also
    // break more:
    //   · CATEGORY ONLY. It never writes, clears or edits applies_to. A bill link
    //     settles a cycle, and settling one from a bulk pass — off a rule I changed
    //     rather than a payment he made — is the one mistake here that would cost
    //     real money. A row that now reads as a BILL is flagged for review with the
    //     bill named in the log, and he confirms it by hand.
    //   · Rows he has answered himself are untouchable (user_categorized).
    //   · Rows already carrying an applies_to are skipped entirely — they are
    //     settled bills, debts and set-asides, and their category rides with them.
    //   · Ambiguous merchants are skipped: at a multi-department merchant the new
    //     answer is a coin flip, and re-deciding months of history on a coin flip
    //     is the failure this guard already exists to prevent elsewhere.
    //   · 120 days back, which covers the whole live ledger without scanning it all.
    try {
      const since = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
      const { data: old } = await admin
        .from("transactions")
        .select("id, description, raw_description, amount, category_id, needs_review")
        .eq("type", "expense")
        .gte("date", since)
        .is("applies_to", null)
        .or("user_categorized.is.null,user_categorized.eq.false");
      let relabelled = 0;
      for (const r of old ?? []) {
        // Every row here is already in the ledger, so a seed-only rule (2026-10-25)
        // does not get a say: this sweep answers exactly as it did before that rule.
        const c = forExistingRow(
          classify(r.description ?? "", -Math.abs(Number(r.amount)), learned, r.raw_description ?? undefined),
        );
        if (c.ambiguous) continue;
        // (A shape-named bill — an ACH transfer read as the car payment, 2026-10-26 — never
        // reaches here as a bill: it is seed-only, so forExistingRow hands this sweep the
        // answer from before that rule. An old unlinked row that is really a car payment
        // is offered by W7 instead, which a person answers.)
        if (c.kind === "bill") {
          // Do not touch the category — just make sure it is asking. The name goes
          // in the log so there is a record of which bill it thinks it is.
          if (!r.needs_review) {
            console.log(`relabel: ${r.description} now reads as the bill "${c.billName}" — flagged for review`);
            await admin.from("transactions").update({ needs_review: true }).eq("id", r.id);
            relabelled++;
          }
          continue;
        }
        if (c.kind !== "variable" || !c.appCategory) continue;
        if (c.appCategory === r.category_id) continue;
        // Only ever move a row that is UNFILED or was auto-filed at low
        // confidence. A high-confidence auto answer already on the row is not
        // improved by another high-confidence auto answer.
        if (r.category_id !== "other" && !r.needs_review) continue;
        console.log(`relabel: ${r.description} ${r.category_id} → ${c.appCategory} (${c.reason})`);
        await admin
          .from("transactions")
          .update({ category_id: c.appCategory, needs_review: c.confidence === "low" && c.appCategory === "other" })
          .eq("id", r.id);
        relabelled++;
      }
      if (relabelled) console.log(`relabelled ${relabelled} existing rows with today's rules`);
    } catch (e) {
      // Never fail a sync over a cosmetic pass — the money is already written.
      console.warn("relabel sweep:", String((e as Error)?.message ?? e));
    }

    // The money write succeeded, so the connection is healthy — but this update used to
    // null last_error unconditionally, which is what let the pending failure above stay
    // invisible for as long as it did.
    //
    // And since 2026-10-26 it no longer washes away a warning that a login is about to
    // stop (_shared/itemHealth.ts). A webhook may have set 'needs_reauth' while this sync
    // ran, so the health columns are decided from the row as it is NOW, read just before
    // the write: an advance warning (PENDING_EXPIRATION / PENDING_DISCONNECT) stays, word
    // for word, because a sync working today says nothing about the date it names; a login
    // that had stopped is cleared, because this sync is the proof it works again.
    const { data: health } = await admin
      .from("bank_connections")
      .select("status, last_error")
      .eq("id", connId)
      .maybeSingle();
    await admin
      .from("bank_connections")
      .update({
        cursor,
        last_sync_at: new Date().toISOString(),
        ...healthAfterSync(health, pendingErr ? pendingErr.slice(0, 400) : null),
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
      .select("consecutive_failures, status, last_error")
      .eq("id", connId)
      .single();
    // A login the bank stopped accepting is 'needs_reauth' with a plain "sign in again"
    // reason, not a bare 'error' (2026-10-26, healthAfterFailure in _shared/itemHealth.ts);
    // and a row already marked 'needs_reauth' keeps that instruction through any other
    // failure. Everything else is recorded exactly as before.
    await admin
      .from("bank_connections")
      .update({
        ...healthAfterFailure(cf, msg),
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

// The app finished Plaid Link in UPDATE mode for an existing connection (2026-10-26):
// the person signed in again, and Plaid repaired the SAME login — no new item, no second
// copy of the accounts. Nothing to exchange (update mode keeps the access token), so this
// clears the "needs signing in again" mark and syncs at once. If the repair did not take,
// that sync fails with the login error and the mark comes straight back
// (healthAfterFailure), so clearing it first can never hide a login that still fails.
async function repaired(p: any) {
  const conn = p.connection_id;
  if (!conn) return json({ error: "connection_id required" }, 400);
  const { error } = await admin
    .from("bank_connections")
    .update({ status: "ok", last_error: null })
    .eq("id", conn)
    .eq("status", "needs_reauth");
  if (error) throw new Error("repaired: " + error.message);
  const result = await syncConnection(conn);
  // How many accounts the login carries, so the app's "Linked N accounts" line reads the
  // same after a repair as after a first link.
  const { count } = await admin.from("accounts").select("id", { count: "exact", head: true }).eq("connection_id", conn);
  return json({ connection_id: conn, repaired: true, accounts: count ?? 0, ...result });
}

// Remove a connection and everything it owns (its accounts + their feed rows +
// pending). A real "disconnect bank" feature — and the cleanup for sandbox tests.
//
// IT TAKES A CONFIRMATION NOW (2026-10-26): `confirm` must repeat the connection id.
// This is a hard delete of every account on the login and its whole transaction
// history, with no undo, and until today any signed-in caller could set it off with one
// field. Nothing in the app calls it (there is no disconnect button, by design); the
// repeated id is the deliberate act a typed confirmation is everywhere else, so a stray
// or half-built request answers 400 and deletes nothing.
async function disconnect(p: any) {
  const conn = p.connection_id;
  if (!conn) return json({ error: "connection_id required" }, 400);
  if (typeof p.confirm !== "string" || p.confirm !== conn) {
    return json(
      { error: "disconnect deletes this bank login's accounts and their whole history; send confirm equal to connection_id to do it" },
      400,
    );
  }
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
      case "repaired": return await repaired(payload);
      case "set_webhook": return await setWebhook();
      case "disconnect": return await disconnect(payload);
      default: return json({ error: `unknown action: ${payload.action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
