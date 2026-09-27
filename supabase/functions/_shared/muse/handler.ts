// The read door's one request handler.
//
// SHAPE ON THE WIRE
//
//   POST /muse-read/finance.audit        {}                       → the tool
//   POST /muse-read                      { tool, args }            → the same tool
//   GET  /muse-read/openapi.json                                   → the description
//
// One path per tool, because that is what an assistant building a connector from an
// OpenAPI description can actually use: each tool becomes its own operation with
// its own summary and its own arguments. A single envelope endpoint would be one
// operation with an opaque body, which is harder for anything to hold on to — but
// the envelope is accepted too, because it costs five lines and nobody has
// published what a phone-built connector will send.
//
// AUTH. The secret travels in `Authorization: Bearer` or in `X-Muse-Token`, and
// which one stays is decided by a test on his phone rather than by preference. No
// secret, an unknown secret, an empty configured secret, or the WRITE door's secret
// all return the same 401 with the same body — nothing in the refusal says which
// kind of wrong it was.
//
// EVERY REPLY IS AUDITED, refusals included. A 401 writes a row with no person on
// it, because "somebody tried and was turned away" is the row worth having.
//
// NOTHING IS PROXIED. This door talks to Postgres and to nothing else — not the
// `plaid` function, not `notify`, not any other edge function. That is item 7 of
// what an assistant may never do, and it is enforced by this file importing no
// client and no URL.

import { azDateISO, nowAZ } from "./az.ts";
import { callerOf, type Person, type ReadSecrets } from "./auth.ts";
import type { AuditSink, Outcome } from "./audit.ts";
import { BodyTooLarge, MAX_BODY_BYTES, readCappedText } from "./body.ts";
import { LedgerUnreadable } from "./paging.ts";
import { createLoader } from "./load.ts";
import type { Db } from "./paging.ts";
import { BadArgs, TOOL_BY_NAME, TOOLS, ABSENT, type Json } from "./tools.ts";
import { scrubName } from "./scrub.ts";
import { openApiDocument } from "./openapi.ts";
import { setLangVar } from "./lib/i18n.ts";

/**
 * Reads per person per Arizona hour.
 *
 * WHY THIS NUMBER IS THE TOOL IT IS. Meta publishes no rate limits for connectors,
 * so this is ours, and PLAN.md §4 makes it a control rather than a suggestion. It
 * is not only about cost. `finance.spend_by_category` answers about a window the
 * caller chooses, and a caller who can ask about enough windows can rebuild a good
 * part of the ledger a question at a time — which is what `search_transactions` is
 * forbidden for. The window rules in tools.ts take the granularity away; this takes
 * the volume away. Until it shipped, the only thing standing there was a polite
 * sentence in API.md asking an assistant not to loop, which is exactly what a
 * prompt injection overrides.
 */
export const READS_PER_HOUR = 60;

/** The counter, in the locked-down `muse_calls` table. One statement per call, so
 *  two arriving together cannot both read 59. Implemented over `muse_bump` in the
 *  door's entry file — the same seam the write door uses. */
export interface RateLimit {
  /** Increment one bucket and return its new value. */
  bump(person: Person, bucket: string): Promise<number>;
}

export interface HandlerDeps {
  db: Db;
  secrets: ReadSecrets;
  audit: AuditSink;
  /** Not optional, deliberately: a missing limiter has to be a build error rather
   *  than a door with no cap on it. */
  limit: RateLimit;
  /** The instant to answer about. Defaults to the real clock — the door's ONLY
   *  clock reading, and it lives behind nowAZ() so a test can hand in a moment. */
  at?: Date;
  /** The public base URL, for the OpenAPI `servers` entry. */
  baseUrl?: string;
}

/**
 * The `error` code on every refusal this door can give.
 *
 * WHY THIS LIST EXISTS. docs/research/muse-bridge/API.md tells the assistant what
 * to do for each kind of refusal, branching on this field — and it was branching on
 * `bad_request`, `unknown_tool`, `rate_limited` and `ledger_unreadable`, none of
 * which the door sent. It sent "bad json", "no such tool", "bad arguments" and
 * "ledger unreadable". One of the five rows matched. An assistant reading that
 * table would have fallen through every branch and improvised, which is the exact
 * failure the hand-written openapi.json was deleted for: a description that
 * disagrees with the door is worse than none.
 *
 * So the codes are here, once, in the door's own source, and a test in
 * tests/museRead.test.ts compares this list against API.md's table both ways.
 *
 * The codes are COARSE on purpose. Four different 400s share `bad_request`,
 * because the field is what an assistant branches on and the `says` sentence is
 * what it repeats — and API.md's standing instruction is to say the sentence as it
 * stands. A code per sentence would be a vocabulary to keep in step for no gain.
 *
 * `too_large` is its own code rather than another 400, because the right response
 * to it is different: a `bad_request` is fixed and sent again, and a body over the
 * cap must not be sent again at all.
 */
