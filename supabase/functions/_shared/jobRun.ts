// A scheduled job saying, in its own words, that it finished.
//
// WHY A JOB RECORDS ITSELF RATHER THAN BEING WATCHED
//   pg_cron already keeps cron.job_run_details, and it is the wrong thing to read
//   twice over. It is not readable from here — only `postgres` holds grants on the
//   cron schema and `service_role`, which is what these functions run as, holds none.
//   And it answers a weaker question: it records that pg_cron INVOKED the http call,
//   so a 200 means the request left, not that the work happened. cron-bank-sync can
//   answer 200 having synced nothing; cron-reminders can answer 200 having reached
//   no device.
//
//   The claim worth alarming on is the one only the job can make.
//
// `detail` IS NOT DECORATION. "It ran" and "it did anything" are different claims,
// and the original failure — no bank pull for months — would have shown as a run
// that kept succeeding while the ledger stopped moving. A job that reports what it
// actually moved lets the heartbeat ask the second question.
//
// THIS NEVER FAILS THE JOB IT WRAPS. A heartbeat that can break the thing it
// watches is worse than none: the bank sync must not stop because a bookkeeping
// insert had a bad minute. Every error here is logged and swallowed, and the job's
// own result is returned untouched. The cost of that choice is a missing row, which
// the heartbeat reads as "this job has not finished lately" — the safe direction,
// because it over-reports rather than going quiet.

// deno-lint-ignore no-explicit-any
type Admin = any;

/** What a job reports about the work itself, in its own terms. */
export type JobDetail = Record<string, unknown>;

export interface JobOutcome<T> {
  result: T;
  ok: boolean;
  detail?: JobDetail;
}

/**
 * Run a job's work and record that it finished.
 *
 * The row is opened BEFORE the work and closed after, so a job that dies halfway —
 * killed mid-run, timed out, crashed the isolate — leaves a row with a
 * `finished_at` of null rather than no row at all. Those two look identical to a
 * heartbeat that only asks "when did this last finish", which is the point: a job
 * that starts and never finishes is as broken as one that never starts, and it is
 * the shape that would otherwise be invisible.
 */
export async function recordRun<T>(
  admin: Admin,
  job: string,
  work: () => Promise<JobOutcome<T>>,
): Promise<T> {
  let runId: string | null = null;
  try {
    const { data } = await admin.from("job_runs").insert({ job }).select("id").single();
    runId = data?.id ? String(data.id) : null;
  } catch (e) {
    console.error(`${job}: could not open a job_runs row`, String(e).slice(0, 160));
  }

  try {
    const outcome = await work();
    if (runId) {
      try {
        await admin
          .from("job_runs")
          .update({
            finished_at: new Date().toISOString(),
            ok: outcome.ok,
            detail: outcome.detail ?? null,
          })
          .eq("id", runId);
      } catch (e) {
        console.error(`${job}: could not close its job_runs row`, String(e).slice(0, 160));
      }
    }
    return outcome.result;
  } catch (e) {
    // The work threw. Close the row as failed and RE-THROW — swallowing it here
    // would turn a broken job into a quiet one, which is the whole thing this file
    // exists to prevent.
    const message = String((e as { message?: unknown })?.message ?? e).slice(0, 400);
    if (runId) {
      try {
        await admin
          .from("job_runs")
          .update({ finished_at: new Date().toISOString(), ok: false, error: message })
          .eq("id", runId);
      } catch (inner) {
        console.error(`${job}: could not record its own failure`, String(inner).slice(0, 160));
      }
    }
    throw e;
  }
}

/**
 * Record a finished run directly, for a job that does not throw.
 *
 * WHY THE SECOND SHAPE EXISTS. `recordRun` above wraps work and re-throws, which is
 * right for a job whose failure should be loud. cron-reminders is deliberately not
 * that job: it catches its own errors so one bad row cannot stop the next tick, and
 * it answers ok:true regardless. Wrapping it would record every run as a success,
 * which is the exact claim a heartbeat must not be told.
 *
 * So that job keeps its own catch, holds what went wrong, and says so here. The row
 * carries the truth its HTTP response cannot.
 *
 * Swallows its own errors for the same reason recordRun does: bookkeeping must never
 * be the reason the work stopped.
 */
export async function recordFinished(
  admin: Admin,
  job: string,
  outcome: { ok: boolean; detail?: JobDetail; error?: string | null },
): Promise<void> {
  try {
    const at = new Date().toISOString();
    await admin.from("job_runs").insert({
      job,
      started_at: at,
      finished_at: at,
      ok: outcome.ok,
      detail: outcome.detail ?? null,
      error: outcome.error ?? null,
    });
  } catch (e) {
    console.error(`${job}: could not record its run`, String(e).slice(0, 160));
  }
}
