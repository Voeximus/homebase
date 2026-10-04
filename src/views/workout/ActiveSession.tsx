import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, Timer, X } from "lucide-react";
import { RestDock } from "../../components/workout/RestDock";
import { getLang, t } from "../../lib/i18n";
import { restDefault, useRestTimer } from "../../lib/restTimer";
import { unlockAudio } from "../../lib/restAlert";
import {
  addSet,
  clearSessionStart,
  editSet,
  elapsedParts,
  finishWorkout,
  fmtWeight,
  ghostsFor,
  initSessionStart,
  readSessionStart,
  removeExercise,
  removeSet,
  replaceEntry,
  sessionCounts,
  shortDay,
  showsWeight,
  tickSet,
  toggleWarmup,
  untick,
} from "../../lib/sessionOps";
import { findExercise, isLogged, isWarmup, lastTime } from "../../lib/trainingMath";
import { useWakeLock } from "../../lib/wakeLock";
import { todayStr, type Exercise, type ExerciseEntry, type Person, type SetEntry, type Workout } from "../../lib/workoutLog";
import { ConfirmSheet, FinishSheet } from "./FinishSheet";
import { SetColumns, SetRow } from "./SetRow";

// ── The set logger (V1.md Ships §1) ──────────────────────────────────────────
// Ported from the workout lab mockup (public/_workoutlab.html, "Active · rest
// timer running"): a sticky session bar, one card per exercise with last
// time's sets in one faint line, set rows with a big tick, and the rest dock.
//
// This component owns no workout state. Every edit builds the whole updated
// workout with src/lib/sessionOps.ts and hands it to `onChange`, so the store
// (with its crash-safe phone copy) is the only place a set lives.
//
// Kept on this phone only: the session start (`hb-session-start-<id>`, for the
// elapsed time) and the running rest (useRestTimer). Both survive a reload.

const newId = () => crypto.randomUUID();
const STICKY_TOP = "calc(env(safe-area-inset-top, 0px) + 6px)";

const elapsedText = (ms: number) => {
  const { h, m } = elapsedParts(ms);
  return h > 0 ? t("{h} h {m} min", { h, m: String(m).padStart(2, "0") }) : t("{n} min", { n: m });
};
const setText = (s: SetEntry) => (s.weight > 0 ? `${fmtWeight(s.weight)}×${s.reps}` : t("{r} reps", { r: s.reps }));
const restText = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

type Confirm = null | "discard" | "nothing";
type Refused = { row: string; missing: "weight" | "reps"; n: number } | null;

