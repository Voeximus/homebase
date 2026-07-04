/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import type { DayLog, LoggedItem, Person, SavedMeal } from "../lib/mealLog";
import type { Routine, Workout } from "../lib/workoutLog";
import type { BodyWeight } from "../lib/weightLog";
import type { MacroTarget } from "../lib/nutrition";

// ── The Health store ─────────────────────────────────────────────────────────
// One shared source of truth for the meal + workout logs, synced to Supabase so
// they follow both people across phones (the role FinanceStore plays for money).
// Solo and Together read/write the SAME in-memory state — no divergent caches —
// which is the fix for the multi-mode / multi-device last-writer-wins risk.
//
// Documents-per-entity: a meal_days row holds a whole day's meals; a workouts
// row a whole session. Writes are OPTIMISTIC + debounced; a Realtime change from
// the other device refetches but SKIPS keys with a pending local write (dirty),
// so it can never undo an edit you're in the middle of.

const dayKey = (p: string, d: string) => `${p}|${d}`;
const mdDirty = (p: string, d: string) => `md|${p}|${d}`;
const wDirty = (id: string) => `w|${id}`;
const wtDirty = (p: string, d: string) => `wt|${p}|${d}`;

function mapDay(r: any): DayLog {
  return {
    date: r.date,
    person: r.person,
    meals: Array.isArray(r.meals) ? r.meals : [],
    status: r.status ?? undefined,
    note: r.note ?? undefined,
  };
}
function mapWorkout(r: any): Workout {
  return {
    id: r.id, date: r.date, person: r.person, name: r.name ?? "", notes: r.notes ?? "",
    exercises: Array.isArray(r.exercises) ? r.exercises : [], done: !!r.done,
  };
}
function mapRoutine(r: any): Routine {
  return { id: r.id, person: r.person, name: r.name, meta: r.meta ?? "", exercises: Array.isArray(r.exercises) ? r.exercises : [] };
}
function mapWeight(r: any): BodyWeight {
  return { person: r.person, date: r.date, weight: Number(r.weight) };
}
function mapSavedMeal(r: any): SavedMeal {
  return { id: r.id, name: r.name ?? "", items: Array.isArray(r.items) ? r.items : [] };
}
function mapMacroTarget(r: any): MacroTarget {
  return { kcal: Number(r.kcal), p: Number(r.p), c: Number(r.c), f: Number(r.f) };
}

interface HealthState {
  mealDays: Record<string, DayLog>;
  workouts: Workout[];
  routines: Routine[]; // custom only; the components add the code-defined seeds
  weights: BodyWeight[];
  savedMeals: SavedMeal[]; // household-shared favorite meals
  macroTargets: Record<string, MacroTarget>; // per-person daily targets (editable)
}

export interface HealthStore {
  loading: boolean;
  // exposed so the context value changes on every write → consumers re-render
  mealDays: Record<string, DayLog>;
  workouts: Workout[];
  routines: Routine[]; // custom only
  weights: BodyWeight[];
  savedMeals: SavedMeal[];
  macroTargets: Record<string, MacroTarget>;
  setMacroTarget: (person: Person, target: MacroTarget) => void;
  getDay: (person: Person, date: string) => DayLog;
  setDay: (day: DayLog) => void;
  upsertWorkout: (w: Workout) => void;
  deleteWorkout: (id: string) => void;
  addRoutine: (r: Routine) => void;
  deleteRoutine: (id: string) => void;
  setWeight: (person: Person, date: string, weight: number) => void;
  deleteWeight: (person: Person, date: string) => void;
  clearWeights: (person: Person) => void;
  addSavedMeal: (name: string, items: LoggedItem[]) => void;
  updateSavedMeal: (id: string, name: string, items: LoggedItem[]) => void;
  deleteSavedMeal: (id: string) => void;
}

const Ctx = createContext<HealthStore | null>(null);

