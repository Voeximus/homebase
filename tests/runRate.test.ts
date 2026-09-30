// The three wrong answers this module exists to prevent.
//
// Each test below is a real failure from 2026-09-30, when "what do we net per month"
// was answered three different ways in one conversation — none of them an arithmetic
// error, all of them correct sums of the wrong rows.
import { describe, expect, it } from "vitest";
import { flowOf, ownAccountsFrom, classify } from "../src/lib/flow";
import { runRate, ONE_OFF_FLOOR } from "../src/lib/runRate";
import type { Account, Transaction } from "../src/types";

const ACCOUNTS: Account[] = [
  { id: "chk-g", name: "Adv Plus Banking", owner: "Gino", last4: "1234", type: "checking", balance: 0, sortOrder: 0, createdAt: "" },
  { id: "card-g", name: "BankAmericard", owner: "Gino", last4: "4728", type: "credit card", balance: 0, sortOrder: 1, createdAt: "" },
  { id: "card-x", name: "Travel Rewards", owner: "Xinyan", last4: "6813", type: "credit card", balance: 0, sortOrder: 2, createdAt: "" },
];

const txn = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2),
  date: "2026-08-15",
  amount: 10,
  type: "expense",
  categoryId: "groceries",
  description: "Shop",
  ...o,
});

describe("flowOf", () => {
  const own = ownAccountsFrom(ACCOUNTS);

  it("does not count a deposit landing on a credit card as income", () => {
    // THE WORST OF THE THREE. Both cards are synced, so one $2,500 payment appeared
    // twice — leaving checking and arriving at the card — and inflated that month's
    // income AND its spending by $2,500 at the same time.
    const v = flowOf(txn({ type: "income", amount: 2500, accountId: "card-g", description: "PENDING PAYMENT" }), own);
    expect(v.flow).toBe("moved");
    expect(v.why).toContain("other half");
  });

  it("treats a payment naming one of their own accounts as repayment, not spending", () => {
    for (const d of ["PAYMENT TO ACCT #4728 ON 09/30 VIA WEB", "Mobile Banking payment to CRD 6813 Conf"]) {
      const v = flowOf(txn({ amount: 2500, accountId: "chk-g", description: d }), own);
      expect(v.flow, d).toBe("repaid");
      expect(v.why, d).toMatch(/4728|6813/);
    }
  });

  it("knows the lenders that are not synced accounts", () => {
    expect(flowOf(txn({ description: "Affirm", amount: 159.17 }), own).flow).toBe("repaid");
    expect(flowOf(txn({ description: "Cherry Technol", amount: 151.72 }), own).flow).toBe("repaid");
  });

  it("does not count a refund as earnings", () => {
    // Counting it would count the same dollar twice — once going out as spending,
    // once coming back.
    expect(flowOf(txn({ type: "income", categoryId: "refund", amount: 47.5, accountId: "chk-g" }), own).flow).toBe("returned");
  });

  it("lets what the app was told beat what a descriptor looks like", () => {
    // A link is somebody's decision; a descriptor is a bank's prose.
    const v = flowOf(txn({ description: "PAYMENT TO ACCT #4728", appliesTo: { kind: "transfer" } as never }), own);
    expect(v.flow).toBe("moved");
    expect(v.why).toContain("recorded in the app");
  });

  it("calls an ordinary charge ordinary, and a paycheck earnings", () => {
    expect(flowOf(txn({ description: "Sam's Club", amount: 59 }), own).flow).toBe("spent");
    expect(flowOf(txn({ type: "income", amount: 1187.42, accountId: "chk-g", description: "ARIZONA STATE UN DES:PAYROLL" }), own).flow).toBe("earned");
  });

  it("attaches a reason to every single verdict", () => {
    for (const { verdict } of classify([txn({}), txn({ type: "income", accountId: "chk-g" })], ACCOUNTS)) {
      expect(verdict.why.length).toBeGreaterThan(8);
    }
  });
});

