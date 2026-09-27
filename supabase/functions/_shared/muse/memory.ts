// What a memory IS. One spelling, imported by both doors.
//
// The read door recalls, searches and lists; the write door remembers and
// forgets. If each of them carried its own idea of what a key looks like, what
// kinds exist, or how long a value may be, the two would drift — and this is the
// one table where drift is not a wrong number but a row the assistant can write
// and then never find again. The repo has the receipts for two copies of one rule
// (the two az.ts files, the two scrub.ts files), so there is one copy of this.
//
// WHY THE TABLE EXISTS. supabase/schema_v40_muse_memory.sql says it at length.
// The short version: Muse's own memory is a black box he cannot read, correct,
// copy, or take with him. This table is the same feature in his own Postgres, in
// five plain columns, so the memory survives him leaving Meta.
//
// THE ONE RULE OF THE STORE. It holds what the ledger cannot compute — standing
// rules, preferences, routines, decisions already made. Never a figure a tool can
// answer. A balance copied in here is a number that was true once and will be
// spoken as current forever, which is the failure this whole bridge exists to
// prevent ("Electric $85" on every phone while every screen said $100).
//
// THE DIRECTION THIS FILE DEFENDS. Everything in this table is read straight back
// into a model's context labelled as trusted output from a connector he installed,
// and everything in it was written BY a model — which may have been talked into
// writing anything by a web page it read. So a memory is scrubbed on the way IN
// (refused, not quietly cleaned — see memoryWrites.ts) and scrubbed again on the
// way OUT, here. Twice, because the two halves defend different days: the way in
// stops a bad row being stored, and the way out stops a row that was stored
// before this rule existed, or typed into the SQL editor by hand, from being said.
//
// NO CLOCK IN HERE. `azDateOf` converts a timestamp the database handed us. That
// is not reading a clock — the same thing azWallClock does in az.ts — and it goes
// through az.ts's own parser so there is no second spelling of "what an instant
// is". scripts/check-categorizer-sync.mjs greps this folder for `new Date(`.

import { azDateISO, nowAZ, parseInstant } from "./az.ts";
import { scrub } from "./scrub.ts";
import type { DbRow } from "./paging.ts";
import type { Json } from "./args.ts";

/**
 * The five kinds, and the list is closed on purpose: it is what stops this table
 * turning into a diary. Anything that does not fit one of these is either a
 * reminder (which has its own table and its own delivery) or a number the ledger
 * already holds.
 *
 * The wording of each one is in docs/research/muse-bridge/API.md, which is what
 * the assistant actually reads. Kept short here so the two cannot disagree about
 * WHICH kinds exist, which is the part a test can check.
 */
