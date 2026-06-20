import { useEffect, useState } from "react";
import { t } from "../lib/i18n";

// ── The signature calibration instrument ─────────────────────────────────────
// "Are you moving at the right rate?" — enter your 7-day-average weight + weeks
// on plan, read the trend against a target band, get one verdict. The macro
// targets are a guess; the weekly scale is the measurement. Lives at the bottom
// of the Meal Builder now (it calibrates the macro budget, so it belongs here).

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
  rate: (cur: number, wk: number) => number;
  verdict: (r: number) => [string, boolean];
};

const GAUGE: Record<Person, GaugeCfg> = {
  gino: {
    start: 143, min: -0.25, max: 1.0, bandLo: 0.25, bandHi: 0.5,
    unit: "lb / week", signed: true,
    rate: (cur, wk) => (cur - 143) / wk,
    verdict: (r) =>
      r < 0 ? [t("Dropping — you're under maintenance. Add ~250 kcal."), false]
      : r < 0.05 ? [t("Flat — add ~200 kcal/day to get moving."), false]
      : r < 0.25 ? [t("A touch slow — nudge +150–200 kcal."), false]
      : r <= 0.5 ? [t("On track. Hold everything."), true]
      : r <= 0.75 ? [t("Upper edge — fine, just watch the mirror."), true]
      : [t("Gaining too fast — trim ~150 kcal to keep it muscle."), false],
  },
  xinyan: {
    start: 149, goal: 118, min: 0, max: 2.0, bandLo: 0.5, bandHi: 1.0,
    unit: "lb / week loss", signed: false,
    rate: (cur, wk) => (149 - cur) / wk,
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
  const [w, setW] = useState(() => localStorage.getItem(`hb-h-${person}-w`) ?? "");
  const [k, setK] = useState(() => localStorage.getItem(`hb-h-${person}-k`) ?? "");
  useEffect(() => localStorage.setItem(`hb-h-${person}-w`, w), [w, person]);
  useEffect(() => localStorage.setItem(`hb-h-${person}-k`, k), [k, person]);

  const cur = parseFloat(w);
  const wk = parseFloat(k);
  const valid = !!cur && !!wk && wk > 0;
  const r = valid ? cfg.rate(cur, wk) : 0;
  const pctOf = (v: number) => clamp(((v - cfg.min) / (cfg.max - cfg.min)) * 100, 0, 100);
  const lo = pctOf(cfg.bandLo);
  const hi = pctOf(cfg.bandHi);
  const [verdictText, verdictOn] = valid
    ? cfg.verdict(r)
    : [t("Enter your numbers to read the trend."), false];
  const shown = valid ? (cfg.signed && r >= 0 ? "+" : "") + r.toFixed(2) : "—";

  const toGo = cfg.goal && valid ? Math.max(0, cur - cfg.goal) : null;
  const donePct =
    cfg.goal && valid ? clamp(((cfg.start - cur) / (cfg.start - cfg.goal)) * 100, 0, 100) : 0;

  return (
    <section className="rounded-[18px] border p-4" style={{ background: "#0f141c", borderColor: "#232d3a" }}>
      <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: acc }}>
        {t("Calibration check")}
      </p>
      <p className="mt-1 text-[15px] font-semibold text-bone">
        {person === "gino" ? t("Are you gaining at the right rate?") : t("Are you losing at the right rate?")}
      </p>
      <p className="mb-3.5 mt-0.5 text-[11px]" style={{ color: "#7e8a98" }}>
        {t("enter your 7-day average — the scale is the measurement")}
      </p>

      <div className="mb-4 grid grid-cols-2 gap-2.5">
        <label className="block">
          <span className="text-[10.5px] uppercase tracking-wider" style={{ color: "#7e8a98" }}>
            {t("Current weight (lb)")}
          </span>
          <input
            type="number"
            inputMode="decimal"
            value={w}
            onChange={(e) => setW(e.target.value)}
            placeholder={String(cfg.start)}
            className="num mt-1.5 w-full rounded-lg px-3 py-2.5 text-[16px] font-semibold text-bone outline-none"
            style={{ background: "#141a24", border: "1px solid #232d3a" }}
          />
        </label>
        <label className="block">
          <span className="text-[10.5px] uppercase tracking-wider" style={{ color: "#7e8a98" }}>
            {t("Weeks on plan")}
          </span>
          <input
            type="number"
            inputMode="numeric"
            value={k}
            onChange={(e) => setK(e.target.value)}
            placeholder="3"
            className="num mt-1.5 w-full rounded-lg px-3 py-2.5 text-[16px] font-semibold text-bone outline-none"
            style={{ background: "#141a24", border: "1px solid #232d3a" }}
          />
        </label>
      </div>

      <div className="relative my-2 h-[42px]">
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
      <div className="flex justify-between text-[10px]" style={{ color: "#7e8a98" }}>
        <span>{t("too slow")}</span>
        <span style={{ color: acc }}>{t("target band")}</span>
        <span>{t("too fast")}</span>
      </div>

      <div className="mt-3.5 flex items-baseline gap-2">
        <span className="num text-[30px] font-bold leading-none text-bone">{shown}</span>
        <span className="text-[12px]" style={{ color: "#7e8a98" }}>{t(cfg.unit)}</span>
      </div>
      <p className="mt-2 text-[13.5px] leading-snug" style={{ color: verdictOn ? "#fff" : "#9aa6b2" }}>
        {verdictText}
      </p>

      {cfg.goal != null && valid && (
        <div className="mt-3.5 border-t pt-3 text-[11.5px]" style={{ borderColor: "#1b232e", color: "#7e8a98" }}>
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
    </section>
  );
}
