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
  // ── Computed, not chosen. ─────────────────────────────────────────────────
  // Each value is placed at an exact OKLCH — the HUE is the pigment, which is
  // the part that carries meaning, and the lightness and chroma are whatever
  // the checks demand — then run through the dataviz validator.
  //
  // THE RULE THAT DECIDED THIS SET: the accent (#38c6e8) is the only colour in
  // the app that is both a FILL and an INK, so it is the only one that has to
  // be unique in both roles. It means one thing — you can act on this. The
  // previous palette had `dining` in cyan, ΔE 4.4 from it, so a category
  // looked tappable. Nothing here is closer than ΔE 20 to the accent except
  // two of the rarest tail entries, and none is closer than 12.8.
  //
  // Status (mint/gold/ember) is text-and-tag only, always beside a word;
  // categories are dots, slices and fills only, never text colour. They never
  // meet in the same role, which is why a green category and a green "on
  // track" can both exist without confusion.
  //
  // THE FIVE THAT CARRY THE DONUT were solved together, all-pairs, because
  // there colour really is the only encoding a slice has:
  //
  //   worst pair ΔE 16.4 normal vision · 8.3 under protanopia/deuteranopia
  //   every slice ≥ 3:1 against the panel
  //
  // THE OTHER THIRTEEN are an honest compromise and worth stating plainly:
  // eighteen hues cannot all sit ΔE 15 apart with an accent reserved — the
  // gamut is not that big. They are fitted greedily against everything already
  // placed, and past the donut five colour is a SECOND encoding here, never
  // the only one: every row in this app that shows a category colour also
  // shows that category's icon and its written name.
  groceries: "#369e4e", // green
  transport: "#987de4", // violet — gas
  dining: "#a3468c", // plum (was cyan, which the accent now owns)
  shopping: "#8f6700", // olive-gold — household + hygiene
  other: "#0871c1", // blue (was plum)
  health: "#cd7790", // rose
  housing: "#3e8ec1", // steel blue
  utilities: "#d67000", // orange
  subscriptions: "#00a4a3", // teal
  entertainment: "#8258aa", // violet, deeper
  car: "#ac594f", // brick — vehicle ownership costs
  travel: "#0094a4", // deep cyan-teal
  education: "#7c9217", // olive-green — tuition and course fees
  kids: "#b16389", // dusty rose
  // Was #f472b6 — the SAME hex as `kids`, so a pet expense and a child expense
  // were literally indistinguishable on every chart in the app.
  pets: "#987500", // dark gold
  electronics: "#6c72dd", // indigo
  // Deliberately `other`'s family at a different value: a catch-up payment on a
  // modelled bill IS an "other" outflow, and it clears the accent by ΔE 23.8,
  // which is the only separation that is non-negotiable.
  bills: "#0073ba", // blue, deeper
  salary: "#008262", // deep green — income
};

export const catColor = (id?: string): string =>
  (id && CAT_COLOR[id]) || "#8b96a5";

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
  "linear-gradient(150deg,#14707f 0%,#155f7d 52%,#1d4a74 100%)";

// Health mode's brand wash — the rose→pink health gradient, so Health reads red
// the way Finance reads green-cyan. Built on the `health` category rose (#e0607f).
// Reserved for PRIMARY actions + key highlights (sparingly), NOT for filling
// large hero cards — those use the neutral HEALTH_HERO surface below.
export const HEALTH = "#e8608f"; // the protein pigment — health's mark

  "linear-gradient(150deg,#e0607f 0%,#fb6f92 52%,#f43f5e 100%)";
// Neutral, professional hero surface for the big summary cards — a deep slate
// wash that lets the colored content (rings, macro counters) stand out instead
// of competing with a saturated red fill.
export const HEALTH_HERO =
  "linear-gradient(155deg,#1c2430 0%,#0f141b 100%)";

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
const DARK_INK = "#080a0e";
const LIGHT_INK = "#f0f4f8";

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
