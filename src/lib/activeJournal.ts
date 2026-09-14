// ── The crash-safe copy of the running session ───────────────────────────────
// Saves to the server wait ~700 ms (debounce) and then need the network. A set
// ticked in that gap — phone locked, app killed, tab reloaded, no signal in the
// gym — used to exist only in memory. So every change to a session that isn't
// finished is ALSO written to the phone at once, under `hb-active-<person>`, and
// on the next load that copy is merged back into the server's.
//
// One slot per person: it holds the session edited most recently. The store
// clears it once a finish of that session has reached the server, or when the
// session is deleted. Every storage call is wrapped — a private window, a full
// disk or blocked site data must never stop a set from being logged.

import type { ExerciseEntry, Workout } from "./workoutLog";
import { repairDuplicateSetIds, type SetIdMaker, type SyncSet, type Tombstones } from "./syncMerge";
import { isDone } from "./trainingMath";

export interface ActiveJournal {
  workout: Workout;
  savedAt: number; // ms since epoch, when this copy was written
  // What this phone deleted inside the session. Kept with the copy because the
  // store's in-memory record dies with the crash, and without it a set deleted
  // just before the crash would be adopted straight back from the server copy.
  removedExercises?: string[];
  removedSets?: string[];
}

export type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const journalKey = (person: string) => `hb-active-${person}`;

function defaultStorage(): JournalStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // the accessor itself can throw when site data is blocked
  }
}

