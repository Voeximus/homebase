// ── What one tap does in the set logger ──────────────────────────────────────
// Pure edits to a running session, so every rule the logger follows can be
// tested without React: the faint suggested numbers ("ghosts"), the tick, the
// warm-up toggle, adding and removing sets, and what Finish keeps.
// See docs/research/workout-mode/V1.md Ships §1.
//
// Every function returns a NEW entry or workout and never changes its input,
// so the view can hand the whole updated workout straight to the store.
//
// Stored sets may come from before ticks existed: no id, no done, no kind.
// Those rows follow the legacy rule in trainingMath (reps > 0 = done), and an
// edit here pins that answer down (`done` written explicitly) so typing a
// number into an old row never ticks or unticks it behind the person's back.

import { findExercise, isDone, isWarmup, recentRecords } from "./trainingMath";
import type { Exercise, ExerciseEntry, Person, SetEntry, Workout } from "./workoutLog";

// ── how a set is logged for this exercise ───────────────────────────────────────
export type LogMode = NonNullable<Exercise["mode"]>;

/** The library's mode, or a best guess for entries generated before modes existed. */
export function logMode(ex: Exercise | undefined): LogMode | undefined {
  if (!ex) return undefined;
  if (ex.mode) return ex.mode;
  if (ex.type === "cardio") return "cardio";
  return ex.equipment === "bodyweight" ? "bodyweight" : "weighted";
}

/**
 * Whether the row has a weight box. Hidden when a weight means nothing for the
 * exercise (bodyweight, band colour, a timed hold, cardio). An exercise that is
 * not in the library (a custom one) keeps it: we can't tell it doesn't need one.
 */
export function showsWeight(ex: Exercise | undefined): boolean {
  const mode = logMode(ex);
  return mode === undefined || mode === "weighted";
}

/**
 * Whether a tick is refused without a weight. Only for a library exercise that
 * is weighted and not done with bodyweight equipment; a custom exercise may be
 * a bodyweight move, and refusing it would make it impossible to log.
 */
export function needsWeight(ex: Exercise | undefined): boolean {
  return !!ex && logMode(ex) === "weighted" && ex.equipment !== "bodyweight";
}

// ── ghosts: the faint numbers in an empty box ───────────────────────────────────
/** The suggested weight and reps for one row; 0 = nothing to suggest. */
export interface Ghost {
  weight: number;
  reps: number;
}
export const NO_GHOST: Ghost = { weight: 0, reps: 0 };

const pos = (n: number | undefined) => (typeof n === "number" && n > 0 ? n : 0);
const first = (a: number | undefined, b: number | undefined) => pos(a) || pos(b);

/**
 * Ghosts for every row of an exercise, in one pass. For each box, in order:
 *   1. last time's value for the same position — the 2nd warm-up is matched to
 *      last time's 2nd warm-up, the 2nd working set to the 2nd working set;
 *   2. otherwise the row above it of the same kind in this session — what was
 *      typed there, or its own ghost, so three planned sets after a session of
 *      two still all show a number.
 * Each box is decided on its own, so a missing weight can come from the row
 * above while the reps come from last time.
 *
 * `currentSets` are the rows as they are now (default: the entry's own sets).
 */
export function ghostsFor(
  entry: ExerciseEntry,
  lastTimeSets: readonly SetEntry[] | null | undefined,
  currentSets: readonly SetEntry[] = entry.sets,
): Ghost[] {
  const last = (lastTimeSets ?? []).filter(isDone);
  const lastWarm = last.filter(isWarmup);
  const lastWork = last.filter((s) => !isWarmup(s));
  let nWarm = 0;
  let nWork = 0;
  let aboveWarm: Ghost | null = null; // what the row above shows, per kind
  let aboveWork: Ghost | null = null;
  const out: Ghost[] = [];
  for (const s of currentSets) {
    const warm = isWarmup(s);
    const src = warm ? lastWarm[nWarm++] : lastWork[nWork++];
    const above = warm ? aboveWarm : aboveWork;
    const g: Ghost = { weight: first(src?.weight, above?.weight), reps: first(src?.reps, above?.reps) };
    out.push(g);
    const shown: Ghost = { weight: pos(s.weight) || g.weight, reps: pos(s.reps) || g.reps };
    if (warm) aboveWarm = shown;
    else aboveWork = shown;
  }
  return out;
}

/** The ghost for one row. See ghostsFor. */
export function ghostFor(
  entry: ExerciseEntry,
  setIndex: number,
  lastTimeSets: readonly SetEntry[] | null | undefined,
  currentSets: readonly SetEntry[] = entry.sets,
): Ghost {
  return ghostsFor(entry, lastTimeSets, currentSets)[setIndex] ?? NO_GHOST;
}

// ── set edits ───────────────────────────────────────────────────────────────────
const withSet = (entry: ExerciseEntry, index: number, next: SetEntry): ExerciseEntry => ({
  ...entry,
  sets: entry.sets.map((s, i) => (i === index ? next : s)),
});

export type TickResult = { entry: ExerciseEntry; error?: undefined } | { error: "needs-weight"; entry?: undefined };

