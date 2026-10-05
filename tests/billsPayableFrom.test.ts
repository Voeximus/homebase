// A charge may only settle a bill paid from the account the money left.
//
// FOUND 2026-10-05, in the live ledger. Both of them had Claude Pro in September.
// There is one Claude Pro bill — Xinyan's, paid from her account. The bank sync
// matched bills BY NAME only, so Gino's own $21.62 "Anthropic" charge on the 8th
// settled her bill, and her real $21.62 payment on the 21st was filed as utilities
// spending and linked to nothing. Every integrity check stayed green: nothing was
// paid twice, and every link pointed at something real.
//
// The sync is a Deno edge function no test can import, which is how this lived. So
// the rule is a pure function in the categorizer, and the sync calls it.
import { describe, expect, it } from "vitest";
import { billsPayableFrom, matchRecurringName } from "../src/lib/categorize";

const GINO = "acct-gino";
const XINYAN = "acct-xinyan";
const JOINT = "acct-joint";

const BILLS = [
  { id: "pro", name: "Claude Pro", account_id: XINYAN },
  { id: "rent", name: "Rent", account_id: JOINT },
  { id: "spotify", name: "Spotify", account_id: GINO },
  // A bill nobody has placed on an account yet.
  { id: "vet", name: "Vet", account_id: null },
];

describe("billsPayableFrom", () => {
  it("is the September Claude Pro case: Gino's charge cannot settle Xinyan's bill", () => {
    const payable = billsPayableFrom(BILLS, GINO);
    expect(matchRecurringName("Claude Pro", payable)).toBeNull();
  });

  it("and her own charge still settles it", () => {
    const payable = billsPayableFrom(BILLS, XINYAN);
    expect(matchRecurringName("Claude Pro", payable)?.id).toBe("pro");
  });

  it("keeps every bill on the charge's own account", () => {
    expect(billsPayableFrom(BILLS, JOINT).map((b) => b.id)).toContain("rent");
    expect(billsPayableFrom(BILLS, GINO).map((b) => b.id)).toContain("spotify");
  });

  it("drops every bill on someone else's account", () => {
    const ids = billsPayableFrom(BILLS, GINO).map((b) => b.id);
    expect(ids).not.toContain("pro");
    expect(ids).not.toContain("rent");
  });

  it("never narrows away a bill with no paying account set", () => {
    // Nobody has said where the vet bill comes from, so there is nothing for the
    // charge's account to disagree with. Narrowing it away would stop it ever being
    // paid by anything.
    for (const acct of [GINO, XINYAN, JOINT]) {
      expect(billsPayableFrom(BILLS, acct).map((b) => b.id)).toContain("vet");
    }
  });

  it("does not narrow at all when the charge's account is unknown", () => {
    // A feed row from an account the app has not resolved is not evidence of anything,
    // and filtering on a missing value would drop every placed bill.
    expect(billsPayableFrom(BILLS, null)).toHaveLength(BILLS.length);
    expect(billsPayableFrom(BILLS, undefined)).toHaveLength(BILLS.length);
  });

  it("returns a copy, so a caller filtering it further cannot touch the original list", () => {
    const out = billsPayableFrom(BILLS, null);
    expect(out).not.toBe(BILLS);
    expect(out).toEqual(BILLS);
  });
});
