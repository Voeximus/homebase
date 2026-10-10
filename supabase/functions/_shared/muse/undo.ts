// The undo core. Build this first, keep it small, and keep it obvious.
//
// WHY IT EXISTS
//
// Phase 1 asked "is this write safe to do unattended?" and split the tools two
// ways on the answer. Phase 2 asks a better question, because Homebase never moves
// money — it records, categorises and computes. The worst a wrong write can do is
// make DATA wrong. So the question is "can this be put back?", and the answer is
// yes for every write in the door as long as the state being replaced is written
// down BEFORE it is replaced.
//
// THE WHOLE MECHANISM, IN FOUR SENTENCES
//   1. A write reads the row it is about to change and records the columns it will
//      touch: their value now (`before`) and the value it is about to write
//      (`after`).
//   2. That list of steps is stored in muse_undo under a short token, and the
//      token comes back in the reply.
//   3. `system.undo` looks the token up and applies the steps in reverse order,
//      setting each column back to `before` — but ONLY if the column still holds
//      `after`.
//   4. If anything has changed it since, nothing is written and the reply says so.
//
// STEP 3's SECOND HALF IS THE ONE THAT MATTERS. An undo that blindly restored a
// snapshot would be a second way to make data wrong: he re-categorises a charge in
// the app, then says "undo that" meaning the assistant's earlier change, and the
// assistant overwrites the newer, deliberate answer with an older one. So every
// step is a compare-and-set. This is the same discipline the app's own review
// surface uses — src/views/redesign/reviewApply.ts re-reads the CURRENT data at tap
// time and refuses if the world moved, because "rendering proves nothing about now".
// An undo token is a rendering that may be minutes old.
//
// WHAT THIS FILE IS NOT
//   · It is not SQL. A step is a named operation over an allowlisted table and an
//     allowlisted set of columns. There is no "run this statement" step, so the set
//     of things an undo can do is this file.
//   · It reads no clock (Rule 2). Timestamps arrive as arguments.
//   · It holds no database client. The applier is a seam the write door implements
//     and the tests fake.

import { scrubCap } from "./scrub.ts";

/** The tables an undo step may name. An allowlist, so a step naming anything else
 *  is refused — including a step that somehow reached the table by another route. */
export const UNDO_TABLES = [
  "transactions",
  "recurring",
  "accounts",
  "debts",
  "paid_bills",
  "merchant_rules",
  // Added 2026-10-10 for finance.dismiss_suggestion: a "worth a look" item waved away
  // is one row here (supabase/schema_v43_review_dismissals.sql), and its undo is the
  // delete of that row — the same insert-then-delete_row shape add_bill and add_debt
  // use, so no new step kind was needed.
  "review_dismissals",
] as const;

export type UndoTable = (typeof UNDO_TABLES)[number];

/**
 * The columns an undo may write, per table.
 *
 * This is the real fence, and it is narrower than the table list. Every column
 * here is one that some tool in this door writes; nothing else is on it. So even a
 * well-formed step cannot put `amount`, `provider`, `raw_description` or
 * `provider_txn_id` back on a transaction — the door never changes those, so an
 * undo has no business being able to.
 *
 * `accounts.balance` is on the list and is the one entry with a caveat worth
 * saying out loud: it is the bank-truth anchor, and a Plaid sync re-anchors it. The
 * undo is exact at the moment it runs and stops being exact at the next sync, and
 * the tool that writes it says so in its reply.
 */
