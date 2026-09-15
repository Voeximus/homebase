// ── The crash-safe copy of a session being edited ────────────────────────────
// Saves to the server wait ~700 ms (debounce) and then need the network. A set
// ticked in that gap — phone locked, app killed, tab reloaded, no signal in the
// gym — used to exist only in memory. So every change to a session is ALSO
// written to the phone at once, under `hb-active-<person>:<workout id>`, and on
// the next load that copy is merged back into the server's.
//
// One slot per session, not per person: a slot holding a session whose sets
// never reached the server must survive starting another session (the offline
// gym again: the first session can't even be shown until a load succeeds).
//
// Each copy counts its edits and how many of them a save has CONFIRMED the
// server holds. That count is what makes the copy safe to trust on load:
//   • everything confirmed → the server is the truth, whatever changed there
//     since (another phone's edit, a delete) must not be undone by an old copy;
//   • edits not confirmed → those are the sets that exist only here.
// The store confirms a copy after a save of the session lands with nothing newer
// edited meanwhile, and clears it once a finish or a delete has landed. Every
// storage call is wrapped — a private window, a full disk or blocked site data
// must never stop a set from being logged.

import type { ExerciseEntry, Workout } from "./workoutLog";
import { repairDuplicateSetIds, type SetIdMaker, type SyncSet, type Tombstones } from "./syncMerge";
import { isDone } from "./trainingMath";
import { finishWorkout } from "./sessionOps";

export interface ActiveJournal {
  workout: Workout;
  savedAt: number; // ms since epoch, when this copy was written
  // What this phone deleted inside the session. Kept with the copy because the
  // store's in-memory record dies with the crash, and without it a set deleted
  // just before the crash would be adopted straight back from the server copy.
  removedExercises?: string[];
  removedSets?: string[];
  edits: number; // changes written to this copy
  confirmed: number; // how many of those a save has confirmed the server holds
  // The session is known to exist on the server (a load saw it, or a save of it
  // landed). Missing there later means someone deleted it on purpose.
  onServer: boolean;
  // The session as the last confirmed save wrote it. A set still equal to its
  // copy here was not touched on this phone since, so the server's version of
  // it (another phone's fix, or its removal) wins.
  base?: Workout;
}

export type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const journalKey = (person: string, workoutId: string) => `hb-active-${person}:${workoutId}`;
// The first version kept one slot per person under this key.
const legacyKey = (person: string) => `hb-active-${person}`;

function defaultStorage(): JournalStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // the accessor itself can throw when site data is blocked
  }
}

function readRaw(key: string, storage: JournalStorage): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const count = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

function asWorkout(v: unknown, person: string): Workout | null {
  const w = v as Partial<Workout> | undefined;
  if (!w || typeof w !== "object") return null;
  if (typeof w.id !== "string" || typeof w.date !== "string" || w.person !== person || !Array.isArray(w.exercises)) return null;
  const exercisesOk = w.exercises.every(
    (e: Partial<ExerciseEntry> | null) => !!e && typeof e.id === "string" && Array.isArray(e.sets),
  );
  if (!exercisesOk) return null;
  return { ...(w as Workout), name: w.name ?? "", notes: w.notes ?? "", done: !!w.done };
}

function asJournal(raw: Record<string, unknown> | null, person: string): ActiveJournal | null {
  const workout = raw && asWorkout(raw.workout, person);
  if (!raw || !workout) return null;
  // A copy from the first version carries no counts: one edit, never confirmed,
  // which is exactly how that version treated every copy.
  const edits = count(raw.edits, 1);
  const base = raw.base === undefined ? null : asWorkout(raw.base, person);
  return {
    workout,
    savedAt: count(raw.savedAt, 0),
    removedExercises: isStringArray(raw.removedExercises) ? raw.removedExercises : undefined,
    removedSets: isStringArray(raw.removedSets) ? raw.removedSets : undefined,
    edits,
    confirmed: Math.min(count(raw.confirmed, 0), edits),
    onServer: raw.onServer === true,
    ...(base && base.id === workout.id ? { base } : {}),
  };
}

/** The stored copy of one session, or null when there is none or it doesn't look like a session. */
export function readJournal(person: string, workoutId: string, storage: JournalStorage | null = defaultStorage()): ActiveJournal | null {
  if (!storage) return null;
  const j = asJournal(readRaw(journalKey(person, workoutId), storage), person);
  return j && j.workout.id === workoutId ? j : null;
}

/**
 * Every stored copy for this person. A copy in the first version's one-per-person
 * slot is moved to its own slot on the way (unless that slot already exists).
 */
export function readJournals(person: string, storage: JournalStorage | null = defaultStorage()): ActiveJournal[] {
  if (!storage) return [];
  try {
    const legacy = asJournal(readRaw(legacyKey(person), storage), person);
    if (legacy) {
      const key = journalKey(person, legacy.workout.id);
      if (storage.getItem(key) === null) storage.setItem(key, storage.getItem(legacyKey(person)) ?? "");
      storage.removeItem(legacyKey(person));
    }
  } catch {
    /* best effort: a copy that can't move is read from the old slot next time */
  }
  const prefix = `${legacyKey(person)}:`;
  const out: ActiveJournal[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) {
      const j = asJournal(readRaw(k, storage), person);
      if (j && k === journalKey(person, j.workout.id)) out.push(j);
    }
  } catch {
    /* blocked storage reads as no copies */
  }
  return out;
}

