// Is everything that should be running, running?
//
// THIS IS NOT THE SELF-AUDIT AND THE DIFFERENCE IS THE WHOLE POINT. selfAudit.ts
// holds checks that are precisely zero in a healthy ledger — do the bills add up the
// same way on every screen, does every link point at something real. Those are
// questions about the NUMBERS. Every one of them keeps passing while the feed that
// supplies the numbers is dead, because a ledger that stopped receiving charges is
// internally consistent. It is consistent about last week.
//
// So this asks the other question: is anything still arriving, and did the unattended
// work actually happen. It is the check that would have caught the original failure —
// months with no scheduled bank pull, the app's screens the only trigger, every figure
// confidently wrong and every self-check green.
//
// WHY THE THRESHOLDS ARE THE NUMBERS THEY ARE. Each one is measured against this
// household's real history, not chosen because it sounded careful. A heartbeat that
// fires on things that are fine is worse than none, because it gets ignored, and then
// it is exactly as useful as no heartbeat while looking like a working one.
//
// PURE ON PURPOSE. It takes readings and returns verdicts; it opens nothing and reads
// no clock. That is Rule 2 (one `nowAZ()` passed in, never read here) and it is also
// what makes every threshold below testable without a network — the lesson from
// expectParts.ts, where the only code that spoke to Postgres was the code no test
// could import.

import { BANK_STALE_MIN } from "./freshness.ts";

/** How long a job may go without finishing before it counts as stopped.
 *
 *  THREE TIMES ITS OWN INTERVAL, not a flat number. A flat "an hour" is wrong in
 *  both directions at once: far too slow for a job that should run every 15 minutes,
 *  and a false alarm every single day for one that runs at 3 AM. Three ticks means
 *  one missed run is quiet and two is not — a single skipped tick is ordinary
 *  scheduler noise and waking somebody for it is how an alarm gets muted for good. */
export const MISSED_TICKS = 3;

/** Consecutive days with no new charge before it is worth saying something.
 *
 *  MEASURED, NOT GUESSED. Over three months of real bank feed the longest quiet
 *  stretch is 3 days, and it happened twice. So 3 is normal and 4 is not. (There is
 *  also a 20-day gap in May–June that is not a gap at all: Plaid was connected on
 *  2026-06-19 and there was simply no feed before it. A threshold set from that
 *  number would never fire.) */
export const QUIET_DAYS_MAX = 3;

/** How long a due reminder may sit unsent before the pipeline is the suspect.
 *
 *  The job runs every 15 minutes and claims delivery within about that, so 30 is two
 *  ticks — the same "one miss is quiet, two is not" rule as above. */
export const REMINDER_STUCK_MIN = 30;

/**
 * The unattended jobs, and the schedule each runs on, in minutes.
 *
 * ONE COPY. This lived twice until 2026-10-05 — once in cron-heartbeat and once in
 * system.heartbeat — word for word, each with its own comment explaining itself. A
 * job added to one and not the other is a job the push watches and Muse cannot see,
 * or the reverse, and both read as "the heartbeat is fine". It surfaced when
 * cron-audit was added and had to be written into both by hand.
 *
 * It stays hand-written rather than read from cron.job, for the reason system.heartbeat
 * gave: that table is not readable from a function, and a cadence that changes
 * without this changing is caught by the check itself going quiet.
 *
 * cron-heartbeat is deliberately absent. It cannot report its own death, and the
 * daily pass is what notices it.
 *
 * THE WEEKLY PRUNE IS ABSENT TOO, AND NOT BY CHOICE. Checked 2026-10-09: pg_cron runs
 * `homebase-prune-job-runs` every Sunday (schema_v41_job_runs.sql), but it is a bare SQL
 * function — `delete from job_runs where started_at < now() - 30 days` — and it writes no
 * row of its own. job_runs holds runs of cron-audit, cron-bank-sync, cron-heartbeat,
 * cron-notify and cron-reminders, and nothing else. A name added here with no rows behind
 * it would read "has never finished a run" every hour, which is noise, not a watch. Until
 * the function records itself, a stopped prune shows up the slow way: job_runs growing
 * past readAll's ceiling, at which point every heartbeat read refuses.
 */
export const WATCHED_JOBS: Readonly<Record<string, number>> = {
  "cron-bank-sync": 15,
  "cron-reminders": 15,
  "cron-notify": 1440,
  // Added 2026-10-05: the self-checks running themselves. A dead audit is silent by
  // construction — no failures found looks exactly like nothing to find — so its
  // liveness is watched here like any other job.
  "cron-audit": 1440,
};

