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
//      field is a write that did not do what the caller thinks it did. The read
//      door's spelling of a field (`protein_g` for `p`, `weight_lb` for `weight`) is
//      accepted and renamed first — see shapes.ts.
//   5  Was this key used before? A repeat replays the first answer and writes
//      nothing.
//   5b THE SHAPE: first, is this call the tool's own EXAMPLE, sent as it stands? Its
//      values are made up, so that is refused. Then the tool's own `check`, which looks
//      inside every list and at every field's type and range, and needs no database.
//      Every problem comes back in one reply, with the keys that were sent and an
//      example of a call that works. Here, and not later, so a malformed call does not
//      spend a slot of the hourly budget; and after 5, so a genuine retry of a call
//      that already landed still replays rather than being re-judged against a
//      calendar that may have turned over since.
//   6  The rate limit, counted in the locked-down muse_calls table.
//   7  Did the HOUSEHOLD already do this? The key in step 5 is per caller; this one
//      asks whether the same write, with the same numbers, came through either
//      person's key in the last few minutes — because two people with two assistants
//      do not know what the other just asked for. It refuses and names who did it,
//      and `do_it_anyway: true` is the way past.
//   8  CLAIM the key by writing the audit row, and only then act. A row written
//      afterwards would guard nothing: two simultaneous identical calls would
//      both pass every check above and both write.
//   9  Run the tool. A refusal gives the key back (nothing happened). A crash
//      keeps it (we cannot prove nothing happened, so a retry needs a new key).
//
//   9  Store the UNDO RECORD with the call, and hand the caller its token.
//
// STEP 9 IS PHASE 2, AND IT IS WHAT REPLACED "A SHORT LIST OF VERBS"
//   Phase 1's safety story was that almost nothing could be changed. This phase's
//   instruction is his own: the assistant has every functionality the app has, and
//   what makes that safe is that every change writes down what was there first.
//   Homebase never moves money — it records, categorises and computes — so the worst
//   a wrong write does is make data wrong, and wrong data can be undone.
//
//   The audit row is already keyed on (person, tool, idem_key) and already holds
//   `result` for a replay, so the before-state rides along in it and the token is
//   those three things. Looking a token up, refusing a second undo of the same
//   change, and dispatching to the registry belong to the undo core; see
//   undoContract.ts for exactly what this handler owes it and what it owes back.
//
// WHAT IS STILL DELIBERATELY ABSENT
//   Nothing here can disconnect the bank. A Plaid disconnect wipes the accounts and
//   their entire transaction history (_shared/callerAuth.ts), no before-state can
//   hold that, and so it stays a one-time code he types rather than a chat command.
//   No tool calls another edge function. No tool writes food_cache.

import type { Db, Person, Push } from "./db.ts";
import { azDateISO, minusMinutes, minutesSince, ticks } from "../_shared/muse/az.ts";
import { callerOf, callerOfAny } from "../_shared/muse/auth.ts";
import { BodyTooLarge, MAX_BODY_BYTES, readCappedText } from "../_shared/muse/body.ts";
import { scrubName } from "../_shared/muse/scrub.ts";
// TOOL_BY_NAME, not TOOLS: routing goes through the Map. `REGISTRY[name]` answered for
// every key on Object.prototype, so "constructor", "__proto__" and "toString" each found
// an inherited value and got past the "no such tool" check.
import { DISPLAY, TOOL_BY_NAME, TOOL_NAMES, type Tool } from "./tools.ts";
import { mintToken, undoSummary } from "../_shared/muse/undo.ts";
import { canonicalArgs, renameAliases, sayKey, shapeSays } from "./shapes.ts";

/** Writes per person per Arizona hour. Meta publishes no rate limits for
 *  connectors, so this is ours.
 *
 *  It started at 10, which the first real hour of use spent on repairs — three bill
 *  links, two bill settings — leaving a weigh-in refused with "do this one in the
 *  app" on a system whose whole point is that there is no app to open. The cap is
 *  there to bound a loop, not to ration a household: a morning of catching up on
 *  meals, sets and charges is easily thirty writes, and every one of them is
 *  recorded, reversible, and cannot move money. 60 still stops a runaway at a cost
 *  of one wasted minute. */
export const WRITES_PER_HOUR = 60;

