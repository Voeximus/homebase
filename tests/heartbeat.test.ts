// The checks that ask whether anything is still running.
//
// Separate from selfAudit's tests on purpose, because they answer a different
// question: selfAudit asks whether the numbers agree with each other, and every one
// of its checks keeps passing while the feed that supplies them is dead. A ledger
// that stopped receiving charges is perfectly consistent — about last week.
import { describe, expect, it } from "vitest";
import {
  heartbeat,
  MISSED_TICKS,
  QUIET_DAYS_MAX,
  REMINDER_STUCK_MIN,
  type HeartbeatReadings,
} from "../supabase/functions/_shared/muse/heartbeat.ts";
import { BANK_STALE_MIN } from "../supabase/functions/_shared/muse/freshness.ts";

const healthy = (over: Partial<HeartbeatReadings> = {}): HeartbeatReadings => ({
  jobs: [
    { job: "cron-bank-sync", minutesSinceFinish: 4, everyMinutes: 15, lastOk: true, reachedNobody: 0 },
    { job: "cron-reminders", minutesSinceFinish: 4, everyMinutes: 15, lastOk: true, reachedNobody: 0 },
  ],
  connections: [
    { owner: "Gino", institution: "Bank of America", status: "ok", minutesSinceSync: 4, consecutiveFailures: 0 },
  ],
  quietDays: 0,
  stuckReminders: 0,
  pushTargets: { Gino: 1, Xinyan: 5 },
  ...over,
});

const find = (r: ReturnType<typeof heartbeat>, id: string) => r.checks.find((c) => c.id === id)!;

describe("heartbeat", () => {
  it("is clean when everything is running", () => {
    const r = heartbeat(healthy());
    expect(r.clean).toBe(true);
    expect(r.alarms).toBe(0);
    expect(r.unknown).toBe(0);
  });

  it("forgives one missed tick and not two", () => {
    // A single skipped run is ordinary scheduler noise. Waking somebody for it is
    // how an alarm gets muted, and a muted alarm is worse than none.
    const at = (mins: number) =>
      find(heartbeat(healthy({ jobs: [{ job: "j", minutesSinceFinish: mins, everyMinutes: 15, lastOk: true, reachedNobody: 0 }] })), "job:j").status;
    expect(at(15 * MISSED_TICKS - 1)).toBe("ok");
    expect(at(15 * MISSED_TICKS + 1)).toBe("alarm");
  });

  it("calls a job that has never finished unknown, not ok and not broken", () => {
    // The third state is the one the original failure lived in for months. Folding
    // it into "ok" hides exactly what this exists to find; folding it into "alarm"
    // screams every time something new is deployed.
    const r = heartbeat(healthy({ jobs: [{ job: "j", minutesSinceFinish: null, everyMinutes: 15, lastOk: null, reachedNobody: 0 }] }));
    expect(find(r, "job:j").status).toBe("unknown");
    expect(r.clean).toBe(true);
    expect(r.unknown).toBe(1);
  });

  it("alarms on a job that finished on time and reported failure", () => {
    const r = heartbeat(healthy({ jobs: [{ job: "j", minutesSinceFinish: 2, everyMinutes: 15, lastOk: false, reachedNobody: 0 }] }));
    expect(find(r, "job:j").status).toBe("alarm");
  });

  it("catches a reminder marked delivered into nothing", () => {
    // sent_at proves the job ran, not that anything arrived — the row is claimed
    // BEFORE the push, so this counter is the only thing that knows.
    const r = heartbeat(healthy({
      jobs: [{ job: "cron-reminders", minutesSinceFinish: 2, everyMinutes: 15, lastOk: true, reachedNobody: 2 }],
    }));
    expect(find(r, "reminders-reached-nobody").status).toBe("alarm");
    expect(find(r, "reminders-reached-nobody").says).toContain("still says they were sent");
  });

  it("names the person who has no device left", () => {
    const r = heartbeat(healthy({ pushTargets: { Gino: 0, Xinyan: 5 } }));
    expect(find(r, "push:Gino").status).toBe("alarm");
    expect(find(r, "push:Xinyan").status).toBe("ok");
  });

  it("treats the measured quiet stretch as normal and one more day as not", () => {
    // Three months of real feed: the longest ordinary gap is 3 days, twice.
    const at = (d: number) => find(heartbeat(healthy({ quietDays: d })), "charges-arriving").status;
    expect(at(QUIET_DAYS_MAX)).toBe("ok");
    expect(at(QUIET_DAYS_MAX + 1)).toBe("alarm");
  });

  it("reports each bank connection on its own, never as a count", () => {
    // One login needing re-auth while the other is fine is the likely shape. "1
    // unhealthy" leaves whoever reads it to go and find out whose.
    const r = heartbeat(healthy({
      connections: [
        { owner: "Gino", institution: "Bank of America", status: "ok", minutesSinceSync: 3, consecutiveFailures: 0 },
        { owner: "Xinyan", institution: "Bank of America", status: "ok", minutesSinceSync: 3, consecutiveFailures: 4 },
      ],
    }));
    expect(find(r, "bank:Gino").status).toBe("ok");
    expect(find(r, "bank:Xinyan").status).toBe("alarm");
    expect(find(r, "bank:Xinyan").says).toContain("Xinyan's Bank of America");
  });

  it("uses the app's own staleness limit rather than a second opinion", () => {
    const at = (m: number) =>
      find(heartbeat(healthy({ connections: [{ owner: "G", institution: null, status: "ok", minutesSinceSync: m, consecutiveFailures: 0 }] })), "bank:G").status;
    expect(at(BANK_STALE_MIN - 1)).toBe("ok");
    expect(at(BANK_STALE_MIN + 1)).toBe("alarm");
  });

  it("flags a reminder sitting past its time", () => {
    expect(find(heartbeat(healthy({ stuckReminders: 1 })), "reminders-stuck").status).toBe("alarm");
    expect(REMINDER_STUCK_MIN).toBe(30);
  });

  it("says every check as a question whose good answer is ok", () => {
    for (const c of heartbeat(healthy()).checks) {
      expect(c.question.endsWith("?"), `${c.id} is not phrased as a question`).toBe(true);
      expect(c.says.length).toBeGreaterThan(10);
    }
  });
});
