// What the write door needs from the database, written down as a list of named
// operations instead of a query builder.
//
// WHY IT IS SHAPED LIKE THIS
//   Every operation below is one statement the door is allowed to run. There is
//   no "run this SQL" escape hatch, so the set of things the door can do to the
//   database is this file, and you can read it in one sitting. The tests drive a
//   fake that implements the same list, which is how the day-document race and
//   the duplicate guard get tested at all — neither is reachable through a real
//   Supabase call from a test runner.
//
//   WHAT PHASE 2 CHANGED, SAID PLAINLY. Phase 1's version of this comment read
//   "notice what is NOT here: no delete, anywhere", and that was the whole safety
//   story. It is not the story any more. His instruction for this phase is that
//   the assistant has every functionality the app has, and the thing that makes
//   that safe is not a shorter list of verbs — it is that every change captures
//   what was there before it, so it can be put back. So there ARE deletes below,
//   one per kind of row, and every tool that reaches one reads the row first and
//   returns an UndoRecord carrying it.
//
//   The rule that replaced "no delete" is narrower and stronger: a delete may
//   exist here only where the row it removes can be restored byte for byte. That
//   is why `deleteFood` and `deleteSavedMeal` take an id back on insert, and why
//   there is still nothing here that touches a bank connection — a Plaid
//   disconnect wipes the accounts and their entire transaction history, no
//   before-state can hold that, and it stays a code he types rather than a chat
//   command.
//
//   Still absent, by absence rather than by a flag: any write to a bank
//   connection, any write to `food_cache`, and any call to another edge function.
//
// Rule 5 (every read is paged and fails closed) is satisfied here by never
// reading a whole table: every read below is a single row, a count, or a list
// with a hard `limit`. A read that could be truncated at 1,000 rows does not
// exist in this door.

import type { ReminderRow } from "../_shared/muse/reminders.ts";
import type { FinanceDb } from "./dbFinance.ts";
// The memory store brings its own four statements. They are extended in rather
// than listed here so the memory table's operations sit beside the tools that use
// them, and so nothing in this file has to know how a memory works.
import type { MemoryDb } from "./memoryDb.ts";

export type Person = "gino" | "xinyan";

export type Outcome = "pending" | "ok" | "denied" | "rate_limited" | "error";

export interface CallRecord {
  outcome: Outcome;
  /** The redacted record of what was asked. Carries the payload fingerprint. */
  args: Record<string, unknown>;
  /** What the first call returned, replayed verbatim to a repeat. */
  result: unknown;
  note: string | null;
}

export interface SavedMealRow {
  id: string;
  name: string;
  /** The saved portions, copied into the day exactly as they are. The door does
   *  not read inside them and never computes a macro. */
  items: unknown[];
}

export interface MealDayRow {
  id: string;
  meals: unknown[];
  status: string | null;
  note: string | null;
  /** The value the compare-and-set writes against. See updateMealDayIfUnchanged. */
  updatedAt: string;
}

/**
 * One logged session, as one json document.
 *
 * `exercises` is opaque here for the same reason `meals` is: the shape belongs to
 * src/lib/workoutLog.ts and the tools that build it, and a seam that named the
 * fields would be a second definition of them. What this layer owes the tools is
 * the whole document and the version it was read at.
 */
export interface WorkoutRow {
  id: string;
  person: Person;
  date: string;
  name: string;
  notes: string;
  exercises: unknown[];
  done: boolean;
  /** The value the compare-and-set writes against. See updateWorkoutIfUnchanged. */
  updatedAt: string;
}

export interface RoutineRow {
  id: string;
  person: Person;
  name: string;
  meta: string;
  exercises: unknown[];
}

/** A row of the shared food library. Mirrors `foods` (schema_v6.sql) column for
 *  column, so an undo can put a deleted food back exactly as it was — including
 *  its id, which is what every logged portion's `foodId` still points at. */
export interface FoodRow {
  id: string;
  name: string;
  role: string;
  kcal: number;
  p: number;
  c: number;
  f: number;
  serving: number | null;
  note: string | null;
  barcode: string | null;
}

export interface MacroRow {
  kcal: number;
  p: number;
  c: number;
  f: number;
}

export interface ReminderInsert {
  person: Person;
  dueAt: string;
  repeats: "once" | "daily" | "weekly";
  message: string;
  source: string;
}

export interface PendingInsert {
  person: Person;
  tool: string;
  payload: Record<string, unknown>;
  summary: string;
}