/**
 * How far back the door looks for the same write the household already made.
 *
 * THE CASE, IN ONE SENTENCE: two people, two assistants, one house, and neither of
 * them knows the other just did it. She asks hers to record what the electric bill
 * came to; four minutes later he asks his the same thing. Both calls are perfectly
 * valid, both hold a real key, and the idempotency key cannot see it — that key is
 * per caller and per request, and these are two callers sending two different keys.
 *
 * Ten minutes, because that is about how long "we were both just talking about it"
 * lasts. Longer and a genuine second weigh-in after a shower starts getting refused;
 * shorter and the two of them miss each other.
 */
export const DUPLICATE_WINDOW_MIN = 10;

/**
 * Fields the DOOR handles, on every tool, rather than any one tool declaring them.
 *
 * There is exactly one, and it is the way past the duplicate guard above — and, since
 * review on 2026-10-10, past the example guard (see EXAMPLE_SENT): both refuse a call
 * that may be perfectly real, and both need a way for a caller that means it to say
 * so. It lives here and not in a tool's `fields` list because a guard a tool could
 * forget to opt into is not a guard — the same reason `person` is refused in one
 * place for every tool rather than checked in seven.
 *
 * It is stripped before the tool sees it, and it is NOT part of the payload
 * fingerprint: it does not change what gets written, only whether the door is
 * willing to write it again. Keeping it out of the fingerprint is what lets a caller
 * that was just refused resend the very same request with the flag on, under the same
 * Idempotency-Key, and have it go through instead of coming back "you used that key
 * for a different request".
 */
export const UNIVERSAL_FIELDS = ["do_it_anyway"] as const;

export interface Secrets {
  gino: string;
  xinyan: string;
}