/**
 * Write a session to the phone: one more unconfirmed edit. Fields another piece
 * keeps in the same slot are carried over. `onServer` = the store knows the
 * session exists on the server; once true for a copy it stays true.
 */
export function writeJournal(
  w: Workout,
  opts: {
    removedExercises?: Iterable<string>;
    removedSets?: Iterable<string>;
    onServer?: boolean;
    now?: number;
    storage?: JournalStorage | null;
  } = {},
): void {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return;
  try {
    const key = journalKey(w.person, w.id);
    const raw = readRaw(key, storage);
    const prev = asJournal(raw, w.person);
    const next: Record<string, unknown> = {
      ...(raw ?? {}),
      workout: w,
      savedAt: opts.now ?? Date.now(),
      removedExercises: [...(opts.removedExercises ?? [])],
      removedSets: [...(opts.removedSets ?? [])],
      edits: (prev?.edits ?? 0) + 1,
      confirmed: prev?.confirmed ?? 0,
      onServer: !!(prev?.onServer || opts.onServer),
    };
    storage.setItem(key, JSON.stringify(next));
  } catch {
    /* best effort: quota or blocked storage — the server save still runs */
  }
}

/**
 * A save of this session landed and nothing was edited after it started: every
 * edit on the copy is now on the server, as `saved`. If the stamp can't be
 * written, the copy is removed instead — it holds nothing the server lacks, and
 * a copy left looking unconfirmed would overwrite newer edits on the next load.
 *
 * `upTo` = the copy's edit count when that save STARTED. The store's own check
 * only sees its own edits, and a save started by a provider that has since
 * unmounted can land after a remounted one wrote more: those stay unconfirmed.
 */
export function confirmJournal(saved: Workout, storage: JournalStorage | null = defaultStorage(), upTo = Infinity): void {
  if (!storage) return;
  const key = journalKey(saved.person, saved.id);
  try {
    const raw = readRaw(key, storage);
    const prev = asJournal(raw, saved.person);
    if (!prev) return;
    storage.setItem(key, JSON.stringify({ ...raw, confirmed: Math.min(prev.edits, upTo), onServer: true, base: saved }));
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* nothing more to try */
    }
  }
}

/**
 * A save of this session landed while a newer edit was waiting, so nothing is
 * confirmed — but the session is on the server now, and missing there later
 * means deleted on purpose, not never saved.
 *
 * `saved` = what that save wrote. It becomes the copy's base (nothing is
 * confirmed): a base left at an older save read a set the newer edit put back
 * to that older value as untouched, and the server's value won on the next load.
 */
export function markJournalOnServer(
  person: string,
  workoutId: string,
  storage: JournalStorage | null = defaultStorage(),
  saved?: Workout,
): void {
  if (!storage) return;
  const key = journalKey(person, workoutId);
  try {
    const raw = readRaw(key, storage);
    if (!asJournal(raw, person) || (raw?.onServer === true && !saved)) return;
    storage.setItem(key, JSON.stringify({ ...raw, onServer: true, ...(saved ? { base: saved } : {}) }));
  } catch {
    /* best effort: the next save that lands stamps it */
  }
}

/** Remove this session's copy (from the first version's slot too, if it holds it). */
export function clearJournal(person: string, workoutId: string, storage: JournalStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(journalKey(person, workoutId));
    const legacy = readRaw(legacyKey(person), storage);
    if ((legacy?.workout as { id?: unknown } | undefined)?.id === workoutId) storage.removeItem(legacyKey(person));
  } catch {
    /* best effort */
  }
}

// ── merging the phone copy with the server copy on load ─────────────────────
// Result for the store:
//   restore — this merged session differs from the server's; put it in state and save it
//   keep    — the server copy already holds everything; the copy can go
//   clear   — the copy is confirmed, stale (deleted elsewhere) or holds nothing worth keeping
export type JournalResolution =
  | { action: "restore"; workout: Workout; tombstones: { exercises: string[]; sets: string[] } }
  | { action: "keep" }
  | { action: "clear" };

const hasIds = (sets: SyncSet[]) => sets.every((s) => typeof s.id === "string" && s.id !== "");

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

/**
 * One set present on both sides. Untouched on this phone since the last
 * confirmed save → the server's version (it may carry another phone's fix).
 * Otherwise a tick is the thing that must not be lost, so: both ticked → the
 * later tick; only the server ticked → the server, if that tick is newer than
 * the phone copy (otherwise the phone un-ticked it afterwards); otherwise the
 * phone copy, which is this phone's newest edit.
 */