export const UNDO_COLUMNS: Record<UndoTable, readonly string[]> = {
  transactions: [
    "category_id",
    "user_categorized",
    "needs_review",
    "splits",
    "applies_to",
    "anomaly_ack",
    // What a person says a row IS — earned, spent, moved, repaid, returned —
    // overruling src/lib/flow.ts. Undoable like everything else: setting it back to
    // null restores the derived answer, which is why only corrections are stored.
    "flow_override",
  ],
  // `account_id` is which account actually pays this bill. All nineteen were null,
  // which is how "nothing is due" was true while the joint account was $1,023 short
  // of rent — the household was being treated as one wallet because the data said
  // nothing about three.
  //
  // `due_days` is the day of the month a bill actually comes out, added 2026-10-09 for
  // finance.set_bill_due_day: T-Mobile's row says the 29th and the charge landed on
  // the 14th in July, August and September, and nothing could move it. Reversible like the
  // rest — the undo writes the old array back, and the tool only ever touches a row
  // with one day, so the before-state is never a split it would have to reassemble.
  //
  // `name` and `category_id`, added 2026-10-10 for finance.edit_bill. FOUND that day in a
  // scan of the door's own calls: nobody — not the app, not the door — could rename a bill
  // or change its category, so bills sat filed under `other` while a category that fits
  // them existed, and one still carried the bank's all-caps name.
  // A rename is reversible like the rest, but it is the one write here that has to move
  // OTHER rows with it — a saved merchant rule and a paid mark both store the bill by its
  // name — so the tool writes those in the same change, and the two columns below are
  // what lets their undo put them back too.
  recurring: [
    "amount",
    "known_amount",
    "variable",
    "active",
    "starts_on",
    "ends_on",
    "account_id",
    "due_days",
    "name",
    "category_id",
  ],
  accounts: ["balance"],
  // `name`, `min_payment`, `apr` and `closed_at`, added 2026-10-10 for finance.edit_debt.
  // The debt tools could add a debt and point it at a card, and nothing could change one:
  // the card's minimum moves after every statement, finance.debts reads the stored one out
  // loud, and the stored one could only be corrected with raw SQL. `closed_at` is the
  // close-without-deleting flag from supabase/schema_v44_debt_closed.sql; the tool refuses
  // with a sentence on a database where that file has not been run, so the allowlist can
  // name the column before the column exists without any write ever reaching it.
  debts: ["provider_account_id", "balance", "name", "min_payment", "apr", "closed_at"],
  // `bill_key`, added 2026-10-10 with the rename above: an override row is keyed
  // "<label>@<day>", and the label is the bill's name for every row written that way.
  paid_bills: ["paid", "bill_key"],
  merchant_rules: ["kind", "category_id", "bill_name"],
  // `key` and nothing else. No tool UPDATES a dismissal — dismissing inserts one and
  // undoing deletes it — but a delete_row step must name a column it expects to find
  // before it removes anything (that is what keeps a delete from ever being blind), and
  // this allowlist is what that column is checked against. The key is the one column
  // that says which dismissal the row is.
  review_dismissals: ["key"],
};

/** A JSON value, as it sits in a column or in the steps document. */
export type UndoValue = null | boolean | number | string | UndoValue[] | { [k: string]: UndoValue };

/**
 * One reversible step. Four kinds, and four is enough for every write in the door
 * — which is the reason to keep counting them.
 *
 *   set_columns           the inverse of an UPDATE. Put these columns back, if
 *                         they still hold what we wrote.
 *   delete_row            the inverse of an INSERT. `guard` names what must not
 *                         point at the row yet, for the two tables where something
 *                         else can have attached itself since (a charge linking to
 *                         a new bill; a payment against a new debt).
 *   reverse_money_event   the inverse of adding a cash charge. The APP'S OWN exact
 *                         inverse — it undoes the fan-out using the stamped
 *                         appliedAmount, which is why the door must not hand-roll
 *                         this one.
 *   restore_money_event   the inverse of deleting a charge. The new SQL function in
 *                         schema_v37, the mirror image of the one above.
 */
