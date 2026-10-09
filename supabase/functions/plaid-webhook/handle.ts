// The plaid-webhook handler, with everything it touches handed in.
//
// SPLIT OUT OF index.ts on 2026-10-09 so a test can drive it. index.ts calls
// Deno.serve the moment it is imported and builds a real Supabase client from the
// environment, so nothing could reach this logic without starting a server against
// production. Here the client, the fetch and the push sender are parameters; index.ts
// passes the real ones and tests/bankSyncLog.test.ts passes fakes. The behaviour is
// what index.ts did, plus the one thing it did not: say that it ran.
//
// WHY IT RECORDS ITS RUNS NOW. FOUND 2026-10-09: a forced refresh's cron-bank-sync
// run recorded posted 0 / pending 0, and five rows landed two seconds later through
// this function, which wrote no job_runs row. Across 715 cron runs the log summed
// posted 1 while 45 rows had arrived. Most charges reach the ledger HERE — the bank
// pushes, this syncs, and the quarter-hour pull finds nothing left to do — so a log of
// cron-bank-sync alone reads like a feed that has stopped while it is working fine.
//
// It records under its own job name, 'plaid-webhook', with the same numbers-only
// detail cron-bank-sync records (_shared/syncCounts.ts), so the two can be added up.
// It is deliberately NOT in the heartbeat's WATCHED_JOBS: it runs when the bank has
// something to say, not on a schedule, so a quiet stretch is not a missed tick and
// must not be alarmed on as one.
//
// Only a ping that triggers a sync is recorded. The token check, a body that is not
// JSON, and webhook types other than transactions answer exactly as before and leave
// no row: they did no work, and a row for each would bury the ones that did.

import { recordRun } from "../_shared/jobRun.ts";
import { syncCounts } from "../_shared/syncCounts.ts";

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface WebhookDeps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  token: string;
  supabaseUrl: string;
  serviceKey: string;
  appUrl: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  // deno-lint-ignore no-explicit-any
  sendPush: (admin: any, payload: PushMessage) => Promise<unknown>;
}

const money = (n: number) => "$" + Number(n).toFixed(2);

export const TXN_CODES = ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "TRANSACTIONS_REMOVED"];

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const url = new URL(req.url);
  // fail CLOSED: a missing/empty PLAID_WEBHOOK_TOKEN denies everything
  if (!deps.token || url.searchParams.get("token") !== deps.token) {
    return new Response("forbidden", { status: 403 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return new Response("ok"); // ack non-JSON pings
  }
  const type = body.webhook_type;
  const code = body.webhook_code as string;
  const itemId = body.item_id as string;

  if (type !== "TRANSACTIONS" || !TXN_CODES.includes(code) || !itemId) {
    return new Response("ok"); // ack everything else (Plaid expects a fast 200)
  }

  // Plaid gets its 200 whatever happens below: every failure is caught inside the
  // work and reported as ok:false in the row, never thrown — a thrown error here
  // would turn into a 500, and Plaid answers a 500 by retrying the same ping.
  return await recordRun(deps.admin, "plaid-webhook", async () => {
    try {
      const { data: conn, error: connErr } = await deps.admin
        .from("bank_connections")
        .select("id")
        .eq("item_id", itemId)
        .maybeSingle();
      // A lookup that FAILED is not the same as an item we do not have. It used to
      // read as one — no row, so "ok", and nothing synced — which hid a broken read
      // behind a quiet success. It is still answered "ok" to Plaid, but recorded as
      // a failure, so the log shows a ping that arrived and was not acted on.
      if (connErr) throw new Error("bank_connections lookup: " + connErr.message);
      // An item that is not ours (a deleted link still pinging) is not a failure: the
      // webhook did what it should, which is nothing. Recorded, with nothing moved.
      if (!conn) return { ok: true, detail: { connections: 0 }, result: new Response("ok") };

      // run the read-only sync for just this item (reuses all the reconcile +
      // categorize + anti-double-count logic in the plaid function)
      const r = await deps.fetch(`${deps.supabaseUrl}/functions/v1/plaid`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.serviceKey}`, apikey: deps.serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", connection_id: conn.id }),
      });
      if (!r.ok) {
        // Same shape cron-bank-sync records for the same failure. The body is a
        // bank's or the sync's own error prose, so it is not read into the row.
        console.error("plaid-webhook: plaid answered", r.status);
        return { ok: false, detail: { plaid_status: r.status }, result: new Response("ok") };
      }
      const res = await r.json();
      const newRows = (res?.newRows ?? []) as { description: string; amount: number; pending: boolean }[];

      // The push is the reason this function exists, but its failure is not the
      // sync's: by now the rows are written. So it keeps its own catch, and the run
      // is recorded as the sync it was.
      try {
        if (newRows.length === 1) {
          const t = newRows[0];
          await deps.sendPush(deps.admin, {
            title: t.pending ? "💳 Charge processing" : "💳 New charge",
            body: `${money(t.amount)} · ${t.description}`,
            url: deps.appUrl,
            tag: "txn",
          });
        } else if (newRows.length > 1) {
          const total = newRows.reduce((s, t) => s + t.amount, 0);
          await deps.sendPush(deps.admin, {
            title: "💳 New transactions",
            body: `${newRows.length} charges · ${money(total)}`,
            url: deps.appUrl,
            tag: "txn",
          });
        }
      } catch (e) {
        console.error("plaid-webhook push", String((e as Error)?.message ?? e));
      }

      // NUMBERS ONLY: syncCounts keeps the numeric fields of the sync's answer and
      // drops newRows, whose merchant names were only ever meant for the phone.
      return { ok: true, detail: syncCounts(res), result: new Response("ok") };
    } catch (e) {
      console.error("plaid-webhook", String((e as Error)?.message ?? e));
      return { ok: false, detail: { threw: true }, result: new Response("ok") };
    }
  });
}
