/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import type { DayLog, LoggedItem, Person, SavedMeal } from "../lib/mealLog";
import type { Routine, Workout } from "../lib/workoutLog";
import type { BodyWeight } from "../lib/weightLog";
import type { MacroTarget } from "../lib/nutrition";
import {
  createSyncTracker,
  localEdit,
  mergeExercises,
  mergeWorkoutLists,
  removedIds,
  repairDuplicateSetIds,
  retryDelay,
  unionById,
  type Tombstones,
} from "../lib/syncMerge";
import {
  clearJournal,
  confirmJournal,
  markJournalOnServer,
  readJournal,
  readJournals,
  resolveJournal,
  writeJournal,
} from "../lib/activeJournal";

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
//
// Workouts get more guards ("never lose a set"; the deciding logic is pure, in
// lib/syncMerge.ts and lib/activeJournal.ts): the unsaved flag carries a
// generation so a save can't mark a NEWER edit as saved; a session merges set by
// set, not exercise by exercise; a failed save never stops retrying; and every
// change to a session is copied to the phone, confirmed once its save lands, and
// merged back after the first load that reaches the server.

const dayKey = (p: string, d: string) => `${p}|${d}`;
const mdDirty = (p: string, d: string) => `md|${p}|${d}`;
const wDirty = (id: string) => `w|${id}`;
const wtDirty = (p: string, d: string) => `wt|${p}|${d}`;
const PEOPLE = ["gino", "xinyan"] as const;
// Sessions whose newest edits exist only on this phone.
const unsavedCopies = () => PEOPLE.flatMap((p) => readJournals(p)).filter((j) => j.edits > j.confirmed);

// Sessions deleted here whose delete hasn't reached the server yet, one key
// each, so a kill before it lands can't bring them back on the next open.
const DEL_PREFIX = "hb-del-";
function pendingDeletes(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(DEL_PREFIX)) out.push(k.slice(DEL_PREFIX.length));
    }
    return out;
  } catch {
    return [];
  }
}

