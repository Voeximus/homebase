// When a reminder should fire, and what happens to a repeating one afterwards.
//
// Pure, and separate from index.ts, because the bug this file exists to avoid is
// one this repo has already paid for: cron-notify carried its own hand-written
// copy of the bill cadence maths, drifted from the app, and told the phones that a
// semiannual insurance bill and a yearly membership were due on their day of
// EVERY month. Cadence logic that nothing tests is how that happens.

// One spelling of the three cadences, in _shared/muse/reminders.ts, where the read
// door's list and the write door's edit tool read it too. It used to be declared
// here and again inside muse-write/tools.ts as a bare string comparison, which is the
// same two-copies shape that let the write door accept a secret the read door
// refused. The database's own check constraint is the third copy and the only one
// that cannot import this.
export type { Repeats } from "../_shared/muse/reminders.ts";
import type { Repeats } from "../_shared/muse/reminders.ts";

/**
 * How late a reminder may be and still be worth delivering.
 *
 * The job runs every 15 minutes, so ordinary lateness is minutes. Twelve hours
 * late means something was down — and an outage should not empty a night's worth
 * of reminders onto his lock screen at six in the morning, one buzz after
 * another, for things that already happened.
 */
export const STALE_HOURS = 12;

/** Whole days added to an instant. Written as 24-hour steps, which is exact here
 *  and would not be anywhere else: Arizona does not observe daylight saving, so
 *  the same wall-clock time comes round every day of the year. A daily reminder
 *  set for 9 PM stays at 9 PM. */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

/** The next time a repeating reminder is due after `now`. Steps forward rather
 *  than dividing, so a reminder that was missed for a week comes back at its own
 *  time of day instead of at the time the outage ended. */
export function nextDue(dueAt: Date, repeats: Repeats, now: Date): Date | null {
  if (repeats === "once") return null;
  const step = repeats === "weekly" ? 7 : 1;
  let next = addDays(dueAt, step);
  // A year of daily steps is 365 turns. The cap is only here so a nonsense date
  // cannot spin: past it we give up and let the row be closed rather than loop.
  for (let i = 0; i < 1000 && next.getTime() <= now.getTime(); i++) {
    next = addDays(next, step);
  }
  return next.getTime() > now.getTime() ? next : null;
}

export interface Plan {
  /** Send the push, or let this one go by. */
  send: boolean;
  /** Why it was skipped, for the log. */
  why?: string;
  /** Where a repeating reminder goes next, or null when it is finished. */
  nextDueAt: Date | null;
}

/**
 * What to do with one reminder that is due.
 *
 * A repeating reminder is never "finished" by being late — it moves on to its
 * next slot either way, which is the difference between missing one buzz and
 * losing a daily reminder entirely.
 */
export function planFor(dueAt: Date, repeats: Repeats, now: Date): Plan {
  const lateMs = now.getTime() - dueAt.getTime();
  const next = nextDue(dueAt, repeats, now);
  if (lateMs > STALE_HOURS * 3_600_000) {
    return { send: false, why: `${Math.round(lateMs / 3_600_000)}h late`, nextDueAt: next };
  }
  return { send: true, nextDueAt: next };
}
