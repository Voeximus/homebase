// settled-means-settled prices a bill per installment (P1), and the sentences agree
// in number with how many offenders there are (P4). Invented bills and amounts only.
import { describe, it, expect } from "vitest";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData, Recurring, Transaction } from "../src/types";

const NOW = new Date(2026, 7, 18, 12); // Aug 18 2026, local noon

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "b",
  name: "Bill",
  amount: 100,
  categoryId: "bills",
  direction: "out",
  cadence: "monthly",
  active: true,
  dueDays: [15],
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  id: "t",
  date: "2026-08-16",
  amount: 50,
  type: "expense",
  categoryId: "groceries",
  description: "Store",
  createdAt: "2026-08-16T12:00:00Z",
  ...over,
});

const data = (over: Partial<AppData> = {}): AppData => ({
  transactions: [],
  debts: [],
  goals: [],
  categories: DEFAULT_CATEGORIES,
  accounts: [],
  recurring: [],
  paidBills: [],
  merchantRules: [],
  foods: [],
  ...over,
});

const settled = (id: string, recurringId: string, day: number, amount: number, monthKey = "2026-08") =>
  txn({
    id,
    date: `${monthKey}-${String(day).padStart(2, "0")}`,
    amount,
    categoryId: "bills",
    appliesTo: { kind: "bill", recurringId, monthKey, day, settled: true },
  });

const check = (d: AppData, id: string) => selfAudit(d, NOW).checks.find((c) => c.id === id)!;

describe("settled-means-settled: one installment is priced as one installment", () => {
  it("a semimonthly row's amount is already per payment, so it is not divided again", () => {
    const semi = bill({ id: "semi", name: "Semi", amount: 90, cadence: "semimonthly", dueDays: [1, 16] });
    // $45 would be 'paid in full' only if the check wrongly halved a per-payment amount.
    const c = check(data({ recurring: [semi], transactions: [settled("s1", "semi", 16, 45)] }), "settled-means-settled");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("$45.00 of $90.00");
  });

  it("a single-day monthly bill is still compared with its whole price", () => {
    const one = bill({ id: "one", name: "Once", amount: 300, dueDays: [20] });
    const c = check(data({ recurring: [one], transactions: [settled("o1", "one", 20, 150)] }), "settled-means-settled");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("$150.00 of $300.00");
  });

  it("knownAmount wins over amount and is split across the due days the same way", () => {
    const k = bill({ id: "k", name: "Known", amount: 500, knownAmount: 400, dueDays: [10, 25] });
    const c = check(data({ recurring: [k], transactions: [settled("k1", "k", 10, 200)] }), "settled-means-settled");
    expect(c.status).toBe("ok");
  });

  it("two short cycles name the largest gap, with thousands separators", () => {
    const big = bill({ id: "big", name: "Big", amount: 2400, dueDays: [20] });
    const small = bill({ id: "small", name: "Small", amount: 100, dueDays: [22] });
    const c = check(
      data({
        recurring: [big, small],
        transactions: [settled("b1", "big", 20, 1000), settled("m1", "small", 22, 90)],
      }),
      "settled-means-settled",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/^2 bill cycles are marked paid/);
    expect(c.detail).toContain("the largest by $1,400.00");
    expect(c.detail).toContain("only $1,000.00 of $2,400.00");
  });
});

describe("one offender reads in the singular", () => {
  it("a single split that does not add up says 'does' and 'off by', never 'the largest'", () => {
    const c = check(
      data({
        transactions: [
          txn({
            id: "sp",
            amount: 80,
            splits: [
              { categoryId: "groceries", amount: 50 },
              { categoryId: "pets", amount: 20 },
            ],
          }),
        ],
      }),
      "splits-sum",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/^1 split charge does not sum to the amount paid, off by \$10\.00:/);
    expect(c.detail).not.toContain("the largest");
  });

  it("two splits that do not add up say 'do' and name the largest", () => {
    const bad = (id: string, amount: number, a: number, b: number) =>
      txn({
        id,
        amount,
        splits: [
          { categoryId: "groceries", amount: a },
          { categoryId: "pets", amount: b },
        ],
      });
    const c = check(data({ transactions: [bad("x", 80, 50, 20), bad("y", 60, 30, 5)] }), "splits-sum");
    expect(c.detail).toMatch(/^2 split charges do not sum to the amount paid, the largest by \$25\.00:/);
  });
});
