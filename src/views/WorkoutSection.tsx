import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Dumbbell,
  Flame,
  Minus,
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
import { BRAND_GRADIENT } from "../lib/catColor";
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
const TILE = { background: "#141a24", borderColor: "#232d3a" } as const;
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
      <div className="flex rounded-full p-1 text-[13px]" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
        <ModePill on={mode === "solo"} onClick={() => setMode("solo")} icon={<User size={14} />}>
          {t("Just me")}
        </ModePill>
        <ModePill on={mode === "together"} onClick={() => setMode("together")} icon={<Users size={14} />}>
          {t("Together")}
        </ModePill>
      </div>

      {mode === "solo" ? (
        <SoloWorkout key={person} person={person} library={library} />
      ) : (
        <TogetherWorkout key={owner} owner={owner} />
      )}
    </div>
  );
}

function ModePill({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 font-semibold transition"
      style={on ? { background: "#34c5e8", color: "#06303a" } : { color: "#8b97a6" }}
    >
      {icon}
      {children}
    </button>
  );
}

// ── SOLO — log a session, routines, PRs, history ────────────────────────────────
function SoloWorkout({ person, library }: { person: Person; library: Exercise[] }) {
  const today = todayStr();
  const { workouts: allWorkouts, routines: allRoutines, upsertWorkout, deleteWorkout, addRoutine, deleteRoutine: storeDeleteRoutine } = useHealth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const mine = useMemo(() => allWorkouts.filter((w) => w.person === person), [allWorkouts, person]);
  const routines = useMemo(
    () => [...SEED_ROUTINES[person], ...allRoutines.filter((r) => r.person === person)],
    [allRoutines, person],
  );
  const active = mine.find((w) => !w.done) ?? null;
  const done = useMemo(() => mine.filter((w) => w.done).sort((a, b) => b.date.localeCompare(a.date)), [mine]);
  const prs = useMemo(() => personalRecords(done), [done]);
  const weekCount = thisWeekCount(done, today);

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
            style={{ background: BRAND_GRADIENT }}
          >
            <Play size={17} /> {t("Start a workout")}
          </button>
          <button
            onClick={() => setQuickOpen(true)}
            className="flex items-center justify-center gap-2 rounded-[16px] border py-3 text-[13.5px] font-semibold transition active:scale-[0.98]"
            style={{ borderColor: "#2dd1c055", background: "rgba(45,209,192,0.10)", color: "#2dd1c0" }}
          >
            <Zap size={16} /> {t("Quick log — just an activity")}
          </button>
        </>
      )}

      {/* routines */}
      {!active && (
        <section className="rounded-[18px] border p-4" style={TILE}>
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#8b97a6" }}>
            {t("Routines")}
          </p>
          <div className="flex flex-col gap-2">
            {routines.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-[12px] px-3 py-2.5" style={{ background: "#0f141c", border: "1px solid #232d3a" }}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-bone">{t(r.name)}</div>
                  <div className="truncate text-[10.5px]" style={{ color: "#7e8a98" }}>
                    {r.meta ? t(r.meta) + " · " : ""}
                    {t("{n} exercises", { n: r.exercises.length })}
                  </div>
                </div>
                {!r.seed && (
                  <button onClick={() => deleteRoutine(r.id)} style={{ color: "#6b7686" }} aria-label="Delete routine">
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => startFromRoutine(r)}
                  className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                  style={{ background: "rgba(52,197,232,0.13)", color: "#34c5e8" }}
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
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#8b97a6" }}>
              {t("Personal records")}
            </p>
          </div>
          <div className="flex flex-col">
            {prs.slice(0, 6).map((pr) => (
              <div key={pr.name} className="flex items-center gap-2 border-b py-2 last:border-0" style={{ borderColor: "#1b232e" }}>
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
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#8b97a6" }}>
              {t("History · {n}", { n: done.length })}
            </p>
            <ChevronDown size={16} style={{ color: "#6b7686", transform: showHistory ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
          </button>
          {showHistory && (
            <div className="mt-2 flex flex-col">
              {done.slice(0, 12).map((w) => (
                <div key={w.id} className="flex items-center gap-2 border-b py-2 last:border-0" style={{ borderColor: "#1b232e" }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-bone">{t(w.name)}</div>
                    <div className="text-[10.5px]" style={{ color: "#7e8a98" }}>{w.date}</div>
                  </div>
                  <div className="num shrink-0 text-right text-[11px]" style={{ color: "#9aa6b2" }}>
                    {sessionStat(w)}
                    {workoutVolume(w) > 0 ? ` · ${r0(workoutVolume(w)).toLocaleString()} ${t("vol")}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <ExerciseSearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} library={library} onPick={(ex) => addExercise(ex)} />
      <QuickLogSheet open={quickOpen} onClose={() => setQuickOpen(false)} library={library} onLog={quickLog} />
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
          <Dumbbell size={15} style={{ color: "#34c5e8" }} />
          <p className="text-[13.5px] font-semibold text-bone">{t("Today's workout")}</p>
        </div>
        <button onClick={onDiscard} className="text-[11px]" style={{ color: "#6b7686" }}>
          {t("Discard")}
        </button>
      </div>

      {w.exercises.length === 0 ? (
        <p className="py-3 text-center text-[12.5px]" style={{ color: "#7e8a98" }}>
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
        style={{ background: "rgba(52,197,232,0.13)", color: "#34c5e8" }}
      >
        <Plus size={15} /> {t("Add exercise")}
      </button>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onSaveRoutine}
          className="rounded-[12px] px-3 py-2.5 text-[12.5px] font-semibold"
          style={{ background: "#0f141c", border: "1px solid #232d3a", color: "#9aa6b2" }}
        >
          {t("Save as routine")}
        </button>
        <button
          onClick={onFinish}
          className="flex flex-1 items-center justify-center gap-2 rounded-[12px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: BRAND_GRADIENT }}
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
    <div className="mb-2.5 rounded-[12px] p-3" style={{ background: "#0f141c", border: "1px solid #232d3a" }}>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-bone">{ex.name}</div>
          {best.e1rm > 0 && (
            <div className="num text-[10px]" style={{ color: "#7e8a98" }}>
              {t("best ~{n} 1RM", { n: r0(best.e1rm) })}
            </div>
          )}
        </div>
        <button onClick={onRemove} style={{ color: "#6b7686" }} aria-label="Remove exercise">
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "#5f6a78" }}>
        <span className="w-6 text-center">{t("Set")}</span>
        <span className="flex-1 text-center">{t("Weight")}</span>
        <span className="flex-1 text-center">{t("Reps")}</span>
        <span className="w-5" />
      </div>
      {ex.sets.map((s, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <span className="num w-6 text-center text-[12px] font-semibold" style={{ color: "#6b7686" }}>{i + 1}</span>
          <NumIn value={s.weight} onChange={(v) => onSetChange(i, { weight: v })} max={2000} suffix="lb" />
          <NumIn value={s.reps} onChange={(v) => onSetChange(i, { reps: v })} max={100} />
          <button onClick={() => onRemoveSet(i)} className="w-5 shrink-0" style={{ color: "#5f6a78" }} aria-label="Remove set">
            <Minus size={14} />
          </button>
        </div>
      ))}
      <button onClick={onAddSet} className="mt-1.5 flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: "#34c5e8" }}>
        <Plus size={12} /> {t("Add set")}
      </button>
    </div>
  );
}

// ── sticky summary ────────────────────────────────────────────────────────────
function WorkoutSummary({ name, weekCount, active }: { name: string; weekCount: number; active: Workout | null }) {
  const vol = active ? workoutVolume(active) : 0;
  const sets = active ? totalSets(active) : 0;
  return (
    <div className="rounded-[22px] px-5 py-4 text-white shadow-lg" style={{ background: BRAND_GRADIENT }}>
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
              <span key={i} className="h-2 flex-1 rounded-full" style={{ background: i < weekCount ? "#ffffff" : "rgba(255,255,255,0.28)", transition: "background .3s" }} />
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
      <div className="sticky z-30 rounded-[22px] px-5 py-4 text-white shadow-lg" style={{ top: STICKY_TOP, background: BRAND_GRADIENT }}>
        <div className="flex items-center gap-1.5 text-[11.5px] opacity-90">
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
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#8b97a6" }}>
          {t("Recent activity")}
        </p>
        {feed.length === 0 ? (
          <p className="py-4 text-center text-[12.5px]" style={{ color: "#7e8a98" }}>
            {t("No workouts logged yet. Switch to Just me to start one.")}
          </p>
        ) : (
          <div className="flex flex-col">
            {feed.map((w) => {
              const who = w.person;
              const acc = PERSON_ACC[who];
              return (
                <div key={w.id} className="flex items-center gap-2.5 border-b py-2 last:border-0" style={{ borderColor: "#1b232e" }}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: acc + "22", color: acc }}>
                    {who === you ? "▲" : PERSON_NAME[who][0]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-bone">
                      <span style={{ color: acc }}>{who === you ? t("You") : PERSON_NAME[who]}</span> · {t(w.name)}
                    </div>
                    <div className="text-[10.5px]" style={{ color: "#7e8a98" }}>{w.date}</div>
                  </div>
                  <div className="num text-[11px]" style={{ color: "#9aa6b2" }}>{sessionStat(w)}</div>
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
    <span className="flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
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
      {suffix && <span className="pr-1 text-[10px]" style={{ color: "#5f6a78" }}>{suffix}</span>}
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
        style={{ background: "#0f141c", border: "1px solid #232d3a", borderTop: "2px solid #34c5e8", borderRadius: "22px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-4 pb-2">
          <div className="flex-1 text-[16px] font-bold text-bone">{t("Add exercise")}</div>
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "#141a24", border: "1px solid #232d3a", margin: "0 16px" }}>
          <Search size={16} style={{ color: "#6b7686" }} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("Search an exercise…")}
            className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[#5f6a78]"
          />
          {q && (
            <button onClick={() => setQ("")} style={{ color: "#6b7686" }}>
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
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition active:bg-[#141a24]"
              >
                <span className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: muscleColor(e.muscle) }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-bone">{e.name}</div>
                  <div className="text-[10.5px] capitalize" style={{ color: "#7e8a98" }}>{t(e.muscle)} · {t(e.equipment)}</div>
                </div>
                <Plus size={16} style={{ color: "#46d18a" }} />
              </button>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-[13px]" style={{ color: "#7e8a98" }}>
              {q ? t("No match — add it as a custom exercise below.") : t("Search by name, muscle, or equipment.")}
            </p>
          )}
        </div>

        {/* custom exercise — name from the query, pick a muscle */}
        {q.trim() && (
          <div className="border-t p-3" style={{ borderColor: "#1b232e" }}>
            <p className="mb-1.5 text-[11px]" style={{ color: "#7e8a98" }}>
              {t('Add "{name}" as a custom exercise', { name: q.trim() })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MUSCLES.map((m) => (
                <button
                  key={m}
                  onClick={() => setCustomMuscle(m)}
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition"
                  style={customMuscle === m ? { background: muscleColor(m), color: "#0a0d12" } : { background: "#141a24", color: "#8b97a6", border: "1px solid #232d3a" }}
                >
                  {t(m)}
                </button>
              ))}
            </div>
            <button
              disabled={!customMuscle}
              onClick={() => customMuscle && add({ name: q.trim(), muscle: customMuscle, exerciseId: "" })}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.98]"
              style={{ background: BRAND_GRADIENT, opacity: customMuscle ? 1 : 0.45 }}
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
        style={{ background: "#0f141c", border: "1px solid #232d3a", borderTop: "2px solid #2dd1c0", borderRadius: "22px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-4 pb-2">
          <Zap size={17} style={{ color: "#2dd1c0" }} />
          <div className="flex-1 text-[16px] font-bold text-bone">{t("Quick log")}</div>
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        {!picked ? (
          <div className="flex-1 overflow-y-auto px-4 pb-3">
            <p className="mb-2 text-[11px]" style={{ color: "#97a3b2" }}>{t("Common")}</p>
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
            <div className="flex items-center gap-2 rounded-xl px-3" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
              <Search size={16} style={{ color: "#6b7686" }} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("or search an exercise…")}
                className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[#5f6a78]"
              />
            </div>
            <div className="mt-1.5">
              {results.map((e) => (
                <button
                  key={e.id}
                  onClick={() => pick({ name: e.name, muscle: e.muscle, exerciseId: e.id })}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition active:bg-[#141a24]"
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
              <button onClick={() => setPicked(null)} className="text-[12px]" style={{ color: "#34c5e8" }}>{t("change")}</button>
            </div>

            <div className="mb-3 flex rounded-full p-1 text-[12.5px]" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
              {(["time", "sets"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className="flex-1 rounded-full py-1.5 font-semibold transition"
                  style={mode === m ? { background: "#34c5e8", color: "#06303a" } : { color: "#8b97a6" }}
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
                    <button key={m} onClick={() => setMins(m)} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#9aa6b2" }}>
                      {m}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className="mb-1 block text-center text-[10px] uppercase tracking-wider" style={{ color: "#7c8696" }}>{t("Sets")}</span>
                  <NumIn value={sets} onChange={setSets} max={20} />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-center text-[10px] uppercase tracking-wider" style={{ color: "#7c8696" }}>{t("Reps")}</span>
                  <NumIn value={reps} onChange={setReps} max={100} />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-center text-[10px] uppercase tracking-wider" style={{ color: "#7c8696" }}>{t("Weight")}</span>
                  <NumIn value={weight} onChange={setWeight} max={2000} suffix="lb" />
                </label>
              </div>
            )}

            <button
              onClick={log}
              className="mt-4 flex items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
              style={{ background: BRAND_GRADIENT }}
            >
              <Check size={16} /> {t("Log it")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