export interface JobReading {
  job: string;
  /** Minutes since this job last FINISHED. Null when it has never finished, which
   *  is different from "a long time ago" and is said differently below. */
  minutesSinceFinish: number | null;
  /** Its own schedule, in minutes. 15 for the quarter-hour jobs, 1440 for daily. */
  everyMinutes: number;
  /** Did its most recent finish report success? */
  lastOk: boolean | null;
  /** Reminders that reached no device at all, summed over the window read. */
  reachedNobody: number;
}

export interface ConnectionReading {
  owner: string;
  institution: string | null;
  status: string;
  minutesSinceSync: number | null;
  consecutiveFailures: number;
}

export interface HeartbeatReadings {
  jobs: readonly JobReading[];
  connections: readonly ConnectionReading[];
  /** Whole days since the newest charge in the ledger. Null when there are none. */
  quietDays: number | null;
  /** Reminders past due by more than REMINDER_STUCK_MIN with nothing sent. */
  stuckReminders: number;
  /** Push targets per person. A person at zero has reminders marked delivered into
   *  nothing — the job says sent, and there is nobody to send to.
   *
   *  It must carry a ZERO for anyone who has none, not leave them out — see
   *  heartbeatFrom.ts for the day it left the one person who mattered out. */
  pushTargets: Readonly<Record<string, number>>;
  /** Who the heartbeat's own alarms are pushed to (HEARTBEAT_OWNER). At zero devices
   *  that is not one alarm among several: it is every other alarm reaching nobody. */
  alertOwner: string;
}

/** Who is told when the machinery breaks, unless HEARTBEAT_OWNER says otherwise. The
 *  push_subscriptions spelling, which is what webpush.ts matches on. One copy, read by
 *  cron-heartbeat, cron-audit and system.heartbeat alike. */
export const DEFAULT_ALERT_OWNER = "Gino";

export interface HeartbeatCheck {
  id: string;
  /** The plain question, phrased so the answer "ok" is obviously the good one —
   *  the same shape selfAudit's checks use, so both read the same way out loud. */
  question: string;
  status: "ok" | "alarm" | "unknown";
  /** One sentence. Said as it is, like every other door reply. */
  says: string;
}

