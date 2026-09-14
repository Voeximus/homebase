import { useMemo, type ReactNode } from "react";
import { Check, ChevronLeft, Info, Trophy, X } from "lucide-react";
import { getLang, t } from "../../lib/i18n";
import { REGIONS, type RegionId } from "../../lib/muscleRegions";
import { finishSummary, finishWorkout, fmtWeight, sessionRecords } from "../../lib/sessionOps";
import { hardSetsByRegion } from "../../lib/trainingMath";
import type { Exercise, Person, Workout } from "../../lib/workoutLog";

// The finish summary and the confirm sheet, ported from the workout lab mockup
// (public/_workoutlab.html, `finishSheet` and the "confirm" sheet) in the app's
// existing centred-sheet style (the same shell as the add-exercise sheet).
//
// The summary reads the session as Finish will save it (finishWorkout), so the
// numbers here are exactly the numbers that land in history.

const OVERLAY = { background: "rgba(0,0,0,.55)" } as const;
const PANEL = {
  background: "var(--color-raised)",
  border: "1px solid var(--color-edge)",
  borderTop: "2px solid var(--color-accent)",
  borderRadius: "22px",
} as const;
const SECLABEL = "text-[11px] font-semibold tracking-[0.05em] uppercase";

function Sheet({
  title,
  icon,
  onClose,
  children,
  foot,
}: {
  title: string;
  icon: ReactNode;
  onClose(): void;
  children: ReactNode;
  foot: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={OVERLAY} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
        style={PANEL}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 pt-3 pr-2 pb-1.5 pl-4">
          <span className="flex-none" style={{ color: "var(--color-accent)" }}>{icon}</span>
          <div className="min-w-0 flex-1 text-[16px] font-bold text-bone">{title}</div>
          <button onClick={onClose} className="grid h-11 w-11 flex-none place-items-center" style={{ color: "var(--color-faint)" }} aria-label={t("Close")}>
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-2">{children}</div>
        <div className="flex gap-2 px-4 pt-2 pb-4">{foot}</div>
      </div>
    </div>
  );
}

/** A yes/no question. `danger` paints the yes button in the warning colour. */
export function ConfirmSheet({
  title,
  text,
  yes,
  no,
  danger,
  onYes,
  onNo,
}: {
  title: string;
  text: string;
  yes: string;
  no: string;
  danger?: boolean;
  onYes(): void;
  onNo(): void;
}) {
  return (
    <Sheet
      title={title}
      icon={<Info size={17} />}
      onClose={onNo}
      foot={
        <>
          <button onClick={onNo} className="h-btn quiet" style={{ flex: 1 }}>
            {no}
          </button>
          <button
            onClick={onYes}
            className="h-btn"
            style={danger ? { flex: 1, background: "var(--h-over)", color: "var(--color-bg)" } : { flex: 1 }}
          >
            {yes}
          </button>
        </>
      }
    >
      <p className="text-[13.5px]" style={{ color: "var(--color-bone)" }}>
        {text}
      </p>
    </Sheet>
  );
}

const plural = (n: number, one: string, many: string) => t(n === 1 ? one : many, { n });
const setsNum = (n: number) => String(Math.round(n * 10) / 10);
const regionName = (id: RegionId) => {
  const r = REGIONS.find((x) => x.id === id);
  return r ? (getLang() === "zh" ? r.zh : r.en) : id;
};

