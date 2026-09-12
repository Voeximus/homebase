// The vibrant per-category palette for the bento reskin. One source of truth for
// every category's color + icon, used by the donut, the budget bars, the ledger
// chips, and the recent feed. Falls back to a neutral slate for unknowns.

import {
  ShoppingCart,
  Fuel,
  UtensilsCrossed,
  SprayCan,
  Pill,
  Package,
  Zap,
  Repeat,
  Clapperboard,
  Home,
  Baby,
  Banknote,
  PawPrint,
  Monitor,
  Car,
  HelpCircle,
  Receipt,
  Plane,
  GraduationCap,
  type LucideIcon,
} from "lucide-react";

export const CAT_COLOR: Record<string, string> = {
  // ── The categorical set, ground from the workshop palette ──────────────────
  // Every value here was COMPUTED, not chosen. Each is placed at an exact OKLCH
  // (lightness, chroma, hue): the hue is the pigment — which is the part that
  // carries meaning — and the lightness and chroma are whatever the checks
  // demand. The dataviz validator was then run over the result.
  //
  // THE FIVE THAT MATTER carry the donut, where colour really is the only
  // encoding a slice has. They were solved together, all-pairs, and they clear
  // every hard gate with headroom:
  //
  //   worst pair ΔE 16.5 normal vision · 8.8 under protanopia/deuteranopia
  //   every slice ≥ 3:1 against the panel
  //   (gates: normal ≥ 15 hard · CVD ≥ 8 target · contrast ≥ 3)
  //
  // Note what the solver did with lightness. Holding all five at one value
  // FAILED — at equal lightness only hue separates them, and hue alone collapses
  // green against teal under deuteranopia (ΔE 4.5). It passes because the five
  // sit at four different lightnesses. That is not a trick; it is how a painter
  // models form, and it is why this palette survives colour-blindness and
  // greyscale when a flat one does not.
  //
  // THE REST are a tail of thirteen. Past about eight slots no set of hues can
  // hold ΔE 15 all-pairs — the gamut is not that big — so the tail is fitted
  // greedily against everything already placed (worst ΔE 6.3) and colour there
  // is a SECOND encoding, never the only one: every row in this app that shows
  // a category colour also shows that category's icon and its written name.
  groceries: "#007d51", // malachite, deep
  transport: "#8d87e7", // indigo — gas
  dining: "#00aaac", // verdigris
  shopping: "#d47c2e", // sienna — household + hygiene
  other: "#a14d92", // lac
  health: "#e06984", // madder lake
  housing: "#0c72cb", // smalt
  utilities: "#886100", // orpiment, burnt down
  subscriptions: "#008eae", // azurite
  entertainment: "#b271c6", // lac, lit
  car: "#a75840", // umber — vehicle ownership costs
  travel: "#00729b", // cerulean, deep — trips, hotels, travel plazas
  education: "#7c9c50", // terre verte — tuition and course fees
  kids: "#b5627d", // madder, half-tone
  // Was #b5627d — the SAME hex as `kids`, so a pet expense and a child expense
  // were literally indistinguishable on every chart in the app. Moved to its
  // own pigment entirely.
  pets: "#8b7b00", // olive earth
  electronics: "#6379e2", // ultramarine — tech / gadgets
  bills: "#8c52b8", // lac, deep — an extra / catch-up payment on a modeled bill
  salary: "#3aa273", // malachite, lit (income)
};

export const catColor = (id?: string): string =>
  (id && CAT_COLOR[id]) || "#8a7f70"; // unknown: a neutral earth, never a hue

const CAT_ICON: Record<string, LucideIcon> = {
  groceries: ShoppingCart,
  transport: Fuel,
  dining: UtensilsCrossed,
  shopping: SprayCan,
  health: Pill,
  other: Package,
  subscriptions: Repeat,
  entertainment: Clapperboard,
  housing: Home,
  utilities: Zap,
  kids: Baby,
  pets: PawPrint,
  electronics: Monitor,
  car: Car,
  travel: Plane,
  education: GraduationCap,
  bills: Receipt,
  salary: Banknote,
};

export const catIcon = (id?: string): LucideIcon =>
  (id && CAT_ICON[id]) || HelpCircle;

// The signature brand wash — every hero panel in Finance.
//
// It used to be a saturated emerald→cyan→blue, which is the one move this
// palette will not make: a big bright fill spends the loudest colour on the
// LARGEST area, and then the number printed on it has to fight for its life.
// A Renaissance panel does the opposite — the ground is the deepest, richest
// part of the picture and the lit figure is what you see. So the hero is now a
// night of lapis ombra, and the figure on it is lead white.
export const BRAND_GRADIENT =
  "linear-gradient(148deg,#26315c 0%,#1f2748 46%,#2c2340 100%)";

// Health mode's mark — madder lake, the pigment boiled from madder root, which
// is what a Renaissance workshop reached for when it wanted a red that was not
// vermilion. Reserved for PRIMARY actions + key highlights (sparingly), NOT for
// filling large hero cards — those use the neutral HEALTH_HERO surface below.
export const HEALTH = "#e06984";

// Neutral, professional hero surface for the big summary cards — a warm gesso
// wash that lets the coloured content (rings, macro counters) stand out instead
// of competing with a saturated fill.
export const HEALTH_HERO =
  "linear-gradient(155deg,#262016 0%,#15120d 100%)";

// Build a conic-gradient string from weighted segments (for the spending donut).
export function conicFromSegments(
  segs: { color: string; value: number }[],
): string {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const stops = segs.map((s) => {
    const start = (acc / total) * 100;
    acc += s.value;
    const end = (acc / total) * 100;
    return `${s.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
  });
  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

/**
 * Readable ink for text sitting ON one of these swatches.
 *
 * Every colour in this file is a MARK colour — picked to read against the dark
 * canvas — which makes them mid-toned, and white text on a mid-toned swatch is
 * the contrast failure that keeps recurring: an audit of the rendered Profile
 * hero measured the owner initial at 2.67:1 on Gino's orange and 1.91:1 on
 * Xinyan's teal, where 22px bold needs 3:1.
 *
 * It COMPARES the two candidates rather than testing luminance against a
 * threshold. The first version of this used `L > 0.45`, which is the kind of
 * magic number that looks principled and isn't: Gino's orange sits at L 0.34,
 * so it picked white — and white was the losing option by 2.6×. Computing both
 * ratios needs no constant and cannot be wrong.
 */
const DARK_INK = "#0e0b07"; // bone black
const LIGHT_INK = "#fbf7ef"; // lead white

function relLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const lin = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function inkOn(bg: string): string {
  if (!/^#?[0-9a-f]{6}$/i.test(bg.replace("#", "").length === 6 ? bg : "")) return DARK_INK;
  const b = relLuminance(bg);
  const ratio = (a: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return ratio(relLuminance(DARK_INK)) >= ratio(relLuminance(LIGHT_INK)) ? DARK_INK : LIGHT_INK;
}