// Record ids an edit deleted on purpose under a dirty key (see `removed` below).
function addTombstones(map: Map<string, Set<string>>, key: string, ids: Iterable<string>) {
  for (const id of ids) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(id);
  }
}
const tombstonesOf = (removed: Map<string, Set<string>>, removedSets: Map<string, Set<string>>, id: string): Tombstones => ({
  exercises: removed.get(wDirty(id)),
  sets: removedSets.get(wDirty(id)),
});

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
  // Duplicate set ids are repaired on the way IN, before any merge or write can
  // see them: an old app version adds a set by copying the last one, id included.
  return repairDuplicateSetIds({
    id: r.id, date: r.date, person: r.person, name: r.name ?? "", notes: r.notes ?? "",
    exercises: Array.isArray(r.exercises) ? r.exercises : [], done: !!r.done,
  });
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
// writer's document wins whole. The merges that stop that (unionById for meals,
// set-by-set mergeExercises for sessions) live in lib/syncMerge.ts.

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
  // Shown from the first render: an offline open (a cold start, or a Finance/
  // Health toggle) must still show the running session, and never offer Start
  // beside it. Not marked touched or unsaved: the first load that reaches the
  // server swaps each for the server's row, and the merge-back below then puts
  // back what only this phone has.
  const [copies] = useState(unsavedCopies);
  const [state, setState] = useState<HealthState>(() => ({
    mealDays: {},
    workouts: copies.map((j) => repairDuplicateSetIds(j.workout)),
    routines: [],
    weights: [],
    savedMeals: [],
    macroTargets: {},
  }));
  const [loading, setLoading] = useState(true);

  const dataRef = useRef(state);
  // Assigned DURING render, before the children render — not in a layout effect
  // after the commit, as the hooks lint would prefer. MealBuilder calls getDay
  // while rendering, and a copy made after the commit drew the previous version
  // of the day: an added meal looked like it hadn't been added, inviting a
  // second tap. Handlers, timers and effects all run later and see the same.
  dataRef.current = state;
  // The unsaved flag per key, with a generation: a save clears it only if no
  // edit arrived after that save started (see createSyncTracker).
  const dirty = useRef(createSyncTracker());
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
  // The same record for SET ids inside a workout, per workout key, consulted by
  // the set-by-set merge.
  const removedSets = useRef<Map<string, Set<string>>>(new Map());
  // Writes for one key run strictly one after another. Two saves of the same
  // session in the air at once can land out of order — the older document last
  // — and the newer save's success would then mark state clean over a server
  // copy that is missing its edit.
  const chains = useRef<Map<string, Promise<void>>>(new Map());
  // The first workouts fetch that SUCCEEDED, whenever it happens: the phone
  // copies are only merged against a real server copy (see the journal effect
  // below). State, not a ref — a load that fails offline must leave the merge
  // waiting for a later fetch, not skip it for the life of the app.
  const [workoutsLoaded, setWorkoutsLoaded] = useState(false);
  const firstServerCopy = useRef<Workout[] | null>(null); // what that fetch returned, before any merge
  const journalChecked = useRef(false);
  // Sessions this provider has edited or deleted. The merge-back leaves their
  // copies alone: state already holds their newest edit.
  const touched = useRef<Set<string>>(new Set());
  // Session ids known to exist on the server (seen in a fetch, or a save of
  // them landed). Stamped on the phone copy, so a copy of a session deleted on
  // another phone is recognised as deleted rather than as never saved.
  const onServer = useRef<Set<string>>(new Set());
  // Sessions deleted on this device. A fetch never brings one back: not one
  // whose delete failed offline, nor one answered from before the delete landed.
  // Never cleared, like the tombstones: ids are never reused.
  const deleted = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    alive.current = true; // re-arm on remount (StrictMode mounts the effect twice)
    for (const id of pendingDeletes()) deleted.current.add(id);
    // What the shown phone copies had deleted, so neither a save nor a refetch
    // adopts those back from the server before the merge-back runs.
    for (const j of copies) {
      addTombstones(removed.current, wDirty(j.workout.id), j.removedExercises ?? []);
      addTombstones(removedSets.current, wDirty(j.workout.id), j.removedSets ?? []);
    }

    async function reloadMealDays() {
      // Taken BEFORE the request: a key whose save lands while this fetch is in
      // the air must still merge, not take this (older) copy whole.
      const fetchNo = dirty.current.beginFetch();
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
          if (!dirty.current.protects(dk, fetchNo) || !local) {
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
      const fetchNo = dirty.current.beginFetch(); // see reloadMealDays
      const { data: rows, error } = await supabase.from("workouts").select("*").order("date", { ascending: false });
      if (error || !active) return;
      const remote = (rows ?? []).map(mapWorkout).filter((w) => !deleted.current.has(w.id));
      for (const w of remote) onServer.current.add(w.id);
      firstServerCopy.current ??= remote;
      setWorkoutsLoaded(true); // committed together with the merge below
      // Same document-merge as meal days: for a session with a pending local
      // write, keeping the local copy WHOLE (the old behaviour) dropped any
      // exercise the other device had already added to that session, and the
      // whole-session upsert behind it then deleted them for good. Local wins
      // per set id (per exercise when sets carry no ids); remote-only exercises
      // and sets are adopted.
      setState((s) => ({
        ...s,
        workouts: mergeWorkoutLists(
          s.workouts,
          remote,
          (id) => dirty.current.protects(wDirty(id), fetchNo),
          (id) => tombstonesOf(removed.current, removedSets.current, id),
        ),
      }));
    }
    async function reloadRoutines() {
      const { data: rows, error } = await supabase.from("workout_routines").select("*");
      if (error || !active) return;
      setState((s) => ({ ...s, routines: (rows ?? []).map(mapRoutine) }));
    }
    async function reloadWeights() {
      const fetchNo = dirty.current.beginFetch(); // see reloadMealDays
      const { data: rows, error } = await supabase.from("body_weights").select("*").order("date", { ascending: true });
      if (error || !active) return;
      setState((s) => {
        const remote = (rows ?? []).map(mapWeight);
        // A refetch (often triggered by the OTHER device's write) must not clobber
        // an in-flight local edit/delete: for any dirty (person+date) the LOCAL
        // state is truth — keep its value, or its ABSENCE (a pending delete isn't
        // resurrected). Clean keys come from remote. Mirrors the meal/workout guard.
        const isDirty = (p: string, d: string) => dirty.current.protects(wtDirty(p, d), fetchNo);
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
      const fetchNo = dirty.current.beginFetch(); // see reloadMealDays
      const { data: rows, error } = await supabase.from("macro_targets").select("*");
      if (error || !active) return;
      setState((s) => {
        const next = { ...s.macroTargets };
        for (const r of rows ?? []) if (!dirty.current.protects(`mt|${r.person}`, fetchNo)) next[r.person] = mapMacroTarget(r);
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
    // Back online → fetch the sessions again. Realtime doesn't replay what it
    // missed, and a load that failed offline would otherwise leave the phone
    // copies waiting for the other phone's next change.
    const onOnline = () => void reloadWorkouts();
    window.addEventListener("online", onOnline);

    const timersMap = timers.current;
    const pendingMap = pending.current;
    return () => {
      active = false;
      window.removeEventListener("online", onOnline);
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
      // this line has run and scheduleWrite refuses it.
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount; `copies` is fixed at the first render
  }, []);

  type Actions = Omit<HealthStore, "loading" | "mealDays" | "workouts" | "routines" | "weights" | "savedMeals" | "macroTargets">;
  const store = useMemo<Actions>(() => {
    // Queue a write behind any write for the same key that is still in the air
    // (see `chains`). Each write reads state when it RUNS, so the queued one
    // carries everything edited while it waited.
    const runInOrder = (key: string, job: () => Promise<void>): Promise<void> => {
      const next = (chains.current.get(key) ?? Promise.resolve()).then(job).catch((e) => console.error("health write crashed", key, e));
      chains.current.set(key, next);
      void next.then(() => {
        if (chains.current.get(key) === next) chains.current.delete(key);
      });
      return next;
    };
    // Debounce a write by key; remember the write fn so unmount can flush it.
    // `doWrite(flush)`: true only for the unmount flush, which may still write
    // once the provider is gone (see writeWorkout).
    const scheduleWrite = (key: string, doWrite: (flush: boolean) => Promise<void>, delay = 700) => {
      // The provider is gone: its timer map has already been cleared and will
      // never be cleared again, so a timer armed here would fire into a dead
      // closure (frozen dataRef, orphaned dirty Set) minutes later and overwrite
      // whatever the live provider has written since.
      if (!alive.current) return;
      const prev = timers.current.get(key);
      if (prev) clearTimeout(prev);
      // The flush queues too. Called straight, it ran beside a save of the same
      // key still in the air; if that older save landed last, the server kept
      // the older document while the flush had already confirmed the phone copy.
      pending.current.set(key, () => void runInOrder(key, () => doWrite(true)));
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          pending.current.delete(key);
          void runInOrder(key, () => doWrite(false));
        }, delay),
      );
    };
    // On a failed write, RE-SCHEDULE with backoff so a dirty key always has a
    // live timer and self-heals when connectivity / RLS recovers — never stuck
    // local-only with no retry (which would also wedge the Realtime refetch).
    // A meal day gives up after a few attempts and clears dirty so the row can
    // re-sync from the authoritative remote copy. A workout never gives up (see
    // retryDelay): giving up let the next refetch replace unsaved sets.
    //
    // `gen` is the key's generation when this write STARTED. Clearing the flag
    // unconditionally was the bug: an edit made while the save was in the air
    // was then marked saved, and the next refetch (often triggered by this very
    // write) replaced it with the older server copy. Returns whether it cleared.
    const onWriteResult = (
      key: string,
      error: unknown,
      attempt: number,
      retry: (n: number, flush: boolean) => Promise<void>,
      gen: number,
    ): boolean => {
      if (!error) return dirty.current.settle(key, gen);
      console.error("health write failed", key, error);
      const delay = retryDelay(key, attempt);
      // the retry returns its promise so the queue waits for the whole attempt;
      // one still waiting at unmount is flushed like any pending write
      if (delay !== null) scheduleWrite(key, (flush) => retry(attempt + 1, flush), delay);
      else return dirty.current.settle(key, gen); // gave up — next refetch re-syncs from remote
      return false;
    };

    // No unmount latch in here. Every job in the queue was admitted by a timer
    // that fired while the provider was alive, or by the unmount flush, and a
    // retry can only be armed through scheduleWrite, which refuses once it is
    // gone. A latch here dropped a save left waiting in the queue at unmount,
    // and a meal day has no phone copy to bring it back.
    const writeDay = async (person: string, date: string, attempt = 0): Promise<void> => {
      const key = mdDirty(person, date);
      // read with the document, before any await: this is the edit being saved
      const gen = dirty.current.generation(key);
      const day = dataRef.current.mealDays[dayKey(person, date)];
      if (!day) {
        dirty.current.settle(key, gen);
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
        onWriteResult(key, readErr, attempt, (n) => writeDay(person, date, n), gen);
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
      onWriteResult(key, error, attempt, (n) => writeDay(person, date, n), gen);
    };
    const writeWorkout = async (id: string, attempt = 0, flush = false): Promise<void> => {
      // The unmount latch, except for the flush. A save left waiting in the
      // queue at unmount is dropped: the phone copy brings its edit back on the
      // next load, and a late save of the old provider could otherwise confirm
      // edits a remounted one has made since.
      if (!alive.current && !flush) return;
      const key = wDirty(id);
      const gen = dirty.current.generation(key); // see writeDay
      const w = dataRef.current.workouts.find((x) => x.id === id);
      if (!w) {
        dirty.current.settle(key, gen);
        return;
      }
      // The copy's edit count as this save starts: a late landing may confirm
      // these, never edits written to the copy after it (by a remounted provider).
      const editsAtStart = readJournal(w.person, id)?.edits ?? 0;
      // Read-before-write for the same reason as writeDay: a session row is one
      // document, so a blind upsert drops any set the other device added.
      const { data: row, error: readErr } = await supabase.from("workouts").select("*").eq("id", id).maybeSingle();
      if (readErr) {
        onWriteResult(key, readErr, attempt, (n, fl) => writeWorkout(id, n, fl), gen);
        return;
      }
      const remote = row ? mapWorkout(row) : null;
      const exercises = remote
        ? mergeExercises(w.exercises, remote.exercises, tombstonesOf(removed.current, removedSets.current, id))
        : w.exercises;
      const { error } = await supabase.from("workouts").upsert(
        { id: w.id, person: w.person, date: w.date, name: w.name, notes: w.notes, exercises, done: w.done, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
      const settled = onWriteResult(key, error, attempt, (n, fl) => writeWorkout(id, n, fl), gen);
      if (error) return;
      // The row exists now, even when a newer edit is waiting. A copy that
      // missed this stamp later read a delete on another phone as "never saved".
      onServer.current.add(id);
      if (!settled) {
        markJournalOnServer(w.person, id);
        return;
      }
      // The server now holds everything the phone copy has, and nothing newer
      // was edited meanwhile. A finish is done with its copy; an unfinished
      // session's copy is stamped confirmed, so a later load trusts the server
      // for it. Clearing or confirming at the tap would lose the session's last
      // sets if this save never landed.
      if (w.done) clearJournal(w.person, w.id);
      else confirmJournal({ ...w, exercises }, undefined, editsAtStart);
    };
    // Record what this device deliberately deleted, so the merge doesn't adopt it
    // straight back from a remote copy that hasn't caught up yet.
    const noteRemovals = (key: string, prev: { id: string }[] | undefined, next: { id: string }[]) =>
      addTombstones(removed.current, key, removedIds(prev, next));
    const flushDay = (person: string, date: string) => scheduleWrite(mdDirty(person, date), () => writeDay(person, date));
    const flushWorkout = (id: string) => scheduleWrite(wDirty(id), (fl) => writeWorkout(id, 0, fl));

    return {
      getDay(person, date) {
        return dataRef.current.mealDays[dayKey(person, date)] ?? { date, person, meals: [] };
      },
      setDay(day) {
        const key = mdDirty(day.person, day.date);
        noteRemovals(key, dataRef.current.mealDays[dayKey(day.person, day.date)]?.meals, day.meals);
        dirty.current.edit(key);
        setState((s) => ({ ...s, mealDays: { ...s.mealDays, [dayKey(day.person, day.date)]: day } }));
        flushDay(day.person, day.date);
      },
      upsertWorkout(edit) {
        const key = wDirty(edit.id);
        const prev = dataRef.current.workouts.find((x) => x.id === edit.id);
        // Duplicate set ids repaired before the edit enters state (localEdit).
        const { workout: w, removedExercises, removedSets: goneSets } = localEdit(prev, edit);
        addTombstones(removed.current, key, removedExercises);
        addTombstones(removedSets.current, key, goneSets);
        touched.current.add(w.id);
        dirty.current.edit(key);
        // The phone copy is written NOW, not after the debounce: a set ticked
        // and then the app killed within the next ~700 ms must still exist. A
        // finish too — otherwise a finish whose save never landed came back on
        // the next load as the running session, or as a banner offering Discard.
        writeJournal(w, {
          removedExercises: removed.current.get(key),
          removedSets: removedSets.current.get(key),
          onServer: onServer.current.has(w.id),
        });
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
        dirty.current.forget(key);
        touched.current.add(id);
        for (const p of PEOPLE) clearJournal(p, id);
        setState((s) => ({ ...s, workouts: s.workouts.filter((x) => x.id !== id) }));
        // A delete is owed until it lands, like a save: marked on the phone,
        // hidden from every fetch, and retried. Sent once and only logged, a
        // delete that failed offline came back with the next fetch.
        deleted.current.add(id);
        try {
          localStorage.setItem(DEL_PREFIX + id, "1");
        } catch {
          /* best effort: this provider still hides it and retries */
        }
        const del = async (attempt = 0): Promise<void> => {
          if (!alive.current) return; // the next mount sends it again from the mark
          const { error } = await supabase.from("workouts").delete().eq("id", id);
          if (!error) {
            try {
              localStorage.removeItem(DEL_PREFIX + id);
            } catch {
              /* a stale mark only re-sends the delete of a row that is gone */
            }
            return;
          }
          console.error("workout delete failed", id, error);
          scheduleWrite(key, () => del(attempt + 1), retryDelay(key, attempt) ?? 30000);
        };
        // Behind any save of this session still in the air, so that save can't
        // land after the delete and bring the row back.
        void runInOrder(key, () => del());
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
        const gen = dirty.current.edit(key);
        setState((s) => ({
          ...s,
          weights: [...s.weights.filter((w) => !(w.person === person && w.date === date)), { person, date, weight }],
        }));
        supabase
          .from("body_weights")
          .upsert({ person, date, weight, updated_at: new Date().toISOString() }, { onConflict: "person,date" })
          .then(({ error }) => {
            dirty.current.settle(key, gen);
            if (error) console.error("body_weights upsert", error);
          });
      },
      deleteWeight(person, date) {
        // optimistic remove of one weigh-in; the trend/averages recompute from state.
        // dirty-guard so a refetch mid-delete can't resurrect the row.
        const key = wtDirty(person, date);
        const gen = dirty.current.edit(key);
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
            dirty.current.settle(key, gen);
            if (error) console.error("body_weights delete", error);
          });
      },
      clearWeights(person) {
        // wipe this person's whole weigh-in history (the other person's stays).
        // dirty-guard every in-flight key so a refetch can't restore deleted rows.
        const keys = dataRef.current.weights.filter((w) => w.person === person).map((w) => wtDirty(w.person, w.date));
        const gens = keys.map((k) => dirty.current.edit(k));
        setState((s) => ({ ...s, weights: s.weights.filter((w) => w.person !== person) }));
        supabase
          .from("body_weights")
          .delete()
          .eq("person", person)
          .then(({ error }) => {
            keys.forEach((k, i) => dirty.current.settle(k, gens[i]));
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
        const gen = dirty.current.edit(key);
        setState((s) => ({ ...s, macroTargets: { ...s.macroTargets, [person]: target } }));
        supabase
          .from("macro_targets")
          .upsert(
            { person, kcal: target.kcal, p: target.p, c: target.c, f: target.f, updated_at: new Date().toISOString() },
            { onConflict: "person" },
          )
          .then(({ error }) => {
            dirty.current.settle(key, gen);
            if (error) console.error("macro_targets upsert", error);
          });
      },
    };
  }, []);

  // ── the phone copies, merged back once per mount ────────────────────────────
  // After the first workouts load that reached the server, however late it
  // comes (an offline start waits for the phone to reconnect). Until then the
  // copies stay on the phone untouched: merging against "no server copy" would
  // read an offline start as "this session never saved". Compared with what
  // that fetch returned, not with state, which may already hold sessions
  // started on this phone while offline.
  const { upsertWorkout, deleteWorkout } = store;
  useEffect(() => {
    if (!workoutsLoaded || journalChecked.current) return;
    journalChecked.current = true;
    // deletes the app was closed before it could send
    for (const id of pendingDeletes()) deleteWorkout(id);
    const serverCopy = firstServerCopy.current ?? [];
    for (const person of PEOPLE) {
      for (const journal of readJournals(person)) {
        // edited here already: state holds its newest edit, and the copy is live
        if (touched.current.has(journal.workout.id)) continue;
        const server = serverCopy.find((w) => w.id === journal.workout.id);
        const r = resolveJournal(server, journal);
        if (r.action !== "restore") {
          clearJournal(person, journal.workout.id); // the server holds it, or it is stale
          continue;
        }
        // Seed what the phone had deleted BEFORE the upsert, so neither its
        // removal diff nor the save's merge adopts those back from the server.
        const key = wDirty(r.workout.id);
        addTombstones(removed.current, key, r.tombstones.exercises);
        addTombstones(removedSets.current, key, r.tombstones.sets);
        upsertWorkout(r.workout); // unsaved again → saved like any edit
      }
    }
  }, [workoutsLoaded, upsertWorkout, deleteWorkout]);

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

/** Mount a ready-made store value — for dev harnesses (?workoutlab) that must
 *  never touch Supabase. The real app always uses HealthProvider. */
export function HealthValueProvider({ value, children }: { value: HealthStore; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHealth(): HealthStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useHealth must be used within HealthProvider");
  return s;
}
