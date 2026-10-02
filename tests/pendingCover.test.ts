// "Overdue" vs "paid, still clearing" — a word, and a double payment.
//
// Live on 2026-10-02: rent was paid on the 1st, the bank showed it, and
// finance.next_bills reported "overdue $1,726.88" because the charge was still
// pending and the app excludes pending rows from every money calculation. That
// exclusion is correct — a payment in flight can reverse. The word was not.
import { describe, expect, it } from "vitest";
import { coverFor, tolerance, DAY_WINDOW, type DueLike, type PendingLike } from "../src/lib/pendingCover";

const RENT: DueLike = { name: "Rent", amount: 1726.88, due: "2026-10-01", accountId: "joint" };
const pending = (o: Partial<PendingLike>): PendingLike => ({
  date: "2026-10-02", amount: -1732.05, description: "ACH HOLD Nollie MA Rent", accountId: "joint", ...o,
});

describe("coverFor", () => {
  it("finds the rent payment that is clearing, despite the amount drifting", () => {
    // Four months of real rent: 1,731.98 · 1,732.16 · 1,726.88 · 1,732.05. An exact
    // match would miss the one bill that matters most.
    const c = coverFor(RENT, [pending({})])!;
    expect(c.amount).toBe(1732.05);
    expect(c.why).toContain("same account");
  });

  it("will not match across accounts", () => {
    // "Some account paid something like this" is not evidence that THIS bill is
    // covered — and both her account and the joint one are called the same thing.
    expect(coverFor(RENT, [pending({ accountId: "xinyan" })])).toBeNull();
  });

  it("says nothing about a bill whose account nobody has set", () => {
    expect(coverFor({ ...RENT, accountId: null }, [pending({})])).toBeNull();
  });

  it("refuses when two pending charges both fit", () => {
    // Picking the closest would be the door guessing, and a wrong "already paid"
    // causes the exact double payment this prevents, in the other direction.
    expect(coverFor(RENT, [pending({}), pending({ amount: -1730.0 })])).toBeNull();
  });

  it("ignores money coming IN, however close the amount", () => {
    expect(coverFor(RENT, [pending({ amount: 1732.05 })])).toBeNull();
  });

  it("holds the line on size and on timing", () => {
    const room = tolerance(RENT.amount);
    expect(coverFor(RENT, [pending({ amount: -(1726.88 + room - 1) })])).not.toBeNull();
    expect(coverFor(RENT, [pending({ amount: -(1726.88 + room + 1) })])).toBeNull();
    expect(coverFor(RENT, [pending({ date: "2026-10-08" })])).not.toBeNull(); // 7 days
    expect(coverFor(RENT, [pending({ date: "2026-10-09" })])).toBeNull();
    expect(DAY_WINDOW).toBe(7);
  });

  it("keeps a floor so small bills are not matched to the cent", () => {
    // 2% of $27 is 54 cents; without a floor Spotify would almost never match.
    expect(tolerance(27)).toBe(25);
    expect(tolerance(1726.88)).toBeCloseTo(34.54, 2);
  });
});
