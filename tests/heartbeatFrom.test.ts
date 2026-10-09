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

function fakeLoad(runs: JobRunRow[], targets: Record<string, number> = { Gino: 1, Xinyan: 4 }): Loader {
  return {
    jobRuns: async () => runs,
    bankConnections: async () => [
      { owner: "Gino", institution: "Bank of America", status: "ok", lastSyncAt: iso(4), consecutiveFailures: 0 },
    ],
    // The push table's own counts, as loadFinance.pushTargets returns them: a person
    // with no device has NO KEY here, not a zero — which is the whole of the bug below.
    pushTargets: async () => targets,
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

// FOUND 2026-10-09. push_subscriptions held 4 rows, all Xinyan's. Gino had none — and
// Gino is HEARTBEAT_OWNER, the one person every alarm is pushed to. The readings were
// the table's own counts, so Gino was not a zero, he was ABSENT, and the check loops over
// whoever is present: the heartbeat said clean while every alarm it could raise was
// going nowhere.
describe("heartbeatFrom checks every household person and the alert owner, devices or not", () => {
  const push = (hb: Awaited<ReturnType<typeof heartbeatFrom>>, who: string) =>
    hb.checks.find((c) => c.id === `push:${who}`);

  it("alarms when the alert owner has no device at all — the live state that read clean", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap(), { Xinyan: 4 }), NOW, AT);
    const gino = push(hb, "Gino");
    expect(gino, "Gino was never checked").toBeTruthy();
    expect(gino!.status).toBe("alarm");
    // The stronger sentence, because it is the stronger fact: nobody hears about ANY alarm.
    expect(gino!.says).toMatch(/every alarm this check raises is sent to Gino/);
    expect(hb.clean).toBe(false);
    expect(push(hb, "Xinyan")!.status).toBe("ok");
  });

  it("checks every household person even when the table has nobody at all", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap(), {}), NOW, AT);
    expect(push(hb, "Gino")!.status).toBe("alarm");
    const xinyan = push(hb, "Xinyan")!;
    expect(xinyan.status).toBe("alarm");
    // Not the alert owner, so the ordinary sentence.
    expect(xinyan.says).toMatch(/every reminder for Xinyan is marked delivered and reaches nobody/);
    expect(xinyan.says).not.toMatch(/every alarm/);
  });

  it("checks whoever HEARTBEAT_OWNER names, even someone outside the household list", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap(), { Gino: 1, Xinyan: 4 }), NOW, AT, "Ops");
    const ops = push(hb, "Ops")!;
    expect(ops.status).toBe("alarm");
    expect(ops.says).toMatch(/sent to Ops/);
    // Gino has a device here and is no longer the alert owner: ordinary and fine.
    expect(push(hb, "Gino")!.status).toBe("ok");
  });

  it("counts a Joint device as reaching him, because that is what sendPush does", async () => {
    // webpush.ts sends an owner's push to that owner's devices AND every Joint one. A
    // Joint phone is a real way to reach him; an alarm saying it is not would be false.
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap(), { Joint: 1, Xinyan: 4 }), NOW, AT);
    expect(push(hb, "Gino")!.status).toBe("ok");
    expect(push(hb, "Xinyan")!.says).toContain("5 devices");
  });

  it("is clean when everyone, the alert owner included, can be reached", async () => {
    const hb = await heartbeatFrom(fakeLoad(runsPastTheCap()), NOW, AT);
    expect(push(hb, "Gino")!.status).toBe("ok");
    expect(push(hb, "Xinyan")!.status).toBe("ok");
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
