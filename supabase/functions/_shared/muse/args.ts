// What a read tool IS, and the argument checks every tool shares.
//
// WHY THIS IS NOT IN tools.ts ANY MORE. Phase 1 had eleven read tools, one catalogue
// file, and the types and the checks lived in it. Phase 2's job is parity — a tool for
// every remaining thing the app can do — so the catalogue is now split by domain
// (finance in tools.ts and toolsFinance.ts, health and workouts in healthRead.ts).
// Two files that both need the same `dateArg` would either import it from each other,
// which is a cycle, or carry a copy each, which is the drift this bridge exists to
// stop: scripts/check-categorizer-sync.mjs fails the build over exactly that, and it
// already caught the two doors growing two clocks.
//
// THIS FILE WAS WRITTEN THREE TIMES, in three branches, in one week — twice at this
// exact path and once as `reply.ts`. Every author hit the same wall in the same order:
// split the catalogue, need the shared checks, find the cycle. That is not three
// mistakes; it is one missing file that three people noticed. What landed is the union
// of the three, with one spelling per idea:
//
//   · the read door's shape (Json, ToolContext, Tool) and BadArgs;
//   · one leap-year table, one date regex, one month regex, one uuid regex;
//   · both families of optional readers, because they mean different things — see the
//     note above optionalDateArg.
//
// Nothing in here reads the database, the clock, or a person.

import type { Loader } from "./load.ts";
import type { CatalogueArg } from "./catalogue.ts";

/** Anything a reply may be made of. No functions, no undefined: a reply is JSON. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ToolContext {
  /** Forced from the secret. Never read from the request body — see the ARGS note
   *  in tools.ts. */
  person: "gino" | "xinyan";
  /** The Arizona "now", built once per request. The door's only clock reading. */
  now: Date;
  load: Loader;
  args: Record<string, unknown>;
}

export interface Tool {
  name: string;
  /** One plain sentence, used in the catalogue and in the OpenAPI description. */
  summary: string;
  /**
   * The arguments, for the OpenAPI description and for the handler's own refusal of a
   * key that is not on the list. `person` is never one of them.
   *
   * The shape is CatalogueArg, in catalogue.ts, because openapi.ts builds the served
   * schema off the catalogue rather than off this array — one definition of "an
   * argument" for the door, its description, and the test that compares them. The
   * declared `type` is the point: openapi.ts used to read
   * `name === "days" ? "integer" : "string"`, which was right about the one integer
   * that existed and would have described the next one as a string. An assistant told
   * "string" sends "3", intArg refuses it, and the refusal reads like the assistant's
   * mistake.
   */
  args?: CatalogueArg[];
  run(ctx: ToolContext): Promise<{ [k: string]: Json }>;
}

/** A caller sent something the tool cannot answer. A 400, not a 500. */
export class BadArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadArgs";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Anchored on the real months. One branch's copy was /^\d{4}-\d{2}$/, which accepts
// "2026-00" and "2026-13" — a month key that matches nothing, so the tool answers about
// an empty month instead of refusing, and the reply is a confident zero.
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A row id, as Postgres spells one.
 *
 * It lives here, in _shared, rather than in either door's tool file, and the reason is
 * an import cycle that phase 2 walked into twice. The write door's phase-1 tools and
 * its phase-2 finance tools both need it; tools.ts already imports the finance registry
 * as a VALUE, so a value imported back the other way is a genuine cycle, and its
 * failure mode is an uninitialised binding at load time rather than a compile error —
 * the door would deploy and then 500 on the first call. A shared module both sides
 * import has no such edge.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a real calendar day? Checked arithmetically rather than by building a Date,
 *  because building one here would trip the door's own no-clocks guard for no reason —
 *  and because "2026-02-31" is a well-shaped string that would compare against real
 *  dates and quietly include or exclude a day. */
export function isRealDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1];
  return d <= last;
}

/**
 * The last day of "YYYY-MM", as "YYYY-MM-DD".
 *
 * Arithmetic on the month number, not a Date — building one here would trip the door's
 * own no-clocks guard. It lives beside DAYS_IN_MONTH rather than in tools.ts, where it
 * started: phase 2 moved the arg helpers into this file and left this one behind, so
 * the leap-year table was briefly in both places. Two copies of a leap-year rule is the
 * kind of drift that is correct for three years and then is not.
 */
