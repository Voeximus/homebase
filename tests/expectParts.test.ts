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

  it("serialises a jsonb array the same way", () => {
    // `splits` is jsonb, so JSON is the literal Postgres takes. This test used to use
    // `due_days` here — see the next one for why that was the wrong column.
    const { values } = expectParts({ splits: [{ categoryId: "dining", amount: 12 }] });
    expect(values).toEqual([["splits", '[{"categoryId":"dining","amount":12}]']]);
  });

  it("writes due_days as a Postgres array literal, because it is int4[] and not jsonb", () => {
    // FOUND 2026-10-09 while adding finance.set_bill_due_day, the first write that
    // compares on this column. Against the live database: `due_days = '[29]'` is
    // `22P02 malformed array literal`; `due_days = '{29}'` finds the T-Mobile row. The
    // old expectation here was the JSON spelling, which would have made every due-day
    // write — and every undo of one — a 500.
    expect(expectParts({ due_days: [15, 30] }).values).toEqual([["due_days", "{15,30}"]]);
    expect(expectParts({ due_days: [29] }).values).toEqual([["due_days", "{29}"]]);
    // A stored empty array is still an array, and null still goes to .is().
    expect(expectParts({ due_days: [] }).values).toEqual([["due_days", "{}"]]);
    expect(expectParts({ due_days: null }).nulls).toEqual(["due_days"]);
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
