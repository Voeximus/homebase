import { Receipt, Landmark, PieChart, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

/**
 * THREE THINGS. His instruction on 2026-10-04: "compress the app down to literally
 * Bills, Accounts budget … strip everything out except those things."
 *
 * It was Home / Insights / Activity / Profile, and behind those four tabs sat
 * fourteen sheets — a ledger, a transaction editor, a review queue, an importer,
 * meal and workout modes, five dev labs. All of it still exists in the database and
 * every bit of it is still reachable through Muse's doors; what came out is the
 * SCREENS, because the app is being retired as an interface and what remains is
 * what he wants to glance at on a phone.
 */
export type TabKey = "bills" | "accounts" | "budget";

const TABS: { key: TabKey; label: string; Icon: LucideIcon }[] = [
  { key: "bills", label: "Bills", Icon: Receipt },
  { key: "accounts", label: "Accounts", Icon: Landmark },
  { key: "budget", label: "Budget", Icon: PieChart },
];

export function TabNav({ active, onTab }: { active: TabKey; onTab: (t: TabKey) => void }) {
  return (
    // `justify-around` sized each button to its own TEXT, so the targets measured
    // 29–36px wide with dead gutters between them — on the most-used control in the
    // app, at the bottom of a phone, where a thumb lands approximately. An
    // equal-column grid gives every tab the same share of the full width and leaves
    // no gap that does nothing. Three columns now, not four.
    //
    // Every colour is a token, so the bar follows light and dark with no second
    // code path. The hairline above it is the separator token, which is the same
    // line the grouped lists use — one rule for every edge in the app.
    <nav
      className="grid grid-cols-3 border-t pt-1.5"
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
            className={`flex min-h-[48px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition active:scale-95 ${
              on ? "text-accent" : "text-faint"
            }`}
          >
            <Icon size={23} strokeWidth={1.6} />
            <span>{t(label)}</span>
          </button>
        );
      })}
    </nav>
  );
}
