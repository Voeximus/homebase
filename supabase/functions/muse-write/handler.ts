// The write door itself: one POST per tool, a secret in a header, and a row in
// the audit log for every call.
//
// This file holds no database code and no Deno code, which is deliberate — it is
// the part the tests drive. index.ts wires it to Supabase, to the push helper and
// to the real clock.
//
// THE ORDER OF THE CHECKS IS PART OF THE DESIGN
//   1  POST only.
//   2  The secret says WHO. Fails closed: no secret, an unknown secret, or a
//      secret that was never configured all deny, and nothing is written — an
//      unauthorized call cannot be attributed to a person, so it cannot be
//      audited either. It goes to the console instead.
//   3  An Idempotency-Key is required. A connector's call can be retried by the
//      assistant on a timeout, by Meta's outbound gate, or by him asking again
//      after a slow reply — and without a key, "log 198.4" twice is two rows.
//   4  The body, the tool name, and the fields that tool accepts. An unknown
//      field is refused by name rather than ignored, because a silently ignored
//      field is a write that did not do what the caller thinks it did.
//   5  Was this key used before? A repeat replays the first answer and writes
//      nothing.
//   6  The rate limit, counted in the locked-down muse_calls table.
//   7  CLAIM the key by writing the audit row, and only then act. A row written
//      afterwards would guard nothing: two simultaneous identical calls would
//      both pass every check above and both write.
//   8  Run the tool. A refusal gives the key back (nothing happened). A crash
//      keeps it (we cannot prove nothing happened, so a retry needs a new key).
//
// WHAT IS DELIBERATELY ABSENT
//   No tool for moving money, deleting anything, settling a bill cycle, writing
//   paid_bills, changing a debt balance or a savings goal, writing food_cache, or
//   calling another edge function. Not disabled — absent. See tools.ts.

import type { Db, Person, Push } from "./db.ts";
import { azDateISO, ticks } from "../_shared/muse/az.ts";
import { callerOf } from "../_shared/muse/auth.ts";
import { BodyTooLarge, MAX_BODY_BYTES, readCappedText } from "../_shared/muse/body.ts";
import { scrubName } from "../_shared/muse/scrub.ts";
import { TOOL_BY_NAME, TOOL_NAMES } from "./tools.ts";

/** Writes per person per Arizona hour. Meta publishes no rate limits for
 *  connectors, so this is ours. */
export const WRITES_PER_HOUR = 10;

export interface Secrets {
  gino: string;
  xinyan: string;
}

