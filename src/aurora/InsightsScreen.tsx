// Insights — reference-html/05-insights-month.html, pushed from Activity's
// "Spent this week" card or Home's "Left this week" (decision 2's default).
//
// Homebase grades its budget over a PAY CYCLE, not a calendar month (Gino's rule:
// money lands on the 15th and the last day), so the ring is the cycle in progress:
// the same six lines, spends and targets the budget bars have always shown.

import { t } from "../lib/i18n";
import { AuroraBackground, IconButton, SpendingRing, useKeptScroll } from "./components";
import { Icon } from "./icons";
import { rgba } from "./adapt";
import { sayInsight } from "./say";
import { money0, type Insight } from "./logic";

export interface InsightsScreenVM {
  title: string;
  day: number;
  days: number;
  cats: { key: string; name: string; spent: number; plan: number; colour: string }[];
  totalPlan: number;
  totalSpent: number;
  insight: Insight | null;
  insightKey: string | null;
}

export function InsightsScreen({
  vm,
  taps,
}: {
  vm: InsightsScreenVM;
  taps: { onBack: () => void; onCategory: (key: string) => void };
}) {
  const scroll = useKeptScroll("insights");
  // Decided in cents, so a cycle a few cents under its plan never reads "$0 over".
  const leftCents = Math.round(vm.totalPlan * 100) - Math.round(vm.totalSpent * 100);
  const over = leftCents < 0;
  const ringLabel =
    `${vm.title}: ${money0(vm.totalSpent)} ${t("spent of")} ${money0(vm.totalPlan)}. ` +
    vm.cats.map((c) => `${t(c.name)} ${money0(c.spent)}`).join(", ") +
    ".";
  const everyOnPace = !vm.insight && vm.day > 3;
  const said = vm.insight ? sayInsight(vm.insight) : null;
  // The reference title is 30px; a cycle that crosses a month ("Oct 31 – Nov 14")
  // steps down rather than running into "Day n of N".
  const long = vm.title.length > 11;
  return (
    <>
      <AuroraBackground preset="month" />
      <div className="au-scroll" ref={scroll}>
        <main className="au-main">
          <header className="au-header au-header--baseline">
            <span className="au-title-row au-title-row--baseline">
              <IconButton icon="chevron-left" label={t("Back")} onClick={taps.onBack} />
              <h1 className={long ? "au-title au-title--fit au-title--sm" : "au-title au-title--fit"} tabIndex={-1} data-au-focus="">
                {vm.title}
              </h1>
            </span>
            <p style={{ flex: "none", fontSize: 14, color: "var(--au-color-text-2)", whiteSpace: "nowrap" }}>
              {t("Day {n} of {total}", { n: vm.day, total: vm.days })}
            </p>
          </header>

          <SpendingRing cats={vm.cats} totalPlan={vm.totalPlan} label={ringLabel}>
            <p className="au-display-md">{money0(vm.totalSpent)}</p>
            <p style={{ fontSize: 14, color: "var(--au-color-text-2)" }}>
              {vm.totalPlan > 0 ? t("spent of {amount}", { amount: money0(vm.totalPlan) }) : t("spent")}
            </p>
            <p className={over ? "au-ring-chip au-ring-chip--over" : "au-ring-chip"}>
              {vm.totalPlan <= 0
                ? t("No plan yet")
                : over
                  ? t("{amount} over", { amount: money0(-leftCents / 100) })
                  : t("{amount} left", { amount: money0(leftCents / 100) })}
            </p>
          </SpendingRing>

          <ul className="au-legend" aria-label={t("Spending by category")}>
            {vm.cats.map((c) => (
              <li key={c.key}>
                <button onClick={() => taps.onCategory(c.key)} aria-label={`${t(c.name)}, ${money0(c.spent)}`}>
                  <span
                    className="au-legend-dot"
                    aria-hidden="true"
                    style={{ background: c.colour, boxShadow: c.colour === "#C4C6D4" ? undefined : `0 0 8px ${rgba(c.colour, 0.7)}` }}
                  />
                  <span className="au-legend-name">{t(c.name)}</span>
                  <span className="au-legend-amt">{money0(c.spent)}</span>
                </button>
              </li>
            ))}
          </ul>

          {said && vm.insightKey ? (
            <section className="au-glass au-tip" aria-labelledby="au-tip">
              <span className="au-tip-disc" aria-hidden="true" style={{ background: "rgba(155,140,255,0.16)", color: "#B7ACFF" }}>
                <Icon name="sparkle" size={18} />
              </span>
              <div className="au-tip-body">
                <h2 id="au-tip" className="au-tip-title">
                  {said.title}
                </h2>
                <p className="au-tip-text">{said.body}</p>
              </div>
              <IconButton
                icon="chevron-right"
                soft
                label={t("Open {name}", { name: t(vm.insight!.category) })}
                onClick={() => taps.onCategory(vm.insightKey!)}
              />
            </section>
          ) : everyOnPace ? (
            <section className="au-glass au-tip">
              <span className="au-tip-disc" aria-hidden="true" style={{ background: "rgba(59,224,207,0.14)", color: "#3BE0CF" }}>
                <Icon name="check" size={18} />
              </span>
              <div className="au-tip-body">
                <h2 className="au-tip-title">{t("Every category is on pace")}</h2>
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </>
  );
}
