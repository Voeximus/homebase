// The bank sync's half of "a hand note gives way to the bank's own charge".
//
// LIFTED OUT OF plaid/index.ts SO A TEST CAN HOLD IT, the reason dedupGuard.ts,
// pendingRow.ts and plaidSync.ts live here: the sync is a Deno edge function no test can
// import, and this decision deletes a row on its own.
//
// FOUND 2026-10-24. Four hand-made "(already paid)" notes were in the ledger — written by
// the app's "paid" tap (FinanceStore.markBillPaid), by the statement import's bill rows,
// or by Muse's finance.mark_bill_paid — and three of them paid a bill the bank had also
// paid. A note holds its bill's month, so when the bank's charge for that same bill
// arrived the sync read the month as taken and filed the charge as an extra payment:
// ordinary spending, flagged for review, while the note went on paying the bill. The
// same money, twice, in the budget, the run rate and the plan — and nothing could ever
// attach the real charge, because every path that links a charge refuses a taken month.
//
// THE RULE: when a NEW bank charge names a bill (the sync's own matching, unchanged) and
// that bill's month is held by a hand note ALONE, for the same amount inside the sync's
// band, the charge takes the month and the note is removed. Everything else keeps
// today's behaviour exactly, and that is most of the rule:
//
//   · a bill paid in cash keeps its note for ever — no bank charge arrives, nothing runs;
//   · a note for a DIFFERENT amount stays: part paid another way, both real. "Different"
//     means outside billAmountBand, and that band is wide for a VARIABLE bill — ±$15 or
//     ±15%, whichever is more — because a variable bill's note is usually the app's
//     estimate, typed in before the real figure was known. So on a variable bill a
//     part-cash payment that comes within the band of the note IS read as the same
//     payment, and the note goes. Said plainly in review on 2026-10-25: that is a real
//     risk, accepted because the narrow band would leave nearly every estimated note
//     double-counting beside its bank charge, and because the note's whole row is
//     written to the log so it can be put back. A fixed bill keeps the near-exact band;
//   · a month held by anything else, or by two rows, is not touched — a charge already
//     paying it, or the self-check's one-payment-per-cycle failure, which wants a person;
//   · a note somebody has answered by hand (user_categorized, a flow override, a split)
//     stays — a guess may SEED a row, never re-decide one a person chose (schema_v26);
//   · only a charge arriving NEW. A charge already in the ledger that comes round again
//     on a cursor reset is never re-decided by a re-sync; the self-check (check 10 in
//     src/lib/selfAudit.ts) and Worth a look (W5c) catch those, for a person to tap.
//     The same for a posted charge whose pending row a person had already answered:
//     their answer is carried onto it (carryCorrection) and the month is left to them;
//   · only a charge from an account we hold. A charge from a bank account that is not in
//     `accounts` is never written by this sync, so a note removed for it would leave the
//     month paid by nothing.
//   The three conditions on the CHARGE are mayTakeOver, below.
//
// A NOTE THE STATEMENT IMPORT WROTE (record_only) GIVES WAY TOO, decided 2026-10-25. It is
// the statement's own word for a payment the bank feed also delivers, it moved no cash (no
// account), and what it said is said again by the bank's charge taking its place — so it
// is replaced exactly like a tapped note: here, and by the write door's
// link_charge_to_bill. What stays refused is a BARE removal of a statement row, with
// nothing restating it: finance.delete_charge and Worth a look's one-tap both still say
// no, which is why W5c offers no button for such a note and says so instead.
//
// WHY REMOVE THE NOTE rather than keep it as a record or re-point it — the reasoning is
// written out once, at takeOverFromHandNote in muse-write/toolsFinance.ts, which does the
// same thing on a person's request. In short: nothing that adds up money reads
// `record_only`, there is no link shape every reader ignores, and one row fewer is the
// only change every reader honours at once. It moves no cash and touches no debt, and
// what the note said — "paid this month" — is now said by the bank's charge.
//
// Pure: no database, no Plaid, no clock.

import { billAmountBand } from "./categorize.ts";

/** A ledger row as the sync's paid-cycles read selects it. */
export interface PaidScanRow {
  id: string;
  type?: string | null;
  amount?: number | string | null;
  provider?: string | null;
  account_id?: string | null;
  status?: string | null;
  applies_to?: unknown;
  user_categorized?: boolean | null;
  flow_override?: string | null;
  splits?: unknown;
}

/** One row claiming a bill month, as the sync tracks it. */
export interface CycleHolder {
  id: string;
  /** A hand note the sync may retire on its own — see isRetirableHandNote. */
  handNote: boolean;
  amount: number;
}

/**
 * A hand note the sync may retire: a settled bill link on a posted expense with no bank
 * and no account (so it moved no cash), that nobody has answered by hand since.
 */
export function isRetirableHandNote(r: PaidScanRow): boolean {
  const at = (r.applies_to ?? null) as { kind?: unknown; settled?: unknown; recurringId?: unknown } | null;
  return (
    r.type === "expense" &&
    (r.status ?? "posted") === "posted" &&
    !r.provider &&
    !r.account_id &&
    at?.kind === "bill" &&
    at.settled === true &&
    typeof at.recurringId === "string" &&
    r.user_categorized !== true &&
    !r.flow_override &&
    !(Array.isArray(r.splits) && r.splits.length > 0)
  );
}

/** The holder record for a row the paid-cycles read returned. */
export function holderOf(r: PaidScanRow): CycleHolder {
  return { id: r.id, handNote: isRetirableHandNote(r), amount: Number(r.amount) };
}

/**
 * The hand note a new bank charge takes its month from, or null for today's behaviour.
 *
 * `holders` is every row claiming that bill month; `retiring` the notes this sync has
 * already given to an earlier charge, so one note is never handed to two. The amount is
 * compared against the NOTE, not the bill: the question is whether the two rows are the
 * same payment, and the note is what the person said was paid. On a variable bill that
 * comparison uses the wide band — see "a note for a DIFFERENT amount" above.
 *
 * Whether the CHARGE may take anything at all — new to the ledger, from an account we
 * hold, its pending row unanswered — is mayTakeOver's question, asked by the sync first.
 */
export function handNoteToRetire(
  holders: readonly CycleHolder[] | undefined,
  chargeAmount: number,
  billVariable: boolean | null | undefined,
  retiring: ReadonlySet<string>,
): CycleHolder | null {
  if (!holders || holders.length !== 1) return null;
  const [h] = holders;
  if (!h.handNote || retiring.has(h.id)) return null;
  if (!(h.amount > 0)) return null;
  const paid = Math.abs(Number(chargeAmount));
  if (!Number.isFinite(paid)) return null;
  if (Math.abs(paid - h.amount) > billAmountBand(h.amount, billVariable)) return null;
  return h;
}
