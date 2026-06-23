// notify — send a Web Push to the household's devices.
// POST { title, body, url?, tag?, owner? }  (JWT-verified: service-role/cron/app).
// Reused for ad-hoc + test pushes; the webhook + crons call sendPush directly.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json();
    // only allow same-origin notification targets (defense-in-depth; the SW also
    // clamps on click) so a push can't deep-link a device to an external page.
    const app = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";
    const url = typeof p.url === "string" && p.url.startsWith(app) ? p.url : app;
    const res = await sendPush(
      admin,
      { title: p.title ?? "Homebase", body: p.body ?? "", url, tag: p.tag },
      p.owner,
    );
    return json(res);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
