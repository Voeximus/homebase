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

import { nowAZ } from "./az.ts";
import { callerOf, type ReadSecrets } from "./auth.ts";
import type { AuditSink, Outcome } from "./audit.ts";
import { LedgerUnreadable } from "./paging.ts";
import { createLoader } from "./load.ts";
import type { Db } from "./paging.ts";
import { BadArgs, TOOL_BY_NAME, TOOLS, ABSENT, type Json } from "./tools.ts";
import { openApiDocument } from "./openapi.ts";
import { setLangVar } from "./lib/i18n.ts";

export interface HandlerDeps {
  db: Db;
  secrets: ReadSecrets;
  audit: AuditSink;
  /** The instant to answer about. Defaults to the real clock — the door's ONLY
   *  clock reading, and it lives behind nowAZ() so a test can hand in a moment. */
  at?: Date;
  /** The public base URL, for the OpenAPI `servers` entry. */
  baseUrl?: string;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** No CORS. A connector's request comes from a server, not a browser, and a door
 *  that answered a preflight would be reachable from any web page he happened to
 *  have open. */
function reply(body: { [k: string]: Json }, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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
    if (!allowed.has(key)) throw new BadArgs(`${tool.name} does not take ${key}.`);
  }
}

export async function handleMuseRead(req: Request, deps: HandlerDeps): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const segment = toolFromPath(url.pathname);

  // Everything the audit row needs, filled in as it becomes known, written once at
  // the end. A single writer means no path can return without a row.
  let person = null as ReturnType<typeof callerOf>;
  let toolName = segment || "(none)";
  let args: Record<string, unknown> = {};

  const finish = async (body: { [k: string]: Json }, status: number, outcome: Outcome): Promise<Response> => {
    const text = JSON.stringify(body);
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

  // The description is the one thing served without a secret: it names the tools
  // and says nothing about the household. A connector has to be able to read it
  // before it has been given anything.
  //
  // It is also the one reply that is NOT audited, deliberately. An unauthenticated
  // request that writes a row lets anyone fill a table nobody is rate-limiting, and
  // an audit log full of strangers fetching a fixed document is an audit log nobody
  // reads. Everything that could touch household data is audited, refusals included.
  if (req.method === "GET" && segment === "openapi.json") {
    return reply(openApiDocument(deps.baseUrl), 200);
  }

  if (req.method !== "POST") {
    return finish(
      { error: "use POST", says: "Ask by POSTing to this door. GET only serves openapi.json." },
      405,
      "denied",
    );
  }

  person = callerOf(req, deps.secrets);
  if (!person) {
    // One refusal for every kind of wrong key, so the body cannot be used to tell
    // "no secret" from "wrong secret" from "the write door's secret".
    return finish(
      { error: "unauthorized", says: "That key does not open this door." },
      401,
      "denied",
    );
  }

  // The generated i18n copy has no browser storage to read a language from, so the
  // language is set explicitly rather than left to a module default. English,
  // because every sentence this door says is written in English in its own source —
  // the app's translated strings are not what goes out. A per-person language is
  // Phase 3 work and belongs here when her secret exists.
  setLangVar("en");

  let body: unknown = {};
  if (req.headers.get("Content-Length") !== "0") {
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return finish({ error: "bad json", says: "The body was not JSON I could read." }, 400, "denied");
    }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return finish({ error: "bad body", says: "The body has to be a JSON object." }, 400, "denied");
  }
  const envelope = body as Record<string, unknown>;

  // Path first, envelope second. A request that names a tool both ways and disagrees
  // is refused rather than resolved, because guessing which one he meant is how a
  // door answers a question nobody asked.
  if (segment) {
    toolName = segment;
    if (typeof envelope.tool === "string" && envelope.tool !== segment) {
      return finish(
        { error: "two tools", says: "The address and the body asked for different things." },
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
          error: "no tool",
          says: "Name the tool, either in the address or as \"tool\" in the body.",
          tools: TOOLS.map((t) => t.name),
        },
        400,
        "denied",
      );
    }
    toolName = envelope.tool;
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
        error: "no such tool",
        says: `There is no ${toolName} on this door.`,
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
    if (e instanceof BadArgs) return finish({ error: "bad arguments", says: e.message }, 400, "denied");
    throw e;
  }

  const now = nowAZ(deps.at);

  try {
    const result = await tool.run({ person, now, args, load: createLoader(deps.db) });
    return finish({ tool: tool.name, ...result }, 200, "ok");
  } catch (e) {
    if (e instanceof BadArgs) {
      return finish({ error: "bad arguments", says: e.message }, 400, "denied");
    }
    if (e instanceof LedgerUnreadable) {
      // Rule 5, out loud. No number goes out, and the sentence says which it is:
      // not an outage, not a zero — a refusal to compute from part of the ledger.
      console.error("muse-read: ledger unreadable", e.message);
      return finish(
        {
          error: "ledger unreadable",
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
