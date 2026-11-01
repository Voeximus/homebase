// Which rows the Activity tab and the All-activity ledger list, which of them ask
// for a category, and which of them the budget counts — ONE spelling of each, read
// by both screens (src/views/redesign/buildVMs.ts and src/components/LedgerSheet.tsx,
// with FinanceTabs building the ledger's list from the same filter).
//
// They used to be two spellings. The ledger still flagged a row for review when no
// merchant rule existed for it (a test the Activity tab retired, because it filled
// the queue with rows that were already filed correctly), and it flagged pending
// holds, which Activity deliberately never asks about. So the same charge read
// "Needs review" on one screen and was fine on the other: dozens of rows against a
// handful.
//
// NOT a Muse-mirrored module on purpose: the door's review filter reads the raw
// needs_review flag, and nothing here is a number the door reports.
import type { Transaction } from "../types";
import { inAnyLine } from "./plan";

/**
 * Is this row listed at all? Hidden are only the rows that are not money moving on
 * their own:
 *   · a set-aside the household excluded (it drops out like a transfer);
 *   · a settled set-aside (an IOU that was paid back);
 *   · a hand-typed "already paid" note (settled, and no bank feed behind it).
 *
 * `settled` on a BANK-FEED bill or debt payment means "already inside the anchored
 * balance", not "hide". The bank sync writes it on every payment it links, so
 * reading it as "hide" made rent, the card payment and most bills vanish from the
 * list depending on which code path happened to link them.
 */
export function inActivityLedger(tx: Transaction): boolean {
  const at = tx.appliesTo;
  if (at?.kind === "setaside" && at.reason === "excluded") return false;
  if (at?.settled && (at.kind === "setaside" || !tx.provider)) return false;
  return true;
}

/** Money moved between the household's own accounts: linked as a transfer, or
 *  paired as one by transferIds (the same pairing every counted figure skips). */
export function isTransferRow(tx: Transaction, moved: ReadonlySet<string>): boolean {
  return tx.appliesTo?.kind === "transfer" || moved.has(tx.id);
}

/**
 * Does this charge need a category from a person? The importer's own "I could not
 * tell" flag, or Misc that nobody chose by hand. Never a pending hold (its category
 * is provisional and the posted twin asks again), never a linked or split row, and
 * never a transfer between their own accounts (not spending at all).
 */
export function needsReviewTx(tx: Transaction, moved: ReadonlySet<string>): boolean {
  if (tx.type !== "expense" || tx.appliesTo || tx.pending) return false;
  if (tx.splits && tx.splits.length > 1) return false;
  if (moved.has(tx.id)) return false;
  return !!tx.needsReview || (tx.categoryId === "other" && !tx.userCategorized);
}

/**
 * Does the budget count this row? The predicate behind the "$X counted" figure
 * (variableSpent*): an expense, attached to nothing, not a transfer, in a category
 * (or with a split slice in a category) that some budget line grades. Pending rows
 * count, as they do on every bar.
 */
export function countedTx(tx: Transaction, moved: ReadonlySet<string>): boolean {
  if (tx.type !== "expense" || tx.appliesTo || moved.has(tx.id)) return false;
  return tx.splits && tx.splits.length
    ? tx.splits.some((s) => inAnyLine(s.categoryId))
    : inAnyLine(tx.categoryId);
}
