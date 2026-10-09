// A person's answer on a pending charge must survive the charge posting.
//
// FOUND 2026-10-09. A car repair was filed as `car` by hand on 10-05
// while it was still pending. On 10-06 it posted: Plaid linked the posted charge to the
// pending one through pending_transaction_id, the sync deleted the pending row and
// inserted the posted row fresh, and the fresh row came back as `other` — the $125/mo
// Misc line. Nothing carried the answer across.
//
// The sync is a Deno edge function no test can import, so the two pure halves are
// tested here: reconcile now keeps the pending → posted link it used to throw away,
// and carryCorrection decides what the posted row inherits.
import { describe, expect, it } from "vitest";
import {
  carryCorrection,
  normalize,
  reconcile,
  type NormalRow,
  type PendingCorrection,
  type PlaidTxn,
} from "../supabase/functions/_shared/plaidSync.ts";

const key = (r: NormalRow) => `${r.date}|${r.amount.toFixed(2)}|${r.description}`;

/** The Firestone charge as Plaid delivers it: pending first, then posted naming it. */
const PENDING: PlaidTxn = {
  transaction_id: "pend-firestone",
  pending: true,
  account_id: "acct-joint",
  date: "2026-10-05",
  name: "FIRESTONE #12345",
  merchant_name: "Firestone",
  amount: 412.5,
};
const POSTED: PlaidTxn = {
  ...PENDING,
  transaction_id: "post-firestone",
  pending: false,
  pending_transaction_id: "pend-firestone",
  date: "2026-10-06",
};

const FILED_BY_HAND: PendingCorrection = { categoryId: "car", userCategorized: true, flowOverride: null, splits: null };

describe("reconcile keeps the pending → posted link", () => {
  it("hands the posted row the id of the pending row it replaces", () => {
    // Plaid lists the pending id in `removed` in the same delta, which is the usual shape.
    const ops = reconcile({ added: [POSTED], modified: [], removed: [{ transaction_id: "pend-firestone" }] }, key);
    expect(ops.upsertPosted).toHaveLength(1);
    expect(ops.upsertPosted[0].pendingTxnId).toBe("pend-firestone");
    // …and still queues the pending row for deletion, exactly as before.
    expect(ops.pendingRemove).toContain("pend-firestone");
  });

  it("a row with no pending twin carries no link", () => {
    expect(normalize({ ...POSTED, pending_transaction_id: null }).pendingTxnId).toBeNull();
    expect(normalize(PENDING).pendingTxnId).toBeNull();
  });
});

describe("carryCorrection", () => {
  it("is the Firestone case: a category chosen by hand lands on the posted row", () => {
    // What the sync builds for the posted Firestone charge: an ordinary expense,
    // auto-filed `other`, no bill link.
    const posted = { amount: 412.5, category_id: "other", needs_review: true };
    expect(carryCorrection(posted, FILED_BY_HAND)).toEqual({
      category_id: "car",
      user_categorized: true,
      needs_review: false,
    });
  });

  it("carries a hand-set flow_override", () => {
    expect(carryCorrection({ amount: 40 }, { categoryId: "other", userCategorized: false, flowOverride: "moved", splits: null })).toEqual({
      flow_override: "moved",
    });
  });

  it("carries both together", () => {
    expect(carryCorrection({ amount: 40 }, { ...FILED_BY_HAND, flowOverride: "spent" })).toEqual({
      category_id: "car",
      user_categorized: true,
      needs_review: false,
      flow_override: "spent",
    });
  });

  it("does not carry a category the classifier picked — only one a person picked", () => {
    // The pending row's auto category was a guess about a hold; the posted row has just
    // been classified afresh from the settled descriptor.
    expect(carryCorrection({ amount: 40 }, { categoryId: "shopping", userCategorized: false, flowOverride: null, splits: null })).toBeNull();
  });

  it("carries nothing when there was no pending row with an answer", () => {
    expect(carryCorrection({ amount: 40, category_id: "other" }, undefined)).toBeNull();
  });

  it("lets the sync's own bill or debt match win over a carried category", () => {
    // A posted row the sync matched to a bill carries the bill's category and settles
    // the cycle. Filing it under the pending-time category would leave the rent filed as
    // dining, frozen there by user_categorized.
    const matchedToBill = {
      amount: 1650,
      category_id: "housing",
      applies_to: { kind: "bill", recurringId: "rent", monthKey: "2026-10", day: 1, installmentIndex: 0, settled: true },
    };
    expect(carryCorrection(matchedToBill, { categoryId: "dining", userCategorized: true, flowOverride: null, splits: null })).toBeNull();
    const matchedToDebt = { amount: 85, applies_to: { kind: "debt", debtId: "affirm", settled: true } };
    expect(carryCorrection(matchedToDebt, FILED_BY_HAND)).toBeNull();
  });

  it("still carries a flow_override past a bill match — a hand override outranks a link", () => {
    const matched = { amount: 1650, applies_to: { kind: "bill", recurringId: "rent", settled: true } };
    expect(carryCorrection(matched, { categoryId: "dining", userCategorized: true, flowOverride: "repaid", splits: null })).toEqual({
      flow_override: "repaid",
    });
  });

  it("never hands over an applies_to, whatever the pending row had", () => {
    // A bill link belongs to the settled charge: a hold can still be reversed. The
    // correction type cannot even express one, and the result must not contain one.
    const out = carryCorrection({ amount: 412.5 }, FILED_BY_HAND);
    expect(out).not.toHaveProperty("applies_to");
  });
});

