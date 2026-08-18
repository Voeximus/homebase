import { describe, it, expect } from "vitest";
import { forecast, summarize, addMonths, monthLabel } from "../src/lib/forecast";
import type { Recurring, Transaction, Debt } from "../src/types";

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "b",
  name: "Bill",
  amount: 100,
  direction: "out",
  cadence: "monthly",
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const ROWS: Recurring[] = [
  bill({ id: "rent", name: "Rent", amount: 1732.16, dueDays: [1] }),
  bill({ id: "pet", name: "Spot Pet", amount: 99.93, dueDays: [4] }),
  bill({ id: "late", name: "Verizon", amount: 93, dueDays: [24] }),
  bill({
    id: "pay",
    name: "Paycheck",
    amount: 1187.42,
    direction: "in",
    cadence: "biweekly",
    anchorDate: "2026-08-07",
  }),
];

/** A recorded payment that settles a bill installment. */
const paid = (recurringId: string, monthKey: string, day: number, amount: number): Transaction => ({
  id: `p-${recurringId}-${day}`,
  date: `${monthKey}-${String(day).padStart(2, "0")}`,
  amount,
  type: "expense",
  categoryId: "housing",
  description: recurringId,
  appliesTo: { kind: "bill", recurringId, monthKey, day },
  createdAt: `${monthKey}-${String(day).padStart(2, "0")}T12:00:00Z`,
});

const DEBTS: Debt[] = [];
const OPTS = { cycleSpend: 0 }; // isolate bills/income from the spend dial

describe("addMonths / monthLabel", () => {
  it("crosses a year boundary", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-02", -3)).toBe("2025-11");
  });
  it("labels", () => {
    expect(monthLabel("2026-08")).toBe("Aug 26");
    expect(monthLabel("2027-01")).toBe("Jan 27");
  });
});

describe("month 0 is THE REST of this month, not the whole thing", () => {
  // The defect: the current month was counted whole, so rent already drafted on
  // the 1st and paychecks already banked were both projected as still to come.
  // The row overstated BOTH sides at once.
  const now = new Date(2026, 7, 18, 12); // Aug 18 2026, local noon
  const txns = [paid("rent", "2026-08", 1, 1732.16), paid("pet", "2026-08", 4, 99.93)];

  it("drops bills the calendar already knows are paid", () => {
    const [m0] = forecast(ROWS, txns, DEBTS, "2026-08", 2, OPTS, now);
    expect(m0.partial).toBe(true);
    expect(m0.lines.map((l) => l.name)).toEqual(["Verizon"]); // rent + pet already paid
    expect(m0.bills).toBeCloseTo(93, 2);
  });

  it("still counts an UNPAID bill whose due day has passed — it is owed", () => {
    // Nothing paid at all: rent (due the 1st) is overdue on the 18th and must
    // remain visible rather than being silently dropped for being in the past.
    const [m0] = forecast(ROWS, [], DEBTS, "2026-08", 2, OPTS, now);
    expect(m0.lines.map((l) => l.name).sort()).toEqual(["Rent", "Spot Pet", "Verizon"]);
    expect(m0.bills).toBeCloseTo(1732.16 + 99.93 + 93, 2);
  });

  it("drops paychecks that already landed", () => {
    // Anchor 2026-08-07 → Aug paydays are the 7th and 21st. On the 18th only the
    // 21st is still coming.
    const [m0] = forecast(ROWS, txns, DEBTS, "2026-08", 2, OPTS, now);
    expect(m0.incomeEvents).toBe(1);
    expect(m0.income).toBeCloseTo(1187.42, 2);
  });

  it("the NEXT month is whole and unaffected", () => {
    const [, m1] = forecast(ROWS, txns, DEBTS, "2026-08", 2, OPTS, now);
    expect(m1.partial).toBeUndefined();
    expect(m1.bills).toBeCloseTo(1732.16 + 99.93 + 93, 2);
    expect(m1.incomeEvents).toBe(2); // Sep 4 + Sep 18
  });

  it("prorates variable spend across the days that are left", () => {
    // Aug 18 → 14 of 31 days remain (today counts). $700/cycle = $1,400/month.
    const [m0] = forecast(ROWS, txns, DEBTS, "2026-08", 2, { cycleSpend: 700 }, now);
    expect(m0.spend).toBeCloseTo((1400 * 14) / 31, 2);
    const [, m1] = forecast(ROWS, txns, DEBTS, "2026-08", 2, { cycleSpend: 700 }, now);
    expect(m1.spend).toBe(1400);
  });

  it("a month that is NOT the current one is never partial", () => {
    const months = forecast(ROWS, txns, DEBTS, "2026-10", 3, OPTS, now);
    expect(months.some((m) => m.partial)).toBe(false);
  });
});

