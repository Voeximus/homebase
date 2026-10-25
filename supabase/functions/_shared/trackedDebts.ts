// Which debts the bank sync credits a payment to by finding a pattern in the charge's
// description — and which payment goes to which.
//
// Pure, like plaidSync.ts beside it: no database, no Deno, no app imports. The sync
// (plaid/index.ts) is a Deno edge function no test can import, so the rule lives here
// and the sync calls it, which is how the rest of its rules are tested. The write door's
// finance.add_history_row reads it too (muse-write/historyRow.ts), so a row added by hand
// is judged by the same rule as the row the bank sends.
//
// THE RULE BEFORE 2026-10-25, unchanged: a debt is ARMED when it has a pattern
// (track_pattern), a FIXED baseline to count down from (tracked_baseline — never the
// live balance, or the recompute would subtract every payment again on every sync), and
// it is NOT a bank-linked card (provider_account_id), whose balance the card→debt
// trigger owns.
//
// WHAT 2026-10-25 ADDS: AND IT IS NOT CLOSED. FOUND that day. finance.edit_debt can close
// a paid-off debt (debts.closed_at, schema_v44) — finished and kept, never deleted — but
// the sync never read the column. A tracked debt's pattern is usually the LENDER's name
// (an instalment lender, a remittance service), and a household that pays one loan off
// often takes the next from the same lender. So once a loan was closed, a payment on the
// NEW one would match the CLOSED loan's pattern first, be recorded against the finished
// debt (settled, out of the budget), and be summed into that debt's recompute, where
// max(0, baseline − paid) keeps it at $0.00 — the payment would vanish from both the
// budget and the new loan, and nothing would say so. Skipping closed debts here closes
// both doors at once: the match, and the recompute that writes the balance.
//
// This is not a fix before the fact. An instalment lender's tracked debt was closed the
// same day this was written, and the household already had new loans from that lender
// with no debt row of their own.
//
// A PAYMENT ONLY A CLOSED DEBT MATCHES IS STILL RECORDED — closedDebtPayment below. FOUND
// in review the same day, on live data. The categorizer files that lender's payments as
// `skip` (his history labels them "Debt: <lender>", and a debt payment is not spending),
// and the sync drops every skip row the debts above do not claim. So with the closed loan
// no longer armed, a payment on the new loan would have been written NOWHERE — not
// credited, not spending, not in the ledger at all — and its pending row deleted when it
// posted. Before the closed check it was at least recorded, against the finished debt.
// Now it is recorded as a "Bill payment" and flagged for a look; see closedDebtPayment
// for why that shape and what it never touches.
//
// A payment that no debt matches, open or closed, goes on to the categorizer exactly as
// it would for a lender the app has never tracked. A new loan is credited once it has
// its own debt row with a pattern and a baseline; until then nothing here guesses which
// debt a payment belongs to.

/** The columns of a `debts` row this rule reads. The sync selects `*`, so any of them
 *  may be absent on an older database — absent reads as "not set". */
export interface TrackableDebt {
  id: string;
  track_pattern?: string | null;
  tracked_baseline?: number | string | null;
  provider_account_id?: string | null;
  closed_at?: string | null;
}

/** Everything about a debt that arms it except whether it is closed. */
function trackable(d: TrackableDebt): boolean {
  return (
    !!d.track_pattern &&
    // A pattern of only spaces would be "found" in nearly every description. The
    // write door's own copy of this test (historyRow.ts trackedDebtFor) already
    // ignores one; the sync now agrees with it.
    String(d.track_pattern).trim() !== "" &&
    d.tracked_baseline != null &&
    !d.provider_account_id
  );
}

/** The debts the sync credits payments to, in the order it was handed them. */
export function armedTrackedDebts<T extends TrackableDebt>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((d) => trackable(d) && !d.closed_at);
}

/**
 * The debts that would be armed if they were open — the set whose payments the closed
 * check took away, and the only one closedDebtPayment answers for. A closed debt that
 * was never armed (no baseline, or it follows a bank-linked card) is not in it: its
 * payments were never credited before 2026-10-25 either, and a card payment recorded as
 * spending would count on top of the card's own charges.
 */
export function closedTrackedDebts<T extends TrackableDebt>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((d) => trackable(d) && !!d.closed_at);
}

/** The first armed debt whose pattern appears anywhere in the description, ignoring
 *  case — the sync's own test, unchanged. The caller passes outflows only. */
export function trackedDebtFor<T extends TrackableDebt>(armed: readonly T[], description: string): T | undefined {
  const up = (description || "").toUpperCase();
  return armed.find((d) => up.includes(String(d.track_pattern).toUpperCase()));
}

/** The columns a payment that only a closed debt matches is recorded with — the sync's
 *  row and the write door's filing both read them from here. */
export const CLOSED_DEBT_FILING = {
  /** "Bill payment": real money out, on NO budget line (plan.ts OUTSIDE_BUDGET_CASH_CATS),
   *  so it cuts what is left to spend without being graded as discretionary spending. */
  category_id: "bills",
  /** A person says which loan it was paid on. */
  needs_review: true,
  /** The category is a guess, so it may seed the row but never re-decide it: a re-sync
   *  keeps whatever the row says by then (schema_v26). */
  keep_category: true,
} as const;

/**
 * What the sync does with an outflow that NO ARMED debt matched and the categorizer would
 * drop (`skip`), when a closed debt's pattern is in its description. The caller asks
 * only for such a row. Returns null when no closed debt matches — the row is dropped
 * exactly as before.
 *
 * Otherwise the row is RECORDED with CLOSED_DEBT_FILING, linked to nothing, so the money
 * that left the account is in the ledger and in front of somebody. Not credited to the
 * closed debt: it is finished, and crediting it is the bug above. Not credited to an open
 * debt either: none matched, and choosing one is a guess no row may be settled on.
 *
 * NEVER RE-DECIDES A ROW (schema_v26, "a guess may seed a row, never re-decide one").
 * `alreadyLinked` is the sync's own record of charges that carry a link today — the
 * closed loan's own old payments are exactly that, settled against it while it was
 * open. The bank re-sends a charge when it changes, and such a charge must stay what it
 * is, so `record` is null for it and the sync writes nothing: the row in the ledger, its
 * link and its category are left exactly as they are. (apply_bank_sync would keep the
 * link anyway — it coalesces applies_to — but it would overwrite the category and the
 * review flag, which is the re-decision this refuses.)
 */
export function closedDebtPayment<T extends TrackableDebt>(
  closed: readonly T[],
  description: string,
  alreadyLinked: boolean,
): { debt: T; record: typeof CLOSED_DEBT_FILING | null } | null {
  const debt = trackedDebtFor(closed, description);
  if (!debt) return null;
  return { debt, record: alreadyLinked ? null : CLOSED_DEBT_FILING };
}
