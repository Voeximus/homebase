// The bank lines the sync drops, written down instead of lost.
//
// WHY THIS FILE EXISTS, 2026-10-26. The bank sync (plaid/index.ts) leaves some posted
// bank lines out of the ledger on purpose — a transfer between the household's own
// accounts, a card payment arriving at the card, a remittance, anything the categorizer
// calls `skip` — and until today each of those was a bare `continue`: the line went
// nowhere, with no trace anywhere. Almost all of them are right to leave out. The ones
// that are not are real money that vanished without a sound: a Zelle to someone outside
// the household was missing from the ledger until three statements were reconciled line
// by line on 2026-10-10, and the bank feed never re-sends a line that has not changed,
// so nothing brought it back.
//
// So every line the sync drops is now written to `dropped_lines` (schema_v47), and the
// read door's finance.worth_a_look lists the recent ones that are not one half of a
// transfer between the household's own accounts. This file is the shape of a row and
// the cleaning of its description — the sync only decides WHEN a line is dropped, and
// it says why in the reason it passes.
//
// Pure: no database, no clock.

import { scrubCap } from "./muse/scrub.ts";

/** The longest description stored. Long enough for a Zelle line with its memo and its
 *  confirmation code; a longer one is cut, never refused, because the row records a
 *  bank line that exists whatever its wording. */
export const DROPPED_DESCRIPTION_MAX = 120;

/** One dropped line, in dropped_lines' own columns. */
export interface DroppedLineRow {
  provider_txn_id: string;
  account_id: string | null;
  date: string;
  /** A magnitude, like every ledger amount. */
  amount: number;
  direction: "in" | "out";
  description: string | null;
  reason: string;
}

/**
 * The description as it is stored: the sync's cleaned name for the line (never the
 * bank's raw descriptor), with the bank's identifier tail cut off and the cleaning every
 * door string goes through.
 *
 * WHAT IS CUT. Bank of America's ACH lines carry an " ID:" tail — the transfer's own
 * number, the name on the account ("INDN:") and the originator's company id ("CO ID:")
 * — none of which says what the money was, and the person's name and the company id are
 * exactly what a table nobody reads closely should not collect. The merchant key cuts
 * at the same place (merchantKey in categorize.ts).
 *
 * WHAT IS KEPT, ON PURPOSE. A "Conf#" / "Confirmation#" code. It is the only thing that
 * says two lines are the two halves of one transfer (transferRef in src/lib/flow.ts), and
 * without it every Zelle between the two of them would be listed as worth a look. The
 * ledger's own descriptions already carry the same codes.
 */
export function scrubDroppedDescription(desc: string | null | undefined): string | null {
  if (typeof desc !== "string") return null;
  const cut = desc.replace(/\s+(?:ID|INDN|CO ID):.*$/i, "");
  const s = scrubCap(cut, DROPPED_DESCRIPTION_MAX);
  return s || null;
}

/**
 * The row for a line the sync is dropping, or null when there is nothing to record — a
 * line that moved no money, or one with no date or id.
 *
 * `amount` is signed the way the sync carries it: negative is money out.
 */
export function droppedLine(
  row: { providerTxnId: string; date: string; amount: number; description: string | null | undefined },
  accountId: string | null,
  reason: string,
): DroppedLineRow | null {
  const amount = Number(row.amount);
  if (!row.providerTxnId || !row.date || !Number.isFinite(amount) || Math.abs(amount) < 0.005) return null;
  return {
    provider_txn_id: row.providerTxnId,
    account_id: accountId,
    date: row.date,
    amount: Math.round(Math.abs(amount) * 100) / 100,
    direction: amount < 0 ? "out" : "in",
    description: scrubDroppedDescription(row.description),
    reason: scrubCap(reason, 120) || "left out by the sync's rules",
  };
}

/**
 * One row per bank id, the LAST one kept, in the order the ids first appeared.
 *
 * WHY, FOUND 2026-10-26 in review. The sync builds its list of posted lines from Plaid's
 * `added` AND `modified` with no de-duplication (reconcile in plaidSync.ts), so one paged
 * sync can carry the same line twice. Postgres refuses an upsert batch that names the
 * same conflict key twice ("ON CONFLICT DO UPDATE command cannot affect row a second
 * time") — the whole batch, not just the repeat — so a doubled line cost every line in
 * its batch of 100. The last copy wins because it is the bank's latest word on the line.
 */
export function uniqueByBankId(rows: readonly DroppedLineRow[]): DroppedLineRow[] {
  const byId = new Map<string, DroppedLineRow>();
  for (const r of rows) byId.set(r.provider_txn_id, r);
  return [...byId.values()];
}

/** Why a CREDIT was dropped. classifyCredit gives no reason of its own, so the sync's
 *  one sentence for it lives here, beside the rows it explains. */
export const CREDIT_TRANSFER_REASON = "money coming in that the rules read as a transfer between your own accounts";
