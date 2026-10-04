// The Db interface, wired to the real database. Nothing else in the door knows
// that Supabase exists.
//
// Two habits run through every function below:
//
//   FAIL CLOSED. Every call checks its error and throws. PostgREST does not throw
//   on its own — it hands back { data: null, error } — so an unchecked call is a
//   write that looks like it worked. The door answers 500 and changes nothing
//   rather than carrying on from a read that did not happen.
//
//   READ NARROW. Each select names the columns it needs and no others. The charge
//   check reads an id; the bill check reads a name. Neither ever reads a
//   description, an amount or a bank descriptor — Rule 4 is a rule about what the
//   door LOOKS at, not a filter bolted on the way out.
//
// THE DELETES. Phase 1 had exactly one — the door's own 'pending' claim row in
// muse_audit — and its comment said no tool could reach a delete on household data.
// Phase 2 changed that on purpose, and the rule that replaced it is narrower: a
// delete exists here only where the tool that reaches it read the whole row first
// and returned an undo record carrying it, so it can be put back byte for byte.
// That is why the two insert functions that take an id back (`insertSavedMeal`,
// `insertFood`) exist at all, and why there is still nothing here that touches a
// bank connection.
//
// EVERY DELETE ANSWERS "was there anything there". `.select("id")` on the delete
// and a length check, rather than a bare delete — because "removed it" and "there
// was nothing to remove" are different answers, and a tool that reported the second
// as the first is how a wrong date or a stale id goes unnoticed in a chat.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { memoryDb } from "./dbMemory.ts";
import type {
  CallRecord,
  Db,
  FoodRow,
  MacroRow,
  MealDayRow,
  Outcome,
  PendingInsert,
  Person,
  RoutineRow,
  SavedMealRow,
  ReminderInsert,
  WorkoutRow,
} from "./db.ts";
import { financeDb } from "./dbFinanceSupabase.ts";

interface PgError {
  code?: string;
  message?: string;
}

