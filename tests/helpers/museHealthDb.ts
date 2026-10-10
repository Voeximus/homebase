// The health half of the write door's database, in memory.
//
// WHY IT IS A BASE CLASS AND NOT A MOCK. The three things most likely to go wrong
// on the health side are unreachable from a test runner any other way: the
// day-document race (the door and the phone writing the same json document in the
// same second), the session-document race, and "an undo puts back exactly what was
// there". All three are about what a COMPARE-AND-SET does when it loses, so the
// fake has to actually hold versions and actually refuse a stale write.
//
// It is shared by tests/museWrite.test.ts and tests/museHealth.test.ts rather than
// copied into both, for the same reason the doors share one clock: two fakes that
// disagree about what "stale" means would make one of the two suites lie.
//
// Row shapes are the door's own (db.ts), so a change to the seam breaks this file
// at the type level rather than at the assertion level.

import { FinanceFake } from "../museFinanceFake.ts";
import type {
  Db,
  FoodRow,
  MacroRow,
  MealDayRow,
  Person,
  RoutineRow,
  SavedMealRow,
  SessionHead,
  WorkoutRow,
} from "../../supabase/functions/muse-write/db.ts";

interface MealDoc {
  id: string;
  meals: unknown[];
  status: string | null;
  note: string | null;
  updatedAt: string;
}

/**
 * Everything on the health side of `Db`. The audit log, the rate-limit counters,
 * the reminder list and the queued path are NOT here — each suite brings its own,
 * because each one asserts different things about them.
 *
 * Declared as `implements Pick<Db, …>` so a method that drifts from the seam is a
 * compile error in the door's own vocabulary.
 */
export class HealthRows extends FinanceFake {
  weights = new Map<string, number>();
  savedMeals: SavedMealRow[] = [];
  mealDays = new Map<string, MealDoc>();
  foods: FoodRow[] = [];
  macroTargets = new Map<Person, MacroRow>();
  workouts: WorkoutRow[] = [];
  routines: RoutineRow[] = [];

  /** Fires right after the door reads a day document, so a test can be the phone
   *  writing in the gap. */
  onReadMealDay: ((date: string) => void) | null = null;
  /** The same hook for a session document. */
  onReadWorkout: ((id: string) => void) | null = null;

  /** Every version stamp this fake has handed out, so two writes in the same
   *  millisecond still get different ones — a compare-and-set that could not tell
   *  two versions apart would pass this suite and fail in Postgres. */
  private stamp = 0;
  protected nextStamp(): string {
    this.stamp += 1;
    return `v${this.stamp}`;
  }

  // `rowSeq`, not `seq`: FinanceFake has a private `seq` of its own, and a subclass
  // redeclaring it would be one field shared by two counters — ids from the two halves
  // would interleave and a test asserting an id would pass or fail by call order.
  private rowSeq = 0;
  protected id(prefix: string): string {
    this.rowSeq += 1;
    return `${prefix}-${String(this.rowSeq).padStart(8, "0")}-0000-0000-0000-000000000000`.slice(0, 36);
  }

  // ── body weight ────────────────────────────────────────────────────────────
  readWeight(person: Person, date: string): Promise<number | null> {
    return Promise.resolve(this.weights.get(`${person}|${date}`) ?? null);
  }
  upsertWeight(person: Person, date: string, weight: number): Promise<void> {
    this.weights.set(`${person}|${date}`, weight);
    return Promise.resolve();
  }
  deleteWeight(person: Person, date: string): Promise<boolean> {
    return Promise.resolve(this.weights.delete(`${person}|${date}`));
  }

  // ── saved meals ────────────────────────────────────────────────────────────
  findSavedMealsByName(name: string): Promise<SavedMealRow[]> {
    const want = name.trim().toLowerCase();
    return Promise.resolve(this.savedMeals.filter((m) => m.name.trim().toLowerCase() === want));
  }
  listSavedMealNames(limit: number): Promise<string[]> {
    return Promise.resolve(this.savedMeals.map((m) => m.name).slice(0, limit));
  }
  readSavedMeal(id: string): Promise<SavedMealRow | null> {
    const hit = this.savedMeals.find((m) => m.id === id);
    // A COPY, so a test that mutates what it read cannot change the store — and so
    // an undo that stores `items` by reference is caught rather than passing.
    return Promise.resolve(hit ? { id: hit.id, name: hit.name, items: [...hit.items] } : null);
  }
  insertSavedMeal(r: { id?: string; name: string; items: unknown[] }): Promise<string> {
    const id = r.id ?? this.id("sm");
    if (this.savedMeals.some((m) => m.id === id)) return Promise.reject(new Error("duplicate saved meal id"));
    this.savedMeals.push({ id, name: r.name, items: [...r.items] });
    return Promise.resolve(id);
  }
  updateSavedMeal(id: string, patch: { name?: string; items?: unknown[] }): Promise<boolean> {
    const hit = this.savedMeals.find((m) => m.id === id);
    if (!hit) return Promise.resolve(false);
    if (patch.name !== undefined) hit.name = patch.name;
    if (patch.items !== undefined) hit.items = [...patch.items];
    return Promise.resolve(true);
  }
  deleteSavedMeal(id: string): Promise<boolean> {
    const before = this.savedMeals.length;
    this.savedMeals = this.savedMeals.filter((m) => m.id !== id);
    return Promise.resolve(this.savedMeals.length < before);
  }