function pickSet(mine: SyncSet, theirs: SyncSet, savedAt: number, base: SyncSet | undefined): SyncSet {
  if (base && same(mine, base)) return theirs;
  const md = isDone(mine);
  const td = isDone(theirs);
  if (md && td) return (theirs.doneAt ?? 0) > (mine.doneAt ?? 0) ? theirs : mine;
  if (td) return (theirs.doneAt ?? 0) > savedAt ? theirs : mine;
  return mine;
}

const withoutSets = (e: ExerciseEntry) => ({ ...e, sets: [] });

function mergeJournalExercises(
  mine: ExerciseEntry[],
  server: ExerciseEntry[],
  tomb: Tombstones,
  savedAt: number,
  base: ExerciseEntry[] | undefined,
): ExerciseEntry[] {
  const serverById = new Map(server.map((e) => [e.id, e]));
  const baseById = new Map((base ?? []).map((e) => [e.id, e]));
  const out: ExerciseEntry[] = [];
  for (const ex of mine) {
    const theirs = serverById.get(ex.id);
    const was = baseById.get(ex.id);
    if (!theirs) {
      // Gone from the server. Untouched here since the confirmed save → another
      // phone removed it; otherwise it is this phone's own unsaved exercise.
      if (!(was && same(ex, was))) out.push(ex);
      continue;
    }
    const fields = was && same(withoutSets(ex), withoutSets(was)) ? theirs : ex;
    const ms = ex.sets as SyncSet[];
    const ts = theirs.sets as SyncSet[];
    // Sets without ids can't be matched: one side's exercise wins whole, as in the live merge.
    if (!hasIds(ms) || !hasIds(ts)) {
      out.push(was && same(ex, was) ? theirs : ex);
      continue;
    }
    const baseSets = new Map(((was?.sets ?? []) as SyncSet[]).filter((s) => s.id).map((s) => [s.id as string, s]));
    const theirsById = new Map(ts.map((s) => [s.id as string, s]));
    const mineIds = new Set(ms.map((s) => s.id as string));
    const sets: SyncSet[] = [];
    for (const s of ms) {
      const t = theirsById.get(s.id as string);
      const b = baseSets.get(s.id as string);
      if (t) sets.push(pickSet(s, t, savedAt, b));
      else if (!(b && same(s, b))) sets.push(s); // untouched and gone from the server → removed elsewhere
    }
    const added = new Set<string>();
    for (const t of ts) {
      const id = t.id as string;
      if (mineIds.has(id) || tomb.sets?.has(id) || added.has(id)) continue;
      added.add(id);
      sets.push(t);
    }
    out.push({ ...fields, sets });
  }
  const mineIds = new Set(mine.map((e) => e.id));
  for (const e of server) if (!mineIds.has(e.id) && !tomb.exercises?.has(e.id)) out.push(e);
  return out;
}

const logsSomething = (w: Workout) =>
  w.exercises.some((ex) => (ex.duration ?? 0) > 0 || (ex.sets as SyncSet[]).some(isDone));

export function resolveJournal(server: Workout | undefined, journal: ActiveJournal, makeId?: SetIdMaker): JournalResolution {
  // Every edit on the copy already reached the server: the server is the truth.
  // (Trusting the copy here is how an old copy undid another phone's later fixes
  // and deletes, or this phone's own later edits when a copy write had failed.)
  if (journal.edits <= journal.confirmed) return { action: "clear" };
  const mine = repairDuplicateSetIds(journal.workout, makeId);
  const tombstones = { exercises: journal.removedExercises ?? [], sets: journal.removedSets ?? [] };
  if (!server) {
    // Once on the server and gone now: deleted on purpose (Discard, or a delete
    // from history on another phone). Never on the server: worth bringing back
    // only if something was actually logged; an empty session is nothing lost.
    if (journal.onServer) return { action: "clear" };
    return logsSomething(mine) ? { action: "restore", workout: mine, tombstones } : { action: "clear" };
  }
  const base = journal.base;
  const tomb: Tombstones = { exercises: new Set(tombstones.exercises), sets: new Set(tombstones.sets) };
  // untouched on this phone since the confirmed save → the server's value
  const pick = <T>(m: T, b: T | undefined, s: T) => (base && m === b ? s : m);
  const mergedRaw: Workout = {
    ...mine,
    name: pick(mine.name, base?.name, server.name),
    notes: pick(mine.notes, base?.notes, server.notes),
    exercises: mergeJournalExercises(mine.exercises, server.exercises, tomb, journal.savedAt, base?.exercises),
  };
  // Finished on another device while this one had unsaved sets: keep the finish
  // (never re-open it) AND the sets (never lose one). Clearing the copy here
  // threw those sets away. Finish's cleanup drops the empty rows this copy still
  // had open. (A finish made HERE is kept as is: the server just hasn't heard.)
  const merged = server.done && !mine.done ? finishWorkout(mergedRaw).workout : mergedRaw;
  const unchanged =
    same(merged.exercises, server.exercises) &&
    merged.name === server.name &&
    merged.notes === server.notes &&
    merged.date === server.date &&
    merged.done === server.done;
  return unchanged ? { action: "keep" } : { action: "restore", workout: merged, tombstones };
}
