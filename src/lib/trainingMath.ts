// ── Training maths for workout mode v1 ───────────────────────────────────────
// Pure functions over stored workouts: which sets count, estimated maxes, hard
// sets per muscle region, and rep records. No clock inside — `today` is passed
// in. See docs/research/workout-mode/V1.md §8 (this scope) and SPEC.md §5.
//
// Two rules every function here shares:
//   • a set counts only if it is DONE (ticked, or a legacy row with reps), has
//     REPS, and is not a WARM-UP;
//   • an exercise is identified by its library entry (id, then name, then alias)
//     and otherwise by its normalised name, so "Tricep pushdowns" and "Triceps
//     pushdown" are one exercise.

import type { Exercise, Person, SetEntry, Workout } from "./workoutLog";
import { isRegionId, type RegionId } from "./muscleRegions";

// ── which sets count ──────────────────────────────────────────────────────────
/** Ticked. Rows saved before ticks existed have no `done`: reps > 0 means done. */
export function isDone(s: SetEntry): boolean {
  return s.done !== undefined ? s.done : s.reps > 0;
}
export function isWarmup(s: SetEntry): boolean {
  return s.kind === "warmup";
}
/**
 * Done AND has reps. A tick on an empty reps box logged nothing (the logger now
 * refuses one), and a stored 0-rep tick must not count as a hard set.
 */
export function isLogged(s: SetEntry): boolean {
  return isDone(s) && s.reps > 0;
}
const counts = (s: SetEntry) => isLogged(s) && !isWarmup(s);

// ── exercise identity ─────────────────────────────────────────────────────────
/**
 * The comparable form of an exercise name: lower case, separators collapsed to
 * one space, a plural "s" dropped from the last word, and a few spellings that
 * old logs use folded together (flye → fly, skull crusher → skullcrusher,
 * tricep → triceps).
 */
