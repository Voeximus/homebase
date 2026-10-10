// The bank sync's duplicate guard: which rows already in the ledger arm it, and how an
// incoming bank row is checked against them.
//
// LIFTED OUT OF plaid/index.ts ON 2026-10-10 so it can be tested — the same reason
// pendingRow.ts and plaidSync.ts live here. The sync is a Deno edge function no test can
// import, and the question this answers became load-bearing that day: the write door
// gained finance.add_history_row, which writes a bank row a statement shows and the
// ledger is missing, as a `record_only` row with no provider. The promise that makes
// that safe is "if the bank later delivers the same charge, it is absorbed, not
// doubled" — and that promise is a property of THIS file.
//
// TWO KINDS OF ROW ARM IT, AND THEY ARE MATCHED DIFFERENTLY (changed later the same
// day, after a review probed the first version):
//
//   · EXACT — a hand-entered row, and a row an OLDER bank connection delivered (the
//     re-link case). Same date, same signed amount, same merchantKey(), exactly as the
//     guard always matched. Unchanged: widening it would start eating real repeat
//     purchases (two same-price fills at one station on consecutive days), and these
//     rows have no reason to drift from the feed's own date and wording.
//
//   · A STATEMENT COPY — a posted `record_only` row with no provider id: what the
//     statement import writes and what finance.add_history_row writes. By definition it
//     is a copy of a bank line, typed in from a statement, so the bank delivering that
//     same line later is the expected case, not a coincidence. And a copy drifts from
//     the feed in exactly two ways the exact match cannot see:
//       – the DATE. A card statement can print the day the card was swiped while the
//         feed carries the day the bank posted it — one to three days later around a
//         weekend. The probe: a history row dated 09-11, the feed's twin dated 09-12,
//         0 absorbed and 1 inserted.
//       – the WORDING. The statement prints "CHECKCARD 0912 SAMPLE DINER PHOENIX AZ";
//         the feed sends the clean name "Sample Diner". Their merchant keys are
//         "CHECKCARD" and "SAMPLE DINER". The probe: 0 absorbed, 1 inserted.
//     And nothing would have flagged the double afterwards: ledgerReview's W5a skips
//     record_only rows (its only fix, a delete, is refused for them). So a copy is
//     matched by the rule the door's own duplicate check uses (sameCharge.ts): the
//     same signed amount to the cent, dated within SAME_CHARGE_DAYS, and the same
//     merchant by key or by noise-stripped stem — against the feed's clean name AND
//     its raw bank line, the two wordings the statement import also compares.
//
// ONE ROW ABSORBS AT MOST ONE DELIVERY, for both kinds — the rule reconcile already
// keeps for exact keys ("two genuinely identical charges still land the second one").
// That is why a statement copy is armed ONLY as a copy and never also as an exact key:
// in both it could be spent twice. When several copies could take a delivery, the
// nearest date wins, so two $5 coffees on the 10th and the 12th each find their own.
//
// Pure: no database, no Plaid, no clock.

import { merchantKey, stripStatementNoise } from "./categorize.ts";
import type { NormalRow } from "./plaidSync.ts";
import { calendarDaysApart, SAME_CHARGE_DAYS, sameMerchant, shiftDate } from "./sameCharge.ts";

/**
 * The identity of one purchase for the exact guard: date, signed amount (− = spend, the
 * way NormalRow is signed) and the merchant key — keyed the way importStatement's dupeKey
 * is, so the three write paths agree on what "the same purchase" means.
 */
export const contentKey = (r: NormalRow): string =>
  `${r.date}|${r.amount.toFixed(2)}|${merchantKey(r.description)}`;

/** A ledger row, as the sync's dedup scan selects it. */
export interface DedupScanRow {
  date: string;
  amount: number | string;
  type: string;
  description: string | null;
  account_id: string | null;
  provider_txn_id: string | null;
  status: string;
  /** Selected since 2026-10-10 so a statement copy can be told from a hand entry.
   *  Optional so a scan written before then still type-checks; absent reads as false,
   *  which is the guard's old behaviour exactly. */
  record_only?: boolean | null;
}

