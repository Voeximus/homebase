// The shared list rules (src/lib/activityRules.ts) and the budget card's verdict
// (src/views/redesign/barPct.ts). Invented rows and figures only.
import { describe, it, expect } from "vitest";
import { inActivityLedger, isTransferRow, needsReviewTx, countedTx } from "../src/lib/activityRules";
import { budgetVerdict } from "../src/views/redesign/barPct";
import { transferIds } from "../src/lib/flow";
import type { Transaction } from "../src/types";

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: "t",
  date: "2026-03-10",
  amount: 40,
  type: "expense",
  categoryId: "groceries",
  description: "Corner Market",
  createdAt: "2026-03-10T12:00:00Z",
  ...over,
});

const NONE: ReadonlySet<string> = new Set();

describe("inActivityLedger: which rows the lists show", () => {
  it("lists an ordinary charge", () => {
    expect(inActivityLedger(tx())).toBe(true);
  });

  it("hides an excluded set-aside, settled or not", () => {
    expect(inActivityLedger(tx({ appliesTo: { kind: "setaside", reason: "excluded" } }))).toBe(false);
    expect(inActivityLedger(tx({ appliesTo: { kind: "setaside", reason: "excluded", settled: true } }))).toBe(false);
  });

  it("keeps a reimbursable set-aside until it is paid back, then hides it", () => {
    expect(inActivityLedger(tx({ appliesTo: { kind: "setaside", reason: "reimbursable" } }))).toBe(true);
    expect(
      inActivityLedger(tx({ appliesTo: { kind: "setaside", reason: "reimbursable", settled: true } })),
    ).toBe(false);
  });

  it("lists a bank-feed bill payment even though the feed marks it settled", () => {
    const paid = tx({
      provider: "plaid",
      categoryId: "bills",
      appliesTo: { kind: "bill", recurringId: "r1", monthKey: "2026-03", day: 5, settled: true },
    });
    expect(inActivityLedger(paid)).toBe(true);
  });

  it("lists a bank-feed debt payment marked settled", () => {
    expect(inActivityLedger(tx({ provider: "plaid", appliesTo: { kind: "debt", debtId: "d1", settled: true } }))).toBe(
      true,
    );
  });

  it("hides a hand-typed 'already paid' note (settled, no feed behind it)", () => {
    const note = tx({ appliesTo: { kind: "bill", recurringId: "r1", monthKey: "2026-03", day: 5, settled: true } });
    expect(inActivityLedger(note)).toBe(false);
  });

  it("lists an unsettled hand-typed bill payment", () => {
    expect(inActivityLedger(tx({ appliesTo: { kind: "bill", recurringId: "r1", monthKey: "2026-03" } }))).toBe(true);
  });
});

describe("isTransferRow", () => {
  it("is true for a row linked as a transfer", () => {
    expect(isTransferRow(tx({ appliesTo: { kind: "transfer" } }), NONE)).toBe(true);
  });

  it("is true for a row the pairing marked as moved, and false otherwise", () => {
    expect(isTransferRow(tx({ id: "a" }), new Set(["a"]))).toBe(true);
    expect(isTransferRow(tx({ id: "b" }), new Set(["a"]))).toBe(false);
  });

  it("follows a person's 'moved' override through transferIds", () => {
    const rows = [tx({ id: "m", flowOverride: "moved" }), tx({ id: "s" })];
    const moved = transferIds(rows);
    expect(isTransferRow(rows[0], moved)).toBe(true);
    expect(isTransferRow(rows[1], moved)).toBe(false);
  });
});