export function HealthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HealthState>({ mealDays: {}, workouts: [], routines: [], weights: [], savedMeals: [], macroTargets: {} });
  const [loading, setLoading] = useState(true);

  const dataRef = useRef(state);
  dataRef.current = state;
  const dirty = useRef<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // the actual write for each debounced key, so a pending edit can be FLUSHED
  // (not dropped) when the provider unmounts mid-debounce.
  const pending = useRef<Map<string, () => void>>(new Map());
  const migrated = useRef(false);

  useEffect(() => {
    let active = true;

    async function reloadMealDays() {
      const { data: rows, error } = await supabase.from("meal_days").select("*");
      if (error || !active) return;
      setState((s) => {
        const next = { ...s.mealDays };
        for (const r of rows ?? []) {
          if (!dirty.current.has(mdDirty(r.person, r.date))) next[dayKey(r.person, r.date)] = mapDay(r);
        }
        return { ...s, mealDays: next };
      });
    }
    async function reloadWorkouts() {
      const { data: rows, error } = await supabase.from("workouts").select("*").order("date", { ascending: false });
      if (error || !active) return;
      setState((s) => {
        const remote = (rows ?? []).map(mapWorkout);
        const remoteIds = new Set(remote.map((w) => w.id));
        const merged = remote.map((w) => (dirty.current.has(wDirty(w.id)) ? s.workouts.find((x) => x.id === w.id) ?? w : w));
        const pendingLocal = s.workouts.filter((w) => dirty.current.has(wDirty(w.id)) && !remoteIds.has(w.id));
        return { ...s, workouts: [...pendingLocal, ...merged] };
      });
    }
    async function reloadRoutines() {
      const { data: rows, error } = await supabase.from("workout_routines").select("*");
      if (error || !active) return;
      setState((s) => ({ ...s, routines: (rows ?? []).map(mapRoutine) }));
    }
    async function reloadWeights() {
      const { data: rows, error } = await supabase.from("body_weights").select("*").order("date", { ascending: true });
      if (error || !active) return;
      setState((s) => {
        const remote = (rows ?? []).map(mapWeight);
        // A refetch (often triggered by the OTHER device's write) must not clobber
        // an in-flight local edit/delete: for any dirty (person+date) the LOCAL
        // state is truth — keep its value, or its ABSENCE (a pending delete isn't
        // resurrected). Clean keys come from remote. Mirrors the meal/workout guard.
        const isDirty = (p: string, d: string) => dirty.current.has(wtDirty(p, d));
        const cleanRemote = remote.filter((w) => !isDirty(w.person, w.date));
        const localDirty = s.weights.filter((w) => isDirty(w.person, w.date));
        return { ...s, weights: [...cleanRemote, ...localDirty] };
      });
    }

    async function reloadSavedMeals() {
      const { data: rows, error } = await supabase.from("saved_meals").select("*").order("created_at", { ascending: true });
      if (error || !active) return;
      setState((s) => ({ ...s, savedMeals: (rows ?? []).map(mapSavedMeal) }));
    }
    async function reloadMacroTargets() {
      const { data: rows, error } = await supabase.from("macro_targets").select("*");
      if (error || !active) return;
      setState((s) => {
        const next = { ...s.macroTargets };
        for (const r of rows ?? []) if (!dirty.current.has(`mt|${r.person}`)) next[r.person] = mapMacroTarget(r);
        return { ...s, macroTargets: next };
      });
    }

    async function migrateLocal() {
      if (migrated.current || localStorage.getItem("hb-health-migrated")) {
        migrated.current = true;
        return;
      }
      try {
        // meal days — only fill cloud where it's empty for that person+date
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith("hb-meallog-")) continue;
          const day = JSON.parse(localStorage.getItem(k) || "null");
          if (day && Array.isArray(day.meals) && day.meals.length && day.person && day.date) {
            const ex = dataRef.current.mealDays[dayKey(day.person, day.date)];
            if (!ex || !ex.meals.length) {
              await supabase.from("meal_days").upsert(
                { person: day.person, date: day.date, meals: day.meals, updated_at: new Date().toISOString() },
                { onConflict: "person,date" },
              );
            }
          }
        }
        for (const p of ["gino", "xinyan"]) {
          const wraw = JSON.parse(localStorage.getItem(`hb-workouts-${p}`) || "[]");
          const wrows = (wraw || []).filter((w: any) => w?.exercises?.length).map((w: any) => ({
            person: p, date: w.date, name: w.name || "", notes: w.notes || "", exercises: w.exercises, done: !!w.done,
          }));
          if (wrows.length && dataRef.current.workouts.filter((x) => x.person === p).length === 0) {
            await supabase.from("workouts").insert(wrows);
          }
          const rraw = JSON.parse(localStorage.getItem(`hb-routines-${p}`) || "[]");
          const rrows = (rraw || []).filter((r: any) => r && !r.seed).map((r: any) => ({
            person: p, name: r.name, meta: r.meta || "", exercises: r.exercises || [],
          }));
          if (rrows.length && dataRef.current.routines.filter((x) => x.person === p).length === 0) {
            await supabase.from("workout_routines").insert(rrows);
          }
        }
      } catch (e) {
        console.error("health migration", e);
      }
      localStorage.setItem("hb-health-migrated", "1");
      migrated.current = true;
      await Promise.all([reloadMealDays(), reloadWorkouts(), reloadRoutines(), reloadWeights()]);
    }

    Promise.all([reloadMealDays(), reloadWorkouts(), reloadRoutines(), reloadWeights(), reloadSavedMeals(), reloadMacroTargets()])
      .then(() => migrateLocal())
      .finally(() => active && setLoading(false));

    const channel = supabase
      .channel("homebase-health")
      .on("postgres_changes", { event: "*", schema: "public", table: "meal_days" }, () => reloadMealDays())
      .on("postgres_changes", { event: "*", schema: "public", table: "workouts" }, () => reloadWorkouts())
      .on("postgres_changes", { event: "*", schema: "public", table: "workout_routines" }, () => reloadRoutines())
      .on("postgres_changes", { event: "*", schema: "public", table: "body_weights" }, () => reloadWeights())
      .on("postgres_changes", { event: "*", schema: "public", table: "saved_meals" }, () => reloadSavedMeals())
      .on("postgres_changes", { event: "*", schema: "public", table: "macro_targets" }, () => reloadMacroTargets())
      .subscribe();

    const timersMap = timers.current;
    const pendingMap = pending.current;
    return () => {
      active = false;
      supabase.removeChannel(channel);
      for (const id of timersMap.values()) clearTimeout(id);
      timersMap.clear();
      // flush any pending debounced writes so a last-second edit isn't dropped
      const flushFns = [...pendingMap.values()];
      pendingMap.clear();
      for (const fn of flushFns) {
        try {
          fn();
        } catch {
          /* best effort */
        }
      }
    };
  }, []);

  type Actions = Omit<HealthStore, "loading" | "mealDays" | "workouts" | "routines" | "weights" | "savedMeals" | "macroTargets">;
  const store = useMemo<Actions>(() => {
    // Debounce a write by key; remember the write fn so unmount can flush it.
    const scheduleWrite = (key: string, doWrite: () => Promise<void>, delay = 700) => {
      const prev = timers.current.get(key);
      if (prev) clearTimeout(prev);
      pending.current.set(key, doWrite);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          pending.current.delete(key);
          void doWrite();
        }, delay),
      );
    };
    // On a failed write, RE-SCHEDULE with backoff so a dirty key always has a
    // live timer and self-heals when connectivity / RLS recovers — never stuck
    // local-only with no retry (which would also wedge the Realtime refetch).
    // After a few attempts give up and clear dirty so the row can re-sync from
    // the authoritative remote copy. `done()` runs the success/give-up path.
    const onWriteResult = (key: string, error: unknown, attempt: number, retry: (n: number) => void) => {
      if (!error) {
        dirty.current.delete(key);
        return;
      }
      console.error("health write failed", key, error);
      if (attempt < 6) scheduleWrite(key, () => Promise.resolve(retry(attempt + 1)), Math.min(30000, 1000 * 2 ** attempt));
      else dirty.current.delete(key); // gave up — next refetch re-syncs from remote
    };

    const writeDay = async (person: string, date: string, attempt = 0): Promise<void> => {
      const key = mdDirty(person, date);
      const day = dataRef.current.mealDays[dayKey(person, date)];
      if (!day) {
        dirty.current.delete(key);
        return;
      }
      const { error } = await supabase
        .from("meal_days")
        .upsert(
          { person, date, meals: day.meals, status: day.status ?? null, note: day.note ?? null, updated_at: new Date().toISOString() },
          { onConflict: "person,date" },
        );
      onWriteResult(key, error, attempt, (n) => void writeDay(person, date, n));
    };
    const writeWorkout = async (id: string, attempt = 0): Promise<void> => {
      const key = wDirty(id);
      const w = dataRef.current.workouts.find((x) => x.id === id);
      if (!w) {
        dirty.current.delete(key);
        return;
      }
      const { error } = await supabase.from("workouts").upsert(
        { id: w.id, person: w.person, date: w.date, name: w.name, notes: w.notes, exercises: w.exercises, done: w.done, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
      onWriteResult(key, error, attempt, (n) => void writeWorkout(id, n));
    };
    const flushDay = (person: string, date: string) => scheduleWrite(mdDirty(person, date), () => writeDay(person, date));
    const flushWorkout = (id: string) => scheduleWrite(wDirty(id), () => writeWorkout(id));

    return {
      getDay(person, date) {
        return dataRef.current.mealDays[dayKey(person, date)] ?? { date, person, meals: [] };
      },
      setDay(day) {
        dirty.current.add(mdDirty(day.person, day.date));
        setState((s) => ({ ...s, mealDays: { ...s.mealDays, [dayKey(day.person, day.date)]: day } }));
        flushDay(day.person, day.date);
      },
      upsertWorkout(w) {
        dirty.current.add(wDirty(w.id));
        setState((s) => {
          const exists = s.workouts.some((x) => x.id === w.id);
          return { ...s, workouts: exists ? s.workouts.map((x) => (x.id === w.id ? w : x)) : [w, ...s.workouts] };
        });
        flushWorkout(w.id);
      },
      deleteWorkout(id) {
        const key = wDirty(id);
        const prev = timers.current.get(key);
        if (prev) clearTimeout(prev);
        timers.current.delete(key);
        pending.current.delete(key);
        dirty.current.delete(key);
        setState((s) => ({ ...s, workouts: s.workouts.filter((x) => x.id !== id) }));
        supabase.from("workouts").delete().eq("id", id).then(({ error }) => error && console.error(error));
      },
      addRoutine(r) {
        setState((s) => ({ ...s, routines: [...s.routines, r] }));
        supabase
          .from("workout_routines")
          .insert({ id: r.id, person: r.person, name: r.name, meta: r.meta ?? "", exercises: r.exercises })
          .then(({ error }) => error && console.error(error));
      },
      deleteRoutine(id) {
        setState((s) => ({ ...s, routines: s.routines.filter((x) => x.id !== id) }));
        supabase.from("workout_routines").delete().eq("id", id).then(({ error }) => error && console.error(error));
      },
      setWeight(person, date, weight) {
        // one entry per day → optimistic replace + immediate upsert (no debounce).
        // dirty-guard the key so a concurrent refetch can't revert it mid-write.
        const key = wtDirty(person, date);
        dirty.current.add(key);
        setState((s) => ({
          ...s,
          weights: [...s.weights.filter((w) => !(w.person === person && w.date === date)), { person, date, weight }],
        }));
        supabase
          .from("body_weights")
          .upsert({ person, date, weight, updated_at: new Date().toISOString() }, { onConflict: "person,date" })
          .then(({ error }) => {
            dirty.current.delete(key);
            if (error) console.error("body_weights upsert", error);
          });
      },
      deleteWeight(person, date) {
        // optimistic remove of one weigh-in; the trend/averages recompute from state.
        // dirty-guard so a refetch mid-delete can't resurrect the row.
        const key = wtDirty(person, date);
        dirty.current.add(key);
        setState((s) => ({
          ...s,
          weights: s.weights.filter((w) => !(w.person === person && w.date === date)),
        }));
        supabase
          .from("body_weights")
          .delete()
          .eq("person", person)
          .eq("date", date)
          .then(({ error }) => {
            dirty.current.delete(key);
            if (error) console.error("body_weights delete", error);
          });
      },
      clearWeights(person) {
        // wipe this person's whole weigh-in history (the other person's stays).
        // dirty-guard every in-flight key so a refetch can't restore deleted rows.
        const keys = dataRef.current.weights.filter((w) => w.person === person).map((w) => wtDirty(w.person, w.date));
        keys.forEach((k) => dirty.current.add(k));
        setState((s) => ({ ...s, weights: s.weights.filter((w) => w.person !== person) }));
        supabase
          .from("body_weights")
          .delete()
          .eq("person", person)
          .then(({ error }) => {
            keys.forEach((k) => dirty.current.delete(k));
            if (error) console.error("body_weights clear", error);
          });
      },
      addSavedMeal(name, items) {
        const id = crypto.randomUUID();
        const meal: SavedMeal = { id, name: name.trim() || "Saved meal", items };
        setState((s) => ({ ...s, savedMeals: [...s.savedMeals, meal] }));
        supabase
          .from("saved_meals")
          .insert({ id: meal.id, name: meal.name, items: meal.items })
          .then(({ error }) => error && console.error("saved_meals insert", error));
      },
      updateSavedMeal(id, name, items) {
        const clean = name.trim() || "Saved meal";
        setState((s) => ({ ...s, savedMeals: s.savedMeals.map((m) => (m.id === id ? { ...m, name: clean, items } : m)) }));
        supabase
          .from("saved_meals")
          .update({ name: clean, items })
          .eq("id", id)
          .then(({ error }) => error && console.error("saved_meals update", error));
      },
      deleteSavedMeal(id) {
        setState((s) => ({ ...s, savedMeals: s.savedMeals.filter((m) => m.id !== id) }));
        supabase.from("saved_meals").delete().eq("id", id).then(({ error }) => error && console.error("saved_meals delete", error));
      },
      setMacroTarget(person, target) {
        // one row per person → optimistic replace + immediate upsert; dirty-guard
        // the key so a concurrent refetch can't revert it mid-write.
        const key = `mt|${person}`;
        dirty.current.add(key);
        setState((s) => ({ ...s, macroTargets: { ...s.macroTargets, [person]: target } }));
        supabase
          .from("macro_targets")
          .upsert(
            { person, kcal: target.kcal, p: target.p, c: target.c, f: target.f, updated_at: new Date().toISOString() },
            { onConflict: "person" },
          )
          .then(({ error }) => {
            dirty.current.delete(key);
            if (error) console.error("macro_targets upsert", error);
          });
      },
    };
  }, []);

  const value: HealthStore = {
    ...store,
    loading,
    mealDays: state.mealDays,
    workouts: state.workouts,
    routines: state.routines,
    weights: state.weights,
    savedMeals: state.savedMeals,
    macroTargets: state.macroTargets,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHealth(): HealthStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useHealth must be used within HealthProvider");
  return s;
}
