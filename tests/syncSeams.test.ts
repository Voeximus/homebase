// Where two of the 2026-10-25 pieces meet inside the bank sync.
//
// FOUND 2026-10-25 while joining them. The categorizer piece taught the sync to read the
// household's own money out before it files money in, so a refund from a shop the
// household spent at is a refund and not earnings — and it counts this sync's OWN money
// out too, "the same test the posted loop applies", so a purchase and its refund in one
// delta see each other. The closed-debt piece, built at the same time, changed that loop:
// a payment only a CLOSED debt matches is now RECORDED as a bill payment instead of being
// dropped. Joined as they were, the spend history still asked the loop's old question, so
// that payment was written as spending but left out of the history, and a refund from the
// same lender in the same delta was filed as earnings — for good, because a credit keeps
// its category on every re-sync.
//
// The sync is a Deno edge function no test can import, so the question it asks is put
// together here from the same shared functions, and a source check holds the sync to it.
// Every name and amount below is made up — except one of the categorizer's own history
// keys, which is looked up BY LABEL at run time and never spelled (tests/closedDebts.test.ts
// does the same).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  armedTrackedDebts,
  closedDebtPayment,
  closedTrackedDebts,
  trackedDebtFor,
} from "../supabase/functions/_shared/trackedDebts";
import {
  classify,
  classifyCredit,
  creditCategory,
  creditHistoryFrom,
  isPaycheck,
  merchantKey,
} from "../supabase/functions/_shared/categorize.ts";
import { spendHistoryDescriptions } from "../supabase/functions/_shared/seedOnly.ts";
import { MERCHANT_CATEGORY } from "../src/lib/categorizeData";

/** The first history key labelled as a debt that reads back as itself. */
const DEBT_KEY = Object.keys(MERCHANT_CATEGORY).find(
  (k) => MERCHANT_CATEGORY[k].startsWith("Debt:") && merchantKey(k) === k,
)!;

/** A debts row the way the sync's `select *` hands it over. */
const debtRow = (over: Record<string, unknown>) => ({
  id: "closed",
  name: "Finished loan",
  balance: 0,
  track_pattern: DEBT_KEY,
  tracked_baseline: 600,
  tracked_since: "2026-03-01",
  provider_account_id: null,
  closed_at: "2026-10-01T00:00:00.000Z",
  ...over,
});

type Row = { providerTxnId: string; amount: number; description: string; raw?: string };

/** The sync's question for one posted outflow — "will the loop below write this as
 *  spending?" — asked the way plaid/index.ts asks it since the two pieces were joined. */
function writtenAsSpend(debtRows: Record<string, unknown>[], linked: ReadonlySet<string>) {
  const armed = armedTrackedDebts(debtRows as any[]);
  const closed = closedTrackedDebts(debtRows as any[]);
  return (r: Row) =>
    !!trackedDebtFor(armed, r.description) ||
    classify(r.description, r.amount, {}, r.raw).kind !== "skip" ||
    !!closedDebtPayment(closed, r.description, linked.has(r.providerTxnId))?.record;
}

/** The question as it stood when the two pieces met, before the closed-debt arm. */
function writtenAsSpendBefore(debtRows: Record<string, unknown>[]) {
  const armed = armedTrackedDebts(debtRows as any[]);
  return (r: Row) => !!trackedDebtFor(armed, r.description) || classify(r.description, r.amount, {}, r.raw).kind !== "skip";
}

describe("a refund from a closed loan's lender, in the same sync as a payment on the new loan", () => {
  const payment: Row = { providerTxnId: "p-1", amount: -42.5, description: DEBT_KEY };
  const refund: Row = { providerTxnId: "r-1", amount: 18.25, description: DEBT_KEY };
  const delta = [payment, refund];

  it("has what the case needs: the key is dropped by the categorizer, and its credit is money in to be judged", () => {
    // If the data file loses these labels, every test below would pass on nothing.
    expect(DEBT_KEY).toBeTruthy();
    expect(classify(DEBT_KEY, -42.5, {}, DEBT_KEY).kind).toBe("skip");
    expect(classifyCredit(DEBT_KEY)).toBe("income");
    expect(isPaycheck(DEBT_KEY)).toBe(false);
    // And the loop records the payment: no open debt has the pattern, the closed one does.
    expect(closedDebtPayment(closedTrackedDebts([debtRow({})] as any[]), DEBT_KEY, false)?.record).toBeTruthy();
  });

  it("reproduces the failure: the old question leaves the recorded payment out, and the refund is filed as earnings", () => {
    const history = creditHistoryFrom(spendHistoryDescriptions([], delta, writtenAsSpendBefore([debtRow({})])));
    expect(creditCategory(refund.description, undefined, history).categoryId).toBe("other-income");
  });

  it("with the loop's own question, the payment is in the history and the refund is a refund", () => {
    const said = spendHistoryDescriptions([], delta, writtenAsSpend([debtRow({})], new Set()));
    expect(said).toEqual([DEBT_KEY]);
    expect(creditCategory(refund.description, undefined, creditHistoryFrom(said)).categoryId).toBe("refund");
  });

  it("counts nothing the loop does not write — a re-sent, already-linked payment, or a row no closed debt matches", () => {
    // The closed loan's own old payment, re-sent: the loop leaves it exactly as it is and
    // writes nothing new, so it adds nothing here (the ledger's own copy is in the stored
    // half of the history already).
    expect(spendHistoryDescriptions([], delta, writtenAsSpend([debtRow({})], new Set(["p-1"])))).toEqual([]);
    // A closed debt the sync never armed while open (no baseline) records nothing.
    expect(spendHistoryDescriptions([], delta, writtenAsSpend([debtRow({ tracked_baseline: null })], new Set()))).toEqual([]);
    // No debt at all: the categorizer's skip stands, as before.
    expect(spendHistoryDescriptions([], delta, writtenAsSpend([], new Set()))).toEqual([]);
  });
});

describe("the sync asks the spend history's question with the loop's own arguments", () => {
  const src = readFileSync("supabase/functions/plaid/index.ts", "utf8").replace(/\r\n/g, "\n");

  it("the posted half of the spend history includes the closed-debt arm", () => {
    const at = src.indexOf("creditHistory = creditHistoryFrom([");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("]);", at));
    expect(block).toContain("ops.upsertPosted");
    expect(block).toContain("!!matchTrackedDebt(r.description)");
    expect(block).toContain('classify(r.description, r.amount, learned, r.raw).kind !== "skip"');
    expect(block).toContain("closedDebtPayment(closedDebts, r.description, seenProviderIds.has(r.providerTxnId))?.record");
  });

  it("the loop records a closed-debt payment with those same arguments", () => {
    expect(src).toContain("closedDebtPayment(closedDebts, row.description, seenProviderIds.has(row.providerTxnId))");
    // The history is built after the paid-rows scan fills seenProviderIds, and before the loop.
    const filled = src.indexOf("seenProviderIds.add(");
    const history = src.indexOf("creditHistory = creditHistoryFrom([");
    const loop = src.indexOf("for (const row of ops.upsertPosted) {");
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(history);
    expect(history).toBeLessThan(loop);
  });
});
