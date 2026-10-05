import { describe, it, expect } from "vitest";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { Account, AppData, Debt, Recurring, SavingsGoal, Transaction } from "../src/types";

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

const account = (over: Partial<Account> = {}): Account => ({
  id: "acct",
  name: "Joint",
  owner: "Joint",
  type: "checking",
  balance: 1000,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const debt = (over: Partial<Debt> = {}): Debt => ({
  id: "d",
  name: "Debt",
  balance: 1000,
  originalBalance: 2000,
  color: "#888888",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const goal = (over: Partial<SavingsGoal> = {}): SavingsGoal => ({
  id: "g",
  name: "Goal",
  saved: 100,
  target: 1000,
  icon: "🎯",
  color: "#888888",
  createdAt: "2026-01-01T00:00:00Z",
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

describe("check 8 — a link must point at something that still exists", () => {
  it("catches the real $165 hole: four payments left pointing at a deleted bill", () => {
    // The exact shape the live ledger carried on 2026-09-26. A phantom $35/month
    // card-payment bill was deleted by hand; its four payments stayed behind,
    // pointing at a recurring row that no longer exists. Checks 6 and 7 both read
    // these rows and both step over them in silence (`if (!rec) continue`), so
    // $165 of real spending counted against no budget and settled no bill.
    const gone = "b04df2be-824e-4e71-b332-b6ee07c94944";
    const pay = (id: string, date: string, amount: number, monthKey: string, cat: string) =>
      txn({
        id,
        date,
        amount,
        categoryId: cat,
        description: "Mobile Banking payment to CRD 6813",
        appliesTo: { kind: "bill", recurringId: gone, monthKey, day: 15 },
      });
    const r = selfAudit(
      data({
        transactions: [
          pay("a", "2026-06-15", 85, "2026-06", "other"),
          pay("b", "2026-07-06", 35, "2026-07", "other"),
          pay("c", "2026-08-25", 25, "2026-09", "bills"),
          pay("d", "2026-09-16", 20, "2026-10", "bills"),
        ],
      }),
      NOW,
    );
    const c = byId(r, "links-point-somewhere");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("4 links");
    expect(c.detail).toContain("$165.00"); // the whole hole, in dollars
    expect(c.detail).toContain("2026-06-15"); // the date
    expect(c.detail).toContain("Mobile Banking payment to CRD 6813"); // the description
    expect(c.detail).toContain("$85.00"); // the amount
    expect(c.detail).toContain("deleted bill");
    // Nothing else objects, which is the point: this was invisible to all seven.
    expect(r.failures).toBe(1);
  });

  it("catches a deleted debt", () => {
    const r = selfAudit(
      data({
        transactions: [txn({ id: "x", description: "Extra to Cherry", appliesTo: { kind: "debt", debtId: "gone" } })],
      }),
      NOW,
    );
    const c = byId(r, "links-point-somewhere");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("deleted debt");
    expect(c.detail).toContain("Extra to Cherry");
  });

  it("catches a deleted goal", () => {
    const r = selfAudit(
      data({
        goals: [goal({ id: "kept" })],
        transactions: [txn({ id: "x", description: "To savings", appliesTo: { kind: "goal", goalId: "gone" } })],
      }),
      NOW,
    );
    expect(byId(r, "links-point-somewhere").status).toBe("fail");
    expect(byId(r, "links-point-somewhere").detail).toContain("deleted goal");
  });

  it("catches a reimbursable whose settling credit was deleted", () => {
    const r = selfAudit(
      data({
        transactions: [
          txn({
            id: "front",
            description: "Fronted for Mom",
            categoryId: "bills",
            appliesTo: { kind: "setaside", reason: "reimbursable", settled: true, settledByTxnId: "gone" },
          }),
        ],
      }),
      NOW,
    );
    expect(byId(r, "links-point-somewhere").status).toBe("fail");
    expect(byId(r, "links-point-somewhere").detail).toContain("deleted charge");
  });

  it("catches a charge attributed to a deleted account", () => {
    const r = selfAudit(
      data({
        accounts: [account({ id: "kept" })],
        transactions: [txn({ id: "x", description: "Safeway", accountId: "gone" })],
      }),
      NOW,
    );
    expect(byId(r, "links-point-somewhere").status).toBe("fail");
    expect(byId(r, "links-point-somewhere").detail).toContain("deleted account");
  });

  it("catches a bill whose linked debt was deleted, without claiming money is stranded", () => {
    // A model row, not a ledger row — no dollars are sitting in the wrong place,
    // so the detail must not invent a figure for them.
    const r = selfAudit(
      data({ recurring: [bill({ id: "card", name: "Card payment", linkedDebtId: "gone" })] }),
      NOW,
    );
    const c = byId(r, "links-point-somewhere");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("the bill Card payment points at a deleted debt");
    expect(c.detail).not.toContain("of real spending");
  });

  it("counts LINKS, not rows — one charge can dangle twice", () => {
    // A bill payment on a deleted account, against a deleted bill: two broken
    // links, one row. The count has to say two or the detail is lying about how
    // much is loose.
    const r = selfAudit(
      data({
        transactions: [
          txn({
            id: "x",
            description: "Cherry",
            accountId: "gone",
            appliesTo: { kind: "bill", recurringId: "gone", monthKey: "2026-08", day: 24 },
          }),
        ],
      }),
      NOW,
    );
    const c = byId(r, "links-point-somewhere");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("2 links");
    expect(c.detail).toContain("deleted bill and account");
  });

  it("passes when every link resolves, and says how many it checked", () => {
    const r = selfAudit(
      data({
        accounts: [account()],
        debts: [debt({ id: "cherry-debt" })],
        goals: [goal({ id: "trip" })],
        recurring: [bill({ id: "card", name: "Card payment", linkedDebtId: "cherry-debt" })],
        transactions: [
          txn({ id: "a", accountId: "acct" }),
          txn({ id: "b", accountId: "acct", appliesTo: { kind: "debt", debtId: "cherry-debt" } }),
          txn({ id: "c", accountId: "acct", appliesTo: { kind: "goal", goalId: "trip" } }),
        ],
      }),
      NOW,
    );
    const c = byId(r, "links-point-somewhere");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("All 6 links"); // 3 accountIds + 1 debt + 1 goal + 1 linkedDebtId
  });

  it("passes on an appliesTo that names nothing — a transfer has no ids to dangle", () => {
    const r = selfAudit(data({ transactions: [txn({ id: "x", appliesTo: { kind: "transfer" } })] }), NOW);
    expect(byId(r, "links-point-somewhere").status).toBe("ok");
  });

  it("the healthy household still passes, now across nine checks — the ninth asks whose account paid", () => {
    const r = selfAudit(
      data({
        accounts: [account()],
        recurring: [bill({ id: "rent", name: "Rent", amount: 1732.16, dueDays: [1] })],
        transactions: [txn({ accountId: "acct" })],
      }),
      NOW,
    );
    expect(r.clean).toBe(true);
    expect(r.checks.length).toBe(9);
  });
});

// ── The Cherry double-count, and why it is NOT a check ─────────────────────────
//
// On 24 Sep 2026 the same $151.72 Cherry payment was in the ledger twice: the real
// bank charge claimed the DEBT while a hand-written "(already paid)" marker claimed
// the BILL. No rule was broken — which is the finding. Check 7 cannot see it,
// because the two rows claim different KINDS, and seeing that they are the same
// obligation needs a seven-day date window plus an amount match: two tuned
// constants, in the file whose whole claim is that it has none.
//
// So these tests assert the BOUNDARY rather than a failure. They are the guard
// against someone later slipping a threshold in here, where the screen promises the
// user that anything it reports is certain. The Cherry shape belongs in the
// suggestions layer, which is allowed to be probably-right and says so.
describe("the Cherry shape stays out of the exact layer", () => {
  const cherry = (over: Partial<Recurring> = {}) =>
    bill({ id: "cherry", name: "Cherry", amount: 151.72, dueDays: [24], linkedDebtId: "cherry-debt", ...over });

  const marker = txn({
    id: "manual",
    date: "2026-08-24",
    amount: 151.72,
    categoryId: "bills",
    description: "Cherry (already paid)",
    appliesTo: { kind: "bill", recurringId: "cherry", monthKey: "2026-08", day: 24, settled: true },
  });

  const bankRow = txn({
    id: "bank",
    date: "2026-08-24",
    amount: 151.72,
    categoryId: "bills",
    description: "CHERRY TECHNOLOGIES",
    accountId: "acct",
    provider: "plaid",
    appliesTo: { kind: "debt", debtId: "cherry-debt", settled: true },
  });

  const cherryData = (over: Partial<AppData> = {}) =>
    data({
      accounts: [account()],
      debts: [debt({ id: "cherry-debt", name: "Cherry" })],
      recurring: [cherry()],
      ...over,
    });

  it("the double-count raises NO exact failure — every link resolves and no rule is broken", () => {
    const r = selfAudit(cherryData({ transactions: [marker, bankRow] }), NOW);
    expect(byId(r, "links-point-somewhere").status).toBe("ok");
    expect(byId(r, "one-payment-per-cycle").status).toBe("ok"); // different kinds, invisible to it
    expect(r.failures).toBe(0);
  });

  it("the healthy single-row version passes", () => {
    const r = selfAudit(cherryData({ transactions: [bankRow] }), NOW);
    expect(r.failures).toBe(0);
  });

  it("a hand-written paid marker with no bank charge behind it still passes", () => {
    // Already a documented rejection in this file's header: a manual marker
    // legitimately has no matching charge, so a check on that fires on correct use.
    const r = selfAudit(cherryData({ transactions: [marker] }), NOW);
    expect(r.failures).toBe(0);
  });

  it("a bill with no linked debt is untouched by any of this", () => {
    const r = selfAudit(
      cherryData({
        recurring: [cherry({ linkedDebtId: undefined })],
        transactions: [marker, bankRow],
      }),
      NOW,
    );
    expect(r.failures).toBe(0);
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
