import { useId } from "react";

/**
 * The Homebase mark.
 *
 * A home plate — the pentagon is literally "home base", and it is a silhouette
 * nothing else in a phone's app drawer shares, which a rounded square with a
 * stock glyph in it is not. (The app shipped with two different logos: a house
 * in the favicon and a lucide Wallet on the login screen.)
 *
 * It is split into two planes that JOIN BEFORE THE POINT. That is the whole
 * idea and the only internal detail, which is why it survives to 16px: two
 * people, two instruments — money and body — separate where they start, single
 * where they land. The seam stops short of the tip on purpose; a seam running
 * all the way through says "divided", which is the opposite of the name.
 *
 * The seam is a real hole punched with a mask, not a background-coloured rect,
 * so the mark drops onto a card, a gradient or a light chip without carrying a
 * stripe of the wrong colour with it.
 */

// Inset so the rounded stroke grows the shape back out to fill the box.
const PLATE = "M22 28 H78 V54 L50 80 L22 54 Z";
const STROKE = 13;

export function Logo({
  size = 48,
  className,
  /** A slow sheen across the mark. Off by default — it belongs on the intro. */
  animated = false,
  title,
}: {
  size?: number | string;
  className?: string;
  animated?: boolean;
  title?: string;
}) {
  // useId, because two marks on one page would otherwise share gradient ids and
  // the second would silently inherit the first's fills.
  const uid = useId().replace(/:/g, "");
  const L = `hbL${uid}`;
  const R = `hbR${uid}`;
  const M = `hbM${uid}`;
  const S = `hbS${uid}`;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={L} x1="18" y1="18" x2="52" y2="86" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
        <linearGradient id={R} x1="48" y1="18" x2="86" y2="86" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#06b6d4" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
        {/* The plate, minus the seam. White keeps, black cuts. */}
        <mask id={M}>
          <path
            d={PLATE}
            fill="#fff"
            stroke="#fff"
            strokeWidth={STROKE}
            strokeLinejoin="round"
            paintOrder="stroke"
          />
          <rect x="48.8" y="0" width="2.4" height="62" fill="#000" />
        </mask>
        {animated && (
          <linearGradient id={S} x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        )}
      </defs>

      <g mask={`url(#${M})`}>
        <rect x="0" y="0" width="50" height="100" fill={`url(#${L})`} />
        <rect x="50" y="0" width="50" height="100" fill={`url(#${R})`} />
        {/* The sheen rides INSIDE the mask, so it lights the mark and never
            leaks a rectangle over whatever is behind it. */}
        {animated && (
          <rect
            className="hb-sheen"
            x="-60"
            y="0"
            width="60"
            height="100"
            fill={`url(#${S})`}
          />
        )}
      </g>
    </svg>
  );
}

/**
 * The mark plus the word, locked up. One component so the optical relationship
 * between them is decided once instead of re-guessed at every call site.
 */
export function Wordmark({
  size = 34,
  animated = false,
  className,
}: {
  size?: number;
  animated?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center ${className ?? ""}`} style={{ gap: size * 0.32 }}>
      <Logo size={size * 1.18} animated={animated} title="Homebase" />
      <span
        style={{
          fontSize: size,
          fontWeight: 700,
          // Tight, because the word is long and the mark beside it is compact.
          letterSpacing: "-0.035em",
          color: "var(--color-bone)",
          lineHeight: 1,
        }}
      >
        Homebase
      </span>
    </span>
  );
}