export type UndoStep =
  | {
      kind: "set_columns";
      table: UndoTable;
      id: string;
      /** What to write back. */
      before: Record<string, UndoValue>;
      /** What must still be there, or the undo refuses. Same keys as `before`. */
      after: Record<string, UndoValue>;
    }
  | {
      kind: "delete_row";
      table: UndoTable;
      id: string;
      /** The columns that must still hold these values, or the undo refuses. */
      after: Record<string, UndoValue>;
      guard?: "no_bill_payments" | "no_debt_payments";
    }
  | { kind: "reverse_money_event"; id: string }
  | { kind: "restore_money_event"; row: Record<string, UndoValue> }
  | {
      /**
       * Run one NAMED inverse out of a registry, on the before-state recorded with it.
       *
       * WHY THERE IS A FIFTH KIND AT ALL, when the other four are the whole point. Those
       * four are DATA over an allowlist of tables and columns, and that is what makes the
       * money side safe: the door can only write a column it can also put back. It works
       * because a ledger row IS columns.
       *
       * The health side is not columns. A day's meals are one JSON document, and taking
       * back the one meal the door added — while keeping the meal the phone added a second
       * later — is not a column write. It is a read, a surgical edit and a compare-and-set.
       * Expressed as `set_columns` it would be a whole-document restore, which would
       * silently throw away whatever the phone did in between: worse than no undo, because
       * it reports success.
       *
       * So the inverse is CODE, named by a string, with the before-state as data. Three
       * things keep that honest:
       *
       *   · a `kind` here is a NAME IN A DATABASE ROW, so renaming a handler orphans every
       *     token already handed out — a rename is a migration, not a refactor;
       *   · the registry is merged at module load by mergeUndo, which throws if two
       *     handlers claim one name, so a token can never mean two different inverses;
       *   · a handler the registry does not have is refused with a sentence, never guessed
       *     at. That is the allowlist property in its own shape.
       *
       * Prefer the four data kinds. Reach for this one only when the row is a document —
       * or, since 2026-10-09, when the inverse RE-CREATES a deleted row whose guard is
       * about other rows. finance.forget_merchant is that case: putting a rule back is an
       * insert that must refuse if the merchant has been given a rule again since, and
       * neither half fits a data kind. A generic "insert this row" kind would let a step
       * create any row in any allowlisted table, which widens what an undo can write; and
       * a compare-and-set cannot name a row that no longer exists. So it is one handler
       * that can insert one rule and nothing else (muse-write/financeUndo.ts), rather
       * than a sixth kind that could insert anything.
       */
      kind: "run_handler";
      handler: string;
      before: UndoValue;
    };

/** A change, as it sits in muse_undo. */
export interface UndoRecord {
  token: string;
  at: string;
  person: string;
  tool: string;
  summary: string;
  steps: UndoStep[];
  state: UndoState;
  undoneAt: string | null;
  undoneBy: string | null;
}

/**
 * Where a change got to. Four states, because "I tried and cannot prove what
 * happened" is a real outcome and deserves its own word rather than being reported
 * as one of the two comfortable ones. See supabase/schema_v38_muse_undo.sql for why
 * the row is written before the change is attempted.
 */
export type UndoState = "pending" | "undoable" | "abandoned" | "undone";

/** What `system.changes` says about each state, in his words rather than the
 *  column's. One line per state, in one place, so editing what he hears is finding a
 *  table rather than reading code — the same rule the read door's CHECK_SAYS
 *  follows. */
export const STATE_SAYS: Record<UndoState, string> = {
  pending:
    "I started this and could not confirm it finished. Check it in the app — I will not put back something I am not sure I did.",
  undoable: "This is done, and I can put it back.",
  // TWO CAUSES SINCE 2026-10-09, and the sentence names both rather than guessing which.
  // `abandoned` used to mean only "the row moved between my read and my write". It now
  // also means "the database refused the write itself": two finance.settle_reimbursable
  // calls on 2026-09-27 died on `invalid input syntax for type json`, the door answered
  // 500, and their rows sat in `pending` for ever — which this table reads out as "I
  // could not confirm it finished", about two writes the database had flatly refused.
  //
  // ONLY A REFUSAL THAT PROVES NOTHING LANDED. Review the same day caught the first
  // version marking ANY failed write abandoned, and this sentence says "there is nothing
  // for me to put back" — untrue after a lost answer from a write that committed, or a
  // failure on the second row of a write whose first row was in. commit() in
  // muse-write/toolsFinance.ts leaves those `pending`, and says why. The last clause
  // stays for the older, narrower case it was written for: a two-row write whose second
  // row had MOVED, where the first had already landed.
  abandoned:
    "This did not go through — the row had changed since I read it, or the database refused the write itself — so I stopped, and there is nothing for me to put back. If it touched more than one row, check them in the app.",
  undone: "I did this and have since put it back.",
};

// ── the token ────────────────────────────────────────────────────────────────

/**
 * A token he can read out loud.
 *
 * Crockford's alphabet minus the vowels: no 0/O, no 1/I/l, no u. So "u-4k7m9qt2"
 * survives being spoken, typed and transcribed, which matters because every
 * message he sends is dictated.
 *
 * NOT a secret, and not treated as one. The door already knows who is calling from
 * the key they presented, and it only undoes that person's own changes — the token
 * names a change, it does not authorise one. Eight characters of this alphabet is
 * 32^8, which is far past guessing by accident, and that is all it is for.
 */