export interface Deps {
  db: Db;
  push: Push;
  secrets: Secrets;
  /**
   * A SECOND set of secrets this door also answers to — in production, the read
   * keys. Muse's connector stores one bearer token per BARE HOSTNAME and both
   * doors live on one host, so a second connector for the write door was refused
   * six times. See callerOfAny in _shared/muse/auth.ts for the full account and
   * for what the collapse costs. Optional, and absent in every test that is not
   * about it, so the two-key behaviour is still what the suite describes.
   */
  alsoAccept?: Secrets;
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
export function personFor(req: Request, secrets: Secrets, alsoAccept?: Secrets): Person | null {
  return alsoAccept ? callerOfAny(req, [secrets, alsoAccept]) : callerOf(req, secrets);
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

/** The tool's own shape check, or nothing for a tool that has none. Handed the
 *  request's clock and nothing else — see ShapeCtx in kit.ts. */
function shapeProblems(def: Tool, args: Record<string, unknown>, clock: Deps["clock"]): string[] {
  return def.check ? def.check(args, { az: clock.az, at: clock.at }) : [];
}

/**
 * Is this call the tool's own example, exactly as the description prints it?
 *
 * FOUND IN REVIEW 2026-10-10. Every shape refusal hands the example back, and most
 * examples carry no id — so one sent as it stands is a real write: the example's weight
 * as today's weigh-in, its macro target over the real one, its reminder on a lock
 * screen. A probe found fifteen tools that answered 200 to their own example. An
 * assistant stuck in a retry loop sending back the last thing it was given is exactly
 * the caller who would do it.
 *
 * Compared on the door's own spelling at every level (canonicalArgs), with key order
 * not mattering — so the example re-sent under the read door's words is caught too. A
 * tool that takes nothing has `{}` for an example, and `{}` is also the one real call
 * it has, so an empty example is never matched.
 */
function isTheExample(def: Tool, canon: Record<string, unknown>): boolean {
  if (Object.keys(def.example).length === 0) return false;
  return JSON.stringify(canonical(canon)) === JSON.stringify(canonical(def.example));
}

/** The refusal for a call that is its tool's example. The way past is said, and
 *  conditioned on a person: an example can coincide with a real request ("delete the
 *  weigh-in on that day"), and a guard with no way through would turn that request
 *  away for ever. */
export const EXAMPLE_SENT =
  "That is the example call from this door's description, exactly as printed. Its values are made up, " +
  "so I wrote nothing. Send the real values instead. If the person really did ask for exactly these, " +
  "send it again with do_it_anyway: true.";

/**
 * A refusal about the SHAPE of a call: every problem, the keys that were sent, and one
 * call that works.
 *
 * `problems` and `received` are there as well as the sentence so an assistant can fix
 * a list item by item without parsing prose; `example` is the tool's own, the same one
 * the description prints, so the cure arrives with the diagnosis even for an assistant
 * that read the description weeks ago and never again. Every string in the problems
 * was built from scrubbed pieces (shapes.ts), and the example is a constant in code.
 */
function shapeRefusal(def: Tool, problems: string[], received: string[]): Reply {
  return deny(400, shapeSays(problems, received, true), { problems, received, example: def.example });
}

/** The audit note for a refusal: what kind it was, then the problems, capped. Key
 *  names and item labels only — the problems never quote a value, an amount or a
 *  memory's words, because the audit log must not hold them. */
function noteOf(head: string, problems: string[]): string {
  const text = problems.length ? `${head}: ${problems.join(" ")}` : head;
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

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

  const person = personFor(req, deps.secrets, deps.alsoAccept);
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
  const sent = rawArgs as Record<string, unknown>;
  // Membership is tested against the RAW keys — cleaning first would let "weight "
  // read as "weight" and then find nothing under it.
  const rawKeys = Object.keys(sent);
  const shown = (keys: string[]) => keys.map(sayKey).sort();
  // The audit log records what was SENT, universal fields included — "he overrode the
  // duplicate guard" is exactly the kind of thing the log is for.
  const fields = shown(rawKeys);

  // ── the read door's words, renamed before anything is judged ───────────────
  //
  // FOUND 2026-10-10. The read door says `protein_g`, `weight_lb` and `duration_min`;
  // this door wanted `p`, `weight` and `minutes`, and refused its sibling's own words.
  // A synonym only stands in for a field this tool really takes (renameAliases), and
  // the universal fields are passed through untouched. Everything after this line —
  // the unknown-field check, the shape check and the tool itself — sees the door's own
  // spelling at the TOP level. Inside a list the tool's own parser renames (shapes.ts),
  // and the fingerprint below is taken over canonicalArgs, which renames at every
  // level — so `weight_lb: 198.4` and `weight: 198.4`, and a meal item's `calories` and
  // `kcal`, are the SAME request to the duplicate guard, which is what they are.
  const named = renameAliases(sent, [...def.fields, ...UNIVERSAL_FIELDS]);
  const args = named.value;
  const extra = named.unknown;
  if (extra.length) {
    const loaded = extra.find((f) => LOADED_FIELDS[f]);
    if (loaded) {
      await db.logCall({ person, tool, args: { fields }, outcome: "denied", note: `refused field ${loaded}`, ms: ms() });
      return deny(400, LOADED_FIELDS[loaded]);
    }
    // EVERY problem in one reply, not just this one. The unknown field is said first
    // and in the sentence it has always had, and whatever the tool's own shape check
    // finds in what WAS recognised comes after it — so a meal sent flat at the top
    // level hears both "it does not take protein_g" and "I need at least one food" in
    // the same answer, instead of one round trip each.
    const problems = [
      `${tool} does not take ${shown(extra).join(", ")}. It takes ${def.fields.join(", ")}.`,
      ...named.clashes,
      ...shapeProblems(def, args, clock),
    ];
    await db.logCall({
      person, tool, args: { fields }, outcome: "denied",
      note: noteOf(`unknown fields: ${shown(extra).join(", ")}`, problems.slice(1)), ms: ms(),
    });
    return shapeRefusal(def, problems, fields);
  }

  // ── the door's own field, taken out before the tool sees anything ──────────
  // A boolean and nothing else: a truthy string would make "false" mean yes.
  const anyway = args.do_it_anyway;
  if (anyway !== undefined && typeof anyway !== "boolean") {
    await db.logCall({ person, tool, args: { fields }, outcome: "denied", note: "do_it_anyway not a boolean", ms: ms() });
    return deny(400, "do_it_anyway is either true or false.");
  }
  const override = anyway === true;
  // The tool is handed the arguments it declared and nothing else, so no tool has to
  // know this field exists — and the fingerprint below is taken over these, not over
  // the raw body, which is what makes the override invisible to the sameness check.
  const toolArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!(UNIVERSAL_FIELDS as readonly string[]).includes(k)) toolArgs[k] = v;
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

  // THE FINGERPRINT IS TAKEN OVER THE DOOR'S OWN WORDS, AT EVERY LEVEL. FOUND IN REVIEW
  // 2026-10-10: it used to be taken over toolArgs, which are only renamed at the top, so
  // a meal sent with `calories`/`protein_g` and then with `kcal`/`p` was two different
  // requests to both the idempotency check and the duplicate guard — and was logged
  // twice. A call with no alias in it is unchanged by canonicalArgs, so every
  // fingerprint already in muse_audit still matches its own retry.
  const canon = canonicalArgs(toolArgs, def.lists);
  const print = await fingerprint(tool, canon);
  const auditArgs = { fields, fingerprint: print };

  // ── has this key been here before? ──────────────────────────────────────────
  const replay = await replayFor(db, person, tool, idemKey, print);
  if (replay) return replay;

  // ── the shape, BEFORE anything is counted ──────────────────────────────────
  //
  // FOUND 2026-10-10. The counter below used to be bumped before the tool looked at
  // its own arguments, so a refusal for a missing `name` inside an exercise spent a
  // slot of the 60-an-hour budget exactly like a write that landed. In the worst hour
  // the log showed, the refusals of one back-fill outnumbered the writes that landed,
  // and a long enough back-fill at a few tries per day would have locked that person
  // out of writing for the rest of the hour, for nothing that ever reached the
  // database.
  //
  // The cap exists to stop a runaway loop that CHANGES things, so it now counts the
  // calls that get that far. A loop of malformed calls is still visible — every one
  // writes an audit row — it just cannot spend anybody's hour.
  //
  // The example guard goes first: an example passes its own shape check by design, so
  // it would sail through the next step and reach the database as a real write.
  if (!override && isTheExample(def, canon)) {
    await db.logCall({ person, tool, args: auditArgs, outcome: "denied", note: "sent the example as it stands", ms: ms() });
    return deny(400, EXAMPLE_SENT, { received: fields });
  }
  const problems = [...named.clashes, ...shapeProblems(def, toolArgs, clock)];
  if (problems.length) {
    await db.logCall({ person, tool, args: auditArgs, outcome: "denied", note: noteOf("shape", problems), ms: ms() });
    return shapeRefusal(def, problems, fields);
  }

  // ── the rate limit ─────────────────────────────────────────────────────────
  const hour = `write:${azDateISO(clock.az)}T${String(clock.az.getHours()).padStart(2, "0")}`;
  const n = await db.bump(person, hour);
  if (n > WRITES_PER_HOUR) {
    await db.logCall({ person, tool, args: auditArgs, outcome: "rate_limited", note: `${n} writes this hour`, ms: ms() });
    return deny(429, `That is ${WRITES_PER_HOUR} writes this hour already. Give it an hour, or do this one in the app.`);
  }

  // ── did the household already do this? ─────────────────────────────────────
  //
  // Here, and not earlier or later, for three reasons:
  //   · AFTER the replay check, so a genuine retry under the same key still replays
  //     its first answer instead of being told somebody else did it;
  //   · AFTER the rate limit, because it costs a database read — a caller looping on
  //     duplicates must be capped before it can make the door do work;
  //   · BEFORE the claim, because nothing is going to happen, so no key should be
  //     burned on it. The refusal goes in through logCall, which leaves the key free:
  //     the very same request with do_it_anyway can be sent again under it.
  if (!override) {
    const earlier = await db.recentSameWrite({
      tool,
      fingerprint: print,
      sinceISO: minusMinutes(clock.at, DUPLICATE_WINDOW_MIN).toISOString(),
    });
    if (earlier) {
      const mins = minutesSince(earlier.atISO, clock.at);
      const ago = mins === null || mins < 1 ? "a moment ago" : `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
      // Who, by name. "That was already done" leaves a person wondering whether they
      // did it themselves and forgot; "Xinyan already did that" ends the question.
      const who = earlier.person === person ? "That was already done" : `${DISPLAY[earlier.person]} already did that`;
      const say =
        `${who} ${ago}, so I have not done it again. ` +
        `Send it again with do_it_anyway if you really do want it twice.`;
      await db.logCall({
        person, tool, args: auditArgs, outcome: "denied",
        note: `duplicate of ${earlier.person} ${ago}`, ms: ms(),
      });
      return deny(409, say);
    }
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
    const outcome = await def.run(toolArgs, {
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
      // A 400 from inside a tool is a value it could not use — a weight that is not
      // pounds, an amount that is a string. Since 2026-10-10 it carries the keys that
      // were sent, the same `received` a shape refusal carries, so a refusal always says
      // what it was looking at. Beside the sentence, not in it: the sentence is the
      // tool's own and is said as it stands.
      return deny(outcome.status, outcome.say, outcome.status === 400 ? { received: fields } : {});
    }

    // THE UNDO RECORD GOES IN muse_undo, under a minted token, like every other change.
    //
    // It used to ride along in the audit row, with the token being (tool, idem_key). That
    // was a reasonable seam to code against while the core did not exist — but the core
    // does exist, and two stores meant `system.undo` could not reach a change made this
    // way and `system.changes` could not list one. One table, one token shape.
    //
    // ORDERING, SAID PLAINLY, because it is weaker here than on the finance side. A
    // finance tool writes its muse_undo row BEFORE it changes anything, which is what
    // lets `pending` mean "the door stopped mid-call and nobody knows whether it landed".
    // A tool that returns its record afterwards cannot have that: the row is written
    // after the change, already `undoable`, so a crash between the write and this line
    // loses the undo record while keeping the change. That is a real gap and it is the
    // narrower one of the two available — the alternative was no undo at all for 22
    // tools. It is the same class as the insert-first gap the finance half documented
    // and did not solve.
    //
    // A tool that leaves `undo` off is saying it could not honestly capture a
    // before-state, and the reply says so rather than implying one exists — UNLESS it
    // set `recorded`, which means it wrote its own row before it changed anything (every
    // finance tool, through commit()). That one has a token and the reply must say so:
    // see undoEnvelope below for the day it did not.
    const stored: Record<string, unknown> = { message: outcome.say, result: outcome.result };
    if (outcome.undo) {
      const undoTok = mintToken((into) => crypto.getRandomValues(into));
      await db.recordChange({
        token: undoTok,
        person,
        tool,
        summary: undoSummary(outcome.undo.says),
        // ONE step, naming the inverse and carrying what it needs. The handler is code,
        // by name, because these rows are documents rather than columns — see the
        // `run_handler` note in _shared/muse/undo.ts.
        steps: [{ kind: "run_handler", handler: outcome.undo.kind, before: outcome.undo.before }],
      });
      // Straight to `undoable`. A change row is BORN `pending`, because the finance tools
      // write theirs before they touch anything and `pending` is how the log says "the
      // door stopped mid-call and nobody knows whether it landed". This path is the other
      // way round — the write has already returned — so `pending` would be a state that is
      // never true here, and `system.changes` would tell him to go and check the app about
      // a change it can see succeeded.
      await db.setChangeState(undoTok, "undoable", {});
      // Kept in the audit row too, so a REPLAY of the same idempotency key hands back
      // the same token and the same sentence rather than minting a second one.
      stored.undo = { ...outcome.undo, token: undoTok };
    } else if (outcome.recorded) {
      // Already in muse_undo — the tool wrote the row itself, before it changed
      // anything. Nothing to mint and nothing to store but the token and its sentence,
      // which go into the audit row for the same replay reason as above.
      stored.undo = { token: outcome.recorded.token, says: outcome.recorded.says };
    }
    await db.finishCall({
      person, tool, idemKey,
      outcome: "ok",
      result: stored,
      rowIds: outcome.rowIds,
      ms: ms(),
    });
    const body: Record<string, unknown> = {
      ok: true,
      tool,
      message: outcome.say,
      result: outcome.result,
      ...undoEnvelope(stored),
    };
    return { status: 200, body };
  } catch (e) {
    // The key stays used. We cannot prove nothing landed, and re-running a write
    // we might already have done is the failure this whole header exists to stop.
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    console.error("muse-write", tool, why);
    await db.finishCall({ person, tool, idemKey, outcome: "error", ms: ms(), note: why });
    return deny(500, "Something went wrong on my side and I stopped. Nothing was retried. Check the app.");
  }
}

/** Said when a change truly has nothing written down that could reverse it. */
const CANNOT_UNDO = "Nothing was written down that could put this back.";

/**
 * The undo half of a success reply, built from what the AUDIT ROW stores — so the first
 * answer and every replay of it say exactly the same thing.
 *
 * THREE ANSWERS, and the envelope may only claim the last one when it is true:
 *
 *   a token      the change is in muse_undo. `undo` carries it, with the sentence
 *                saying what undoing does, and `only_until` when something outside
 *                this door can overwrite the restore.
 *   a call       the memory store's undo is a tool, not a token (memoryWrites.ts says
 *                why): the result names `memory.restore` or `memory.forget`, and its
 *                key. That is a real way back, so the reply names it in `undo_with` and
 *                does not say nothing could put it back.
 *   neither      `undo: null`, and `cannot_undo` says so.
 *
 * FOUND 2026-10-09. finance.set_bill_amount answered with a token in result.undo —
 * a real row, `undoable`, in muse_undo — and, in the same reply, `undo: null` and
 * "Nothing was written down that could put this back." Every finance write said that,
 * because this function did not exist: the reply only knew about a record the HANDLER
 * minted, and every finance tool writes its own row first (commit() in toolsFinance.ts).
 * The memory writes said it too, about a `previous` column that is exactly what was
 * written down. An assistant that trusted the envelope over the result would have told
 * him his change was permanent.
 */
function undoEnvelope(stored: Record<string, unknown>): Record<string, unknown> {
  const undo = stored.undo as { says?: unknown; fragile?: unknown; token?: unknown } | undefined;
  if (undo && typeof undo.token === "string") {
    return {
      undo: {
        token: undo.token,
        says: undo.says,
        ...(undo.fragile ? { only_until: undo.fragile } : {}),
      },
    };
  }
  const call = undoCallOf(stored.result);
  if (call) return { undo: null, undo_with: call };
  return { undo: null, cannot_undo: CANNOT_UNDO };
}

/**
 * The calls this door will name as a way back. A list, not "any tool this door has".
 *
 * FOUND 2026-10-09, in review of the change that added `undo_with`. The first version
 * repeated any tool name a result put in `undo`, and the memory writes named
 * memory.restore for every outcome — including a brand-new key, where restore refuses,
 * and a key restore had just brought back, where restore swaps in the OLDER wording and
 * leaves it live. The envelope then told the assistant to make that call. memoryWrites.ts
 * now names the real inverse for each outcome (see done() there); this list is the other
 * half, so that a result naming some other tool as its undo is not passed on as one
 * without somebody first deciding here that it really is.
 */
const UNDO_CALLS: ReadonlySet<string> = new Set(["memory.restore", "memory.forget"]);

/** The tool call a result names as its own undo, when it is one of UNDO_CALLS and this
 *  door has it — `{ tool: "memory.forget", args: { key } }` and the like. Anything else
 *  is not a way back and is not repeated as one. */
function undoCallOf(result: unknown): { tool: string; args: Record<string, unknown> } | null {
  if (typeof result !== "object" || result === null) return null;
  const u = (result as Record<string, unknown>).undo;
  if (typeof u !== "object" || u === null || Array.isArray(u)) return null;
  const { tool, args } = u as { tool?: unknown; args?: unknown };
  if (typeof tool !== "string" || !UNDO_CALLS.has(tool) || !TOOL_BY_NAME.has(tool)) return null;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { tool, args: args as Record<string, unknown> };
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
    // Rebuilt field by field, NOT spread. The stored record now carries the undo
    // record, and its `before` can be a whole session document — spreading it would
    // put the before-state of every write into the reply, which is a copy of the
    // ledger arriving by the back door. The repeat gets the same three things the
    // first call got: the sentence, the result, and the token.
    const body: Record<string, unknown> = {
      ok: true,
      tool,
      repeated: true,
      message: stored.message,
      result: stored.result,
    };
    // The TOKEN COMES OUT OF THE STORED RECORD, not from the tool and the key. It used to
    // be derived from (tool, idem_key), which made a replay reproduce it for free; now it
    // is minted once and written into muse_undo, so the replay has to hand back the one
    // that is actually in the table. Minting a second one here would give the assistant a
    // token naming no change.
    return { status: 200, body: { ...body, ...undoEnvelope(stored) } };
  }
  if (earlier.outcome === "pending") {
    return deny(409, "I am still working on that one. Ask me again in a moment rather than sending it twice.");
  }
  return deny(409, `That key already ${earlier.outcome === "error" ? "failed" : "came back refused"}. Send a new one.`);
}
