import { useEffect, useRef } from "react";
import { t } from "../../lib/i18n";

// The rest dock, ported from the workout lab mockup (public/_workoutlab.html,
// `.restdock`). It sits just above the bottom tab bar because that is where the
// thumb already is between sets, so −15 / +15 / Skip are one reach away.
//
// It only draws what it's given: the countdown comes from useRestTimer, which
// keeps the end time, so this component never counts anything itself.
//
// The countdown is a `timer` (not read aloud every second); only the line above
// it is a live status, so a screen reader hears "Rest over" once.

// 59px = the .h-tabs bar: 6px padding + 46px button + 6px padding + 1px border.
const TABS_H = "59px";

const clock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Every dock control is at least 48 × 44 — tapped with a sweaty thumb mid-set.
const CTL = "min-h-[44px] min-w-[48px] rounded-[10px] px-2 text-[13px] font-bold";
const QUIET = { background: "var(--color-tile)", color: "var(--color-bone)", boxShadow: "inset 0 0 0 1px var(--color-edge)" };
const ACCENT = { background: "var(--color-accent)", color: "var(--h-on-accent)" };

export function RestDock({
  remaining,
  over,
  label,
  onAdd,
  onSkip,
}: {
  remaining: number;
  over: boolean;
  label: string;
  onAdd(sec: number): void;
  onSkip(): void;
}) {
  const box = useRef<HTMLDivElement>(null);

  // One pulse when the rest ends. Done with the Web Animations API so it needs
  // no new CSS; skipped entirely for people who asked for reduced motion.
  useEffect(() => {
    const el = box.current;
    if (!over || !el || typeof el.animate !== "function") return;
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      const good = getComputedStyle(el).getPropertyValue("--h-good").trim();
      if (!good) return;
      const anim = el.animate(
        [
          { boxShadow: `0 0 0 0 color-mix(in srgb, ${good} 60%, transparent)` },
          { boxShadow: "0 0 0 14px transparent" },
        ],
        { duration: 900, easing: "ease", iterations: 1 },
      );
      return () => anim.cancel();
    } catch {
      /* no animation support — the border colour still changes */
    }
  }, [over]);

  return (
    <div
      className="fixed left-1/2 z-[39] w-full max-w-[640px] -translate-x-1/2 px-4 pb-1.5"
      style={{ bottom: `calc(${TABS_H} + env(safe-area-inset-bottom))` }}
    >
      <div
        ref={box}
        className="relative flex min-h-[60px] items-center gap-2 overflow-hidden rounded-[14px] border py-2 pr-2 pl-3.5"
        style={{
          background: "var(--color-raised)",
          borderColor: over ? "var(--h-good)" : "var(--color-edge)",
        }}
      >
        <div className="min-w-0 flex-1">
          <div role="status" aria-live="polite" className="truncate text-[12px]" style={{ color: "var(--color-taupe)" }}>
            {over ? t("Rest over") : label ? t("Rest · {name}", { name: label }) : t("Rest")}
          </div>
          {over ? (
            <div className="text-[20px] leading-none font-[750]" style={{ color: "var(--color-bone)" }}>
              {t("Next set")}
            </div>
          ) : (
            <div
              role="timer"
              aria-label={t("Rest left")}
              className="hb-num text-[28px] leading-none font-[750] tracking-[-0.5px]"
              style={{ color: "var(--color-bone)" }}
            >
              {clock(remaining)}
            </div>
          )}
        </div>

        {!over && (
          <button className={CTL} style={QUIET} onClick={() => onAdd(-15)} aria-label={t("15 seconds less")}>
            −15
          </button>
        )}
        <button className={CTL} style={QUIET} onClick={() => onAdd(15)} aria-label={t("15 seconds more")}>
          +15
        </button>
        <button className={CTL} style={ACCENT} onClick={onSkip}>
          {over ? t("OK") : t("Skip")}
        </button>
      </div>
    </div>
  );
}
