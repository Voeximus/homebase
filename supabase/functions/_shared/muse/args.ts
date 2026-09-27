// One spelling of "is this argument the shape the tool asked for", for every tool
// on the read door.
//
// These four functions used to be module-private at the top of tools.ts, which was
// right while there was one tool file. Phase 2 adds a second (toolsFinance.ts), and
// the alternative to a shared file is a second copy of a date validator — which is
// the drift this whole bridge exists to stop, in miniature: two validators that
// agree today and disagree the first time one of them is fixed.
//
// They live in their own file rather than being exported from tools.ts so that the
// catalogue can import the tool lists WITHOUT the tool lists importing back for a
// validator. A reader should not have to reason about import order to know the
// door starts.
//
// NO CLOCK IN HERE (Rule 2). dateArg checks that a date is real by ARITHMETIC, not
// by building a Date — building one would trip the door's own no-clocks guard for
// no reason, and the guard is a grep.

/** A caller sent something the tool cannot answer. A 400, not a 500. */
export class BadArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadArgs";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The last day of "YYYY-MM", as "YYYY-MM-DD".
 *
 * Arithmetic on the month number, not a Date — building one here would trip the door's
 * own no-clocks guard. It lives beside DAYS_IN_MONTH rather than in tools.ts, where it
 * started: phase 2 moved the arg helpers into this file and left this one behind, so
 * the leap-year table was briefly in both places. Two copies of a leap-year rule is
 * the kind of drift that is correct for three years and then is not.
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
  // A well-shaped string that is not a real day ("2026-02-31") would compare as a
  // string against real dates and quietly include or exclude a day.
  const [y, m, d] = v.split("-").map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1];
  if (m < 1 || m > 12 || d < 1 || !last || d > last) throw new BadArgs(`${v} is not a real date.`);
  return v;
}

/** The same date, optional. Returns null when the key is absent — never a default
 *  built from a clock, which is the one thing this door may not do. */
export function optionalDateArg(args: Record<string, unknown>, name: string): string | null {
  return args[name] == null ? null : dateArg(args, name);
}

/** A month, "YYYY-MM". Optional, for the same reason. */
export function optionalMonthArg(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  if (v == null) return null;
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) {
    throw new BadArgs(`${name} has to be a month like 2026-09.`);
  }
  return v;
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
  if (typeof v !== "boolean") throw new BadArgs(`${name} is either true or false.`);
  return v;
}