/**
 * What a cancel or an edit may change on a reminder, and nothing else.
 *
 * `canceledAt` is how a cancel is spelled, and that is worth saying out loud: THERE
 * IS STILL NO DELETE IN THIS FILE. "Cancel" is an update that sets one timestamp, so
 * the row survives as the record that it was cancelled, the audit log's `row_ids`
 * points at something that still exists, and cron-reminders simply stops picking it
 * up. A delete verb here would be the first one in either door, and it would be
 * reachable by an assistant — see the list at the top of this file.
 */
export interface ReminderPatch {
  dueAt?: string;
  message?: string;
  repeats?: "once" | "daily" | "weekly";
  canceledAt?: string;
}

/** One reminder as the write door reads it. The shared `ReminderRow` shape, so the
 *  two doors and the cron job cannot disagree about what the columns mean. */
export type { ReminderRow };

/** The write the household already made, for the duplicate guard. */
export interface EarlierWrite {
  person: Person;
  /** When it happened, as the stored timestamp. The door turns it into minutes. */
  atISO: string;
}

/**
 * Everything the write door may do to the database.
 *
 * PHASE 2 WIDENED THIS, and the note above about "notice what is NOT here" now reads
 * differently, so it is restated rather than left to be contradicted by the code. The
 * finance half — writes to `transactions`, `recurring`, `accounts`, `debts`,
 * `paid_bills` and `merchant_rules` — lives in dbFinance.ts and is mixed in here. It
 * is not an escape hatch: those writes are fenced by the same allowlist of tables AND
 * columns that the undo core validates against, so the door can only write a column it
 * can also put back. What is still absent is anything that hard-deletes beyond
 * recovery — there is no way from here to disconnect a bank, and no way to delete a
 * bill or a bank-fed charge.
 *
 * The memory store's four statements come in the same way, from memoryDb.ts, and it
 * is the one table here that is not a fact about the house — it is what the assistant
 * was told to remember. Forgetting is a soft delete, so it is undoable like the rest.
 */
export interface Db extends FinanceDb, MemoryDb {
  // ── the audit log, which is also the duplicate guard ──────────────────────
  /** The earlier call under this idempotency key, or null. */
  findCall(person: Person, tool: string, idemKey: string): Promise<CallRecord | null>;
  /**
   * Write the 'pending' row that claims this idempotency key. "duplicate" means
   * the unique index refused it — somebody got here first, and the caller must
   * go back to findCall rather than act.
   */
  claimCall(c: {
    person: Person;
    tool: string;
    idemKey: string;
    args: Record<string, unknown>;
  }): Promise<"claimed" | "duplicate">;
  /**
   * Give a claimed key back, because the call was refused and NOTHING was
   * written. Every refusal in tools.ts happens before its first write, so this is
   * always true where it is called — and it matters: a corrected retry must not
   * be told "you already used that key" when the first attempt did nothing.
   */
  releaseCall(person: Person, tool: string, idemKey: string): Promise<void>;
  /** Close out a claimed row. Keyed the same way the claim was. */
  finishCall(c: {
    person: Person;
    tool: string;
    idemKey: string;
    outcome: Outcome;
    result?: unknown;
    rowIds?: string[];
    ms: number;
    note?: string;
  }): Promise<void>;
  /**
   * Record a call that never claimed a key — a refusal, or a rate limit. The
   * key stays free on purpose: nothing happened, so a corrected retry should not
   * be told "you already used that key".
   */
  logCall(c: {
    person: Person;
    tool: string;
    args: Record<string, unknown>;
    outcome: Outcome;
    note: string;
    ms: number;
  }): Promise<void>;

  /**
   * The most recent write of the same tool, with the same arguments, by EITHER
   * person, no older than `sinceISO` — or null when there is none.
   *
   * THE HOUSEHOLD CASE THIS EXISTS FOR. Two people, two assistants, one house. She
   * asks hers to record what the electric bill came to; four minutes later he asks
   * his the same thing, because neither of them knows the other already did it. The
   * idempotency key cannot see that: it is per caller and per request, and these are
   * two different callers sending two different keys. So the door asks its own audit
   * log whether the household has already done this, and says who did it.
   *
   * Matched on the payload fingerprint the audit row already carries, and only
   * against rows that got as far as claiming a key ('ok' or 'pending') — a refused
   * call did nothing, so it is not something that was "already done".
   */
  recentSameWrite(q: {
    tool: string;
    fingerprint: string;
    sinceISO: string;
  }): Promise<EarlierWrite | null>;

  // ── rate limits ───────────────────────────────────────────────────────────
  /** Increment one counter and return its new value, in a single statement. */
  bump(person: Person, bucket: string): Promise<number>;