export const ERROR_CODES = [
  "unauthorized",
  "bad_request",
  "too_large",
  "unknown_tool",
  "rate_limited",
  "ledger_unreadable",
  "use_post",
  "failed",
] as const;

/** The only headers any reply carries. NO CORS, deliberately: a connector's request
 *  comes from a server, not a browser, and a door that answered a preflight would be
 *  reachable from any web page he happened to have open. Every reply — the answers,
 *  the refusals and the door's own description — goes out through `finish` below, so
 *  there is no reply that escapes the audit log. */
// An assistant's setup screen runs in a browser, so it asks permission first with
// an OPTIONS request and refuses to continue unless the answer allows the header
// the key travels in. Without these the connector reports "check your API key",
// which is the one thing that is not wrong. Allowing any origin costs nothing
// here: the key, not the origin, is what opens this door.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-muse-token, content-type, idempotency-key, apikey",
  "Access-Control-Max-Age": "86400",
};
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS };

/** The tool name out of the path, tolerant of the deployed prefix
 *  (/functions/v1/muse-read/<tool>) and of a trailing slash. */
export function toolFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.lastIndexOf("muse-read");
  if (i === -1) return "";
  return parts.slice(i + 1).join("/");
}

function checkArgs(tool: { name: string; args?: { name: string }[] }, args: Record<string, unknown>): void {
  const allowed = new Set((tool.args ?? []).map((a) => a.name));
  for (const key of Object.keys(args)) {
    if (key === "person") {
      throw new BadArgs("This door works out who is asking from the key you used, so leave person out.");
    }
    // scrubName, not the raw key: this sentence is repeated back to the assistant
    // and stored in the audit log, and a field name is a string the caller chose.
    if (!allowed.has(key)) throw new BadArgs(`${tool.name} does not take ${scrubName(key, 24) || "that"}.`);
  }
}