function must(error: PgError | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message ?? "unknown error"}`);
}

/** 23505 is a unique-index violation: somebody else got there first. That is an
 *  answer, not a failure. */
function isDuplicate(error: PgError | null): boolean {
  return error?.code === "23505";
}

/** Saved meals are a short household list. Reading a bounded slice and matching
 *  in code keeps the match EXACT — passing a typed name into a SQL pattern would
 *  make % and _ behave as wildcards, so a meal called "50_50 bowl" would quietly
 *  match the wrong row. */
const SAVED_MEAL_SCAN = 200;

/** Routines are a short per-person list, same reasoning as SAVED_MEAL_SCAN: read a
 *  bounded slice and match in code, so a name with % or _ in it cannot behave as a
 *  SQL wildcard and quietly match the wrong routine. */
const ROUTINE_SCAN = 100;

/** A `numeric` column arrives as a string from PostgREST. Named once so every
 *  mapper below reads the same way, and so a null comes back as 0 rather than NaN. */
const num = (v: unknown): number => Number(v ?? 0);
const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** Rows → the door's own shapes. Transcription only: renaming snake_case and
 *  turning a `numeric` string into a number, the same job _shared/muse/rows.ts does
 *  on the read door. Nothing here computes anything. */
function toFoodRow(r: Record<string, unknown>): FoodRow {
  return {
    id: str(r.id),
    name: str(r.name),
    role: str(r.role) || "other",
    kcal: num(r.kcal),
    p: num(r.p),
    c: num(r.c),
    f: num(r.f),
    serving: optNum(r.serving),
    note: optStr(r.note),
    barcode: optStr(r.barcode),
  };
}

function toWorkoutRow(r: Record<string, unknown>): WorkoutRow {
  return {
    id: str(r.id),
    person: str(r.person) as Person,
    date: str(r.date),
    name: str(r.name),
    notes: str(r.notes),
    exercises: list(r.exercises),
    done: !!r.done,
    updatedAt: str(r.updated_at),
  };
}

function toRoutineRow(r: Record<string, unknown>): RoutineRow {
  return {
    id: str(r.id),
    person: str(r.person) as Person,
    name: str(r.name),
    meta: str(r.meta),
    exercises: list(r.exercises),
  };
}

export function supabaseDb(admin: SupabaseClient): Db {
  const audit = () => admin.from("muse_audit");

  async function savedMealSlice(): Promise<SavedMealRow[]> {
    const { data, error } = await admin
      .from("saved_meals")
      .select("id, name, items")
      .order("created_at", { ascending: true })
      .limit(SAVED_MEAL_SCAN);
    must(error, "read saved_meals");
    return (data ?? []).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      items: Array.isArray(r.items) ? (r.items as unknown[]) : [],
    }));
  }

  return {
    // Phase 2's finance half, wired in dbFinanceSupabase.ts. A separate file rather
    // than more of this one, because it is the half whose writes touch the ledger and
    // it carries its own fence: a column name cannot reach PostgREST unless the undo
    // core can also put that column back.
    ...financeDb(admin),
    // The memory store's four statements, implemented in their own file beside the
    // tools that use them. Spread in, so this file stays the ledger's wiring.
    ...memoryDb(admin),

    async findCall(person, tool, idemKey) {
      const { data, error } = await audit()
        .select("outcome, args, result, note")
        .eq("person", person)
        .eq("tool", tool)
        .eq("idem_key", idemKey)
        .maybeSingle();
      must(error, "read muse_audit");
      if (!data) return null;
      const rec: CallRecord = {
        outcome: data.outcome as Outcome,
        args: (data.args ?? {}) as Record<string, unknown>,
        result: data.result,
        note: (data.note as string | null) ?? null,
      };
      return rec;
    },

    async claimCall(c) {
      const { error } = await audit().insert({
        person: c.person,
        door: "write",
        tool: c.tool,
        idem_key: c.idemKey,
        args: c.args,
        outcome: "pending",
      });
      if (!error) return "claimed";
      if (isDuplicate(error)) return "duplicate";
      must(error, "claim muse_audit");
      return "duplicate"; // unreachable; must() threw
    },

    async releaseCall(person, tool, idemKey) {
      // The one delete in the door, and it is fenced twice: this person's row,
      // under this key, and only while it is still 'pending'. A finished row can
      // never be removed by anything here.
      const { error } = await audit()
        .delete()
        .eq("person", person)
        .eq("tool", tool)
        .eq("idem_key", idemKey)
        .eq("outcome", "pending");
      must(error, "release muse_audit claim");
    },

    async finishCall(c) {
      const { error } = await audit()
        .update({
          outcome: c.outcome,
          result: c.result ?? null,
          row_ids: c.rowIds ?? [],
          ms: c.ms,
          note: c.note ?? null,
        })
        .eq("person", c.person)
        .eq("tool", c.tool)
        .eq("idem_key", c.idemKey);
      must(error, "finish muse_audit");
    },

    async logCall(c) {
      const { error } = await audit().insert({
        person: c.person,
        door: "write",
        tool: c.tool,
        args: c.args,
        outcome: c.outcome,
        note: c.note,
        ms: c.ms,
      });
      must(error, "write muse_audit");
    },

    async recentSameWrite({ tool, fingerprint, sinceISO }) {
      // Matched on the fingerprint the audit row already carries, inside jsonb, so
      // nothing new has to be stored for this and the guard works on rows written
      // before it existed. `outcome` is restricted to the two that mean something
      // was actually attempted: a 'denied' or 'rate_limited' row did nothing, and
      // treating it as "already done" would refuse the corrected retry.
      const { data, error } = await audit()
        .select("person, at")
        .eq("door", "write")
        .eq("tool", tool)
        .eq("args->>fingerprint", fingerprint)
        .in("outcome", ["ok", "pending"])
        .gte("at", sinceISO)
        .order("at", { ascending: false })
        .limit(1);
      must(error, "read muse_audit for a duplicate");
      const row = (data ?? [])[0];
      if (!row) return null;
      return { person: row.person as "gino" | "xinyan", atISO: String(row.at) };
    },

    async bump(person, bucket) {
      const { data, error } = await admin.rpc("muse_bump", { p_person: person, p_bucket: bucket });
      must(error, "bump muse_calls");
      const n = Number(data);
      // A counter that came back unreadable must not read as "plenty left".
      if (!Number.isFinite(n)) throw new Error("bump muse_calls: no count returned");
      return n;
    },

    async countOpenReminders(person) {
      const { count, error } = await admin
        .from("reminders")
        .select("id", { count: "exact", head: true })
        .eq("person", person)
        .is("sent_at", null)
        // A cancelled reminder is not waiting for anything. Without this line,
        // cancelling one would free nothing and the open cap would be a wall: twenty
        // cancelled rows and no way to add a twenty-first reminder ever again.
        .is("canceled_at", null);
      must(error, "count reminders");
      if (count === null) throw new Error("count reminders: no count returned");
      return count;
    },

    async insertReminder(r: ReminderInsert) {
      const { data, error } = await admin
        .from("reminders")
        .insert({
          person: r.person,
          due_at: r.dueAt,
          repeats: r.repeats,
          message: r.message,
          source: r.source,
        })
        .select("id")
        .single();
      must(error, "insert reminder");
      return String(data!.id);
    },

    async readReminder(id) {
      // No `person` filter, on purpose: the tool needs to know the row exists and
      // whose it is, so that it can answer the same way for "no such reminder" and
      // "that one is hers". A filter here would hide the difference from the code
      // that has to make that choice deliberately.
      const { data, error } = await admin
        .from("reminders")
        .select("id, person, message, due_at, repeats, source, sent_at, last_sent_at, canceled_at")
        .eq("id", id)
        .maybeSingle();
      must(error, "read reminders");
      if (!data) return null;
      return {
        id: String(data.id),
        person: String(data.person),
        message: String(data.message ?? ""),
        dueAt: String(data.due_at),
        repeats: String(data.repeats ?? "once"),
        source: String(data.source ?? ""),
        sentAt: (data.sent_at as string | null) ?? null,
        lastSentAt: (data.last_sent_at as string | null) ?? null,
        canceledAt: (data.canceled_at as string | null) ?? null,
      };
    },

    async updateReminderIfUnchanged(id, seen, patch) {
      const row: Record<string, unknown> = {};
      if (patch.dueAt !== undefined) row.due_at = patch.dueAt;
      if (patch.message !== undefined) row.message = patch.message;
      if (patch.repeats !== undefined) row.repeats = patch.repeats;
      if (patch.canceledAt !== undefined) row.canceled_at = patch.canceledAt;
      // Compare-and-set, and all four conditions are load-bearing:
      //   · the id, obviously;
      //   · `due_at` still the value that was read — a repeating reminder that the
      //     cron job advanced in the gap is a DIFFERENT reminder now, and editing
      //     "9 AM tomorrow" when it has already moved to 9 AM the day after is a
      //     wrong row written confidently;
      //   · `sent_at` still null — a reminder that went out in the gap cannot be
      //     cancelled, and answering "cancelled" while the push is already on the
      //     lock screen is the worst lie this tool could tell;
      //   · `canceled_at` still null — the other phone's cancel wins, and the caller
      //     is told so rather than quietly resurrecting it.
      const { data, error } = await admin
        .from("reminders")
        .update(row)
        .eq("id", id)
        .eq("due_at", seen.dueAt)
        .is("sent_at", null)
        .is("canceled_at", null)
        .select("id");
      must(error, "update reminders");
      return (data ?? []).length === 1 ? "ok" : "stale";
    },

    async readWeight(person, date) {
      const { data, error } = await admin
        .from("body_weights")
        .select("weight")
        .eq("person", person)
        .eq("date", date)
        .maybeSingle();
      must(error, "read body_weights");
      return data ? Number(data.weight) : null;
    },

    async upsertWeight(person, date, weight, atISO) {
      const { error } = await admin
        .from("body_weights")
        .upsert({ person, date, weight, updated_at: atISO }, { onConflict: "person,date" });
      must(error, "upsert body_weights");
    },

    async deleteWeight(person, date) {
      const { data, error } = await admin
        .from("body_weights")
        .delete()
        .eq("person", person)
        .eq("date", date)
        .select("id");
      must(error, "delete body_weights");
      return (data ?? []).length > 0;
    },

    async findSavedMealsByName(name) {
      const want = name.trim().toLowerCase();
      return (await savedMealSlice()).filter((m) => m.name.trim().toLowerCase() === want);
    },

    async listSavedMealNames(limit) {
      return (await savedMealSlice()).map((m) => m.name).filter(Boolean).slice(0, limit);
    },

    async readMealDay(person, date) {
      const { data, error } = await admin
        .from("meal_days")
        .select("id, meals, status, note, updated_at")
        .eq("person", person)
        .eq("date", date)
        .maybeSingle();
      must(error, "read meal_days");
      if (!data) return null;
      const row: MealDayRow = {
        id: String(data.id),
        meals: Array.isArray(data.meals) ? (data.meals as unknown[]) : [],
        status: (data.status as string | null) ?? null,
        note: (data.note as string | null) ?? null,
        updatedAt: String(data.updated_at),
      };
      return row;
    },

    async insertMealDay(r) {
      const row: Record<string, unknown> = {
        person: r.person,
        date: r.date,
        meals: r.meals,
        updated_at: r.atISO,
      };
      // Only when the caller passed them. Sending status: null explicitly would be
      // the same value the column defaults to today, but writing a field a tool did
      // not ask about is the habit that erases the other phone's work.
      if (r.status !== undefined) row.status = r.status;
      if (r.note !== undefined) row.note = r.note;
      const { error } = await admin.from("meal_days").insert(row);
      if (!error) return "ok";
      if (isDuplicate(error)) return "conflict";
      must(error, "insert meal_days");
      return "conflict"; // unreachable; must() threw
    },

    async updateMealDayIfUnchanged(id, seenUpdatedAt, patch) {
      // Compare-and-set. The whole day is one document, so the update may only
      // land on the exact version that was read — `updated_at` is the version.
      // Nothing comes back means the phone wrote in the gap, and the caller
      // re-reads rather than replacing a document it has not seen.
      //
      // Only the fields the patch names are sent. A tool that adds a meal must not
      // write `status` back, even to the value it just read: that read is a moment
      // old, and the app's own rule is that "nothing clears a status, so a day the
      // other phone marked skipped survives our write".
      const fields: Record<string, unknown> = { updated_at: patch.atISO };
      if (patch.meals !== undefined) fields.meals = patch.meals;
      if (patch.status !== undefined) fields.status = patch.status;
      if (patch.note !== undefined) fields.note = patch.note;
      const { data, error } = await admin
        .from("meal_days")
        .update(fields)
        .eq("id", id)
        .eq("updated_at", seenUpdatedAt)
        .select("id");
      must(error, "update meal_days");
      return (data ?? []).length === 1 ? "ok" : "stale";
    },

    // ── saved meals ─────────────────────────────────────────────────────────
    async readSavedMeal(id) {
      const { data, error } = await admin
        .from("saved_meals")
        .select("id, name, items")
        .eq("id", id)
        .maybeSingle();
      must(error, "read saved_meals");
      if (!data) return null;
      const row: SavedMealRow = { id: str(data.id), name: str(data.name), items: list(data.items) };
      return row;
    },

    async insertSavedMeal(r) {
      // The id is sent only when an undo is putting a deleted row back under its own
      // id; otherwise the column's default generates one.
      const row: Record<string, unknown> = { name: r.name, items: r.items };
      if (r.id) row.id = r.id;
      const { data, error } = await admin.from("saved_meals").insert(row).select("id").single();
      must(error, "insert saved_meals");
      return String(data!.id);
    },

    async updateSavedMeal(id, patch) {
      const fields: Record<string, unknown> = {};
      if (patch.name !== undefined) fields.name = patch.name;
      if (patch.items !== undefined) fields.items = patch.items;
      if (Object.keys(fields).length === 0) return true;
      const { data, error } = await admin.from("saved_meals").update(fields).eq("id", id).select("id");
      must(error, "update saved_meals");
      return (data ?? []).length > 0;
    },

    async deleteSavedMeal(id) {
      const { data, error } = await admin.from("saved_meals").delete().eq("id", id).select("id");
      must(error, "delete saved_meals");
      return (data ?? []).length > 0;
    },

    // ── the food library ────────────────────────────────────────────────────
    async readFood(id) {
      const { data, error } = await admin
        .from("foods")
        .select("id, name, role, kcal, p, c, f, serving, note, barcode")
        .eq("id", id)
        .maybeSingle();
      must(error, "read foods");
      return data ? toFoodRow(data) : null;
    },

    async findFoodByName(name) {
      // `ilike` with the name ESCAPED, not interpolated: % and _ are wildcards in a
      // pattern, so a food called "50_50 bowl" would otherwise match "5000 bowl"
      // and the duplicate check would refuse the wrong thing.
      const pattern = name.trim().replace(/([\\%_])/g, "\\$1");
      const { data, error } = await admin
        .from("foods")
        .select("id, name, role, kcal, p, c, f, serving, note, barcode")
        .ilike("name", pattern)
        .order("created_at", { ascending: true })
        .limit(1);
      must(error, "read foods by name");
      const row = (data ?? [])[0];
      return row ? toFoodRow(row) : null;
    },

    async insertFood(r) {
      const row: Record<string, unknown> = {
        name: r.name,
        role: r.role,
        kcal: r.kcal,
        p: r.p,
        c: r.c,
        f: r.f,
        serving: r.serving,
        note: r.note,
        barcode: r.barcode,
      };
      // Its own id when an undo is restoring one: every logged portion's `foodId`
      // points at it, so a restore under a new id would orphan the history.
      if (r.id) row.id = r.id;
      const { data, error } = await admin.from("foods").insert(row).select("id").single();
      must(error, "insert foods");
      return String(data!.id);
    },

    async deleteFood(id) {
      const { data, error } = await admin.from("foods").delete().eq("id", id).select("id");
      must(error, "delete foods");
      return (data ?? []).length > 0;
    },

    // ── macro targets ──────────────────────────────────────────────────────
    async readMacroTarget(person) {
      const { data, error } = await admin
        .from("macro_targets")
        .select("kcal, p, c, f")
        .eq("person", person)
        .maybeSingle();
      must(error, "read macro_targets");
      if (!data) return null;
      const row: MacroRow = { kcal: num(data.kcal), p: num(data.p), c: num(data.c), f: num(data.f) };
      return row;
    },

    async upsertMacroTarget(person: Person, target: MacroRow, atISO: string) {
      const { error } = await admin
        .from("macro_targets")
        .upsert({ person, kcal: target.kcal, p: target.p, c: target.c, f: target.f, updated_at: atISO }, {
          onConflict: "person",
        });
      must(error, "upsert macro_targets");
    },

    async deleteMacroTarget(person) {
      const { data, error } = await admin
        .from("macro_targets")
        .delete()
        .eq("person", person)
        .select("person");
      must(error, "delete macro_targets");
      return (data ?? []).length > 0;
    },

    // ── the session document ───────────────────────────────────────────────
    async readWorkout(id) {
      const { data, error } = await admin
        .from("workouts")
        .select("id, person, date, name, notes, exercises, done, updated_at")
        .eq("id", id)
        .maybeSingle();
      must(error, "read workouts");
      return data ? toWorkoutRow(data) : null;
    },

    async findOpenSession(person, date) {
      const { data, error } = await admin
        .from("workouts")
        .select("id, person, date, name, notes, exercises, done, updated_at")
        .eq("person", person)
        .eq("date", date)
        .eq("done", false)
        .order("created_at", { ascending: true })
        .limit(1);
      must(error, "read open workouts");
      const row = (data ?? [])[0];
      return row ? toWorkoutRow(row) : null;
    },

    async insertWorkout(r: WorkoutRow) {
      const { error } = await admin.from("workouts").insert({
        id: r.id,
        person: r.person,
        date: r.date,
        name: r.name,
        notes: r.notes,
        exercises: r.exercises,
        done: r.done,
        updated_at: r.updatedAt,
      });
      if (!error) return "ok";
      if (isDuplicate(error)) return "conflict";
      must(error, "insert workouts");
      return "conflict"; // unreachable; must() threw
    },

    async updateWorkoutIfUnchanged(id, seenUpdatedAt, patch) {
      // The same compare-and-set as meal_days, and for the same reason: a session
      // row is one json document, so any write replaces the lot, and the other
      // phone may be mid-set.
      const fields: Record<string, unknown> = { updated_at: patch.atISO };
      if (patch.name !== undefined) fields.name = patch.name;
      if (patch.notes !== undefined) fields.notes = patch.notes;
      if (patch.exercises !== undefined) fields.exercises = patch.exercises;
      if (patch.done !== undefined) fields.done = patch.done;
      const { data, error } = await admin
        .from("workouts")
        .update(fields)
        .eq("id", id)
        .eq("updated_at", seenUpdatedAt)
        .select("id");
      must(error, "update workouts");
      return (data ?? []).length === 1 ? "ok" : "stale";
    },

    async deleteWorkout(id) {
      const { data, error } = await admin.from("workouts").delete().eq("id", id).select("id");
      must(error, "delete workouts");
      return (data ?? []).length > 0;
    },

    // ── routines ───────────────────────────────────────────────────────────
    async readRoutine(id) {
      const { data, error } = await admin
        .from("workout_routines")
        .select("id, person, name, meta, exercises")
        .eq("id", id)
        .maybeSingle();
      must(error, "read workout_routines");
      return data ? toRoutineRow(data) : null;
    },

    async listRoutines(person) {
      const { data, error } = await admin
        .from("workout_routines")
        .select("id, person, name, meta, exercises")
        .eq("person", person)
        .order("created_at", { ascending: true })
        .limit(ROUTINE_SCAN);
      must(error, "read workout_routines");
      return (data ?? []).map(toRoutineRow);
    },

    async insertRoutine(r: RoutineRow) {
      const { error } = await admin.from("workout_routines").insert({
        id: r.id,
        person: r.person,
        name: r.name,
        meta: r.meta,
        exercises: r.exercises,
      });
      if (!error) return "ok";
      if (isDuplicate(error)) return "conflict";
      must(error, "insert workout_routines");
      return "conflict"; // unreachable; must() threw
    },

    async deleteRoutine(id) {
      const { data, error } = await admin.from("workout_routines").delete().eq("id", id).select("id");
      must(error, "delete workout_routines");
      return (data ?? []).length > 0;
    },

    async transactionExists(id) {
      const { data, error } = await admin
        .from("transactions")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      must(error, "read transactions");
      return !!data;
    },

    async recurringName(id) {
      const { data, error } = await admin
        .from("recurring")
        .select("name")
        .eq("id", id)
        .maybeSingle();
      must(error, "read recurring");
      return data ? String(data.name ?? "") : null;
    },

    async insertPending(r: PendingInsert) {
      const { data, error } = await admin
        .from("muse_pending")
        .insert({ person: r.person, tool: r.tool, payload: r.payload, summary: r.summary })
        .select("id, expires_at")
        .single();
      must(error, "insert muse_pending");
      return { id: String(data!.id), expiresAt: String(data!.expires_at) };
    },
  };
}
