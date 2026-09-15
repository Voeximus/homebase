import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  Dumbbell,
  Flame,
  Minus,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Trophy,
  X,
  Zap,
} from "lucide-react";
import { getLang, t, tc } from "../lib/i18n";
import { REST_IDLE, saveRest } from "../lib/restTimer";
import { clearSessionStart, copyLastSet, discardTarget, newSet, shortDay } from "../lib/sessionOps";
import { isDone } from "../lib/trainingMath";
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
  type Exercise,
  type ExerciseEntry,
  type Person,
  type Routine,
  type SetEntry,
  type Workout,
} from "../lib/workoutLog";
import { useHealth } from "../store/HealthStore";
import { ActiveSession } from "./workout/ActiveSession";
import { ExerciseDetail } from "./workout/ExerciseDetail";
import { ExercisesTab } from "./workout/ExercisesTab";
import { ConfirmSheet } from "./workout/FinishSheet";
import { ProgressTab } from "./workout/ProgressTab";

const newId = () => crypto.randomUUID();
// A fresh empty working set — see newSet for why it carries no `done: false`.
const emptySet = (): SetEntry => newSet(newId);
// "30 min" for a time-based quick log, else "N sets"
const sessionStat = (w: Workout) =>
  workoutDuration(w) > 0 && totalSets(w) === 0
    ? t("{n} min", { n: workoutDuration(w) })
    : t("{n} sets", { n: totalSets(w) });

// See the note on PERSON_ACC in MealBuilder: person identity is carried by the
// NAME, not by a brand hue. The orange and teal that used to live here sat on
// top of the fat legend and the accent respectively.
const PERSON_ACC = (you: boolean) => (you ? "var(--color-accent)" : "var(--color-taupe)");
const PERSON_NAME: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };
const STICKY_TOP = "calc(env(safe-area-inset-top, 0px) + 6px)";
const r0 = (n: number) => Math.round(n);
const other = (p: Person): Person => (p === "gino" ? "xinyan" : "gino");
const WEEK_GOAL = 4; // a friendly weekly target the ring fills toward

// ── the views inside Workouts ─────────────────────────────────────────────────
// Today · Progress · Exercises · Together (V1.md Ships §5). The pick is kept on
// the phone. The old two-way "Just me / Together" switch saved "together" under
// hb-workout-mode; that still opens Together the first time.
type View = "today" | "progress" | "exercises" | "together";
const VIEWS: { id: View; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "progress", label: "Progress" },
  { id: "exercises", label: "Exercises" },
  { id: "together", label: "Together" },
];
const VIEW_KEY = "hb-workout-view";

function loadView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (VIEWS.some((v) => v.id === saved)) return saved as View;
    return localStorage.getItem("hb-workout-mode") === "together" ? "together" : "today";
  } catch {
    return "today"; // storage blocked: start on Today every time
  }
}

/**
 * Which unfinished session is the one being logged, and which is left over.
 *
 * Running = the session opened on this screen (started here, or "Finish it" on
 * an old one), else an unfinished one dated today. Its date is not re-checked
 * once it is open, so a workout that runs past midnight stays on screen.
 * Stale = the newest unfinished session from an earlier day, shown as a banner
 * instead of pretending to be today's workout — only while nothing is running,
 * so there is never more than one session open at a time.
 */
function pickSessions(workouts: Workout[], person: Person, today: string, openId: string | null) {
  const open = workouts.filter((w) => w.person === person && !w.done);
  const running = open.find((w) => w.id === openId) ?? open.find((w) => w.date >= today) ?? null;
  const stale = running
    ? null
    : open.filter((w) => w.date < today).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  return { running, stale };
}

