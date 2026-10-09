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
// The one exception to the cap, chargeNames, reads the whole ledger and so is PAGED
// instead — in a stable order, until a short page, counted, and throwing on any gap.

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
  /** What a person said this row IS, overruling src/lib/flow.ts, or null when the
   *  derived answer stands — which is the normal case. */
  flowOverride: string | null;
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
  /** Which account this bill is paid from, or null while nobody has said. All
   *  nineteen were null, which is how "nothing is due" was true while the joint
   *  account was short of rent. */
  accountId: string | null;
  /** Read for finance.set_bill_due_day, which has to know when a due day is NOT what
   *  places the row: a biweekly row with an anchor date is laid out every 14 days from
   *  the anchor (schedule.ts biweeklyDays), and its due_days are never read. */
  cadence: string;
  anchorDate: string | null;
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
  /** Whose account it is — said out loud when a bill is pinned to one, because
   *  "Adv SafeBalance Banking" alone does not tell anybody whose it is. */
  owner: string;
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

/**
 * The database answered, and its answer was "no": Postgres refused this one statement
 * with an error code, so the transaction PostgREST wrapped it in was rolled back and
 * nothing from THIS statement landed.
 *
 * WHY A FAILURE NEEDS TO SAY WHICH KIND IT IS. FOUND 2026-10-09, in review. commit() in
 * toolsFinance.ts had just learned to mark a change row `abandoned` when its write threw
 * — and `abandoned` tells him "this did not go through, there is nothing to put back".
 * But a throw on its own does not prove that. A fetch that dies after PostgREST has
 * committed comes back as an error too, and before this class every failure reached
 * commit() as the same bare Error, so the two could not be told apart: a write that had
 * LANDED would have been reported as one that never happened, with its undo made
 * unreachable. Only an error that carries a Postgres code says the statement itself was
 * refused; everything else is "nobody knows", which is what `pending` is for.
 */
export class StatementRefused extends Error {
  /** The SQLSTATE Postgres answered with — 22P02 is the 2026-09-27 json bug. */
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "StatementRefused";
    this.code = code;
  }
}

/**
 * Does this error code PROVE the statement rolled back? Only a Postgres SQLSTATE does,
 * and not every one of those:
 *
 *   five characters, digits and capitals   a SQLSTATE — the statement ran and Postgres
 *                                          refused it, so its transaction did not commit.
 *   PGRST…                                 PostgREST's own codes. Eight characters, so
 *                                          they fail the shape check — some of them are
 *                                          about the response, after the work was done.
 *   class 08 (connection exception)        the link to Postgres broke; whether the
 *                                          statement committed is exactly what is unknown.
 *   40003 (statement_completion_unknown)   Postgres's own word for "nobody knows".
 *   empty or missing                       a transport failure — supabase-js reports a
 *                                          failed fetch with no code at all. The write may
 *                                          have landed and its answer been lost.
 */
export function provesRolledBack(code: unknown): code is string {
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return false;
  if (code.startsWith("08")) return false;
  if (code === "40003") return false;
  return true;
}

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
   * The cleaned name — `description`, NEVER `raw_description` — of every charge in the
   * ledger (money out), for the one question finance.learn_merchant asks of it: does
   * any charge actually carry the key this rule is about to be saved under?
   *
   * WHY IT IS THE WHOLE LEDGER. A learned rule is an EXACT lookup on merchantKey()
   * (learnedFor in categorize.ts), and the key is the app's own derivation from the
   * name — so the only way to know whether a rule will ever fire is to derive the key
   * from every name and look. A filter in the database cannot do that derivation.
   *
   * Paged in a stable total order (date, then id) and counted on the same filter, and
   * it THROWS rather than returning part of the ledger. A short read here would make
   * the door tell him "this rule matches nothing yet" about a rule that matches
   * charges it simply did not read.
   */
  chargeNames(): Promise<string[]>;

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

  /**
   * Put a forgotten merchant rule back — its own id, its own pattern, its own three
   * answers — and nothing else. "taken" means the table refused it because a rule with
   * that pattern (or that id) is already there, and nothing was written.
   *
   * WHY IT IS ITS OWN VERB AND NOT insertRow. Added 2026-10-09 for the undo of
   * finance.forget_merchant. insertRow lets the database choose the id, on purpose:
   * its column list for merchant_rules does not carry `id`, and adding it there would
   * let every insert into that table pick its own id. Putting a rule back under the id
   * it had is the point of this one — the undo log, the audit row and anything the
   * phone cached all name that id — so it is a separate statement that can write
   * exactly one table and exactly these five columns, the same shape requestBankRefresh
   * takes for the same reason.
   *
   * `created_at` is not carried. The database stamps it again, so it reads the time of
   * the undo; nothing in the app or either door reads that column for a rule.
   *
   * "taken" is not checked by reading first and hoping. The table's own unique index
   * on `pattern` is what answers, so a rule taught on the phone in the instant between
   * the undo's check and this insert is refused rather than overwritten.
   */
  restoreMerchantRule(rule: RuleRow): Promise<"ok" | "taken">;

  /**
   * How many ledger statements on this connection have CHANGED a row — counted when one
   * resolves having done so: an insert, an "ok" update or delete, a money event. A
   * compare-and-set that matched nothing ("moved") changed nothing and is not counted;
   * nor is the change log itself (recordChange, setChangeState), which is the record of
   * a change and not one.
   *
   * It exists for one reader. commit() in toolsFinance.ts reads it before and after a
   * write that throws, because a tool that writes two rows can fail on the second, and
   * "the database refused this statement" is then only half the story: the first row
   * is in. A connection is made per request (index.ts builds a fresh one for every
   * call), so the count is this call's and no one else's.
   */
  writesLanded(): number;

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