  // ── reminders ─────────────────────────────────────────────────────────────
  /** How many of this person's reminders are still going to arrive — not
   *  delivered, and not cancelled. Cancelling one has to free a slot, or the cap
   *  becomes a wall nothing can get past. */
  countOpenReminders(person: Person): Promise<number>;
  insertReminder(r: ReminderInsert): Promise<string>;
  /**
   * One reminder by id, whoever it belongs to.
   *
   * It reads the row's `person` rather than filtering on it, because the tool has to
   * be able to tell "there is no such reminder" from "that one is hers" — and then
   * deliberately say the SAME thing for both. Filtering in the query would make that
   * choice by accident instead of on purpose.
   */
  readReminder(id: string): Promise<ReminderRow | null>;
  /**
   * Change a reminder, but only if it is still exactly as it was read.
   *
   * "stale" means something moved in the gap — the 15-minute job delivered it, or
   * advanced a repeating one's due time, or the other phone cancelled it. The caller
   * re-reads and says so; it does NOT write over what it has not seen. Same
   * compare-and-set shape as updateMealDayIfUnchanged, for the same reason: this
   * door and the cron job can both be inside the same row at the same second, and
   * the loser of that race must not be the one that silently wins.
   */
  updateReminderIfUnchanged(
    id: string,
    seen: { dueAt: string },
    patch: ReminderPatch,
  ): Promise<"ok" | "stale">;

  // ── body weight ───────────────────────────────────────────────────────────
  /** The weigh-in already stored for that day, so the reply can say what it
   *  replaced instead of quietly overwriting it. */
  readWeight(person: Person, date: string): Promise<number | null>;
  upsertWeight(person: Person, date: string, weight: number, atISO: string): Promise<void>;
  /** false = there was no weigh-in for that day. Not an error: it is the answer to
   *  "delete Tuesday's" when Tuesday was never logged. */
  deleteWeight(person: Person, date: string): Promise<boolean>;

  // ── saved meals ───────────────────────────────────────────────────────────
  /** Every saved meal whose name matches, ignoring case and outer spaces. */
  findSavedMealsByName(name: string): Promise<SavedMealRow[]>;
  /** A short list of names, for the "I do not know that one" reply. */
  listSavedMealNames(limit: number): Promise<string[]>;

  // ── the day document ──────────────────────────────────────────────────────
  readMealDay(person: Person, date: string): Promise<MealDayRow | null>;
  /** "conflict" means a row for that person and date appeared while we were
   *  deciding to insert one. Re-read and take the update path. */
  insertMealDay(r: {
    person: Person;
    date: string;
    meals: unknown[];
    /** Left out = the column keeps its default (null). Passed only by the tool
     *  that marks a day followed-roughly or off-plan on a day with no row yet. */
    status?: string | null;
    note?: string | null;
    atISO: string;
  }): Promise<"ok" | "conflict">;
  /**
   * Compare-and-set on the whole day document.
   *
   * The day is stored as ONE json document per person per date, so any write
   * replaces the lot — and a blind write erases whatever the phone logged since
   * we read. The app guards that by re-reading and merging. This door goes one
   * step further: the update only lands if `updated_at` is still the value we
   * read. "stale" means the phone wrote in the gap, and the caller re-reads and
   * tries again. That closes the window the app's own merge still leaves open.
   *
   * Every field in `patch` is OPTIONAL except the stamp, and only the fields
   * present are written. That matters: `status` and `note` are the other phone's
   * business as much as ours, so a tool that only adds a meal must not send them
   * at all rather than send back the values it happened to read. The app's own
   * write has the same rule — "nothing clears a status, so a day the other phone
   * marked skipped survives our write" (src/store/HealthStore.tsx).
   */
  updateMealDayIfUnchanged(
    id: string,
    seenUpdatedAt: string,
    patch: { meals?: unknown[]; status?: string | null; note?: string | null; atISO: string },
  ): Promise<"ok" | "stale">;

  // ── saved meals, as rows rather than as a lookup ───────────────────────────
  /** One saved meal by id, for editing, deleting, and for putting a deleted one
   *  back. Null when there is no such row. */
  readSavedMeal(id: string): Promise<SavedMealRow | null>;
  /** `id` is supplied only by an undo putting a deleted row back — a saved meal's
   *  id is what nothing else points at, but restoring the same one means a second
   *  undo of the same delete cannot create a duplicate. */
  insertSavedMeal(r: { id?: string; name: string; items: unknown[] }): Promise<string>;
  /** false = no such row. Only the fields present are written. */
  updateSavedMeal(id: string, patch: { name?: string; items?: unknown[] }): Promise<boolean>;
  deleteSavedMeal(id: string): Promise<boolean>;

