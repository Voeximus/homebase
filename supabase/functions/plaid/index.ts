// Homebase bank feed — one multiplexed Plaid function (READ-ONLY).
//
// Actions (POST { action, ... }):
//   link_token — make a Link token (browser opens Link). connection_id ⇒ update mode.
//   exchange   — public_token → access_token (stored in Vault) → discover accounts → first sync.
//   sync       — pull /transactions/sync, reconcile, write posted rows + bank-truth balances.
//
// The Plaid secret and the bank access_token live server-side ONLY — never sent
// to the browser. Lean mode: no public webhook; the daily pg_cron job and a
// client "refresh" both hit `sync`. JWT-verified (no unauthenticated surface).
//
// Categorization reuses your full trained library (categorizeData + classify +
// learned merchant_rules); low-confidence rows are flagged needs_review for the
// existing one-tap clarify UI. Only "variable" living spend is inserted.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcile, type NormalRow, type PlaidTxn } from "../_shared/plaidSync.ts";
import { classify, merchantKey, matchRecurringName, type LearnedRules } from "../_shared/categorize.ts";

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

// Resolve a bill payment to its idempotent appliesTo (mirror of buildImportPlan):
// snap the posted day to the recurring's nearest scheduled due day, so the feed
// row lines up with a calendar-marked installment and dedups.
function billAppliesTo(rec: { id: string; dueDays?: number[] }, date: string) {
  const monthKey = date.slice(0, 7);
  const postDay = parseInt(date.slice(8, 10), 10);
  const day =
    rec.dueDays && rec.dueDays.length
      ? rec.dueDays.reduce(
          (best, d) => (Math.abs(d - postDay) < Math.abs(best - postDay) ? d : best),
          rec.dueDays[0],
        )
      : postDay;
  return { kind: "bill", recurringId: rec.id, monthKey, day, settled: true } as const;
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
    if (typeof r.amount === "number" && r.amount > 0) {
      const amtGap = Math.abs(amount - r.amount);
      if (amtGap > 15 && amtGap > 0.15 * r.amount) continue;
    }
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
      .select("id, name, due_days, amount, direction")
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
    const paidBill = new Set<string>();
    const seenProviderIds = new Set<string>();
    for (const t of paidRows ?? []) {
      const at = (t as any).applies_to;
      if (at?.kind === "bill") paidBill.add(`${at.recurringId}|${at.monthKey}|${at.day}`);
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

    const ops = reconcile({ added, modified, removed }, contentKey);

    // group posted rows: living-spend by account, and BILL payments (matched to a
    // recurring) recorded as appliesTo=bill so they auto-mark paid + log the real
    // amount. Income / transfers (skip) are dropped.
    const postedByAcct: Record<string, any[]> = {};
    const billByAcct: Record<string, any[]> = {};
    for (const row of ops.upsertPosted) {
      // A payment on a feed-tracked debt (Affirm / Mom-China via Remitly) wins
      // over bill/variable/skip. Only OUTFLOWS (− in our sign convention) count —
      // a refund must never reduce the debt. Recorded settled (out of the budget);
      // the debt balance is recomputed from the sum of these below.
      const td = row.amount < 0 ? matchTrackedDebt(row.description) : undefined;
      if (td) {
        (billByAcct[row.accountId] ??= []).push({
          provider_txn_id: row.providerTxnId,
          provider_account_id: row.accountId,
          date: row.date,
          amount: Math.abs(row.amount),
          type: "expense",
          category_id: "other",
          description: row.description,
          applies_to: { kind: "debt", debtId: td.id, settled: true },
          needs_review: false,
        });
        continue;
      }
      const c = classify(row.description, row.amount, learned);
      if (c.kind === "skip") continue;
      if (c.kind === "bill") {
        // Resolve to a recurring row tolerant of name drift (normalized / merchant
        // key), then fall back to a day+amount heuristic for bills the categorizer
        // is sure about but couldn't name-match. This is what makes a real bank
        // bill-payment auto-flip the CORRECT modeled bill to paid.
        const matched =
          matchRecurringName(c.billName, outRecs) ??
          matchBillByDayAmount(outRecs, row.date, Math.abs(row.amount), paidBill);
        if (matched) {
          const rec = { id: matched.id as string, dueDays: (matched.due_days ?? undefined) as number[] | undefined };
          const at = billAppliesTo(rec, row.date);
          const key = `${rec.id}|${at.monthKey}|${at.day}`;
          // skip if this installment is already recorded (manual / prior import) —
          // unless it's THIS feed row re-syncing (the unique index will update it).
          if (paidBill.has(key) && !seenProviderIds.has(row.providerTxnId)) continue;
          (billByAcct[row.accountId] ??= []).push({
            provider_txn_id: row.providerTxnId,
            provider_account_id: row.accountId,
            date: row.date,
            amount: Math.abs(row.amount),
            type: "expense",
            category_id: c.appCategory ?? "other",
            description: row.description,
            applies_to: at,
            needs_review: false,
          });
          paidBill.add(key);
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
        needs_review: c.confidence === "low",
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
      const c = classify(row.description, row.amount, learned);
      if (c.kind === "skip") continue;
      pendingRows.push({
        date: row.date,
        amount: Math.abs(row.amount),
        type: "expense",
        category_id: c.appCategory ?? "other",
        description: row.description,
        account_id: acctId,
        provider: "plaid",
        provider_txn_id: row.providerTxnId,
        provider_account_id: row.accountId,
        status: "pending",
        needs_review: c.confidence === "low",
      });
    }
    if (pendingRows.length) {
      const { error: pErr } = await admin.from("transactions").insert(pendingRows);
      if (pErr) console.warn("pending insert:", pErr.message);
    }

    await admin
      .from("bank_connections")
      .update({ cursor, last_sync_at: new Date().toISOString(), status: "ok", last_error: null })
      .eq("id", connId);

    // Summary of what landed this sync — the webhook uses it to push a phone
    // notification ("$X · Merchant"). Posted spend + bills + pending charges.
    const newRows = [
      ...Object.values(postedByAcct).flat(),
      ...Object.values(billByAcct).flat(),
      ...pendingRows,
    ].map((r: any) => ({ description: r.description, amount: r.amount, pending: r.status === "pending" }));

    return { posted: ops.upsertPosted.length, pending: ops.pendingUpsert.length, reversed: ops.reverse.length, newRows };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await admin
      .from("bank_connections")
      .update({ status: "error", last_error: msg.slice(0, 400) })
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
  await admin.from("pending_preview").delete().eq("connection_id", conn);
  await admin.from("accounts").delete().eq("connection_id", conn);
  await admin.from("bank_connections").delete().eq("id", conn);
  return json({ disconnected: conn, accounts_removed: ids.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
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