describe("summarize excludes the partial month from comparisons", () => {
  const now = new Date(2026, 7, 18, 12);

  // A SEMIMONTHLY paycheck on purpose, so every whole month is identical and the
  // partial month is unambiguously the outlier. (With the biweekly row above, the
  // three-paycheck month is genuinely the best month of the year and beats the
  // partial one — true, but it makes this test prove nothing.)
  const FLAT: Recurring[] = [
    bill({ id: "rent", name: "Rent", amount: 1732.16, dueDays: [1] }),
    bill({ id: "pet", name: "Spot Pet", amount: 99.93, dueDays: [4] }),
    bill({ id: "late", name: "Verizon", amount: 93, dueDays: [24] }),
    bill({ id: "pay", name: "Paycheck", amount: 2374.84, direction: "in", cadence: "monthly", dueDays: [15] }),
  ];
  // On Aug 18: rent and Spot Pet are already paid AND the 15th paycheck has
  // already landed. So the rest of August has NO income left and $93 of Verizon
  // still to go — a surplus of −$93, far below any whole month's $449.75.
  //
  // This is the direction that matters most. Left in the comparison, a partial
  // month makes the app report a scary "tightest month" that is not a month at
  // all, just a few days measured against twelve whole ones.
  const txns = [
    paid("rent", "2026-08", 1, 1732.16),
    paid("pet", "2026-08", 4, 99.93),
  ];

  it("the partial month is a genuine outlier — the premise of this block", () => {
    const months = forecast(FLAT, txns, DEBTS, "2026-08", 12, OPTS, now);
    expect(months[0].partial).toBe(true);
    expect(months[0].surplus).toBe(Math.min(...months.map((m) => m.surplus)));
  });

  it("worst is drawn from WHOLE months, so the fraction cannot pose as the tightest month", () => {
    const months = forecast(FLAT, txns, DEBTS, "2026-08", 12, OPTS, now);
    const s = summarize(months)!;
    expect(s.worst.partial).toBeUndefined();
    expect(s.worst.surplus).toBeGreaterThan(months[0].surplus);
  });

  it("best is drawn from WHOLE months too", () => {
    const months = forecast(FLAT, txns, DEBTS, "2026-08", 12, OPTS, now);
    expect(summarize(months)!.best.partial).toBeUndefined();
  });

  it("with genuinely varied months, best and worst are different whole months", () => {
    // FLAT deliberately makes every whole month identical, so best === worst there
    // is correct, not a bug. This assertion needs varied data to mean anything, so
    // it uses the biweekly rows: October carries a third paycheck and is the real
    // best month. Neither end may be the partial row.
    const months = forecast(ROWS, txns, DEBTS, "2026-08", 12, OPTS, now);
    const s = summarize(months)!;
    expect(s.best.monthKey).not.toBe(s.worst.monthKey);
    expect(s.best.monthKey).toBe("2026-10"); // the three-paycheck month
    expect(s.best.partial).toBeUndefined();
    expect(s.worst.partial).toBeUndefined();
  });

  it("steady is the modal WHOLE month, undistorted by the fraction", () => {
    const months = forecast(FLAT, txns, DEBTS, "2026-08", 12, OPTS, now);
    const s = summarize(months)!;
    expect(s.steady).not.toBe(Math.round(months[0].surplus));
  });

  it("but the TOTAL still includes the partial month — those are real dollars", () => {
    const months = forecast(FLAT, txns, DEBTS, "2026-08", 12, OPTS, now);
    const s = summarize(months)!;
    expect(s.total).toBeCloseTo(
      months.reduce((acc, m) => acc + m.surplus, 0),
      2,
    );
  });

  it("does not divide by nothing when every month is partial", () => {
    const months = forecast(FLAT, [], DEBTS, "2026-08", 1, OPTS, now);
    expect(() => summarize(months)).not.toThrow();
    expect(summarize(months)!.best.monthKey).toBe("2026-08");
  });
});

describe("bill windows drive the forecast month by month", () => {
  const now = new Date(2026, 7, 18, 12);
  const rows = [
    bill({ id: "rent", name: "Rent", amount: 1000, dueDays: [1] }),
    bill({ id: "car", name: "Car payment", amount: 232.67, dueDays: [30], startsOn: "2026-09-30" }),
    bill({ id: "aleks", name: "ALEKS", amount: 21.57, dueDays: [14], endsOn: "2026-10-14" }),
  ];

  it("a not-yet-started bill appears in the month it starts and not before", () => {
    const months = forecast(rows, [], DEBTS, "2026-08", 4, OPTS, now);
    const has = (m: (typeof months)[number], name: string) => m.lines.some((l) => l.name === name);
    expect(has(months[0], "Car payment")).toBe(false); // Aug
    expect(has(months[1], "Car payment")).toBe(true); // Sep
    expect(has(months[2], "Car payment")).toBe(true); // Oct
  });

  it("an ended bill stops appearing", () => {
    const months = forecast(rows, [], DEBTS, "2026-08", 4, OPTS, now);
    const has = (m: (typeof months)[number], name: string) => m.lines.some((l) => l.name === name);
    expect(has(months[2], "ALEKS")).toBe(true); // Oct 14 is the last day, inclusive
    expect(has(months[3], "ALEKS")).toBe(false); // Nov
  });
});

describe("the card is simulated down as the projection walks", () => {
  const now = new Date(2026, 7, 18, 12);
  const rows = [bill({ id: "cp", name: "Card payment", amount: 134, dueDays: [15], linkedDebtId: "d1" })];
  const debts: Debt[] = [
    { id: "d1", name: "Card", balance: 600, originalBalance: 1000, apr: 0, color: "#000", createdAt: "" },
  ];

  it("the payment line disappears in the month the balance clears", () => {
    const months = forecast(rows, [], debts, "2026-08", 8, { cycleSpend: 0, cardPay: 300, cardDebtId: "d1" }, now);
    const paying = months.filter((m) => m.lines.some((l) => l.name === "Card payment")).length;
    expect(paying).toBe(2); // $600 at $300/mo
    expect(months.find((m) => m.cardCleared)?.monthKey).toBe("2026-09");
    expect(months[2].lines.some((l) => l.name === "Card payment")).toBe(false);
  });

  it("never pays more than the balance owed", () => {
    const months = forecast(rows, [], debts, "2026-08", 8, { cycleSpend: 0, cardPay: 5000, cardDebtId: "d1" }, now);
    const first = months[0].lines.find((l) => l.name === "Card payment")!;
    expect(first.amount).toBeCloseTo(600, 2);
  });
});
