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
//   Notice what is NOT here: no delete, anywhere. No write to `transactions`,
//   `recurring`, `debts`, `savings_goals`, `paid_bills` or `food_cache`. The
//   forbidden list from PLAN.md §4 is enforced by absence — there is no verb to
//   reach for, so no amount of talking to the assistant can reach one.
//
// Rule 5 (every read is paged and fails closed) is satisfied here by never
// reading a whole table: every read below is a single row, a count, or a list
// with a hard `limit`. A read that could be truncated at 1,000 rows does not
// exist in this door.

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

export interface Db {
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

  // ── rate limits ───────────────────────────────────────────────────────────
  /** Increment one counter and return its new value, in a single statement. */
  bump(person: Person, bucket: string): Promise<number>;

  // ── reminders ─────────────────────────────────────────────────────────────
  /** How many of this person's reminders have not been delivered yet. */
  countOpenReminders(person: Person): Promise<number>;
  insertReminder(r: ReminderInsert): Promise<string>;

  // ── body weight ───────────────────────────────────────────────────────────
  /** The weigh-in already stored for that day, so the reply can say what it
   *  replaced instead of quietly overwriting it. */
  readWeight(person: Person, date: string): Promise<number | null>;
  upsertWeight(person: Person, date: string, weight: number, atISO: string): Promise<void>;

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
   */
  updateMealDayIfUnchanged(
    id: string,
    seenUpdatedAt: string,
    patch: { meals: unknown[]; atISO: string },
  ): Promise<"ok" | "stale">;

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
