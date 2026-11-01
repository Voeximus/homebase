// The payoff on screen: Home's Payoff tile, the Insights card and the attack ladder all
// read ONE plan (payoffPlan in src/lib/headline.ts), and the lens never changes it.
//
// Added 2026-11-01. Every figure and name below is MADE UP: the repo is public.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AppData, Debt, Recurring, Transaction } from "../src/types";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import { buildFinanceVMs } from "../src/views/redesign/buildVMs";
import { payoffPlan } from "../src/lib/headline";

let seq = 0;
const tx = (date: string, amount: number, categoryId: string, accountId: string): Transaction => ({
  id: `pv${String(++seq).padStart(3, "0")}`,
  date,
  amount,
  type: "expense",
  categoryId,
  description: "Corner Market",
  accountId,
  createdAt: `${date}T12:00:00Z`,
});
const acct = (id: string, owner: Account["owner"]): Account => ({
  id,
  name: `Sample ${id}`,
  owner,
  type: "checking",
  balance: 500,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
});
const row = (id: string, name: string, amount: number, over: Partial<Recurring> = {}): Recurring =>
  ({
    id,
    name,
    amount,
    direction: "out",
    cadence: "monthly",
    active: true,
    dueDays: [1],
    categoryId: "housing",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as Recurring;
const debt = (id: string, name: string, balance: number, apr: number): Debt =>
  ({ id, name, balance, originalBalance: balance + 500, apr, minPayment: 25, color: "#888888", createdAt: "2026-01-01T00:00:00Z" }) as Debt;

const DATA: AppData = {
  // Spending well over the budget in the three complete months before NOW, on both
  // people's accounts, so the over-budget line is up and the lens has rows to filter.
  transactions: [
    tx("2027-01-06", 1200, "groceries", "acct-g"),
    tx("2027-01-09", 900, "dining", "acct-x"),
    tx("2027-02-06", 1100, "groceries", "acct-g"),
    tx("2027-02-10", 800, "shopping", "acct-x"),
    tx("2027-03-04", 1300, "groceries", "acct-x"),
    tx("2027-03-08", 700, "dining", "acct-g"),
    tx("2027-04-03", 90, "groceries", "acct-g"),
  ],
  debts: [debt("dA", "Card A", 2400, 20), debt("dB", "Loan B", 600, 0)],
  goals: [],
  categories: DEFAULT_CATEGORIES,
  accounts: [acct("acct-g", "Gino"), acct("acct-x", "Xinyan"), acct("acct-j", "Joint")],
  recurring: [
    row("p1", "Paycheck", 2000, { direction: "in", cadence: "semimonthly", dueDays: [15, 31], categoryId: "salary" }),
    row("b1", "Rent", 1500),
    row("b2", "Loan B payment", 100, { dueDays: [20], categoryId: "bills", linkedDebtId: "dB" }),
  ],
  paidBills: [],
  merchantRules: [],
  foods: [],
};

const NOW = new Date(2027, 3, 8, 19, 0, 0); // 8 Apr 2027, an Arizona evening
const vmsFor = (owner: "gino" | "xinyan", lens: "all" | "me", lang: "en" | "zh" = "en") =>
  buildFinanceVMs(DATA, owner, lens, { email: "someone@example.test", lang });

describe("one payoff for every screen", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands Home and Insights the same payoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const vms = vmsFor("gino", "all");
    expect(vms.home.payoff).toEqual(vms.insights.payoff);
    expect(vms.home.payoff).toBe(vms.insights.payoff);
    // The fixture is in the state the screen leads with: a date, and the amber line up.
    expect(vms.home.payoff.kind).toBe("plan");
    if (vms.home.payoff.kind === "plan") expect(vms.home.payoff.overBy).toBeGreaterThan(0);
  });

  it("gives the attack ladder the plan's own schedule and the over-budget figures", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const vms = vmsFor("gino", "all");
    const plan = payoffPlan(DATA, NOW);
    expect(vms.deploy.schedule).toEqual(plan.schedule);
    expect([vms.deploy.pace, vms.deploy.target, vms.deploy.overBy]).toEqual([plan.pace, plan.target, plan.overBy]);
    const p = vms.home.payoff;
    expect(p.kind === "plan" && p.overBy).toBe(plan.overBy);
  });

  it("is the household's payoff in Mine as in All, on both phones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const all = vmsFor("gino", "all");
    for (const [owner, lens] of [["gino", "me"], ["xinyan", "me"], ["xinyan", "all"]] as const) {
      const v = vmsFor(owner, lens);
      expect(v.home.payoff, `${owner}/${lens}`).toEqual(all.home.payoff);
      expect(v.deploy.schedule, `${owner}/${lens}`).toEqual(all.deploy.schedule);
    }
  });

  it("keeps the ladder's amber line off when nothing is owed, as Home and Insights do", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const paidOff: AppData = { ...DATA, debts: DATA.debts.map((d) => ({ ...d, balance: 0 })) };
    const plan = payoffPlan(paidOff, NOW);
    expect(plan.kind).toBe("debtFree");
    expect(plan.overBy).toBeGreaterThan(0);
    const vms = buildFinanceVMs(paidOff, "gino", "all", { email: "someone@example.test", lang: "en" });
    expect(vms.home.payoff).toEqual({ kind: "debtFree" });
    expect(vms.deploy.overBy).toBe(0);
  });

  it("rounds a short plan's need UP to whole dollars, so it never reads $0/mo", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tight: AppData = {
      ...DATA,
      recurring: DATA.recurring.map((r) => (r.id === "b1" ? { ...r, amount: 3000 } : r)),
    };
    const plan = payoffPlan(tight, NOW);
    expect(plan.kind).toBe("short");
    const p = buildFinanceVMs(tight, "gino", "all", { email: "someone@example.test", lang: "en" }).home.payoff;
    expect(p.kind).toBe("short");
    if (p.kind === "short") {
      expect(Number.isInteger(p.shortBy)).toBe(true);
      expect(p.shortBy).toBeGreaterThanOrEqual(plan.shortBy);
      expect(p.shortBy - plan.shortBy).toBeLessThan(1);
      expect(p.overBy).toBe(plan.overBy);
    }
  });

  it("prints the month in Chinese when the phone is in Chinese, and nothing else moves", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const en = vmsFor("gino", "all").home.payoff;
    const zh = vmsFor("gino", "all", "zh").home.payoff;
    expect(en.kind).toBe("plan");
    expect(zh.kind).toBe("plan");
    if (en.kind === "plan" && zh.kind === "plan") {
      expect(en.date).toMatch(/^[A-Z][a-z]{2} '\d{2}$/);
      expect(zh.date).toMatch(/^\d{4}年\d{1,2}月$/);
      expect({ ...zh, date: en.date }).toEqual(en);
    }
  });
});