export function normName(name: string): string {
  let n = name.toLowerCase().trim().replace(/[-_\s]+/g, " ");
  // Plural first, so "flyes" → "flye" → "fly" and "skull crushers" → "skull crusher".
  n = n.replace(/(\S+)$/, (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return n
    .replace(/\bflye\b/g, "fly")
    .replace(/skull crusher/g, "skullcrusher")
    .replace(/\btricep\b/g, "triceps");
}

interface LibraryIndex {
  size: number;
  byId: Map<string, Exercise>;
  byName: Map<string, Exercise>;
  byAlias: Map<string, Exercise>;
}
// The library array is built once and reused, so its lookups are too. `size`
// catches the rare in-place push of a custom exercise.
const indexCache = new WeakMap<Exercise[], LibraryIndex>();

// First row per key wins, except that a visible row replaces a hidden one: the
// hidden "Burpees" (folded into "Burpee") normalises to the same name and comes
// first in the library, and must not answer for the exercise people log.
const claim = (map: Map<string, Exercise>, k: string, e: Exercise) => {
  const had = map.get(k);
  if (!had || (had.hidden && !e.hidden)) map.set(k, e);
};

function indexOf(library: Exercise[]): LibraryIndex {
  const cached = indexCache.get(library);
  if (cached && cached.size === library.length) return cached;
  const idx: LibraryIndex = { size: library.length, byId: new Map(), byName: new Map(), byAlias: new Map() };
  for (const e of library) {
    if (!idx.byId.has(e.id)) idx.byId.set(e.id, e);
    claim(idx.byName, normName(e.name), e);
    for (const a of e.aliases ?? []) claim(idx.byAlias, normName(a), e);
  }
  indexCache.set(library, idx);
  return idx;
}

/**
 * The library entry for a logged exercise: by id, then by name, then by alias.
 * A near-duplicate folded into another entry answers as that entry, so an old
 * log saved under "ex-burpees" and a new one under "ex-burpee" are one exercise.
 */
export function findExercise(library: Exercise[], name: string, exerciseId?: string): Exercise | undefined {
  const idx = indexOf(library);
  const hit = (exerciseId ? idx.byId.get(exerciseId) : undefined) ?? idx.byName.get(normName(name)) ?? idx.byAlias.get(normName(name));
  return hit?.mergedInto ? (idx.byId.get(hit.mergedInto) ?? hit) : hit;
}

/** One key per exercise: the library id when it is in the library, else the normalised name. */
function exKey(library: Exercise[], name: string, exerciseId?: string): string {
  const ex = findExercise(library, name, exerciseId);
  return ex ? `#${ex.id}` : `~${normName(name)}`;
}

// ── estimated one-rep max ─────────────────────────────────────────────────────
/**
 * Epley estimate of the most you could lift once. A single IS the max (Epley
 * would add 3.3%); above 15 reps the formula is not trusted, so there is none.
 */
export function e1rm(weight: number, reps: number): number | null {
  if (!Number.isFinite(weight) || !Number.isFinite(reps)) return null;
  if (weight <= 0 || reps < 1 || reps > 15) return null;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

// ── hard sets per muscle region ───────────────────────────────────────────────
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / 86400000);

/**
 * Ticked working sets in the last `days` days (today inclusive — the same
 * rolling rule as thisWeekCount). Each set adds 1 to its exercise's main
 * regions and 0.5 to its helpers. A set whose exercise has no region data is
 * counted in `unplaced` instead, so the total is never silently short — except
 * cardio, which has no regions on purpose: nothing about it is missing.
 */
export function hardSetsByRegion(
  workouts: Workout[],
  library: Exercise[],
  person: Person,
  today: string,
  days = 7,
): { byRegion: Partial<Record<RegionId, number>>; unplaced: number } {
  const byRegion: Partial<Record<RegionId, number>> = {};
  let unplaced = 0;
  for (const w of workouts) {
    if (!w.done || w.person !== person) continue;
    const d = daysBetween(w.date, today);
    if (!(d >= 0 && d < days)) continue;
    for (const entry of w.exercises) {
      const n = entry.sets.filter(counts).length;
      if (n === 0) continue;
      const ex = findExercise(library, entry.name, entry.exerciseId);
      const main = new Set((ex?.primary ?? []).filter(isRegionId));
      const helps = new Set((ex?.secondary ?? []).filter(isRegionId).filter((r) => !main.has(r)));
      if (main.size === 0 && helps.size === 0) {
        const cardio = ex ? (ex.mode ?? (ex.type === "cardio" ? "cardio" : undefined)) === "cardio" : false;
        if (!cardio) unplaced += n;
        continue;
      }
      for (const r of main) byRegion[r] = (byRegion[r] ?? 0) + n;
      for (const r of helps) byRegion[r] = (byRegion[r] ?? 0) + n * 0.5;
    }
  }
  return { byRegion, unplaced };
}

/**
 * Where a 7-day hard-set count sits among the growth bands in the studies.
 * Returns the English key; the view translates it with t(). Half sets fall in
 * the band below the next whole-number boundary (29.5 is still "Less for each
 * extra set"; 30 starts the next).
 */
export function bandLabel(hardSets: number): string {
  if (!(hardSets > 0)) return "None";
  if (hardSets < 4) return "Below the lowest band in the studies";
  if (hardSets === 4) return "Minimum band";
  if (hardSets <= 10) return "More growth for each set";
  if (hardSets <= 18) return "More in total, less for each extra set";
  if (hardSets < 30) return "Less for each extra set";
  if (hardSets < 43) return "Least for each extra set";
  return "Not enough studies to say";
}

// ── records ───────────────────────────────────────────────────────────────────
const REP_TARGETS = [1, 3, 5, 8, 10, 12] as const;
type RepTarget = (typeof REP_TARGETS)[number];

/** A person's finished workouts, oldest first (stable within a day). */
const finishedOf = (workouts: Workout[], person: Person) =>
  workouts
    .filter((w) => w.done && w.person === person)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w.date.localeCompare(b.w.date) || a.i - b.i)
    .map((x) => x.w);

/**
 * Heaviest weight lifted for AT LEAST 1/3/5/8/10/12 reps, across the person's
 * finished workouts. Done working sets with a weight only; null = never done.
 */
export function repRecords(
  workouts: Workout[],
  person: Person,
  name: string,
  library: Exercise[],
): Record<RepTarget, number | null> {
  const out = { 1: null, 3: null, 5: null, 8: null, 10: null, 12: null } as Record<RepTarget, number | null>;
  const key = exKey(library, name);
  for (const w of workouts) {
    if (!w.done || w.person !== person) continue;
    for (const entry of w.exercises) {
      if (exKey(library, entry.name, entry.exerciseId) !== key) continue;
      for (const s of entry.sets) {
        if (!counts(s) || !(s.weight > 0)) continue;
        for (const r of REP_TARGETS) {
          if (s.reps >= r && (out[r] === null || s.weight > out[r])) out[r] = s.weight;
        }
      }
    }
  }
  return out;
}

/**
 * Sets that beat the rep record standing BEFORE their workout: heavier than
 * anything lifted in an earlier workout for at least as many reps. The first
 * workout with an exercise is only a baseline — its ramp from 95 to 185 is not
 * a string of records. At most one record per exercise and rep count per
 * workout (the heaviest), and none that a heavier-or-equal set with more reps
 * in the same workout already covers. Newest first.
 */
export function recentRecords(
  workouts: Workout[],
  person: Person,
  library: Exercise[],
  limit = 10,
): { name: string; weight: number; reps: number; date: string }[] {
  // per exercise: heaviest weight at each exact rep count in earlier workouts
  const seen = new Map<string, Map<number, number>>();
  const found: { name: string; weight: number; reps: number; date: string }[] = [];
  for (const w of finishedOf(workouts, person)) {
    // this workout's heaviest per exercise and rep count, folded into `seen` after it
    const pending = new Map<string, { name: string; byReps: Map<number, number> }>();
    for (const entry of w.exercises) {
      const ex = findExercise(library, entry.name, entry.exerciseId);
      const key = ex ? `#${ex.id}` : `~${normName(entry.name)}`;
      for (const s of entry.sets) {
        if (!counts(s)) continue;
        const p = pending.get(key) ?? { name: ex?.name ?? entry.name, byReps: new Map<number, number>() };
        p.byReps.set(s.reps, Math.max(p.byReps.get(s.reps) ?? 0, s.weight > 0 ? s.weight : 0));
        pending.set(key, p);
      }
    }
    for (const [key, { name, byReps }] of pending) {
      const prior = seen.get(key);
      if (prior) {
        for (const [reps, weight] of byReps) {
          if (!(weight > 0)) continue;
          // a set in this workout with more reps at the same or a heavier weight
          // already holds this record (185x7 after 185x8 is not a second one)
          let covered = false;
          for (const [r2, w2] of byReps) if (r2 > reps && w2 >= weight) covered = true;
          if (covered) continue;
          let best = 0;
          for (const [r, wt] of prior) if (r >= reps && wt > best) best = wt;
          if (weight > best) found.push({ name, weight, reps, date: w.date });
        }
      }
      const m = prior ?? new Map<number, number>();
      for (const [reps, weight] of byReps) m.set(reps, Math.max(m.get(reps) ?? 0, weight));
      seen.set(key, m);
    }
  }
  return found.reverse().slice(0, Math.max(0, limit));
}

// ── last time ─────────────────────────────────────────────────────────────────
/**
 * The person's most recent finished workout that did working sets of this
 * exercise, and the sets they did in it (done sets with reps — warm-ups
 * included, in logged order).
 * `excludeWorkoutId` keeps the session being logged from answering itself.
 */
export function lastTime(
  workouts: Workout[],
  person: Person,
  name: string,
  library: Exercise[],
  excludeWorkoutId?: string,
): { date: string; sets: SetEntry[] } | null {
  const key = exKey(library, name);
  const ordered = finishedOf(workouts, person);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const w = ordered[i];
    if (w.id === excludeWorkoutId) continue;
    const sets = w.exercises
      .filter((entry) => exKey(library, entry.name, entry.exerciseId) === key)
      .flatMap((entry) => entry.sets.filter(isLogged));
    // A session with only a warm-up done (the machine was taken) shows no working
    // sets, so it doesn't answer: the one before it has the numbers to follow.
    if (sets.some((s) => !isWarmup(s))) return { date: w.date, sets };
  }
  return null;
}
