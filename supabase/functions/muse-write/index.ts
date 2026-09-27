// muse-write — the WRITE door. One POST per tool, a secret in a header.
// PUBLIC (verify_jwt=false) because the caller is an assistant's cloud VM, which
// cannot hold a Supabase session. It is not unguarded: it checks its own
// per-person secret and fails CLOSED if that secret is missing, empty or wrong.
//
// WHY NOT JUST GIVE THE ASSISTANT A SUPABASE LOGIN
//   Because that hands it everything. Setting verify_jwt = true means "the request
//   carries a valid project credential", and the publishable key is a valid
//   project credential compiled into the browser bundle on purpose. On top of
//   that, 17 of the 18 tables carry the same rule — any signed-in account may read
//   and write every row. So a login is not a permission, it is the whole ledger.
//   supabase/functions/_shared/callerAuth.ts records the live audit that proved
//   it. A separate door with its own secret and nine named verbs is the answer.
//
// TWO DOORS, TWO SECRETS. This one holds everything that changes anything;
// muse-read holds the questions. Meta's "Always allow" is granted per type of
// action on a CONNECTOR, and nobody outside Meta knows how wide that is — so an
// allow granted to make weigh-ins frictionless must not be able to reach a money
// write. Different function, different secret, different connector.
//
// SECRETS (supabase secrets set — never committed):
//   MUSE_WRITE_GINO     his write secret
//   MUSE_WRITE_XINYAN   hers
//   APP_URL             where a tapped notification opens
//   VAPID_*             already set, used by the shared push helper
// Revoking is: change one secret, redeploy this function. Under a minute, and it
// cannot half-work. Losing her phone revokes hers and not his.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";
import { clockNow } from "../_shared/muse/az.ts";
import { supabaseDb } from "./dbSupabase.ts";
import { handleWrite, personFor, type Secrets } from "./handler.ts";
import { openapi } from "./openapi.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SECRETS: Secrets = {
  gino: Deno.env.get("MUSE_WRITE_GINO") ?? "",
  xinyan: Deno.env.get("MUSE_WRITE_XINYAN") ?? "",
};
const APP = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

/** This door's own public address, the way the read door builds its own. */
const BASE_URL =
  Deno.env.get("MUSE_WRITE_URL") ?? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/muse-write`;

// See the note in _shared/muse/handler.ts: a connector's setup screen runs in a
// browser, asks permission with an OPTIONS request first, and reports "check your
// API key" when the answer does not allow the header the key travels in.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-muse-token, content-type, idempotency-key, apikey",
  "Access-Control-Max-Age": "86400",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Answered before the key is checked: it carries no key by design and reads
  // nothing. The real request behind it still needs one.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // The description of the door. Behind the same secret as the door itself: a
  // connector that cannot authenticate has no business reading the tool list.
  // If Phone Test 2 shows the assistant needs this before it can be given a
  // secret, opening it up is a one-line change — make it deliberately.
  if (req.method === "GET" && url.pathname.endsWith("/openapi.json")) {
    if (!personFor(req, SECRETS)) {
      return new Response(JSON.stringify({ ok: false, message: "Unauthorized." }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }
    return new Response(JSON.stringify(openapi(url), null, 2), { headers: JSON_HEADERS });
  }

  // A connector setup screen proves a key works by fetching the door itself, with
  // no path and no body. Answering "send a POST" there reads as a broken address
  // and the key gets blamed — which is what happened the first time this door was
  // connected. A bare GET now answers yes when the key is good, 401 when it is
  // not. It reads no table and names no figure.
  if (req.method === "GET" || req.method === "HEAD") {
    const who = personFor(req, SECRETS);
    if (!who) {
      return new Response(JSON.stringify({ ok: false, message: "Unauthorized." }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }
    return new Response(
      // Built from the project URL, NOT from the incoming request. Behind Supabase's
      // proxy the request arrives as http:// with /functions/v1 already stripped, so
      // echoing it back handed out `http://…/muse-write/openapi.json` — wrong scheme,
      // missing prefix, 404 for anything that followed it. A connector's setup screen
      // follows that link to check the key, and reports the 404 as a bad key.
      JSON.stringify({ ok: true, door: "homebase-write", openapi: `${BASE_URL}/openapi.json` }),
      { headers: JSON_HEADERS },
    );
  }

  try {
    const reply = await handleWrite(req, {
      db: supabaseDb(admin),
      // The owner is always resolved from the secret inside the handler. It is
      // never optional here: sendPush fans out to EVERY stored subscription when
      // the owner is undefined, so a missing person would mean both phones.
      //
      // A push failure is logged and swallowed on purpose. The queued ROW is the
      // substance; the push is the doorbell. Turning a write that landed into a
      // 500 would tell the assistant nothing happened when something did, and
      // that is the worse of the two lies — the row is already visible in the app.
      push: async (payload, owner) => {
        try {
          await sendPush(admin, payload, owner);
        } catch (e) {
          console.error("muse-write push", String((e as Error)?.message ?? e).slice(0, 200));
        }
      },
      secrets: SECRETS,
      appUrl: APP,
      // The one clock reading in the whole door, taken once, passed down. See
      // az.ts for why a UTC runtime answering about an Arizona day is not a small
      // problem for somebody who works nights.
      clock: clockNow(),
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: JSON_HEADERS });
  } catch (e) {
    // Reaching here means the database itself would not answer — a read that
    // failed before anything was claimed, or a write that could not be recorded.
    // Answer plainly and change nothing. Never fail open.
    console.error("muse-write fatal", String((e as Error)?.message ?? e).slice(0, 200));
    return new Response(
      JSON.stringify({ ok: false, message: "I could not reach the ledger cleanly, so I did nothing." }),
      { status: 503, headers: JSON_HEADERS },
    );
  }
});