export function lastDayOf(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1];
  return `${monthKey}-${String(last).padStart(2, "0")}`;
}

export function dateArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !DATE.test(v)) {
    throw new BadArgs(`${name} has to be a date like 2026-09-01.`);
  }
  if (!isRealDate(v)) throw new BadArgs(`${v} is not a real date.`);
  return v;
}

/**
 * THE TWO OPTIONAL FAMILIES, and why both survive.
 *
 * `optionalDateArg` returns NULL when the key is absent. `optDateArg` returns a
 * FALLBACK the caller supplies. They are not two names for one thing:
 *
 *   · null is "the caller did not filter on this" — a search with no `from` searches
 *     every date, and a null that became a default would silently narrow it;
 *   · a fallback is "the caller meant today", which only the caller can say, because
 *     the only permitted `now` is the one the handler built for the request. A default
 *     computed in here would be a second clock, which is the failure the door's own
 *     build guard exists to catch.
 *
 * Collapsing them would force one of those two meanings to be spelled at every call
 * site instead, which is where it would eventually be spelled wrong.
 */
export function optionalDateArg(args: Record<string, unknown>, name: string): string | null {
  return args[name] == null ? null : dateArg(args, name);
}

/** A date argument that may be left out. The caller supplies the fallback, which is
 *  always derived from the request's one `now` — never from a clock in here. */
export function optDateArg(args: Record<string, unknown>, name: string, fallback: string): string {
  return args[name] === undefined ? fallback : dateArg(args, name);
}

export function monthArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !MONTH.test(v)) {
    throw new BadArgs(`${name} has to be a month like 2026-09.`);
  }
  return v;
}

/** A month, "YYYY-MM". Optional, returning null for the same reason as the date. */
export function optionalMonthArg(args: Record<string, unknown>, name: string): string | null {
  return args[name] == null ? null : monthArg(args, name);
}

export function intArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = args[name];
  if (v == null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BadArgs(`${name} has to be a whole number between ${min} and ${max}.`);
  }
  return v;
}

export function textArg(args: Record<string, unknown>, name: string, max = 64): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) throw new BadArgs(`${name} is missing.`);
  if (v.length > max) throw new BadArgs(`${name} is too long.`);
  return v.trim();
}

/** Text that may be left out. Returns null rather than "", so a caller cannot
 *  accidentally treat "no filter" as "matches the empty string". */
export function optionalTextArg(args: Record<string, unknown>, name: string, max = 64): string | null {
  return args[name] == null ? null : textArg(args, name, max);
}

/** Optional free text where "" is the useful absence — a note being cleared rather
 *  than a filter being skipped. Kept beside optionalTextArg for the same reason the two
 *  date readers are both here: the two absences are different instructions. */
export function optTextArg(args: Record<string, unknown>, name: string, max = 64): string {
  return args[name] === undefined ? "" : textArg(args, name, max);
}

/**
 * A dollar figure in an argument. Optional.
 *
 * NOT a numeric string. A caller that sends "12.50" has guessed at the shape, and
 * guessing is worth a refusal rather than a coercion: a string that parses today
 * ("12.50") and one that does not ("$12.50") would behave differently, and neither
 * failure would be visible in a chat.
 */
export function optionalMoneyArg(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) {
    throw new BadArgs(`${name} has to be a number of dollars, zero or more.`);
  }
  return v;
}

/** A true/false filter. Optional, and three-valued on purpose: absent means "do not
 *  filter on this", which is a different instruction from false. */
export function optionalBoolArg(args: Record<string, unknown>, name: string): boolean | null {
  const v = args[name];
  if (v == null) return null;
  if (typeof v !== "boolean") throw new BadArgs(`${name} has to be true or false.`);
  return v;
}

/**
 * An id the read door handed out, echoed back.
 *
 * Deliberately NOT a uuid check, and that is the difference between this and UUID
 * above. `workouts.id` and `meal_days.meals[].id` are uuids in the database, but a meal
 * id created by an older app version comes from mealLog's own rowId() ("m9k2x-1f"), and
 * a routine id may be one of the code seeds ("seed-gino-upper-a"). A uuid regex here
 * would refuse rows that exist. So: the characters an id is made of, and a length, and
 * nothing else. Use UUID where the column really is one and nothing older can be in it.
 */
export function idArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) {
    throw new BadArgs(`${name} has to be an id as the read door gave it to you.`);
  }
  return v;
}