/**
 * The tick. Empty boxes take their ghost, then the set is marked done with the
 * time and an id (a legacy row without one gets it now). A weighted exercise
 * with no weight typed or suggested is refused and nothing changes. A set that
 * is already ticked is left as it is — un-ticking is `untick`.
 *
 * The weight ghost is only used where the weight box is shown, so a hidden box
 * never saves a weight nobody could see.
 */
export function tickSet(
  entry: ExerciseEntry,
  index: number,
  ghosts: readonly (Ghost | undefined)[],
  exercise: Exercise | undefined,
  now: number,
  makeId: () => string,
): TickResult {
  const s = entry.sets[index];
  if (!s || s.done === true) return { entry };
  const g = ghosts[index] ?? NO_GHOST;
  const weight = pos(s.weight) || (showsWeight(exercise) ? g.weight : 0);
  const reps = pos(s.reps) || g.reps;
  if (needsWeight(exercise) && !(weight > 0)) return { error: "needs-weight" };
  return { entry: withSet(entry, index, { ...s, weight, reps, id: s.id ?? makeId(), done: true, doneAt: now }) };
}

/** Un-tick: `done: false` written out (a legacy row with reps would otherwise still count), numbers kept. */
export function untick(entry: ExerciseEntry, index: number): ExerciseEntry {
  const s = entry.sets[index];
  if (!s) return entry;
  const next: SetEntry = { ...s, done: false };
  delete next.doneAt;
  return withSet(entry, index, next);
}

/** The set-number cell: warm-up ↔ working. */
export function toggleWarmup(entry: ExerciseEntry, index: number): ExerciseEntry {
  const s = entry.sets[index];
  if (!s) return entry;
  return withSet(entry, index, { ...s, kind: isWarmup(s) ? "working" : "warmup" });
}

const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Typing into a box. A legacy row's done-ness is pinned first, so the tick the
 * person sees does not flip because the reps went from 0 to 8.
 */
export function editSet(entry: ExerciseEntry, index: number, patch: { weight?: number; reps?: number }): ExerciseEntry {
  const s = entry.sets[index];
  if (!s) return entry;
  const next: SetEntry = { ...s, done: s.done ?? isDone(s) };
  if (patch.weight !== undefined) next.weight = clean(patch.weight);
  if (patch.reps !== undefined) next.reps = clean(patch.reps);
  return withSet(entry, index, next);
}

/**
 * A new empty working set. It copies NOTHING from the row above (the ghost
 * already shows those numbers faintly) — only a fresh id, and `done: false`
 * so a number typed into it doesn't count until it is ticked.
 */
export function addSet(entry: ExerciseEntry, makeId: () => string): ExerciseEntry {
  return { ...entry, sets: [...entry.sets, { id: makeId(), reps: 0, weight: 0, kind: "working", done: false }] };
}

export function removeSet(entry: ExerciseEntry, index: number): ExerciseEntry {
  if (index < 0 || index >= entry.sets.length) return entry;
  return { ...entry, sets: entry.sets.filter((_, i) => i !== index) };
}

// ── workout edits ───────────────────────────────────────────────────────────────
export function replaceEntry(w: Workout, entry: ExerciseEntry): Workout {
  return { ...w, exercises: w.exercises.map((e) => (e.id === entry.id ? entry : e)) };
}

export function removeExercise(w: Workout, entryId: string): Workout {
  return { ...w, exercises: w.exercises.filter((e) => e.id !== entryId) };
}

// ── finish ──────────────────────────────────────────────────────────────────────
const hasNumbers = (s: SetEntry) => pos(s.weight) > 0 || pos(s.reps) > 0;
const hasDuration = (e: ExerciseEntry) => pos(e.duration) > 0;

/**
 * What Finish saves: sets with no numbers are dropped, then exercises left with
 * nothing (and no duration). Unticked sets that do have numbers stay, still
 * unticked, so they are kept but never counted. `nothingLogged` = not one done
 * set or timed entry is left, which is when the logger asks to discard instead.
 */
export function finishWorkout(w: Workout): { workout: Workout; nothingLogged: boolean } {
  const exercises = w.exercises
    .map((e) => (e.sets.every(hasNumbers) ? e : { ...e, sets: e.sets.filter(hasNumbers) }))
    .filter((e) => e.sets.length > 0 || hasDuration(e));
  const nothingLogged = !exercises.some((e) => hasDuration(e) || e.sets.some(isDone));
  return { workout: { ...w, exercises, done: true }, nothingLogged };
}

/** Working sets ticked / working sets in the session, and warm-ups ticked. */
export function sessionCounts(w: Workout): { done: number; planned: number; warmups: number } {
  let done = 0;
  let planned = 0;
  let warmups = 0;
  for (const e of w.exercises) {
    for (const s of e.sets) {
      if (isWarmup(s)) {
        if (isDone(s)) warmups++;
        continue;
      }
      planned++;
      if (isDone(s)) done++;
    }
  }
  return { done, planned, warmups };
}

/** Longer than this from start to last tick is two sittings, not one session (a workout that runs past midnight still fits). */
const MAX_SESSION_MIN = 12 * 60;

