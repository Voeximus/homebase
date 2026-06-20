/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import type { DayLog, Person } from "../lib/mealLog";
import type { Routine, Workout } from "../lib/workoutLog";
import type { BodyWeight } from "../lib/weightLog";

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

function mapDay(r: any): DayLog {
  return { date: r.date, person: r.person, meals: Array.isArray(r.meals) ? r.meals : [] };
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

interface HealthState {
  mealDays: Record<string, DayLog>;
  workouts: Workout[];
  routines: Routine[]; // custom only; the components add the code-defined seeds
  weights: BodyWeight[];
}

export interface HealthStore {
  loading: boolean;
  // exposed so the context value changes on every write → consumers re-render
  mealDays: Record<string, DayLog>;
  workouts: Workout[];
  routines: Routine[]; // custom only
  weights: BodyWeight[];
  getDay: (person: Person, date: string) => DayLog;
  setDay: (day: DayLog) => void;
  upsertWorkout: (w: Workout) => void;
  deleteWorkout: (id: string) => void;
  addRoutine: (r: Routine) => void;
  deleteRoutine: (id: string) => void;
  setWeight: (person: Person, date: string, weight: number) => void;
}

const Ctx = createContext<HealthStore | null>(null);

export function HealthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HealthState>({ mealDays: {}, workouts: [], routines: [], weights: [] });
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
      setState((s) => ({ ...s, weights: (rows ?? []).map(mapWeight) }));
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

    Promise.all([reloadMealDays(), reloadWorkouts(), reloadRoutines(), reloadWeights()])
      .then(() => migrateLocal())
      .finally(() => active && setLoading(false));

    const channel = supabase
      .channel("homebase-health")
      .on("postgres_changes", { event: "*", schema: "public", table: "meal_days" }, () => reloadMealDays())
      .on("postgres_changes", { event: "*", schema: "public", table: "workouts" }, () => reloadWorkouts())
      .on("postgres_changes", { event: "*", schema: "public", table: "workout_routines" }, () => reloadRoutines())
      .on("postgres_changes", { event: "*", schema: "public", table: "body_weights" }, () => reloadWeights())
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

  type Actions = Omit<HealthStore, "loading" | "mealDays" | "workouts" | "routines" | "weights">;
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
        .upsert({ person, date, meals: day.meals, updated_at: new Date().toISOString() }, { onConflict: "person,date" });
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
        // one entry per day → optimistic replace + immediate upsert (no debounce)
        setState((s) => ({
          ...s,
          weights: [...s.weights.filter((w) => !(w.person === person && w.date === date)), { person, date, weight }],
        }));
        supabase
          .from("body_weights")
          .upsert({ person, date, weight, updated_at: new Date().toISOString() }, { onConflict: "person,date" })
          .then(({ error }) => error && console.error("body_weights upsert", error));
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
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHealth(): HealthStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useHealth must be used within HealthProvider");
  return s;
}
