import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Dumbbell,
  Flame,
  Minus,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Trophy,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import { t } from "../lib/i18n";
import {
  bestSet,
  personalRecords,
  rowId,
  searchExercises,
  SEED_ROUTINES,
  thisWeekCount,
  todayStr,
  totalSets,
  workoutDuration,
  workoutVolume,
  type Exercise,
  type ExerciseEntry,
  type Person,
  type Routine,
  type Workout,
} from "../lib/workoutLog";
import { useHealth } from "../store/HealthStore";

const newId = () => crypto.randomUUID();
// "30 min" for a time-based quick log, else "N sets"
const sessionStat = (w: Workout) =>
  workoutDuration(w) > 0 && totalSets(w) === 0
    ? t("{n} min", { n: workoutDuration(w) })
    : t("{n} sets", { n: totalSets(w) });

const PERSON_ACC: Record<Person, string> = { gino: "#ef8136", xinyan: "#2dd1c0" };
const PERSON_NAME: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };
const TILE = { background: "var(--color-tile)", borderColor: "var(--color-edge)" } as const;
const STICKY_TOP = "calc(env(safe-area-inset-top, 0px) + 6px)";
const r0 = (n: number) => Math.round(n);
const other = (p: Person): Person => (p === "gino" ? "xinyan" : "gino");
const WEEK_GOAL = 4; // a friendly weekly target the ring fills toward

