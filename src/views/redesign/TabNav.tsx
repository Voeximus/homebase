import { Home, PieChart, LayoutGrid, User, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

export type TabKey = "home" | "insights" | "activity" | "profile";

const TABS: { key: TabKey; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Home", Icon: Home },
  { key: "insights", label: "Insights", Icon: PieChart },
  { key: "activity", label: "Activity", Icon: LayoutGrid },
  { key: "profile", label: "Profile", Icon: User },
];

export function TabNav({
  active,
  onTab,
  badges,
}: {
  active: TabKey;
  onTab: (t: TabKey) => void;
  /**
   * A plain count beside a tab's label. Used by "Worth a look" — Activity is a
   * tab you open on purpose, so without this there is no way to learn the app
   * noticed something. Counts are never summed with anything else: "the app has a
   * question about a bill" and "the app has a question about a category" are two
   * different questions and one number would hide both.
   */
  badges?: Partial<Record<TabKey, number>>;
}) {
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
        const badge = badges?.[key] ?? 0;
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            aria-current={on ? "page" : undefined}
            className="flex min-h-[48px] flex-col items-center justify-center gap-1 text-[11px] transition active:scale-95"
            style={{ color: on ? "#34c5e8" : "#7a8595" }}
          >
            <Icon size={21} />
            <span className="inline-flex items-center gap-1">
              {t(label)}
              {badge > 0 && (
                <span
                  className="rounded-full px-1.5 text-[10px] font-bold"
                  style={{ background: "#e3b341", color: "#0b0f17" }}
                >
                  {badge}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
