import { describe, it, expect, vi, afterEach } from "vitest";
import { todayISO, currentMonthKey, isoDate, monthKeyOf } from "../src/lib/format";
import { biweeklyDaysIn, inWindow, firesInMonth, billCycleFor } from "../src/lib/schedule";
import { payCycleFor, nextPayday, previousPayday, PAY_DAYS } from "../src/lib/plan";
import type { Recurring } from "../src/types";

// A minimal recurring row. Only the fields a given test cares about get set.
const row = (over: Partial<Recurring> = {}): Recurring => ({
  id: "r1",
  name: "Test",
  amount: 100,
  direction: "out",
  cadence: "monthly",
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

afterEach(() => vi.useRealTimers());

// ─────────────────────────────────────────────────────────────────────────────
describe("the stamp is LOCAL, never UTC", () => {
  // This is the regression guard for the worst money bug in the app: dates were
  // stamped with toISOString(), which is UTC, so from 5pm Arizona onward every
  // entry was filed under TOMORROW — into the wrong budget month and the wrong
  // pay cycle.
  it("6pm on the last of the month stays in that month", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T01:00:00Z")); // 6pm Aug 31 in Phoenix
    expect(todayISO()).toBe("2026-08-31");
    expect(currentMonthKey()).toBe("2026-08");
    // and the UTC spelling is provably different — proving the test has teeth
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("9pm on New Year's Eve does not roll into the next YEAR", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T04:00:00Z")); // 9pm Dec 31 in Phoenix
    expect(todayISO()).toBe("2026-12-31");
    expect(currentMonthKey()).toBe("2026-12");
  });

  it("morning is unaffected (control)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T16:00:00Z")); // 9am Phoenix
    expect(todayISO()).toBe("2026-08-18");
  });

  it("isoDate/monthKeyOf agree with the Date's own LOCAL fields, always", () => {
    for (const iso of [
      "2026-01-01T07:30:00Z",
      "2026-06-15T23:59:00Z",
      "2026-12-31T06:59:00Z",
      "2027-03-01T00:00:00Z",
    ]) {
      const d = new Date(iso);
      const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
      expect(isoDate(d)).toBe(expected);
      expect(monthKeyOf(d)).toBe(expected.slice(0, 7));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("biweeklyDaysIn — real 14-day stepping", () => {
  // Xinyan is paid every 14 days. Modelling that as "twice a month" put every
  // forecast off by up to six days and hid the months that carry a third check.
  it("steps 14 days from the anchor", () => {
    expect(biweeklyDaysIn("2026-08-07", "2026-08")).toEqual([7, 21]);
    expect(biweeklyDaysIn("2026-08-07", "2026-09")).toEqual([4, 18]);
  });

  it("finds the months that carry a THIRD paycheck", () => {
    expect(biweeklyDaysIn("2026-08-07", "2026-10")).toEqual([2, 16, 30]);
  });

  it("walks BACKWARDS from the anchor so past months render", () => {
    expect(biweeklyDaysIn("2026-08-07", "2026-07")).toEqual([10, 24]);
    expect(biweeklyDaysIn("2026-08-07", "2026-06")).toEqual([12, 26]);
  });

  it("handles February and a leap year", () => {
    expect(biweeklyDaysIn("2026-08-07", "2027-02")).toEqual([5, 19]);
    expect(biweeklyDaysIn("2028-01-07", "2028-02")).toEqual([4, 18]);
  });

  it("returns nothing for a malformed anchor rather than throwing", () => {
    expect(biweeklyDaysIn("", "2026-08")).toEqual([]);
    expect(biweeklyDaysIn("nonsense", "2026-08")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("inWindow — a bill's lifetime", () => {
  it("is unbounded when neither side is set", () => {
    expect(inWindow(row(), "2020-01", 1)).toBe(true);
    expect(inWindow(row(), "2099-12", 31)).toBe(true);
  });

  it("BOTH bounds are inclusive", () => {
    const r = row({ startsOn: "2026-09-30", endsOn: "2026-11-30" });
    expect(inWindow(r, "2026-09", 30)).toBe(true); // exactly the first day
    expect(inWindow(r, "2026-11", 30)).toBe(true); // exactly the last day
    expect(inWindow(r, "2026-09", 29)).toBe(false);
    expect(inWindow(r, "2026-12", 30)).toBe(false);
  });

  it("clamps a day past the month's length (a day-30 bill in February)", () => {
    // Feb 2027 has 28 days, so day 30 resolves to the 28th — which IS inside a
    // window that opens on Feb 1. Without the clamp the row would compare
    // "2027-02-30", a date that does not exist.
    const r = row({ startsOn: "2027-02-01" });
    expect(inWindow(r, "2027-02", 30)).toBe(true);
    const ended = row({ endsOn: "2027-02-27" });
    expect(inWindow(ended, "2027-02", 30)).toBe(false); // clamps to 28 > 27
  });

  it("lets the row through when there is no month to place it in", () => {
    // Better to show a real bill than to hide it on missing context.
    expect(inWindow(row({ startsOn: "2030-01-01" }), undefined, 15)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("firesInMonth — periodic bills land on their anniversary only", () => {
  it("monthly and sub-monthly cadences always fire", () => {
    for (const cadence of ["weekly", "biweekly", "semimonthly", "monthly"] as const) {
      expect(firesInMonth(row({ cadence }), "2026-08")).toBe(true);
    }
  });

  it("a yearly membership fires in ONE month, not twelve", () => {
    const r = row({ cadence: "yearly", anchorDate: "2026-06-16" });
    const firing = [];
    for (let m = 1; m <= 12; m++) {
      if (firesInMonth(r, `2026-${String(m).padStart(2, "0")}`)) firing.push(m);
    }
    expect(firing).toEqual([6]);
  });

  it("semiannual fires every 6 months, forwards AND backwards across a year", () => {
    const r = row({ cadence: "semiannual", anchorDate: "2026-08-01" });
    expect(firesInMonth(r, "2026-08")).toBe(true);
    expect(firesInMonth(r, "2027-02")).toBe(true);
    expect(firesInMonth(r, "2026-02")).toBe(true); // before the anchor
    expect(firesInMonth(r, "2025-08")).toBe(true);
    expect(firesInMonth(r, "2026-09")).toBe(false);
    expect(firesInMonth(r, "2027-01")).toBe(false);
  });

  it("quarterly", () => {
    const r = row({ cadence: "quarterly", anchorDate: "2026-01-15" });
    expect([1, 4, 7, 10].every((m) => firesInMonth(r, `2026-${String(m).padStart(2, "0")}`))).toBe(true);
    expect([2, 3, 5, 6, 8, 9, 11, 12].some((m) => firesInMonth(r, `2026-${String(m).padStart(2, "0")}`))).toBe(false);
  });

  it("an un-anchored periodic bill is shown rather than hidden", () => {
    expect(firesInMonth(row({ cadence: "yearly" }), "2026-03")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("payCycleFor — the budget's real unit", () => {
  it("the 31 sentinel resolves to the true last day", () => {
    expect(PAY_DAYS).toEqual([15, 31]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T19:00:00Z")); // noon Sep 20 Phoenix
    const c = payCycleFor(new Date());
    expect(c.start).toBe("2026-09-15");
    expect(c.end).toBe("2026-09-29"); // day before Sep 30, the month-end payday
  });

  it("spans the month boundary by design", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T19:00:00Z"));
    const c = payCycleFor(new Date());
    expect(c.start).toBe("2026-08-31");
    expect(c.end).toBe("2026-09-14");
  });

  it("February's month-end payday is the 28th", () => {
    const d = new Date(2027, 1, 20, 12); // Feb 20 2027 local
    const c = payCycleFor(d);
    expect(c.start).toBe("2027-02-15");
    expect(c.end).toBe("2027-02-27");
    expect(nextPayday(d).getDate()).toBe(28);
  });

  it("dayIndex and days are consistent, and dayIndex starts at 1", () => {
    const d = new Date(2026, 8, 15, 12);
    const c = payCycleFor(d);
    expect(c.dayIndex).toBe(1);
    expect(c.days).toBeGreaterThan(1);
  });

  it("previousPayday mirrors nextPayday", () => {
    const d = new Date(2026, 8, 20, 12);
    expect(previousPayday(d).getDate()).toBe(15);
    expect(nextPayday(d).getDate()).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("billCycleFor — which cycle a payment settles", () => {
  it("an EARLY payment rolls forward to the next cycle, not late on this one", () => {
    // Paying the Jul-17 bill on Jun 30 must count for July.
    expect(billCycleFor([17], "2026-06-30")).toEqual({ monthKey: "2026-07", day: 17 });
  });

  it("on time stays on this cycle", () => {
    expect(billCycleFor([17], "2026-07-17")).toEqual({ monthKey: "2026-07", day: 17 });
  });

  it("slightly late still settles this cycle (7-day grace)", () => {
    expect(billCycleFor([17], "2026-07-23")).toEqual({ monthKey: "2026-07", day: 17 });
  });

  it("beyond the grace it is prepaying the NEXT cycle", () => {
    expect(billCycleFor([17], "2026-07-26")).toEqual({ monthKey: "2026-08", day: 17 });
  });

  it("multi-installment bills keep their two slots distinct", () => {
    expect(billCycleFor([15, 30], "2026-07-15")).toEqual({ monthKey: "2026-07", day: 15 });
    expect(billCycleFor([15, 30], "2026-07-30")).toEqual({ monthKey: "2026-07", day: 30 });
  });

  it("clamps a day-31 bill to a short month", () => {
    expect(billCycleFor([31], "2026-09-30").day).toBe(30);
  });

  it("with no due days it uses the payment's own day", () => {
    expect(billCycleFor(undefined, "2026-07-09")).toEqual({ monthKey: "2026-07", day: 9 });
  });
});