  // ── the food library ──────────────────────────────────────────────────────
  readFood(id: string): Promise<FoodRow | null>;
  /**
   * The first library food with this name, ignoring case and outer spaces.
   *
   * It exists to REFUSE a duplicate, and the reason is a real trap rather than
   * tidiness: src/lib/mealLog.ts buildLibrary() dedupes the searchable library by
   * lower-cased name, custom foods first, so a second food called "Protein bar"
   * can never be found by search. The app has the same trap and lets you walk into
   * it; a door that let an assistant walk into it would be adding a row that can
   * only be seen by deleting the other one.
   */
  findFoodByName(name: string): Promise<FoodRow | null>;
  /** `id` supplied only by an undo putting a deleted food back — every logged
   *  portion's `foodId` points at it, so a restore under a new id would restore
   *  the food and orphan every portion of it. */
  insertFood(r: FoodRow & { id?: string }): Promise<string>;
  deleteFood(id: string): Promise<boolean>;

  // ── macro targets ─────────────────────────────────────────────────────────
  /** The saved row, or null when nobody has set one and the app is falling back to
   *  nutrition.ts's DAILY. The difference is what an undo has to restore. */
  readMacroTarget(person: Person): Promise<MacroRow | null>;
  upsertMacroTarget(person: Person, target: MacroRow, atISO: string): Promise<void>;
  /** Puts a person back to having no saved target at all — the only honest inverse
   *  of the first time one was ever set. */
  deleteMacroTarget(person: Person): Promise<boolean>;

  // ── the session document ──────────────────────────────────────────────────
  readWorkout(id: string): Promise<WorkoutRow | null>;
  /**
   * This person's unfinished session on that date, if there is one.
   *
   * The workout screen shows at most one running session and starting a second is
   * not something the app can do, so the door refuses it too rather than leaving
   * two half-logged sessions on one day for him to find later.
   */
  findOpenSession(person: Person, date: string): Promise<WorkoutRow | null>;
  /** "conflict" means that id is already taken. The door generates ids, so the
   *  only way to see this is an undo re-inserting a row that came back. */
  insertWorkout(r: WorkoutRow): Promise<"ok" | "conflict">;
  /**
   * Compare-and-set on the whole session document — the same guard as
   * updateMealDayIfUnchanged and for the same reason, spelled out in
   * src/store/HealthStore.tsx: "a session row is one document, so a blind upsert
   * drops any set the other device added". Two phones are in this app at once and
   * one of them may be mid-set while the door writes.
   */
  updateWorkoutIfUnchanged(
    id: string,
    seenUpdatedAt: string,
    patch: { name?: string; notes?: string; exercises?: unknown[]; done?: boolean; atISO: string },
  ): Promise<"ok" | "stale">;
  deleteWorkout(id: string): Promise<boolean>;

  // ── routines ──────────────────────────────────────────────────────────────
  readRoutine(id: string): Promise<RoutineRow | null>;
  /** This person's SAVED routines. The code-defined seeds are not rows and are
   *  added by the tool, exactly as the workout screen adds them. */
  listRoutines(person: Person): Promise<RoutineRow[]>;
  insertRoutine(r: RoutineRow): Promise<"ok" | "conflict">;
  deleteRoutine(id: string): Promise<boolean>;

  // ── queued writes ─────────────────────────────────────────────────────────
  /**
   * Does that charge exist? Used to refuse a queued write that could never
   * apply. Reads the id and NOTHING else — not the description, not the amount,
   * not the merchant. Rule 4 is not a filter on the way out; it is a rule about
   * what the door looks at.
   */
  transactionExists(id: string): Promise<boolean>;
  /**
   * The bill's own name, or null when there is no such bill. A bill row's name is
   * one of the few strings that may leave the door — he wrote it, it names a
   * bill and not a merchant — and it is needed, because "record a bill as
   * $123.45" with no name is a tap prompt nobody can answer. Scrubbed before it
   * goes anywhere.
   */
  recurringName(id: string): Promise<string | null>;
  /** The whole of the queued path: one row, and nothing in the ledger changes. */
  insertPending(r: PendingInsert): Promise<{ id: string; expiresAt: string }>;
}

/** What the door needs from the push helper. Kept to this shape so the tests can
 *  count pushes without a network. */
export type Push = (
  payload: { title: string; body: string; url?: string; tag?: string },
  owner: string,
) => Promise<void>;
