import type { ReactNode } from "react";

// The pieces the three screens are built from, so the look lives in one file.
//
// Taken from the reference he picked on 2026-10-04. Three ideas carry the whole
// design and everything here is one of them:
//
//   1. THE HERO CARD is the opposite of the page — a black card on cream, a cream
//      card on black. It holds the one number the screen exists to show, plus up
//      to three small readouts in wells cut into it.
//   2. CATEGORY CHIPS are a soft tint with a single letter in it. They carry
//      their own background, so they are identical in both themes.
//   3. EVERYTHING ELSE is a white card with generous radius, rows separated by a
//      hairline that starts under the text rather than at the card's edge.

/** The hero card. `tone="lime"` is for the one card that is an action. */
export function Hero({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-4 rounded-[24px] p-[18px]"
      style={{ background: "var(--color-hero)", color: "var(--color-heroink)" }}
    >
      {children}
    </div>
  );
}

/** The big figure. Cents are set smaller and quieter — the reference's own move,
 *  and it is what stops a six-character number reading as a wall. */
export function Figure({ whole, cents }: { whole: string; cents: string }) {
  return (
    <div className="mt-1 text-[44px] font-bold leading-none tracking-[-0.035em] tabular-nums">
      {whole}
      <span className="text-[26px]" style={{ color: "var(--color-heroink)", opacity: 0.6 }}>
        {cents}
      </span>
    </div>
  );
}

/** Up to three small readouts in wells cut into the hero card. */
export function Wells({ items }: { items: { k: string; v: string; lime?: boolean }[] }) {
  return (
    <div className="mt-4 grid grid-cols-3 gap-[7px]">
      {items.map((i) => (
        <div
          key={i.k}
          className="rounded-[13px] px-2.5 py-[9px]"
          style={{ background: "var(--color-edgehero)", opacity: 0.92 }}
        >
          <div className="text-[11px]" style={{ color: "var(--color-hero)", opacity: 0.62 }}>
            {i.k}
          </div>
          <div
            className="mt-px text-[14px] font-semibold tabular-nums"
            style={{ color: i.lime ? "var(--color-lime)" : "var(--color-hero)" }}
          >
            {i.v}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The six chip tints, each with an ink that reads on it (measured: 4.94–6.06:1).
 *  They are self-contained, so a chip looks the same in both themes. */
const CHIPS = [
  { bg: "#E3EFD2", fg: "#3A6B22" },
  { bg: "#F7DCD2", fg: "#9C4420" },
  { bg: "#D9E6F5", fg: "#2B5584" },
  { bg: "#F2DEEE", fg: "#8A3C72" },
  { bg: "#EFE6D0", fg: "#7A5A17" },
  { bg: "#E4E2DC", fg: "#5C5A52" },
] as const;

/** Stable per name, so a category keeps its colour between sessions and between
 *  screens — a chip that changes hue on reload is noise pretending to be meaning. */
export function chipFor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CHIPS[h % CHIPS.length];
}

export function Chip({ name, size = 34 }: { name: string; size?: number }) {
  const c = chipFor(name);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[11px] font-bold"
      style={{
        width: size,
        height: size,
        background: c.bg,
        color: c.fg,
        fontSize: size * 0.41,
      }}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** A white card holding rows. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mx-4 overflow-hidden rounded-[20px] bg-tile ${className}`}>{children}</div>
  );
}

/** A section heading, in the reference's weight. */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-[18px] flex items-baseline justify-between px-5">
      <span className="text-[15px] font-bold text-bone">{children}</span>
      {aside && <span className="text-[13px] text-taupe">{aside}</span>}
    </div>
  );
}

/** The hairline between rows — inset so the card reads as one object. */
export const ROW_SEP = { boxShadow: "inset 0 -1px 0 var(--color-edge)" } as const;

/** A progress track. `over` turns it red; the fill is the ink, never the lime,
 *  because the lime is 1.27:1 on this ground and a bar has to be seen. */
export function Bar({ pct, over }: { pct: number; over?: boolean }) {
  return (
    <div
      className="mt-[9px] h-[5px] overflow-hidden rounded-full"
      style={{ background: "var(--color-recessed)" }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: over ? "var(--color-ember)" : "var(--color-bone)",
        }}
      />
    </div>
  );
}

/** The lime pill — a fill with ink on it, which is the only way the lime is ever
 *  allowed to appear on the light ground. */
export function LimePill({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold"
      style={{ background: "var(--color-lime)", color: "#111111" }}
    >
      {children}
    </span>
  );
}