export const MEMORY_KINDS = ["standing", "preference", "routine", "decided", "fact"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** A handle, not a sentence: lower case, dashes, 2 to 48 characters. The same
 *  shape the table's own check constraint enforces. */
export const MEMORY_KEY = /^[a-z][a-z0-9-]{1,47}$/;

/** One line, one or two sentences. Longer than this is a document, and a document
 *  belongs in the app where he can read it on a screen. */
export const VALUE_MAX = 300;

/** Tags narrow a search. Slugs, same family as the key, and few — a row wearing
 *  ten tags is a row nobody will ever find by any of them. */
export const TAG_MAX = 24;
export const TAGS_MAX = 6;

/**
 * How many live memories one person may hold.
 *
 * Not a storage limit — 200 rows is nothing. It is a shape limit. This table holds
 * the things that do not change: standing rules, preferences, routines, settled
 * decisions. Realistically that is tens, growing over years. Past two hundred,
 * something has gone wrong — an assistant is journaling into it, or copying
 * figures the ledger already answers — and the cap turns that into a refusal he
 * can see instead of a table that quietly becomes a diary.
 *
 * It is also the thing that keeps `memory.list` finite: two pages cover
 * everything, so "tell me everything you know" is always answerable.
 */
export const LIVE_MAX = 200;

/** One page of `memory.list`. Two pages reach LIVE_MAX. */
export const LIST_PAGE = 100;

/** The most `memory.search` will hand back at once. A search that matches more
 *  than this is a search that needed narrowing, and the reply says so. */
export const SEARCH_MAX = 50;

/** A memory as the table holds it. Mapped once, here, so no tool reads a column
 *  name. */
export interface MemoryRow {
  id: string;
  person: string;
  key: string;
  kind: string;
  value: string;
  tags: string[];
  source: string;
  learnedAt: string;
  updatedAt: string;
  /** Null for a live memory; the instant it was forgotten otherwise. */
  forgottenAt: string | null;
  /** What this row held before the last change, or null. One step. */
  previous: { value: string; kind: string; tags: string[]; at: string } | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

export function toMemoryRow(row: DbRow): MemoryRow {
  const prev = row.previous;
  const previous =
    prev && typeof prev === "object" && !Array.isArray(prev)
      ? {
          value: str((prev as DbRow).value),
          kind: str((prev as DbRow).kind),
          tags: strings((prev as DbRow).tags),
          at: str((prev as DbRow).at),
        }
      : null;
  return {
    id: str(row.id),
    person: str(row.person),
    key: str(row.key),
    kind: str(row.kind),
    value: str(row.value),
    tags: strings(row.tags),
    source: str(row.source),
    learnedAt: str(row.learned_at),
    updatedAt: str(row.updated_at),
    forgottenAt: typeof row.forgotten_at === "string" && row.forgotten_at ? row.forgotten_at : null,
    // A previous with no value in it is not a before-state, it is a null wearing a
    // shape. Undo would then "restore" an empty memory, which is worse than
    // refusing to undo at all.
    previous: previous && previous.value ? previous : null,
  };
}

/**
 * A stored timestamp as its Arizona calendar date, or null.
 *
 * Postgres hands these over in UTC. From 5 PM Arizona onward UTC has already
 * rolled the date forward, so slicing the first ten characters off the string
 * would date half of his waking day to tomorrow — the exact bug az.ts exists for.
 * He works nights, so that is not an edge case.
 *
 * `nowAZ` with an explicit instant is a converter, not a clock reading: it is the
 * same call every tool makes on the instant the handler built once.
 */
export function azDateOf(iso: unknown): string | null {
  const at = parseInstant(typeof iso === "string" ? iso : "");
  return at ? azDateISO(nowAZ(at)) : null;
}

/** The sentence a memory that cannot be said is replaced by. A row can reach this
 *  only by being written outside the door — the write door refuses rather than
 *  storing something it would have to clean. */
export const UNSAYABLE = "This memory has something in it I will not read out. Open the app.";

/**
 * One memory, safe to hand back.
 *
 * Every string goes through scrub() — Rule 4, and here it is the rule that
 * matters most, because this string is about to be read back as trusted context.
 * A value that will not survive cleaning is replaced whole, never sliced: half a
 * standing rule is worse than none ("$1,400 a check is a" would be obeyed).
 *
 * `previous` comes out too, and that is deliberate: it is what makes "undo that"
 * work from a NEW conversation, where the reply that carried the inverse call is
 * long gone.
 */
export function saidMemory(m: MemoryRow): { [k: string]: Json } {
  const out: { [k: string]: Json } = {
    key: scrub(m.key) ?? "a memory with an unreadable name",
    kind: scrub(m.kind, TAG_MAX) ?? "fact",
    value: scrub(m.value, VALUE_MAX) ?? UNSAYABLE,
    tags: m.tags.map((t) => scrub(t, TAG_MAX)).filter((t): t is string => !!t),
    learned_on: azDateOf(m.learnedAt),
    source: scrub(m.source, TAG_MAX) ?? "unknown",
  };
  const changed = azDateOf(m.updatedAt);
  if (changed && changed !== out.learned_on) out.changed_on = changed;
  if (m.forgottenAt) out.forgotten_on = azDateOf(m.forgottenAt);
  if (m.previous) {
    out.previous = {
      value: scrub(m.previous.value, VALUE_MAX) ?? UNSAYABLE,
      kind: scrub(m.previous.kind, TAG_MAX) ?? "fact",
      tags: m.previous.tags.map((t) => scrub(t, TAG_MAX)).filter((t): t is string => !!t),
    };
  }
  return out;
}

/** Live, in the order a person would read them: kind first, then key. Stable, so
 *  two pages of `memory.list` cannot repeat or skip a row. */
export function liveMemories(rows: MemoryRow[]): MemoryRow[] {
  return rows
    .filter((m) => !m.forgottenAt)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/**
 * Does this text match? Case-insensitive substring across the key, the value and
 * the tags.
 *
 * Matched in CODE rather than in SQL, and that is not laziness. A typed string
 * passed into a SQL pattern makes `%` and `_` behave as wildcards, so searching
 * for "50_50" would quietly match rows that do not contain it — the same trap
 * dbSupabase.ts already avoids for saved meals by reading a bounded slice and
 * comparing here. This table is capped at LIVE_MAX rows per person, so the whole
 * of it is a small read.
 */
export function matchesText(m: MemoryRow, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return false;
  if (m.key.toLowerCase().includes(q)) return true;
  if (m.value.toLowerCase().includes(q)) return true;
  return m.tags.some((t) => t.toLowerCase().includes(q));
}
