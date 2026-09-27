// The eight lines between a compare-and-set and Postgres.
//
// These exist because of a 500 that had been there since the tool was written.
// `finance.settle_reimbursable` guards on `applies_to`, a jsonb column, and the
// expectation reached PostgREST as a JavaScript object — which goes into the query
// string through String(), so Postgres received `[object Object]` and said `invalid
// input syntax for type json`. Every write guarding on that column was dead.
//
// It survived because the only code that spoke to Postgres lived in a file no test
// could import (it pulls `jsr:@supabase/…` and is excluded from both tsconfigs), and
// the fake database the suite does run against compares the two objects in
// JavaScript, where it works perfectly. The fix was to move the one decision into a
// file with no dependencies at all — this one.
import { describe, expect, it } from "vitest";
import { expectParts } from "../supabase/functions/muse-write/expectParts.ts";

describe("expectParts", () => {
  it("serialises an object, because eq() stringifies whatever it is given", () => {
    const appliesTo = { kind: "setaside", reason: "reimbursable", settled: true };
    const { values } = expectParts({ applies_to: appliesTo });
    expect(values).toEqual([["applies_to", JSON.stringify(appliesTo)]]);
    // The actual failure, spelled out: this is what Postgres used to be sent.
    expect(String(appliesTo)).toBe("[object Object]");
    expect(values[0][1]).not.toBe("[object Object]");
  });

  it("serialises an array the same way", () => {
    const { values } = expectParts({ due_days: [15, 30] });
    expect(values).toEqual([["due_days", "[15,30]"]]);
  });

  it("sends null to .is(), never to .eq()", () => {
    // PostgREST renders eq(null) as `=null`, which matches nothing in SQL. An
    // expectation of null spelled with eq would refuse every write, and each tool
    // would report "something changed that row" about a row nothing had touched.
    const { nulls, values } = expectParts({ applies_to: null });
    expect(nulls).toEqual(["applies_to"]);
    expect(values).toEqual([]);
  });

  it("leaves the scalars alone", () => {
    const { nulls, values } = expectParts({ amount: 92.08, active: false, name: "Rent" });
    expect(nulls).toEqual([]);
    expect(values).toEqual([["amount", 92.08], ["active", false], ["name", "Rent"]]);
  });

  it("splits a mixed expectation into both halves", () => {
    const { nulls, values } = expectParts({ applies_to: null, category_id: "dining", splits: [{ a: 1 }] });
    expect(nulls).toEqual(["applies_to"]);
    expect(values).toEqual([["category_id", "dining"], ["splits", '[{"a":1}]']]);
  });
});