/** A statement copy waiting for the bank's delivery of the same line. */
export interface StatementCopy {
  date: string;
  /** Signed like NormalRow: − = money out. */
  amount: number;
  description: string;
  /** Spent: it has absorbed a delivery and cannot absorb another. */
  claimed: boolean;
}

/**
 * The dates the dedup scan must read for a delta whose posted rows span `dates`: the
 * delta's own range, widened by SAME_CHARGE_DAYS each side — a statement copy dated
 * two days before the earliest delivery is still the same charge, and a scan that
 * stopped at the delivery's date would never see it. (An exact key only ever matches
 * its own date, so the extra days cannot make the exact guard match anything it did
 * not before.)
 */
export function dedupScanWindow(dates: readonly string[]): { from: string; to: string } {
  const sorted = [...dates].sort();
  return {
    from: shiftDate(sorted[0], -SAME_CHARGE_DAYS),
    to: shiftDate(sorted[sorted.length - 1], SAME_CHARGE_DAYS),
  };
}

/**
 * Arm the guard from the rows already in the ledger.
 *
 * What goes in, and why the scope is this narrow (the reasoning lives at the call site
 * in plaid/index.ts and is not repeated here):
 *   • rows with NO provider_txn_id — hand-entered rows as exact keys; statement copies
 *     (record_only) as copies, matched by the wider rule above
 *   • feed rows this connection does NOT own — the older item after a re-link — as
 *     exact keys
 *   • but NEVER this connection's own feed rows
 *   • posted only
 *
 * `knownProviderIds` collects every provider id seen, posted or not, so reconcile can
 * tell "this row coming back" from "a different row with the same content".
 */
export function armDedupGuard(
  prior: readonly DedupScanRow[],
  ourAcctIds: ReadonlySet<string>,
): { existingKeys: Set<string>; knownProviderIds: Set<string>; copies: StatementCopy[] } {
  const existingKeys = new Set<string>();
  const knownProviderIds = new Set<string>();
  const copies: StatementCopy[] = [];
  for (const r of prior) {
    if (r.provider_txn_id) knownProviderIds.add(r.provider_txn_id);
    if (r.status !== "posted") continue;
    if (r.provider_txn_id && r.account_id && ourAcctIds.has(r.account_id)) continue;
    const signed = r.type === "income" ? Number(r.amount) : -Number(r.amount);
    if (!r.provider_txn_id && r.record_only === true) {
      copies.push({ date: r.date, amount: signed, description: r.description ?? "", claimed: false });
      continue;
    }
    existingKeys.add(`${r.date}|${signed.toFixed(2)}|${merchantKey(r.description ?? "")}`);
  }
  return { existingKeys, knownProviderIds, copies };
}

const READ = { merchantKey, stripStatementNoise };
const cents = (n: number) => Math.round(n * 100);

/**
 * Does a statement copy already stand for this posted bank row? If one does, it is
 * marked spent and the answer is yes — reconcile then absorbs the row. Called by
 * reconcile only after the exact guard has said no and only for an id the ledger does
 * not already hold, so a cursor-reset re-pull of a row we store is never absorbed.
 */
export function claimStatementCopy(copies: StatementCopy[], row: NormalRow): boolean {
  let best: StatementCopy | null = null;
  let bestGap = Infinity;
  for (const c of copies) {
    if (c.claimed || cents(c.amount) !== cents(row.amount)) continue;
    const gap = calendarDaysApart(c.date, row.date);
    if (gap > SAME_CHARGE_DAYS || gap >= bestGap) continue;
    const named = sameMerchant(c.description, row.description, READ) ||
      (!!row.raw && row.raw !== row.description && sameMerchant(c.description, row.raw, READ));
    if (!named) continue;
    best = c;
    bestGap = gap;
  }
  if (!best) return false;
  best.claimed = true;
  return true;
}
