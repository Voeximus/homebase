// A budget goal for ONE pay cycle — the shared rules (src/lib/cycleBudget.ts), the
// envelope the screens draw from (src/lib/headline.ts), and the screen's own view-model.
//
// Added 2026-10-10 with public.cycle_budgets. Every figure below is MADE UP: the repo is
// public, and a household's real goal must never be typed into it. The standard budget's
// per-line figures are read off LEAN_VARIABLE rather than written here, so these tests
// follow the plan if it is ever re-based.
//
// The instants are local (the suite runs in America/Phoenix — see vitest.config.ts), and
// the paydays are the app's own: the 15th and the last day of the month.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppData, CycleBudget, Transaction } from "../src/types";
import {
  BUDGET_LINE_KEYS,
  cycleInProgress,
  cycleOpeningOn,
  cycleTargets,
  goalCycleProblem,
  goalCycles,
  goalFor,
  goalsAhead,
  GOAL_CYCLES_AHEAD,
  GOAL_CYCLES_BACK,
} from "../src/lib/cycleBudget";
import { LEAN_VARIABLE, lineSpent, payCycleFor, perCycle, sumTargets } from "../src/lib/plan";
import { envelopeStatus, firepowerStatus } from "../src/lib/headline";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import { buildFinanceVMs } from "../src/views/redesign/buildVMs";
import { barPct } from "../src/views/redesign/barPct";
import { InsightsTab } from "../src/views/redesign/InsightsTab";
import { HomeTab } from "../src/views/redesign/HomeTab";
import { CategorySheet } from "../src/views/redesign/CategorySheet";

/** 10 Oct, 7 PM — the cycle in progress opened on 30 Sep and runs to 14 Oct. */
const OCT_10 = new Date(2026, 9, 10, 19, 0, 0);

const standard = (key: string) => perCycle(LEAN_VARIABLE.find((l) => l.key === key)!.target);

let seq = 0;
const goal = (cycleStart: string, line: string, amount: number): CycleBudget => ({
  id: `g${++seq}`,
  cycleStart,
  line,
  amount,
  setBy: "gino",
});

const txn = (date: string, amount: number, categoryId = "groceries"): Transaction => ({
  id: `t-${date}-${amount}-${categoryId}-${++seq}`,
  date,
  amount,
  type: "expense",
  categoryId,
  description: "Store",
  createdAt: `${date}T12:00:00Z`,
});

// ── which cycles a goal can be for ───────────────────────────────────────────

