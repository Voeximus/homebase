// Which of the bank lines the sync dropped are worth a person's look.
//
// WHY, 2026-10-26. The sync now writes every posted line it leaves out of the ledger to
// `dropped_lines` (schema_v47, supabase/functions/_shared/droppedLines.ts). Nearly all of
// them are the household's own money moving — both halves of a Zelle between the two of
// them, a card payment arriving at the card — and listing those would bury the one that
// matters: a line a rule skipped that was real money going out or coming in. That is how
// a Zelle to someone outside the household went missing from the ledger until three
// statements were reconciled by hand on 2026-10-10.
//
// So finance.worth_a_look lists a dropped line from the last DROPPED_LOOKBACK_DAYS days
// only when nothing explains it as one half of a transfer between the household's own
// accounts. Three things explain one, and each is the household's own data saying so —
// none is a guess about what the money was for:
//
//   1. ITS OTHER HALF IS THERE. The same confirmation code on exactly one other line, in
//      the opposite direction, on another of their accounts, for the same amount to the
//      cent — transferPairs in src/lib/flow.ts, the one pair-finder the run rate and the
//      budget already use, asked over the dropped lines AND the ledger together (one half
//      of a card payment is in the ledger as the bill payment; the other is dropped).
//   2. IT NAMES ONE OF THEIR OWN ACCOUNTS by its last four digits ("TRANSFER TO ACCT
//      #…"), the way flowOf's rule 3 reads a payment to their own card. The confirmation
//      code is taken out first, so a code that happens to contain four digits cannot pass
//      for an account number.
//   3. IT IS A PAYMENT ARRIVING AT ONE OF THEIR CARDS — flowOf's rule 2, unchanged.
//
// And one thing settles it as no longer missing:
//
//   4. IT HAS BEEN PUT BACK. A row a person added as history — finance.add_history_row
//      or a statement import, both `record_only` with no bank id — on the same account,
//      the same way, for the same amount to the cent, dated within SAME_CHARGE_DAYS of
//      the line (add_history_row's own duplicate window). FOUND 2026-10-26 in review: the
//      history row has no bank id, so the sync never takes the line out of the table, and
//      W8 went on calling it "left out of the ledger" for two weeks after it was put back.
//      Only a record-only row counts, never a bank row of the same size: a $60 charge at
//      a shop two days later must not explain away a $60 Zelle nobody has accounted for.
//
// Anything else is listed, with the reason the sync gave for dropping it. A line the
// ledger already holds as a BANK row is never in the table at all: the sync takes it back
// out the moment it writes it (plaid/index.ts).
//
// Pure: no database, no clock — `today` is handed in.

import type { Account, Transaction } from "./lib/types.ts";
import { flowOf, ownAccountsFrom, transferPairs, transferRef } from "./lib/flow.ts";
import { addDaysISO } from "./lib/format.ts";
import { SAME_CHARGE_DAYS } from "../sameCharge.ts";
import type { DbRow } from "./paging.ts";

/** How far back a dropped line is worth mentioning. Two weeks: long enough that a line
 *  from the last pay cycle is still asked about, short enough that a line somebody
 *  already looked at and left alone stops coming back on its own. */
export const DROPPED_LOOKBACK_DAYS = 14;

/** How much further back than that the door READS, so a line just inside the window can
 *  still find its other half. The two halves of a transfer between their own accounts
 *  post a day or two apart, never a week. */
export const DROPPED_PAIR_SLACK_DAYS = 7;

/**
 * The oldest date the door reads from dropped_lines (2026-10-26, in review). It used to
 * read the whole table on every call, and nothing prunes it — the first sync after a new
 * link can write two years of dropped lines at once — so the read is the window plus the
 * slack, on the table's date index.
 */
export function droppedReadFrom(today: string): string {
  return addDaysISO(today, -(DROPPED_LOOKBACK_DAYS + DROPPED_PAIR_SLACK_DAYS));
}