describe("runRate", () => {
  const paycheck = (date: string, amount = 2000) =>
    txn({ date, type: "income", amount, accountId: "chk-g", description: "PAYROLL" });
  const shop = (date: string, amount: number, description = "Sam's Club") =>
    txn({ date, amount, description, accountId: "chk-g" });

  it("leaves the current month out, because a partial month is not a month", () => {
    // A partial month carries a full rent and half an income, so it always reads as a
    // disaster. September was quoted mid-flight as evidence of one.
    const r = runRate([paycheck("2026-08-01"), shop("2026-08-02", 100), paycheck("2026-09-01")], ACCOUNTS, "2026-09-30");
    expect(r.months.map((m) => m.month)).toEqual(["2026-08"]);
  });

  it("keeps a card payment out of both sides of the month", () => {
    const rows = [
      paycheck("2026-08-01"),
      txn({ date: "2026-08-17", amount: 2500, accountId: "chk-g", description: "PAYMENT TO ACCT #4728" }),
      txn({ date: "2026-08-17", amount: 2500, type: "income", accountId: "card-g", description: "PENDING PAYMENT" }),
    ];
    const r = runRate(rows, ACCOUNTS, "2026-09-15");
    expect(r.months[0].earned).toBe(2000); // not 4500
    expect(r.months[0].spent).toBe(0); // not 2500
    expect(r.months[0].net).toBe(2000);
  });

  it("separates a one-off instead of letting it define the month", () => {
    // August 2026, exactly: a $1,250 car down payment turned an ordinary month into a
    // reported $1,225 loss, and that number was repeated twice before he caught it.
    const rows = [
      paycheck("2026-08-01", 2000),
      shop("2026-08-05", 1900),
      txn({ date: "2026-08-17", amount: 1250, accountId: "chk-g", description: "The Watkins Team at Courtesy CDJR" }),
      paycheck("2026-07-01", 2000),
      shop("2026-07-05", 1900),
    ];
    const r = runRate(rows, ACCOUNTS, "2026-09-15");
    const aug = r.months.find((m) => m.month === "2026-08")!;
    expect(aug.net).toBe(-1150); // what a raw sum says
    expect(aug.netOngoing).toBe(100); // what an ordinary month of this shape is
    expect(aug.oneOffs).toHaveLength(1);
    expect(aug.oneOffs[0].description).toContain("Watkins");
    // And the RATE quotes the ongoing figure, or a car purchase lands in every
    // future month forever.
    expect(r.perMonth).toBe(100);
  });

  it("does not call a repeat visit a one-off, however large", () => {
    const rows = [
      shop("2026-07-05", 900, "Costco"),
      shop("2026-08-05", 900, "Costco"),
      paycheck("2026-07-01"), paycheck("2026-08-01"),
    ];
    const r = runRate(rows, ACCOUNTS, "2026-09-15");
    expect(r.months.every((m) => m.oneOffs.length === 0)).toBe(true);
  });

  it("does not call small rare spending unusual", () => {
    // Without a size floor every restaurant visited once becomes "unusual" and the
    // list runs to hundreds of lines, which is worse than no list.
    const r = runRate([paycheck("2026-08-01"), shop("2026-08-06", ONE_OFF_FLOOR - 1, "A One-Time Cafe")], ACCOUNTS, "2026-09-15");
    expect(r.months[0].oneOffs).toEqual([]);
  });

  it("hands back every row it left out, with the rule that left it out", () => {
    // The load-bearing property. A number that shows its inputs can be wrong out loud.
    const rows = [
      paycheck("2026-08-01"),
      txn({ date: "2026-08-17", amount: 300, accountId: "chk-g", description: "PAYMENT TO ACCT #4728" }),
      txn({ date: "2026-08-10", amount: 159.17, accountId: "chk-g", description: "Affirm" }),
    ];
    const r = runRate(rows, ACCOUNTS, "2026-09-15");
    const repaid = r.excluded.find((e) => e.flow === "repaid")!;
    expect(repaid.total).toBe(459.17);
    expect(repaid.rows).toHaveLength(2);
    for (const row of repaid.rows) expect(row.why.length).toBeGreaterThan(8);
  });
});

