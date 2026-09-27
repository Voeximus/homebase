// The memory store's four statements, wired to the real database.
//
// Same two habits as dbSupabase.ts, which spreads this in:
//
//   FAIL CLOSED. PostgREST does not throw — it hands back { data: null, error } —
//   so every call checks its error and throws. A write that looks like it worked is
//   worse here than a 500: the assistant would say "remembered" about nothing and
//   then never find it again.
//
//   READ NARROW. Each select names its columns. There is nothing sensitive in this
//   table beyond its own contents, but the habit is what keeps a later column from
//   arriving in a reply nobody decided to put it in.
//
// THERE IS NO DELETE IN THIS FILE. Forgetting stamps `forgotten_at`; that is the
// whole of it. Purging a forgotten memory for good is the by-hand statement at the
// bottom of schema_v37_muse_memory.sql, run by him, in the SQL editor, knowing that
// after it the forget cannot be undone.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { MemoryDb, MemoryRecord } from "./memoryDb.ts";

interface PgError {
  code?: string;
  message?: string;
}

function must(error: PgError | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message ?? "unknown error"}`);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];

export function memoryDb(admin: SupabaseClient): MemoryDb {
  const table = () => admin.from("muse_memory");

  return {
    async readMemory(person, key) {
      const { data, error } = await table()
        .select("id, key, kind, value, tags, forgotten_at, previous")
        .eq("person", person)
        .eq("key", key)
        .maybeSingle();
      must(error, "read muse_memory");
      if (!data) return null;
      const prev = data.previous as Record<string, unknown> | null;
      const row: MemoryRecord = {
        id: String(data.id),
        key: String(data.key ?? ""),
        kind: String(data.kind ?? ""),
        value: String(data.value ?? ""),
        tags: strings(data.tags),
        forgottenAt: data.forgotten_at ? String(data.forgotten_at) : null,
        previous:
          prev && typeof prev === "object" && typeof prev.value === "string" && prev.value
            ? {
                value: prev.value,
                kind: typeof prev.kind === "string" ? prev.kind : "",
                tags: strings(prev.tags),
                at: typeof prev.at === "string" ? prev.at : "",
              }
            : null,
      };
      return row;
    },

    async countMemories(person) {
      const { count, error } = await table()
        .select("id", { count: "exact", head: true })
        .eq("person", person)
        .is("forgotten_at", null);
      must(error, "count muse_memory");
      // A cap counted from an unreadable number must not read as "plenty of room".
      if (count === null) throw new Error("count muse_memory: no count returned");
      return count;
    },

    async upsertMemory(m) {
      // `forgotten_at: null` is written on EVERY upsert, not only when reviving.
      // That is what makes remembering a forgotten key bring the row back rather
      // than leaving a live-looking row with a forgotten stamp still on it.
      //
      // `learned_at` is deliberately absent from the update: the column keeps the
      // day the assistant first learned this, and a correction is not a new fact.
      // The default fills it on an insert.
      const { data, error } = await table()
        .upsert(
          {
            person: m.person,
            key: m.key,
            kind: m.kind,
            value: m.value,
            tags: m.tags,
            updated_at: m.atISO,
            forgotten_at: null,
            previous: m.previous,
          },
          { onConflict: "person,key" },
        )
        .select("id")
        .single();
      must(error, "upsert muse_memory");
      return String(data!.id);
    },

    async forgetMemory(person, key, atISO) {
      // Fenced on `forgotten_at is null`, so forgetting is idempotent in the
      // direction that matters: a second forget changes nothing and the stamp keeps
      // saying when it actually happened. Nothing coming back means there was no
      // live row — the caller turns that into a refusal rather than a cheerful
      // "done".
      const { data, error } = await table()
        .update({ forgotten_at: atISO, updated_at: atISO })
        .eq("person", person)
        .eq("key", key)
        .is("forgotten_at", null)
        .select("id");
      must(error, "forget muse_memory");
      return (data ?? []).length === 1 ? "ok" : "missing";
    },
  };
}