// ── entry point ────────────────────────────────────────────────────────────────
export function WorkoutSection({ owner, person }: { owner: Person; person: Person }) {
  const [view, setView] = useState<View>(loadView);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* storage blocked — the view just isn't remembered */
    }
  }, [view]);

  const [library, setLibrary] = useState<Exercise[]>([]);
  useEffect(() => {
    let on = true;
    import("../lib/exerciseData").then((m) => on && setLibrary(m.BUNDLED_EXERCISES)).catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  const { workouts } = useHealth();
  // The session opened on this screen, per person (a different phone owner is a different screen).
  const [opened, setOpened] = useState<{ person: Person; id: string } | null>(null);
  const openId = opened?.person === person ? opened.id : null;
  const today = todayStr();
  const { running, stale } = useMemo(() => pickSessions(workouts, person, today, openId), [workouts, person, today, openId]);

  // The exercise page sits over whichever view opened it. That view stays
  // mounted underneath (hidden), so Back lands on the same search, the same
  // expanded list and the same scroll position.
  const [detail, setDetail] = useState<{ name: string; scrollY: number } | null>(null);
  const openExercise = (name: string) => {
    setDetail({ name, scrollY: window.scrollY });
    requestAnimationFrame(() => window.scrollTo(0, 0));
  };
  const back = () => {
    const y = detail?.scrollY ?? 0;
    setDetail(null);
    requestAnimationFrame(() => window.scrollTo(0, y));
  };
  const go = (v: View) => {
    setDetail(null);
    setView(v);
    requestAnimationFrame(() => window.scrollTo(0, 0));
  };
  const resume = () => (view === "today" && detail ? back() : go("today"));

  const nav = (
    <div className="h-seg" role="tablist" aria-label={t("Workout views")} style={{ display: "flex", width: "100%" }}>
      {VIEWS.map((v) => (
        <button
          key={v.id}
          role="tab"
          aria-selected={view === v.id}
          className={view === v.id ? "on" : ""}
          style={{ flex: 1, padding: "0 4px" }}
          onClick={() => go(v.id)}
        >
          {tc(v.label, "workouts")}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-3 pb-8">
      {running && (view !== "today" || detail) && (
        <div
          className="flex min-h-11 items-center gap-2 rounded-[12px] pl-3 pr-1.5 text-[12.5px]"
          style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}
        >
          <span className="min-w-0 flex-1 truncate">
            {t("Workout in progress")}
            {running.date !== today && (
              <>
                {" · "}
                <b className="font-semibold text-bone">{shortDay(running.date, getLang())}</b>
              </>
            )}
          </span>
          <button onClick={resume} className="h-btn" style={{ width: "auto", minHeight: 36, padding: "0 12px", fontSize: 12.5 }}>
            <Play size={13} /> {t("Resume")}
          </button>
        </div>
      )}

      {detail && (
        <ExerciseDetail name={detail.name} person={person} library={library} workouts={workouts} onBack={back} />
      )}

      {/* Today stays mounted on every view, so a running rest keeps counting and
          still beeps at zero while Progress or an exercise page is open. */}
      <div hidden={!!detail || view !== "today"} className="flex flex-col gap-3">
        <SoloWorkout
          key={person}
          person={person}
          library={library}
          running={running}
          stale={stale}
          nav={nav}
          onOpenSession={(id) => {
            setOpened({ person, id });
            requestAnimationFrame(() => window.scrollTo(0, 0));
          }}
          onCloseSession={() => setOpened(null)}
          onOpenExercise={openExercise}
        />
      </div>

      {view === "progress" && (
        <div hidden={!!detail} className="flex flex-col gap-3">
          {nav}
          <ProgressTab person={person} workouts={workouts} library={library} onOpenExercise={openExercise} />
        </div>
      )}
      {view === "exercises" && (
        <div hidden={!!detail} className="flex flex-col gap-3">
          {nav}
          <ExercisesTab library={library} onOpen={openExercise} />
        </div>
      )}
      {view === "together" && (
        <div hidden={!!detail} className="flex flex-col gap-3">
          {nav}
          <TogetherWorkout key={owner} owner={owner} />
        </div>
      )}
    </div>
  );
}

// ── TODAY — log a session, routines, PRs, history ───────────────────────────────
function SoloWorkout({
  person,
  library,
  running: active,
  stale,
  nav,
  onOpenSession,
  onCloseSession,
  onOpenExercise,
}: {
  person: Person;
  library: Exercise[];
  running: Workout | null;
  stale: Workout | null;
  nav: ReactNode;
  onOpenSession: (id: string) => void;
  onCloseSession: () => void;
  onOpenExercise: (name: string) => void;
}) {
  const today = todayStr();
  const {
    loading,
    workouts: allWorkouts,
    routines: allRoutines,
    upsertWorkout,
    deleteWorkout,
    addRoutine,
    deleteRoutine: storeDeleteRoutine,
  } = useHealth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  // the id of the unfinished session the Discard confirm was opened for
  const [confirmStale, setConfirmStale] = useState<string | null>(null);

  const mine = useMemo(() => allWorkouts.filter((w) => w.person === person), [allWorkouts, person]);
  const routines = useMemo(
    () => [...SEED_ROUTINES[person], ...allRoutines.filter((r) => r.person === person)],
    [allRoutines, person],
  );
  const done = useMemo(() => mine.filter((w) => w.done).sort((a, b) => b.date.localeCompare(a.date)), [mine]);
  const prs = useMemo(() => personalRecords(done, library), [done, library]);
  const weekCount = thisWeekCount(done, today);
  // a past workout opened for editing (history is fully manageable, not rigid)
  const editingWorkout = useMemo(() => done.find((w) => w.id === editId) ?? null, [done, editId]);

  // Starting waits for the first load: until it lands, an unfinished session
  // already on the server is invisible, and a second one would be started beside it.
  const canStart = !active && !loading;
  const start = (w: Workout) => {
    if (!canStart) return;
    // The rest is kept per person, not per session: one left over from a session
    // that was abandoned or discarded from the banner must not greet a new one.
    saveRest(person, REST_IDLE);
    upsertWorkout(w);
    onOpenSession(w.id);
  };
  const startBlank = () => start({ id: newId(), date: today, person, name: t("Workout"), notes: "", exercises: [], done: false });
  const startFromRoutine = (r: Routine) =>
    start({
      id: newId(),
      date: today,
      person,
      name: r.name,
      notes: "",
      exercises: r.exercises.map((re) => ({
        id: rowId(),
        exerciseId: "",
        name: re.name,
        muscle: re.muscle,
        sets: Array.from({ length: Math.max(1, re.sets) }, emptySet),
      })),
      done: false,
    });
  const addExercise = (ex: { name: string; muscle: string; exerciseId: string }) => {
    if (!active) return;
    upsertWorkout({
      ...active,
      exercises: [...active.exercises, { id: rowId(), exerciseId: ex.exerciseId, name: ex.name, muscle: ex.muscle, sets: [emptySet()] }],
    });
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
  // The session the confirm named, not whichever is stale now (discardTarget).
  // Gone or finished meanwhile → the confirm closes with nothing to delete.
  const staleToDiscard = discardTarget(mine, confirmStale);
  const discardStale = () => {
    if (staleToDiscard) {
      clearSessionStart(staleToDiscard.id);
      saveRest(person, REST_IDLE);
      deleteWorkout(staleToDiscard.id);
    }
    setConfirmStale(null);
  };
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
      {active ? (
        <>
          {/* The logger brings its own sticky session bar, so the week hero steps
              aside while a session is open instead of stacking two sticky headers. */}
          <ActiveSession
            key={active.id}
            workout={active}
            person={person}
            library={library}
            workouts={allWorkouts}
            onChange={upsertWorkout}
            onFinish={(w) => {
              upsertWorkout(w);
              onCloseSession();
            }}
            onDiscard={() => {
              deleteWorkout(active.id);
              onCloseSession();
            }}
            onOpenExercise={onOpenExercise}
            onAddExercise={() => setSearchOpen(true)}
          />
          {active.exercises.length > 0 && (
            <button onClick={saveAsRoutine} className="h-link" style={{ justifyContent: "center", width: "100%" }}>
              {t("Save as routine")}
            </button>
          )}
          {nav}
        </>
      ) : (
        <>
          {nav}

          {stale && (
            <section className="h-panel" style={{ borderColor: "var(--h-hl)" }}>
              <p className="h-eyebrow">
                <Clock size={13} /> {t("Unfinished workout from {date}", { date: shortDay(stale.date, getLang()) })}
              </p>
              <p className="text-[13.5px] font-semibold text-bone" style={{ marginTop: 4 }}>{t(stale.name)}</p>
              <p className="h-sub">
                {(() => {
                  const n = stale.exercises.reduce((k, e) => k + e.sets.filter(isDone).length, 0);
                  return t(n === 1 ? "{n} set ticked, never finished" : "{n} sets ticked, never finished", { n });
                })()}
              </p>
              <div className="flex gap-2" style={{ marginTop: "var(--h-2)" }}>
                <button onClick={() => onOpenSession(stale.id)} className="h-btn" style={{ flex: 1 }}>
                  {t("Finish it")}
                </button>
                <button onClick={() => setConfirmStale(stale.id)} className="h-btn quiet" style={{ width: "auto", padding: "0 16px" }}>
                  {t("Discard")}
                </button>
              </div>
            </section>
          )}

          {/* sticky summary — this week */}
          <div className="sticky z-30" style={{ top: STICKY_TOP }}>
            <WorkoutSummary name={PERSON_NAME[person]} weekCount={weekCount} />
          </div>

          {/* ONE primary. The second button was a tinted-accent slab of the same
              width directly under the first, which makes two primaries and no
              answer to "what do I press?". Starting a session is the main act;
              logging a walk afterwards is the aside, so it now reads as one. */}
          <button
            onClick={startBlank}
            disabled={!canStart}
            className="h-btn"
            style={{ minHeight: 52, fontSize: 15, opacity: canStart ? 1 : 0.5 }}
          >
            <Play size={17} /> {t("Start a workout")}
          </button>
          <button onClick={() => setQuickOpen(true)} className="h-link" style={{ justifyContent: "center", width: "100%" }}>
            <Zap size={14} /> {t("Or just log an activity")}
          </button>

          {/* routines */}
          <section className="h-panel">
            <p className="h-eyebrow" style={{ marginBottom: "var(--h-2)" }}>{t("Routines")}</p>
            <div className="flex flex-col gap-2">
              {/* The whole row starts the routine, so the accent is spent once on
                  the real primary above instead of four times on identical Start
                  pills that out-shouted the names you are actually reading. */}
              {routines.map((r) => (
                <div key={r.id} className="flex items-center gap-1">
                  <button
                    onClick={() => startFromRoutine(r)}
                    disabled={!canStart}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-[12px] px-3 text-left"
                    style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", minHeight: 52, opacity: canStart ? 1 : 0.5 }}
                  >
                    <Play size={14} style={{ color: "var(--color-accent)", flex: "none" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold" style={{ color: "var(--color-bone)" }}>{t(r.name)}</span>
                      <span className="block truncate text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
                        {r.meta ? t(r.meta) + " · " : ""}
                        {t(r.exercises.length === 1 ? "{n} exercise" : "{n} exercises", { n: r.exercises.length })}
                      </span>
                    </span>
                  </button>
                  {!r.seed && (
                    <button
                      onClick={() => deleteRoutine(r.id)}
                      className="grid h-11 w-10 place-items-center rounded-[10px]"
                      style={{ color: "var(--color-faint)" }}
                      aria-label={t("Delete routine")}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* PRs */}
      {prs.length > 0 && (
        <section className="h-panel">
          <div className="mb-2.5 flex items-center gap-1.5">
            <Trophy size={14} style={{ color: "var(--color-faint)" }} />
            <p className="h-eyebrow">{t("Personal records")}</p>
          </div>
          <div className="flex flex-col">
            {prs.slice(0, 6).map((pr) => (
              <div key={pr.name} className="flex items-center gap-2 border-b py-2 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
                <div className="min-w-0 flex-1 truncate text-[13px] text-bone">{pr.name}</div>
                <div className="num shrink-0 text-[12.5px] font-semibold text-bone">
                  {pr.weight > 0 ? t("{w} lb × {r}", { w: r0(pr.weight), r: pr.reps }) : t("{r} reps", { r: pr.reps })}
                </div>
                {pr.e1rm > 0 && (
                  <div className="num w-[58px] shrink-0 text-right text-[11px]" style={{ color: "var(--color-taupe)" }}>
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
        <section className="h-panel">
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
                    {/* No "vol" here any more: it added pounds × reps to bare reps (V1.md §5). */}
                    <div className="num shrink-0 text-right text-[11px]" style={{ color: "var(--color-taupe)" }}>
                      {sessionStat(w)}
                    </div>
                  </button>
                  {confirmDelId === w.id ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => { deleteWorkout(w.id); setConfirmDelId(null); }}
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: "color-mix(in srgb, var(--h-over) 14%, transparent)", color: "var(--h-over)" }}
                      >
                        {t("Delete")}
                      </button>
                      <button onClick={() => setConfirmDelId(null)} className="px-1 text-[11px]" style={{ color: "var(--color-taupe)" }}>
                        {t("Cancel")}
                      </button>
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-2">
                      <button onClick={() => setEditId(w.id)} style={{ color: "var(--color-faint)" }} aria-label={t("Edit workout")}>
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setConfirmDelId(w.id)} style={{ color: "var(--color-faint)" }} aria-label={t("Delete workout")}>
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
      {staleToDiscard && (
        <ConfirmSheet
          title={t("Discard this workout?")}
          text={t("{name} from {date}. Sets you logged will be deleted.", { name: t(staleToDiscard.name), date: shortDay(staleToDiscard.date, getLang()) })}
          yes={t("Discard")}
          no={t("Keep")}
          danger
          onYes={discardStale}
          onNo={() => setConfirmStale(null)}
        />
      )}
    </div>
  );
}

// ── one exercise in the edit sheet (the logger has its own, ActiveSession) ──────
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
        <button onClick={onRemove} className="h-hit" style={{ color: "var(--color-faint)" }} aria-label="Remove exercise">
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--color-faint)" }}>
        <span className="w-6 text-center">{tc("Set", "gym")}</span>
        <span className="flex-1 text-center">{t("Weight")}</span>
        <span className="flex-1 text-center">{t("Reps")}</span>
        <span className="w-5" />
      </div>
      {ex.sets.map((s, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <span className="num w-6 text-center text-[12px] font-semibold" style={{ color: "var(--color-faint)" }}>{i + 1}</span>
          <NumIn value={s.weight} onChange={(v) => onSetChange(i, { weight: v })} max={2000} suffix="lb" />
          <NumIn value={s.reps} onChange={(v) => onSetChange(i, { reps: v })} max={100} />
          <button onClick={() => onRemoveSet(i)} className="h-hit w-5 shrink-0" style={{ color: "var(--color-faint)" }} aria-label="Remove set">
            <Minus size={14} />
          </button>
        </div>
      ))}
      <button onClick={onAddSet} className="h-hit mt-1.5 flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: "var(--color-accent)" }}>
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
  // A different workout opened → start its draft over (adjusted during render,
  // so there is never a frame showing the previous workout's draft).
  const [draftOf, setDraftOf] = useState(workout);
  if (draftOf !== workout) {
    setDraftOf(workout);
    setDraft(workout);
    setConfirmDel(false);
  }

  const upd = (exId: string, fn: (e: ExerciseEntry) => ExerciseEntry) =>
    setDraft((w) => ({ ...w, exercises: w.exercises.map((e) => (e.id === exId ? fn(e) : e)) }));
  // the last row's numbers only — never its id, tick or warm-up mark (copyLastSet)
  const addSet = (exId: string) => upd(exId, (e) => copyLastSet(e, newId));
  const setSet = (exId: string, i: number, patch: { reps?: number; weight?: number }) =>
    upd(exId, (e) => ({ ...e, sets: e.sets.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const removeSet = (exId: string, i: number) => upd(exId, (e) => ({ ...e, sets: e.sets.filter((_, j) => j !== i) }));
  const setDur = (exId: string, d: number) => upd(exId, (e) => ({ ...e, duration: d }));
  const removeExercise = (exId: string) => setDraft((w) => ({ ...w, exercises: w.exercises.filter((e) => e.id !== exId) }));
  const addExercise = (ex: { name: string; muscle: string; exerciseId: string }) =>
    setDraft((w) => ({ ...w, exercises: [...w.exercises, { id: rowId(), exerciseId: ex.exerciseId, name: ex.name, muscle: ex.muscle, sets: [emptySet()] }] }));

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
                <button onClick={onDelete} className="flex-1 rounded-[12px] py-2.5 text-[13px] font-semibold" style={{ background: "var(--h-over)", color: "var(--color-bg)" }}>
                  {t("Delete workout")}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setConfirmDel(true)} className="flex items-center justify-center rounded-[12px] px-4 py-2.5" style={{ background: "color-mix(in srgb, var(--h-over) 14%, transparent)", color: "var(--h-over)" }} aria-label="Delete workout">
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
        <button onClick={onRemove} className="h-hit" style={{ color: "var(--color-faint)" }} aria-label="Remove exercise">
          <X size={15} />
        </button>
      </div>
      <NumIn value={ex.duration ?? 0} onChange={onChange} max={600} suffix="min" />
    </div>
  );
}

// ── sticky summary ────────────────────────────────────────────────────────────
function WorkoutSummary({ name, weekCount }: { name: string; weekCount: number }) {
  // Same grammar as the meal day's hero, so the two halves of Health read as one
  // app: eyebrow, one big number, one supporting line, progress underneath.
  //
  // The old card stacked a 30px "0" over a 9px "DAYS" and put the week bars to
  // its RIGHT on the same baseline as a sentence — three unrelated things in one
  // row, with the bars running off the edge at 375px.
  //
  // It is only shown while no session is open; the logger's own bar takes its
  // place (and the "vol" number it used to show there is gone, V1.md §5).
  const left = Math.max(0, WEEK_GOAL - weekCount);
  return (
    <div className="h-hero">
      <div className="h-herorow">
        <div className="min-w-0">
          <div className="h-eyebrow">{t("{name}'s training", { name })}</div>
          <div key={weekCount} className="h-display pop" style={{ marginTop: 4 }}>
            {weekCount}
          </div>
          <div className="h-sub" style={{ marginTop: 6 }}>
            {t("of {n} days this week", { n: WEEK_GOAL })}
          </div>
        </div>
      </div>
      {/* The week as a row of equal slots — a progress meter, not a sentence. */}
      <div className="h-week" style={{ gridTemplateColumns: `repeat(${WEEK_GOAL}, 1fr)` }}>
        {Array.from({ length: WEEK_GOAL }, (_, i) => (
          <span key={i} className={`d${i < weekCount ? " on" : ""}`} style={{ height: 8 }} />
        ))}
      </div>
      <div className="h-sub" style={{ marginTop: "var(--h-2)" }}>
        {weekCount >= WEEK_GOAL ? t("Goal hit — nice work") : t("{n} more to hit your goal", { n: left })}
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
      <section className="h-panel">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>
          {t("Recent activity")}
        </p>
        {feed.length === 0 ? (
          <p className="py-4 text-center text-[12.5px]" style={{ color: "var(--color-taupe)" }}>
            {t("No workouts logged yet. Start one from Today.")}
          </p>
        ) : (
          <div className="flex flex-col">
            {feed.map((w) => {
              const who = w.person;
              const acc = PERSON_ACC(who === you);
              return (
                <div key={w.id} className="flex items-center gap-2.5 border-b py-2 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: "var(--color-raised)", color: acc, boxShadow: "inset 0 0 0 1px var(--color-edge)" }}>
                    {PERSON_NAME[who][0]}
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
  // The value changed from outside (not by typing here) → show it.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    const cur = buf === "" ? 0 : parseInt(buf, 10);
    if (cur !== value) setBuf(value ? String(value) : "");
  }
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
// Muscle groups no longer carry a hue, and this is the one place in the rebuild
// where a palette was DELETED rather than corrected.
//
// It was eight colors — and its first three were literally the old macro legend,
// so "chest" was the same color as "protein", "back" the same as "carbs" and
// "legs" the same as "fat", on screens one tap apart inside the same mode.
//
// It could not be fixed by re-stepping either. A list is an all-pairs form: any
// two rows can sit side by side, and no eight-hue set clears the separation
// floors under all 28 pairs. More than three series in a form like that means
// fewer series or facets, not a better palette.
//
// And it was never carrying information. Every row already SAYS "Chest · Barbell"
// underneath the name — the bar was a second, worse copy of a label that was
// right there. So the bar is a neutral rule now, doing the one job it was
// actually good at, which is giving the row a left edge to align on.
const MUSCLE_RULE = "var(--color-edge)";
const MUSCLES = ["chest", "back", "legs", "shoulders", "arms", "core", "fullbody", "cardio"];

function ExerciseSearchSheet({ open, onClose, library, onPick }: { open: boolean; onClose: () => void; library: Exercise[]; onPick: (ex: { name: string; muscle: string; exerciseId: string }) => void }) {
  const [q, setQ] = useState("");
  const [customMuscle, setCustomMuscle] = useState<string | null>(null);
  const results = useMemo(() => searchExercises(q, library, 40), [q, library]);

  // Each opening starts empty (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQ("");
      setCustomMuscle(null);
    }
  }

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
                <span className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: MUSCLE_RULE }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-bone">{e.name}</div>
                  <div className="text-[10.5px] capitalize" style={{ color: "var(--color-taupe)" }}>{t(e.muscle)} · {t(e.equipment)}</div>
                </div>
                <Plus size={16} style={{ color: "var(--color-accent)" }} />
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
                  style={customMuscle === m ? { background: "var(--color-accent)", color: "var(--h-on-accent)" } : { background: "var(--color-tile)", color: "var(--color-taupe)", border: "1px solid var(--color-edge)" }}
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

  // Each opening starts from the defaults (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQ("");
      setPicked(null);
      setMode("time");
      setMins(30);
      setSets(3);
      setReps(10);
      setWeight(0);
    }
  }

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
                  style={{ background: "var(--color-raised)", color: "var(--color-taupe)", boxShadow: "inset 0 0 0 1px var(--color-edge)" }}
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
                  <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ background: MUSCLE_RULE }} />
                  <span className="flex-1 truncate text-[13.5px] text-bone">{e.name}</span>
                  <Plus size={15} style={{ color: "var(--color-accent)" }} />
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
