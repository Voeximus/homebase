// A paycheck placed by day of month lands on the Friday before when that day is a
// weekend — and nothing else on the calendar moves.
//
// FOUND 2026-10-25. The semimonthly paycheck row says "the 15th and the last day", and the
// schedule put each check on exactly that date. The ledger shows otherwise: a month-end
// check that fell on a Sunday landed on Friday the 29th, and a 15th that fell on a
// Saturday landed on Friday the 14th. So the per-account look-ahead saw pay one or two
// days after it arrived and could call an account short on a day it was not.
//
// Every amount and name below is made up. The calendar dates are real ones — which day of
// the week a date falls on is the whole subject.
import { describe, expect, it } from "vitest";
import { monthlySchedule, paydayLandsOn } from "../src/lib/schedule";
import { billsAhead } from "../src/lib/headline";
import { monthlyAmount } from "../src/lib/recurring";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { Account, AppData, Recurring } from "../src/types";

const pay = (over: Partial<Recurring> = {}): Recurring => ({
  id: "pay",
  name: "Paycheck",
  amount: 2000,
  direction: "in",
  cadence: "semimonthly",
  active: true,
  dueDays: [15, 31],
  owner: "Gino",
  categoryId: "salary",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "bill",
  name: "Phone",
  amount: 300,
  direction: "out",
  cadence: "monthly",
  active: true,
  dueDays: [15],
  categoryId: "utilities",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const incomeDays = (rows: Recurring[], monthKey: string) =>
  monthlySchedule(rows, monthKey).entries.filter((e) => e.direction === "in").map((e) => e.day);

describe("paydayLandsOn", () => {
  it("is the two dates the ledger showed: a Saturday 15th lands Friday the 14th, a Sunday month end the 29th", () => {
    expect(paydayLandsOn("2026-08", 15)).toBe(14); // Sat 2026-08-15
    expect(paydayLandsOn("2026-05", 31)).toBe(29); // Sun 2026-05-31
  });

  it("resolves the month-end sentinel to the real last day before it looks at the weekday", () => {
    expect(paydayLandsOn("2026-10", 31)).toBe(30); // Sat 2026-10-31
    expect(paydayLandsOn("2028-09", 31)).toBe(29); // a 30-day month ending on Sat the 30th
    expect(paydayLandsOn("2027-02", 31)).toBe(26); // Sun 2027-02-28, a non-leap February
    expect(paydayLandsOn("2026-02", 31)).toBe(27); // Sat 2026-02-28
  });

  it("leaves a weekday exactly as it was given, sentinel and all", () => {
    expect(paydayLandsOn("2026-10", 15)).toBe(15); // Thu
    expect(paydayLandsOn("2026-08", 31)).toBe(31); // Mon 2026-08-31: still the sentinel
    expect(paydayLandsOn("2026-11", 31)).toBe(31); // Mon 2026-11-30
    expect(paydayLandsOn(undefined, 15)).toBe(15); // no month, no placing in time
  });

  it("never moves a check into the month before", () => {
    expect(paydayLandsOn("2026-11", 1)).toBe(1); // Sun 2026-11-01: its Friday is in October
    expect(paydayLandsOn("2027-05", 1)).toBe(1); // Sat 2027-05-01
    expect(paydayLandsOn("2026-05", 2)).toBe(1); // Sat 2026-05-02: Friday the 1st is still May
  });
});

describe("monthlySchedule places weekend paydays on the Friday before", () => {
  it("moves only the day of a semimonthly check, never the month's total", () => {
    const rows = [pay()];
    expect(incomeDays(rows, "2026-08")).toEqual([14, 31]);
    expect(incomeDays(rows, "2026-05")).toEqual([15, 29]);
    expect(incomeDays(rows, "2026-10")).toEqual([15, 30]);
    expect(incomeDays(rows, "2026-11")).toEqual([13, 31]); // Sun 15th → Fri 13th
    expect(incomeDays(rows, "2027-02")).toEqual([15, 26]);
    for (const mk of ["2026-05", "2026-08", "2026-10", "2026-11", "2027-02"]) {
      const total = monthlySchedule(rows, mk)
        .entries.filter((e) => e.direction === "in")
        .reduce((s, e) => s + e.amount, 0);
      expect(total, mk).toBe(monthlyAmount(rows[0]));
    }
  });

  it("leaves an outgoing bill on its due day, weekend or not", () => {
    const out = monthlySchedule([bill()], "2026-08").entries;
    expect(out.map((e) => e.day)).toEqual([15]);
  });

  it("leaves a biweekly check alone — its dates are stepped from a date it is known to have landed", () => {
    // Anchored on a Saturday on purpose: the anchor is the record of a real landing, so
    // even an odd one is not second-guessed.
    const bw = pay({ id: "bw", cadence: "biweekly", anchorDate: "2026-08-01", dueDays: [15, 29], amount: 1000 });
    expect(incomeDays([bw], "2026-08")).toEqual([1, 15, 29]);
  });

  it("judges a check's window on the date it is FOR, not the day it lands", () => {
    // Starts on Saturday the 15th: that first check still counts, and lands on the 14th.
    expect(incomeDays([pay({ startsOn: "2026-08-15" })], "2026-08")).toEqual([14, 31]);
    // Ends on Friday the 14th: the check for the 15th is outside it, even though it would
    // have landed on the 14th.
    expect(incomeDays([pay({ endsOn: "2026-08-14" })], "2026-08")).toEqual([]);
  });

  it("keeps the plan and the calendar in agreement (selfAudit check 1)", () => {
    const d: AppData = {
      transactions: [],
      debts: [],
      goals: [],
      categories: DEFAULT_CATEGORIES,
      accounts: [],
      recurring: [pay()],
      paidBills: [],
      merchantRules: [],
      foods: [],
    };
    const c = selfAudit(d, new Date(2026, 7, 10, 12)).checks.find((x) => x.id === "schedule-vs-plan")!;
    expect(c.status).toBe("ok");
  });
});

describe("the per-account look-ahead sees weekend pay when it arrives", () => {
  const account: Account = {
    id: "acct",
    name: "Checking",
    owner: "Gino",
    type: "checking",
    balance: 100,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const ahead = (rows: Recurring[]) => {
    const d: AppData = {
      transactions: [],
      debts: [],
      goals: [],
      categories: DEFAULT_CATEGORIES,
      accounts: [account],
      recurring: rows,
      paidBills: [],
      merchantRules: [],
      foods: [],
    };
    const now = new Date(2026, 7, 10, 12); // Mon Aug 10 2026
    return billsAhead(d, now, () => ({ payingNow: null, maybeAlreadyPaid: null })).accounts.find((a) => a.accountId === "acct")!;
  };

  it("is the false shortfall: a bill on Saturday the 15th is covered by the check that landed Friday the 14th", () => {
    const a = ahead([pay({ accountId: "acct" }), bill({ accountId: "acct", dueDays: [15] })]);
    expect(a.shortBy).toBe(0);
    expect(a.shortOn).toBeNull();
  });

  it("still walks a bill due ON the Friday before the pay that lands that day — the same-day rule is unchanged", () => {
    const a = ahead([pay({ accountId: "acct" }), bill({ accountId: "acct", dueDays: [14] })]);
    expect(a.shortBy).toBe(200);
    expect(a.shortOn).toBe("2026-08-14");
  });
});
