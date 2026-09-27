// src/lib/headline.ts — the assembly a screen and the Muse read door share.
//
// WHY THIS FILE EXISTS. Some of the app's figures are not one function call but a
// SEQUENCE of them, and the sequence used to live inside a view module. The budget
// envelope was five calls in a particular order with a particular window, written
// out in src/views/redesign/buildVMs.ts; the read door needed the same number and
// held its own copy of those five lines; and tests/museSnapshot.test.ts wrote them a
// third time in order to check the door. Nothing tied the three together, so a change
// to how the screen grades the envelope would have changed the screen and left the
// door answering the old way — in a chat, where there is no screen beside the number
// to notice. That is the "$85 versus $100" failure cron-notify already had, arriving
// through the tool he would use most.
//
// Two claims are checked here, for each of the four assemblies the file now holds:
//   1. the extraction is FAITHFUL — it does the same calls in the same order and
//      returns the same numbers as doing them by hand;
//   2. both callers actually go through it, rather than keeping a copy.
//
// The four are the budget envelope, the firepower tile ("available this month"),
// "still due before payday", and the forward projection's options. The last two
// arrived with the three money questions he asks every pay cycle —
// finance.firepower, finance.next_bills and finance.forecast — which were declared
// and not built for exactly this reason: their inputs were assembled inside a screen.
//
// THE FIREPOWER AND FORECAST EXTRACTIONS ARE ALSO PINNED AGAINST THE REAL LEDGER, in
// tests/museSnapshot.test.ts, which is where "the numbers on screen did not change"
// is proved against data nobody designed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  billsBeforeNextPayday,
  envelopeStatus,
  FALLBACK_CYCLE_SPEND,
  firepowerStatus,
  forecastPlan,
  lowestPoint,
  monthGetter,
  runForecast,
} from "../src/lib/headline";
import {
  LEAN_VARIABLE,
  OUTSIDE_BUDGET_CASH_CATS,
  lineSpent,
  payCycleFor,
  planMath,
  perCycle,
  recentCycleSpend,
  spentByCategory,
  spentByCategoryBetween,
  sumTargets,
  typicalCycleSpend,
  variableSpentBetween,
  variableSpentThisMonth,
} from "../src/lib/plan";
import { dueBeforeNextPayday, monthCalendar } from "../src/lib/schedule";
import { forecast } from "../src/lib/forecast";
import { totalBalance } from "../src/lib/recurring";
import { isoDate, monthKeyOf } from "../src/lib/format";
import type { AppData, Transaction } from "../src/types";

const txn = (date: string, amount: number, categoryId = "groceries"): Transaction => ({
  id: `t-${date}-${amount}-${categoryId}`,
  date,
  amount,
  type: "expense",
  categoryId,
  description: "Store",
  createdAt: `${date}T12:00:00Z`,
});

// Mid-cycle, so the window has charges on both sides of it and a partial period is
// being graded — the case a month-shaped calculation gets wrong.
const NOW = new Date(2026, 8, 20, 19, 0, 0);

const LEDGER: Transaction[] = [
  txn("2026-09-16", 206.09),
  txn("2026-09-18", 61.4, "dining"),
  txn("2026-09-20", 42.0),
  txn("2026-09-22", 18.5, "pets"),
  // Outside the cycle on both sides, so a wrong window shows up as a wrong number.
  txn("2026-08-20", 500.0),
  txn("2026-10-05", 500.0),
  // Not graded against the envelope at all: electronics belongs to no line.
  txn("2026-09-19", 300.0, "electronics"),
  // A split fans across two lines, which is the case a per-line copy gets wrong.
  {
    ...txn("2026-09-21", 100.0),
    splits: [
      { categoryId: "groceries", amount: 70 },
      { categoryId: "pets", amount: 30 },
    ],
  },
];