export interface Deps {
  db: Db;
  push: Push;
  secrets: Secrets;
  appUrl: string;
  /** Built once by clockNow(), passed in. The door never reads a clock itself. */
  clock: { at: Date; az: Date };
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Which person's secret is this? Never the request body — the body is written by
 * a model that may have been talked into writing anything, and `sendPush` fans
 * out to EVERY stored subscription when the owner is undefined, so a missing
 * field would not mean "Gino", it would mean the whole household.
 *
 * ONE ANSWER FOR BOTH DOORS, and this is the third thing the two doors stopped
 * spelling twice (after az.ts and scrub.ts). This function used to have its own
 * comparison and its own rules, and it had drifted in two ways that both mattered
 * on the door that CHANGES things:
 *
 *   · it accepted any non-empty configured secret, while the read door refuses
 *     anything under 24 characters (MIN_SECRET_LENGTH) precisely so a placeholder
 *     or a half-pasted value locks the door instead of opening it. So "changeme"
 *     would have opened the write door and been refused by the read door, and
 *     supabase/config.toml claimed both doors checked;
 *   · it returned on the first match, which makes "is this Gino's secret"
 *     measurably faster to test than "is this Xinyan's". callerOf compares every
 *     candidate before answering.
 *
 * Two headers are accepted for now because nobody outside Meta has published what
 * a phone-built connector puts a static secret in. PLAN.md's Phone Test 2 settles
 * it on his phone; when it does, delete the losing branch in auth.ts.
 */
export function personFor(req: Request, secrets: Secrets): Person | null {
  return callerOf(req, secrets);
}

/** Key order must not change a fingerprint, or the same request sent twice looks
 *  like two different ones. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * A fingerprint of what was asked, so one key reused for a DIFFERENT request is
 * caught instead of quietly replaying the wrong answer.
 *
 * It is not a secret and is not treated as one: the payload space is small enough
 * to guess at, and only the household can read the audit table — and they can
 * read the underlying rows anyway. It is a sameness check, nothing more.
 */
async function fingerprint(tool: string, args: unknown): Promise<string> {
  const text = JSON.stringify({ tool, args: canonical(args) });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const deny = (status: number, message: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  body: { ok: false, message, ...extra },
});

/** Fields whose presence is not a typo but an attempt at something the door does
 *  not allow, so each gets its own sentence. */
const LOADED_FIELDS: Record<string, string> = {
  person: "Reminders and logs go to whoever's key was used. There is no way to aim one at somebody else from here.",
  owner: "Reminders and logs go to whoever's key was used. There is no way to aim one at somebody else from here.",
  for: "Reminders and logs go to whoever's key was used. There is no way to aim one at somebody else from here.",
  applies_to: "Nothing here can settle a bill. That is a tap in the app, looking at both numbers.",
  appliesTo: "Nothing here can settle a bill. That is a tap in the app, looking at both numbers.",
  type: "This only adds an expense. Income goes in the app.",
};

export async function handleWrite(req: Request, deps: Deps): Promise<Reply> {
  const started = ticks();
  const ms = () => ticks() - started;

  if (req.method !== "POST") {
    return deny(405, "Send a POST with a tool name and its arguments.");
  }

  const person = personFor(req, deps.secrets);
  if (!person) {
    // Nothing is written: there is no person to attribute the row to, and an
    // audit table a stranger can fill up is its own problem.
    console.warn("muse-write: denied, no recognized secret");
    return deny(401, "Unauthorized.");
  }

  // ── the belt under the whole request ────────────────────────────────────────
  // This file's own first line promises "a row in the audit log for every call",
  // and a crafted tool name used to break that promise: `TOOLS[tool]` found an
  // inherited value for "constructor", `def.fields` was undefined, the TypeError
  // escaped this function entirely, and index.ts answered 503 "I could not reach
  // the ledger cleanly" — blaming the database, with NO row written anywhere. An
  // audit log a string can skip is not an audit log. The lookup is own-property
  // only now (below), and this catch is the belt under it: anything unexpected
  // from here on is recorded against the person whose key opened the door.
  try {
    return await afterAuth(req, deps, person, ms);
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    console.error("muse-write: unhandled", why);
    try {
      await deps.db.logCall({ person, tool: "?", args: {}, outcome: "error", note: why, ms: ms() });
    } catch (logErr) {
      console.error("muse-write: audit row not written", String((logErr as Error)?.message ?? logErr));
    }
    return deny(500, "Something went wrong on my side and I stopped. Nothing was retried. Check the app.");
  }
}

async function afterAuth(
  req: Request,
  deps: Deps,
  person: Person,
  ms: () => number,
): Promise<Reply> {
  const { db, clock } = deps;

  // Capped before it is read, and counted in BYTES as it arrives — see body.ts.
  // The old check read the whole body first and then measured `text.length`, which
  // counts UTF-16 units, so 16,000 four-byte characters passed a cap named BYTES.
  let text: string;
  try {
    text = await readCappedText(req);
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      await db.logCall({ person, tool: "?", args: {}, outcome: "denied", note: "body too large", ms: ms() });
      return deny(
        413,
        `That request is far bigger than any of these tools needs. Nothing over ${MAX_BODY_BYTES / 1024} KB is read.`,
      );
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    await db.logCall({ person, tool: "?", args: {}, outcome: "denied", note: "body was not JSON", ms: ms() });
    return deny(400, "I could not read that as JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    await db.logCall({ person, tool: "?", args: {}, outcome: "denied", note: "body was not an object", ms: ms() });
    return deny(400, "Send an object with a tool and its args.");
  }
  const body = parsed as Record<string, unknown>;
  // Checked before it is stored or echoed. A tool name and a field name are
  // strings a caller chose, and both end up in the audit log and on his settings
  // screen — so they are no more trusted than a bank descriptor. They are names
  // rather than sentences, so scrubName keeps the name off the front and drops
  // whatever was appended to it; a real tool name comes through unchanged.
  const tool = scrubName(body.tool, 60);
  if (!tool) {
    await db.logCall({ person, tool: "?", args: {}, outcome: "denied", note: "no tool named", ms: ms() });
    return deny(400, "Name the tool.", { tools: TOOL_NAMES });
  }

  // A Map, not `TOOLS[tool]`. The registry is a plain object, so an object-literal
  // lookup answers for every key on Object.prototype: "constructor", "__proto__",
  // "toString", "valueOf" and "hasOwnProperty" all found an inherited value and
  // sailed past this check, and scrubName passes them through because they are made
  // of the characters a name is made of. One of them then crashed on `def.fields`
  // with no audit row at all; another spent a rate-limit slot, wrote a row naming a
  // tool that does not exist, and burned the caller's Idempotency-Key. The read door
  // has always used a Map (_shared/muse/tools.ts); this one does now.
  const def = TOOL_BY_NAME.get(tool);
  if (!def) {
    await db.logCall({ person, tool, args: {}, outcome: "denied", note: "no such tool", ms: ms() });
    return deny(404, `There is no ${tool} on this door.`, { tools: TOOL_NAMES });
  }

  const rawArgs = body.args === undefined ? {} : body.args;
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    await db.logCall({ person, tool, args: {}, outcome: "denied", note: "args was not an object", ms: ms() });
    return deny(400, "args is an object of fields.");
  }
  const args = rawArgs as Record<string, unknown>;
  // Membership is tested against the RAW keys — cleaning first would let "weight "
  // read as "weight" and then find nothing under it.
  const rawKeys = Object.keys(args);
  const shown = (keys: string[]) => keys.map((k) => scrubName(k, 24) || "?").sort();
  const fields = shown(rawKeys);
  const extra = rawKeys.filter((f) => !def.fields.includes(f));
  if (extra.length) {
    const loaded = extra.find((f) => LOADED_FIELDS[f]);
    const note = loaded ? `refused field ${loaded}` : `unknown fields: ${shown(extra).join(", ")}`;
    await db.logCall({ person, tool, args: { fields }, outcome: "denied", note, ms: ms() });
    return deny(
      400,
      loaded
        ? LOADED_FIELDS[loaded]
        : `${tool} does not take ${shown(extra).join(", ")}. It takes ${def.fields.join(", ")}.`,
    );
  }

  // A key, not a sentence. Bounded to the characters a key is made of, so nothing
  // that lands in the audit log through this header can carry text at all.
  const idemKey = (req.headers.get("Idempotency-Key") ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idemKey)) {
    await db.logCall({ person, tool, args: { fields }, outcome: "denied", note: "no usable Idempotency-Key", ms: ms() });
    return deny(
      400,
      "Every write needs an Idempotency-Key header: 8 to 200 characters, letters, numbers, dots, colons or dashes. Send the same one if you retry.",
    );
  }

