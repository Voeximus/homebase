// What Phase 2's finance writes need from the database, as a list of named
// operations. Same shape and same reasoning as db.ts: no "run this SQL" escape
// hatch, so the set of things the door can do to the ledger is this file and you can
// read it in one sitting.
//
// THE ONE PROPERTY THAT MAKES THIS PHASE SAFE
//
// Three of the operations below take a table and a set of columns rather than being
// spelled out one per tool — and they are fenced by the SAME allowlist the undo core
// uses (UNDO_TABLES and UNDO_COLUMNS in ../_shared/muse/undo.ts). So:
//
//   the door can only write a column it can also put back.
//
// That is not a coincidence to be maintained by hand; it is what the fence is. Add a
// tool that writes `transactions.amount` and it does not compile past the allowlist,
// which is exactly the moment to ask whether that change is reversible.
//
// EVERY WRITE IS A COMPARE-AND-SET. `setColumns` and `deleteRow` take what they
// expect to find and report "moved" when the row does not hold it any more. The app
// itself writes blind here — `setTransactionCategory` updates by id and hopes — and
// gets away with it because a human is looking at the row. An assistant is not: it
// read the row some seconds ago, through a chat, and the phone may have written in
// between. So the door refuses rather than overwriting, and says so.
//
// WHY THE DOOR NOW READS A CHARGE'S DESCRIPTION. db.ts's own rule is READ NARROW —
// "the charge check reads an id; the bill check reads a name". Two of Phase 2's
// writes need more than that, and they need it for the same reason the app does:
// promoting a charge to a bill names the bill after the merchant, and learning a
// merchant rule keys on merchantKey(description). Those are the app's own
// derivations, from the app's own function. So `readCharge` reads `description`, and
// it still never reads `raw_description` — the untouched bank descriptor is the one
// field no tool on either door looks at.
//
// Rule 5 is satisfied the same way db.ts satisfies it: every read below is a single
// row, a count, or a list with a hard cap AND a count cross-check, so a read that
// PostgREST silently truncated at 1,000 rows cannot be mistaken for a complete one.

import type { UndoStep, UndoTable, UndoValue } from "../_shared/muse/undo.ts";
import type { UndoRecord, UndoState } from "../_shared/muse/undo.ts";
import type { Person } from "./db.ts";

/**
 * A charge, in the columns the finance writes read.
 *
 * Deliberately NOT the app's `Transaction` type: that lives in src/ behind a React
 * import, and half its fields are display-only. What is here is what some guard or
 * some undo step needs, and nothing else.
 */
export interface ChargeRow {
  id: string;
  date: string;
  amount: number;
  type: "income" | "expense";
  categoryId: string;
  /** The cleaned merchant name. Read because promote-to-bill and learn-merchant
   *  derive the merchant key from it, exactly as the app does. */
  description: string;
  accountId: string | null;
  appliesTo: UndoValue;
  splits: UndoValue;
  anomalyAck: boolean;
  needsReview: boolean;
  userCategorized: boolean;
  recordOnly: boolean;
  /** Which feed produced the row, or null for a hand-entered one. The gate on
   *  deleting: the bank re-delivers its own rows, and real bank history is the one
   *  thing the app cannot rebuild. */
  provider: string | null;
  /** "pending" while the bank has not posted it. */
  pending: boolean;
  createdAt: string;
  person: string | null;
}

export interface BillRow {
  id: string;
  name: string;
  amount: number;
  direction: "in" | "out" | "transfer";
  categoryId: string | null;
  active: boolean;
  variable: boolean;
  knownAmount: number | null;
  dueDays: number[] | null;
  startsOn: string | null;
  endsOn: string | null;
  linkedDebtId: string | null;
}

/** Just enough of a bill to run the three guards that compare names. */
export interface BillNameRow {
  id: string;
  name: string;
  direction: string;
  active: boolean;
}

/** One charge that claims a bill cycle. Used by the collision guard, which is the
 *  guard that would have stopped a $6 parking charge settling a $1,732 rent cycle. */
export interface BillPaymentRow {
  id: string;
  type: "income" | "expense";
  appliesTo: UndoValue;
}

export interface AccountRow {
  id: string;
  name: string;
  balance: number;
  providerAccountId: string | null;
  last4: string | null;
}

export interface DebtRow {
  id: string;
  name: string;
  balance: number;
  providerAccountId: string | null;
  trackPattern: string | null;
}

export interface RuleRow {
  id: string;
  pattern: string;
  kind: string;
  categoryId: string | null;
  billName: string | null;
}

export interface PaidOverrideRow {
  id: string;
  paid: boolean;
}

/** A money event, in the shape the app's own RPC takes. The door assembles no part
 *  of the arithmetic: the RPC clamps the debt paydown and stamps the applied amount,
 *  in one transaction, which is why this is the only way the door adds a charge. */
export interface MoneyEvent {
  date: string;
  amount: number;
  type: "income" | "expense";
  categoryId: string;
  description: string;
  accountId: string | null;
  person: Person;
}

