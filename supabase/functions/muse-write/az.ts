// The ONLY place in the write door that reads a clock or builds a Date.
//
// WHY THAT RULE EXISTS
//   An edge function runs in UTC. The household is in Arizona (UTC-7, and
//   Arizona never moves for daylight saving). Every date the app stores is a
//   LOCAL calendar date — src/lib/format.ts spells out why: from 5 PM Arizona
//   onward, UTC has already rolled over, so a UTC stamp files an evening entry
//   under TOMORROW. He works nights, so most of his waking day sits inside that
//   broken window.
//
//   So: build the Arizona "now" ONCE at the top of the request and pass it down.
//   Nothing else in this folder may call new Date(), Date.now() or todayISO() —
//   a forgotten argument silently answers about the wrong day, and a wrong day
//   in a chat has no screen beside it showing the right one.
//
// NOTE FOR THE MERGE
//   The read door introduces the same function at
//   supabase/functions/_shared/muse/az.ts (see PLAN.md §2, Rule 2). `nowAZ`
//   below is a character-for-character copy of the one in that plan. When the
//   shared file lands, DELETE this copy and import from there — two spellings of
//   a clock is the drift this whole plan exists to prevent. tests/museWrite.test.ts
//   fails the moment both files exist and disagree.

/** The Arizona "now", as a Date whose LOCAL fields are Arizona's — which is
 *  what every copied module reads (getFullYear/getMonth/getDate). */
export function nowAZ(at: Date = new Date()): Date {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at);
  const g = (t: string) => Number(f.find((p) => p.type === t)!.value);
  return new Date(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
}

/**
 * The one clock reading in the whole door. Called ONCE at the top of a request,
 * and both halves are then passed down explicitly:
 *   at — the true instant, for anything stored as a timestamp
 *   az — the same instant with Arizona's calendar and clock, for anything stored
 *        as a calendar date
 * Every test hands it an explicit `at`, which is what makes "same answer in UTC
 * and in Arizona" a thing a test can actually demand.
 */
export function clockNow(at: Date = new Date()): { at: Date; az: Date } {
  return { at, az: nowAZ(at) };
}

/** A counter for "how long did that take", which is the `ms` column in the audit
 *  log. It lives here so that "az.ts is the only file in the door that reads a
 *  clock" stays literally true and a test can check it with a search. It never
 *  touches a calendar, so it cannot be the cause of a wrong day. */
export function ticks(): number {
  return Date.now();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An Arizona Date as its calendar date, "YYYY-MM-DD". Same spelling as
 *  src/lib/format.ts isoDate — getFullYear/getMonth/getDate, never
 *  toISOString(), which is the silently-UTC fifth spelling that caused the
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
    timeZone: "America/Phoenix",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(at);
}

/** Add whole days to an instant. Safe to write as 24-hour steps ONLY because
 *  Arizona has no daylight saving — the wall-clock time of day is preserved for
 *  every date of the year, which is exactly what a daily reminder means. */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}
