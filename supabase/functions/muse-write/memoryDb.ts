// The four statements the memory store is allowed to run against its own table,
// and nothing else.
//
// Same shape as db.ts and for the same reason: every operation the door can
// perform on the database is a named entry on a list you can read in one sitting,
// so "what could this door possibly do to my data" has an answer that is not "it
// depends what SQL it builds". db.ts extends this interface, dbMemory.ts implements
// it over Supabase, and the tests drive a fake that implements the same four.
//
// Notice the shape of the two writes. `upsertMemory` carries the before-state it is
// replacing, and `forgetMemory` sets a timestamp rather than removing a row. There
// is no delete in here at all — a memory the assistant was told to forget is still
// in the table, which is what makes "no, bring that back" a single call instead of
// an apology.
//
// This file imports one type and nothing else, so it cannot be part of an import
// cycle: db.ts needs it, and it needs nothing from db.ts.

import type { Person } from "../_shared/muse/auth.ts";

/** A memory row as the write door needs to see it: enough to decide, and enough to
 *  hand back the call that reverses what it just did. */
export interface MemoryRecord {
  id: string;
  key: string;
  kind: string;
  value: string;
  tags: string[];
  /** Null while it is live. Set means he told the assistant to forget it, and
   *  remembering the same key again revives this row rather than making a second
   *  one wearing the same handle. */
  forgottenAt: string | null;
  /** What this row held before the last correction, or null. This is the undo, and
   *  it is read as well as written: `memory.restore` needs it, and it has to
   *  survive the audit log being trimmed, which is the second reason it is not
   *  kept there. */
  previous: { value: string; kind: string; tags: string[]; at: string } | null;
}

/** Everything a write needs to land, including the before-state it replaces. The
 *  door assembles this; the database does not compute any part of it. */
export interface MemoryUpsert {
  person: Person;
  key: string;
  kind: string;
  value: string;
  tags: string[];
  atISO: string;
  /** What the row held before this write, or null when the row is new. Stored in
   *  the row itself rather than in muse_audit: that log deliberately holds no
   *  reply bodies, and a second copy of the content is a second place for it to
   *  leak from. */
  previous: { value: string; kind: string; tags: string[]; at: string } | null;
}

export interface MemoryDb {
  /** The row under that key, live or forgotten, or null. Reads the whole row
   *  because every field of it is part of the before-state. */
  readMemory(person: Person, key: string): Promise<MemoryRecord | null>;
  /** How many live memories this person holds, for the cap. A count, not a list. */
  countMemories(person: Person): Promise<number>;
  /**
   * Insert, or update the row under (person, key).
   *
   * It always CLEARS `forgotten_at`, which is what makes remembering a forgotten
   * key revive that row instead of leaving two rows wearing the same handle with
   * one of them invisible. `memory.restore` uses the same statement to bring a
   * forgotten memory back, so there is one write path and one thing to get right.
   */
  upsertMemory(m: MemoryUpsert): Promise<string>;
  /**
   * Stamp a live memory as forgotten. "missing" means there was no LIVE row under
   * that key, so nothing was changed — which the door turns into a refusal rather
   * than a cheerful "done", because "I forgot it" about something that was never
   * there is the kind of lie that makes a memory store untrustworthy.
   */
  forgetMemory(person: Person, key: string, atISO: string): Promise<"ok" | "missing">;
}
