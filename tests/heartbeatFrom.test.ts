// The heartbeat must judge the WHOLE of job_runs, not a page of it.
//
// FOUND 2026-10-05. The hourly cron-heartbeat function read job_runs with its own
// unbounded `select`, which Supabase caps at 1,000 rows. job_runs crossed 1,000 at
// 05:07 on 2026-10-02; from then on the bank sync and reminders jobs — which write a
// row every 15 minutes, so their newest rows are the ones a cap drops — read as
// stopped, every hour, while both were running. Muse's system.heartbeat, asked the
// same question of the same table through the paged loader, said "finished 5 minutes
// ago".
//
// Both now build their readings in heartbeatFrom(). These tests hand it a ledger
// past the old cap with the decisive row LAST, which is the shape that broke it.
import { describe, expect, it } from "vitest";
import { heartbeatFrom, previousAlarms } from "../supabase/functions/_shared/muse/heartbeatFrom";
import { WATCHED_JOBS } from "../supabase/functions/_shared/muse/heartbeat";
import type { Loader } from "../supabase/functions/_shared/muse/load";
import type { JobRunRow } from "../supabase/functions/_shared/muse/loadFinance";

const AT = new Date("2026-10-05T14:20:00Z"); // the real instant
const NOW = new Date("2026-10-05T07:20:00Z"); // nowAZ(AT): Arizona wall clock in UTC fields

const iso = (minutesAgo: number) => new Date(AT.getTime() - minutesAgo * 60000).toISOString();

/** 1,700 job_runs rows — past the old 1,000 cap — oldest first, so every job's
 *  NEWEST row sits in the tail a capped page would have dropped. */
function runsPastTheCap(): JobRunRow[] {
  const rows: JobRunRow[] = [];
  for (let i = 1700; i >= 1; i--) {
    rows.push({ job: "cron-bank-sync", finishedAt: iso(i * 15), ok: true, detail: null });
  }
  // The decisive rows, last of all.
  rows.push({ job: "cron-bank-sync", finishedAt: iso(4), ok: true, detail: null });
  rows.push({ job: "cron-reminders", finishedAt: iso(4), ok: true, detail: null });
  rows.push({ job: "cron-notify", finishedAt: iso(60), ok: true, detail: null });
  rows.push({ job: "cron-audit", finishedAt: iso(60), ok: true, detail: null });
  rows.push({ job: "cron-heartbeat", finishedAt: iso(13), ok: true, detail: { alarming: ["job:cron-bank-sync"] } });
  return rows;
}

function fakeLoad(runs: JobRunRow[]): Loader {
  return {
    jobRuns: async () => runs,
    bankConnections: async () => [
      { owner: "Gino", institution: "Bank of America", status: "ok", lastSyncAt: iso(4), consecutiveFailures: 0 },
    ],
    pushTargets: async () => ({ Gino: 1 }),
    appData: async () => ({ transactions: [{ date: "2026-10-05" }] }),
    reminders: async () => [],
  } as unknown as Loader;
}

describe("heartbeatFrom reads every job run, however many there are", () => {
  it("does not call the bank sync stopped when its newest row is past row 1,000", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap()), NOW, AT);
    const bank = hb.checks.find((c) => c.id === "job:cron-bank-sync")!;
    expect(bank.status).toBe("ok");
    expect(bank.says).toContain("4 minutes ago");
  });

  it("nor the reminders job — the other 15-minute job the cap hid", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap()), NOW, AT);
    expect(hb.checks.find((c) => c.id === "job:cron-reminders")!.status).toBe("ok");
  });

  it("watches every job in the one shared list, including cron-audit", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap()), NOW, AT);
    for (const job of Object.keys(WATCHED_JOBS)) {
      expect(hb.checks.map((c) => c.id), `${job} is not watched`).toContain(`job:${job}`);
    }
  });

  it("still alarms when a job genuinely stops — the fix must not just silence it", async () => {
    const runs = runsPastTheCap().filter((r) => r.job !== "cron-bank-sync" || r.finishedAt! < iso(600));
    const hb = await heartbeatFrom(fakeLoad(runs), NOW, AT);
    expect(hb.checks.find((c) => c.id === "job:cron-bank-sync")!.status).toBe("alarm");
  });
});

describe("previousAlarms finds the last heartbeat row in a complete load", () => {
  it("returns what the newest cron-heartbeat run recorded, wherever it sits", async () => {
    // The old function searched the same capped page for its own last row and lost
    // it, so every alarm looked new and pushed again.
    const known = await previousAlarms(fakeLoad(runsPastTheCap()));
    expect([...known]).toEqual(["job:cron-bank-sync"]);
  });

  it("is empty when the heartbeat has never run", async () => {
    const known = await previousAlarms(fakeLoad([]));
    expect(known.size).toBe(0);
  });
});