/** A change, on its way into muse_undo. */
export interface ChangeInsert {
  token: string;
  person: Person;
  tool: string;
  summary: string;
  steps: UndoStep[];
}

/** The most rows a capped list read will fetch before the door refuses to answer
 *  from part of it. A bill with more payments than this is not a bigger answer, it
 *  is a different situation. */
export const LIST_CAP = 500;

export interface FinanceDb {
  // ── reads ─────────────────────────────────────────────────────────────────
  readCharge(id: string): Promise<ChargeRow | null>;
  readBill(id: string): Promise<BillRow | null>;
  readAccount(id: string): Promise<AccountRow | null>;
  readDebt(id: string): Promise<DebtRow | null>;
  readMerchantRule(pattern: string): Promise<RuleRow | null>;
  readPaidOverride(month: string, billKey: string): Promise<PaidOverrideRow | null>;
  /** Every recurring row's name and direction, for the three guards that compare
   *  names: the merchant-rule backstop, the promote-to-bill dedupe and the
   *  duplicate-name refusal. Throws rather than truncating. */
  allBillNames(): Promise<BillNameRow[]>;
  /** Every charge claiming a cycle of this bill. Throws rather than truncating —
   *  a truncated list would make the collision guard say "nothing is paying that
   *  cycle" about a cycle something is already paying. */
  billPayments(recurringId: string): Promise<BillPaymentRow[]>;
  /** How many charges point at this debt. Only ever compared against zero. */
  countDebtPayments(debtId: string): Promise<number>;

  /**
   * Every bank connection's two time columns, and NOTHING else.
   *
   * Read narrow, like every other read in this file: not the Plaid item_id, not the
   * vault secret's name, not the cursor, not the bank's error text. The refresh tool
   * needs to know when a pull was last asked for and when one last landed, and that
   * is the whole of it.
   *
   * `refresh_requested_at` may be MISSING on a database where
   * supabase/schema_v39_bank_refresh.sql has not been run. The implementation reads
   * it as null in that case rather than failing, so the door still answers — see the
   * tool's own refusal for what it says when the column is not there to write.
   */
  bankSyncTimes(): Promise<{ id: string; lastSyncAt: string | null; refreshRequestedAt: string | null }[]>;

  /**
   * Stamp "a pull was asked for" on every bank connection, and return how many rows
   * it touched.
   *
   * WHY IT IS NOT A `setColumns` CALL. Every other write in this file goes through
   * the undo-fenced compare-and-set, because every other write replaces a value
   * somebody could want back. This one replaces nothing: it is a request for work,
   * on a column no screen shows and no figure is computed from, and there is no
   * before-state worth keeping. The fence exists to stop a tool writing a column
   * outside the allowlist — so this stays OUTSIDE the fence and outside the
   * allowlist, as its own named verb that can write exactly one column on exactly
   * one table and nothing else.
   *
   * It is also why nothing here records an undo. "Un-ask the bank" is not a thing:
   * the pull either happened or did not, and handing back a token that looked like
   * it could reverse it would be the door promising something it cannot do.
   */
  requestBankRefresh(atISO: string): Promise<number>;

  // ── writes, fenced by the undo allowlist ──────────────────────────────────
  /**
   * UPDATE one row's allowlisted columns, but only while it still holds `expect`.
   * "moved" means it does not, and nothing was written.
   */
  setColumns(
    table: UndoTable,
    id: string,
    patch: Record<string, UndoValue>,
    expect: Record<string, UndoValue>,
  ): Promise<"ok" | "moved">;
  /** INSERT one row and return its id. The inverse is a delete, so this is the one
   *  write not fenced column by column — it is fenced table by table. */
  insertRow(table: UndoTable, row: Record<string, UndoValue>): Promise<string>;
  /** DELETE one row, but only while it still holds `expect`. */
  deleteRow(table: UndoTable, id: string, expect: Record<string, UndoValue>): Promise<"ok" | "moved">;

  // ── the app's own money engine, and its two inverses ──────────────────────
  /** apply_money_event. Returns the inserted row's id. */
  applyMoneyEvent(ev: MoneyEvent): Promise<string>;
  /** reverse_money_event, after checking the row is still there. */
  reverseMoneyEvent(id: string): Promise<"ok" | "moved">;
  /** restore_money_event. "moved" when a row with that id is already back. */
  restoreMoneyEvent(row: Record<string, UndoValue>): Promise<"ok" | "moved">;

  // ── the change log ────────────────────────────────────────────────────────
  /** Write the 'pending' row that holds the token and the inverse, BEFORE the
   *  change is attempted. */
  recordChange(c: ChangeInsert): Promise<void>;
  /** Move a change to its final state. `undoneBy` is set only when undoing. */
  setChangeState(
    token: string,
    state: UndoState,
    at: { undoneAt?: string; undoneBy?: string },
  ): Promise<void>;
  findChange(person: Person, token: string): Promise<UndoRecord | null>;
  /** This person's newest change that can still be put back, for a bare "undo
   *  that" with no token. */
  latestUndoable(person: Person): Promise<UndoRecord | null>;
}