describe("a goal belongs to a real pay cycle, by its first day", () => {
  it("knows a cycle's first day the way payCycleFor does, and nothing else", () => {
    expect(cycleOpeningOn("2026-10-15")).toEqual({ start: "2026-10-15", end: "2026-10-30", label: payCycleFor(new Date(2026, 9, 15)).label });
    expect(cycleOpeningOn("2026-09-30")?.end).toBe("2026-10-14");
    expect(cycleOpeningOn("2026-10-31")?.end).toBe("2026-11-14");
    // A short February: the month-end payday is the 28th.
    expect(cycleOpeningOn("2027-02-28")?.end).toBe("2027-03-14");
    // Not a first day — a goal filed here would match no cycle and look set.
    expect(cycleOpeningOn("2026-10-16")).toBeNull();
    expect(cycleOpeningOn("2026-10-30")).toBeNull();
    // Not a day at all. 2027-02-31 would roll into March if it were trusted.
    expect(cycleOpeningOn("2027-02-31")).toBeNull();
    expect(cycleOpeningOn("2026-13-01")).toBeNull();
    expect(cycleOpeningOn("tomorrow")).toBeNull();
  });

  it("offers one cycle back, the one in progress, and two ahead — across a month end", () => {
    const starts = goalCycles(OCT_10).map((c) => c.start);
    expect(starts).toEqual(["2026-09-15", "2026-09-30", "2026-10-15", "2026-10-31"]);
    expect(starts).toHaveLength(GOAL_CYCLES_BACK + 1 + GOAL_CYCLES_AHEAD);
    expect(cycleInProgress(OCT_10)).toEqual({ start: "2026-09-30", end: "2026-10-14", label: payCycleFor(OCT_10).label });
    // Every offered cycle runs straight into the next one: no day falls between two.
    const cs = goalCycles(OCT_10);
    for (let i = 1; i < cs.length; i++) {
      const dayAfter = new Date(`${cs[i - 1].end}T12:00:00`);
      dayAfter.setDate(dayAfter.getDate() + 1);
      expect(cs[i].start).toBe(payCycleFor(dayAfter).start);
    }
  });

  it("walks from the Arizona evening it is given, not from the next day", () => {
    // 14 Oct at 9 PM is still the cycle that opened on 30 Sep. A UTC runtime would
    // already be on the 15th, and would offer a different set of cycles.
    expect(goalCycles(new Date(2026, 9, 14, 21, 0, 0))[GOAL_CYCLES_BACK].start).toBe("2026-09-30");
    expect(goalCycles(new Date(2026, 9, 15, 0, 30, 0))[GOAL_CYCLES_BACK].start).toBe("2026-10-15");
  });

  it("says why a cycle cannot be set, and always names the ones that can", () => {
    expect(goalCycleProblem("2026-10-15", OCT_10)).toBeNull();
    expect(goalCycleProblem("2026-09-15", OCT_10)).toBeNull();
    const offered = "2026-09-15, 2026-09-30, 2026-10-15, 2026-10-31";

    const notStart = goalCycleProblem("2026-10-16", OCT_10)!;
    expect(notStart).toContain("not the first day of a pay cycle");
    expect(notStart).toContain(offered);

    const tooOld = goalCycleProblem("2026-08-31", OCT_10)!;
    expect(tooOld).toContain("more than 1 cycle back");
    expect(tooOld).toContain(offered);

    const tooFar = goalCycleProblem("2026-11-15", OCT_10)!;
    expect(tooFar).toContain("more than 2 cycles ahead");
    expect(tooFar).toContain(offered);
  });
});

// ── what a cycle's targets are ───────────────────────────────────────────────

describe("cycleTargets: the goal where one is set, the standard budget everywhere else", () => {
  it("with no goal, is the standard budget — the total spelled exactly as before", () => {
    const t = cycleTargets("2026-09-30", []);
    expect(t.from).toBe("standard");
    // Not a sum of six shares: the same expression the envelope always used, so nothing
    // moves by a float's rounding on the day goals arrived.
    expect(t.total).toBe(perCycle(sumTargets(LEAN_VARIABLE)));
    for (const l of t.lines) {
      expect(l.from, l.key).toBe("standard");
      expect(l.target, l.key).toBe(standard(l.key));
    }
    expect(t.lines.map((l) => l.key)).toEqual(BUDGET_LINE_KEYS);
  });

  it("takes a goal line as a CYCLE figure — never halved — and keeps the rest standard", () => {
    const t = cycleTargets("2026-09-30", [goal("2026-09-30", "groceries", 123.45), goal("2026-09-30", "pets", 0)]);
    expect(t.from).toBe("mixed");
    const by = new Map(t.lines.map((l) => [l.key, l]));
    expect(by.get("groceries")).toMatchObject({ target: 123.45, from: "goal" });
    // Zero is a real goal ("nothing on this line this cycle"), not a missing one.
    expect(by.get("pets")).toMatchObject({ target: 0, from: "goal" });
    expect(by.get("dining")).toMatchObject({ target: standard("dining"), from: "standard" });
    const others = LEAN_VARIABLE.filter((l) => l.key !== "groceries" && l.key !== "pets").reduce((s, l) => s + perCycle(l.target), 0);
    expect(t.total).toBe(Math.round((123.45 + others) * 100) / 100);
  });

  it("says 'goal' only when every line has one, and totals them to the cent", () => {
    const amounts = [101.11, 22.22, 33.33, 44.44, 5.55, 6.66];
    const goals = BUDGET_LINE_KEYS.map((k, i) => goal("2026-10-15", k, amounts[i]));
    const t = cycleTargets("2026-10-15", goals);
    expect(t.from).toBe("goal");
    expect(t.total).toBe(213.31);
    expect(t.lines.map((l) => l.target)).toEqual(amounts);
  });

  it("leaves out a row for another cycle, an unknown line, or an amount that is not dollars", () => {
    const goals = [
      goal("2026-10-15", "groceries", 1), // a different cycle
      goal("2026-09-30", "vacation", 50), // no such line
      { ...goal("2026-09-30", "dining", 0), amount: Number.NaN }, // nothing anybody wrote
      goal("2026-09-30", "gas", -5), // a negative target means nothing
    ];
    expect(goalFor("2026-09-30", goals).size).toBe(0);
    expect(cycleTargets("2026-09-30", goals)).toEqual(cycleTargets("2026-09-30", []));
  });

  it("lists the goals already set for the cycles ahead, and not the cycle in progress", () => {
    const goals = [goal("2026-09-30", "dining", 40), goal("2026-10-15", "groceries", 90), goal("2026-10-15", "misc", 10)];
    const ahead = goalsAhead(OCT_10, goals);
    expect(ahead.map((c) => c.start)).toEqual(["2026-10-15"]);
    expect(ahead[0].end).toBe("2026-10-30");
    expect(ahead[0].targets.from).toBe("mixed");
    expect(goalsAhead(OCT_10, [])).toEqual([]);
  });
});

