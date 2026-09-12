import { Home, PieChart, LayoutGrid, User, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

export type TabKey = "home" | "insights" | "activity" | "profile";

const TABS: { key: TabKey; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Home", Icon: Home },
  { key: "insights", label: "Insights", Icon: PieChart },
  { key: "activity", label: "Activity", Icon: LayoutGrid },
  { key: "profile", label: "Profile", Icon: User },
];

export function TabNav({ active, onTab }: { active: TabKey; onTab: (t: TabKey) => void }) {
  return (
    // `justify-around` sized each button to its own TEXT, so the targets
    // measured 29–36px wide with dead gutters between them — on the most-used
    // control in the app, at the bottom of a phone, where a thumb lands
    // approximately. An equal-column grid gives every tab the same share of the
    // full width and leaves no gap that does nothing.
    <nav
      className="grid grid-cols-4 border-t pt-2"
      style={{
        background: "#10141d",
        borderColor: "#1d2530",
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
            className="flex min-h-[48px] flex-col items-center justify-center gap-1 text-[11px] transition active:scale-95"
            style={{ color: on ? "#34c5e8" : "#7a8595" }}
          >
            <Icon size={21} />
            {t(label)}
          </button>
        );
      })}
    </nav>
  );
}