const TOKEN_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";
export const TOKEN_SHAPE = /^u-[0-9a-hjkmnp-tv-z]{8}$/;

/** `random` is passed in, so a test gets a fixed token and the door gets a real one.
 *  It fills the array with bytes, exactly like crypto.getRandomValues — whose own
 *  signature is why the buffer type is spelled out rather than left to default. */
export function mintToken(random: (into: Uint8Array<ArrayBuffer>) => void): string {
  const bytes = new Uint8Array(8);
  random(bytes);
  let out = "u-";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

// ── validating a step before it runs ─────────────────────────────────────────

/** A step was refused before anything was written. Never thrown past the tool that
 *  raised it: the door turns it into a plain sentence. */
export class UndoRefused extends Error {
  readonly say: string;
  constructor(say: string) {
    super(say);
    this.name = "UndoRefused";
    this.say = say;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTable(v: unknown): v is UndoTable {
  return typeof v === "string" && (UNDO_TABLES as readonly string[]).includes(v);
}

function isPlainObject(v: unknown): v is Record<string, UndoValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Is this a step this door is willing to run?
 *
 * Checked on the way OUT (when a tool builds one) and again on the way IN (when
 * system.undo reads one back), which is not belt-and-braces for its own sake: the
 * steps spend time in a table, and a door that trusted what it read out of a table
 * would be a door whose write surface is whatever is in that table. Fails closed,
 * loudly, with a sentence rather than a stack trace.
 */
/** A handler name, as a `kind` in the registry spells one: `area.verb-object`. */
const HANDLER_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export function checkStep(step: unknown): UndoStep {
  if (!isPlainObject(step)) throw new UndoRefused("That undo is not in a shape I can run.");
  const kind = step.kind;

  if (kind === "reverse_money_event" || kind === "restore_money_event") {
    if (kind === "reverse_money_event") {
      if (typeof step.id !== "string" || !UUID.test(step.id)) {
        throw new UndoRefused("That undo names a charge I cannot read.");
      }
      return { kind, id: step.id };
    }
    const row = step.row;
    if (!isPlainObject(row) || typeof row.id !== "string" || !UUID.test(row.id)) {
      throw new UndoRefused("That undo names a charge I cannot read.");
    }
    return { kind, row };
  }

  if (kind === "run_handler") {
    if (typeof step.handler !== "string" || !HANDLER_NAME.test(step.handler)) {
      throw new UndoRefused("That undo names an inverse I cannot read.");
    }
    // `before` may be any JSON the handler recorded, including null — a handler whose
    // inverse needs nothing but its own name is legitimate (an insert's inverse is a
    // delete of a row the id already identifies). What it may NOT be is undefined,
    // which is what a column that was never written looks like coming back out.
    if (step.before === undefined) throw new UndoRefused("That undo does not say what to put back.");
    // Whether the registry HAS this handler is checked where it is applied, not here:
    // this function is also what reads a row back out of the database for
    // system.changes, and a change made by an older deploy should still be readable
    // and listed rather than making the whole list unreadable.
    return { kind, handler: step.handler, before: step.before as UndoValue };
  }

  if (kind !== "set_columns" && kind !== "delete_row") {
    throw new UndoRefused("That undo asks for something this door cannot do.");
  }
  if (!isTable(step.table)) throw new UndoRefused("That undo names something I do not write to.");
  if (typeof step.id !== "string" || !UUID.test(step.id)) {
    throw new UndoRefused("That undo names a row I cannot read.");
  }
  const allowed = UNDO_COLUMNS[step.table];
  const after = step.after;
  if (!isPlainObject(after) || Object.keys(after).length === 0) {
    throw new UndoRefused("That undo does not say what it expects to find.");
  }
  for (const col of Object.keys(after)) {
    if (!allowed.includes(col)) {
      // Named, because this one is worth being able to find: it means either a new
      // tool forgot to widen the allowlist, or something wrote a step the door
      // would not have written.
      throw new UndoRefused(`That undo wants to change ${col}, which nothing here writes.`);
    }
  }

  if (kind === "delete_row") {
    const guard = step.guard;
    if (guard !== undefined && guard !== "no_bill_payments" && guard !== "no_debt_payments") {
      throw new UndoRefused("That undo carries a check I do not know.");
    }
    return { kind, table: step.table, id: step.id, after, ...(guard ? { guard } : {}) };
  }

  const before = step.before;
  if (!isPlainObject(before)) throw new UndoRefused("That undo does not say what to put back.");
  const beforeKeys = Object.keys(before).sort().join(",");
  const afterKeys = Object.keys(after).sort().join(",");
  // The two halves must describe the SAME columns. A `before` missing a column
  // that `after` names would leave that column holding the new value while the
  // reply said everything was put back — a half undo reported as a whole one.
  if (beforeKeys !== afterKeys) {
    throw new UndoRefused("That undo does not line up with what it changed.");
  }
  return { kind, table: step.table, id: step.id, before, after };
}

/** Every step, checked. Used by a tool building a change and by system.undo
 *  reading one back. */
export function checkSteps(steps: unknown): UndoStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new UndoRefused("That undo has no steps in it.");
  }
  if (steps.length > MAX_STEPS) throw new UndoRefused("That undo has more steps than I will run.");
  return steps.map(checkStep);
}

/** The most rows one write is allowed to touch.
 *
 *  It was 8 until 2026-10-10, when three rows (promoting a charge to a bill: the new
 *  bill, the charge, the merchant rule) was the largest write in the door. Then
 *  finance.confirm_charges arrived: a backlog of charges sat flagged for review, most of
 *  them at a few merchants and already in the right category, and clearing them one
 *  call at a time ran into the cap of 60 writes an hour. Confirming a batch is one change
 *  with one undo token, and its steps are one compare-and-set per charge, so the batch
 *  can be no bigger than this.
 *
 *  50 covered the largest single merchant's backlog that day in one call, and is still
 *  small enough that a runaway list is refused rather than run — confirm_charges
 *  refuses anything over it in words, before it writes a row. finance.edit_bill is the
 *  other write whose row count depends on the data — a rename carries every saved rule
 *  and paid mark that names the bill — and it too refuses, before writing anything, a
 *  rename that would need more than this, rather than raising the cap for it. */
export const MAX_STEPS = 50;

// ── the seam the write door implements ───────────────────────────────────────

/** What applying one step needs from the database. Each method is one statement,
 *  and each returns whether the row it aimed at was still the row it expected. */
export interface UndoApplier {
  /** UPDATE … SET before WHERE id = id AND every after column still matches. */
  setColumns(
    table: UndoTable,
    id: string,
    before: Record<string, UndoValue>,
    after: Record<string, UndoValue>,
  ): Promise<"ok" | "moved">;
  /** DELETE WHERE id = id AND every after column still matches. */
  deleteRow(table: UndoTable, id: string, after: Record<string, UndoValue>): Promise<"ok" | "moved">;
  /** Is anything pointing at this bill / debt? "yes" means the delete is refused. */
  isReferenced(guard: "no_bill_payments" | "no_debt_payments", id: string): Promise<boolean>;
  /** The app's own exact inverse of adding a charge. "moved" means the charge is not
   *  there any more, so there is nothing to take back out. */
  reverseMoneyEvent(id: string): Promise<"ok" | "moved">;
  /** Put a deleted charge back under its original id. "moved" means a row with that
   *  id is already there, so it has been put back already. */
  restoreMoneyEvent(row: Record<string, UndoValue>): Promise<"ok" | "moved">;
  /**
   * Run a named inverse out of the registry.
   *
   * It returns the handler's OWN sentence on failure rather than "moved", because a
   * handler knows things this function cannot: "that meal is not there any more",
   * "the day has been edited since", "it is already back". Those are different
   * answers and a person can act on the difference.
   */
  runHandler(handler: string, before: UndoValue): Promise<"ok" | { say: string }>;
}

/** Why an undo stopped. `moved` is the interesting one: nothing was written. */
export type UndoOutcome =
  | { ok: true; steps: number }
  | { ok: false; say: string };

/**
 * Apply one change's inverse.
 *
 * ORDER. Steps run in REVERSE of the order they were recorded, because that is
 * what "undo" means for a write that touched more than one row: promoting a charge
 * to a bill inserted the bill first and pointed the charge at it last, so the undo
 * un-points the charge first and removes the bill last. Removing the bill first
 * would leave the charge pointing at nothing, which is the state the app's own
 * `links-point-somewhere` self-check exists to complain about.
 *
 * STOPPING. The first step that finds the world moved stops the whole undo, and
 * the reply says which one and that the earlier steps DID run. That is the honest
 * report: a partial undo has happened, and pretending otherwise is worse than
 * saying so. It cannot leave a state the app has no name for, because every step is
 * one of the app's own writes going the other way.
 */
export async function applyUndo(steps: UndoStep[], apply: UndoApplier): Promise<UndoOutcome> {
  let done = 0;
  for (const step of [...steps].reverse()) {
    if (step.kind === "reverse_money_event") {
      if ((await apply.reverseMoneyEvent(step.id)) === "moved") {
        return {
          ok: false,
          say: stopped(done, "that charge is not there any anymore, so there is nothing of it to take back out"),
        };
      }
      done++;
      continue;
    }
    if (step.kind === "restore_money_event") {
      if ((await apply.restoreMoneyEvent(step.row)) === "moved") {
        return { ok: false, say: stopped(done, "that charge is already back in the ledger") };
      }
      done++;
      continue;
    }
    if (step.kind === "run_handler") {
      const hit = await apply.runHandler(step.handler, step.before);
      if (hit !== "ok") {
        // The handler's sentence stands as written — it is more specific than anything
        // this function could say. What gets added is how far the undo got, because a
        // partial undo has happened and saying otherwise is the worse answer.
        return { ok: false, say: done === 0 ? hit.say : `${hit.say} ${sofar(done)}`.trim() };
      }
      done++;
      continue;
    }

    if (step.kind === "delete_row") {
      if (step.guard && (await apply.isReferenced(step.guard, step.id))) {
        return {
          ok: false,
          say: stopped(
            done,
            step.guard === "no_bill_payments"
              ? "something has been attached to that bill since, so removing it would leave that charge pointing at nothing"
              : "something has been paid against that debt since, so removing it would leave that payment pointing at nothing",
          ),
        };
      }
      const hit = await apply.deleteRow(step.table, step.id, step.after);
      if (hit === "moved") {
        return { ok: false, say: stopped(done, "that row is not the one I added any more") };
      }
      done++;
      continue;
    }
    const hit = await apply.setColumns(step.table, step.id, step.before, step.after);
    if (hit === "moved") {
      return { ok: false, say: stopped(done, "something has changed it since") };
    }
    done++;
  }
  return { ok: true, steps: done };
}

// ── a batch, undone row by row ───────────────────────────────────────────────

/**
 * The tools whose changes are a BATCH OF SEPARATE ROWS, which system.undo puts back
 * one row at a time instead of stopping at the first that moved.
 *
 * FOUND 2026-10-10 in review of finance.confirm_charges. applyUndo above is right for
 * a SEQUENCE: promoting a charge to a bill inserts the bill and then points the charge
 * at it, so if the charge has moved the bill must stay, and stopping is the only safe
 * answer. A batch is not a sequence. Fifty confirmed charges are fifty separate
 * answers, and one of them being re-filed on the phone says nothing about the other
 * forty-nine. Run through applyUndo, though, it froze them all for good: the undo
 * stopped at the re-filed row, the change stayed `undoable`, and every retry began
 * again from the last step — where the rows it HAD put back now held their old values,
 * read as "moved", and stopped it there. With MAX_STEPS at 8 and three real steps that
 * was rare; with fifty separate rows it is the likely case.
 *
 * WHY A LIST OF TOOL NAMES and not "any change whose steps are all set_columns on
 * different rows". The shape cannot tell a batch from a sequence that happens to be
 * all updates — settle_reimbursable's two rows are one answer about a charge and the
 * deposit that repays it, and putting one back without the other is a state nobody
 * asked for. Only the tool knows its rows are independent, so the tool says so by
 * being on this list. A tool name is stored in every muse_undo row it writes, so a
 * name here is permanent in the same way a handler name is: renaming the tool would
 * send its old tokens back through applyUndo.
 */
export const ROW_BY_ROW_TOOLS: ReadonlySet<string> = new Set(["finance.confirm_charges"]);

/** How a row-by-row undo went: rows put back, and rows that no longer held what the
 *  door wrote and so were left holding what they hold now. */
export interface RowByRowOutcome {
  putBack: number;
  changedSince: number;
}

/**
 * Put back every row of a batch that still holds what the door wrote, skip each one
 * that does not, and count both.
 *
 * Every step is still its own compare-and-set, so a row somebody has changed since —
 * re-filed on the phone, deleted, replaced by the bank — keeps that newer state; the
 * only thing that changes from applyUndo is that it does not stop the rows after it.
 * The order is still newest first, out of habit rather than need.
 *
 * It refuses, before writing anything, any change that is not a batch of separate
 * rows: a step of another kind, or one row named twice (the second step would be
 * checked against what the first had just put back). That is a step this door did not
 * write for a batch tool, and the honest answer is a sentence, not a guess.
 *
 * A database failure part-way throws, as applyUndo's does, and the change stays
 * `undoable`. A retry then finds the rows already put back holding their old values
 * and counts them as changed since — a wrong COUNT, never a wrong write, because the
 * compare-and-set still refuses each of them.
 */
export async function applyUndoRowByRow(
  steps: UndoStep[],
  apply: Pick<UndoApplier, "setColumns">,
): Promise<RowByRowOutcome> {
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "set_columns") {
      throw new UndoRefused("That undo is not a batch of separate rows, so I will not put it back one row at a time.");
    }
    const at = `${s.table}:${s.id}`;
    if (seen.has(at)) {
      throw new UndoRefused("That undo names one row twice, so I will not put it back one row at a time.");
    }
    seen.add(at);
  }
  let putBack = 0;
  let changedSince = 0;
  for (const s of [...steps].reverse()) {
    if (s.kind !== "set_columns") continue; // unreachable: checked above, and says so to the compiler
    if ((await apply.setColumns(s.table, s.id, s.before, s.after)) === "ok") putBack += 1;
    else changedSince += 1;
  }
  return { putBack, changedSince };
}

