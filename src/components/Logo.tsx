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

// The house, and the doorway knocked out of it. Both numbers are duplicated in
// scripts/build-icons.mjs, which says so itself: change one and the tab icon and
// the in-app mark become two different logos.
const HOUSE = "M12 46 L50 14 L88 46 L88 88 L12 88 Z";
const DOOR = { x: 40, y: 62, w: 20, h: 26, r: 2 };

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
        <linearGradient id={L} x1="10" y1="6" x2="92" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#CAF277" />
          <stop offset="1" stopColor="#A8DC45" />
        </linearGradient>
        {/* The house, minus the doorway. White keeps, black cuts — so the
            doorway is a real hole and the mark drops onto any ground without
            carrying a rectangle of the wrong colour with it. */}
        <mask id={M}>
          <path d={HOUSE} fill="#fff" />
          <rect x={DOOR.x} y={DOOR.y} width={DOOR.w} height={DOOR.h} rx={DOOR.r} fill="#000" />
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
        <rect x="0" y="0" width="100" height="100" fill={`url(#${L})`} />
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
