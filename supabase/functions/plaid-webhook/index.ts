// plaid-webhook — Plaid pings this when new transactions are available, so a
// charge syncs + pushes to the phones the instant the bank reports it (instead
// of waiting for the app to open). PUBLIC (verify_jwt=false) — guarded by a
// shared secret in the URL (?token=...). It only ever triggers a read-only sync.
//
// The handler itself is in handle.ts, with the client, fetch and push sender passed
// in, so a test can drive it without a server or a database (split 2026-10-09, when
// it started recording each sync it triggers in job_runs — see handle.ts for why).
// This file only reads the environment and serves.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";
import { handleWebhook } from "./handle.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("PLAID_WEBHOOK_TOKEN") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

const admin = createClient(SUPABASE_URL, SERVICE);

Deno.serve((req) =>
  handleWebhook(req, {
    admin,
    token: WEBHOOK_TOKEN,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE,
    appUrl: APP_URL,
    fetch,
    sendPush,
  })
);
