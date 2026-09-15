// ── Sync merge: the pure half of "never lose a set" ──────────────────────────
// HealthStore keeps the network and the timers; everything that DECIDES which
// copy of a document survives lives here, so it can be tested without Supabase.
//
// Four decisions, each fixing a way a logged set used to disappear:
//   1. When an unsaved edit counts as saved (SyncTracker). A save used to clear
//      the "unsaved" flag even when a newer edit had arrived while it was in the
//      air, and the next refetch then replaced that newer edit with the older
//      server copy.
//   2. How a server copy folds into a local copy with an unsaved edit. It was
//      whole-exercise: the other phone's new set inside an exercise this phone
//      had also touched was dropped. Now set by set, whenever every set carries
//      an id.
//   3. Duplicate set ids. Old app versions add a set by copying the last one,
//      id and all, and two sets sharing an id would merge into one.
//   4. When a failed save stops retrying. A workout used to give up after about
//      a minute offline, and giving up marked it saved.

import type { ExerciseEntry, SetEntry, Workout } from "./workoutLog";

// The per-set fields this module reads. They are optional on stored sets (old
// rows have none), so they are spelled out here rather than assumed.
export type SyncSet = SetEntry & { id?: string; done?: boolean; doneAt?: number };

// ── 1. the unsaved flag, with a generation per key ──────────────────────────
// Every edit bumps its key's generation. A save remembers the generation it
// started from and may clear the flag only if that is still the newest one.
//
// The second hole is a refetch that was already in the air when a save landed:
// it answers with the copy from BEFORE the save, and by then the key looks clean.
// So a key also stays protected for any fetch that began before it went clean.
export interface SyncTracker {
  /** An edit happened: mark the key unsaved and return its new generation. */
  edit(key: string): number;
  /** The key's current generation (0 if never edited). Read it when a save starts. */
  generation(key: string): number;
  /** A save that started at `gen` finished. Clears the flag only if nothing newer arrived; returns whether it did. */
  settle(key: string, gen: number): boolean;
  /** Drop the flag no matter what (the thing itself was deleted). */
  forget(key: string): void;
  isDirty(key: string): boolean;
  /** Call as a refetch starts; pass the result to `protects` when it answers. */
  beginFetch(): number;
  /** Must this fetch's copy MERGE into local rather than replace it? */
  protects(key: string, fetch: number): boolean;
}

export function createSyncTracker(): SyncTracker {
  const gens = new Map<string, number>();
  const dirty = new Set<string>();
  // key → the newest fetch number that had already started when the key went clean
  const cleanAfter = new Map<string, number>();
  let fetches = 0;
  const markClean = (key: string) => {
    dirty.delete(key);
    cleanAfter.set(key, fetches);
  };
  return {
    edit(key) {
      const g = (gens.get(key) ?? 0) + 1;
      gens.set(key, g);
      dirty.add(key);
      return g;
    },
    generation: (key) => gens.get(key) ?? 0,
    settle(key, gen) {
      if ((gens.get(key) ?? 0) !== gen) return false;
      markClean(key);
      return true;
    },
    forget: markClean,
    isDirty: (key) => dirty.has(key),
    beginFetch: () => ++fetches,
    protects: (key, fetch) => dirty.has(key) || (cleanAfter.get(key) ?? 0) >= fetch,
  };
}

// ── 2. merging a remote copy into a local one ────────────────────────────────
// Children only the remote has are adopted (that is the other phone's edit);
// for an id both sides have, LOCAL wins (this device is the one writing right
// now). `removed` holds ids this device deleted on purpose, which must not sail
// back in from a remote copy that hasn't caught up. Remote-only children land at
// the END: nothing carries an order stamp, so there is no honest way to
// interleave them. Every function returns `local` itself when there is nothing
// to adopt, so a refetch that changes nothing doesn't churn state.
export function unionById<T extends { id: string }>(local: T[], remote: T[], removed?: ReadonlySet<string>): T[] {
  const mine = new Set(local.map((x) => x.id));
  const extra = remote.filter((x) => !mine.has(x.id) && !removed?.has(x.id));
  return extra.length ? [...local, ...extra] : local;
}

/** What this device deliberately deleted inside one workout. */
export interface Tombstones {
  exercises?: ReadonlySet<string>;
  sets?: ReadonlySet<string>;
}

const allHaveIds = (sets: SyncSet[]): boolean => sets.every((s) => typeof s.id === "string" && s.id !== "");

