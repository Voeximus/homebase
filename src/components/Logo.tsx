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
 *
 * Re-pigmented 2026-09-11: ULTRAMARINE and GOLD. Those are the two pigments a
 * Renaissance contract actually named — lapis lazuli, shipped from Afghanistan
 * and priced above gold, and gold leaf itself — and they are the only pair in
 * the app's palette that differs in LIGHTNESS as much as in hue. The old
 * emerald→cyan→blue halves were near-isoluminant, so in greyscale, under
 * colour-blindness, or at 16px the split quietly disappeared and the mark
 * flattened into one blob. These two stay two.
 *
 * Each half is lit from above-left and falls into shadow at the lower right,
 * which is the same single light source the rest of the app is painted under.
 *
 * It does not move. There was a highlight that swept across it every seven
 * seconds; it came out for two reasons. The visible one is that it travelled
 * from off the mark's left edge to off its right, which widens the group's
 * bounding box for the whole flight — and a CSS filter on any ancestor takes
 * its region from that box, so the mark cast a faint bar underneath itself.
 * Neither a clip-path nor a nested viewport fixes that (clipping changes what
 * paints, not what the box measures). The better reason is that the front door
 * already has one thing moving on it, and a logo that shines on a timer is a
 * tic rather than a shine — a painted panel does not shimmer.
 */

// Inset so the rounded stroke grows the shape back out to fill the box.
const PLATE = "M22 28 H78 V54 L50 80 L22 54 Z";
const STROKE = 13;

export function Logo({
  size = 48,
  className,
  title,
}: {
  size?: number | string;
  className?: string;
  title?: string;
}) {
  // useId, because two marks on one page would otherwise share gradient ids and
  // the second would silently inherit the first's fills.
  const uid = useId().replace(/:/g, "");
  const L = `hbL${uid}`;
  const R = `hbR${uid}`;
  const M = `hbM${uid}`;

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
        {/* ultramarine — lit top-left, into shadow bottom-right */}
        <linearGradient id={L} x1="16" y1="16" x2="54" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9ab6ff" />
          <stop offset="1" stopColor="#2d3d97" />
        </linearGradient>
        {/* gold leaf — the same light, one pigment over */}
        <linearGradient id={R} x1="46" y1="14" x2="88" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0cd7c" />
          <stop offset="0.55" stopColor="#d3a63f" />
          <stop offset="1" stopColor="#8f6a15" />
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
      </defs>

      <g mask={`url(#${M})`}>
        <rect x="0" y="0" width="50" height="100" fill={`url(#${L})`} />
        <rect x="50" y="0" width="50" height="100" fill={`url(#${R})`} />
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
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center ${className ?? ""}`} style={{ gap: size * 0.32 }}>
      <Logo size={size * 1.18} title="Homebase" />
      <span
        style={{
          // The inscription face. A humanist roman beside a lapis-and-gold
          // plate is the lockup the mark was drawn for; a grotesque beside it
          // was always going to read as a tech logo wearing a costume.
          fontFamily: "var(--font-display)",
          fontSize: size * 1.1,
          fontWeight: 600,
          // Garamond is already generously fitted — it wants air, not squeeze.
          letterSpacing: "0.005em",
          color: "var(--color-bone)",
          lineHeight: 1,
        }}
      >
        Homebase
      </span>
    </span>
  );
}
