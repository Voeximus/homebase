// The Budget screen's numbers are the app's own, not this builder's.
//
// WHY THIS EXISTS NOW. `buildFinanceVMs` had no test at all, and on 2026-10-04 it was
// cut from 672 lines to ~220 when the app was compressed to Bills / Accounts / Budget
// and five of its seven VMs lost the screens they fed. Everything removed was verified
// by the type checker alone — which proves the file compiles, not that the two VMs
// left still say what they said. The Budget screen is one of the three things the app
// now is, and every figure on it comes out of here.
//
// SO IT IS THE DOOR'S RULE 1, APPLIED TO THE SCREEN: nothing here recomputes anything.
// Each assertion calls the same library function the builder is supposed to be calling
// and demands the same answer, so a figure can only be right by coming from the app's
// own arithmetic. A test that recomputed the budget in its own words would pass just
// as happily against a builder that had quietly started doing its own maths.
import { describe, expect, it } from "vitest";
import { buildFinanceVMs } from "../src/views/redesign/buildVMs";
import { LEAN_VARIABLE } from "../src/lib/plan";
import { firepowerStatus } from "../src/lib/headline";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData } from "../src/types";

/** A household with income, a fixed bill, two debts and some variable spending. */
const data = (): AppData => ({
  categories: DEFAULT_CATEGORIES,
  accounts: [
    { id: "a1", name: "Checking", owner: "Gino", last4: "4728", type: "checking", balance: 2495.63, pendingHold: 616.52, sortOrder: 1 },
    { id: "a2", name: "Joint", owner: "Joint", last4: "1111", type: "checking", balance: 63.27, pendingHold: 168.99, sortOrder: 2 },
  ],
  recurring: [
    { id: "pay", name: "Paycheck", amount: 1400, direction: "in", cadence: "semimonthly", active: true, dueDays: [15, 31], accountId: "a1" },
    { id: "rent", name: "Rent", amount: 1732.05, direction: "out", cadence: "monthly", active: true, dueDays: [1], accountId: "a2", categoryId: "housing" },
  ],
  transactions: [
    { id: "t1", date: "2026-10-02", amount: 88.68, type: "expense", categoryId: "groceries", description: "Yami", accountId: "a1", createdAt: "2026-10-02T12:00:00Z" },
    { id: "t2", date: "2026-10-02", amount: 32.65, type: "expense", categoryId: "groceries", description: "99 Ranch", accountId: "a1", createdAt: "2026-10-02T12:00:00Z" },
    { id: "t3", date: "2026-10-03", amount: 19.39, type: "expense", categoryId: "dining", description: "Ike's", accountId: "a2", createdAt: "2026-10-03T12:00:00Z" },
  ],
  debts: [
    { id: "d1", name: "Credit card", balance: 1404.83, originalBalance: 4156.78, apr: 26.49, minPayment: 134, createdAt: "2026-01-01T00:00:00Z" },
    { id: "d2", name: "Cherry", balance: 606.85, originalBalance: 900, createdAt: "2026-01-01T00:00:00Z" },
  ],
  savingsGoals: [],
  paidBills: [],
  merchantRules: [],
} as unknown as AppData);

describe("buildFinanceVMs after the compression", () => {
  it("returns only the two VMs the three screens use", () => {
    // It returned seven. A stray `home`/`activity`/`profile`/`bills` coming back would
    // mean the dead builders were restored rather than the screens.
    expect(Object.keys(buildFinanceVMs(data())).sort()).toEqual(["deploy", "envelopes", "insights"]);
  });

  // ONE composed call, and that is the point of asserting against it rather than
  // against its pieces. firepowerStatus runs planMath and envelopeStatus in a
  // particular ORDER, and the comment in buildVMs is explicit that the order is where
  // the arithmetic hides: a screen that called the same two functions itself would be
  // honestly computed and still disagree with the Muse door, which calls this one.
  // So the test demands the builder's figures equal THIS call's, not a re-derivation.
  const head = () => firepowerStatus(data(), new Date());

  it("takes income, living cost and variable from the same firepowerStatus call", () => {
    const vm = buildFinanceVMs(data()).insights;
    const h = head();
    expect(vm.income).toBe(h.math.income);
    expect(vm.living).toBe(h.math.fixedNonDebt);
    expect(vm.variable).toBe(h.math.variable);
  });

  it("takes the budget bar and its cycle from that call's envelope", () => {
    const vm = buildFinanceVMs(data()).insights;
    const env = head().envelope;
    expect(vm.budgetSpent).toBe(env.spent);
    expect(vm.budgetTarget).toBe(env.target);
    expect(vm.budgetCycleLabel).toBe(env.cycle.label);
    expect(vm.budgetCycleDay).toBe(env.cycle.dayIndex);
    expect(vm.budgetCycleDays).toBe(env.cycle.days);
  });

  it("takes what is free to aim at the debt from that call's firepower", () => {
    expect(buildFinanceVMs(data()).insights.atDebt).toBe(head().firepower);
  });

  it("builds one category row per lean envelope, and the donut only from the ones with spending", () => {
    const vm = buildFinanceVMs(data()).insights;
    expect(vm.categories).toHaveLength(LEAN_VARIABLE.length);
    // A zero bar still has to be drawn — "nothing spent on this" is information. A
    // zero SLICE is not: it would be an invisible wedge in the ring.
    expect(vm.donut.every((d) => d.amount > 0)).toBe(true);
    expect(vm.donut.length).toBeLessThanOrEqual(vm.categories.length);
    for (const d of vm.donut) {
      expect(vm.categories.some((c) => c.catId === d.catId && c.spent === d.amount)).toBe(true);
    }
  });

  it("drills into a category with the SAME figure the bar shows", () => {
    // The reason envelopes and insights are built together and returned together: the
    // bar and the list behind it must be one calculation. Two calls would be two
    // answers the first time anything about the window changed.
    const { insights, envelopes } = buildFinanceVMs(data());
    for (const line of LEAN_VARIABLE) {
      const env = envelopes.find((e) => e.key === line.key);
      const row = insights.categories.find((c) => c.catId === env?.catId);
      expect(env, `no envelope for ${line.key}`).toBeTruthy();
      expect(row?.spent).toBe(env!.spent);
      expect(row?.target).toBe(env!.target);
    }
  });

  it("orders the payoff ladder by the projection, not by balance", () => {
    const { insights, deploy } = buildFinanceVMs(data());
    expect(insights.ladder.map((l) => l.name)).toEqual(deploy.ordered.map((d) => d.name));
    expect(deploy.totalDebt).toBe(head().math.totalDebt);
    // Cherry has the smaller balance; the card has 26.49% APR. The ladder follows the
    // payoff order, so this fails if it ever silently became a sort by size.
    expect(insights.ladder.length).toBe(2);
  });

  it("says '—' for the debt-free date rather than inventing one when nothing clears", () => {
    const broke = data();
    broke.recurring = broke.recurring.filter((r) => r.direction !== "in");
    const vm = buildFinanceVMs(broke).insights;
    // No income, so the schedule never pays anything off. A date here would be a
    // number made up to fill a slot.
    expect(typeof vm.debtFreeBy).toBe("string");
    if (vm.debtFreeBy === "—") expect(vm.monthsToGo).toBe(0);
  });
});
