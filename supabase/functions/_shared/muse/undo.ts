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
  ],
  recurring: ["amount", "known_amount", "variable", "active", "starts_on", "ends_on"],
  accounts: ["balance"],
  debts: ["provider_account_id", "balance"],
  paid_bills: ["paid"],
  merchant_rules: ["kind", "category_id", "bill_name"],
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
  | { kind: "restore_money_event"; row: Record<string, UndoValue> };

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
 * as one of the two comfortable ones. See supabase/schema_v37_muse_undo.sql for why
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
  abandoned: "I did not do this. Something had changed the row since I read it, so I stopped.",
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

/** The most rows one write is allowed to touch. Three is today's maximum
 *  (promoting a charge to a bill: the new bill, the charge, the merchant rule), so
 *  this is loose enough not to be in the way and tight enough that a runaway list
 *  is refused rather than run. */
export const MAX_STEPS = 8;

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

function stopped(done: number, why: string): string {
  const already =
    done === 0
      ? "Nothing was changed."
      : done === 1
        ? "One part of it was already put back and stays put back."
        : `${done} parts of it were already put back and stay put back.`;
  return `I stopped: ${why}. ${already} Have a look in the app before asking me again.`;
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