// ── entry point ────────────────────────────────────────────────────────────────
export function WorkoutSection({ owner, person }: { owner: Person; person: Person }) {
  const [mode, setMode] = useState<"solo" | "together">(
    () => (localStorage.getItem("hb-workout-mode") as "solo" | "together") || "solo",
  );
  useEffect(() => localStorage.setItem("hb-workout-mode", mode), [mode]);

  const [library, setLibrary] = useState<Exercise[]>([]);
  useEffect(() => {
    let on = true;
    import("../lib/exerciseData").then((m) => on && setLibrary(m.BUNDLED_EXERCISES)).catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-3 pb-8">
      <div className="hb-ctl">
        <div className="hb-itog">
          <button className={mode === "solo" ? "on" : ""} onClick={() => setMode("solo")} aria-label={t("Just me")}><User size={16} /></button>
          <button className={mode === "together" ? "on" : ""} onClick={() => setMode("together")} aria-label={t("Together")}><Users size={16} /></button>
        </div>
      </div>

      {mode === "solo" ? (
        <SoloWorkout key={person} person={person} library={library} />
      ) : (
        <TogetherWorkout key={owner} owner={owner} />
      )}
    </div>
  );
}

// ── SOLO — log a session, routines, PRs, history ────────────────────────────────
function SoloWorkout({ person, library }: { person: Person; library: Exercise[] }) {
  const today = todayStr();
  const { workouts: allWorkouts, routines: allRoutines, upsertWorkout, deleteWorkout, addRoutine, deleteRoutine: storeDeleteRoutine } = useHealth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);

  const mine = useMemo(() => allWorkouts.filter((w) => w.person === person), [allWorkouts, person]);
  const routines = useMemo(
    () => [...SEED_ROUTINES[person], ...allRoutines.filter((r) => r.person === person)],
    [allRoutines, person],
  );
  const active = mine.find((w) => !w.done) ?? null;
  const done = useMemo(() => mine.filter((w) => w.done).sort((a, b) => b.date.localeCompare(a.date)), [mine]);
  const prs = useMemo(() => personalRecords(done), [done]);
  const weekCount = thisWeekCount(done, today);
  // a past workout opened for editing (history is fully manageable, not rigid)
  const editingWorkout = useMemo(() => done.find((w) => w.id === editId) ?? null, [done, editId]);

  const setActive = (fn: (w: Workout) => Workout) => {
    if (active) upsertWorkout(fn(active));
  };

  const startBlank = () => {
    if (active) return;
    upsertWorkout({ id: newId(), date: today, person, name: t("Workout"), notes: "", exercises: [], done: false });
  };
  const startFromRoutine = (r: Routine) => {
    if (active) return;
    const exercises: ExerciseEntry[] = r.exercises.map((re) => ({
      id: rowId(),
      exerciseId: "",
      name: re.name,
      muscle: re.muscle,
      sets: Array.from({ length: Math.max(1, re.sets) }, () => ({ reps: 0, weight: 0 })),
    }));
    upsertWorkout({ id: newId(), date: today, person, name: r.name, notes: "", exercises, done: false });
  };
  const addExercise = (ex: { name: string; muscle: string; exerciseId: string }) =>
    setActive((w) => ({ ...w, exercises: [...w.exercises, { id: rowId(), exerciseId: ex.exerciseId, name: ex.name, muscle: ex.muscle, sets: [{ reps: 0, weight: 0 }] }] }));
  const addSet = (exId: string) =>
    setActive((w) => ({
      ...w,
      exercises: w.exercises.map((e) =>
        e.id === exId ? { ...e, sets: [...e.sets, e.sets.length ? { ...e.sets[e.sets.length - 1] } : { reps: 0, weight: 0 }] } : e,
      ),
    }));
  const setSet = (exId: string, i: number, patch: { reps?: number; weight?: number }) =>
    setActive((w) => ({
      ...w,
      exercises: w.exercises.map((e) =>
        e.id === exId ? { ...e, sets: e.sets.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : e,
      ),
    }));
  const removeSet = (exId: string, i: number) =>
    setActive((w) => ({ ...w, exercises: w.exercises.map((e) => (e.id === exId ? { ...e, sets: e.sets.filter((_, j) => j !== i) } : e)) }));
  const removeExercise = (exId: string) =>
    setActive((w) => ({ ...w, exercises: w.exercises.filter((e) => e.id !== exId) }));
  const finish = () => {
    if (!active) return;
    if (!active.exercises.length) {
      deleteWorkout(active.id); // nothing logged → discard the empty session
      return;
    }
    upsertWorkout({ ...active, done: true });
  };
  const discard = () => {
    if (active) deleteWorkout(active.id);
  };
  const saveAsRoutine = () => {
    if (!active || !active.exercises.length) return;
    addRoutine({
      id: newId(),
      person,
      name: active.name || t("My routine"),
      meta: t("saved {date}", { date: today.slice(5) }),
      exercises: active.exercises.map((e) => ({ name: e.name, muscle: e.muscle, sets: Math.max(1, e.sets.length), reps: "" })),
    });
  };
  const deleteRoutine = (id: string) => storeDeleteRoutine(id);
  // Quick log → a one-exercise session, marked done immediately. Counts toward
  // the week + history, never asks you to build a routine.
  const quickLog = (
    a: { name: string; muscle: string; exerciseId: string },
    payload: { duration?: number; sets?: number; reps?: number; weight?: number },
  ) => {
    const ex: ExerciseEntry =
      payload.duration != null
        ? { id: rowId(), exerciseId: a.exerciseId, name: a.name, muscle: a.muscle, sets: [], duration: payload.duration }
        : {
            id: rowId(),
            exerciseId: a.exerciseId,
            name: a.name,
            muscle: a.muscle,
            sets: Array.from({ length: Math.max(1, payload.sets ?? 1) }, () => ({ reps: payload.reps ?? 0, weight: payload.weight ?? 0 })),
          };
    upsertWorkout({ id: newId(), date: today, person, name: a.name, notes: "", exercises: [ex], done: true });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* sticky summary — this week + today's session */}
      <div className="sticky z-30" style={{ top: STICKY_TOP }}>
        <WorkoutSummary name={PERSON_NAME[person]} weekCount={weekCount} active={active} />
      </div>

      {active ? (
        <ActiveWorkout
          w={active}
          onAddExercise={() => setSearchOpen(true)}
          onAddSet={addSet}
          onSetChange={setSet}
          onRemoveSet={removeSet}
          onRemoveExercise={removeExercise}
          onFinish={finish}
          onDiscard={discard}
          onSaveRoutine={saveAsRoutine}
        />
      ) : (
        <>
          <button
            onClick={startBlank}
            className="flex items-center justify-center gap-2 rounded-[18px] py-4 text-[15px] font-semibold text-white transition active:scale-[0.98]"
            style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
          >
            <Play size={17} /> {t("Add a workout")}
          </button>
          <button
            onClick={() => setQuickOpen(true)}
            className="flex items-center justify-center gap-2 rounded-[16px] py-3 text-[13.5px] font-semibold transition active:scale-[0.98]"
            style={{ background: "color-mix(in srgb, var(--color-accent) 12%, transparent)", color: "var(--color-accent)" }}
          >
            <Zap size={16} /> {t("Quick log — just an activity")}
          </button>
        </>
      )}

      {/* routines */}
      {!active && (
        <section className="rounded-[18px] border p-4" style={TILE}>
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>
            {t("Routines")}
          </p>
          <div className="flex flex-col gap-2">
            {routines.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-[12px] px-3 py-2.5" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-bone">{t(r.name)}</div>
                  <div className="truncate text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
                    {r.meta ? t(r.meta) + " · " : ""}
                    {t("{n} exercises", { n: r.exercises.length })}
                  </div>
                </div>
                {!r.seed && (
                  <button onClick={() => deleteRoutine(r.id)} style={{ color: "var(--color-faint)" }} aria-label="Delete routine">
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => startFromRoutine(r)}
                  className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                  style={{ background: "rgba(52,197,232,0.13)", color: "var(--color-accent)" }}
                >
                  <Play size={12} /> {t("Start")}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* PRs */}
      {prs.length > 0 && (
        <section className="rounded-[18px] border p-4" style={TILE}>
          <div className="mb-2.5 flex items-center gap-1.5">
            <Trophy size={14} style={{ color: "#f6c453" }} />
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>
              {t("Personal records")}
            </p>
          </div>
          <div className="flex flex-col">
            {prs.slice(0, 6).map((pr) => (
              <div key={pr.name} className="flex items-center gap-2 border-b py-2 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
                <div className="min-w-0 flex-1 truncate text-[13px] text-bone">{pr.name}</div>
                <div className="num shrink-0 text-[12.5px] font-semibold text-bone">
                  {pr.weight > 0 ? t("{w} lb × {r}", { w: r0(pr.weight), r: pr.reps }) : t("{r} reps", { r: pr.reps })}
                </div>
                {pr.e1rm > 0 && (
                  <div className="num w-[58px] shrink-0 text-right text-[11px]" style={{ color: "#f6c453" }}>
                    {t("~{n} 1RM", { n: r0(pr.e1rm) })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* history */}
      {done.length > 0 && (
        <section className="rounded-[18px] border p-4" style={TILE}>
          <button onClick={() => setShowHistory((s) => !s)} className="flex w-full items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>
              {t("History · {n}", { n: done.length })}
            </p>
            <ChevronDown size={16} style={{ color: "var(--color-faint)", transform: showHistory ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
          </button>
          {showHistory && (
            <div className="mt-2 flex flex-col">
              {done.slice(0, 12).map((w) => (
                <div key={w.id} className="flex items-center gap-2 border-b py-2 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
                  <button onClick={() => setEditId(w.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-bone">{t(w.name)}</div>
                      <div className="text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{w.date}</div>
                    </div>
                    <div className="num shrink-0 text-right text-[11px]" style={{ color: "var(--color-taupe)" }}>
                      {sessionStat(w)}
                      {workoutVolume(w) > 0 ? ` · ${r0(workoutVolume(w)).toLocaleString()} ${t("vol")}` : ""}
                    </div>
                  </button>
                  {confirmDelId === w.id ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => { deleteWorkout(w.id); setConfirmDelId(null); }}
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: "#2a1518", color: "#f0556e" }}
                      >
                        {t("Delete")}
                      </button>
                      <button onClick={() => setConfirmDelId(null)} className="px-1 text-[11px]" style={{ color: "var(--color-taupe)" }}>
                        {t("Cancel")}
                      </button>
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2">
                      <button onClick={() => setEditId(w.id)} style={{ color: "var(--color-faint)" }} aria-label="Edit workout">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setConfirmDelId(w.id)} style={{ color: "var(--color-faint)" }} aria-label="Delete workout">
                        <Trash2 size={13} />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <ExerciseSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} library={library} onPick={(ex) => addExercise(ex)} />
      <QuickLogSheet open={quickOpen} onClose={() => setQuickOpen(false)} library={library} onLog={quickLog} />
      {editingWorkout && (
        <EditWorkoutSheet
          workout={editingWorkout}
          library={library}
          onClose={() => setEditId(null)}
          onSave={(w) => { upsertWorkout(w); setEditId(null); }}
          onDelete={() => { deleteWorkout(editingWorkout.id); setEditId(null); }}
        />
      )}
    </div>
  );
}

// ── the active session ──────────────────────────────────────────────────────────
function ActiveWorkout({
  w,
  onAddExercise,
  onAddSet,
  onSetChange,
  onRemoveSet,
  onRemoveExercise,
  onFinish,
  onDiscard,
  onSaveRoutine,
}: {
  w: Workout;
  onAddExercise: () => void;
  onAddSet: (exId: string) => void;
  onSetChange: (exId: string, i: number, patch: { reps?: number; weight?: number }) => void;
  onRemoveSet: (exId: string, i: number) => void;
  onRemoveExercise: (exId: string) => void;
  onFinish: () => void;
  onDiscard: () => void;
  onSaveRoutine: () => void;
}) {
  return (
    <section className="rounded-[18px] border p-4" style={TILE}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Dumbbell size={15} style={{ color: "var(--color-accent)" }} />
          <p className="text-[13.5px] font-semibold text-bone">{t("Today's workout")}</p>
        </div>
        <button onClick={onDiscard} className="text-[11px]" style={{ color: "var(--color-faint)" }}>
          {t("Discard")}
        </button>
      </div>

      {w.exercises.length === 0 ? (
        <p className="py-3 text-center text-[12.5px]" style={{ color: "var(--color-taupe)" }}>
          {t("Add an exercise to get started.")}
        </p>
      ) : (
        w.exercises.map((ex) => (
          <ExerciseBlock
            key={ex.id}
            ex={ex}
            onAddSet={() => onAddSet(ex.id)}
            onSetChange={(i, patch) => onSetChange(ex.id, i, patch)}
            onRemoveSet={(i) => onRemoveSet(ex.id, i)}
            onRemove={() => onRemoveExercise(ex.id)}
          />
        ))
      )}

      <button
        onClick={onAddExercise}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
        style={{ background: "rgba(52,197,232,0.13)", color: "var(--color-accent)" }}
      >
        <Plus size={15} /> {t("Add exercise")}
      </button>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onSaveRoutine}
          className="rounded-[12px] px-3 py-2.5 text-[12.5px] font-semibold"
          style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}
        >
          {t("Save as routine")}
        </button>
        <button
          onClick={onFinish}
          className="flex flex-1 items-center justify-center gap-2 rounded-[12px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
        >
          <Check size={16} /> {t("Finish workout")}
        </button>
      </div>
    </section>
  );
}

function ExerciseBlock({
  ex,
  onAddSet,
  onSetChange,
  onRemoveSet,
  onRemove,
}: {
  ex: ExerciseEntry;
  onAddSet: () => void;
  onSetChange: (i: number, patch: { reps?: number; weight?: number }) => void;
  onRemoveSet: (i: number) => void;
  onRemove: () => void;
}) {
  const best = bestSet(ex.sets);
  return (
    <div className="mb-2.5 rounded-[12px] p-3" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }}>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-bone">{ex.name}</div>
          {best.e1rm > 0 && (
            <div className="num text-[10px]" style={{ color: "var(--color-taupe)" }}>
              {t("best ~{n} 1RM", { n: r0(best.e1rm) })}
            </div>
          )}
        </div>
        <button onClick={onRemove} style={{ color: "var(--color-faint)" }} aria-label="Remove exercise">
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--color-faint)" }}>
        <span className="w-6 text-center">{t("Set")}</span>
        <span className="flex-1 text-center">{t("Weight")}</span>
        <span className="flex-1 text-center">{t("Reps")}</span>
        <span className="w-5" />
      </div>
      {ex.sets.map((s, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <span className="num w-6 text-center text-[12px] font-semibold" style={{ color: "var(--color-faint)" }}>{i + 1}</span>
          <NumIn value={s.weight} onChange={(v) => onSetChange(i, { weight: v })} max={2000} suffix="lb" />
          <NumIn value={s.reps} onChange={(v) => onSetChange(i, { reps: v })} max={100} />
          <button onClick={() => onRemoveSet(i)} className="w-5 shrink-0" style={{ color: "var(--color-faint)" }} aria-label="Remove set">
            <Minus size={14} />
          </button>
        </div>
      ))}
      <button onClick={onAddSet} className="mt-1.5 flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: "var(--color-accent)" }}>
        <Plus size={12} /> {t("Add set")}
      </button>
    </div>
  );
}

// ── edit a PAST workout (history is manageable, not rigid) ──────────────────────
// A local draft of the session: rename, edit/add/remove exercises + sets, change a
// cardio duration, edit notes, or delete. Save upserts it back (stays in history);
// the week count / PRs / volume all recompute from the live list automatically.
function EditWorkoutSheet({
  workout,
  library,
  onClose,
  onSave,
  onDelete,
}: {
  workout: Workout;
  library: Exercise[];
  onClose: () => void;
  onSave: (w: Workout) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Workout>(workout);
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    setDraft(workout);
    setConfirmDel(false);
  }, [workout]);

  const upd = (exId: string, fn: (e: ExerciseEntry) => ExerciseEntry) =>
    setDraft((w) => ({ ...w, exercises: w.exercises.map((e) => (e.id === exId ? fn(e) : e)) }));
  const addSet = (exId: string) =>
    upd(exId, (e) => ({ ...e, sets: [...e.sets, e.sets.length ? { ...e.sets[e.sets.length - 1] } : { reps: 0, weight: 0 }] }));
  const setSet = (exId: string, i: number, patch: { reps?: number; weight?: number }) =>
    upd(exId, (e) => ({ ...e, sets: e.sets.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const removeSet = (exId: string, i: number) => upd(exId, (e) => ({ ...e, sets: e.sets.filter((_, j) => j !== i) }));
  const setDur = (exId: string, d: number) => upd(exId, (e) => ({ ...e, duration: d }));
  const removeExercise = (exId: string) => setDraft((w) => ({ ...w, exercises: w.exercises.filter((e) => e.id !== exId) }));
  const addExercise = (ex: { name: string; muscle: string; exerciseId: string }) =>
    setDraft((w) => ({ ...w, exercises: [...w.exercises, { id: rowId(), exerciseId: ex.exerciseId, name: ex.name, muscle: ex.muscle, sets: [{ reps: 0, weight: 0 }] }] }));

  const inpStyle = { background: "var(--color-tile)", border: "1px solid var(--color-edge)" } as const;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(0,0,0,.55)" }} onClick={onClose}>
        <div
          className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
          style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)", borderRadius: "22px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 p-4 pb-2">
            <Dumbbell size={16} style={{ color: "var(--color-accent)" }} />
            <div className="flex-1 text-[16px] font-bold text-bone">{t("Edit workout")}</div>
            <button onClick={onClose} style={{ color: "var(--color-faint)" }}>
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-2">
            <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Name")}</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft((w) => ({ ...w, name: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-[14px] text-bone outline-none"
              style={inpStyle}
            />
            <div className="mb-3 mt-1 text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{draft.date}</div>

            {draft.exercises.map((ex) =>
              ex.duration != null && ex.sets.length === 0 ? (
                <DurationBlock key={ex.id} ex={ex} onChange={(d) => setDur(ex.id, d)} onRemove={() => removeExercise(ex.id)} />
              ) : (
                <ExerciseBlock
                  key={ex.id}
                  ex={ex}
                  onAddSet={() => addSet(ex.id)}
                  onSetChange={(i, p) => setSet(ex.id, i, p)}
                  onRemoveSet={(i) => removeSet(ex.id, i)}
                  onRemove={() => removeExercise(ex.id)}
                />
              ),
            )}

            <button
              onClick={() => setSearchOpen(true)}
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
              style={{ background: "rgba(52,197,232,0.13)", color: "var(--color-accent)" }}
            >
              <Plus size={15} /> {t("Add exercise")}
            </button>

            <label className="mb-1 mt-3 block text-[10px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Notes")}</label>
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft((w) => ({ ...w, notes: e.target.value }))}
              rows={2}
              placeholder={t("optional")}
              className="w-full resize-none rounded-lg px-3 py-2 text-[13px] text-bone outline-none placeholder:text-[var(--color-faint)]"
              style={inpStyle}
            />
          </div>

          <div className="flex gap-2 p-4 pt-2">
            {confirmDel ? (
              <>
                <button onClick={() => setConfirmDel(false)} className="flex-1 rounded-[12px] py-2.5 text-[13px] font-semibold" style={{ background: "var(--color-raised)", color: "var(--color-bone)" }}>
                  {t("Cancel")}
                </button>
                <button onClick={onDelete} className="flex-1 rounded-[12px] py-2.5 text-[13px] font-semibold" style={{ background: "#f0556e", color: "var(--color-bg)" }}>
                  {t("Delete workout")}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setConfirmDel(true)} className="flex items-center justify-center rounded-[12px] px-4 py-2.5" style={{ background: "rgba(240,85,110,0.13)", color: "#f0556e" }} aria-label="Delete workout">
                  <Trash2 size={16} />
                </button>
                <button
                  onClick={() => onSave(draft)}
                  className="flex flex-1 items-center justify-center gap-2 rounded-[12px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
                  style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
                >
                  <Check size={16} /> {t("Save changes")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <ExerciseSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} library={library} onPick={addExercise} />
    </>
  );
}

function DurationBlock({ ex, onChange, onRemove }: { ex: ExerciseEntry; onChange: (d: number) => void; onRemove: () => void }) {
  return (
    <div className="mb-2.5 rounded-[12px] p-3" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }}>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="min-w-0 truncate text-[13.5px] font-medium text-bone">{ex.name}</div>
        <button onClick={onRemove} style={{ color: "var(--color-faint)" }} aria-label="Remove exercise">
          <X size={15} />
        </button>
      </div>
      <NumIn value={ex.duration ?? 0} onChange={onChange} max={600} suffix="min" />
    </div>
  );
}

// ── sticky summary ────────────────────────────────────────────────────────────
function WorkoutSummary({ name, weekCount, active }: { name: string; weekCount: number; active: Workout | null }) {
  const vol = active ? workoutVolume(active) : 0;
  const sets = active ? totalSets(active) : 0;
  return (
    <div className="rounded-[22px] px-5 py-4 text-white shadow-lg" style={{ background: "var(--color-hero)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)" }}>
      <div className="flex items-center justify-between text-[11.5px] opacity-90">
        <span>{t("{name}'s training", { name })}</span>
        <span>{t("this week")}</span>
      </div>
      <div className="mt-2 flex items-center gap-4">
        <div className="flex flex-col items-center">
          <span key={weekCount} className="pop num text-[30px] font-bold leading-none">{weekCount}</span>
          <span className="text-[9px] font-semibold uppercase tracking-wide opacity-90">{t("days")}</span>
        </div>
        <div className="min-w-0 flex-1">
          {/* week dots */}
          <div className="flex gap-1.5">
            {Array.from({ length: WEEK_GOAL }, (_, i) => (
              <span key={i} className="h-2 flex-1 rounded-full" style={{ background: i < weekCount ? "var(--color-accent)" : "rgba(255,255,255,0.16)", transition: "background .3s" }} />
            ))}
          </div>
          <div className="mt-2 text-[11.5px] opacity-90">
            {active
              ? t("In progress · {sets} sets{vol}", { sets, vol: vol > 0 ? ` · ${r0(vol).toLocaleString()} ${t("vol")}` : "" })
              : weekCount >= WEEK_GOAL
                ? t("Goal hit 🎯 — nice work")
                : t("{n} to hit your weekly goal", { n: WEEK_GOAL - weekCount })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TOGETHER — shared activity + weekly challenge ──────────────────────────────
function TogetherWorkout({ owner }: { owner: Person }) {
  const today = todayStr();
  const you = owner;
  const partner = other(owner);
  const order: Person[] = [you, partner];

  const { workouts } = useHealth();
  const all: Record<Person, Workout[]> = {
    gino: workouts.filter((w) => w.person === "gino" && w.done),
    xinyan: workouts.filter((w) => w.person === "xinyan" && w.done),
  };
  const week: Record<Person, number> = {
    gino: thisWeekCount(all.gino, today),
    xinyan: thisWeekCount(all.xinyan, today),
  };
  const combined = week.gino + week.xinyan;
  const feed = [...all.gino, ...all.xinyan]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 12);

  return (
    <div className="flex flex-col gap-3">
      {/* shared weekly challenge */}
      <div className="sticky z-30 rounded-[22px] px-5 py-4 text-white shadow-lg" style={{ top: STICKY_TOP, background: "var(--color-hero)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)" }}>
        <div className="flex items-center gap-1.5 text-[11.5px] opacity-90" style={{ color: "var(--color-accent)" }}>
          <Flame size={14} /> {t("This week · together")}
        </div>
        <div className="mt-1.5 flex items-end gap-2">
          <span key={combined} className="pop num text-[34px] font-bold leading-none">{combined}</span>
          <span className="pb-1 text-[12px] opacity-90">{t("workouts as a household")}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {order.map((p) => (
            <div key={p} className="rounded-[14px] px-3 py-2" style={{ background: "rgba(0,0,0,0.16)" }}>
              <div className="text-[11px] font-semibold" style={{ color: p === you ? "#ffe7d4" : "#cdfff5" }}>
                {p === you ? t("You") : PERSON_NAME[p]}
              </div>
              <div className="num text-[20px] font-bold">{t("{n} days", { n: week[p] })}</div>
            </div>
          ))}
        </div>
      </div>

      {/* shared activity feed */}
      <section className="rounded-[18px] border p-4" style={TILE}>
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>
          {t("Recent activity")}
        </p>
        {feed.length === 0 ? (
          <p className="py-4 text-center text-[12.5px]" style={{ color: "var(--color-taupe)" }}>
            {t("No workouts logged yet. Switch to Just me to start one.")}
          </p>
        ) : (
          <div className="flex flex-col">
            {feed.map((w) => {
              const who = w.person;
              const acc = PERSON_ACC[who];
              return (
                <div key={w.id} className="flex items-center gap-2.5 border-b py-2 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: acc + "22", color: acc }}>
                    {who === you ? "▲" : PERSON_NAME[who][0]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-bone">
                      <span style={{ color: acc }}>{who === you ? t("You") : PERSON_NAME[who]}</span> · {t(w.name)}
                    </div>
                    <div className="text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{w.date}</div>
                  </div>
                  <div className="num text-[11px]" style={{ color: "var(--color-taupe)" }}>{sessionStat(w)}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── numeric input (string-buffered + clamped, like the meal builder's) ──────────
function NumIn({ value, onChange, max, suffix }: { value: number; onChange: (n: number) => void; max: number; suffix?: string }) {
  const [buf, setBuf] = useState(value ? String(value) : "");
  useEffect(() => {
    const cur = buf === "" ? 0 : parseInt(buf, 10);
    if (cur !== value) setBuf(value ? String(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className="flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}>
      <input
        value={buf}
        inputMode="numeric"
        onChange={(e) => {
          const raw = e.target.value.replace(/\D/g, "");
          const next = raw === "" ? "" : String(Math.min(max, parseInt(raw, 10)));
          setBuf(next);
          onChange(next === "" ? 0 : parseInt(next, 10));
        }}
        placeholder="0"
        className="num w-full bg-transparent text-center text-[15px] font-semibold text-bone outline-none"
      />
      {suffix && <span className="pr-1 text-[10px]" style={{ color: "var(--color-faint)" }}>{suffix}</span>}
    </span>
  );
}

// ── exercise search sheet (search the library or add a custom exercise) ─────────
const MUSCLE_TINT: Record<string, string> = {
  chest: "#fb7185", back: "#38bdf8", legs: "#f6c453", shoulders: "#a78bfa",
  arms: "#34c5e8", core: "#22c55e", fullbody: "#fb923c", cardio: "#f0556e",
};
const muscleColor = (m: string) => MUSCLE_TINT[m] ?? "#8b97a6";
const MUSCLES = ["chest", "back", "legs", "shoulders", "arms", "core", "fullbody", "cardio"];

function ExerciseSearchSheet({ open, onClose, library, onPick }: { open: boolean; onClose: () => void; library: Exercise[]; onPick: (ex: { name: string; muscle: string; exerciseId: string }) => void }) {
  const [q, setQ] = useState("");
  const [customMuscle, setCustomMuscle] = useState<string | null>(null);
  const results = useMemo(() => searchExercises(q, library, 40), [q, library]);

  useEffect(() => {
    if (open) {
      setQ("");
      setCustomMuscle(null);
    }
  }, [open]);

  if (!open) return null;
  const add = (ex: { name: string; muscle: string; exerciseId: string }) => {
    onPick(ex);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(0,0,0,.55)" }} onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
        style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)", borderRadius: "22px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-4 pb-2">
          <div className="flex-1 text-[16px] font-bold text-bone">{t("Add exercise")}</div>
          <button onClick={onClose} style={{ color: "var(--color-faint)" }}>
            <X size={20} />
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", margin: "0 16px" }}>
          <Search size={16} style={{ color: "var(--color-faint)" }} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("Search an exercise…")}
            className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[var(--color-faint)]"
          />
          {q && (
            <button onClick={() => setQ("")} style={{ color: "var(--color-faint)" }}>
              <X size={15} />
            </button>
          )}
        </div>

        <div className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
          {results.length > 0 ? (
            results.map((e) => (
              <button
                key={e.id}
                onClick={() => add({ name: e.name, muscle: e.muscle, exerciseId: e.id })}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition active:bg-[var(--color-tile)]"
              >
                <span className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: muscleColor(e.muscle) }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-bone">{e.name}</div>
                  <div className="text-[10.5px] capitalize" style={{ color: "var(--color-taupe)" }}>{t(e.muscle)} · {t(e.equipment)}</div>
                </div>
                <Plus size={16} style={{ color: "#46d18a" }} />
              </button>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-[13px]" style={{ color: "var(--color-taupe)" }}>
              {q ? t("No match — add it as a custom exercise below.") : t("Search by name, muscle, or equipment.")}
            </p>
          )}
        </div>

        {/* custom exercise — name from the query, pick a muscle */}
        {q.trim() && (
          <div className="border-t p-3" style={{ borderColor: "var(--color-edge)" }}>
            <p className="mb-1.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
              {t('Add "{name}" as a custom exercise', { name: q.trim() })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MUSCLES.map((m) => (
                <button
                  key={m}
                  onClick={() => setCustomMuscle(m)}
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition"
                  style={customMuscle === m ? { background: muscleColor(m), color: "var(--color-bg)" } : { background: "var(--color-tile)", color: "var(--color-taupe)", border: "1px solid var(--color-edge)" }}
                >
                  {t(m)}
                </button>
              ))}
            </div>
            <button
              disabled={!customMuscle}
              onClick={() => customMuscle && add({ name: q.trim(), muscle: customMuscle, exerciseId: "" })}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.98]"
              style={{ background: "var(--color-accent)", color: "var(--h-on-accent)", opacity: customMuscle ? 1 : 0.45 }}
            >
              <Plus size={14} /> {t("Add custom exercise")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Quick log — the low-friction path: pick an activity, log time or sets ───────
const QUICK_PICKS: { name: string; muscle: string }[] = [
  { name: "Walk", muscle: "cardio" },
  { name: "Treadmill", muscle: "cardio" },
  { name: "Run", muscle: "cardio" },
  { name: "Cycling", muscle: "cardio" },
  { name: "Leg press", muscle: "legs" },
  { name: "Stretching", muscle: "fullbody" },
];

function QuickLogSheet({
  open,
  onClose,
  library,
  onLog,
}: {
  open: boolean;
  onClose: () => void;
  library: Exercise[];
  onLog: (
    a: { name: string; muscle: string; exerciseId: string },
    payload: { duration?: number; sets?: number; reps?: number; weight?: number },
  ) => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ name: string; muscle: string; exerciseId: string } | null>(null);
  const [mode, setMode] = useState<"time" | "sets">("time");
  const [mins, setMins] = useState(30);
  const [sets, setSets] = useState(3);
  const [reps, setReps] = useState(10);
  const [weight, setWeight] = useState(0);
  const results = useMemo(() => searchExercises(q, library, 24), [q, library]);

  useEffect(() => {
    if (open) {
      setQ("");
      setPicked(null);
      setMode("time");
      setMins(30);
      setSets(3);
      setReps(10);
      setWeight(0);
    }
  }, [open]);

  if (!open) return null;
  const pick = (a: { name: string; muscle: string; exerciseId: string }) => {
    setPicked(a);
    setMode(a.muscle === "cardio" ? "time" : "sets");
  };
  const log = () => {
    if (!picked) return;
    onLog(picked, mode === "time" ? { duration: mins } : { sets, reps, weight });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(0,0,0,.55)" }} onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
        style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)", borderRadius: "22px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-4 pb-2">
          <Zap size={17} style={{ color: "var(--color-accent)" }} />
          <div className="flex-1 text-[16px] font-bold text-bone">{t("Quick log")}</div>
          <button onClick={onClose} style={{ color: "var(--color-faint)" }}>
            <X size={20} />
          </button>
        </div>

        {!picked ? (
          <div className="flex-1 overflow-y-auto px-4 pb-3">
            <p className="mb-2 text-[11px]" style={{ color: "var(--color-taupe)" }}>{t("Common")}</p>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {QUICK_PICKS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => pick({ name: p.name, muscle: p.muscle, exerciseId: "" })}
                  className="rounded-full px-3 py-1.5 text-[12.5px] font-semibold"
                  style={{ background: muscleColor(p.muscle) + "1f", color: muscleColor(p.muscle) }}
                >
                  {t(p.name)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}>
              <Search size={16} style={{ color: "var(--color-faint)" }} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("or search an exercise…")}
                className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[var(--color-faint)]"
              />
            </div>
            <div className="mt-1.5">
              {results.map((e) => (
                <button
                  key={e.id}
                  onClick={() => pick({ name: e.name, muscle: e.muscle, exerciseId: e.id })}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition active:bg-[var(--color-tile)]"
                >
                  <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ background: muscleColor(e.muscle) }} />
                  <span className="flex-1 truncate text-[13.5px] text-bone">{e.name}</span>
                  <Plus size={15} style={{ color: "#46d18a" }} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-2">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[15.5px] font-bold text-bone">{picked.name}</span>
              <button onClick={() => setPicked(null)} className="text-[12px]" style={{ color: "var(--color-accent)" }}>{t("change")}</button>
            </div>

            <div className="mb-3 flex rounded-full p-1 text-[12.5px]" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}>
              {(["time", "sets"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className="flex-1 rounded-full py-1.5 font-semibold transition"
                  style={mode === m ? { background: "var(--color-accent)", color: "var(--h-on-accent)" } : { color: "var(--color-taupe)" }}
                >
                  {m === "time" ? t("Duration") : t("Sets & reps")}
                </button>
              ))}
            </div>

            {mode === "time" ? (
              <>
                <NumIn value={mins} onChange={setMins} max={600} suffix="min" />
                <div className="mt-2 flex gap-2">
                  {[15, 30, 45, 60].map((m) => (
                    <button key={m} onClick={() => setMins(m)} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}>
                      {m}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className="mb-1 block text-center text-[10px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Sets")}</span>
                  <NumIn value={sets} onChange={setSets} max={20} />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-center text-[10px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Reps")}</span>
                  <NumIn value={reps} onChange={setReps} max={100} />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-center text-[10px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Weight")}</span>
                  <NumIn value={weight} onChange={setWeight} max={2000} suffix="lb" />
                </label>
              </div>
            )}

            <button
              onClick={log}
              className="mt-4 flex items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
              style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
            >
              <Check size={16} /> {t("Log it")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