  // ── the food library ───────────────────────────────────────────────────────
  readFood(id: string): Promise<FoodRow | null> {
    const hit = this.foods.find((f) => f.id === id);
    return Promise.resolve(hit ? { ...hit } : null);
  }
  findFoodByName(name: string): Promise<FoodRow | null> {
    const want = name.trim().toLowerCase();
    const hit = this.foods.find((f) => f.name.trim().toLowerCase() === want);
    return Promise.resolve(hit ? { ...hit } : null);
  }
  insertFood(r: FoodRow & { id?: string }): Promise<string> {
    const id = r.id || this.id("food");
    if (this.foods.some((f) => f.id === id)) return Promise.reject(new Error("duplicate food id"));
    this.foods.push({ ...r, id });
    return Promise.resolve(id);
  }
  deleteFood(id: string): Promise<boolean> {
    const before = this.foods.length;
    this.foods = this.foods.filter((f) => f.id !== id);
    return Promise.resolve(this.foods.length < before);
  }

  // ── macro targets ──────────────────────────────────────────────────────────
  readMacroTarget(person: Person): Promise<MacroRow | null> {
    const hit = this.macroTargets.get(person);
    return Promise.resolve(hit ? { ...hit } : null);
  }
  upsertMacroTarget(person: Person, target: MacroRow): Promise<void> {
    this.macroTargets.set(person, { ...target });
    return Promise.resolve();
  }
  deleteMacroTarget(person: Person): Promise<boolean> {
    return Promise.resolve(this.macroTargets.delete(person));
  }

  // ── the day document ───────────────────────────────────────────────────────
  readMealDay(person: Person, date: string): Promise<MealDayRow | null> {
    const doc = this.mealDays.get(`${person}|${date}`);
    const snapshot: MealDayRow | null = doc
      ? { id: doc.id, meals: [...doc.meals], status: doc.status, note: doc.note, updatedAt: doc.updatedAt }
      : null;
    // The phone's turn. Fired AFTER the snapshot is taken, so what the door holds is
    // already one version behind by the time it tries to write.
    this.onReadMealDay?.(date);
    return Promise.resolve(snapshot);
  }
  insertMealDay(r: {
    person: Person;
    date: string;
    meals: unknown[];
    status?: string | null;
    note?: string | null;
    atISO: string;
  }): Promise<"ok" | "conflict"> {
    const key = `${r.person}|${r.date}`;
    if (this.mealDays.has(key)) return Promise.resolve("conflict");
    this.mealDays.set(key, {
      id: this.id("md"),
      meals: [...r.meals],
      status: r.status ?? null,
      note: r.note ?? null,
      updatedAt: this.nextStamp(),
    });
    return Promise.resolve("ok");
  }
  updateMealDayIfUnchanged(
    id: string,
    seenUpdatedAt: string,
    patch: { meals?: unknown[]; status?: string | null; note?: string | null; atISO: string },
  ): Promise<"ok" | "stale"> {
    for (const doc of this.mealDays.values()) {
      if (doc.id !== id) continue;
      if (doc.updatedAt !== seenUpdatedAt) return Promise.resolve("stale");
      if (patch.meals !== undefined) doc.meals = [...patch.meals];
      if (patch.status !== undefined) doc.status = patch.status;
      if (patch.note !== undefined) doc.note = patch.note;
      doc.updatedAt = this.nextStamp();
      return Promise.resolve("ok");
    }
    return Promise.resolve("stale");
  }