export function ActiveSession({
  workout,
  person,
  library,
  workouts,
  onChange,
  onFinish,
  onDiscard,
  onOpenExercise,
  onAddExercise,
}: {
  workout: Workout;
  person: Person;
  library: Exercise[];
  workouts: Workout[];
  onChange(w: Workout): void;
  onFinish(w: Workout): void;
  onDiscard(): void;
  onOpenExercise(name: string): void;
  onAddExercise(): void;
}) {
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [finishing, setFinishing] = useState(false);
  // The refused tick: which row, which box it needs, and a counter so a second refusal shakes again.
  const [refused, setRefused] = useState<Refused>(null);
  const [restLabel, setRestLabel] = useState("");
  const restSetId = useRef<string | null>(null); // the set whose tick started the running rest
  const rest = useRestTimer(person);
  useWakeLock(!workout.done);

  // Session start: stored the first time this workout is open on this phone.
  // Written in an effect (a side effect), read during render — until the effect
  // has run, the fallback is the time this screen opened, which is the same.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    initSessionStart(workout.id, Date.now());
  }, [workout.id]);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15000); // the bar shows whole minutes
    return () => clearInterval(id);
  }, []);
  const startedAt = readSessionStart(workout.id);
  const isToday = workout.date === todayStr();
  // The bar counts from the earlier of the stored start and the first tick: the
  // start is kept per device, and a session begun on another one ticked before it.
  let since = startedAt ?? nowMs;
  for (const e of workout.exercises) for (const s of e.sets) if (typeof s.doneAt === "number" && s.doneAt < since) since = s.doneAt;

  const counts = sessionCounts(workout);
  const rowKey = (entry: ExerciseEntry, i: number) => `${entry.id}:${i}`;
  const update = (entry: ExerciseEntry) => onChange(replaceEntry(workout, entry));

  const tick = (entry: ExerciseEntry, i: number, ghosts: ReturnType<typeof ghostsFor>, ex: Exercise | undefined) => {
    // Every tick is a tap, which is the only moment a browser lets the page
    // unlock sound for the end-of-rest beep. Cheap to repeat; a phone may have
    // suspended the audio since the last one.
    unlockAudio();
    const s = entry.sets[i];
    // isLogged, not isDone: a tick whose reps were cleared logs nothing, and the
    // tap fills the reps back in (tickSet) instead of un-ticking it
    if (isLogged(s)) {
      update(untick(entry, i));
      if (s.id && restSetId.current === s.id) rest.skip(); // the rest it started goes with it
      return;
    }
    const r = tickSet(entry, i, ghosts, ex, Date.now(), newId);
    if (r.error) {
      const missing = r.error === "needs-weight" ? "weight" : "reps";
      setRefused((cur) => ({ row: rowKey(entry, i), missing, n: (cur?.n ?? 0) + 1 }));
      return;
    }
    setRefused(null);
    update(r.entry);
    const done = r.entry.sets[i];
    const sec = restDefault(ex, done);
    if (sec > 0) {
      rest.start(sec);
      setRestLabel(isWarmup(done) ? t("{name} warm-up", { name: entry.name }) : entry.name);
      restSetId.current = done.id ?? null;
    }
  };

  const tapFinish = () => {
    if (finishWorkout(workout).nothingLogged) setConfirm("nothing");
    else setFinishing(true);
  };
  const leave = () => {
    clearSessionStart(workout.id);
    rest.skip();
  };
  const save = () => {
    leave();
    setFinishing(false);
    onFinish(finishWorkout(workout).workout);
  };
  const discard = () => {
    leave();
    setConfirm(null);
    onDiscard();
  };

  return (
    <div className="flex flex-col gap-2.5">
      {/* session bar */}
      <div className="sticky z-30" style={{ top: STICKY_TOP }}>
        <div className="h-hero" style={{ padding: "10px var(--h-3)" }}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[15px] font-bold text-bone">{t(workout.name)}</div>
            <button onClick={() => setConfirm("discard")} className="h-link" style={{ minHeight: 44, padding: "0 6px" }}>
              {t("Discard")}
            </button>
            <button onClick={tapFinish} className="h-btn" style={{ width: "auto", padding: "0 16px" }}>
              <Check size={16} /> {t("Finish")}
            </button>
          </div>
          <div className="h-sub">
            {isToday ? elapsedText(nowMs - since) : shortDay(workout.date, getLang())}
            {" · "}
            <span className="num">{t("{done} / {planned} work sets", { done: counts.done, planned: counts.planned })}</span>
            {counts.warmups > 0 &&
              " · " + t(counts.warmups === 1 ? "{n} warm-up done" : "{n} warm-ups done", { n: counts.warmups })}
          </div>
        </div>
      </div>

      {workout.exercises.length === 0 ? (
        <div className="rounded-[var(--h-radius)] border border-dashed px-3 py-6 text-center text-[13px]" style={{ borderColor: "var(--color-edge)", color: "var(--color-taupe)" }}>
          {t("No exercises yet. Add your first one.")}
        </div>
      ) : (
        workout.exercises.map((entry) => (
          <ExerciseCard
            key={entry.id}
            entry={entry}
            workout={workout}
            person={person}
            library={library}
            workouts={workouts}
            refused={refused}
            rowKey={rowKey}
            onOpen={() => onOpenExercise(entry.name)}
            onRemove={() => {
              setRefused(null);
              onChange(removeExercise(workout, entry.id));
            }}
            onEntry={(next) => {
              if (refused?.row.startsWith(entry.id + ":")) setRefused(null);
              update(next);
            }}
            onTick={tick}
          />
        ))
      )}

      <button onClick={onAddExercise} className={workout.exercises.length ? "h-btn ghost" : "h-btn"}>
        <Plus size={15} /> {t("Add exercise")}
      </button>

      {/* room for the dock, so the last card can scroll clear of it */}
      {rest.endsAt !== null && <div aria-hidden="true" style={{ height: 76 }} />}
      {rest.endsAt !== null && (
        <RestDock remaining={rest.remaining} over={rest.over} label={restLabel} onAdd={rest.add} onSkip={rest.skip} />
      )}

      {finishing && (
        <FinishSheet
          workout={workout}
          person={person}
          library={library}
          workouts={workouts}
          startedAt={isToday ? startedAt : null}
          onNotes={(notes) => onChange({ ...workout, notes })}
          onSave={save}
          onBack={() => setFinishing(false)}
        />
      )}
      {confirm === "discard" && (
        <ConfirmSheet
          title={t("Discard this workout?")}
          text={t("Sets you logged will be deleted.")}
          yes={t("Discard")}
          no={t("Keep")}
          danger
          onYes={discard}
          onNo={() => setConfirm(null)}
        />
      )}
      {confirm === "nothing" && (
        <ConfirmSheet
          title={t("Nothing was logged")}
          text={t("Nothing was logged. Discard this workout?")}
          yes={t("Discard")}
          no={t("Keep")}
          danger
          onYes={discard}
          onNo={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ── one exercise ────────────────────────────────────────────────────────────────
function ExerciseCard({
  entry,
  workout,
  person,
  library,
  workouts,
  refused,
  rowKey,
  onOpen,
  onRemove,
  onEntry,
  onTick,
}: {
  entry: ExerciseEntry;
  workout: Workout;
  person: Person;
  library: Exercise[];
  workouts: Workout[];
  refused: Refused;
  rowKey(entry: ExerciseEntry, i: number): string;
  onOpen(): void;
  onRemove(): void;
  onEntry(next: ExerciseEntry): void;
  onTick(entry: ExerciseEntry, i: number, ghosts: ReturnType<typeof ghostsFor>, ex: Exercise | undefined): void;
}) {
  const ex = findExercise(library, entry.name, entry.exerciseId);
  const withWeight = showsWeight(ex);
  const last = useMemo(
    () => lastTime(workouts, person, entry.name, library, workout.id),
    [workouts, person, entry.name, library, workout.id],
  );
  const ghosts = ghostsFor(entry, last?.sets);
  const lastWorking = last?.sets.filter((s) => !isWarmup(s)) ?? [];
  const nextRest = restDefault(ex, { reps: 0, weight: 0 });

  let working = 0;
  const labels = entry.sets.map((s) => (isWarmup(s) ? "W" : String(++working)));

  return (
    <div className="rounded-[12px] border pt-2.5 pr-2.5 pb-2 pl-3" style={{ background: "var(--color-raised)", borderColor: "var(--color-edge)" }}>
      <div className="mb-1 flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <button onClick={onOpen} className="h-hit block min-h-6 max-w-full truncate text-left text-[14px] font-semibold text-bone">
            {entry.name}
          </button>
          <div className="truncate text-[13px]" style={{ color: "var(--color-taupe)" }}>
            {last && lastWorking.length > 0
              ? t("Last time ({date}): {sets}", { date: shortDay(last.date, getLang()), sets: lastWorking.map(setText).join(" · ") })
              : t("First time logging this")}
          </div>
        </div>
        <button
          onClick={onRemove}
          className="-mt-1.5 -mr-1.5 grid h-11 w-11 flex-none place-items-center rounded-[10px]"
          style={{ color: "var(--color-faint)" }}
          aria-label={t("Remove {name}", { name: entry.name })}
        >
          <X size={16} />
        </button>
      </div>

      {entry.sets.length > 0 && <SetColumns showWeight={withWeight} />}
      {entry.sets.some(isWarmup) && (
        <div className="pb-0.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
          {t("W = warm-up")}
        </div>
      )}
      {entry.sets.map((s, i) => {
        const key = rowKey(entry, i);
        const err = refused?.row === key;
        return (
          <SetRow
            key={s.id ?? `row-${i}`}
            set={s}
            label={labels[i]}
            ghost={ghosts[i]}
            showWeight={withWeight}
            done={isLogged(s)}
            missing={err ? refused.missing : null}
            shake={err ? refused.n : 0}
            onWeight={(n) => onEntry(editSet(entry, i, { weight: n }))}
            onReps={(n) => onEntry(editSet(entry, i, { reps: n }))}
            onTick={() => onTick(entry, i, ghosts, ex)}
            onToggleKind={() => onEntry(toggleWarmup(entry, i))}
          />
        );
      })}

      <div className="flex items-center gap-3">
        <button
          onClick={() => onEntry(addSet(entry, newId))}
          className="inline-flex min-h-11 items-center gap-1 px-1 text-[11.5px] font-semibold"
          style={{ color: "var(--color-accent)" }}
        >
          <Plus size={12} /> {t("Add set")}
        </button>
        {entry.sets.length > 0 && (
          <button
            onClick={() => onEntry(removeSet(entry, entry.sets.length - 1))}
            className="inline-flex min-h-11 items-center gap-1 px-1 text-[11.5px] font-semibold"
            style={{ color: "var(--color-taupe)" }}
          >
            <Minus size={12} /> {t("Remove last set")}
          </button>
        )}
        <span className="hb-tiny ml-auto inline-flex items-center gap-1 text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
          <Timer size={11} /> {nextRest > 0 ? t("Rest {time}", { time: restText(nextRest) }) : t("No rest timer")}
        </span>
      </div>
    </div>
  );
}
