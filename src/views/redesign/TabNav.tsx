import { Home, PieChart, LayoutGrid, HeartPulse, User, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

export type TabKey = "home" | "insights" | "activity" | "profile";
/** What the bar can be pointing at. Health is a destination, not a mode switch. */
export type NavKey = TabKey | "health";

// ── One navigation system ────────────────────────────────────────────────────
// Every screen used to carry TWO switches above the content — Finance/Health and
// Mine/Household — stacked on top of this bar. Three navigation controls for two
// axes, and the mode switch sat at the TOP of the screen while the thing it was
// a sibling of sat at the bottom.
//
// Health is a slot in the bar now. It is a place you go, exactly like Insights,
// and putting it here says so. Mine/Household stays on screen because it changes
// what the numbers MEAN rather than where you are.
//
// The bar is painted from the semantic tokens, not from literals, so inside
// Health it takes that theme's ground and accent instead of imposing Finance's.
const TABS: { key: NavKey; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Home", Icon: Home },
  { key: "insights", label: "Insights", Icon: PieChart },
  { key: "activity", label: "Activity", Icon: LayoutGrid },
  { key: "health", label: "Health", Icon: HeartPulse },
  { key: "profile", label: "Profile", Icon: User },
];

export function TabNav({ active, onTab }: { active: NavKey; onTab: (t: NavKey) => void }) {
  return (
    // `justify-around` sized each button to its own TEXT, so the targets
    // measured 29–36px wide with dead gutters between them — on the most-used
    // control in the app, at the bottom of a phone, where a thumb lands
    // approximately. An equal-column grid gives every tab the same share of the
    // full width and leaves no gap that does nothing.
    <nav
      className="grid grid-cols-5 border-t pt-2"
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-edge)",
        paddingBottom: "max(12px, env(safe-area-inset-bottom))",
      }}
      aria-label={t("Sections")}
    >
      {TABS.map(({ key, label, Icon }) => {
        const on = key === active;
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            aria-current={on ? "page" : undefined}
            className="flex min-h-[48px] flex-col items-center justify-center gap-1 text-[10px] font-semibold transition active:scale-95"
            style={{ color: on ? "var(--color-accent)" : "var(--color-faint)" }}
          >
            <Icon
              size={20}
              // A hair of lift on the active icon. The only motion in the bar,
              // and it is the one that confirms the tap landed.
              style={{
                transform: on ? "translateY(-1px) scale(1.06)" : "none",
                transition: "transform var(--t-lat, 240ms) var(--ease-out, ease)",
              }}
            />
            {t(label)}
          </button>
        );
      })}
    </nav>
  );
}
