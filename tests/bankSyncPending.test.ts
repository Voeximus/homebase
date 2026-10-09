// A Zelle between their own accounts must not show as spending while it processes.
//
// FOUND 2026-10-04. Xinyan Zelled Gino $250 and $50. Both accounts are synced, so each
// Zelle arrived twice while pending, and the pending path filed the sending half as an
// expense — the learned rule 'ZELLE TRANSFER' -> shopping fired, because that bare key
// is all the pending wording "Zelle Transfer CONF# …; GIO" gives a merchant lookup —
// and the receiving half as other-income. For a day the ledger carried $300 of
// spending and $300 of income that never happened.
//
// The POSTED twins were dropped on arrival, by classify() and classifyCredit() reading
// the "Internal: spouse" history labels — which are written against the posted
// wording, "Zelle payment to GIO" / "Zelle payment from XINYAN LI". So the fix asks
// the posted path's own test in the posted path's own words; these tests pin both
// that the internal pair now drops and that a Zelle to anyone else still lands.
import { describe, expect, it } from "vitest";
import { classify, classifyCredit, type LearnedRules } from "../supabase/functions/_shared/categorize.ts";
import { normalize, type PlaidTxn } from "../supabase/functions/_shared/plaidSync.ts";
import { pendingFields, postedZelleWording } from "../supabase/functions/_shared/pendingRow.ts";

// The two live merchant rules that touch these rows (merchant_rules, 2026-10-09).
const LEARNED: LearnedRules = {
  "ZELLE TRANSFER": { kind: "variable", categoryId: "shopping" },
  "ZELLE PAYMENT TO YINAN LI": { kind: "variable", categoryId: "dining" },
};

/** A pending Plaid row. Plaid's sign: + is money OUT of the account. */
const pending = (name: string, plaidAmount: number, account = "acct-xinyan"): PlaidTxn => ({
  transaction_id: `p-${name}-${plaidAmount}`,
  pending: true,
  account_id: account,
  date: "2026-10-04",
  name,
  merchant_name: null,
  amount: plaidAmount,
});

const fields = (t: PlaidTxn) => pendingFields(normalize(t), LEARNED);

describe("pending internal Zelles are dropped, both halves", () => {
  it("the $250: the sending half on Xinyan's account is not spending", () => {
    expect(fields(pending("Zelle Transfer CONF# TESTPAIR1; GIO", 250, "acct-xinyan"))).toBeNull();
  });

  it("the $250: the receiving half on Gino's account is not income", () => {
    expect(fields(pending("Zelle Transfer Conf# TESTPAIR1; XINYAN LI", -250, "acct-gino"))).toBeNull();
  });

  it("the $50 pair, the same", () => {
    expect(fields(pending("Zelle Transfer CONF# TESTPAIR2; GIO", 50, "acct-xinyan"))).toBeNull();
    expect(fields(pending("Zelle Transfer Conf# TESTPAIR2; XINYAN LI", -50, "acct-gino"))).toBeNull();
  });

  it("is the posted path's test, not a second one: the posted twins drop for the same reason", () => {
    // What the posted path runs on these same two Zelles once they settle.
    expect(classify("Zelle payment to GIO Conf# testpair1", -250, LEARNED, "Zelle payment to GIO Conf# testpair1").kind).toBe("skip");
    expect(classifyCredit("Zelle payment from XINYAN LI Conf# testpair1")).toBe("transfer");
    // …and the pending wording is translated into exactly those words.
    expect(postedZelleWording("Zelle Transfer CONF# TESTPAIR1; GIO", -250)).toBe("Zelle payment to GIO Conf# TESTPAIR1");
    expect(postedZelleWording("Zelle Transfer Conf# TESTPAIR1; XINYAN LI", 250)).toBe(
      "Zelle payment from XINYAN LI Conf# TESTPAIR1",
    );
  });
});

describe("a Zelle to anyone outside the household is still recorded", () => {
  it("money out to a third party stays an expense, filed as before", () => {
    // A real $40 that left the household, to someone with no internal label.
    expect(fields(pending("Zelle Transfer CONF# TESTSOLO1; SAM SAMPLE", 40))).toEqual({
      type: "expense",
      amount: 40,
      category_id: "shopping",
      needs_review: false,
    });
  });

  it("money in from a third party stays income", () => {
    expect(fields(pending("Zelle Transfer Conf# TESTSOLO2; YINAN LI", -20))).toEqual({
      type: "income",
      amount: 20,
      category_id: "other-income",
      needs_review: false,
    });
  });

  it("a name the posted path has its own rule for is not dropped by it", () => {
    // 'ZELLE PAYMENT TO YINAN LI' -> dining is a variable rule, not a skip, so the
    // posted-wording test says "keep", and the row is filed as before.
    expect(fields(pending("Zelle Transfer CONF# TESTCODE1; YINAN LI", 30))?.type).toBe("expense");
  });
});

describe("postedZelleWording", () => {
  it("reads the direction from the amount's sign, which the pending text does not carry", () => {
    expect(postedZelleWording("Zelle Transfer Conf# ABC123; SOMEONE", -1)).toBe("Zelle payment to SOMEONE Conf# ABC123");
    expect(postedZelleWording("Zelle Transfer Conf# ABC123; SOMEONE", 1)).toBe("Zelle payment from SOMEONE Conf# ABC123");
  });

  it("leaves everything that is not the pending Zelle wording alone", () => {
    expect(postedZelleWording("Zelle payment to GIO Conf# testpair1", -250)).toBeNull();
    expect(postedZelleWording("Corner Bakery", -8.5)).toBeNull();
    expect(postedZelleWording(undefined, -1)).toBeNull();
    expect(postedZelleWording("Zelle Transfer Conf# ABC123; SOMEONE", 0)).toBeNull();
  });

  it("finds the bank's wording in the raw line if Plaid ever sends a clean merchant name", () => {
    const t = { ...pending("Zelle Transfer CONF# TESTPAIR1; GIO", 250), merchant_name: "Zelle" };
    expect(fields(t)).toBeNull();
  });
});

describe("everything else the pending path decides, unchanged by the move", () => {
  it("a pending bill is filed under bills, never the graded Misc line", () => {
    expect(fields(pending("Spot Pet Insurance", 99.93))?.category_id).toBe("bills");
  });

  it("a pending paycheck is salary", () => {
    expect(fields(pending("ACME CORP DES:PAYROLL", -1500, "acct-gino"))?.category_id).toBe("salary");
  });

  it("a pending internal account transfer in is still dropped", () => {
    expect(fields(pending("TRANSFER FROM ACCT #1211 ON 09/10 VIA WEB", -39, "acct-gino"))).toBeNull();
  });

  it("an unknown merchant is an expense at low confidence", () => {
    expect(fields(pending("SOME NEW PLACE", 12.5))).toEqual({
      type: "expense",
      amount: 12.5,
      category_id: "other",
      needs_review: true,
    });
  });
});
