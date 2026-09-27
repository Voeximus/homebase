// The Arizona clock. THE ONLY PLACE IN EITHER DOOR THAT READS A CLOCK.
//
// WHY THIS FILE EXISTS
//
// The app's shared maths modules read the machine's own calendar date when you do
// not hand them one. There are eight such defaults (forecast.ts, ledgerReview.ts,
// plan.ts ×3, recurring.ts ×2, selfAudit.ts), and `todayISO()` returns the LOCAL
// date on purpose: the household is in Arizona, UTC-7 with no daylight saving, and
// format.ts records why in its own comment — from 5 PM local onward UTC has
// already rolled over, so an evening purchase was being stamped with TOMORROW's
// date and filed into the wrong month and the wrong pay cycle.
//
// A Supabase edge function runs in UTC. So from 5 PM Arizona onward, a door that
// let one of those defaults fire would answer about TOMORROW — a different pay
// cycle, different bills due, a different low day — and on the last evening of a
// month, about the next month. He works nights, roughly 6 PM to 6 AM, so that is
// not an edge case for him; it is most of his waking day.
//
// cron-notify already had to patch this by hand with
// `new Date(Date.now() - 7 * 3600 * 1000)`. That trick is correct only while the
// runtime happens to be UTC, and silently wrong the day it is not. This builds the
// date from the IANA zone instead, so it is right whatever the machine thinks.
//
// THE RULE THE REST OF THE DOOR FOLLOWS: build this ONCE at the top of the
// request and pass it explicitly into every entry point. Never let a default
// fire. scripts/check-categorizer-sync.mjs greps the door's own files for
// `new Date(`, `Date.now(` and `todayISO(` and fails the build if it finds one
// outside this file — and tests/museRead.test.ts runs every tool under UTC and
// under Arizona and demands identical output, which is what catches a forgotten
// argument that the grep cannot see.

export const HOUSEHOLD_ZONE = "America/Phoenix";

/**
 * The Arizona "now", as a Date whose LOCAL fields are Arizona's — which is what
 * every copied module reads (getFullYear / getMonth / getDate / getHours).
 *
 * `at` is the instant to convert, and it defaults to the real clock. That default
 * is the one clock reading the door is allowed, and it lives here so a test can
 * hand in a fixed instant instead.
 */
export function nowAZ(at: Date = new Date()): Date {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: HOUSEHOLD_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string) => Number(f.find((p) => p.type === t)!.value);
  // `hour` can come back as 24 for midnight under hour12:false — % 24 folds it to
  // 0 rather than rolling the date forward a day.
  return new Date(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
}

// ─────────────────────────────────────────────────────────────────────────────
// The rest of the date handling BOTH doors need.
//
// This section came out of supabase/functions/muse-write/az.ts, which was written
// as a stand-in while the two doors were built side by side. It is here, in the one
// file the clock rule exempts, because two spellings of a clock is exactly the
// drift this plan exists to stop — and because the write door's own test fired the
// moment both copies existed and disagreed. There is one copy now. A door that
// grows a private az.ts fails the build (scripts/check-categorizer-sync.mjs).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one clock reading in a whole request. Called ONCE at the top, and both
 * halves are then passed down explicitly:
 *   at — the true instant, for anything stored as a timestamp
 *   az — the same instant with Arizona's calendar and clock, for anything stored
 *        as a calendar date
 * Every test hands it an explicit `at`, which is what makes "same answer in UTC
 * and in Arizona" a thing a test can demand.
 */
export function clockNow(at: Date = new Date()): { at: Date; az: Date } {
  return { at, az: nowAZ(at) };
}

/** A counter for "how long did that take", which is the `ms` column in the audit
 *  log. It lives here so that "az.ts is the only file that reads a clock" stays
 *  literally true and a search can check it. It never touches a calendar, so it
 *  cannot be the cause of a wrong day. */