/** One dropped line, as the door reads it. */
export interface DroppedLine {
  providerTxnId: string;
  accountId: string | null;
  date: string;
  /** A magnitude; the direction is in `direction`. */
  amount: number;
  direction: "in" | "out";
  /** The sync's scrubbed description — never the raw descriptor. */
  description: string;
  reason: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A dropped_lines row, mapped column by column. A row missing what makes it a line — an
 *  id, a date, a direction, an amount — is left out rather than guessed at. */
export function toDroppedLine(r: DbRow): DroppedLine | null {
  const amount = Number(r.amount);
  const direction = r.direction === "in" || r.direction === "out" ? r.direction : null;
  const providerTxnId = str(r.provider_txn_id);
  const date = str(r.date).slice(0, 10);
  if (!providerTxnId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !direction || !Number.isFinite(amount)) return null;
  return {
    providerTxnId,
    accountId: str(r.account_id) || null,
    date,
    amount: Math.abs(amount),
    direction,
    description: str(r.description),
    reason: str(r.reason),
  };
}

/** The id a dropped line goes by among the ledger's rows while they are paired. Prefixed
 *  so it can never be mistaken for a real transaction id. */
const pairId = (d: DroppedLine) => `dropped:${d.providerTxnId}`;

/** A dropped line in the shape flow.ts reads. Only the fields its rules look at carry
 *  anything; the rest are the empty values a row with no category would have. */
function asTransaction(d: DroppedLine): Transaction {
  return {
    id: pairId(d),
    date: d.date,
    amount: d.amount,
    type: d.direction === "out" ? "expense" : "income",
    categoryId: "",
    description: d.description,
    accountId: d.accountId ?? undefined,
  } as Transaction;
}

/**
 * The dropped lines worth a look, newest first.
 *
 * `today` is the household's date ("YYYY-MM-DD"). A line dated after it (the bank's
 * clock is not the household's) is still inside the window.
 */
export function droppedWorthALook(
  lines: readonly DroppedLine[],
  data: { transactions: readonly Transaction[]; accounts: readonly Account[] },
  today: string,
): DroppedLine[] {
  const from = addDaysISO(today, -DROPPED_LOOKBACK_DAYS);
  const recent = lines.filter((d) => d.date >= from);
  if (!recent.length) return [];

  const own = ownAccountsFrom(data.accounts);
  const ownIds = new Set(data.accounts.map((a) => a.id));

  // Rule 4: the history row that put each line back, if there is one. One row puts back
  // ONE line — two $60 lines a day apart and one $60 history row leave one of them still
  // missing — taken oldest line first, so the same data gives the same answer every call.
  const cents = (n: number) => Math.round(Number(n) * 100);
  const putBack = new Map<string, Transaction>();
  const standIns = new Set<string>();
  const byAge = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.providerTxnId.localeCompare(b.providerTxnId));
  for (const d of byAge) {
    if (!d.accountId) continue;
    const lo = addDaysISO(d.date, -SAME_CHARGE_DAYS);
    const hi = addDaysISO(d.date, SAME_CHARGE_DAYS);
    const row = data.transactions.find(
      (t) =>
        !standIns.has(t.id) &&
        t.recordOnly === true &&
        !t.provider &&
        t.accountId === d.accountId &&
        t.type === (d.direction === "out" ? "expense" : "income") &&
        cents(t.amount) === cents(d.amount) &&
        t.date >= lo &&
        t.date <= hi,
    );
    if (!row) continue;
    putBack.set(d.providerTxnId, row);
    standIns.add(row.id);
  }

  // Every line the door read goes into the pool, not only the recent ones (the read
  // reaches DROPPED_PAIR_SLACK_DAYS further back): the two halves of a transfer can post
  // days apart, and a window that cut between them would turn half a transfer back into
  // something worth a look. A history row that put a line back is left OUT of the pool —
  // it is the same money as that line, and the two carrying one confirmation code would
  // stop the line pairing with its real other half (transferPairs wants exactly one).
  const pool = [...data.transactions.filter((t) => !standIns.has(t.id)), ...lines.map(asTransaction)];
  const paired = transferPairs(pool, (accountId) => ownIds.has(accountId));

  const explained = (d: DroppedLine): boolean => {
    if (putBack.has(d.providerTxnId)) return true;
    if (paired.has(pairId(d))) return true;
    const ref = transferRef(d.description);
    const words = ref ? d.description.replace(new RegExp(ref, "ig"), " ") : d.description;
    const runs = words.match(/\d{4}/g) ?? [];
    if (runs.some((r) => own.lastFours.includes(r))) return true;
    return d.direction === "in" && flowOf(asTransaction(d), own).flow === "moved";
  };

  return recent
    .filter((d) => !explained(d))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount || a.providerTxnId.localeCompare(b.providerTxnId));
}
