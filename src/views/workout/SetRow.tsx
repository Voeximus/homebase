import { useEffect, useRef, useState, type Ref } from "react";
import { Check } from "lucide-react";
import { t } from "../../lib/i18n";
import { fmtWeight, type Ghost } from "../../lib/sessionOps";
import type { SetEntry } from "../../lib/workoutLog";

// One set row of the logger, ported from the workout lab mockup
// (public/_workoutlab.html, `.setrow`): set number · weight · reps · tick.
//
// Empty boxes show the ghost as a placeholder: faint and normal weight, where a
// typed number is bone and semibold, so the two can be told apart by colour AND
// weight at a sweaty glance. The tick is 48 × 48 because it is the one thing
// tapped on every set.
//
// This row only draws and reports; every rule (what a tick fills in, when it is
// refused) lives in src/lib/sessionOps.ts.

// set number · weight · reps · tick, on a 343px phone column
const COLS_WEIGHT = "28px minmax(0,1fr) minmax(0,1fr) 48px";
const COLS_REPS = "28px minmax(0,1fr) 48px";

export function SetColumns({ showWeight }: { showWeight: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="grid items-center gap-1.5 py-0.5 text-center text-[10.5px] tracking-[0.05em] uppercase"
      style={{ gridTemplateColumns: showWeight ? COLS_WEIGHT : COLS_REPS, color: "var(--color-faint)" }}
    >
      <span>{t("Set")}</span>
      {showWeight && <span>{t("Weight")}</span>}
      <span>{t("Reps")}</span>
      <span />
    </div>
  );
}

export function SetRow({
  set,
  label,
  ghost,
  showWeight,
  done,
  weightError,
  shake,
  onWeight,
  onReps,
  onTick,
  onToggleKind,
}: {
  set: SetEntry;
  label: string; // "W" or the working-set number
  ghost: Ghost;
  showWeight: boolean;
  done: boolean;
  weightError: boolean;
  shake: number; // bumped each time a tick is refused, to shake the weight box again
  onWeight(n: number): void;
  onReps(n: number): void;
  onTick(): void;
  onToggleKind(): void;
}) {
  const weightBox = useRef<HTMLSpanElement>(null);
  const warm = set.kind === "warmup";

  // The refusal shake. Web Animations API, so it needs no new CSS; skipped for
  // people who asked for reduced motion (the red border and message still show).
  useEffect(() => {
    const el = weightBox.current;
    if (!shake || !el || typeof el.animate !== "function") return;
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      const anim = el.animate(
        [{ transform: "none" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }],
        { duration: 350, easing: "ease" },
      );
      return () => anim.cancel();
    } catch {
      /* no animation support */
    }
  }, [shake]);

  const setName = warm ? t("warm-up") : t("set {n}", { n: label });
  return (
    <div className="grid items-center gap-1.5 py-[3px]" style={{ gridTemplateColumns: showWeight ? COLS_WEIGHT : COLS_REPS }}>
      <button
        onClick={onToggleKind}
        className="h-hit num grid h-11 place-items-center rounded-lg text-[12.5px] font-bold"
        style={warm ? { color: "var(--color-bone)", boxShadow: "inset 0 0 0 1px var(--color-edge)" } : { color: "var(--color-taupe)" }}
        aria-label={warm ? t("Warm-up set. Tap to make it a working set") : t("Set {n}. Tap to make it a warm-up", { n: label })}
      >
        {label}
      </button>

      {showWeight && (
        <NumBox
          boxRef={weightBox}
          value={set.weight}
          ghost={ghost.weight}
          decimal
          max={2000}
          suffix="lb"
          done={done}
          error={weightError}
          label={t("Weight for {set}", { set: setName })}
          onChange={onWeight}
        />
      )}
      <NumBox
        value={set.reps}
        ghost={ghost.reps}
        max={999}
        done={done}
        label={t("Reps for {set}", { set: setName })}
        onChange={onReps}
      />

      <button
        onClick={onTick}
        aria-pressed={done}
        aria-label={done ? t("Undo {set}", { set: setName }) : t("Mark {set} done", { set: setName })}
        className="grid h-12 w-12 place-items-center rounded-[12px]"
        style={
          done
            ? { background: "var(--h-good)", color: "var(--color-bg)" }
            : { boxShadow: "inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 70%, transparent)", color: "var(--color-accent)" }
        }
      >
        <Check size={20} />
      </button>

      {weightError && (
        <div role="alert" className="col-span-full pb-0.5 pl-[34px] text-[11px]" style={{ color: "var(--h-over)" }}>
          {t("Enter a weight")}
        </div>
      )}
    </div>
  );
}

// ── the number box (string-buffered, so "17." can be typed on the way to 17.5) ──
const parse = (s: string) => (s === "" || s === "." ? 0 : Number(s));
const show = (n: number) => (n > 0 ? fmtWeight(n) : "");

function NumBox({
  value,
  ghost,
  decimal,
  max,
  suffix,
  done,
  error,
  label,
  boxRef,
  onChange,
}: {
  value: number;
  ghost: number;
  decimal?: boolean;
  max: number;
  suffix?: string;
  done: boolean;
  error?: boolean;
  label: string;
  boxRef?: Ref<HTMLSpanElement>;
  onChange(n: number): void;
}) {
  const [buf, setBuf] = useState(() => show(value));
  const [seen, setSeen] = useState(value);
  // A value changed from outside (a tick filling in the ghost): show it, unless
  // the buffer already means that number (mid-typing "17." is 17).
  if (value !== seen) {
    setSeen(value);
    if (parse(buf) !== value) setBuf(show(value));
  }

  return (
    <span
      ref={boxRef}
      className="flex h-11 items-center justify-center gap-0.5 rounded-lg border"
      style={{
        background: done ? "transparent" : "var(--color-tile)",
        borderColor: error ? "var(--h-over)" : done ? "transparent" : "var(--color-edge)",
      }}
    >
      <input
        value={buf}
        inputMode={decimal ? "decimal" : "numeric"}
        aria-label={label}
        aria-invalid={error || undefined}
        placeholder={ghost > 0 ? fmtWeight(ghost) : ""}
        onChange={(e) => {
          let raw = e.target.value.replace(decimal ? /[^\d.]/g : /\D/g, "");
          if (decimal) {
            const dot = raw.indexOf(".");
            if (dot >= 0) raw = raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, "").slice(0, 2);
          }
          if (parse(raw) > max) raw = String(max);
          setBuf(raw);
          setSeen(parse(raw));
          onChange(parse(raw));
        }}
        className="num h-full w-full min-w-0 bg-transparent text-center text-[16px] font-semibold text-bone outline-none placeholder:font-normal placeholder:text-[var(--color-faint)]"
      />
      {suffix && (
        <span className="pr-1.5 text-[10px]" style={{ color: "var(--color-faint)" }}>
          {suffix}
        </span>
      )}
    </span>
  );
}
