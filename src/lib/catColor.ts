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
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

export const CAT_COLOR: Record<string, string> = {
  groceries: "#22c55e", // green
  transport: "#8b5cf6", // violet (gas)
  dining: "#06b6d4", // cyan
  shopping: "#f97316", // orange (household + hygiene)
  health: "#fb7185", // rose
  other: "#d946ef", // fuchsia
  subscriptions: "#2dd4bf", // teal
  entertainment: "#a78bfa", // light violet
  housing: "#60a5fa", // blue
  utilities: "#fb923c", // amber-orange
  kids: "#f472b6", // pink
  pets: "#f472b6", // pink — dog / pets
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
  salary: Banknote,
};

export const catIcon = (id?: string): LucideIcon =>
  (id && CAT_ICON[id]) || HelpCircle;

// The signature brand gradient — the green→cyan→blue wash on every hero.
export const BRAND_GRADIENT =
  "linear-gradient(150deg,#10b981 0%,#06b6d4 52%,#3b82f6 100%)";

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
