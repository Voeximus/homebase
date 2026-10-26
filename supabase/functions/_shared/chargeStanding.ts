// What the bank sync knows about one posted charge BEFORE it decides anything new for it.
//
// LIFTED OUT OF plaid/index.ts SO A TEST CAN HOLD IT, the reason handNote.ts and
// plaidSync.ts live here: the sync is a Deno edge function no test can import.
//
// FOUND 2026-10-25 in review of the 2026-10-24 bill work. That work gave the sync two new
// powers: a named bill paid from another of the household's accounts now links
// (matchBillForCharge in categorize.ts), and a bank charge can take a bill month from a
// hand-made "(already paid)" note (handNote.ts). Both were meant for charges ARRIVING. But
// the sync also re-sends charges it already stores — every row Plaid lists in `modified`,
// and the whole history after a cursor reset — and apply_bank_sync writes a re-sent row
// with `applies_to = coalesce(existing, new)` and no user_categorized guard
// (schema_v26_keep_category.sql). So a charge already in the ledger with no link — one a
// person may have answered by hand, like the car-insurance charges that never linked —
// would have gained a bill link the next time the bank touched it, dropped out of the
// budget, and settled a month nobody asked it to. That is a guess RE-DECIDING a row, which
// is the one thing the sync must never do (schema_v26: a guess may seed a row, never
// re-decide one). The takeover already checked the ledger; the cross-account link did not.
//
// So both new powers now ask the same questions of the charge first, here.
//
// Pure: no database, no Plaid, no clock.

/** The facts about one posted charge in this sync's delta. */
export interface ChargeStanding {
  /** The ledger holds no row with this bank id yet — posted or still pending. The sync
   *  reads this before deciding anything (plaid/index.ts, "stored charges"). */
  isNew: boolean;
  /** The pending row this posted charge replaces carried a person's answer — a category,
   *  a flow or a split. carryCorrection (plaidSync.ts) moves that answer onto this row. */
  answered: boolean;
  /** It came from a bank account the `accounts` table holds. A charge from any other
   *  account is never written by the sync at all. */
  mapped: boolean;
  /** The applies_to the ledger already holds for this bank id, or null. */
  storedLink: unknown;
}

/**
 * May the sync link this charge to `billId`, a bill set on ANOTHER account than the one
 * the money left (the household fallback in matchBillForCharge)?
 *
 *  · a NEW charge, yes — unless its pending row was answered by a person: then their
 *    answer is carried onto it and the bill link is theirs to make (W7 offers it). Before
 *    2026-10-24 that charge never linked and kept their answer, and it still does.
 *  · a charge already stored, only when it already carries that same bill link — the
 *    bank re-sending a row this sync linked before, written back exactly as it is. A
 *    stored charge with no link (or a different one) is left as it is: today's shape.
 */
export function mayLinkFromAnotherAccount(s: ChargeStanding, billId: string): boolean {
  if (s.isNew) return !s.answered;
  return storedLinkIs(s, billId);
}

/** The ledger already holds this charge linked to `billId`. */
function storedLinkIs(s: ChargeStanding, billId: string): boolean {
  const at = (s.storedLink ?? null) as { kind?: unknown; recurringId?: unknown } | null;
  return at?.kind === "bill" && at.recurringId === billId;
}

/**
 * May the sync link this charge to `billId`, a bill the categorizer named only from the
 * SHAPE of the line — an ACH transfer read as the car payment (SHAPE_BILL_RULES in
 * categorize.ts, 2026-10-26) — at that bill's own amount to the cent?
 *
 *  · from ANOTHER account than the bill's: exactly mayLinkFromAnotherAccount.
 *  · from the bill's own account, a NEW charge: yes — even when a person answered its
 *    pending row. CHANGED 2026-10-26 in review: the first version refused that charge, so
 *    a category tapped on the pending car payment (the phone buzzes on every pending
 *    charge) left the posted one unlinked and the bill reading unpaid. A bill named by
 *    its lender is linked on its own account in that case, and this is the same match
 *    held tighter — the right account and the exact amount — so it is linked the same
 *    way: the bill link wins over the carried category, and a flow the person set still
 *    carries (carryCorrection in plaidSync.ts).
 *  · a charge already stored, only when it already carries that same bill link: a
 *    stored charge with no link keeps the shape it has. The rule is new, and a new rule
 *    may seed a row but never re-decide one.
 */
export function mayLinkByShape(s: ChargeStanding, billId: string, fromAnotherAccount: boolean): boolean {
  if (fromAnotherAccount) return mayLinkFromAnotherAccount(s, billId);
  if (s.isNew) return true;
  return storedLinkIs(s, billId);
}

/**
 * May this charge take a bill month from a hand note at all? Only when it is new to the
 * ledger, nobody answered its pending row, and it came from an account the sync writes.
 * Whether a particular note gives way to it is handNoteToRetire's question, asked after.
 */
export function mayTakeOver(s: ChargeStanding): boolean {
  return s.isNew && !s.answered && s.mapped;
}
