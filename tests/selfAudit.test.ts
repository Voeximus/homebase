import { describe, it, expect } from "vitest";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData, Recurring, Transaction } from "../src/types";

const NOW = new Date(2026, 7, 18, 12); // Aug 18 2026, local noon

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "b",
  name: "Bill",
  amount: 100,
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

const byId = (r: ReturnType<typeof selfAudit>, id: string) => r.checks.find((c) => c.id === id)!;

describe("selfAudit — healthy data says nothing", () => {
  it("a well-formed household passes every check", () => {
    const r = selfAudit(
      data({
        recurring: [
          bill({ id: "rent", name: "Rent", amount: 1732.16, dueDays: [1] }),
          bill({ id: "mom", name: "Mom", amount: 600, dueDays: [15, 30] }),
          bill({ id: "ins", name: "Insurance", amount: 639.42, cadence: "semiannual", anchorDate: "2026-08-01", dueDays: [1] }),
        ],
        transactions: [txn()],
      }),
      NOW,
    );
    expect(r.clean).toBe(true);
    expect(r.failures).toBe(0);
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
  });

  it("the real budget configuration is internally consistent", () => {
    // Guards the shipped LEAN_VARIABLE + OUTSIDE_BUDGET_CASH_CATS against each
    // other, which is the pairing the `utilities` hole slipped through.
    const r = selfAudit(data(), NOW);
    expect(byId(r, "no-orphan-categories").status).toBe("ok");
    expect(byId(r, "lines-sum-to-envelope").status).toBe("ok");
  });
});

describe("check 1 — a bill the budget charges but the calendar never shows", () => {
  it("catches an active bill with no due day", () => {
    // monthlySchedule sends a row with no due days to `unscheduled`, so it never
    // appears on the Bills calendar — while monthlyAmount still charges it
    // against firepower. Budgeted and invisible at the same time.
    const r = selfAudit(
      data({ recurring: [bill({ id: "ghost", name: "Ghost bill", amount: 250, dueDays: undefined })] }),
      NOW,
    );
    const c = byId(r, "schedule-vs-plan");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Ghost bill");
    expect(r.clean).toBe(false);
  });

  it("does NOT fire on a biweekly row — that gap is convention 1", () => {
    // monthlyAmount uses x2 while the calendar places real 14-day dates, so a
    // year holds ~26 payments against 24 budgeted. Deliberate conservatism, so
    // flagging it would be crying wolf about a design decision.
    const r = selfAudit(
      data({
        recurring: [
          bill({ id: "pay", name: "Paycheck", amount: 1187.42, direction: "in", cadence: "biweekly", anchorDate: "2026-08-07", dueDays: undefined }),
        ],
      }),
      NOW,
    );
    expect(byId(r, "schedule-vs-plan").status).toBe("ok");
  });

  it("does NOT fire on a windowed bill — that divergence is documented", () => {
    const r = selfAudit(
      data({ recurring: [bill({ id: "car", name: "Car payment", amount: 232.67, dueDays: [30], startsOn: "2026-09-30" })] }),
      NOW,
    );
    expect(byId(r, "schedule-vs-plan").status).toBe("ok");
  });

  it("does NOT fire on a periodic bill, whose lump averages out over a year", () => {
    const r = selfAudit(
      data({
        recurring: [
          bill({ id: "y", name: "Membership", amount: 16.22, cadence: "yearly", anchorDate: "2026-06-16", dueDays: [16] }),
        ],
      }),
      NOW,
    );
    expect(byId(r, "schedule-vs-plan").status).toBe("ok");
  });
});

describe("check 2 — a budget bar must equal the charges it lists", () => {
  it("passes with a still-processing charge present", () => {
    // The regression guard: the drill-in once counted pending charges the bar
    // excluded, so the rows never summed to their own header.
    const r = selfAudit(
      data({ transactions: [txn({ id: "a", amount: 40 }), txn({ id: "b", amount: 180, pending: true })] }),
      NOW,
    );
    expect(byId(r, "bar-vs-rows").status).toBe("ok");
  });

  it("passes with a bill payment present, which is not variable spend", () => {
    const r = selfAudit(
      data({
        transactions: [
          txn({ id: "a", amount: 40 }),
          txn({ id: "b", amount: 500, appliesTo: { kind: "bill", recurringId: "rent", monthKey: "2026-08", day: 1 } }),
        ],
      }),
      NOW,
    );
    expect(byId(r, "bar-vs-rows").status).toBe("ok");
  });

  it("passes with a split charge, counting only the slices each line claims", () => {
    const r = selfAudit(
      data({
        transactions: [
          txn({
            id: "s",
            amount: 100,
            splits: [
              { categoryId: "groceries", amount: 70 },
              { categoryId: "pets", amount: 30 },
            ],
          }),
        ],
      }),
      NOW,
    );
    expect(byId(r, "bar-vs-rows").status).toBe("ok");
  });
});

describe("check 5 — a split must not resize the charge", () => {
  it("catches slices that do not sum to what was paid", () => {
    const r = selfAudit(
      data({
        transactions: [
          txn({
            id: "bad",
            amount: 100,
            description: "Costco",
            splits: [
              { categoryId: "groceries", amount: 60 },
              { categoryId: "pets", amount: 25 }, // 85 != 100
            ],
          }),
        ],
      }),
      NOW,
    );
    const c = byId(r, "splits-sum");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Costco");
    expect(c.detail).toContain("15.00"); // names the gap in real dollars
  });

  it("tolerates float noise below half a cent", () => {
    const r = selfAudit(
      data({
        transactions: [
          txn({
            id: "ok",
            amount: 100,
            splits: [
              { categoryId: "groceries", amount: 33.333 },
              { categoryId: "pets", amount: 33.333 },
              { categoryId: "dining", amount: 33.334 },
            ],
          }),
        ],
      }),
      NOW,
    );
    expect(byId(r, "splits-sum").status).toBe("ok");
  });
});

describe("every check is EXACT — no thresholds to argue with", () => {
  it("reports a clean run without inventing warnings", () => {
    const r = selfAudit(data(), NOW);
    // No "warn" tier exists on purpose: a check that can only say "probably"
    // does not belong in this file.
    expect(r.checks.every((c) => c.status === "ok" || c.status === "fail")).toBe(true);
  });

  it("every check states its question in plain language", () => {
    for (const c of selfAudit(data(), NOW).checks) {
      expect(c.question.length).toBeGreaterThan(10);
      expect(c.question.endsWith("?")).toBe(true);
      expect(c.detail.length).toBeGreaterThan(10);
    }
  });
});