export async function handleMuseRead(req: Request, deps: HandlerDeps): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const segment = toolFromPath(url.pathname);

  // The permission question a browser asks before the real request. It carries no
  // key by design, so it is answered before the key is checked and it reads
  // nothing: an empty yes, and the real request that follows still has to hold a
  // key like every other call.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Everything the audit row needs, filled in as it becomes known, written once at
  // the end. A single writer means no path can return without a row.
  let person = null as ReturnType<typeof callerOf>;
  // Every assignment to toolName goes through scrubName, because this string is
  // chosen by the caller and it lands in three places that matter: the routing
  // lookup, the refusal sentence the assistant hears, and the `tool` column of the
  // audit log that his settings screen renders. A real tool name comes through
  // unchanged; anything appended to one is dropped rather than carried along. See
  // scrub.ts for why a NAME is recognised instead of cleaned as prose.
  let toolName = scrubName(segment, 60) || "(none)";
  let args: Record<string, unknown> = {};

  const finish = async (body: { [k: string]: Json }, status: number, outcome: Outcome): Promise<Response> => {
    const text = JSON.stringify(body);
    // NO PERSON, NO ROW. A call with no recognised key cannot be attributed, and
    // three things follow from that, all pointing the same way:
    //   · `muse_audit.person` is NOT NULL and checked against the two names, so
    //     there is no value a row like this could carry;
    //   · this door is PUBLIC, so a row written for an anonymous caller lets a
    //     stranger fill a table nobody is rate-limiting — and the rate limiter is
    //     keyed on person, so it cannot count these either;
    //   · muse-write made the same choice for the same reason, and one rule across
    //     both doors is easier to trust than two.
    // It goes to the function log instead, loudly. The consequence, said plainly
    // for whoever runs the Phase 1 gates: a 401 shows up in the Supabase function
    // logs, not in muse_audit. Everything a key opened is in the table, refusals
    // included.
    if (!person) {
      console.error(`muse-read: denied, no recognized key (${outcome})`);
      return new Response(text, { status, headers: JSON_HEADERS });
    }
    try {
      await deps.audit.record({
        person,
        door: "read",
        tool: toolName,
        args,
        outcome,
        ms: performance.now() - started,
        // Byte length, not character count: the reply carries names, and a name
        // with an accent in it is more bytes than letters.
        bytes: new TextEncoder().encode(text).length,
      });
    } catch (e) {
      // Loud, not silent, and the read still goes out — see the note in audit.ts.
      console.error("muse-read: audit row not written", String((e as Error)?.message ?? e));
      return new Response(JSON.stringify({ ...body, audit: "not recorded" }), { status, headers: JSON_HEADERS });
    }
    return new Response(text, { status, headers: JSON_HEADERS });
  };

  // THE KEY IS CHECKED BEFORE ANYTHING IS ROUTED. Every path, every method,
  // including the description — so a stranger cannot learn which tools exist, and
  // so there is no reply this door gives that is not counted in the audit log.
  //
  // This is a settled disagreement, recorded because it is worth knowing which way
  // it went. The door was first built serving its description openly, on the
  // reasoning that a connector might need to read it before it has been given a
  // key. Nobody has published whether that is true — PLAN.md §1 marks the whole
  // question unverified — and the two costs are not the same size. An open path on
  // a verify_jwt = false function is an anonymous, unrate-limited endpoint that
  // names the household's whole tool surface, and _shared/callerAuth.ts exists
  // because of what one of those cost last time. Against that, if an assistant
  // really cannot fetch the description before it holds a key, SETUP.md's own
  // fallback already covers it: paste API.md into the chat instead.
  //
  // So: fail closed everywhere, and reopen this with one line if a phone test ever
  // shows it has to be open.
  person = callerOf(req, deps.secrets);
  if (!person) {
    // One refusal for every kind of wrong key, so the body cannot be used to tell
    // "no secret" from "wrong secret" from "the write door's secret" — nor a path
    // that exists from one that does not.
    return finish(
      { error: "unauthorized", says: "That key does not open this door." },
      401,
      "denied",
    );
  }

  // The description names the tools and their fields and says nothing about the
  // household — no balance, no name, no date. It is generated from the catalogue in
  // tools.ts rather than written beside it, so a tool that exists appears here and
  // a tool that does not cannot.
  // It does NOT count against the hourly cap, and that is a choice rather than an
  // oversight: a connector may have to fetch this several times while it is being
  // built on his phone, and spending his reading allowance on the door's own
  // description would look like the door being broken during setup. It reads no
  // table, so the only thing a loop on it costs is an audit row.
  if (req.method === "GET" && segment === "openapi.json") {
    return finish(openApiDocument(deps.baseUrl), 200, "ok");
  }

  // A connector setup screen proves a key works by fetching the door itself, with
  // no path and no body. Answering 405 there reads as "this address is broken" and
  // the key gets blamed — which is exactly what happened on the first attempt to
  // connect the write door. So a bare GET, once the key is good, says yes and
  // points at the description. It reads no table and names no figure.
  if (req.method === "GET" || req.method === "HEAD") {
    if (segment === "" || segment === undefined) {
      return finish(
        { ok: true, door: "homebase", openapi: `${deps.baseUrl ?? ""}/openapi.json` },
        200,
        "ok",
      );
    }
  }

  if (req.method !== "POST") {
    return finish(
      { error: "use_post", says: "Ask by POSTing to this door. GET only serves openapi.json." },
      405,
      "denied",
    );
  }

  // The generated i18n copy has no browser storage to read a language from, so the
  // language is set explicitly rather than left to a module default. English,
  // because every sentence this door says is written in English in its own source —
  // the app's translated strings are not what goes out. A per-person language is
  // Phase 3 work and belongs here when her secret exists.
  setLangVar("en");

  // The body is read through a counted reader with a cap on it (body.ts), so a
  // caller holding a key cannot hand the isolate more than it has memory for. The
  // declared size is refused before a byte is read; a chunked body is refused as it
  // arrives.
  let body: unknown;
  let text: string;
  try {
    text = await readCappedText(req);
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      return finish(
        {
          error: "too_large",
          says: `That request is far bigger than any question here needs. Nothing over ${MAX_BODY_BYTES / 1024} KB is read.`,
        },
        413,
        "denied",
      );
    }
    console.error("muse-read: body not readable", String((e as Error)?.message ?? e));
    return finish({ error: "bad_request", says: "I could not read the body of that request." }, 400, "denied");
  }
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return finish({ error: "bad_request", says: "The body was not JSON I could read." }, 400, "denied");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return finish({ error: "bad_request", says: "The body has to be a JSON object." }, 400, "denied");
  }
  const envelope = body as Record<string, unknown>;

  // Path first, envelope second. A request that names a tool both ways and disagrees
  // is refused rather than resolved, because guessing which one he meant is how a
  // door answers a question nobody asked.
  if (segment) {
    toolName = scrubName(segment, 60);
    if (typeof envelope.tool === "string" && envelope.tool !== segment) {
      return finish(
        { error: "bad_request", says: "The address and the body asked for different things." },
        400,
        "denied",
      );
    }
    args = envelope.args && typeof envelope.args === "object" && !Array.isArray(envelope.args)
      ? (envelope.args as Record<string, unknown>)
      : withoutEnvelopeKeys(envelope);
  } else {
    if (typeof envelope.tool !== "string" || !envelope.tool) {
      return finish(
        {
          error: "bad_request",
          says: "Name the tool, either in the address or as \"tool\" in the body.",
          tools: TOOLS.map((t) => t.name),
        },
        400,
        "denied",
      );
    }
    toolName = scrubName(envelope.tool, 60);
    args =
      envelope.args && typeof envelope.args === "object" && !Array.isArray(envelope.args)
        ? (envelope.args as Record<string, unknown>)
        : {};
  }

  const tool = TOOL_BY_NAME.get(toolName);
  if (!tool) {
    // Told no AND told why. An assistant that only hears "no" improvises; one that
    // is handed the list and the reasons stops asking.
    return finish(
      {
        error: "unknown_tool",
        says: `There is no ${toolName || "such tool"} on this door.`,
        tools: TOOLS.map((t) => t.name),
        never: ABSENT.map((a) => ({ name: a.name, why: a.why })),
      },
      404,
      "denied",
    );
  }

  try {
    checkArgs(tool, args);
  } catch (e) {
    if (e instanceof BadArgs) return finish({ error: "bad_request", says: e.message }, 400, "denied");
    throw e;
  }

  const now = nowAZ(deps.at);

  // ── the cap ────────────────────────────────────────────────────────────────
  // Counted here rather than at the top of the request, so a malformed call cannot
  // spend somebody's hour — the same place the write door counts, and the same
  // bucket spelling the migration names. A counter that will not answer is a
  // REFUSAL, never "plenty left": the cap exists for the case where something is
  // looping, which is exactly when the database is under load.
  const bucket = `read:${azDateISO(now)}T${String(now.getHours()).padStart(2, "0")}`;
  let used: number;
  try {
    used = await deps.limit.bump(person, bucket);
  } catch (e) {
    console.error("muse-read: rate counter unreadable", String((e as Error)?.message ?? e));
    return finish(
      {
        error: "failed",
        says: "I could not check my own call count just now, so I stopped rather than answer.",
      },
      500,
      "error",
    );
  }
  if (used > READS_PER_HOUR) {
    return finish(
      {
        error: "rate_limited",
        says: `That is ${READS_PER_HOUR} questions this hour already. Wait for the hour to turn, or open the app.`,
      },
      429,
      "rate_limited",
    );
  }

  try {
    const result = await tool.run({ person, now, args, load: createLoader(deps.db) });
    return finish({ tool: tool.name, ...result }, 200, "ok");
  } catch (e) {
    if (e instanceof BadArgs) {
      return finish({ error: "bad_request", says: e.message }, 400, "denied");
    }
    if (e instanceof LedgerUnreadable) {
      // Rule 5, out loud. No number goes out, and the sentence says which it is:
      // not an outage, not a zero — a refusal to compute from part of the ledger.
      console.error("muse-read: ledger unreadable", e.message);
      return finish(
        {
          error: "ledger_unreadable",
          says: "I could not read the whole ledger just now, so I am not going to give you a number. Try again in a moment, and check the app if it keeps happening.",
          table: e.table,
        },
        503,
        "error",
      );
    }
    console.error("muse-read failed", tool.name, String((e as Error)?.message ?? e));
    return finish(
      {
        error: "failed",
        says: "Something went wrong working that out, so there is no number to give you.",
      },
      500,
      "error",
    );
  }
}

/** A flat body (`{"from":"…","to":"…"}`) treated as the arguments, once the
 *  envelope's own two keys are out of the way. */
function withoutEnvelopeKeys(envelope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (k === "tool" || k === "args") continue;
    out[k] = v;
  }
  return out;
}
