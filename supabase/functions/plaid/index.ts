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
import { classify, merchantKey, type LearnedRules } from "../_shared/categorize.ts";

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
  const r = await plaid("/link/token/create", body);
  return json({ link_token: r.link_token });
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

    // fresh balances + our account map
    const accResp = await plaid("/accounts/get", { access_token: token });
    const balByProv: Record<string, number> = {};
    for (const a of accResp.accounts) balByProv[a.account_id] = pickBalance(a);

    const { data: ourAccts } = await admin
      .from("accounts")
      .select("id, provider_account_id, owner")
      .eq("connection_id", connId);
    const acctIdByProv: Record<string, string> = {};
    const ownerByProv: Record<string, string> = {};
    for (const a of ourAccts ?? []) {
      if (a.provider_account_id) {
        acctIdByProv[a.provider_account_id] = a.id;
        ownerByProv[a.provider_account_id] = a.owner;
      }
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

    // group posted living-spend by provider account, categorized by your library
    const postedByAcct: Record<string, any[]> = {};
    for (const row of ops.upsertPosted) {
      const c = classify(row.description, row.amount, learned);
      if (c.kind !== "variable") continue; // income / transfers / bills aren't living spend
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
        p_posted: postedByAcct[provId] ?? [],
        p_reverse: reverseSent ? [] : ops.reverse,
      });
      if (error) throw new Error("apply_bank_sync: " + error.message);
      reverseSent = true;
    }

    // maintain the display-only pending preview
    if (ops.pendingRemove.length) {
      await admin.from("pending_preview").delete().eq("provider", "plaid").in("provider_txn_id", ops.pendingRemove);
    }
    const pendRows = ops.pendingUpsert
      .map((row) => {
        const c = classify(row.description, row.amount, learned);
        if (c.kind !== "variable") return null;
        return {
          connection_id: connId,
          account_id: acctIdByProv[row.accountId] ?? null,
          provider: "plaid",
          provider_txn_id: row.providerTxnId,
          provider_account_id: row.accountId,
          date: row.date,
          amount: row.amount,
          description: row.description,
          category_id: c.appCategory ?? "other",
          owner: ownerByProv[row.accountId] ?? null,
        };
      })
      .filter(Boolean);
    if (pendRows.length) {
      await admin.from("pending_preview").upsert(pendRows as any[], { onConflict: "provider,provider_txn_id" });
    }

    await admin
      .from("bank_connections")
      .update({ cursor, last_sync_at: new Date().toISOString(), status: "ok", last_error: null, consecutive_failures: 0 })
      .eq("id", connId);

    return { posted: ops.upsertPosted.length, pending: ops.pendingUpsert.length, reversed: ops.reverse.length };
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
      case "disconnect": return await disconnect(payload);
      default: return json({ error: `unknown action: ${payload.action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
