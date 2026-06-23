// plaid-webhook — Plaid pings this when new transactions are available, so a
// charge syncs + pushes to the phones the instant the bank reports it (instead
// of waiting for the app to open). PUBLIC (verify_jwt=false) — guarded by a
// shared secret in the URL (?token=...). It only ever triggers a read-only sync.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("PLAID_WEBHOOK_TOKEN") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

const admin = createClient(SUPABASE_URL, SERVICE);
const money = (n: number) => "$" + Number(n).toFixed(2);

const TXN_CODES = ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "TRANSACTIONS_REMOVED"];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // fail CLOSED: a missing/empty PLAID_WEBHOOK_TOKEN denies everything
  if (!WEBHOOK_TOKEN || url.searchParams.get("token") !== WEBHOOK_TOKEN) {
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

  try {
    const { data: conn } = await admin
      .from("bank_connections")
      .select("id")
      .eq("item_id", itemId)
      .maybeSingle();
    if (!conn) return new Response("ok");

    // run the read-only sync for just this item (reuses all the reconcile +
    // categorize + anti-double-count logic in the plaid function)
    const r = await fetch(`${SUPABASE_URL}/functions/v1/plaid`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync", connection_id: conn.id }),
    });
    const res = await r.json();
    const newRows = (res?.newRows ?? []) as { description: string; amount: number; pending: boolean }[];

    if (newRows.length === 1) {
      const t = newRows[0];
      await sendPush(admin, {
        title: t.pending ? "💳 Charge processing" : "💳 New charge",
        body: `${money(t.amount)} · ${t.description}`,
        url: APP_URL,
        tag: "txn",
      });
    } else if (newRows.length > 1) {
      const total = newRows.reduce((s, t) => s + t.amount, 0);
      await sendPush(admin, {
        title: "💳 New transactions",
        body: `${newRows.length} charges · ${money(total)}`,
        url: APP_URL,
        tag: "txn",
      });
    }
  } catch (e) {
    console.error("plaid-webhook", String((e as Error)?.message ?? e));
  }
  return new Response("ok");
});
