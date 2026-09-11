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
  groceries: "#22c55e", // green
  transport: "#8b5cf6", // violet (gas)
  dining: "#06b6d4", // cyan
  shopping: "#f97316", // orange (household + hygiene)
  health: "#fb7185", // rose
  // Was #d946ef fuchsia, which sat ΔE 1.3 from `transport` violet under
  // protanopia and 14.1 under NORMAL vision — below the 15 floor, so even
  // full-colour readers struggled. Those two are the 3rd and 4th most-used
  // categories in the ledger and they share the Insights budget chart, one row
  // apart, as adjacent donut slices. Stepped away from violet while staying in
  // the same family, so Misc still reads the way he is used to.
  //   plum vs violet: ΔE 15.4 normal · the five-slice donut now clears every
  //   hard gate (the remaining green↔orange WARN is legal — each row carries an
  //   icon and its written name).
  other: "#b0559b", // plum
  subscriptions: "#2dd4bf", // teal
  entertainment: "#a78bfa", // light violet
  housing: "#60a5fa", // blue
  utilities: "#fb923c", // amber-orange
  kids: "#f472b6", // pink
  pets: "#f472b6", // pink — dog / pets
  electronics: "#818cf8", // indigo — tech / gadgets
  car: "#ca8a04", // dark mustard — vehicle ownership costs (no other cat is near this hue)
  travel: "#38bdf8", // light sky — trips, hotels, travel plazas
  education: "#a3e635", // lime — tuition and course fees
  bills: "#0ea5e9", // sky — an extra / catch-up payment on a modeled bill
  salary: "#46d18a", // mint (income)
};

export const catColor = (id?: string): string =>
  (id && CAT_COLOR[id]) || "#8b97a6";

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

// The signature brand gradient — the green→cyan→blue wash on every hero.
export const BRAND_GRADIENT =
  "linear-gradient(150deg,#10b981 0%,#06b6d4 52%,#3b82f6 100%)";

// Health mode's brand wash — the rose→pink health gradient, so Health reads red
// the way Finance reads green-cyan. Built on the `health` category rose (#fb7185).
// Reserved for PRIMARY actions + key highlights (sparingly), NOT for filling
// large hero cards — those use the neutral HEALTH_HERO surface below.
export const HEALTH = "#fb7185";
export const HEALTH_GRADIENT =
  "linear-gradient(150deg,#fb7185 0%,#fb6f92 52%,#f43f5e 100%)";
// Neutral, professional hero surface for the big summary cards — a deep slate
// wash that lets the colored content (rings, macro counters) stand out instead
// of competing with a saturated red fill.
export const HEALTH_HERO =
  "linear-gradient(155deg,#1c2433 0%,#10151d 100%)";

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
const DARK_INK = "#0d1218";
const LIGHT_INK = "#ffffff";

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
