// ── The in-memory Health store for ?workoutlab ───────────────────────────────
// A complete HealthStore value with no Supabase behind it: every action mutates
// plain state held in this module's closure, and nothing leaves the tab. There
// is no sandbox database, so a harness wired to the real store would be logging
// test sets into the household's actual history — this file is the reason that
// cannot happen. tests/fakeHealthStore.test.ts walks its import graph to prove
// src/lib/supabase.ts is never reached (type-only imports are erased, so the
// HealthStore type costs nothing at runtime).
//
// The state lives in a tiny external store rather than useState so getDay (and
// anything else that reads synchronously) sees a write made a line earlier —
// the same guarantee the real store gets from its dataRef — and so the whole
// thing runs under plain node in a test, without rendering React.
//
// Semantics copy the real store where a screen could notice: upsertWorkout
// replaces in place or puts a new session FIRST, a routine is appended, a weigh-
// in is one row per person + day. What it deliberately does not copy is the
// debounce, the retry, and the merge — there is no second phone to merge with.

import { useMemo, useState, useSyncExternalStore } from "react";
import type { HealthStore } from "../store/HealthStore";
import type { DayLog } from "../lib/mealLog";

export interface FakeHealthState {
  mealDays: HealthStore["mealDays"];
  workouts: HealthStore["workouts"];
  routines: HealthStore["routines"];
  weights: HealthStore["weights"];
  savedMeals: HealthStore["savedMeals"];
  macroTargets: HealthStore["macroTargets"];
}
export type FakeHealthActions = Omit<HealthStore, "loading" | keyof FakeHealthState>;

export interface FakeHealth {
  getState: () => FakeHealthState;
  subscribe: (listener: () => void) => () => void;
  actions: FakeHealthActions;
}

const dayKey = (p: string, d: string) => `${p}|${d}`;

export function createFakeHealth(initial: Partial<FakeHealthState> = {}): FakeHealth {
  let state: FakeHealthState = {
    mealDays: {},
    workouts: [],
    routines: [],
    weights: [],
    savedMeals: [],
    macroTargets: {},
    ...initial,
  };
  const listeners = new Set<() => void>();
  // Every write makes a NEW state object, so useSyncExternalStore sees a change
  // and the context value handed to the screens changes with it.
  const set = (fn: (s: FakeHealthState) => FakeHealthState) => {
    state = fn(state);
    for (const l of [...listeners]) l();
  };

  const actions: FakeHealthActions = {
    getDay(person, date) {
      return state.mealDays[dayKey(person, date)] ?? ({ date, person, meals: [] } satisfies DayLog);
    },
    setDay(day) {
      set((s) => ({ ...s, mealDays: { ...s.mealDays, [dayKey(day.person, day.date)]: day } }));
    },
    upsertWorkout(w) {
      set((s) => {
        const exists = s.workouts.some((x) => x.id === w.id);
        return { ...s, workouts: exists ? s.workouts.map((x) => (x.id === w.id ? w : x)) : [w, ...s.workouts] };
      });
    },
    deleteWorkout(id) {
      set((s) => ({ ...s, workouts: s.workouts.filter((x) => x.id !== id) }));
    },
    addRoutine(r) {
      set((s) => ({ ...s, routines: [...s.routines, r] }));
    },
    deleteRoutine(id) {
      set((s) => ({ ...s, routines: s.routines.filter((x) => x.id !== id) }));
    },
    setWeight(person, date, weight) {
      set((s) => ({
        ...s,
        weights: [...s.weights.filter((w) => !(w.person === person && w.date === date)), { person, date, weight }],
      }));
    },
    deleteWeight(person, date) {
      set((s) => ({ ...s, weights: s.weights.filter((w) => !(w.person === person && w.date === date)) }));
    },
    clearWeights(person) {
      set((s) => ({ ...s, weights: s.weights.filter((w) => w.person !== person) }));
    },
    addSavedMeal(name, items) {
      const meal = { id: crypto.randomUUID(), name: name.trim() || "Saved meal", items };
      set((s) => ({ ...s, savedMeals: [...s.savedMeals, meal] }));
    },
    updateSavedMeal(id, name, items) {
      const clean = name.trim() || "Saved meal";
      set((s) => ({ ...s, savedMeals: s.savedMeals.map((m) => (m.id === id ? { ...m, name: clean, items } : m)) }));
    },
    deleteSavedMeal(id) {
      set((s) => ({ ...s, savedMeals: s.savedMeals.filter((m) => m.id !== id) }));
    },
    setMacroTarget(person, target) {
      set((s) => ({ ...s, macroTargets: { ...s.macroTargets, [person]: target } }));
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actions,
  };
}

/** The hook the lab mounts: a full HealthStore held in memory for the life of
 *  the component. `seed` runs once, on mount — remount (a new key) to reset. */
export function useFakeHealthStore(seed?: () => Partial<FakeHealthState>): HealthStore {
  const [fake] = useState(() => createFakeHealth(seed?.()));
  const state = useSyncExternalStore(fake.subscribe, fake.getState, fake.getState);
  return useMemo(() => ({ ...fake.actions, ...state, loading: false }), [fake, state]);
}