// ── the envelope the screens are drawn from ──────────────────────────────────

describe("envelopeStatus and firepowerStatus grade the cycle against its goal", () => {
  // Mid-cycle on 20 Sep: the cycle opened on the 15th.
  const NOW = new Date(2026, 8, 20, 19, 0, 0);
  const LEDGER = [txn("2026-09-16", 206.09), txn("2026-09-18", 61.4, "dining"), txn("2026-09-19", 18.5, "pets")];
  const GOALS = [goal("2026-09-15", "groceries", 175), goal("2026-09-15", "dining", 40)];

  it("uses the goal per line and in the envelope total, and says where each came from", () => {
    const plain = envelopeStatus(LEDGER, NOW);
    const got = envelopeStatus(LEDGER, NOW, LEAN_VARIABLE, GOALS);
    expect(got.cycle).toEqual(plain.cycle);
    expect(got.spent).toBe(plain.spent);
    expect(got.byCat).toEqual(plain.byCat);
    expect(got.targetsFrom).toBe("mixed");
    expect(got.target).toBe(cycleTargets("2026-09-15", GOALS).total);
    const by = new Map(got.lines.map((l) => [l.key, l]));
    expect(by.get("groceries")).toMatchObject({ target: 175, from: "goal", spent: 206.09 });
    expect(by.get("dining")).toMatchObject({ target: 40, from: "goal" });
    expect(by.get("pets")).toMatchObject({ target: standard("pets"), from: "standard" });
    for (const l of LEAN_VARIABLE) expect(by.get(l.key)!.spent, l.key).toBe(lineSpent(l, got.byCat));
    // The MONTHLY figure never moves: the debt maths is monthly and a goal is one cycle.
    expect(got.monthlyTarget).toBe(sumTargets(LEAN_VARIABLE));
  });

  it("ignores a goal set for another cycle", () => {
    const later = [goal("2026-09-30", "groceries", 1)];
    expect(envelopeStatus(LEDGER, NOW, LEAN_VARIABLE, later)).toEqual(envelopeStatus(LEDGER, NOW));
    expect(envelopeStatus(LEDGER, NOW).targetsFrom).toBe("standard");
  });

  it("firepower reads the goal from the data for the cycle's 'over by', and leaves every monthly figure alone", () => {
    const base: AppData = {
      transactions: LEDGER,
      debts: [],
      goals: [],
      categories: DEFAULT_CATEGORIES,
      accounts: [],
      recurring: [],
      paidBills: [],
      merchantRules: [],
      foods: [],
    };
    // A goal on every line, tighter than what this cycle has already spent.
    const tight = BUDGET_LINE_KEYS.map((k) => goal("2026-09-15", k, k === "groceries" ? 175 : 10));
    const without = firepowerStatus(base, NOW);
    const withGoal = firepowerStatus({ ...base, cycleBudgets: tight }, NOW);
    expect(withGoal.envelope.target).toBe(cycleTargets("2026-09-15", tight).total);
    expect(withGoal.envelope.targetsFrom).toBe("goal");
    expect(withGoal.overspendThisCycle).toBe(Math.max(0, withGoal.envelope.spent - withGoal.envelope.target));
    // Under the standard budget this cycle is not over; against the tighter goal it is.
    expect(without.overspendThisCycle).toBe(0);
    expect(withGoal.overspendThisCycle).toBeGreaterThan(0);
    // Monthly: unchanged, goal or no goal.
    expect(withGoal.monthlyTarget).toBe(without.monthlyTarget);
    expect(withGoal.math).toEqual(without.math);
    expect(withGoal.overspendThisMonth).toBe(without.overspendThisMonth);
    expect(withGoal.firepower).toBe(without.firepower);
  });
});