export function ticks(): number {
  return Date.now();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An Arizona Date as its calendar date, "YYYY-MM-DD". Same spelling as
 *  src/lib/format.ts isoDate — getFullYear/getMonth/getDate, never
 *  toISOString(), which is the silently-UTC spelling that caused the
 *  evening-entry bug. */
export function azDateISO(az: Date): string {
  return `${az.getFullYear()}-${pad2(az.getMonth() + 1)}-${pad2(az.getDate())}`;
}

/** Is this a real "YYYY-MM-DD"? Rejects 2026-02-31 as well as nonsense. */
export function isDateISO(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Days between two "YYYY-MM-DD" dates, b − a. Both are treated as plain
 *  calendar dates, so no timezone gets a vote. */
export function daysBetweenISO(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * A moment the caller named, as a real instant.
 *
 * Two spellings are accepted and NOTHING else:
 *   "2026-09-26T23:45:00Z" / "…-07:00"  — an instant, offset included
 *   "2026-09-26T23:45"                  — Arizona wall-clock time
 *
 * The second one is the useful one: an assistant speaking to a person in Arizona
 * says "quarter to midnight", not "06:45 UTC". It is turned into an instant by
 * pinning UTC-7, which is exact for all time because Arizona does not observe
 * daylight saving. No other zone would be safe to do this to.
 *
 * A bare date with no time is refused rather than assumed to mean midnight — a
 * reminder that silently means 00:00 is a reminder that arrives at the wrong end
 * of the day.
 */
export function parseInstant(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  const wall = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(t);
  if (wall) {
    if (!isDateISO(wall[1])) return null;
    const hh = Number(wall[2]);
    const mm = Number(wall[3]);
    if (hh > 23 || mm > 59) return null;
    const at = new Date(`${wall[1]}T${wall[2]}:${wall[3]}:00-07:00`);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(t)) return null;
  const at = new Date(t);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** An instant as Arizona wall-clock words, for a sentence a person reads:
 *  "Sep 26, 11:00 PM". Formatting a moment somebody handed us is not reading a
 *  clock — no default argument, nothing implicit. */
export function azWallClock(at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: HOUSEHOLD_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/** Add whole days to an instant. Safe to write as 24-hour steps ONLY because
 *  Arizona has no daylight saving — the wall-clock time of day is preserved for
 *  every date of the year, which is exactly what a daily reminder means. */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a timestamp somebody else wrote.
//
// Everything above turns "now" into an Arizona calendar. These four turn a STORED
// timestamp — `reminders.due_at`, `reminders.sent_at`, `muse_audit.at` — into
// something a tool can compare against or say out loud.
//
// THEY LIVE HERE FOR THE SAME REASON THE CLOCK DOES. A door that wrote
// `new Date(row.due_at)` would fail the build (scripts/check-categorizer-sync.mjs
// greps every door file for `new Date(`), and rightly: the grep cannot tell a
// harmless parse from a fired default, so the rule is that no door file spells it
// at all. Parsing is instant handling, instant handling is this file's job, and a
// door that needs a stored time asks for it by name.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stored timestamp as the instant it names, or null.
 *
 * Refuses anything without a zone on the end. Postgres hands a `timestamptz` back
 * with one ("2026-09-27T06:00:00+00:00"), and a value that arrived without one is
 * a value whose zone we would have to guess — which for a reminder means guessing
 * seven hours, which means guessing the wrong end of a night shift. Both
 * separators are accepted because PostgREST spells it with a T and psql with a
 * space, and a reader should not have to know which one wrote the row.
 */
export function instantOf(stored: unknown): Date | null {
  if (typeof stored !== "string") return null;
  const t = stored.trim().replace(" ", "T");
  // The offset may be "+00", "+00:00" or "Z" — all three come out of Postgres
  // depending on who is asking.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(t)) return null;
  const at = new Date(t);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The same conversion nowAZ() does, named for what it is when the instant is not
 * "now": an instant re-expressed as Arizona's calendar and clock.
 *
 * WHY A TOOL NEEDS THIS AND CANNOT JUST SUBTRACT. `nowAZ()` returns a Date whose
 * LOCAL fields are Arizona's, so its epoch value is NOT the instant it describes
 * unless the machine happens to be in Arizona. Comparing that against a real
 * instant is wrong by the runtime's own offset — seven hours, on the machine these
 * doors actually run on. So "is this reminder overdue" is answered by putting BOTH
 * sides through here and comparing two Arizona calendars.
 */
export function azFields(at: Date): Date {
  return nowAZ(at);
}

/** An instant, moved back by whole minutes. The duplicate guard's window. */
export function minusMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() - minutes * 60_000);
}

/**
 * Whole minutes from a stored timestamp up to `at`, or null when the timestamp
 * cannot be read. Negative when the stored time is in the future.
 *
 * Floor, not round: "already done 2 minutes ago" must never become "3 minutes ago"
 * on a sentence a person is reading back to themselves.
 */
export function minutesSince(stored: unknown, at: Date): number | null {
  const then = instantOf(stored);
  if (!then) return null;
  return Math.floor((at.getTime() - then.getTime()) / 60_000);
}
