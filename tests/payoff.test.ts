import { describe, it, expect } from "vitest";
import { payoffSchedule, payoffClears, PAY_DAYS, SAVINGS_SPLIT } from "../src/lib/plan";
import type { Debt } from "../src/types";

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
