// announce-update — pushes an "Update ready" notification to every household
// device on a new release. Called by the GitHub Pages deploy workflow (right
// after Pages publishes) ONLY when the changelog version bumped, so it fires
// once per real release, not per commit. PUBLIC (verify_jwt=false), guarded by
// ?token=ANNOUNCE_TOKEN. High-urgency (via sendPush) so it lands immediately.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TOKEN = Deno.env.get("ANNOUNCE_TOKEN") ?? "";
const APP = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

Deno.serve(async (req) => {
  // fail CLOSED: a missing/empty ANNOUNCE_TOKEN denies everything
  if (!TOKEN || new URL(req.url).searchParams.get("token") !== TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  // an optional ?v=<version> just rides along into the body for context
  const v = new URL(req.url).searchParams.get("v");
  const res = await sendPush(admin, {
    title: "⬆️ Update ready",
    body: v ? `Homebase ${v} is live — open it to see what's new.` : "Homebase just updated — open it to see what's new.",
    url: APP,
    tag: "app-update",
  });
  return new Response(JSON.stringify({ ok: true, ...res }), { headers: { "Content-Type": "application/json" } });
});
