import { describe, it, expect } from "vitest";
import {
  payoffSchedule,
  payoffClears,
  minFirepowerToClear,
  autopaysOf,
  PAY_DAYS,
  SAVINGS_SPLIT,
  type Autopay,
} from "../src/lib/plan";
import { shiftMonthKey } from "../src/lib/format";
import type { Debt, Recurring } from "../src/types";

// The payoff projection is the only calculation in the app that produces a DATE
// people plan around, and it is the one with no ground truth to check against —
// the future has not happened yet. So these tests check the things that must be
// true of any answer it gives, whatever the numbers.

const debt = (name: string, balance: number, apr = 0): Debt =>
  ({ id: name, name, balance, apr, minPayment: 0, originalBalance: balance }) as Debt;

// Gino's real debts, June 2026, in his real attack order.
const REAL = [debt("Affirm", 0.83), debt("Mom (China)", 700), debt("Credit card (…4728)", 4113.01, 26.49), debt("Cherry (dental)", 758.57)];
const FROM = new Date(2026, 8, 11);

describe("the savings skim can never starve the debt", () => {
  // The bug: once ONE debt remained, `toSavings = min(perCheck, perPay)` took the
  // whole payday whenever perPay <= $500. The debt then received $0.00 forever —
  // not less, nothing — the balance froze, and the loop ran out its 240-payday
  // guard. Traced on the real debts at $800/mo: 240 of 240 paydays sent nothing.
  it("sends something at the debt on every payday, at any firepower", () => {
    for (const monthly of [100, 300, 600, 800, 999, 1000, 1500, 3000]) {
      const sch = payoffSchedule(REAL, monthly, FROM, PAY_DAYS, SAVINGS_SPLIT);
      const starved = sch.filter((e) => e.toDebt <= 0.005);
      expect(
        starved.length,
        `$${monthly}/mo produced ${starved.length} paydays that sent $0 at the debt`,
      ).toBe(0);
    }
  });

  it("more firepower never leaves more debt", () => {
    // The old code was non-monotonic: a bigger perPay meant a bigger skim, so
    // $800/mo finished with $739.51 owed while $600/mo finished with $670.41.
    let prev = Infinity;
    for (const monthly of [300, 600, 800, 1000, 1200, 1600, 2400]) {
      const sch = payoffSchedule(REAL, monthly, FROM, PAY_DAYS, SAVINGS_SPLIT);
      const left = sch.length ? sch[sch.length - 1].remaining : Infinity;
      expect(left, `$${monthly}/mo left more than the level below it`).toBeLessThanOrEqual(prev + 0.005);
      prev = left;
    }
  });

  it("still skims the full $500 at the firepower the plan actually runs at", () => {
    // The fix must be a no-op where it matters today: perPay is ~$1,132, so the
    // half-cap (566) never binds and the skim is the intended $500.
    const sch = payoffSchedule(REAL, 2264.5, FROM, PAY_DAYS, SAVINGS_SPLIT);
    const skimming = sch.filter((e) => e.toSavings > 0);
    expect(skimming.length).toBeGreaterThan(0);
    for (const e of skimming) expect(e.toSavings).toBeCloseTo(500, 2);
  });
});

describe("a schedule that never clears must not report a date", () => {
  it("payoffClears is false when the loop gave up", () => {
    // A debt whose interest outruns the payment: the projection cannot finish, and
    // saying so is the only honest answer.
    const runaway = [debt("Card", 20000, 29.99)];
    const sch = payoffSchedule(runaway, 120, FROM, PAY_DAYS);
    expect(sch.length).toBeGreaterThan(0); // it still returns events…
    expect(payoffClears(sch)).toBe(false); // …but it did NOT pay anything off
    expect(sch[sch.length - 1].remaining).toBeGreaterThan(0);
  });

  it("payoffClears is true for a plan that finishes", () => {
    const sch = payoffSchedule(REAL, 2264.5, FROM, PAY_DAYS, SAVINGS_SPLIT);
    expect(payoffClears(sch)).toBe(true);
    expect(sch[sch.length - 1].remaining).toBeLessThanOrEqual(0.005);
  });

  it("payoffClears is false for an empty schedule", () => {
    // Zero or negative firepower returns no events at all.
    expect(payoffClears(payoffSchedule(REAL, 0, FROM))).toBe(false);
  });
});