function readRaw(person: string, storage: JournalStorage | null): Record<string, unknown> | null {
  if (!storage) return null;
  try {
    const v: unknown = JSON.parse(storage.getItem(journalKey(person)) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The stored copy for this person, or null when there is none or it doesn't look like a session. */
export function readJournal(person: string, storage: JournalStorage | null = defaultStorage()): ActiveJournal | null {
  const raw = readRaw(person, storage);
  const w = raw?.workout as Partial<Workout> | undefined;
  if (!raw || !w || typeof w !== "object") return null;
  if (typeof w.id !== "string" || typeof w.date !== "string" || w.person !== person || !Array.isArray(w.exercises)) return null;
  const exercisesOk = w.exercises.every(
    (e: Partial<ExerciseEntry> | null) => !!e && typeof e.id === "string" && Array.isArray(e.sets),
  );
  if (!exercisesOk) return null;
  return {
    workout: { ...(w as Workout), name: w.name ?? "", notes: w.notes ?? "", done: !!w.done },
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    removedExercises: isStringArray(raw.removedExercises) ? raw.removedExercises : undefined,
    removedSets: isStringArray(raw.removedSets) ? raw.removedSets : undefined,
  };
}

/**
 * Write the running session to the phone. Fields another piece keeps in the same
 * slot for the same session (a start time, a rest end time) are carried over;
 * a different session replaces the slot whole.
 */
export function writeJournal(
  w: Workout,
  opts: { removedExercises?: Iterable<string>; removedSets?: Iterable<string>; now?: number; storage?: JournalStorage | null } = {},
): void {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return;
  try {
    const prev = readRaw(w.person, storage);
    const sameSession = (prev?.workout as { id?: unknown } | undefined)?.id === w.id;
    const next: Record<string, unknown> = {
      ...(sameSession ? prev : {}),
      workout: w,
      savedAt: opts.now ?? Date.now(),
      removedExercises: [...(opts.removedExercises ?? [])],
      removedSets: [...(opts.removedSets ?? [])],
    };
    storage.setItem(journalKey(w.person), JSON.stringify(next));
  } catch {
    /* best effort: quota or blocked storage — the server save still runs */
  }
}

/** Remove the slot, but only if it still holds this session (a newer one may have replaced it). */
export function clearJournal(person: string, workoutId: string, storage: JournalStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const raw = readRaw(person, storage);
    if ((raw?.workout as { id?: unknown } | undefined)?.id !== workoutId) return;
    storage.removeItem(journalKey(person));
  } catch {
    /* best effort */
  }
}

// ── merging the phone copy with the server copy on load ─────────────────────
// Result for the store:
//   restore — this merged session differs from the server's; put it in state and save it
//   keep    — the server copy already holds everything; nothing to do
//   clear   — the phone copy is stale (the session was finished) or holds nothing worth keeping
export type JournalResolution =
  | { action: "restore"; workout: Workout; tombstones: { exercises: string[]; sets: string[] } }
  | { action: "keep" }
  | { action: "clear" };

const hasIds = (sets: SyncSet[]) => sets.every((s) => typeof s.id === "string" && s.id !== "");

/**
 * One set present on both sides. A tick is the thing that must not be lost, so:
 * both ticked → the later tick; only the server ticked → the server, if that tick
 * is newer than the phone copy (otherwise the phone un-ticked it afterwards);
 * otherwise the phone copy, which is this phone's newest edit.
 */
function pickSet(mine: SyncSet, theirs: SyncSet, savedAt: number): SyncSet {
  const md = isDone(mine);
  const td = isDone(theirs);
  if (md && td) return (theirs.doneAt ?? 0) > (mine.doneAt ?? 0) ? theirs : mine;
  if (td) return (theirs.doneAt ?? 0) > savedAt ? theirs : mine;
  return mine;
}

function mergeJournalExercises(mine: ExerciseEntry[], server: ExerciseEntry[], tomb: Tombstones, savedAt: number): ExerciseEntry[] {
  const serverById = new Map(server.map((e) => [e.id, e]));
  const out = mine.map((ex) => {
    const theirs = serverById.get(ex.id);
    if (!theirs) return ex;
    const ms = ex.sets as SyncSet[];
    const ts = theirs.sets as SyncSet[];
    // Sets without ids can't be matched: the phone's exercise wins whole, as in the live merge.
    if (!hasIds(ms) || !hasIds(ts)) return ex;
    const theirsById = new Map(ts.map((s) => [s.id as string, s]));
    const mineIds = new Set(ms.map((s) => s.id as string));
    const sets = ms.map((s) => {
      const t = theirsById.get(s.id as string);
      return t ? pickSet(s, t, savedAt) : s;
    });
    const added = new Set<string>();
    for (const t of ts) {
      const id = t.id as string;
      if (mineIds.has(id) || tomb.sets?.has(id) || added.has(id)) continue;
      added.add(id);
      sets.push(t);
    }
    return { ...ex, sets };
  });
  const mineIds = new Set(mine.map((e) => e.id));
  for (const e of server) if (!mineIds.has(e.id) && !tomb.exercises?.has(e.id)) out.push(e);
  return out;
}

const logsSomething = (w: Workout) =>
  w.exercises.some((ex) => (ex.duration ?? 0) > 0 || (ex.sets as SyncSet[]).some(isDone));

// Key-order-blind equality: the server stores exercises as JSONB, which reorders
// object keys, so comparing JSON text would call identical sessions different.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ak = keys(ao);
  return ak.length === keys(bo).length && ak.every((k) => same(ao[k], bo[k]));
}

export function resolveJournal(server: Workout | undefined, journal: ActiveJournal, makeId?: SetIdMaker): JournalResolution {
  const mine = repairDuplicateSetIds(journal.workout, makeId);
  // A finished session is done with its phone copy: the finish carried every set
  // this phone had. (Only a finish on ANOTHER phone could leave something behind
  // here, and re-opening a session someone finished is the worse surprise.)
  if (mine.done || server?.done) return { action: "clear" };
  const tombstones = { exercises: journal.removedExercises ?? [], sets: journal.removedSets ?? [] };
  if (!server) {
    // Never reached the server (or was deleted elsewhere). Worth bringing back
    // only if something was actually logged; an empty session is nothing lost.
    return logsSomething(mine) ? { action: "restore", workout: mine, tombstones } : { action: "clear" };
  }
  const tomb: Tombstones = { exercises: new Set(tombstones.exercises), sets: new Set(tombstones.sets) };
  const merged: Workout = { ...mine, exercises: mergeJournalExercises(mine.exercises, server.exercises, tomb, journal.savedAt) };
  const unchanged =
    same(merged.exercises, server.exercises) && merged.name === server.name && merged.notes === server.notes && merged.date === server.date;
  return unchanged ? { action: "keep" } : { action: "restore", workout: merged, tombstones };
}
