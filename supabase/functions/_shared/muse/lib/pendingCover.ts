// GENERATED — DO NOT EDIT. Source: src/lib/pendingCover.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/pendingCover.ts
// and re-run the generator.
// Is a bill that looks overdue actually paid and still clearing?
//
// THE SITUATION THIS EXISTS FOR, observed live on 2026-10-02. Rent was paid on the
// 1st. The bank showed it. The ledger showed it. And `finance.next_bills` reported
// "overdue $1,726.88", because the charge was still PENDING and the app deliberately
// excludes pending rows from every money calculation — a payment in flight can be
// reversed, so counting it as spent would be a guess dressed as a fact.
//
// That exclusion is right and this does not change it. What was wrong was the WORD.
// "Overdue" means you forgot; "paid, still clearing" means you did not. The app had
// the second fact and said the first, and anybody asking "what do I still owe" would
// have been told to pay rent twice.
//
// SO THIS ASSERTS NOTHING AND SETTLES NOTHING. It does not mark a bill paid, does not
// link a charge, and does not move a number. It answers one question — is there a
// payment in flight that looks like this bill — so the reply can say so alongside the
// unchanged figure. The bill stays unpaid until the charge posts and is linked, which
// is the only evidence that actually proves it.
//
// WHY NOT JUST LINK THE PENDING CHARGE. Because it will not survive. When a pending
// charge posts, Plaid ties the posted row to it and the sync DELETES the pending row
// and inserts the posted one (supabase/functions/plaid/index.ts:710-712). A link
// written onto a pending row dies with the row, leaving a bill that looks settled by
// a charge that no longer exists — the orphan the app's own links-point-somewhere
// check exists to catch.

/** The slice of a pending bank charge this needs. Signed as the bank reports it. */
export interface PendingLike {
  date: string;
  amount: number;
  description: string;
  accountId: string | null;
}

/** The slice of a due bill this needs. */
export interface DueLike {
  name: string;
  amount: number;
  /** The resolved calendar date, not a day number. */
  due: string;
  accountId: string | null;
}

/**
 * How far off the amount may be and still be the same bill.
 *
 * MEASURED, NOT PICKED. Rent is the reason there is a tolerance at all: four months
 * of it read 1,731.98 · 1,732.16 · 1,726.88 · 1,732.05, a spread of $5.28 on a bill
 * recorded as fixed. So an exact match would miss the one bill that matters most.
 *
 * 2% or $25, whichever is larger — the percentage covers large bills that drift, the
 * floor covers small ones where 2% is pennies. Deliberately tight: a loose match that
 * says "already paid" about the wrong charge is worse than saying nothing, because it
 * produces the exact double-payment this is meant to prevent, in the other direction.
 */
export function tolerance(billAmount: number): number {
  return Math.max(25, Math.abs(billAmount) * 0.02);
}

/** How many days either side of the due date a payment still counts as "for this". */
export const DAY_WINDOW = 7;

const daysApart = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export interface Cover {
  date: string;
  amount: number;
  /** Plain words for why this charge was taken to be that bill. */
  why: string;
}

/**
 * The pending charge that looks like this bill, or null.
 *
 * THREE CONDITIONS, ALL REQUIRED — the account, the size and the timing. Any two of
 * them alone would match the wrong thing: two bills on one account in the same week,
 * or a coincidental amount on the wrong account. And a bill whose account nobody has
 * set matches NOTHING rather than matching across the household, because "some
 * account paid something like this" is not evidence that this bill is covered.
 *
 * AMBIGUITY IS REPORTED, NOT RESOLVED. If more than one pending charge fits, this
 * returns null: picking the closest would be the door guessing, and a wrong "already
 * paid" is the one outcome worse than no answer.
 */
export function coverFor(bill: DueLike, pending: readonly PendingLike[]): Cover | null {
  if (!bill.accountId) return null;
  const room = tolerance(bill.amount);
  const fits = pending.filter(
    (p) =>
      p.accountId === bill.accountId &&
      p.amount < 0 && // money going out; the bank's own sign, not flipped here
      Math.abs(Math.abs(p.amount) - Math.abs(bill.amount)) <= room &&
      daysApart(p.date, bill.due) <= DAY_WINDOW,
  );
  if (fits.length !== 1) return null;
  const p = fits[0];
  const off = Math.abs(Math.abs(p.amount) - Math.abs(bill.amount));
  return {
    date: p.date,
    amount: Math.abs(p.amount),
    why:
      off < 0.005
        ? `a payment for exactly this amount is clearing on the same account, dated ${p.date}`
        : `a payment within ${off.toFixed(2)} of this is clearing on the same account, dated ${p.date}`,
  };
}