export interface Heartbeat {
  clean: boolean;
  alarms: number;
  unknown: number;
  checks: HeartbeatCheck[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function sayMinutes(m: number): string {
  if (m < 90) return plural(Math.round(m), "minute", "minutes");
  const h = m / 60;
  if (h < 48) return plural(Math.round(h), "hour", "hours");
  return plural(Math.round(h / 24), "day", "days");
}

/**
 * Turn readings into verdicts.
 *
 * `unknown` is a THIRD state and not a rounding of either other one. A job that has
 * never finished is not passing and is not failing: it has never run, which is the
 * state the whole original failure lived in for months. Folding it into "ok" hides
 * exactly what this exists to find, and folding it into "alarm" would scream on the
 * morning anything new is deployed.
 */
export function heartbeat(r: HeartbeatReadings): Heartbeat {
  const checks: HeartbeatCheck[] = [];

  for (const j of r.jobs) {
    const limit = j.everyMinutes * MISSED_TICKS;
    if (j.minutesSinceFinish === null) {
      checks.push({
        id: `job:${j.job}`,
        question: `Is ${j.job} still running?`,
        status: "unknown",
        says: `${j.job} has never finished a run. If it was only just deployed this is expected; if not, it has never worked.`,
      });
    } else if (j.minutesSinceFinish > limit) {
      checks.push({
        id: `job:${j.job}`,
        question: `Is ${j.job} still running?`,
        status: "alarm",
        says: `${j.job} last finished ${sayMinutes(j.minutesSinceFinish)} ago and it should run every ${sayMinutes(j.everyMinutes)}. It has missed at least ${MISSED_TICKS - 1} turns.`,
      });
    } else if (j.lastOk === false) {
      checks.push({
        id: `job:${j.job}`,
        question: `Is ${j.job} still running?`,
        status: "alarm",
        says: `${j.job} ran ${sayMinutes(j.minutesSinceFinish)} ago and reported that it failed.`,
      });
    } else {
      checks.push({
        id: `job:${j.job}`,
        question: `Is ${j.job} still running?`,
        status: "ok",
        says: `${j.job} finished ${sayMinutes(j.minutesSinceFinish)} ago.`,
      });
    }
  }

  // THE ONE THAT SEPARATES "IT RAN" FROM "IT DID ANYTHING". A reminder is marked
  // delivered before the push goes out — deliberately, because the other order turns
  // one failed push into a buzz every fifteen minutes forever. The cost is that
  // sent_at proves the job ran and nothing more. This is the only number that knows.
  const nobody = r.jobs.reduce((s, j) => s + j.reachedNobody, 0);
  checks.push(
    nobody > 0
      ? {
          id: "reminders-reached-nobody",
          question: "Are reminders actually reaching a phone?",
          status: "alarm",
          says: `${plural(nobody, "reminder", "reminders")} was marked delivered while reaching no device at all. The app still says they were sent.`,
        }
      : {
          id: "reminders-reached-nobody",
          question: "Are reminders actually reaching a phone?",
          status: "ok",
          says: "Every reminder delivered lately reached at least one device.",
        },
  );

  for (const [person, n] of Object.entries(r.pushTargets)) {
    checks.push(
      n > 0
        ? {
            id: `push:${person}`,
            question: `Can ${person} still be reached by a notification?`,
            status: "ok",
            says: `${person} has ${plural(n, "device", "devices")} registered.`,
          }
        : {
            id: `push:${person}`,
            question: `Can ${person} still be reached by a notification?`,
            status: "alarm",
            // The alert owner gets the stronger sentence because it is the stronger
            // fact: every alarm in this list is pushed to that one person, so with no
            // device it is not one broken thing among several — it is the reason nobody
            // will hear about any of them.
            says: person === r.alertOwner
              ? `${person} has no device registered, and every alarm this check raises is sent to ${person} — so none of them reaches anyone. Every reminder for ${person} is marked delivered and reaches nobody too.`
              : `${person} has no device registered, so every reminder for ${person} is marked delivered and reaches nobody.`,
          },
    );
  }

  if (r.quietDays === null) {
    checks.push({
      id: "charges-arriving",
      question: "Are new charges still arriving from the bank?",
      status: "unknown",
      says: "There are no charges at all, so there is nothing to measure against.",
    });
  } else {
    checks.push(
      r.quietDays > QUIET_DAYS_MAX
        ? {
            id: "charges-arriving",
            question: "Are new charges still arriving from the bank?",
            status: "alarm",
            says: `No new charge for ${plural(r.quietDays, "day", "days")}. The longest ordinary quiet stretch here is ${QUIET_DAYS_MAX} days, so this is past normal.`,
          }
        : {
            id: "charges-arriving",
            question: "Are new charges still arriving from the bank?",
            status: "ok",
            says: r.quietDays === 0
              ? "A charge arrived today."
              : `The newest charge is ${plural(r.quietDays, "day", "days")} old, which is within the ordinary quiet stretch.`,
          },
    );
  }

  // PER ROW, NEVER AGGREGATED. Two connections, and one of them failing while the
  // other is fine is the likely shape — a household where one bank login needs
  // re-authorising and the other does not. A count would say "1 unhealthy" and leave
  // whoever reads it to go and find out whose.
  for (const c of r.connections) {
    const who = `${c.owner}'s ${c.institution ?? "bank"}`;
    if (c.status !== "ok" || c.consecutiveFailures > 0) {
      checks.push({
        id: `bank:${c.owner}`,
        question: `Is ${who} still connected?`,
        status: "alarm",
        says: c.consecutiveFailures > 0
          ? `${who} has failed to sync ${plural(c.consecutiveFailures, "time", "times")} in a row. It may need signing in to again.`
          : `${who} is in the state "${c.status}" rather than ok.`,
      });
    } else if (c.minutesSinceSync === null) {
      checks.push({
        id: `bank:${c.owner}`,
        question: `Is ${who} still connected?`,
        status: "unknown",
        says: `${who} is connected but has never synced.`,
      });
    } else if (c.minutesSinceSync > BANK_STALE_MIN) {
      // BANK_STALE_MIN, imported, not a number chosen here. The app already decided
      // what counts as stale money and stamps it on every read-door reply; a second
      // opinion in this file is how one system ends up with two answers to the same
      // question.
      checks.push({
        id: `bank:${c.owner}`,
        question: `Is ${who} still connected?`,
        status: "alarm",
        says: `${who} last synced ${sayMinutes(c.minutesSinceSync)} ago, past the ${BANK_STALE_MIN} minutes the app treats as current.`,
      });
    } else {
      checks.push({
        id: `bank:${c.owner}`,
        question: `Is ${who} still connected?`,
        status: "ok",
        says: `${who} synced ${sayMinutes(c.minutesSinceSync)} ago.`,
      });
    }
  }

  checks.push(
    r.stuckReminders > 0
      ? {
          id: "reminders-stuck",
          question: "Is any reminder overdue and still unsent?",
          status: "alarm",
          says: `${plural(r.stuckReminders, "reminder is", "reminders are")} more than ${REMINDER_STUCK_MIN} minutes past due with nothing sent.`,
        }
      : {
          id: "reminders-stuck",
          question: "Is any reminder overdue and still unsent?",
          status: "ok",
          says: "Nothing is sitting past its time.",
        },
  );

  const alarms = checks.filter((c) => c.status === "alarm").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  return { clean: alarms === 0, alarms, unknown, checks };
}
