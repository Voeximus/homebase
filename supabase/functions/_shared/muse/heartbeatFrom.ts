// The heartbeat's READINGS, built once, for both callers.
//
// WHY THIS FILE EXISTS, found 2026-10-05. heartbeat.ts says "one copy of the
// judgement" and meant it — both the hourly cron-heartbeat function and Muse's
// system.heartbeat call the same pure heartbeat(). But the READINGS that function
// judges were built twice, in two files, by two different queries:
//
//   system.heartbeat   load.jobRuns() — readAll, paged, every row, ordered
//   cron-heartbeat     admin.from("job_runs").select(...) — one page, NO limit,
//                      NO order
//
// Supabase silently caps an unbounded select at 1,000 rows. job_runs crossed 1,000
// at 05:07 on 2026-10-02, and from that run on, the hourly function judged a random
// 1,000 of the ~1,700 rows. The bank sync and the reminders job write a row every 15
// minutes, so their NEWEST rows were the ones most likely to be missing — and the
// heartbeat concluded both had stopped. It said so every hour for three days, while
// Muse, asked the same question about the same table, answered "finished 5 minutes
// ago". Because the page was unordered it FLAPPED, and every flap back to "alarm"
// counted as new and pushed.
//
// The worst of it was the direction: an alarm stuck on means a REAL bank-feed outage
// is already "known" and pushes nothing. The check built to catch a dead feed had
// been made blind to one.
//
// So the readings come from here, through the Loader, which reads every table the
// paged way (Rule 5). Two callers, one builder, one answer — the same guarantee
// heartbeat.ts gave for the judgement, now extended to what it is judging.
//
// PURE IN THE SAME SENSE AS EVERYTHING HERE: it reads no clock. `now` (Arizona
// wall-clock, for calendar questions) and `at` (the real instant, for "how long ago")
// are both passed in.

import type { Loader } from "./load.ts";
import { azDateISO, minutesSince } from "./az.ts";
import { heartbeat, REMINDER_STUCK_MIN, WATCHED_JOBS, type Heartbeat } from "./heartbeat.ts";

export async function heartbeatFrom(load: Loader, now: Date, at: Date): Promise<Heartbeat> {
  const [runs, conns, targets, data, gino, xin] = await Promise.all([
    load.jobRuns(),
    load.bankConnections(),
    load.pushTargets(),
    load.appData(),
    load.reminders("gino"),
    load.reminders("xinyan"),
  ]);

  // `at`, the real instant — never `now`, whose epoch is seven hours out because its
  // fields hold Arizona. Subtracting a UTC timestamp from `now` once gave "finished
  // -406 minutes ago" for a row written thirteen minutes earlier. az.ts owns every
  // instant comparison; the door's clock guard allows time handling there and nowhere
  // else.
  const since = (iso: string | null): number | null => minutesSince(iso, at);

  const jobs = Object.entries(WATCHED_JOBS).map(([job, everyMinutes]) => {
    const mine = runs.filter((r) => r.job === job && r.finishedAt);
    const newest = mine.reduce<typeof mine[number] | null>(
      (best, r) => (!best || (r.finishedAt ?? "") > (best.finishedAt ?? "") ? r : best),
      null,
    );
    // Summed over everything kept, not over the newest run alone: a push that reached
    // nobody two hours ago still means nobody was reached.
    const reachedNobody = mine.reduce((sum, r) => {
      const n = Number((r.detail ?? {})["reached_nobody"] ?? 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    return {
      job,
      minutesSinceFinish: since(newest?.finishedAt ?? null),
      everyMinutes,
      lastOk: newest ? newest.ok : null,
      reachedNobody,
    };
  });

  const newestCharge = data.transactions.reduce((d, t) => (t.date > d ? t.date : d), "");
  const quietDays = newestCharge
    ? Math.floor((Date.parse(`${azDateISO(now)}T00:00:00Z`) - Date.parse(`${newestCharge}T00:00:00Z`)) / 86400000)
    : null;

  const stuck = [...gino, ...xin].filter(
    (r) => !r.sentAt && !r.canceledAt && (since(r.dueAt) ?? 0) > REMINDER_STUCK_MIN,
  ).length;

  return heartbeat({
    jobs,
    connections: conns.map((c) => ({
      owner: c.owner,
      institution: c.institution,
      status: c.status,
      minutesSinceSync: since(c.lastSyncAt),
      consecutiveFailures: c.consecutiveFailures,
    })),
    quietDays,
    stuckReminders: stuck,
    pushTargets: targets,
  });
}

/** The alarm ids a previous cron-heartbeat run recorded, read from the SAME complete
 *  job_runs load — so the "is this alarm new" comparison can no longer be fooled by a
 *  truncated page either. Exported because it is the other half of the bug: the old
 *  function found its own previous row in the same capped, unordered page. */
export async function previousAlarms(load: Loader): Promise<Set<string>> {
  const runs = await load.jobRuns();
  const previous = runs
    .filter((r) => r.job === "cron-heartbeat" && r.finishedAt)
    .reduce<(typeof runs)[number] | null>(
      (best, r) => (!best || (r.finishedAt ?? "") > (best.finishedAt ?? "") ? r : best),
      null,
    );
  return new Set(((previous?.detail ?? {})["alarming"] as string[] | undefined) ?? []);
}