// FOUND 2026-10-09 in review of the first carry, which read no splits: a split made on
// a pending charge reached the posted row as its primary category alone, marked
// user_categorized and needs_review=false — so the other slices were graded against the
// wrong envelope and nothing would ever ask again. A split now carries whole, or the
// posted row asks again; it never turns into one locked category.
describe("carryCorrection with a split pending charge", () => {
  // The reviewer's case: $180 at a warehouse club, split by hand $120 / $60.
  const SPLIT: PendingCorrection = {
    categoryId: "groceries", // the largest slice, as setTransactionSplits sets it
    userCategorized: true,
    flowOverride: null,
    splits: [
      { categoryId: "groceries", amount: 120 },
      { categoryId: "household", amount: 60 },
    ],
  };

  it("carries the slices with the category when the charge posts at the same amount", () => {
    const posted = { amount: 180, category_id: "groceries", needs_review: true };
    expect(carryCorrection(posted, SPLIT)).toEqual({
      category_id: "groceries",
      user_categorized: true,
      needs_review: false,
      splits: [
        { categoryId: "groceries", amount: 120 },
        { categoryId: "household", amount: 60 },
      ],
    });
  });

  it("compares in cents, so float noise in the slices is not a different amount", () => {
    const cents: PendingCorrection = {
      ...SPLIT,
      categoryId: "pets",
      splits: [
        { categoryId: "pets", amount: 39.98 },
        { categoryId: "groceries", amount: 38 },
        { categoryId: "shopping", amount: 14.83 },
      ],
    };
    // 39.98 + 38 + 14.83 is 92.80999999999999 in floating point.
    expect(carryCorrection({ amount: 92.81 }, cents)?.splits).toHaveLength(3);
  });

  it("asks again, carrying no category, when the posted amount no longer fits the split", () => {
    // Posted $5 higher than the hold. The slices add to $180 and the charge is $185,
    // so they cannot be carried; and the primary slice alone, locked as answered,
    // is the bug. The posted row keeps its own category and asks.
    expect(carryCorrection({ amount: 185 }, SPLIT)).toEqual({ needs_review: true });
  });

  it("asks again when the stored split is malformed rather than trusting part of it", () => {
    const broken = { ...SPLIT, splits: [{ categoryId: "groceries", amount: "120" }, { amount: 60 }] };
    expect(carryCorrection({ amount: 180 }, broken)).toEqual({ needs_review: true });
  });

  it("treats a split as a person's answer even on a row missing the user_categorized flag", () => {
    // The sync never writes a split, so one is always a person's. Two posted rows in the
    // live ledger carry splits with user_categorized=false, from before the flag.
    expect(carryCorrection({ amount: 180 }, { ...SPLIT, userCategorized: false })).toMatchObject({
      user_categorized: true,
      splits: SPLIT.splits,
    });
  });

  it("still carries the flow_override when the split cannot carry", () => {
    expect(carryCorrection({ amount: 185 }, { ...SPLIT, flowOverride: "spent" })).toEqual({
      needs_review: true,
      flow_override: "spent",
    });
  });

  it("lets the sync's own bill or debt match win over a split, as over a category", () => {
    const matched = { amount: 180, applies_to: { kind: "bill", recurringId: "costco", settled: true } };
    expect(carryCorrection(matched, SPLIT)).toBeNull();
  });

  it("an empty split is no split: the ordinary category carry applies", () => {
    expect(carryCorrection({ amount: 180 }, { ...SPLIT, splits: [] })).toEqual({
      category_id: "groceries",
      user_categorized: true,
      needs_review: false,
    });
  });
});