  // ── the session document ───────────────────────────────────────────────────
  readWorkout(id: string): Promise<WorkoutRow | null> {
    const row = this.workouts.find((w) => w.id === id);
    const snapshot: WorkoutRow | null = row ? { ...row, exercises: clone(row.exercises) } : null;
    this.onReadWorkout?.(id);
    return Promise.resolve(snapshot);
  }
  findOpenSession(person: Person, date: string): Promise<WorkoutRow | null> {
    const row = this.workouts.find((w) => w.person === person && w.date === date && !w.done);
    return Promise.resolve(row ? { ...row, exercises: clone(row.exercises) } : null);
  }
  /** Insertion order stands in for `created_at`, which the real reads order by. */
  sessionsOn(person: Person, date: string, limit: number): Promise<SessionHead[]> {
    return Promise.resolve(
      this.workouts
        .filter((w) => w.person === person && w.date === date)
        .slice(0, limit)
        .map((w) => ({ id: w.id, date: w.date, name: w.name, done: w.done })),
    );
  }
  recentSessions(person: Person, limit: number): Promise<SessionHead[]> {
    const mine = this.workouts
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => w.person === person)
      .sort((a, b) => b.w.date.localeCompare(a.w.date) || b.i - a.i);
    return Promise.resolve(
      mine.slice(0, limit).map(({ w }) => ({ id: w.id, date: w.date, name: w.name, done: w.done })),
    );
  }
  insertWorkout(r: WorkoutRow): Promise<"ok" | "conflict"> {
    if (this.workouts.some((w) => w.id === r.id)) return Promise.resolve("conflict");
    this.workouts.push({ ...r, exercises: clone(r.exercises), updatedAt: this.nextStamp() });
    return Promise.resolve("ok");
  }
  updateWorkoutIfUnchanged(
    id: string,
    seenUpdatedAt: string,
    patch: { name?: string; notes?: string; date?: string; exercises?: unknown[]; done?: boolean; atISO: string },
  ): Promise<"ok" | "stale"> {
    const row = this.workouts.find((w) => w.id === id);
    if (!row) return Promise.resolve("stale");
    if (row.updatedAt !== seenUpdatedAt) return Promise.resolve("stale");
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.notes !== undefined) row.notes = patch.notes;
    if (patch.date !== undefined) row.date = patch.date;
    if (patch.exercises !== undefined) row.exercises = clone(patch.exercises);
    if (patch.done !== undefined) row.done = patch.done;
    row.updatedAt = this.nextStamp();
    return Promise.resolve("ok");
  }
  deleteWorkout(id: string): Promise<boolean> {
    const before = this.workouts.length;
    this.workouts = this.workouts.filter((w) => w.id !== id);
    return Promise.resolve(this.workouts.length < before);
  }

  // ── routines ───────────────────────────────────────────────────────────────
  readRoutine(id: string): Promise<RoutineRow | null> {
    const row = this.routines.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row, exercises: clone(row.exercises) } : null);
  }
  listRoutines(person: Person): Promise<RoutineRow[]> {
    return Promise.resolve(
      this.routines.filter((r) => r.person === person).map((r) => ({ ...r, exercises: clone(r.exercises) })),
    );
  }
  insertRoutine(r: RoutineRow): Promise<"ok" | "conflict"> {
    if (this.routines.some((x) => x.id === r.id)) return Promise.resolve("conflict");
    this.routines.push({ ...r, exercises: clone(r.exercises) });
    return Promise.resolve("ok");
  }
  deleteRoutine(id: string): Promise<boolean> {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    return Promise.resolve(this.routines.length < before);
  }
}

/** A deep copy, so nothing the door holds is the same object the store holds — a
 *  json column is a value, and a fake that shared references would let a mutation
 *  "land" without a write. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Compile-time proof that the class above covers the health half of the seam, and
 *  covers it with the door's own signatures. If a method is renamed in db.ts, this
 *  line is where the suite says so. */
export type HealthHalf = Pick<
  Db,
  | "readWeight"
  | "upsertWeight"
  | "deleteWeight"
  | "findSavedMealsByName"
  | "listSavedMealNames"
  | "readSavedMeal"
  | "insertSavedMeal"
  | "updateSavedMeal"
  | "deleteSavedMeal"
  | "readFood"
  | "findFoodByName"
  | "insertFood"
  | "deleteFood"
  | "readMacroTarget"
  | "upsertMacroTarget"
  | "deleteMacroTarget"
  | "readMealDay"
  | "insertMealDay"
  | "updateMealDayIfUnchanged"
  | "readWorkout"
  | "findOpenSession"
  | "sessionsOn"
  | "recentSessions"
  | "insertWorkout"
  | "updateWorkoutIfUnchanged"
  | "deleteWorkout"
  | "readRoutine"
  | "listRoutines"
  | "insertRoutine"
  | "deleteRoutine"
>;
const _covers: HealthHalf = new HealthRows();
void _covers;