// ── the screen ───────────────────────────────────────────────────────────────

describe("the budget screen's numbers come from the goal, and nothing else about it changes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Built once, so the two view-models below are drawn from the very same rows.
  const ROWS = [txn("2026-10-16", 80), txn("2026-10-17", 25, "dining")];
  const data = (cycleBudgets?: CycleBudget[], transactions: Transaction[] = ROWS): AppData => ({
    transactions,
    debts: [],
    goals: [],
    categories: DEFAULT_CATEGORIES,
    accounts: [],
    recurring: [],
    paidBills: [],
    merchantRules: [],
    foods: [],
    ...(cycleBudgets ? { cycleBudgets } : {}),
  });

  it("draws each bar, the envelope and the insights against this cycle's goal", () => {
    vi.useFakeTimers();
    // Noon on 20 Oct in Arizona: the cycle that opened on the 15th.
    vi.setSystemTime(new Date("2026-10-20T19:00:00Z"));
    const goals = [goal("2026-10-15", "groceries", 70), goal("2026-10-15", "dining", 30)];
    const plain = buildFinanceVMs(data(), "gino", "all", { email: "someone@example.test", lang: "en" });
    const vms = buildFinanceVMs(data(goals), "gino", "all", { email: "someone@example.test", lang: "en" });

    const env = new Map(vms.envelopes.map((e) => [e.key, e]));
    expect(env.get("groceries")!.target).toBe(70);
    expect(env.get("dining")!.target).toBe(30);
    expect(env.get("pets")!.target).toBe(standard("pets"));
    const total = cycleTargets("2026-10-15", goals).total;
    expect(vms.home.budgetTarget).toBe(total);
    expect(vms.insights.budgetTarget).toBe(total);
    expect(vms.insights.categories.find((c) => c.catId === "groceries")!.target).toBe(70);
    // Groceries spent 80 against a goal of 70: the bar's "over by" is the goal's.
    expect(vms.home.overspent).toBe(Math.max(0, vms.home.budgetSpent - total));

    // Without the goal, the same screen shows the standard budget, exactly as before.
    expect(plain.home.budgetTarget).toBe(perCycle(sumTargets(LEAN_VARIABLE)));
    expect(new Map(plain.envelopes.map((e) => [e.key, e])).get("groceries")!.target).toBe(standard("groceries"));
    // And nothing but the targets moved: same rows, same spend, same cycle, same shape.
    expect(vms.envelopes.map((e) => ({ ...e, target: 0 }))).toEqual(plain.envelopes.map((e) => ({ ...e, target: 0 })));
    expect(vms.home.budgetSpent).toBe(plain.home.budgetSpent);
    expect(vms.home.budgetCycleLabel).toBe(plain.home.budgetCycleLabel);
    expect(Object.keys(vms.home).sort()).toEqual(Object.keys(plain.home).sort());
    expect(vms.home.firepower).toBe(plain.home.firepower);
  });

  // Every bar's inline width in a rendered screen, as the text the browser would read.
  // A width the browser cannot parse ("NaN%", "Infinity%") is thrown away, and the bar
  // then falls back to its full default width — a line drawn fully used.
  const widths = (html: string) => [...html.matchAll(/width:([^;"]*)%/g)].map((m) => m[1]);
  const allFinite = (ws: string[]) => ws.every((w) => Number.isFinite(Number(w)));
  const VM_OPTS = { email: "someone@example.test", lang: "en" } as const;
  const petsCat = LEAN_VARIABLE.find((l) => l.key === "pets")!.cats[0];

  it("a line whose goal is 0 draws an empty bar, never a NaN width (2026-10-10)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T19:00:00Z"));
    // A cycle that sets one line to 0 and spends nothing on it — a real choice, and the
    // first goal this feature is for. Before that day no target could be 0, so the
    // Insights row divided by it bare: 0 / 0, "NaN%", a full-width bar.
    const vms = buildFinanceVMs(data([goal("2026-10-15", "pets", 0)]), "gino", "all", VM_OPTS);
    const pets = vms.insights.categories.find((c) => c.catId === petsCat)!;
    expect(pets).toMatchObject({ target: 0, spent: 0 });

    const insights = renderToStaticMarkup(createElement(InsightsTab, { vm: vms.insights }));
    const ws = widths(insights);
    expect(ws.length).toBeGreaterThanOrEqual(LEAN_VARIABLE.length);
    expect(allFinite(ws), `Insights widths: ${ws.join(", ")}`).toBe(true);

    // The drill-in for the same line agrees: an empty bar.
    const env = vms.envelopes.find((e) => e.key === "pets")!;
    const sheet = renderToStaticMarkup(createElement(CategorySheet, { vm: env, open: true, onClose: () => {} }));
    expect(allFinite(widths(sheet))).toBe(true);
    expect(barPct(env.spent, env.target)).toBe(0);
  });

  it("a cycle whose whole goal is 0, with nothing spent, draws the Home bar empty (2026-10-10)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T19:00:00Z"));
    const zeros = LEAN_VARIABLE.map((l) => goal("2026-10-15", l.key, 0));
    const vms = buildFinanceVMs(data(zeros, []), "gino", "all", VM_OPTS);
    expect(vms.home.budgetTarget).toBe(0);
    expect(vms.home.budgetSpent).toBe(0);

    const home = renderToStaticMarkup(createElement(HomeTab, { vm: vms.home }));
    const ws = widths(home);
    expect(ws.length).toBeGreaterThan(0);
    expect(allFinite(ws), `Home widths: ${ws.join(", ")}`).toBe(true);
    const insights = renderToStaticMarkup(createElement(InsightsTab, { vm: vms.insights }));
    expect(allFinite(widths(insights))).toBe(true);
  });

  it("a 0 goal that was spent against reads as a full, over bar — the same on every bar", () => {
    // Spent against a 0 goal: every dollar is over, so the bar is full (and the caller
    // colours it as over, because spent > target). The Insights row, the Home bar and
    // the drill-in all take this one rule, so the same line can never read full on one
    // screen and empty on another.
    expect(barPct(12, 0)).toBe(100);
    expect(barPct(0, 0)).toBe(0);
    expect(barPct(0, 40)).toBe(0);
    expect(barPct(10, 40)).toBe(25);
    expect(barPct(90, 40)).toBe(100);
  });
});

