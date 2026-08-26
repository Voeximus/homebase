import { describe, it, expect } from "vitest";
import {
  LEAN_VARIABLE,
  OUTSIDE_BUDGET_CASH_CATS,
  inAnyLine,
  sumTargets,
  billExpected,
  spentByCategoryBetween,
  planMath,
} from "../src/lib/plan";
import { householdMonthly, liveOn, monthlyAmount, accountFlow } from "../src/lib/recurring";
import { CADENCE_TO_MONTHLY } from "../src/lib/household";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import { monthlySchedule } from "../src/lib/schedule";
import type { Recurring, Transaction, Debt } from "../src/types";

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "b1",
  name: "Bill",
  amount: 100,
  direction: "out",
  cadence: "monthly",
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  id: "t1",
  date: "2026-08-10",
  amount: 50,
  type: "expense",
  categoryId: "groceries",
  description: "Store",
  createdAt: "2026-08-10T12:00:00Z",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DELIBERATE CONVENTIONS — these tests exist to stop a 'fix'", () => {
  it("biweekly is x2, NOT 26/12 — and that is on purpose", () => {
    // If this test fails, someone has 'corrected' a deliberate decision. The
    // budget plans on TWO checks a month and treats the ~2 extra checks a year as
    // upside rather than budgeted income. 26/12 = 2.167 is arithmetically right
    // and was rejected. It understates annual income by about $2,375 knowingly.
    // Do not change the constant to make this test pass — change it back.
    expect(CADENCE_TO_MONTHLY.biweekly).toBe(2);
    expect(CADENCE_TO_MONTHLY.semimonthly).toBe(2);
  });

  it("periodic cadences are monthly AVERAGES here, never per-occurrence", () => {
    expect(monthlyAmount(bill({ amount: 639.42, cadence: "semiannual" }))).toBeCloseTo(106.57, 2);
    expect(monthlyAmount(bill({ amount: 16.22, cadence: "yearly" }))).toBeCloseTo(1.352, 3);
  });

  it("every expense category is graded on a line OR explicitly ungraded", () => {
    // The hole this closes: `utilities` sat on no budget line AND in no carve-out,
    // so a $180 water charge vanished from the budget bars, the donut and
    // firepower at once — real cash, invisible everywhere. A category must be one
    // or the other, never neither.
    const UNGRADED_BY_DESIGN = new Set([
      ...OUTSIDE_BUDGET_CASH_CATS,
      "interest", // already inside the card balance the debt total reads
    ]);
    const orphans = DEFAULT_CATEGORIES.filter(
      (c) => c.type === "expense" && !inAnyLine(c.id) && !UNGRADED_BY_DESIGN.has(c.id),
    ).map((c) => c.id);
    expect(
      orphans,
      `these expense categories are graded by nothing and reduce firepower by nothing, so money assigned to them disappears from every screen: ${orphans.join(", ")}. Put each on a LEAN_VARIABLE line or in OUTSIDE_BUDGET_CASH_CATS.`,
    ).toEqual([]);
  });

  it("the budget lines sum to the envelope they claim", () => {
    expect(sumTargets(LEAN_VARIABLE)).toBe(1600);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("liveOn / householdMonthly — a bill that cannot fire must not be charged", () => {
  // The regression guard for the largest money defect found: Home read $1,163.92
  // /mo lower than Bills and Forecast for the same month, because the plan path
  // ignored the window columns the calendar path honoured.
  const rows: Recurring[] = [
    bill({ id: "rent", name: "Rent", amount: 1732.16 }),
    bill({ id: "car", name: "Car payment", amount: 232.67, startsOn: "2026-09-30" }),
    bill({ id: "ins", name: "Car insurance (both)", amount: 290.59, startsOn: "2027-02-01" }),
    bill({ id: "mom", name: "Mom", amount: 300, startsOn: "2026-11-01" }),
    bill({ id: "aleks", name: "ALEKS", amount: 21.57, endsOn: "2026-10-14" }),
    bill({ id: "pay", name: "Paycheck", amount: 1187.42, direction: "in", cadence: "biweekly" }),
  ];

  it("excludes not-yet-started bills", () => {
    const h = householdMonthly(rows, "2026-08-18");
    expect(h.bills).toBeCloseTo(1732.16 + 21.57, 2);
  });

  it("includes a bill from its start date, inclusive", () => {
    expect(householdMonthly(rows, "2026-09-29").bills).toBeCloseTo(1753.73, 2);
    expect(householdMonthly(rows, "2026-09-30").bills).toBeCloseTo(1986.4, 2);
  });

  it("excludes a bill after its end date — the silent-forever case", () => {
    expect(liveOn(rows[4], "2026-10-14")).toBe(true);
    expect(liveOn(rows[4], "2026-10-15")).toBe(false);
    const h = householdMonthly(rows, "2026-12-01");
    expect(h.bills).toBeCloseTo(1732.16 + 232.67 + 300, 2); // no ALEKS
  });

  it("income is windowed the same way", () => {
    const h = householdMonthly(rows, "2026-08-18");
    expect(h.income).toBeCloseTo(1187.42 * 2, 2); // biweekly x2, per convention
  });

  it("accountFlow honours the window too", () => {
    const rs = [bill({ accountId: "a", amount: 500, startsOn: "2026-12-01" })];
    expect(accountFlow("a", rs, "2026-08-18").outflow).toBe(0);
    expect(accountFlow("a", rs, "2026-12-01").outflow).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("planMath", () => {
  const debts: Debt[] = [
    { id: "d1", name: "Card", balance: 1000, originalBalance: 2000, color: "#000", createdAt: "" },
  ];

  it("does not add a phantom fixed cost on top of the bill rows", () => {
    // A hardcoded $10.59 renters-insurance constant used to be added to hh.bills
    // even though the LEMONADE INSURANCE row already existed and was active.
    const rows = [bill({ amount: 1000 })];
    const m = planMath(rows, debts, 0, "2026-08-18");
    expect(m.fixed).toBe(1000);
  });

  it("windows the debt-payment add-back too, or firepower reads TOO HIGH", () => {
    // debtPaymentsInFixed is SUBTRACTED from fixed. If householdMonthly stops
    // counting a windowed-out card payment while this keeps subtracting it,
    // fixedNonDebt falls below reality and firepower overstates available cash —
    // the more damaging direction to be wrong.
    const rows = [
      bill({ id: "r", name: "Rent", amount: 1000 }),
      bill({ id: "c", name: "Card payment (…4728)", amount: 134, endsOn: "2026-07-31" }),
    ];
    const m = planMath(rows, debts, 0, "2026-08-18");
    expect(m.fixed).toBe(1000); // the ended card payment is gone from bills
    expect(m.debtPaymentsInFixed).toBe(0); // ...and from the add-back
    expect(m.fixedNonDebt).toBe(1000);
  });

  it("prices a VARIABLE bill the way the calendar does, not at its stale amount", () => {
    // Found by the self-audit on live data: the plan counted Electric at its
    // stored $85 while the calendar counted the $100 read off the bill, and
    // Verizon $83 against $93. The plan's figure being LOWER made firepower read
    // TOO HIGH — overstating available cash, the more damaging direction.
    const rows = [
      bill({ id: "srp", name: "Electric (SRP)", amount: 85, variable: true, knownAmount: 100 }),
      bill({ id: "vz", name: "Verizon", amount: 83, variable: true, knownAmount: 93 }),
    ];
    const m = planMath(rows, debts, 0, "2026-08-18", []);
    expect(m.fixed).toBeCloseTo(193, 2); // 100 + 93, not 85 + 83
  });

  it("uses the rolling average when there is no override", () => {
    const b = bill({ id: "srp", name: "Electric (SRP)", amount: 85, variable: true });
    const paid = (amount: number, date: string, monthKey: string): Transaction =>
      txn({
        id: `p${date}`,
        date,
        amount,
        appliesTo: { kind: "bill", recurringId: "srp", monthKey, day: 17 },
      });
    const history = [
      paid(120, "2026-05-17", "2026-05"),
      paid(130, "2026-06-17", "2026-06"),
      paid(140, "2026-07-17", "2026-07"),
    ];
    const m = planMath([b], debts, 0, "2026-08-18", history);
    expect(m.fixed).toBeCloseTo(130, 2); // the average, not the stored 85
  });

  it("leaves a PERIODIC variable bill on its contracted amount", () => {
    // billExpected returns a PER-CHARGE figure that monthlySchedule treats as
    // monthly; those coincide only for a monthly bill. Applying it to a
    // semiannual row would count one charge as if it landed every month.
    const b = bill({ id: "ins", name: "Insurance", amount: 639.42, cadence: "semiannual", variable: true, knownAmount: 700 });
    const m = planMath([b], debts, 0, "2026-08-18", []);
    expect(m.fixed).toBeCloseTo(639.42 / 6, 2);
  });

  it("a live card payment IS added back as firepower, not counted as living cost", () => {
    const rows = [
      bill({ id: "r", name: "Rent", amount: 1000 }),
      bill({ id: "c", name: "Card payment (…4728)", amount: 134, linkedDebtId: "d1" }),
    ];
    const m = planMath(rows, debts, 0, "2026-08-18");
    expect(m.fixed).toBe(1134);
    expect(m.debtPaymentsInFixed).toBe(134);
    expect(m.fixedNonDebt).toBe(1000);
  });

  // The add-back used to key on a NAME regex, /card payment|affirm/i — a guess
  // about what someone typed rather than a fact about the row. "Cherry (dental)"
  // is a real $151.72/mo bill with linked_debt_id set and it matched neither
  // alternative, so the payment was counted as a living cost AND attacked as debt
  // principal: firepower read $151.72/mo low while the payoff schedule spent the
  // same dollars a second time. The fixture above never set linkedDebtId either,
  // so the old test passed on data the live table does not have.
  it("a debt-linked bill is added back whatever it is called", () => {
    const rows = [
      bill({ id: "r", name: "Rent", amount: 1000 }),
      bill({ id: "ch", name: "Cherry (dental)", amount: 151.72, linkedDebtId: "d2" }),
    ];
    const m = planMath(rows, debts, 0, "2026-08-18");
    expect(m.debtPaymentsInFixed).toBeCloseTo(151.72, 2);
    expect(m.fixedNonDebt).toBeCloseTo(1000, 2);
  });

  it("a bill that merely SOUNDS like a debt payment is not added back", () => {
    const rows = [bill({ id: "x", name: "Affirmations app", amount: 9.99 })];
    const m = planMath(rows, debts, 0, "2026-08-18");
    expect(m.debtPaymentsInFixed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("billExpected — what a variable bill will actually be", () => {
  const b = bill({ id: "srp", name: "Electric (SRP)", amount: 83, variable: true });
  const paid = (amount: number, date: string, monthKey: string, day = 17): Transaction =>
    txn({
      id: `p-${date}`,
      date,
      amount,
      categoryId: "utilities",
      appliesTo: { kind: "bill", recurringId: "srp", monthKey, day },
    });

  it("a fixed bill never moves", () => {
    expect(billExpected(bill({ amount: 1732.16 }), [])).toBe(1732.16);
  });

  it("known_amount beats every estimate — that is its whole job", () => {
    const withOverride = { ...b, knownAmount: 100 };
    const history = [paid(80, "2026-05-17", "2026-05"), paid(82, "2026-06-17", "2026-06")];
    expect(billExpected(withOverride, history)).toBe(100);
  });

  it("known_amount of 0 is honoured, not swallowed as falsy", () => {
    expect(billExpected({ ...b, knownAmount: 0 }, [paid(80, "2026-05-17", "2026-05")])).toBe(0);
  });

  it("falls back to the modelled amount until a real payment is seen", () => {
    expect(billExpected(b, [])).toBe(83);
  });

  it("averages the last THREE actuals, most recent first", () => {
    const history = [
      paid(60, "2026-04-17", "2026-04"),
      paid(90, "2026-05-17", "2026-05"),
      paid(120, "2026-06-17", "2026-06"),
      paid(150, "2026-07-17", "2026-07"),
    ];
    expect(billExpected(b, history)).toBeCloseTo((90 + 120 + 150) / 3, 6);
  });

  it("ignores payments belonging to a DIFFERENT bill", () => {
    const other = txn({
      id: "x",
      amount: 999,
      appliesTo: { kind: "bill", recurringId: "someone-else", monthKey: "2026-07", day: 1 },
    });
    expect(billExpected(b, [other])).toBe(83);
  });

  it("ignores income rows", () => {
    const credit = txn({
      id: "c",
      amount: 999,
      type: "income",
      appliesTo: { kind: "bill", recurringId: "srp", monthKey: "2026-07", day: 17 },
    });
    expect(billExpected(b, [credit])).toBe(83);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("spentByCategoryBetween — the partition behind every budget bar", () => {
  it("counts only free-form expense rows inside the window", () => {
    const rows = [
      txn({ id: "a", date: "2026-08-01", amount: 10 }),
      txn({ id: "b", date: "2026-08-31", amount: 20 }),
      txn({ id: "c", date: "2026-07-31", amount: 999 }), // before
      txn({ id: "d", date: "2026-09-01", amount: 999 }), // after
    ];
    expect(spentByCategoryBetween(rows, "2026-08-01", "2026-08-31")).toEqual({ groceries: 30 });
  });

  it("EXCLUDES anything carrying an appliesTo — bills are not variable spend", () => {
    const rows = [
      txn({ id: "a", amount: 10 }),
      txn({ id: "b", amount: 500, appliesTo: { kind: "bill", recurringId: "r", monthKey: "2026-08", day: 1 } }),
      txn({ id: "c", amount: 300, appliesTo: { kind: "transfer" } }),
      txn({ id: "d", amount: 200, appliesTo: { kind: "setaside", reason: "excluded" } }),
    ];
    expect(spentByCategoryBetween(rows, "2026-08-01", "2026-08-31")).toEqual({ groceries: 10 });
  });

  it("EXCLUDES still-processing charges", () => {
    const rows = [txn({ id: "a", amount: 10 }), txn({ id: "b", amount: 180, pending: true })];
    expect(spentByCategoryBetween(rows, "2026-08-01", "2026-08-31")).toEqual({ groceries: 10 });
  });

  it("a split fans across its slices and the total is unchanged", () => {
    const rows = [
      txn({
        id: "a",
        amount: 100,
        categoryId: "groceries",
        splits: [
          { categoryId: "groceries", amount: 60 },
          { categoryId: "shopping", amount: 30 },
          { categoryId: "pets", amount: 10 },
        ],
      }),
    ];
    const by = spentByCategoryBetween(rows, "2026-08-01", "2026-08-31");
    expect(by).toEqual({ groceries: 60, shopping: 30, pets: 10 });
    expect(Object.values(by).reduce((s, n) => s + n, 0)).toBe(100);
  });

  it("a 31-day string bound still catches the 31st of a 31-day month", () => {
    const rows = [txn({ id: "a", date: "2026-08-31", amount: 42 })];
    expect(spentByCategoryBetween(rows, "2026-08-01", "2026-08-31")).toEqual({ groceries: 42 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("monthlySchedule — Rule 5: divide by the FULL day count, THEN filter", () => {
  it("a two-installment bill splits evenly", () => {
    const rows = [bill({ id: "mom", name: "Mom", amount: 600, dueDays: [15, 30] })];
    const s = monthlySchedule(rows, "2026-11");
    const mom = s.entries.filter((e) => e.label === "Mom");
    expect(mom).toHaveLength(2);
    expect(mom.every((e) => Math.abs(e.amount - 300) < 0.005)).toBe(true);
  });

  it("a mid-month START drops one installment WITHOUT inflating the other", () => {
    // The trap: dividing by the SURVIVING days would make the remaining payment
    // $600 instead of $300, doubling a month the bill only half-covers.
    const rows = [bill({ id: "mom", name: "Mom", amount: 600, dueDays: [15, 30], startsOn: "2026-11-20" })];
    const s = monthlySchedule(rows, "2026-11");
    const mom = s.entries.filter((e) => e.label === "Mom");
    expect(mom).toHaveLength(1);
    expect(mom[0].day).toBe(30);
    expect(mom[0].amount).toBeCloseTo(300, 2);
  });

  it("a mid-month END behaves the same way", () => {
    const rows = [bill({ id: "mom", name: "Mom", amount: 600, dueDays: [15, 30], endsOn: "2026-11-20" })];
    const mom = monthlySchedule(rows, "2026-11").entries.filter((e) => e.label === "Mom");
    expect(mom).toHaveLength(1);
    expect(mom[0].day).toBe(15);
    expect(mom[0].amount).toBeCloseTo(300, 2);
  });

  it("a periodic bill lands at FULL charge in its anchor month only", () => {
    const rows = [
      bill({ id: "ins", name: "Insurance", amount: 639.42, cadence: "semiannual", anchorDate: "2026-08-01", dueDays: [1] }),
    ];
    const aug = monthlySchedule(rows, "2026-08").entries.filter((e) => e.label === "Insurance");
    expect(aug).toHaveLength(1);
    expect(aug[0].amount).toBeCloseTo(639.42, 2); // full charge, NOT 639.42/6
    expect(monthlySchedule(rows, "2026-09").entries.filter((e) => e.label === "Insurance")).toHaveLength(0);
  });

  it("a card-payment bill disappears when its debt is cleared, and returns when it is not", () => {
    const rows = [bill({ id: "cp", name: "Card payment", amount: 134, dueDays: [15], linkedDebtId: "d1" })];
    const cleared: Debt[] = [
      { id: "d1", name: "Card", balance: 0, originalBalance: 500, color: "#000", createdAt: "" },
    ];
    const owing: Debt[] = [{ ...cleared[0], balance: 500 }];
    expect(monthlySchedule(rows, "2026-08", [], cleared).entries).toHaveLength(0);
    expect(monthlySchedule(rows, "2026-08", [], owing).entries).toHaveLength(1);
  });

  it("a true biweekly row charges its full amount each time, not a split of the month", () => {
    const rows = [
      bill({ id: "pay", name: "Paycheck", amount: 1187.42, direction: "in", cadence: "biweekly", anchorDate: "2026-08-07" }),
    ];
    const oct = monthlySchedule(rows, "2026-10").entries.filter((e) => e.direction === "in");
    expect(oct).toHaveLength(3); // October carries a third check
    expect(oct.every((e) => Math.abs(e.amount - 1187.42) < 0.005)).toBe(true);
  });
});