  const print = await fingerprint(tool, args);
  const auditArgs = { fields, fingerprint: print };

  // ── has this key been here before? ──────────────────────────────────────────
  const replay = await replayFor(db, person, tool, idemKey, print);
  if (replay) return replay;

  // ── the rate limit ─────────────────────────────────────────────────────────
  const hour = `write:${azDateISO(clock.az)}T${String(clock.az.getHours()).padStart(2, "0")}`;
  const n = await db.bump(person, hour);
  if (n > WRITES_PER_HOUR) {
    await db.logCall({ person, tool, args: auditArgs, outcome: "rate_limited", note: `${n} writes this hour`, ms: ms() });
    return deny(429, `That is ${WRITES_PER_HOUR} writes this hour already. Give it an hour, or do this one in the app.`);
  }

  // ── claim the key, THEN act ────────────────────────────────────────────────
  const claim = await db.claimCall({ person, tool, idemKey, args: auditArgs });
  if (claim === "duplicate") {
    // Two calls arrived together and the other one won the index.
    const second = await replayFor(db, person, tool, idemKey, print);
    if (second) return second;
    return deny(409, "That key is already in use. Give it a moment, then ask me what happened.");
  }

  try {
    const outcome = await def.run(args, {
      db,
      push: deps.push,
      person,
      at: clock.at,
      az: clock.az,
      appUrl: deps.appUrl,
    });

    if (!outcome.ok) {
      // A refusal never burns the key: every refusal in tools.ts happens before
      // that tool's first write, so there is nothing to be idempotent about.
      await db.releaseCall(person, tool, idemKey);
      await db.logCall({ person, tool, args: auditArgs, outcome: "denied", note: outcome.say, ms: ms() });
      return deny(outcome.status, outcome.say);
    }

    const stored = { message: outcome.say, result: outcome.result };
    await db.finishCall({
      person, tool, idemKey,
      outcome: "ok",
      result: stored,
      rowIds: outcome.rowIds,
      ms: ms(),
    });
    return { status: 200, body: { ok: true, tool, ...stored } };
  } catch (e) {
    // The key stays used. We cannot prove nothing landed, and re-running a write
    // we might already have done is the failure this whole header exists to stop.
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    console.error("muse-write", tool, why);
    await db.finishCall({ person, tool, idemKey, outcome: "error", ms: ms(), note: why });
    return deny(500, "Something went wrong on my side and I stopped. Nothing was retried. Check the app.");
  }
}

/** The answer for a key that has been used before, or null when it is new. */
async function replayFor(
  db: Db,
  person: Person,
  tool: string,
  idemKey: string,
  print: string,
): Promise<Reply | null> {
  const earlier = await db.findCall(person, tool, idemKey);
  if (!earlier) return null;
  if (earlier.args?.fingerprint !== print) {
    return deny(409, "That Idempotency-Key was used for a different request. Use a new one.");
  }
  if (earlier.outcome === "ok") {
    const stored = (earlier.result ?? {}) as Record<string, unknown>;
    return { status: 200, body: { ok: true, tool, repeated: true, ...stored } };
  }
  if (earlier.outcome === "pending") {
    return deny(409, "I am still working on that one. Ask me again in a moment rather than sending it twice.");
  }
  return deny(409, `That key already ${earlier.outcome === "error" ? "failed" : "came back refused"}. Send a new one.`);
}