/** Set by set when every set on both sides has an id; otherwise the local list whole (old rows carry no ids). */
export function mergeSets(local: SetEntry[], remote: SetEntry[], removed?: ReadonlySet<string>): SetEntry[] {
  const l = local as SyncSet[];
  const r = remote as SyncSet[];
  if (!allHaveIds(l) || !allHaveIds(r)) return local;
  const mine = new Set(l.map((s) => s.id));
  const seen = new Set<string>();
  const extra = r.filter((s) => {
    const id = s.id as string;
    // `seen` so a remote list with a duplicate id can't add the same set twice
    if (mine.has(id) || removed?.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return extra.length ? [...local, ...extra] : local;
}

export function mergeExercises(local: ExerciseEntry[], remote: ExerciseEntry[], removed?: Tombstones): ExerciseEntry[] {
  const byId = new Map(remote.map((e) => [e.id, e]));
  let changed = false;
  const kept = local.map((ex) => {
    const theirs = byId.get(ex.id);
    if (!theirs) return ex;
    const sets = mergeSets(ex.sets, theirs.sets, removed?.sets);
    if (sets === ex.sets) return ex;
    changed = true;
    return { ...ex, sets };
  });
  const all = unionById(kept, remote, removed?.exercises);
  return changed || all !== kept ? all : local;
}

/** Local wins for everything but the children it doesn't have. */
export function mergeWorkout(local: Workout, remote: Workout, removed?: Tombstones): Workout {
  const exercises = mergeExercises(local.exercises, remote.exercises, removed);
  return exercises === local.exercises ? local : { ...local, exercises };
}

/**
 * The workouts list after a refetch. Unprotected workouts take the remote copy
 * whole; a protected one (unsaved edit, or a fetch older than its last save)
 * merges into the local copy; protected local workouts the server doesn't have
 * yet stay, at the front, as they always have.
 */
export function mergeWorkoutLists(
  local: Workout[],
  remote: Workout[],
  isProtected: (id: string) => boolean,
  removedFor: (id: string) => Tombstones | undefined,
): Workout[] {
  const localById = new Map(local.map((w) => [w.id, w]));
  const remoteIds = new Set(remote.map((w) => w.id));
  const merged = remote.map((w) => {
    if (!isProtected(w.id)) return w;
    const mine = localById.get(w.id);
    return mine ? mergeWorkout(mine, w, removedFor(w.id)) : w;
  });
  const pendingLocal = local.filter((w) => isProtected(w.id) && !remoteIds.has(w.id));
  return [...pendingLocal, ...merged];
}

/**
 * A workout edit as it enters local state. Duplicate set ids are repaired HERE
 * too, not only on the way in from the server: a local copy [a, b, b] next to
 * the server's repaired [a, b, b~1] sees b~1 as a set it doesn't have, adopts
 * it, and the next save stores a set that was never lifted. Returns the
 * workout to keep and the exercise and set ids the edit deleted.
 */
export function localEdit(
  prev: Workout | undefined,
  next: Workout,
): { workout: Workout; removedExercises: string[]; removedSets: string[] } {
  const workout = repairDuplicateSetIds(next);
  return { workout, removedExercises: removedIds(prev?.exercises, workout.exercises), removedSets: removedSetIds(prev, workout) };
}

/** Ids present in `prev` and missing from `next`: what an edit deleted. */
export function removedIds(prev: { id: string }[] | undefined, next: { id: string }[]): string[] {
  if (!prev?.length) return [];
  const kept = new Set(next.map((x) => x.id));
  return prev.filter((x) => !kept.has(x.id)).map((x) => x.id);
}

/** Set ids an edit deleted anywhere in the workout (a set whose whole exercise went is covered by that exercise's tombstone too). */
export function removedSetIds(prev: Workout | undefined, next: Workout): string[] {
  if (!prev) return [];
  const kept = new Set<string>();
  for (const ex of next.exercises) for (const s of ex.sets as SyncSet[]) if (s.id) kept.add(s.id);
  const out: string[] = [];
  for (const ex of prev.exercises) for (const s of ex.sets as SyncSet[]) if (s.id && !kept.has(s.id)) out.push(s.id);
  return out;
}

// ── 3. duplicate set ids ─────────────────────────────────────────────────────
// Within one exercise, the FIRST set keeps a shared id and each later copy gets
// a new one. The default new id is DERIVED from the duplicate and its occurrence,
// not random, and that is load-bearing: the repair runs on every load and is
// never written back by itself, so a random id would change on every refetch.
// A phone holding yesterday's repaired id would then see today's repaired id as
// a set it doesn't have, adopt it, and show the set twice.
//
// The occurrence is the copy's count among sets sharing that id (the 2nd "b" is
// b~1, the 3rd b~2), NOT its position in the list. A position shifts whenever
// any earlier set is removed — the old app removes rows too — and [a, b, b]
// would repair to b~2 on one phone and, after "a" went, to b~1 on the other.
export type SetIdMaker = (duplicateOf: string, occurrence: number) => string;
export const derivedSetId: SetIdMaker = (dup, occurrence) => `${dup}~${occurrence}`;

export function repairDuplicateSetIds(w: Workout, makeId: SetIdMaker = derivedSetId): Workout {
  let changed = false;
  const exercises = w.exercises.map((ex) => {
    const sets = ex.sets as SyncSet[];
    if (!Array.isArray(sets) || sets.length < 2) return ex;
    const taken = new Set<string>();
    for (const s of sets) if (s?.id) taken.add(s.id);
    const copies = new Map<string, number>(); // id → how many sets carried it so far
    let fixed: SyncSet[] | null = null;
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      if (!s?.id) continue;
      const n = copies.get(s.id) ?? 0;
      copies.set(s.id, n + 1);
      if (n === 0) continue;
      let id = makeId(s.id, n);
      // never land on an id another set in this exercise already uses
      for (let k = 0; taken.has(id) && k < 50; k++) id = makeId(id, n);
      if (taken.has(id)) id = `${s.id}~${n}~${taken.size}`;
      taken.add(id);
      fixed ??= [...sets];
      fixed[i] = { ...s, id };
    }
    if (!fixed) return ex;
    changed = true;
    return { ...ex, sets: fixed };
  });
  return changed ? { ...w, exercises } : w;
}

// ── 4. retrying a failed save ────────────────────────────────────────────────
// Backoff 1 s, 2 s, 4 s … capped at 30 s. A meal day gives up after 6 attempts
// (about a minute) and re-syncs from the server. A workout never gives up:
// giving up cleared its unsaved flag, the next refetch then replaced the session
// with the older server copy, and the next tick saved that reduced copy — a 90 s
// rest with no signal was enough to lose the set logged before it. Staying
// unsaved is safe, because a refetch merges set by set into an unsaved session.
export const WORKOUT_KEY_PREFIX = "w|";

/** Milliseconds before retrying the attempt (0-based) that just failed; null = give up. */
export function retryDelay(key: string, attempt: number): number | null {
  if (attempt >= 6 && !key.startsWith(WORKOUT_KEY_PREFIX)) return null;
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}