describe("what the first live run caught", () => {
  const ACC: Account[] = [
    { id: "chk", name: "Checking", owner: "Gino", last4: "1234", type: "checking", balance: 0, sortOrder: 0, createdAt: "" },
  ];
  const t = (o: Partial<Transaction>): Transaction => ({
    id: Math.random().toString(36).slice(2), date: "2026-08-01", amount: 10, type: "expense",
    categoryId: "housing", description: "x", accountId: "chk", ...o,
  });

  it("does not call rent a one-off because the bank changes its reference every month", () => {
    // The actual first output of this module: rent appeared as a one-off in July AND
    // August, because "Nollie MA DES:Rent ID:XXXXX7762" and "ID:XXXXX6948" are
    // different strings. $1,732 was pulled out of two months as unusual spending.
    const rows = [
      t({ date: "2026-07-01", amount: 1731.98, description: "Nollie MA DES:Rent ID:XXXXX7762 INDN:GIO" }),
      t({ date: "2026-08-03", amount: 1732.16, description: "Nollie MA DES:Rent ID:XXXXX6948 INDN:GIO" }),
      t({ date: "2026-07-01", amount: 4000, type: "income", description: "PAYROLL" }),
      t({ date: "2026-08-01", amount: 4000, type: "income", description: "PAYROLL" }),
    ];
    const r = runRate(rows, ACC, "2026-09-15");
    expect(r.months.flatMap((m) => m.oneOffs)).toEqual([]);
  });

  it("never calls a charge linked to a bill a one-off, whatever its descriptor says", () => {
    const rows = [
      t({ date: "2026-08-01", amount: 1726.88, description: "totally unique string 999", appliesTo: { kind: "bill" } as never }),
      t({ date: "2026-08-01", amount: 4000, type: "income", description: "PAYROLL" }),
    ];
    expect(runRate(rows, ACC, "2026-09-15").months[0].oneOffs).toEqual([]);
  });
});

describe("the two true answers", () => {
  const ACC: Account[] = [
    { id: "chk", name: "Checking", owner: "Gino", last4: "1234", type: "checking", balance: 0, sortOrder: 0, createdAt: "" },
    { id: "card", name: "Card", owner: "Gino", last4: "4728", type: "credit card", balance: 0, sortOrder: 1, createdAt: "" },
  ];
  const t = (o: Partial<Transaction>): Transaction => ({
    id: Math.random().toString(36).slice(2), date: "2026-08-10", amount: 10, type: "expense",
    categoryId: "other", description: "x", accountId: "chk", ...o,
  });

  it("separates what they are worth from what is in the account", () => {
    // A card payment cancels debt with cash. Net worth is unchanged; the checking
    // balance is $2,500 lighter. Reporting either figure alone under the name "what
    // we net" is how one question got three different answers.
    const rows = [
      t({ amount: 4000, type: "income", description: "PAYROLL" }),
      // Kept under ONE_OFF_FLOOR deliberately: in a one-month window ANY large rare
      // charge is a one-off by construction, which would send perMonth to the ongoing
      // figure and make this test about one-off detection instead of about cash.
      t({ amount: 400, description: "Groceries" }),
      t({ amount: 2500, description: "PAYMENT TO ACCT #4728" }),
      t({ amount: 2500, type: "income", accountId: "card", description: "PENDING PAYMENT" }),
    ];
    const r = runRate(rows, ACC, "2026-09-15");
    const m = r.months[0];
    expect(m.net).toBe(3600); // 4000 earned − 400 spent; the card payment is not spending
    expect(m.cashChange).toBe(1100); // 4000 in, 400 + 2500 out of checking
    expect(r.perMonth).toBe(3600);
    expect(r.cashPerMonth).toBe(1100);
  });

  it("does not let the card's own rows touch the cash figure", () => {
    const rows = [
      t({ amount: 4000, type: "income", description: "PAYROLL" }),
      t({ amount: 300, accountId: "card", description: "Something bought on the card" }),
    ];
    const r = runRate(rows, ACC, "2026-09-15");
    expect(r.months[0].cashChange).toBe(4000); // the card purchase took no cash
    expect(r.months[0].net).toBe(3700); // but it was still spending
  });
});