describe("the schedule's arithmetic closes", () => {
  it("every dollar sent is accounted for as principal or interest", () => {
    const sch = payoffSchedule(REAL, 2264.5, FROM, PAY_DAYS, SAVINGS_SPLIT);
    const principal = REAL.reduce((s, d) => s + d.balance, 0);
    const interest = sch.reduce((s, e) => s + e.interest, 0);
    const paid = sch.reduce((s, e) => s + e.toDebt, 0);
    // What reached the debts must equal what was owed plus what it cost to carry.
    expect(paid).toBeCloseTo(principal + interest, 2);
  });

  it("each event's total equals what went to debt plus what went to savings", () => {
    const sch = payoffSchedule(REAL, 2264.5, FROM, PAY_DAYS, SAVINGS_SPLIT);
    for (const e of sch) expect(e.total).toBeCloseTo(e.toDebt + e.toSavings, 6);
  });
});

// ── autopays: a debt-linked bill pays its own debt first ─────────────────────
//
// Added 2026-11-01. Every figure below is MADE UP: the repo is public.
//
// planMath adds a debt-linked bill's dollars back into firepower, and the schedule
// used to send all of firepower down the attack order. So a loan whose bill the bank
// pulls by itself was shown paid off on the wrong payday, and the debt at the top of
// the order was shown getting money that really went to the loan. Now each payday
// pays the autopays to their own debts first, out of the same money, and snowballs
// the rest. They never add money.
describe("autopays pay their own debt first", () => {
  // Jan 5: the first payday is Jan 15, the second Jan 31.
  const NOW = new Date(2027, 0, 5, 12);
  // Card A first in the order and charging interest; Loan B second, at 0%.
  const FX = [debt("Card A", 1000, 24), debt("Loan B", 300, 0)];
  // $100/mo on Loan B: $50 a payday.
  const AUTO_B: Autopay[] = [{ debtId: "Loan B", perPay: 50 }];

  it("default to none: no autopays is exactly the schedule it always was", () => {
    const plain = payoffSchedule(FX, 600, NOW);
    expect(plain).toEqual(payoffSchedule(FX, 600, NOW, PAY_DAYS, undefined, 0, []));
    // And nothing carries an `auto` key, so every caller written before sees no change.
    for (const e of plain) for (const p of e.payments) expect("auto" in p).toBe(false);
  });

  it("pays the autopay to its own debt, then the rest down the order, one payment per debt", () => {
    const sch = payoffSchedule(FX, 400, NOW, PAY_DAYS, undefined, 0, AUTO_B);
    // Payday 1: $200 to send. $50 to Loan B by its autopay, the other $150 to Card A.
    const first = sch[0];
    expect(first.payments).toHaveLength(2);
    const a = first.payments.find((p) => p.debtId === "Card A")!;
    const b = first.payments.find((p) => p.debtId === "Loan B")!;
    expect(b.amount).toBeCloseTo(50, 6);
    expect(b.auto).toBeCloseTo(50, 6);
    expect(a.amount).toBeCloseTo(150, 6);
    expect(a.auto).toBeUndefined();
    // In the attack order, whatever order the passes ran in.
    expect(first.payments.map((p) => p.debtId)).toEqual(["Card A", "Loan B"]);
    // Never two payments to one debt on one payday, including the paydays where Loan B
    // gets its autopay AND the snowball's leftover once Card A is gone. A bigger loan, so
    // it is still open when the card clears.
    const longer = payoffSchedule([FX[0], debt("Loan B", 900, 0)], 400, NOW, PAY_DAYS, undefined, 0, AUTO_B);
    for (const e of [...sch, ...longer]) {
      const ids = e.payments.map((p) => p.debtId);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const merged = longer.flatMap((e) => e.payments).find((p) => p.debtId === "Loan B" && p.amount > (p.auto ?? 0) + 0.005);
    expect(merged, "no payday merged an autopay with snowball money").toBeDefined();
    expect(merged!.auto).toBeCloseTo(50, 6);
  });

  it("stops after its last date", () => {
    const ending: Autopay[] = [{ debtId: "Loan B", perPay: 50, endsOn: "2027-01-20" }];
    const sch = payoffSchedule(FX, 400, NOW, PAY_DAYS, undefined, 0, ending);
    // Jan 15 is inside the window, Jan 31 is past it.
    expect(sch[0].payments.find((p) => p.debtId === "Loan B")?.auto).toBeCloseTo(50, 6);
    expect(sch[1].payments.some((p) => p.auto !== undefined)).toBe(false);
    // With Card A still open, the whole of Jan 31's money goes to it.
    expect(sch[1].payments.map((p) => p.debtId)).toEqual(["Card A"]);
  });

  it("never adds money: a $100/mo autopay on $60/mo of firepower sends $30, all to its debt", () => {
    const sch = payoffSchedule(FX, 60, NOW, PAY_DAYS, undefined, 0, [{ debtId: "Loan B", perPay: 50 }]);
    expect(sch[0].toDebt).toBeCloseTo(30, 6);
    expect(sch[0].payments).toHaveLength(1);
    expect(sch[0].payments[0].debtId).toBe("Loan B");
    expect(sch[0].payments[0].amount).toBeCloseTo(30, 6);
    expect(sch[0].payments[0].auto).toBeCloseTo(30, 6);
  });

  it("still accounts for every dollar as principal or interest", () => {
    const sch = payoffSchedule(FX, 400, NOW, PAY_DAYS, SAVINGS_SPLIT, 0, AUTO_B);
    expect(payoffClears(sch)).toBe(true);
    const principal = FX.reduce((s, d) => s + d.balance, 0);
    const interest = sch.reduce((s, e) => s + e.interest, 0);
    const paid = sch.reduce((s, e) => s + e.toDebt, 0);
    expect(paid).toBeCloseTo(principal + interest, 2);
    // And each payday's payments add up to what it sent at the debt.
    for (const e of sch) expect(e.payments.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(e.toDebt, 6);
  });
});

describe("minFirepowerToClear is the edge of having a date", () => {
  const NOW = new Date(2027, 0, 5, 12);
  // A card whose interest outruns a small payment, and a 0% loan with its own autopay.
  const FX = [debt("Card A", 5000, 29.99), debt("Loan B", 400, 0)];
  const AUTO_B: Autopay[] = [{ debtId: "Loan B", perPay: 40 }];
  const clears = (f: number) => payoffClears(payoffSchedule(FX, f, NOW, PAY_DAYS, SAVINGS_SPLIT, 0, AUTO_B));

  it("clears at F and does not at F − $1, nor one cent below F", () => {
    const f = minFirepowerToClear(FX, NOW, PAY_DAYS, SAVINGS_SPLIT, AUTO_B);
    expect(f).toBeGreaterThan(0);
    // To the cent.
    expect(Math.abs(f * 100 - Math.round(f * 100))).toBeLessThan(1e-6);
    expect(clears(f)).toBe(true);
    expect(clears(f - 1)).toBe(false);
    expect(clears(Math.round((f - 0.01) * 100) / 100)).toBe(false);
  });

  it("is 0 when nothing open is owed", () => {
    expect(minFirepowerToClear([], NOW)).toBe(0);
    expect(minFirepowerToClear([debt("Card A", 0, 24)], NOW)).toBe(0);
    expect(minFirepowerToClear([{ ...debt("Card A", 800, 24), closedAt: "2026-12-01T00:00:00Z" } as Debt], NOW)).toBe(0);
  });
});

describe("autopaysOf keeps exactly the live bills that pay a debt", () => {
  const rec = (id: string, over: Partial<Recurring> = {}): Recurring =>
    ({
      id,
      name: `Bill ${id}`,
      amount: 80,
      direction: "out",
      cadence: "monthly",
      active: true,
      linkedDebtId: "Loan B",
      createdAt: "2027-01-01T00:00:00Z",
      ...over,
    }) as Recurring;
  const ON = "2027-03-10";

  it("drops inactive, incoming, unlinked, ended and not-yet-started rows", () => {
    const rows = [
      rec("keep"),
      rec("off", { active: false }),
      rec("in", { direction: "in" }),
      rec("unlinked", { linkedDebtId: undefined }),
      rec("ended", { endsOn: "2027-03-09" }),
      rec("later", { startsOn: "2027-03-11" }),
    ];
    expect(autopaysOf(rows, ON)).toEqual([{ debtId: "Loan B", perPay: 40, endsOn: null }]);
  });

  it("carries endsOn, and pays half the monthly amount each payday whatever the cadence", () => {
    const rows = [
      rec("last", { endsOn: "2027-06-30" }),
      rec("twice", { amount: 25, cadence: "semimonthly", linkedDebtId: "Card A" }),
    ];
    expect(autopaysOf(rows, ON)).toEqual([
      { debtId: "Loan B", perPay: 40, endsOn: "2027-06-30" },
      { debtId: "Card A", perPay: 25, endsOn: null },
    ]);
  });
});

describe("shiftMonthKey", () => {
  it("wraps the year both ways", () => {
    expect(shiftMonthKey("2027-12", 1)).toBe("2028-01");
    expect(shiftMonthKey("2027-01", -1)).toBe("2026-12");
    expect(shiftMonthKey("2027-01", -13)).toBe("2025-12");
    expect(shiftMonthKey("2027-05", 0)).toBe("2027-05");
    expect(shiftMonthKey("2027-05", 24)).toBe("2029-05");
  });
});