describe("envelopeStatus is the sequence, not a new calculation", () => {
  it("returns exactly what the five calls return, in the same order", () => {
    const monthlyTarget = sumTargets(LEAN_VARIABLE);
    const cycle = payCycleFor(NOW);
    const target = perCycle(monthlyTarget);
    const spent = variableSpentBetween(LEDGER, cycle.start, cycle.end);
    const byCat = spentByCategoryBetween(LEDGER, cycle.start, cycle.end);

    const got = envelopeStatus(LEDGER, NOW);
    expect(got.monthlyTarget).toBe(monthlyTarget);
    expect(got.cycle).toEqual(cycle);
    expect(got.target).toBe(target);
    expect(got.spent).toBe(spent);
    expect(got.byCat).toEqual(byCat);
  });

  it("prices every line the way the bar does", () => {
    const { byCat, lines } = envelopeStatus(LEDGER, NOW);
    expect(lines).toHaveLength(LEAN_VARIABLE.length);
    for (const l of LEAN_VARIABLE) {
      const line = lines.find((x) => x.key === l.key)!;
      expect(line, l.key).toBeDefined();
      expect(line.target, l.key).toBe(perCycle(l.target));
      expect(line.spent, l.key).toBe(lineSpent(l, byCat));
      expect(line.label, l.key).toBe(l.label);
      expect(line.cats, l.key).toEqual(l.cats);
    }
  });

  it("grades the pay cycle rather than the month, and a split lands on both lines", () => {
    const { cycle, spent, byCat } = envelopeStatus(LEDGER, NOW);
    // The cycle contains 20 Sep and excludes 20 Aug and 5 Oct.
    expect(cycle.start <= "2026-09-20" && "2026-09-20" <= cycle.end).toBe(true);
    expect(cycle.start > "2026-08-20").toBe(true);
    expect(cycle.end < "2026-10-05").toBe(true);
    // 70 of the split's 100 on groceries, 30 on pets.
    expect(byCat.groceries).toBe(206.09 + 42 + 70);
    expect(byCat.pets).toBe(18.5 + 30);
    // Electronics is real cash out and is graded against no line, so it is in the
    // partition and not in the envelope's spend.
    expect(byCat.electronics).toBe(300);
    expect(spent).toBe(206.09 + 42 + 70 + 61.4 + 18.5 + 30);
  });

  it("reads no clock of its own", () => {
    // The edge runtime is UTC. From 5 PM Arizona onward a fired default answers about
    // tomorrow — a different pay cycle, a different set of charges — and NOW above is
    // 7 PM deliberately. `now` is a required argument, so there is no default to fire.
    const src = readFileSync("src/lib/headline.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(code).not.toMatch(/new Date\(|Date\.now\(|todayISO\(/);
  });
});

// ── firepower: "available THIS month" ────────────────────────────────────────
//
// planMath answers a question about the PLAN. The hero tile answers one about THIS
// month, and the screen subtracts two things planMath cannot see before it shows a
// figure. A door that called planMath and stopped would have been honestly computed
// and wrong by both subtractions — which is why finance.firepower was absent.
describe("firepowerStatus is the tile, not planMath", () => {
  // A month with all three ingredients in it: graded spend over the monthly
  // envelope, and cash out in a category no budget line grades.
  const NOW_M = new Date(2026, 8, 26, 22, 0, 0); // Arizona evening, month not over
  const data = (txns: Transaction[]): AppData =>
    ({
      transactions: txns,
      debts: [
        { id: "d1", name: "Credit card (…4728)", balance: 4113.01, originalBalance: 4500, apr: 19.99, minPayment: 35, color: "#ef4444", createdAt: "2026-01-01T00:00:00Z" },
      ],
      accounts: [
        { id: "a1", name: "Checking", owner: "Gino", type: "checking", balance: 812.4, pendingHold: 0, sortOrder: 1, createdAt: "2026-01-01T00:00:00Z" },
      ],
      recurring: [
        { id: "r1", name: "Paycheck", amount: 2800, direction: "in", cadence: "semimonthly", active: true, dueDays: [15, 31], categoryId: "income", createdAt: "2026-01-01T00:00:00Z" },
        { id: "r2", name: "Rent", amount: 1715, direction: "out", cadence: "monthly", active: true, dueDays: [1], categoryId: "rent", createdAt: "2026-01-01T00:00:00Z" },
      ],
      categories: [],
      goals: [],
      paidBills: [],
      merchantRules: [],
    }) as unknown as AppData;

  const HEAVY: Transaction[] = [
    ...LEDGER,
    // Enough graded spend to blow the MONTHLY envelope, not just the cycle's share.
    txn("2026-09-05", 1400.0),
    // Ungraded, still cash out the door: electronics belongs to no budget line.
    txn("2026-09-08", 250.0, "electronics"),
    // And one more of the outside-budget set, to prove the whole list is read and
    // not just the first entry.
    txn("2026-09-09", 180.0, "utilities"),
  ];

  it("subtracts the overspend and the ungraded cash, exactly as the screen does", () => {
    const d = data(HEAVY);
    const monthKey = monthKeyOf(NOW_M);
    const monthlyTarget = sumTargets(LEAN_VARIABLE);
    const math = planMath(d.recurring, d.debts, monthlyTarget, isoDate(NOW_M), d.transactions);
    const spentMonth = variableSpentThisMonth(d.transactions, monthKey);
    const overspendMonth = Math.max(0, spentMonth - monthlyTarget);
    const byCatMonth = spentByCategory(d.transactions, monthKey);
    const outside = OUTSIDE_BUDGET_CASH_CATS.reduce((s, c) => s + (byCatMonth[c] ?? 0), 0);

    const got = firepowerStatus(d, NOW_M);
    expect(got.monthKey).toBe(monthKey);
    expect(got.math).toEqual(math);
    expect(got.monthlyTarget).toBe(monthlyTarget);
    expect(got.spentThisMonth).toBe(spentMonth);
    expect(got.overspendThisMonth).toBe(overspendMonth);
    expect(got.outsideBudgetCash).toBe(outside);
    expect(got.firepower).toBe(Math.max(0, math.firepower - overspendMonth - outside));

    // The subtractions are real on this fixture, or the assertions above are vacuous.
    expect(overspendMonth).toBeGreaterThan(0);
    // 250 electronics + 180 utilities added here, plus the 300 of electronics already
    // in LEDGER. Three charges in two categories, so this proves the whole
    // OUTSIDE_BUDGET_CASH_CATS list is read and totalled, not just its first entry.
    expect(outside).toBe(300 + 250 + 180);
    expect(got.firepower).toBeLessThan(math.firepower);
  });

  it("is NOT planMath's firepower — the two differ by the two subtractions", () => {
    const got = firepowerStatus(data(HEAVY), NOW_M);
    expect(got.firepower).not.toBe(got.math.firepower);
    expect(got.math.firepower - got.overspendThisMonth - got.outsideBudgetCash).toBe(got.firepower);
  });

  it("never goes negative, and under-spending never inflates it", () => {
    // Blow the month so far past the envelope that the raw figure is negative.
    const broke = data([...HEAVY, txn("2026-09-10", 9000.0)]);
    const over = firepowerStatus(broke, NOW_M);
    expect(over.math.firepower - over.overspendThisMonth - over.outsideBudgetCash).toBeLessThan(0);
    expect(over.firepower).toBe(0);

    // Spend nothing: firepower is planMath's figure and not a penny more. The budget
    // stays reserved — an under-spent month does not become extra firepower.
    const quiet = firepowerStatus(data([]), NOW_M);
    expect(quiet.overspendThisMonth).toBe(0);
    expect(quiet.outsideBudgetCash).toBe(0);
    expect(quiet.firepower).toBe(Math.max(0, quiet.math.firepower));
  });

  it("keeps the month and the cycle overspends as two different numbers", () => {
    const got = firepowerStatus(data(HEAVY), NOW_M);
    expect(got.overspendThisCycle).toBe(Math.max(0, got.envelope.spent - got.envelope.target));
    // One grades a month against a monthly envelope, the other a pay cycle against
    // its share. Mixing them charges half a period against a whole one.
    expect(got.overspendThisMonth).not.toBe(got.overspendThisCycle);
  });

  it("hands planMath an explicit date, so a UTC default cannot move a bill", () => {
    // planMath's date decides which recurring rows are live (startsOn / endsOn). Its
    // default is the machine's local date, which in an edge function is UTC — so from
    // 5 PM Arizona onward it is tomorrow, and at a month end, next month.
    const withWindow = data(HEAVY);
    const rows = [
      ...withWindow.recurring,
      // Starts the day AFTER the Arizona evening this test asks about. Under the
      // Arizona date it is not live; under a UTC rollover it would be.
      { id: "r3", name: "Dental plan", amount: 120, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [5], categoryId: "health", startsOn: "2026-09-27", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const d = { ...withWindow, recurring: rows } as unknown as AppData;
    const got = firepowerStatus(d, NOW_M);
    const az = planMath(rows, d.debts, sumTargets(LEAN_VARIABLE), "2026-09-26", d.transactions);
    const tomorrow = planMath(rows, d.debts, sumTargets(LEAN_VARIABLE), "2026-09-27", d.transactions);
    expect(got.math.fixedNonDebt).toBe(az.fixedNonDebt);
    // The two dates really do disagree, so the assertion above is load-bearing.
    expect(tomorrow.fixedNonDebt).not.toBe(az.fixedNonDebt);
  });
});

// ── still due before payday ──────────────────────────────────────────────────
describe("billsBeforeNextPayday is the window, not a new one", () => {
  const RECURRING = [
    { id: "r-rent", name: "Rent", amount: 1715, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [1], categoryId: "rent", createdAt: "2026-01-01T00:00:00Z" },
    { id: "r-spot", name: "Spotify", amount: 14.04, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [10], categoryId: "subscriptions", createdAt: "2026-01-01T00:00:00Z" },
    { id: "r-srp", name: "Electric (SRP)", amount: 100, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [17], categoryId: "utilities", createdAt: "2026-01-01T00:00:00Z" },
    { id: "r-tmo", name: "T-Mobile", amount: 85, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [29], categoryId: "utilities", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const DATA = { transactions: [], recurring: RECURRING, debts: [], accounts: [] } as unknown as AppData;

  // 20 Sep 2026, Arizona evening. The cycle containing it opened on the 15th and ends
  // on the 29th (paydays are the 15th and the 31st), so the 17th is INSIDE it and
  // already overdue, and the 29th is inside it and still ahead.
  const NOW_B = new Date(2026, 8, 20, 22, 0, 0);

  it("returns exactly what the four-argument call returns", () => {
    const getMonth = monthGetter(DATA, NOW_B);
    const mc = getMonth(NOW_B.getFullYear(), NOW_B.getMonth());
    const cycle = payCycleFor(NOW_B);
    const [endY, endM] = cycle.end.split("-").map(Number);
    const months = endY === mc.year && endM - 1 === mc.month ? [mc] : [mc, getMonth(endY, endM - 1)];
    const want = dueBeforeNextPayday(months, isoDate(NOW_B), cycle.end, cycle.start);

    const got = billsBeforeNextPayday(getMonth, NOW_B);
    expect(got.cycle).toEqual(cycle);
    expect(got.daysLeft).toBe(Math.max(0, cycle.days - cycle.dayIndex));
    expect(got.total).toBe(want.total);
    expect(got.overdueTotal).toBe(want.overdueTotal);
    expect(got.bills.map((b) => b.id)).toEqual(want.bills.map((b) => b.id));
  });

  it("opens at the cycle start, so an unpaid bill already past its date stays in", () => {
    const got = billsBeforeNextPayday(monthGetter(DATA, NOW_B), NOW_B);
    const days = got.bills.map((b) => b.day).sort((a, b) => a - b);
    // The 17th is behind today and still unpaid — it is the row a window opening at
    // today would silently drop, and it is the one most at risk of being forgotten.
    expect(days).toEqual([17, 29]);
    expect(got.bills.find((b) => b.day === 17)!.overdue).toBe(true);
    expect(got.bills.find((b) => b.day === 29)!.overdue).toBe(false);
    expect(got.overdueTotal).toBe(100);
    expect(got.total).toBe(185);
    // Rent on the 1st and Spotify on the 10th are in the month and OUTSIDE the
    // cycle, so a month-shaped answer would have counted them.
    expect(days).not.toContain(1);
    expect(days).not.toContain(10);
  });

  it("carries the resolved date, and crosses a month boundary when the cycle does", () => {
    // 31 Aug is a payday, so the cycle it opens runs into September — a window that a
    // caller handing over only August would under-report.
    const now = new Date(2026, 7, 31, 22, 0, 0);
    const got = billsBeforeNextPayday(monthGetter(DATA, now), now);
    expect(got.cycle.start).toBe("2026-08-31");
    expect(got.cycle.end.slice(0, 7)).toBe("2026-09");
    // Every bill in the window names its own month in `due`, which a day number
    // alone cannot do once two months are in play.
    for (const b of got.bills) expect(b.due).toBe(`${b.due.slice(0, 7)}-${String(b.day).padStart(2, "0")}`);
    expect(got.bills.map((b) => b.due)).toContain("2026-09-10");
    expect(got.bills.some((b) => b.due.startsWith("2026-08"))).toBe(false);
  });

  it("hands back the very calendar the total was built from", () => {
    const getMonth = monthGetter(DATA, NOW_B);
    const got = billsBeforeNextPayday(getMonth, NOW_B);
    // The list a screen renders and the figure above it come from one build of the
    // month, so they cannot disagree the way a bar and its drill-in rows once did.
    expect(got.month).toEqual(monthCalendar(RECURRING, [], NOW_B, 2026, 8, []));
  });
});

// ── the forward projection ───────────────────────────────────────────────────
describe("forecastPlan is the retired screen's assembly", () => {
  const DEBTS = [
    // The biggest interest-bearing balance with a bill attached — what the screen
    // modelled. The bigger balance below carries NO apr, so it must not be picked.
    { id: "d-visa", name: "Credit card (…4728)", balance: 4113.01, originalBalance: 4500, apr: 19.99, minPayment: 35, color: "#ef4444", createdAt: "2026-01-01T00:00:00Z" },
    { id: "d-mom", name: "Mom (China)", balance: 9000, originalBalance: 9000, color: "#f59e0b", createdAt: "2026-01-01T00:00:00Z" },
    { id: "d-small", name: "Affirm", balance: 212, originalBalance: 400, apr: 10, color: "#f59e0b", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const RECURRING = [
    { id: "r-in", name: "Paycheck", amount: 2800, direction: "in" as const, cadence: "semimonthly" as const, active: true, dueDays: [15, 31], categoryId: "income", createdAt: "2026-01-01T00:00:00Z" },
    { id: "r-rent", name: "Rent", amount: 1715, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [1], categoryId: "rent", createdAt: "2026-01-01T00:00:00Z" },
    { id: "r-card", name: "Card payment (…4728)", amount: 129.4, direction: "out" as const, cadence: "monthly" as const, active: true, dueDays: [15], categoryId: "debt", linkedDebtId: "d-visa", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const ACCOUNTS = [
    { id: "a1", name: "Checking", owner: "Gino", type: "checking", balance: 1193.77, pendingHold: 0, sortOrder: 1, createdAt: "2026-01-01T00:00:00Z" },
    { id: "a2", name: "Visa", owner: "Gino", type: "credit", balance: 4113.01, sortOrder: 2, createdAt: "2026-01-01T00:00:00Z" },
  ];
  const NOW_F = new Date(2026, 8, 26, 22, 0, 0);
  const withTxns = (txns: Transaction[]) =>
    ({ transactions: txns, debts: DEBTS, recurring: RECURRING, accounts: ACCOUNTS } as unknown as AppData);

  // Spread across several complete cycles, so there is a median to read.
  const HISTORY: Transaction[] = [
    txn("2026-07-02", 300), txn("2026-07-20", 500), txn("2026-08-02", 900),
    txn("2026-08-20", 700), txn("2026-09-02", 400), txn("2026-09-20", 650),
  ];

  it("picks the card, the dials' opening positions and the cash, the way the screen did", () => {
    const d = withTxns(HISTORY);
    const cycles = recentCycleSpend(d.transactions, NOW_F);
    const typical = typicalCycleSpend(cycles);
    const plan = forecastPlan(d, NOW_F);

    expect(plan.startMonth).toBe(monthKeyOf(NOW_F));
    // The biggest balance with an APR, not the biggest balance.
    expect(plan.cardDebt?.id).toBe("d-visa");
    expect(plan.opts.cardDebtId).toBe("d-visa");
    // The card bill's own contracted amount, rounded to the dollar.
    expect(plan.opts.cardPay).toBe(129);
    expect(plan.typicalCycle).toBe(typical);
    expect(plan.opts.cycleSpend).toBe(Math.round(typical));
    expect(plan.cycles).toEqual(cycles);
    // The bank's own available total, cards excluded by totalBalance.
    expect(plan.opts.openingCash).toBe(totalBalance(d.accounts));
    expect(plan.opts.openingCash).toBe(1193.77);
  });

  it("falls back to the screen's own figure only when there is no history to read", () => {
    const plan = forecastPlan(withTxns([]), NOW_F);
    expect(plan.typicalCycle).toBe(0);
    expect(plan.opts.cycleSpend).toBe(FALLBACK_CYCLE_SPEND);
  });

  it("leaves the card override OFF when no bill is attached, rather than inventing one", () => {
    // The screen fell back to a hardcoded 134 here. With no card row there is no card
    // line for an override to apply to, so that number was never reachable — and a
    // figure that can be spoken in a chat must not be an invented one.
    const noBill = { ...withTxns(HISTORY), recurring: RECURRING.filter((r) => !r.linkedDebtId) } as unknown as AppData;
    const plan = forecastPlan(noBill, NOW_F);
    expect(plan.cardDebt?.id).toBe("d-visa");
    expect(plan.opts.cardPay).toBeUndefined();
    expect(JSON.stringify(plan.opts)).not.toContain("134");
  });

  it("runForecast is forecast() called with that plan and nothing else", () => {
    const d = withTxns(HISTORY);
    const plan = forecastPlan(d, NOW_F);
    const want = forecast(d.recurring, d.transactions, d.debts, plan.startMonth, 6, plan.opts, NOW_F);
    const got = runForecast(d, NOW_F, 6);
    expect(got.plan).toEqual(plan);
    expect(got.months).toEqual(want);
    expect(got.months).toHaveLength(6);
    expect(got.months[0].partial).toBe(true);
  });

  it("finds the lowest moment across the run, earliest of any tie", () => {
    const { months } = runForecast(withTxns(HISTORY), NOW_F, 12);
    const low = lowestPoint(months)!;
    expect(low).not.toBeNull();
    const all = months.filter((m) => m.low).map((m) => m.low!.balance);
    expect(low.balance).toBe(Math.min(...all));
    const owner = months.find((m) => m.monthKey === low.monthKey)!;
    expect(owner.low).toEqual({ day: low.day, balance: low.balance });
    // A tie resolves to the earlier month, so the answer names the one that arrives
    // first rather than whichever the reduction happened to reach last.
    const tie = [
      { monthKey: "2026-10", label: "Oct 26", low: { day: 4, balance: -50 } },
      { monthKey: "2026-11", label: "Nov 26", low: { day: 9, balance: -50 } },
    ] as unknown as Parameters<typeof lowestPoint>[0];
    expect(lowestPoint(tie)!.monthKey).toBe("2026-10");
  });

  it("has no low point at all when no opening balance was supplied", () => {
    // A projection with no running balance in it has no low point, and that is a
    // different answer from a low point of zero.
    const d = withTxns(HISTORY);
    const bare = forecast(d.recurring, d.transactions, d.debts, "2026-09", 3, { cycleSpend: 800 }, NOW_F);
    expect(bare.every((m) => m.low === undefined)).toBe(true);
    expect(lowestPoint(bare)).toBeNull();
  });
});

describe("both callers go through it", () => {
  /** A module's code with its comments taken out, so a rule can be explained in the
   *  file it applies to without the explanation tripping the check. */
  const codeOf = (path: string) =>
    readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

  it("the screen builds its envelope AND its firepower from headline.ts", () => {
    const src = readFileSync("src/views/redesign/buildVMs.ts", "utf8");
    expect(src).toMatch(/import \{ firepowerStatus \} from "\.\.\/\.\.\/lib\/headline"/);
    expect(src).toContain("firepowerStatus(data, now)");
    // And it no longer re-runs either sequence itself.
    const code = codeOf("src/views/redesign/buildVMs.ts");
    expect(code).not.toContain("payCycleFor(now)");
    expect(code).not.toContain("perCycle(monthlyTarget)");
    expect(code).not.toContain("lineSpent(");
    expect(code).not.toContain("planMath(");
    expect(code).not.toContain("OUTSIDE_BUDGET_CASH_CATS");
  });

  it("the Bills sheet gets its window from headline.ts", () => {
    const src = readFileSync("src/views/redesign/BillsSheet.tsx", "utf8");
    expect(src).toMatch(/import \{ billsBeforeNextPayday \} from "\.\.\/\.\.\/lib\/headline"/);
    expect(src).toContain("billsBeforeNextPayday(getMonth, base)");
    const code = codeOf("src/views/redesign/BillsSheet.tsx");
    // The four arguments are no longer assembled here.
    expect(code).not.toContain("dueBeforeNextPayday(");
    expect(code).not.toContain("payCycleFor(");
  });

  it("the read door does too, through the generated copy", () => {
    const src = readFileSync("supabase/functions/_shared/muse/tools.ts", "utf8");
    expect(src).toMatch(/from "\.\/lib\/headline\.ts"/);
    for (const name of [
      "envelopeStatus",
      "firepowerStatus",
      "billsBeforeNextPayday",
      "monthGetter",
      "runForecast",
      "lowestPoint",
    ]) {
      expect(src, `${name} is not imported from headline`).toContain(name);
    }
    const code = codeOf("supabase/functions/_shared/muse/tools.ts");
    // Not one of the assembled sequences is re-run in the door.
    for (const call of [
      "payCycleFor(",
      "perCycle(",
      "variableSpentBetween(",
      "variableSpentThisMonth(",
      "spentByCategory(",
      "dueBeforeNextPayday(",
      "monthCalendar(",
      "forecast(",
      "recentCycleSpend(",
      "typicalCycleSpend(",
      "totalBalance(data",
    ]) {
      expect(code, `the door re-runs ${call}`).not.toContain(call);
    }
  });

  it("the generated copies are on the generator's list, so they cannot be hand-edited", () => {
    const gen = readFileSync("scripts/gen-muse-shared.mjs", "utf8");
    // headline.ts imports all three, so all four have to be generated or the door
    // will not start — and a file on disk that the generator does not write is drift
    // the --check run refuses.
    for (const module of ["headline.ts", "schedule.ts", "forecast.ts", "recurring.ts"]) {
      expect(gen, `${module} is not generated`).toContain(`"src/lib/${module}"`);
    }
    const copy = readFileSync("supabase/functions/_shared/muse/lib/headline.ts", "utf8");
    expect(copy).toContain("GENERATED — DO NOT EDIT");
  });
});
