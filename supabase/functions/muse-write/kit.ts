// What a write tool IS, and the handful of checks every one of them shares.
//
// WHY THIS IS NOT IN tools.ts ANY MORE. Phase 1 had seven write tools and one
// file, so the shape and the checks lived beside them. Phase 2's instruction is
// his own: "Muse has to have every functionality given in the app and the app must
// become a database for patterns and information storage." That turns seven tools
// into dozens across two domains, and two catalogue files that both need `dateFor`
// would either import it from each other — a cycle, and the registry is built at
// module load, so a cycle here is a door that does not start — or carry a copy
// each. A copy is the drift the whole bridge exists to stop: the two doors already
// grew two clocks and two cleaners once, and scripts/check-categorizer-sync.mjs
// fails the build over it.
//
// So the shape and the checks are HERE, once. Nothing in this file touches the
// database, reads a clock, or decides anything a tool decides.

import type { Db, Person, Push } from "./db.ts";
import { azDateISO, daysBetweenISO, isDateISO } from "../_shared/muse/az.ts";
import type { UndoRecord } from "./undoContract.ts";
import { keysOf, shapeSays, type ListShape } from "./shapes.ts";

/** The push_subscriptions "owner" spelling, and the name a sentence uses. Lives in
 *  _shared/muse/auth.ts since 2026-10-09, so the heartbeat can read the same household
 *  list; re-exported here because every write tool has always asked kit.ts for it. */
export { DISPLAY } from "../_shared/muse/auth.ts";

export interface Ctx {
  db: Db;
  push: Push;
  /** Taken from the secret that was presented. NEVER from the request body. */
  person: Person;
  /** The true instant, built once at the top of the request. */
  at: Date;
  /** The same instant as Arizona's calendar and clock. Built once, passed down. */
  az: Date;
  appUrl: string;
}

export type Refusal = { ok: false; status: number; say: string };
export type Success = {
  ok: true;
  result: Record<string, unknown>;
  rowIds: string[];
  say: string;
  /**
   * How to put this change back, captured BEFORE the change landed.
   *
   * This is the whole safety net phase 2 trades for letting an assistant change
   * anything. His reasoning, and it is sound: Homebase never moves money — it
   * records, categorises and computes — so the worst a wrong write does is make
   * data wrong, and wrong data can be undone as long as the before-state was
   * written down first.
   *
   * Optional on purpose. A tool that cannot honestly capture its before-state must
   * leave this off rather than return a record that would not restore anything,
   * and the handler then tells the caller plainly that this one cannot be undone.
   */
  undo?: UndoRecord;
  /**
   * The change is ALREADY in muse_undo, under this token — the tool wrote its own row.
   *
   * The finance tools do it that way round on purpose (commit() in toolsFinance.ts
   * writes the row BEFORE it changes anything, so a crash leaves `pending` rather than a
   * change nobody can account for). That means there is nothing for handler.ts to mint
   * or store; what it owes is to say the token out loud in the envelope.
   *
   * It did not, until 2026-10-09. The handler only looked at `undo` above, so every
   * finance write came back with a real token in `result.undo` and, right beside it,
   * `undo: null` and "Nothing was written down that could put this back." An assistant
   * reading the envelope was told the one thing that was not true. A tool sets one of
   * these two fields, never both.
   */
  recorded?: { token: string; says: string };
};
export type ToolOutcome = Refusal | Success;

