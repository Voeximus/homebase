import { useMemo, useState } from "react";
import { Check, ChevronDown, Trash2, X } from "lucide-react";
import { t } from "../lib/i18n";
import { todayStr } from "../lib/mealLog";
import { useHealth } from "../store/HealthStore";
import { currentWeekAvg, latestWeight, ratePerWeek } from "../lib/weightLog";

// ── Weight & trend — fully automatic calibration ─────────────────────────────
// You log ONE number a day. The app computes the weekly average, the lb/week
// trend (least-squares, so daily noise doesn't matter), and the verdict — no
// "weeks on plan", no manual calibration. The scale is the measurement.

export type Person = "gino" | "xinyan";
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

type GaugeCfg = {
  start: number;
  goal?: number;
  min: number;
  max: number;
  bandLo: number;
  bandHi: number;
  unit: string;
  signed: boolean;
  verdict: (r: number) => [string, boolean];
};

const GAUGE: Record<Person, GaugeCfg> = {
  gino: {
    start: 143, min: -0.25, max: 1.0, bandLo: 0.25, bandHi: 0.5, unit: "lb / week", signed: true,
    verdict: (r) =>
      r < 0 ? [t("Dropping — you're under maintenance. Add ~250 kcal."), false]
      : r < 0.05 ? [t("Flat — add ~200 kcal/day to get moving."), false]
      : r < 0.25 ? [t("A touch slow — nudge +150–200 kcal."), false]
      : r <= 0.5 ? [t("On track. Hold everything."), true]
      : r <= 0.75 ? [t("Upper edge — fine, just watch the mirror."), true]
      : [t("Gaining too fast — trim ~150 kcal to keep it muscle."), false],
  },
  xinyan: {
    start: 149, goal: 118, min: 0, max: 2.0, bandLo: 0.5, bandHi: 1.0, unit: "lb / week loss", signed: false,
    verdict: (r) =>
      r < 0 ? [t("Up this week — tighten portions, cut ~100 kcal."), false]
      : r < 0.25 ? [t("Stalled — add steps first, then trim ~100 kcal."), false]
      : r < 0.5 ? [t("A bit slow — add steps, hold calories a week."), false]
      : r <= 1.0 ? [t("On track. Hold."), true]
      : r <= 1.25 ? [t("Brisk but okay — keep protein high."), true]
      : [t("Too fast — add ~150 kcal to protect muscle."), false],
  },
};

