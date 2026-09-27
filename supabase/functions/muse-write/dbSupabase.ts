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
// There is exactly one delete in this file, and it can only remove the door's own
// 'pending' claim row in muse_audit. No tool can reach a delete on household data,
// because no such function exists here to call.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { memoryDb } from "./dbMemory.ts";
import type {
  CallRecord,
  Db,
  MealDayRow,
  Outcome,
  PendingInsert,
  ReminderInsert,
  SavedMealRow,
} from "./db.ts";

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
        .is("sent_at", null);
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
      const { error } = await admin
        .from("meal_days")
        .insert({ person: r.person, date: r.date, meals: r.meals, updated_at: r.atISO });
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
      const { data, error } = await admin
        .from("meal_days")
        .update({ meals: patch.meals, updated_at: patch.atISO })
        .eq("id", id)
        .eq("updated_at", seenUpdatedAt)
        .select("id");
      must(error, "update meal_days");
      return (data ?? []).length === 1 ? "ok" : "stale";
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
