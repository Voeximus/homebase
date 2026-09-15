import { useMemo } from "react";
import { ChevronLeft, History, User } from "lucide-react";
import { BodyMap } from "../../components/workout/BodyMap";
import { t } from "../../lib/i18n";
import { findExercise, repRecords } from "../../lib/trainingMath";
import type { Exercise, Person, Workout } from "../../lib/workoutLog";
import { StudyNotes } from "./StudyNotes";
import { REP_COLUMNS, dayLabel, fmtWeight, regionName, regionsOf, sessionsWith, setsText } from "./viewHelpers";

// ── The exercise page ─────────────────────────────────────────────────────────
// Ported from the lab mockup's detail screen ("Barbell back squat"). Three blocks,
// top to bottom: which muscles it uses (a picture, then the same thing in words),
// what studies found, and your own numbers.
//
// An exercise the person typed in themselves is not in the library, so there is
// no muscle map, and study notes show the fixed no-notes line (V1.md §2) — then
// their numbers, which come from their logs and need neither.

const EDGE = { borderColor: "var(--color-edge)" } as const;

export function ExerciseDetail({
  name,
  person,
  library,
  workouts,
  onBack,
}: {
  name: string;
  person: Person;
  library: Exercise[];
  workouts: Workout[];
  onBack(): void;
}) {
  const ex = useMemo(() => findExercise(library, name), [library, name]);
  // The library is a lazy import; until it lands, an empty list is "not loaded", not "not found".
  const loading = library.length === 0;
  const { primary, secondary } = regionsOf(ex);

  return (
    <div className="flex flex-col gap-3">
      <div className="-mb-1 -ml-2.5 -mt-1">
        <button
          onClick={onBack}
          className="inline-flex min-h-[44px] items-center gap-0.5 px-2.5 text-[13px] font-semibold"
          style={{ color: "var(--color-taupe)" }}
        >
          <ChevronLeft size={18} /> {t("Back")}
        </button>
      </div>

      <div>
        <h1 className="h-stat" style={{ lineHeight: 1.2 }}>{ex?.name ?? name}</h1>
        {ex && <div className="h-sub capitalize" style={{ fontSize: 12.5, marginTop: 2 }}>{t(ex.equipment)}</div>}
      </div>

      {!loading && !ex && (
        <section className="h-panel">
          <p className="text-[13px] leading-normal text-bone">{t("You added this exercise, so there is no muscle map for it.")}</p>
        </section>
      )}

      {ex && primary.length + secondary.length > 0 && (
        <section className="h-panel">
          <div className="h-cardhead">
            <span className="ic"><User size={14} /></span>
            <div className="t" style={{ flex: 1 }}>{t("Muscles used")}</div>
          </div>
          <BodyMap primary={primary} secondary={secondary} />
          <p className="mt-2 text-[12.5px] text-bone">
            <b className="font-[650]">{t("Main:")}</b> {primary.length ? primary.map(regionName).join(", ") : t("none")}
            {secondary.length > 0 && (
              <>
                {" · "}
                <b className="font-[650]">{t("Helps:")}</b> {secondary.map(regionName).join(", ")}
              </>
            )}
          </p>
        </section>
      )}

      {!loading && <StudyNotes exercise={ex} hasMuscles={!!ex && primary.length + secondary.length > 0} />}

      <YourNumbers name={ex?.name ?? name} person={person} library={library} workouts={workouts} />
    </div>
  );
}

// ── your numbers: rep records and the last 3 sessions ──────────────────────────
function YourNumbers({
  name,
  person,
  library,
  workouts,
}: {
  name: string;
  person: Person;
  library: Exercise[];
  workouts: Workout[];
}) {
  const records = useMemo(() => repRecords(workouts, person, name, library), [workouts, person, name, library]);
  const sessions = useMemo(() => sessionsWith(workouts, person, name, library, 3), [workouts, person, name, library]);
  const anyRecord = REP_COLUMNS.some((r) => records[r] !== null);

  return (
    <section className="h-panel">
      <div className="h-cardhead">
        <span className="ic"><History size={14} /></span>
        <div className="t" style={{ flex: 1 }}>{t("Your numbers")}</div>
      </div>

      {sessions.length === 0 ? (
        <p className="h-sub">{t("You haven't logged this yet.")}</p>
      ) : (
        <>
          {anyRecord && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      {REP_COLUMNS.map((r) => (
                        <th
                          key={r}
                          scope="col"
                          className="px-0.5 py-1 text-center text-[9.5px] font-semibold uppercase tracking-[.05em]"
                          style={{ color: "var(--color-faint)" }}
                        >
                          {t(r === 1 ? "{n} rep" : "{n} reps", { n: r })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {REP_COLUMNS.map((r) => {
                        const w = records[r];
                        return (
                          <td
                            key={r}
                            className={`num border-t py-1.5 text-center ${w !== null ? "font-semibold text-bone" : "font-normal"}`}
                            style={w !== null ? EDGE : { ...EDGE, color: "var(--color-faint)" }}
                          >
                            {w !== null ? fmtWeight(w) : "–"}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="hb-tiny" style={{ marginTop: 4 }}>{t("Heaviest weight (lb) for at least that many reps.")}</p>
            </>
          )}

          <p className="h-eyebrow" style={{ marginTop: anyRecord ? 12 : 0 }}>
            {t(sessions.length === 1 ? "Last session" : "Last {n} sessions", { n: sessions.length })}
          </p>
          {sessions.map((s) => (
            <div key={s.workoutId} className="flex min-h-[44px] items-center gap-2 border-b py-2 last:border-b-0" style={EDGE}>
              <span className="min-w-0 flex-1">
                <span className="block text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
                  {dayLabel(s.date)} · {t(s.workoutName)}
                </span>
                <span className="num block text-[13px] text-bone">
                  {s.working.length
                    ? setsText(s.working)
                    : s.minutes
                      ? t("{n} min", { n: s.minutes })
                      : t("Warm-ups only")}
                </span>
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
