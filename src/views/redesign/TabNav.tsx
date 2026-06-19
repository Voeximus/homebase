import { Home, PieChart, LayoutGrid, User, type LucideIcon } from "lucide-react";

export type TabKey = "home" | "insights" | "activity" | "profile";

const TABS: { key: TabKey; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Home", Icon: Home },
  { key: "insights", label: "Insights", Icon: PieChart },
  { key: "activity", label: "Activity", Icon: LayoutGrid },
  { key: "profile", label: "Profile", Icon: User },
];

export function TabNav({ active, onTab }: { active: TabKey; onTab: (t: TabKey) => void }) {
  return (
    <nav
      className="flex justify-around border-t pt-3"
      style={{
        background: "#10141d",
        borderColor: "#1d2530",
        paddingBottom: "max(16px, env(safe-area-inset-bottom))",
      }}
    >
      {TABS.map(({ key, label, Icon }) => {
        const on = key === active;
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            className="flex flex-col items-center gap-1 text-[11px] transition active:scale-95"
            style={{ color: on ? "#34c5e8" : "#6b7686" }}
          >
            <Icon size={21} />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
