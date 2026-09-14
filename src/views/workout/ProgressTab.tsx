import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import { hardSetsByRegion, recentRecords } from "../../lib/trainingMath";
import { todayStr, type Exercise, type Person, type Workout } from "../../lib/workoutLog";
import { TICKS, dayLabel, fmtSets, fmtWeight, progressRows, regionName } from "./viewHelpers";

// ── The Progress tab ──────────────────────────────────────────────────────────
// Ported from the lab mockup's "Progress · Gino" screen, cut to v1: hard sets per
// muscle for the last 7 days, then recent records. No heatmap, no period switch,
// no estimated-max chart.
//
// Each row is a count, a bar and the band the count falls in. The bar shares one
// scale across rows (the top value, never under 20) so rows compare by length,
// and the marks at 4, 10 and 18 sit where the bands change — context, not goals.
// Muscles with no sets are hidden until asked for, so the list starts with what
// was actually trained.

const EDGE = { borderColor: "var(--color-edge)" } as const;

export function ProgressTab({
  person,
  workouts,
  library,
  onOpenExercise,
}: {
  person: Person;
  workouts: Workout[];
  library: Exercise[];
  onOpenExercise(name: string): void;
}) {
  const today = todayStr();
  const [showAll, setShowAll] = useState(false);
  const hard = useMemo(() => hardSetsByRegion(workouts, library, person, today, 7), [workouts, library, person, today]);
  const { rows, hidden, scale } = progressRows(hard.byRegion, showAll);
  const records = useMemo(() => recentRecords(workouts, person, library, 8), [workouts, person, library]);
  const pct = (v: number) => Math.min(100, (v / scale) * 100);

  return (
    <div className="flex flex-col gap-3">
      <section className="h-panel">
        <p className="h-eyebrow">{t("Hard sets per muscle · last 7 days")}</p>
        <p className="h-sub" style={{ marginTop: 2 }}>
          {t("A hard set is a ticked working set, not a warm-up. A muscle that only helps gets half a set.")}
        </p>

        {rows.length > 0 && (
          <div className="relative mt-1.5 h-3 text-[9px]" style={{ color: "var(--color-faint)" }} aria-hidden="true">
            {TICKS.map((tk) => (
              <span key={tk} className="absolute -translate-x-1/2" style={{ left: `${pct(tk)}%` }}>
                {tk}
              </span>
            ))}
          </div>
        )}

        {rows.length === 0 ? (
          <p
            className="mt-2 rounded-[var(--h-radius)] px-3 py-6 text-center text-[13px]"
            style={{ border: "1px dashed var(--color-edge)", color: "var(--color-taupe)" }}
          >
            {t("No hard sets in the last 7 days.")}
          </p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="border-b py-[9px] last:border-b-0" style={EDGE} data-region={r.id}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-[13px] text-bone">{regionName(r.id)}</span>
                <span className="num text-[14px] font-bold text-bone">{fmtSets(r.value)}</span>
              </div>
              <div
                className="relative mb-1 mt-1.5 h-2 rounded-full"
                style={{ background: "var(--color-well)", boxShadow: "inset 0 0 0 1px var(--color-edge)" }}
                aria-hidden="true"
              >
                <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${r.pct}%`, background: "var(--color-bone)" }} />
                {TICKS.map((tk) => (
                  <span
                    key={tk}
                    className="absolute -bottom-[3px] -top-[3px]"
                    style={
                      r.value >= tk
                        ? {
                            left: `${pct(tk)}%`,
                            width: 2,
                            // cut through the filled bar, so a passed mark still shows
                            background:
                              "linear-gradient(to bottom, var(--color-taupe) 0 3px, var(--color-bg) 3px calc(100% - 3px), var(--color-taupe) calc(100% - 3px))",
                          }
                        : { left: `${pct(tk)}%`, width: 1.5, background: "var(--color-taupe)" }
                    }
                  />
                ))}
              </div>
              <div className="hb-tiny">{t(r.band)}</div>
            </div>
          ))
        )}

        {(hidden > 0 || showAll) && (
          <button className="h-btn quiet" style={{ marginTop: "var(--h-2)" }} onClick={() => setShowAll((s) => !s)}>
            {showAll ? t("Hide muscles with no sets") : t("Show all muscles")}
          </button>
        )}

        {rows.length > 0 && (
          <p className="hb-tiny" style={{ marginTop: 8 }}>
            {t("The marks at 4, 10 and 18 are where the bands in the studies change. They are not targets.")}
          </p>
        )}
        {hard.unplaced > 0 && (
          <p className="h-sub" style={{ marginTop: 6 }}>
            {t("Sets with no muscle detail: {n}", { n: fmtSets(hard.unplaced) })}
          </p>
        )}
      </section>

      <section className="h-panel">
        <p className="h-eyebrow" style={{ marginBottom: 2 }}>{t("Recent records")}</p>
        {records.length === 0 ? (
          <p className="h-sub" style={{ marginTop: 4 }}>{t("No records yet.")}</p>
        ) : (
          records.map((rec, i) => (
            <button
              key={`${rec.name}-${rec.date}-${i}`}
              onClick={() => onOpenExercise(rec.name)}
              className="flex min-h-[44px] w-full items-center gap-2 border-b py-2 text-left last:border-b-0"
              style={EDGE}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-bone">{rec.name}</span>
                <span className="num block text-[12px]" style={{ color: "var(--color-taupe)" }}>
                  {t("{w} lb × {r}", { w: fmtWeight(rec.weight), r: rec.reps })}
                </span>
              </span>
              <span className="num flex-none text-right text-[11px]" style={{ color: "var(--color-taupe)" }}>
                {dayLabel(rec.date)}
              </span>
              <ChevronRight size={14} style={{ color: "var(--color-faint)", flex: "none" }} />
            </button>
          ))
        )}
      </section>
    </div>
  );
}