/**
 * The numbers the finish sheet shows, from the session as it is now (before
 * the drop). `minutes` = last tick − session start (the first tick when the
 * start isn't known); null when no tick has a time, or when that span is too
 * long to be one sitting ("Finish it" on a session from an earlier day).
 */
export function finishSummary(
  w: Workout,
  startedAt: number | null,
): { minutes: number | null; sets: number; warmups: number; exercises: number; empty: number; unticked: number } {
  let sets = 0;
  let warmups = 0;
  let empty = 0;
  let unticked = 0;
  let firstAt = Infinity;
  let lastAt = 0;
  let exercises = 0;
  for (const e of w.exercises) {
    let any = hasDuration(e);
    for (const s of e.sets) {
      if (!hasNumbers(s)) {
        empty++;
        continue;
      }
      if (!isDone(s)) {
        unticked++;
        continue;
      }
      any = true;
      if (isWarmup(s)) warmups++;
      else sets++;
      if (typeof s.doneAt === "number" && Number.isFinite(s.doneAt)) {
        firstAt = Math.min(firstAt, s.doneAt);
        lastAt = Math.max(lastAt, s.doneAt);
      }
    }
    if (any) exercises++;
  }
  let minutes: number | null = null;
  if (lastAt > 0) {
    const start = startedAt !== null && Number.isFinite(startedAt) && startedAt <= lastAt ? startedAt : firstAt;
    minutes = Math.round((lastAt - start) / 60000);
    // An old session finished days later has ticks from both sittings; the gap
    // between them is not a workout length, so there is no time to show.
    if (minutes > MAX_SESSION_MIN) minutes = null;
  }
  return { minutes, sets, warmups, exercises, empty, unticked };
}

/**
 * Rep records set in this session: the records that exist with it saved and
 * did not exist without it. Kept to its date and its exercises, because saving
 * a session from an earlier day can make a later first set count as a record.
 */
export function sessionRecords(
  workouts: Workout[],
  finished: Workout,
  person: Person,
  library: Exercise[],
): { name: string; weight: number; reps: number; date: string }[] {
  const others = workouts.filter((w) => w.id !== finished.id);
  const key = (r: { name: string; weight: number; reps: number; date: string }) => `${r.name}|${r.weight}|${r.reps}|${r.date}`;
  const before = new Map<string, number>();
  for (const r of recentRecords(others, person, library, Infinity)) before.set(key(r), (before.get(key(r)) ?? 0) + 1);
  const names = new Set(
    finished.exercises.map((e) => findExercise(library, e.name, e.exerciseId)?.name ?? e.name),
  );
  return recentRecords([...others, finished], person, library, Infinity).filter((r) => {
    const k = key(r);
    const n = before.get(k) ?? 0;
    if (n > 0) {
      before.set(k, n - 1);
      return false;
    }
    return r.date === finished.date && names.has(r.name);
  });
}

// ── session start (kept on this phone) ──────────────────────────────────────────
export const sessionStartKey = (workoutId: string) => `hb-session-start-${workoutId}`;

type StartStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function browserStore(): StartStore | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // the accessor itself throws when site data is blocked
  }
}

/** The stored start time, or null when there is none (or storage is blocked). */
export function readSessionStart(workoutId: string, store: StartStore | undefined = browserStore()): number | null {
  try {
    const v = Number(store?.getItem(sessionStartKey(workoutId)) ?? NaN);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Store `now` as the start unless one is already stored. Returns the start in effect. */
export function initSessionStart(workoutId: string, now: number, store: StartStore | undefined = browserStore()): number {
  const had = readSessionStart(workoutId, store);
  if (had !== null) return had;
  try {
    store?.setItem(sessionStartKey(workoutId), String(now));
  } catch {
    /* storage full or blocked — elapsed time just won't survive a reload */
  }
  return now;
}

export function clearSessionStart(workoutId: string, store: StartStore | undefined = browserStore()): void {
  try {
    store?.removeItem(sessionStartKey(workoutId));
  } catch {
    /* nothing to clean up */
  }
}

// ── small formatting (numbers only; words go through t() in the views) ─────────
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_ZH = "日一二三四五六";

/**
 * "Tue 3 Sep" (English) or "9月3日 周二" (Chinese) for a YYYY-MM-DD date.
 * Spelled out by hand: Intl's English short months differ between ICU versions
 * ("Sep" / "Sept").
 */
export function shortDay(iso: string, lang: "en" | "zh" = "en"): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dow = new Date(y, m - 1, d).getDay();
  return lang === "zh" ? `${m}月${d}日 周${WEEKDAY_ZH[dow]}` : `${WEEKDAY_EN[dow]} ${d} ${MONTH_EN[m - 1]}`;
}

/** 185, 17.5, 1.25 — at most two decimals, no trailing zeros. */
export function fmtWeight(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Whole minutes and hours of an elapsed time, for "42 min" / "1 h 05 min". */
export function elapsedParts(ms: number): { h: number; m: number } {
  const total = Math.max(0, Math.floor(ms / 60000));
  return { h: Math.floor(total / 60), m: total % 60 };
}