export function CalibrationGauge({ person, acc }: { person: Person; acc: string }) {
  const cfg = GAUGE[person];
  const { weights, setWeight, deleteWeight, clearWeights } = useHealth();
  const today = todayStr();
  const mine = useMemo(
    () => weights.filter((w) => w.person === person).sort((a, b) => a.date.localeCompare(b.date)),
    [weights, person],
  );
  const todayEntry = mine.find((w) => w.date === today);
  const [draft, setDraft] = useState("");
  const [showHist, setShowHist] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null); // date pending delete
  const [confirmReset, setConfirmReset] = useState(false);
  // newest-first for the history list
  const history = useMemo(() => [...mine].reverse(), [mine]);
  const fmtHist = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const weekInfo = currentWeekAvg(mine, today);
  const cur = weekInfo ? weekInfo.avg : latestWeight(mine);
  const raw = ratePerWeek(mine); // lb/week, negative = losing
  const valid = raw != null && mine.length >= 2;
  const r = raw == null ? 0 : person === "gino" ? raw : -raw; // signed for THIS person's goal
  const [verdictText, verdictOn] = valid
    ? cfg.verdict(r)
    : [t("Log your weight a few days and your trend appears here — automatically."), false];
  const shown = valid ? (cfg.signed && r >= 0 ? "+" : "") + r.toFixed(2) : "—";

  const pctOf = (v: number) => clamp(((v - cfg.min) / (cfg.max - cfg.min)) * 100, 0, 100);
  const lo = pctOf(cfg.bandLo);
  const hi = pctOf(cfg.bandHi);

  const last = latestWeight(mine);
  const toGo = cfg.goal && last != null ? Math.max(0, last - cfg.goal) : null;
  const donePct = cfg.goal && last != null ? clamp(((cfg.start - last) / (cfg.start - cfg.goal)) * 100, 0, 100) : 0;

  const save = () => {
    const v = parseFloat(draft);
    if (!v || v <= 0 || v > 1000) return;
    setWeight(person, today, Math.round(v * 10) / 10);
    setDraft("");
  };

  return (
    <section className="rounded-[18px] border p-4" style={{ background: "#0f141c", borderColor: "#232d3a" }}>
      <p className="stat-key" style={{ color: acc }}>{t("Weight & trend")}</p>
      <p className="mt-1 h-title text-[15px] text-bone">
        {person === "gino" ? t("Are you gaining at the right rate?") : t("Are you losing at the right rate?")}
      </p>
      <p className="mb-3.5 mt-0.5 text-[11.5px]" style={{ color: "#97a3b2" }}>
        {t("Log your weight daily — the rest is automatic.")}
      </p>

      {/* daily weigh-in */}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1 rounded-lg px-3 py-2.5" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && save()}
            inputMode="decimal"
            placeholder={todayEntry ? String(todayEntry.weight) : t("today's weight")}
            className="num w-full bg-transparent text-[16px] font-semibold text-bone outline-none placeholder:text-[#5f6a78] placeholder:font-normal"
          />
          <span className="text-[11px]" style={{ color: "#5f6a78" }}>{t("lb")}</span>
        </div>
        <button
          onClick={save}
          className="rounded-lg px-4 py-2.5 text-[13px] font-semibold"
          style={{ background: acc, color: "#0a0d12" }}
        >
          {todayEntry ? t("Update") : t("Log")}
        </button>
      </div>
      {todayEntry && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px]" style={{ color: "#46d18a" }}>
          <Check size={13} /> {t("Logged today: {w} lb", { w: todayEntry.weight })}
        </p>
      )}

      {/* weekly average + trend */}
      <div className="mt-4 flex items-end gap-5">
        <div>
          <div className="stat-key" style={{ color: "#97a3b2" }}>{t("This week's avg")}</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="stat text-[26px] text-bone">{cur != null ? cur.toFixed(1) : "—"}</span>
            <span className="text-[12px] font-semibold" style={{ color: "#7c8696" }}>{t("lb")}</span>
          </div>
          {weekInfo && (
            <div className="text-[10.5px]" style={{ color: "#7c8696" }}>{t("{n}-day average", { n: weekInfo.count })}</div>
          )}
        </div>
        <div className="flex-1">
          <div className="stat-key" style={{ color: "#97a3b2" }}>{t("Trend")}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="stat text-[26px]" style={{ color: verdictOn ? "#46d18a" : valid ? acc : "#7c8696" }}>{shown}</span>
            <span className="text-[11px]" style={{ color: "#7c8696" }}>{t(cfg.unit)}</span>
          </div>
        </div>
      </div>

      {/* the band */}
      <div className="relative my-3 h-[40px]">
        <div className="absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full" style={{ background: "#222b38" }} />
        <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full" style={{ left: `${lo}%`, width: `${hi - lo}%`, background: acc, opacity: 0.5 }} />
        <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2" style={{ left: `${lo}%`, background: acc }} />
        <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2" style={{ left: `${hi}%`, background: acc }} />
        {valid && (
          <div
            className="absolute top-1/2 h-7 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white"
            style={{ left: `${pctOf(r)}%`, boxShadow: "0 0 0 4px rgba(0,0,0,.35)", transition: "left .5s cubic-bezier(.2,.7,.2,1)" }}
          />
        )}
      </div>
      <div className="flex justify-between text-[10px]" style={{ color: "#7c8696" }}>
        <span>{t("too slow")}</span>
        <span style={{ color: acc }}>{t("target band")}</span>
        <span>{t("too fast")}</span>
      </div>

      <p className="mt-3 text-[13.5px] leading-snug" style={{ color: verdictOn ? "#fff" : "#97a3b2" }}>
        {verdictText}
      </p>

      {cfg.goal != null && last != null && (
        <div className="mt-3.5 border-t pt-3 text-[11.5px]" style={{ borderColor: "#1b232e", color: "#97a3b2" }}>
          <span>
            {t("Progress to {goal}:", { goal: cfg.goal })}{" "}
            <b className="text-bone">
              {toGo! <= 0
                ? t("Goal reached 🎉")
                : t("{remaining} lb to go · {pct}% there", { remaining: toGo!.toFixed(1), pct: Math.round(donePct) })}
            </b>
          </span>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "#222b38" }}>
            <div className="h-full rounded-full" style={{ width: `${donePct}%`, background: acc, transition: "width .5s ease" }} />
          </div>
        </div>
      )}

      {/* weigh-in history — delete one, or reset the lot */}
      {mine.length > 0 && (
        <div className="mt-3.5 border-t pt-3" style={{ borderColor: "#1b232e" }}>
          <button onClick={() => setShowHist((s) => !s)} className="flex w-full items-center justify-between">
            <span className="stat-key" style={{ color: "#97a3b2" }}>{t("History · {n}", { n: mine.length })}</span>
            <ChevronDown size={15} style={{ color: "#6b7686", transform: showHist ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
          </button>
          {showHist && (
            <div className="mt-2 flex flex-col">
              {history.map((w) => (
                <div key={w.date} className="flex items-center gap-2 border-b py-1.5 last:border-0" style={{ borderColor: "#161d27" }}>
                  <span className="flex-1 text-[12px]" style={{ color: "#9aa6b2" }}>
                    {fmtHist(w.date)}
                    {w.date === today && <span style={{ color: acc }}> · {t("today")}</span>}
                  </span>
                  <span className="num text-[12.5px] font-semibold text-bone">{w.weight} {t("lb")}</span>
                  {confirmDel === w.date ? (
                    <span className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          deleteWeight(person, w.date);
                          setConfirmDel(null);
                        }}
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: "#2a1518", color: "#f0556e" }}
                      >
                        {t("Delete")}
                      </button>
                      <button onClick={() => setConfirmDel(null)} className="px-1 text-[11px]" style={{ color: "#7c8696" }}>
                        {t("Cancel")}
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmDel(w.date)} style={{ color: "#5f6a78" }} aria-label="Delete weigh-in">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => setConfirmReset(true)}
                className="mt-2.5 flex items-center justify-center gap-1.5 rounded-lg py-2 text-[12px] font-medium"
                style={{ background: "#161c26", color: "#8b97a6" }}
              >
                <Trash2 size={13} /> {t("Reset weight history")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* reset confirmation */}
      {confirmReset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,.6)" }}
          onClick={() => setConfirmReset(false)}
        >
          <div
            className="w-full max-w-[340px] rounded-[20px] p-5"
            style={{ background: "#0f141c", border: "1px solid #232d3a" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: "#2a1518", color: "#f0556e" }}>
                <Trash2 size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14.5px] font-bold text-bone">{t("Reset weight history?")}</p>
                <p className="mt-1 text-[12px]" style={{ color: "#97a3b2" }}>
                  {t("Deletes all {n} weigh-ins. Your trend and averages reset. This can't be undone.", { n: mine.length })}
                </p>
              </div>
              <button onClick={() => setConfirmReset(false)} style={{ color: "#6b7686" }}>
                <X size={18} />
              </button>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setConfirmReset(false)}
                className="flex-1 rounded-xl py-2.5 text-[13px] font-semibold"
                style={{ background: "#161c26", color: "#b7c0cc" }}
              >
                {t("Cancel")}
              </button>
              <button
                onClick={() => {
                  clearWeights(person);
                  setConfirmReset(false);
                  setShowHist(false);
                }}
                className="flex-1 rounded-xl py-2.5 text-[13px] font-semibold"
                style={{ background: "#f0556e", color: "#0a0d12" }}
              >
                {t("Delete all")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
