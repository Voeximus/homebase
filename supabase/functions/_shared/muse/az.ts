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