/** How far an undo got, in one clause. Split out of `stopped` because a handler step
 *  brings its own sentence and only needs this half added to it. */
function sofar(done: number): string {
  return done === 0
    ? "Nothing was changed."
    : done === 1
      ? "One part of it was already put back and stays put back."
      : `${done} parts of it were already put back and stay put back.`;
}

function stopped(done: number, why: string): string {
  return `I stopped: ${why}. ${sofar(done)} Have a look in the app before asking me again.`;
}

// ── saying it back ───────────────────────────────────────────────────────────

/** The cap on a change's summary, so it fits the column's own check and a reply. */
export const SUMMARY_CAP = 300;

/** A summary, safe to store and safe to say. Capped rather than refused, for the
 *  reason scrub.ts gives: this string is going INTO a row, and a shorter true line
 *  beats a refusal. */
export function undoSummary(raw: string): string {
  return scrubCap(raw, SUMMARY_CAP);
}

/**
 * One change, as `system.changes` reports it.
 *
 * Built key by key rather than spread, so nothing can ride along on a column added
 * to the table later — the same rule finance.worth_a_look follows. The summary is
 * scrubbed again on the way out even though it was scrubbed on the way in: Rule 4
 * is that every string out goes through the cleaner, so that "which strings were
 * checked" is not a judgement call a reader makes line by line.
 *
 * The STEPS ARE NEVER EMITTED. They hold the before-state of a row, which for a
 * deleted charge is the whole row, description included. That belongs in his
 * database, not in an assistant's context — so the reply says how many rows the
 * change touched and which tool made it, and the app is the place the detail is
 * read. What comes back is `can_undo` and the token, which is what "undo that"
 * needs.
 */
export function sayChange(r: UndoRecord): { [k: string]: UndoValue } {
  return {
    token: r.token,
    at: r.at,
    tool: r.tool,
    what: undoSummary(r.summary) || "a change I can no longer describe",
    rows_touched: r.steps.length,
    state: r.state,
    can_undo: r.state === "undoable",
    means: STATE_SAYS[r.state],
    undone_at: r.undoneAt,
  };
}
