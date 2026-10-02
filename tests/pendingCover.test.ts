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

// The gap pendingCover does NOT close, which the sweep found the same day.
//
// coverFor only sees a charge while it is PENDING — a window of a day or three. The
// moment the bank posts it the cover vanishes and finance.next_bills says "overdue"
// again: the same wrong answer, just later. Rent posts two days after it is paid and
// stays unlinked until somebody links it, so the window always closes before the fix
// does.
//
// The posted case is answered by W7 in ledgerReview.ts instead of by a third matcher
// here. These tests pin the SPLIT so neither half quietly grows into the other.
describe("the two halves of 'not actually overdue'", () => {
  const RENT: DueLike = { name: "Rent", amount: 1726.88, due: "2026-10-01", accountId: "joint" };

  it("stops seeing a charge the moment it stops being pending", () => {
    // Not a bug in coverFor — it is handed only the pending rows, by design, because
    // the app excludes pending money from every figure and this exists to explain
    // that exclusion rather than to work around it.
    const pendingRows: PendingLike[] = [
      { date: "2026-10-02", amount: -1732.05, description: "ACH HOLD Nollie MA Rent", accountId: "joint" },
    ];
    expect(coverFor(RENT, pendingRows)).not.toBeNull();
    // Once posted, the caller passes no pending rows for it at all.
    expect(coverFor(RENT, [])).toBeNull();
  });

  it("keeps its own tolerance, which is looser than W7's and must stay separate", () => {
    // pendingCover: 2% or $25, ±7 days — a payment in flight, matched generously
    // because the alternative is telling him to pay rent twice.
    // W7's account arm: 1%, ±3 days — a posted charge, matched strictly because
    // offering a wrong link WRITES something.
    //
    // If these two ever become one number, one of the two jobs is being done wrong.
    expect(tolerance(1726.88)).toBeCloseTo(34.54, 2);
    expect(DAY_WINDOW).toBe(7);
  });
});