export function FinishSheet({
  workout,
  person,
  library,
  workouts,
  startedAt,
  onNotes,
  onSave,
  onBack,
}: {
  workout: Workout; // the session as it is now, before the drop
  person: Person;
  library: Exercise[];
  workouts: Workout[];
  startedAt: number | null;
  onNotes(notes: string): void;
  onSave(): void;
  onBack(): void;
}) {
  const sum = finishSummary(workout, startedAt);
  const finished = useMemo(() => finishWorkout(workout).workout, [workout]);
  const records = useMemo(() => sessionRecords(workouts, finished, person, library), [workouts, finished, person, library]);
  const topMuscles = useMemo(() => {
    const { byRegion } = hardSetsByRegion([finished], library, person, finished.date, 1);
    return REGIONS.map((r) => r.id)
      .filter((id) => (byRegion[id] ?? 0) > 0)
      .sort((a, b) => (byRegion[b] ?? 0) - (byRegion[a] ?? 0))
      .slice(0, 6)
      .map((id) => ({ id, n: byRegion[id] ?? 0 }));
  }, [finished, library, person]);

  const line = [
    sum.minutes !== null ? t("{n} min", { n: sum.minutes }) : "",
    plural(sum.sets, "{n} set", "{n} sets") + (sum.warmups ? " + " + plural(sum.warmups, "{n} warm-up", "{n} warm-ups") : ""),
    plural(sum.exercises, "{n} exercise", "{n} exercises"),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Sheet
      title={t("Finish workout")}
      icon={<Check size={17} />}
      onClose={onBack}
      foot={
        <div className="flex w-full flex-col gap-1">
          <button onClick={onSave} className="h-btn">
            <Check size={16} /> {t("Save workout")}
          </button>
          <button onClick={onBack} className="h-link" style={{ justifyContent: "center", minHeight: 44 }}>
            {t("Back to workout")}
          </button>
        </div>
      }
    >
      {(sum.empty > 0 || sum.unticked > 0) && (
        <section className="h-panel mb-3" style={{ borderColor: "var(--h-hl)", padding: "10px 12px" }}>
          {sum.empty > 0 && (
            <p className="text-[13px] font-semibold text-bone">
              {plural(sum.empty, "{n} empty set will be removed.", "{n} empty sets will be removed.")}
            </p>
          )}
          {sum.unticked > 0 && (
            <p className="h-sub" style={{ marginTop: 2 }}>
              {plural(
                sum.unticked,
                "{n} set has numbers but no tick. It is kept, but not counted.",
                "{n} sets have numbers but no tick. They are kept, but not counted.",
              )}
            </p>
          )}
          <button onClick={onBack} className="h-link on" style={{ minHeight: 44 }}>
            <ChevronLeft size={13} /> {t("Back to workout")}
          </button>
        </section>
      )}

      <p className="num text-[13.5px] font-bold text-bone">{line}</p>

      <p className={`${SECLABEL} mt-3.5 mb-1 flex items-center gap-1`} style={{ color: "var(--color-taupe)" }}>
        <Trophy size={12} /> {t("Records this session")}
      </p>
      {records.length > 0 ? (
        records.map((r, i) => (
          <div key={`${r.name}-${r.weight}-${r.reps}-${i}`} className="flex items-center gap-2 border-b py-2 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
            <span className="min-w-0 flex-1 truncate text-[13px] text-bone">{r.name}</span>
            <span className="num shrink-0 text-[12.5px] font-semibold text-bone">
              {t("{w} lb × {r}", { w: fmtWeight(r.weight), r: r.reps })}
            </span>
            <span className="shrink-0 rounded-md px-1.5 text-[10px] font-bold" style={{ background: "var(--color-bone)", color: "var(--color-bg)" }}>
              {t("Record")}
            </span>
          </div>
        ))
      ) : (
        <p className="h-sub">{t("No records this time.")}</p>
      )}

      <p className={`${SECLABEL} mt-3 mb-1`} style={{ color: "var(--color-taupe)" }}>
        {t("Hard sets by muscle")}
      </p>
      <p className="text-[13px] text-bone">
        {topMuscles.length > 0
          ? topMuscles.map((m, i) => (
              <span key={m.id}>
                {i > 0 && " · "}
                {regionName(m.id)} <b className="num">{setsNum(m.n)}</b>
              </span>
            ))
          : t("None yet.")}
      </p>

      <label htmlFor="hb-finish-note" className="mt-3 mb-1 block text-[10px] tracking-wider uppercase" style={{ color: "var(--color-taupe)" }}>
        {t("Session note")}
      </label>
      <textarea
        id="hb-finish-note"
        value={workout.notes}
        onChange={(e) => onNotes(e.target.value)}
        rows={2}
        placeholder={t("How did it feel?")}
        className="w-full resize-none rounded-lg px-3 py-2 text-[13px] text-bone outline-none placeholder:text-[var(--color-faint)]"
        style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}
      />
    </Sheet>
  );
}