export interface Tool {
  /**
   * "direct" lands straight away. "queued" writes a row into muse_pending and
   * nothing else, and waits for a tap in the app.
   *
   * PHASE 2 MOVED THE HEALTH SIDE OFF "queued", and the reason is measured rather
   * than preferred: nothing in src/ reads muse_pending — `grep -rn "muse_pending"
   * src/` finds nothing — so a queued row sits until cron-reminders marks it
   * expired 24 hours later. The tap it was waiting for does not exist. Direct
   * with an undo token is the version that actually does something, and the
   * before-state is what makes it safe.
   */
  kind: "direct" | "queued";
  /** One line, for the OpenAPI description and for the "no such tool" reply. */
  does: string;
  /** Every field this tool accepts. Anything else is refused by name — a typo
   *  that silently did nothing would be worse than a refusal. */
  fields: string[];
  /**
   * ONE MINIMAL CALL THAT WORKS, written next to the tool so it cannot drift from it.
   *
   * FOUND 2026-10-10. The door's description only ever printed the top-level field
   * names — "health.log_workout: … Fields: date, name, notes, exercises." — and never
   * what goes INSIDE `exercises`. So the assistant guessed, more than once and from more
   * than one phone, and "Each exercise needs a name." was refused the same way every
   * time. An example shows the inside of every list in one line.
   *
   * It is printed into the served description by catalogue.ts (toolLines), returned
   * with every shape refusal, and tests/museShapes.test.ts runs every one of them
   * through its own tool and fails if any comes back refused for its shape. catalogueOf
   * refuses to start a door whose example names a field the tool does not take.
   *
   * Every value in one is made up, and that is the whole of what keeps one harmless —
   * NOT the placeholder id. An example that carries an id (EXAMPLE_ID) finds no row and
   * is refused with a 404. Most carry none, and those sent exactly as they stand would
   * be real writes: a weigh-in of the example's weight, the example's reminder, the
   * example's macro target replacing the real one (FOUND IN REVIEW 2026-10-10 — a probe
   * found fifteen examples that answered 200). So handler.ts refuses any call that IS
   * its tool's example, before anything is counted, and every reply that hands an
   * example back says it is not to be sent as it stands. A name an example looks a row
   * up by — a saved meal, a memory key, a merchant — is chosen not to match one, and
   * was checked against the live tables when it was written.
   */
  example: Record<string, unknown>;
  /**
   * WHERE THE LISTS ARE in a call to this tool, and what each item takes — so handler.ts
   * can put the read door's words under the door's own at every level before it takes
   * the call's fingerprint (canonicalArgs in shapes.ts). The same ListShape the tool's
   * own parser reads its items with, never a second copy. Absent on a tool with no list.
   */
  lists?: Readonly<Record<string, ListShape>>;
  /**
   * The checks that need no database: field types, ranges, the inside of every list,
   * and anything that can be decided from the payload and the Arizona calendar alone.
   * Returns EVERY problem, not the first — an empty list means none.
   *
   * handler.ts runs this BEFORE the hourly write counter is bumped, so a malformed
   * call costs nothing from the 60-an-hour budget, and `run` calls the same parser
   * again so a tool driven directly (as the test suites do) refuses the same way.
   *
   * EVERY TOOL THAT TAKES A FIELD HAS ONE, since review on 2026-10-10. The first version
   * gave one only to the tools with a list, on the reasoning that a flat tool gained
   * nothing — and it did: health.log_weight with `weight: "abc"` still spent a slot of
   * the hour, and finance.add_transaction with a bad amount AND a bad category took two
   * round trips to hear both. tests/museShapes.test.ts fails a tool with fields and no
   * check, and drives every tool with malformed values against a database that throws
   * on first touch: any 400 a tool gives before it reads anything must be one its check
   * finds too. Optional in the type only for the tool that takes nothing.
   */
  check?(payload: Record<string, unknown>, ctx: ShapeCtx): string[];
  run(payload: Record<string, unknown>, ctx: Ctx): Promise<ToolOutcome>;
}

/** What a shape check is allowed to know: the Arizona calendar, for "how far back
 *  may this be dated", and the same instant as a moment, for "is this reminder at
 *  least a minute out". Both are the request's clock, built once by the handler and
 *  passed in — never read here. Not the database, not the person: that is what keeps
 *  a check free enough to run before anything is counted. */
export type ShapeCtx = Pick<Ctx, "az" | "at">;

// ── small shared checks ──────────────────────────────────────────────────────

export const refuse = (status: number, say: string): Refusal => ({ ok: false, status, say });

// Re-exported, not redefined. The finance half needed the same regex in
// toolsFinance.ts, which tools.ts imports as a value, so it went to _shared/muse/args.ts
// to stay clear of a runtime cycle. One copy, reachable from both doors.
export { UUID } from "../_shared/muse/args.ts";

// A category id is a stable slug in the app's own list.
export const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * The id every example call uses where a real id goes.
 *
 * In the right SHAPE — a uuid passes every id check on both doors — so the example
 * shows exactly what an id looks like and gets through the shape checks it is tested
 * against. And all zeros, so nobody mistakes it for a real row: sent as it stands it
 * finds nothing and is refused with a 404, instead of changing a charge or a session
 * that happened to be first in a table. Never a real id copied out of the database —
 * the repo is public.
 */
export const EXAMPLE_ID = "00000000-0000-4000-8000-000000000000";