// ── the rules that keep it honest ────────────────────────────────────────────

describe("one list of lines, and no clock", () => {
  it("the migration's line check names exactly the plan's six lines", () => {
    // If a line is added to or renamed in LEAN_VARIABLE, the table would refuse a goal
    // for it — or keep one for a line nothing grades. This fails until both move together.
    const sql = readFileSync("supabase/schema_v45_cycle_budgets.sql", "utf8");
    const m = /check \(line in \(([^)]*)\)\)/.exec(sql);
    expect(m, "the line check is not in the migration").not.toBeNull();
    const inSql = [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    expect(inSql).toEqual([...BUDGET_LINE_KEYS].sort());
  });

  it("reads no clock of its own", () => {
    const src = readFileSync("src/lib/cycleBudget.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    // A Date built from a calendar date's own parts is not a clock; one built from
    // nothing, Date.now() and todayISO() are.
    expect(code).not.toMatch(/new Date\(\)|Date\.now\(|todayISO\(/);
  });

  it("is on the generator's list, so the doors answer from the same file", () => {
    expect(readFileSync("scripts/gen-muse-shared.mjs", "utf8")).toContain('"src/lib/cycleBudget.ts"');
    expect(readFileSync("supabase/functions/_shared/muse/lib/cycleBudget.ts", "utf8")).toContain("GENERATED — DO NOT EDIT");
  });
});
