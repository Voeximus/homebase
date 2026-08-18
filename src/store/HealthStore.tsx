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
// the other device refetches and MERGES into keys with a pending local write
// (dirty). It used to SKIP those keys, which protected the writer but silently
// threw away the reader's copy — the other phone's meals never entered state,
// and the whole-document upsert that followed then wrote them out of existence.
// Both phones are in this app at the same time, so that is the normal case.

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

// ── document merge ───────────────────────────────────────────────────────────
// meal_days / workouts rows are DOCUMENTS — one row carries a whole day's meals
// or a whole session's exercises — so every write replaces the lot and the last
// writer's document wins whole. Union the children by id instead: LOCAL wins for
// an id both sides have (this device is the one writing right now), and children
// only the REMOTE has are kept rather than erased — that is the other phone's
// edit. `removed` holds ids this device deleted on purpose, which must not sail
// back in from the remote copy. Remote-only children land at the END: neither a
// meal nor an exercise carries a timestamp, so there is no honest way to
// interleave them. Returns `local` itself when there is nothing to adopt, so a
// refetch that changes nothing doesn't churn state.
function unionById<T extends { id: string }>(local: T[], remote: T[], removed?: Set<string>): T[] {
  const mine = new Set(local.map((x) => x.id));
  const extra = remote.filter((x) => !mine.has(x.id) && !removed?.has(x.id));
  return extra.length ? [...local, ...extra] : local;
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
  // Unmount latch. A failed write re-arms its retry from an ASYNC callback, so
  // the new timer is created AFTER cleanup has already emptied the timer map —
  // and cleanup never runs again. The chain (6 attempts, ~61s) then outlives the
  // provider, and HealthView is unmounted on every Finance/Health toggle: a
  // retry firing after a remount would upsert the OLD provider's frozen dataRef
  // over whatever the new one has since written. Clearing the map a second time
  // can't fix that (the timer doesn't exist yet), so the latch is the gate.
  const alive = useRef(true);
  // Per dirty key, the child ids this device deleted on purpose. The merge below
  // adopts remote-only children, and without this record a meal or exercise you
  // just deleted would come straight back from the not-yet-updated remote copy.
  // Never cleared: ids are minted fresh (rowId/uuid) and never reused, so a stale
  // tombstone can only ever gate an id that no longer exists — and it costs a
  // string per deletion for the life of the session.
  const removed = useRef<Map<string, Set<string>>>(new Map());

  useEffect(() => {
    let active = true;
    alive.current = true; // re-arm on remount (StrictMode mounts the effect twice)

    async function reloadMealDays() {
      const { data: rows, error } = await supabase.from("meal_days").select("*");
      if (error || !active) return;
      setState((s) => {
        const next = { ...s.mealDays };
        for (const r of rows ?? []) {
          const k = dayKey(r.person, r.date);
          const dk = mdDirty(r.person, r.date);
          const remote = mapDay(r);
          const local = s.mealDays[k];
          // Clean key (or nothing local yet) → remote is truth.
          if (!dirty.current.has(dk) || !local) {
            next[k] = remote;
            continue;
          }
          // Dirty key: a local edit is mid-flight. We used to SKIP the row, which
          // meant the other phone's meals never reached this state and the whole-
          // document upsert waiting behind this edit then erased them from the DB.
          // Merge instead — every local meal stays (the edit is untouched) and the
          // meals only she has are adopted. status/note stay local-first for the
          // same reason; the write path re-fills them from remote when unset.
          const meals = unionById(local.meals, remote.meals, removed.current.get(dk));
          if (meals !== local.meals) next[k] = { ...local, meals };
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
        // Same document-merge as meal days: for a session with a pending local
        // write, keeping the local copy WHOLE (the old behaviour) dropped any
        // exercise the other device had already added to that session, and the
        // whole-session upsert behind it then deleted them for good. Local wins
        // per exercise id; remote-only exercises are adopted.
        const merged = remote.map((w) => {
          if (!dirty.current.has(wDirty(w.id))) return w;
          const local = s.workouts.find((x) => x.id === w.id);
          if (!local) return w;
          const exercises = unionById(local.exercises, w.exercises, removed.current.get(wDirty(w.id)));
          return exercises === local.exercises ? local : { ...local, exercises };
        });
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
      // Latch AFTER the flush, not before: the flush is a deliberate last-second
      // save and must still write. What must NOT survive is what the flush might
      // schedule later — its failure retry lands in a later task, by which time
      // this line has run and scheduleWrite/writeDay refuse it.
      alive.current = false;
    };
  }, []);

  type Actions = Omit<HealthStore, "loading" | "mealDays" | "workouts" | "routines" | "weights" | "savedMeals" | "macroTargets">;
  const store = useMemo<Actions>(() => {
    // Debounce a write by key; remember the write fn so unmount can flush it.
    const scheduleWrite = (key: string, doWrite: () => Promise<void>, delay = 700) => {
      // The provider is gone: its timer map has already been cleared and will
      // never be cleared again, so a timer armed here would fire into a dead
      // closure (frozen dataRef, orphaned dirty Set) minutes later and overwrite
      // whatever the live provider has written since.
      if (!alive.current) return;
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
      // Second gate for the unmount latch: a retry chain scheduled by the old
      // provider must never reach the network with that provider's stale state.
      if (!alive.current) return;
      const key = mdDirty(person, date);
      const day = dataRef.current.mealDays[dayKey(person, date)];
      if (!day) {
        dirty.current.delete(key);
        return;
      }
      // READ BEFORE WRITE. The upsert below replaces the whole document, so
      // writing local state blind erases any meal the other phone logged since
      // this edit began — and each backoff retry re-wrote the same stale
      // document for up to a minute. Merging HERE (not once at edit time) means
      // every attempt carries the freshest remote copy.
      const { data: row, error: readErr } = await supabase
        .from("meal_days")
        .select("*")
        .eq("person", person)
        .eq("date", date)
        .maybeSingle();
      if (readErr) {
        // Do NOT fall back to a blind write: whatever stops the read (offline,
        // RLS) is exactly the condition under which the write is destructive.
        // Retry the pair instead — the local edit stays dirty and safe.
        onWriteResult(key, readErr, attempt, (n) => void writeDay(person, date, n));
        return;
      }
      const remote = row ? mapDay(row) : null;
      const meals = remote ? unionById(day.meals, remote.meals, removed.current.get(key)) : day.meals;
      const { error } = await supabase
        .from("meal_days")
        .upsert(
          {
            person,
            date,
            meals,
            // local first, remote as the fallback: nothing clears a status, so a
            // day the other phone marked skipped/estimated survives our write.
            status: day.status ?? remote?.status ?? null,
            note: day.note ?? remote?.note ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "person,date" },
        );
      onWriteResult(key, error, attempt, (n) => void writeDay(person, date, n));
    };
    const writeWorkout = async (id: string, attempt = 0): Promise<void> => {
      if (!alive.current) return; // see writeDay
      const key = wDirty(id);
      const w = dataRef.current.workouts.find((x) => x.id === id);
      if (!w) {
        dirty.current.delete(key);
        return;
      }
      // Read-before-write for the same reason as writeDay: a session row is one
      // document, so a blind upsert drops any exercise the other device added.
      const { data: row, error: readErr } = await supabase.from("workouts").select("*").eq("id", id).maybeSingle();
      if (readErr) {
        onWriteResult(key, readErr, attempt, (n) => void writeWorkout(id, n));
        return;
      }
      const remote = row ? mapWorkout(row) : null;
      const exercises = remote ? unionById(w.exercises, remote.exercises, removed.current.get(key)) : w.exercises;
      const { error } = await supabase.from("workouts").upsert(
        { id: w.id, person: w.person, date: w.date, name: w.name, notes: w.notes, exercises, done: w.done, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
      onWriteResult(key, error, attempt, (n) => void writeWorkout(id, n));
    };
    // Record what this device deliberately deleted, so the union above doesn't
    // adopt it straight back from a remote copy that hasn't caught up yet.
    const noteRemovals = (key: string, prev: { id: string }[] | undefined, next: { id: string }[]) => {
      if (!prev?.length) return;
      const kept = new Set(next.map((x) => x.id));
      for (const x of prev) {
        if (kept.has(x.id)) continue;
        let set = removed.current.get(key);
        if (!set) removed.current.set(key, (set = new Set()));
        set.add(x.id);
      }
    };
    const flushDay = (person: string, date: string) => scheduleWrite(mdDirty(person, date), () => writeDay(person, date));
    const flushWorkout = (id: string) => scheduleWrite(wDirty(id), () => writeWorkout(id));

    return {
      getDay(person, date) {
        return dataRef.current.mealDays[dayKey(person, date)] ?? { date, person, meals: [] };
      },
      setDay(day) {
        const key = mdDirty(day.person, day.date);
        noteRemovals(key, dataRef.current.mealDays[dayKey(day.person, day.date)]?.meals, day.meals);
        dirty.current.add(key);
        setState((s) => ({ ...s, mealDays: { ...s.mealDays, [dayKey(day.person, day.date)]: day } }));
        flushDay(day.person, day.date);
      },
      upsertWorkout(w) {
        noteRemovals(wDirty(w.id), dataRef.current.workouts.find((x) => x.id === w.id)?.exercises, w.exercises);
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