/**
 * An id the read door handed out, echoed back.
 *
 * Deliberately NOT a uuid check, and the same reasoning as the read door's idArg:
 * `workouts.id` is a uuid, but a meal id written by an older app version comes
 * from mealLog's own rowId() ("m9k2x-1f"), and a routine id may be one of the code
 * seeds ("seed-gino-upper-a"). A uuid regex would refuse rows that exist.
 */
export const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number, and not a numeric string — a string that looks like a number
 *  is a sign the caller guessed at the shape. */
export function money(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

export const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * The date this write is for. Defaults to Arizona's today — never the runtime's,
 * which from 5 PM onward is already tomorrow.
 *
 * `backDays` is how far back the tool is willing to look. It is small on purpose:
 * a weigh-in from three months ago is a typo far more often than a memory, and a
 * wrong date is invisible in a chat.
 */
export function dateFor(
  payload: Record<string, unknown>,
  ctx: ShapeCtx,
  backDays: number,
): { date: string } | Refusal {
  const today = azDateISO(ctx.az);
  if (payload.date === undefined) return { date: today };
  if (!isDateISO(payload.date)) {
    return refuse(400, "I need the date as YYYY-MM-DD, or leave it out and I will use today.");
  }
  const delta = daysBetweenISO(payload.date, today);
  if (delta < 0) return refuse(400, `${payload.date} has not happened yet in Arizona. Today is ${today}.`);
  if (delta > backDays) {
    return refuse(
      400,
      `${payload.date} is more than ${backDays} days back. Add that one in the app so you can see what is already there.`,
    );
  }
  return { date: payload.date };
}

// ── every problem, not the first ─────────────────────────────────────────────

/**
 * The answer of a shape check: the parsed value, or EVERY problem with it.
 *
 * FOUND 2026-10-10. The parsers on this door used to return the first refusal they
 * met, so a call with three things wrong took three round trips to fix — and a
 * back-fill of several workouts at once paid that three times over for each of them.
 * A parser now keeps going past a problem, collects all of them, and hands the whole
 * list back; the tool's `check` (run by handler.ts before anything is counted) and its
 * `run` both call the same parser, so the two cannot disagree.
 *
 * Here and not in healthTools.ts since review on 2026-10-10, when every flat tool in
 * all four catalogues got a check of its own and all four needed the same three lines.
 */
export type Shaped<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export const shaped = <T>(problems: string[], value: () => T): Shaped<T> =>
  problems.length ? { ok: false, problems } : { ok: true, value: value() };

/** The problems out of a shape answer, for a tool's `check`. */
export const problemsOf = <T>(s: Shaped<T>): string[] => (s.ok ? [] : s.problems);

/** The refusal a tool's own `run` gives for a shape answer that failed. Reached only
 *  when a tool is driven without the handler in front of it — the handler runs the
 *  same check first and answers with the example attached. */
export const shapeRefused = (problems: string[], payload: Record<string, unknown>): Refusal =>
  refuse(400, shapeSays(problems, keysOf(payload)));

/**
 * A pad to write a flat tool's problems on, one field at a time.
 *
 * The small checks every catalogue already had — idArg, categoryArg, dateFor, readId —
 * each answer with a value or a Refusal. `take` keeps the value, or notes the refusal's
 * sentence and carries on to the next field instead of returning; `no` notes a problem
 * that is not one of those; `done` hands back EVERY problem, or builds the parsed value
 * once there are none. A plain closure rather than a class, like the rest of this door.
 *
 *   const pad = problemPad();
 *   const id = pad.take(idArg(payload.transaction_id, "the charge"));
 *   const category = pad.take(categoryArg(payload.category_id));
 *   return pad.done(() => ({ id: id!, category: category! }));
 *
 * The `!` is honest: done() only calls the builder when nothing was noted, which means
 * every take returned its value.
 */
export function problemPad() {
  const said: string[] = [];
  return {
    take<T>(answer: T | Refusal): T | undefined {
      if (typeof answer === "object" && answer !== null && (answer as { ok?: unknown }).ok === false) {
        said.push((answer as Refusal).say);
        return undefined;
      }
      return answer as T;
    },
    no(say: string): void {
      said.push(say);
    },
    /** Problems a nested parser already collected — a list's, say. */
    all(more: readonly string[]): void {
      said.push(...more);
    },
    done<T>(value: () => T): Shaped<T> {
      return shaped(said, value);
    },
  };
}