describe("needsReviewTx: does a charge ask for a category", () => {
  it("asks when the importer could not tell", () => {
    expect(needsReviewTx(tx({ needsReview: true }), NONE)).toBe(true);
  });

  it("asks about Misc nobody chose, not Misc a person chose", () => {
    expect(needsReviewTx(tx({ categoryId: "other" }), NONE)).toBe(true);
    expect(needsReviewTx(tx({ categoryId: "other", userCategorized: true }), NONE)).toBe(false);
  });

  it("does not ask about a filed charge just because no merchant rule exists", () => {
    expect(needsReviewTx(tx({ categoryId: "dining" }), NONE)).toBe(false);
  });

  it("never asks about a pending hold", () => {
    expect(needsReviewTx(tx({ needsReview: true, pending: true }), NONE)).toBe(false);
    expect(needsReviewTx(tx({ categoryId: "other", pending: true }), NONE)).toBe(false);
  });

  it("never asks about a linked row", () => {
    expect(
      needsReviewTx(tx({ categoryId: "other", appliesTo: { kind: "bill", recurringId: "r1", monthKey: "2026-03" } }), NONE),
    ).toBe(false);
  });

  it("never asks about a split of two or more slices", () => {
    const split = tx({
      needsReview: true,
      splits: [
        { categoryId: "groceries", amount: 25 },
        { categoryId: "pets", amount: 15 },
      ],
    });
    expect(needsReviewTx(split, NONE)).toBe(false);
  });

  it("never asks about money moved between their own accounts", () => {
    expect(needsReviewTx(tx({ id: "x", categoryId: "other" }), new Set(["x"]))).toBe(false);
  });

  it("never asks about income", () => {
    expect(needsReviewTx(tx({ type: "income", categoryId: "other" }), NONE)).toBe(false);
  });
});

describe("countedTx: does the budget count this row", () => {
  it("counts an expense in a graded category", () => {
    expect(countedTx(tx({ categoryId: "groceries" }), NONE)).toBe(true);
  });

  it("does not count a category no line grades", () => {
    expect(countedTx(tx({ categoryId: "education" }), NONE)).toBe(false);
  });

  it("counts a pending charge, as every bar does", () => {
    expect(countedTx(tx({ pending: true }), NONE)).toBe(true);
  });

  it("does not count income, linked rows or transfers", () => {
    expect(countedTx(tx({ type: "income", categoryId: "groceries" }), NONE)).toBe(false);
    expect(countedTx(tx({ appliesTo: { kind: "setaside", reason: "reimbursable" } }), NONE)).toBe(false);
    expect(countedTx(tx({ id: "x" }), new Set(["x"]))).toBe(false);
  });

  it("counts a split when any slice sits in a graded category, whatever the row's own category", () => {
    const split = tx({
      categoryId: "education",
      splits: [
        { categoryId: "education", amount: 30 },
        { categoryId: "pets", amount: 10 },
      ],
    });
    expect(countedTx(split, NONE)).toBe(true);
    const ungraded = tx({
      categoryId: "groceries",
      splits: [
        { categoryId: "education", amount: 30 },
        { categoryId: "car", amount: 10 },
      ],
    });
    expect(countedTx(ungraded, NONE)).toBe(false);
  });
});

describe("budgetVerdict: the one word beside the cycle's number", () => {
  it("is over once spending passes the whole target", () => {
    expect(budgetVerdict(301, 300, 10, 15)).toBe("over");
    expect(budgetVerdict(1, 0, 1, 15)).toBe("over");
  });

  it("is ahead when under the target but past an even pace for the day", () => {
    // Day 1 of 15 on a $300 cycle: an even pace is $20.
    expect(budgetVerdict(150, 300, 1, 15)).toBe("ahead");
    expect(budgetVerdict(20.01, 300, 1, 15)).toBe("ahead");
  });

  it("is ok at or under the pace", () => {
    expect(budgetVerdict(20, 300, 1, 15)).toBe("ok");
    expect(budgetVerdict(150, 300, 8, 15)).toBe("ok");
    expect(budgetVerdict(0, 300, 1, 15)).toBe("ok");
  });

  it("treats exactly the target on the last day as ok, not over", () => {
    expect(budgetVerdict(300, 300, 15, 15)).toBe("ok");
  });

  it("clamps a day outside the cycle instead of producing a negative or inflated pace", () => {
    expect(budgetVerdict(10, 300, 0, 15)).toBe("ahead");
    expect(budgetVerdict(299, 300, 40, 15)).toBe("ok");
  });

  it("falls back to the whole target when the cycle length is unknown", () => {
    expect(budgetVerdict(299, 300, 3, 0)).toBe("ok");
  });

  it("a $0 goal with nothing spent is ok", () => {
    expect(budgetVerdict(0, 0, 5, 15)).toBe("ok");
  });
});
