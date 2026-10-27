// Goals — reference-html/07-goals.html, with the household's DEBTS as the goals.
//
// Homebase has no savings goals (savings_goals is empty); what it fills every
// payday is the payoff plan. So each debt is a goal: its ring is how much of it is
// paid, its date is the payday the plan clears it (the same schedule the payoff
// ladder reads — never a second estimate), and the payday card is what the next
// payday sends.

import { t } from "../lib/i18n";
import { AuroraBackground, GoalRing, useKeptScroll } from "./components";
import { Icon } from "./icons";
import { CHIP_TEXT, rgba } from "./adapt";
import { etaDate, money0, shortDate } from "./logic";

export interface GoalsScreenVM {
  today: string;
  debtLeft: number;
  paidThisMonth: number;
  debts: { id: string; name: string; balance: number; original: number; colour: string; clearsOn: string | null }[];
  next: { date: string; total: number; chips: { key: string; label: string; amount: number; colour: string }[] } | null;
}

export function GoalsScreen({ vm, taps }: { vm: GoalsScreenVM; taps: { onPlan: () => void } }) {
  const scroll = useKeptScroll("goals");
  const total = vm.debts.reduce((s, d) => s + d.balance, 0);
  const share = [...vm.debts]
    .filter((d) => d.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .map((d) => `${d.name} ${total > 0 ? Math.round((d.balance / total) * 100) : 0}%`)
    .join(", ");
  return (
    <>
      <AuroraBackground preset="goals" />
      <div className="au-scroll" ref={scroll}>
        <main className="au-main">
          <header className="au-header">
            <h1 className="au-title" tabIndex={-1} data-au-focus="">
              {t("Goals")}
            </h1>
            <button className="au-pillbtn" onClick={taps.onPlan}>
              <Icon name="goals" size={18} />
              {t("Payoff plan")}
            </button>
          </header>

          {vm.debts.length === 0 ? (
            <section style={{ marginTop: 48, display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
              <GoalRing pct={1} colour="#3BE0CF" done />
              <h2 style={{ fontSize: 22, fontWeight: 400, letterSpacing: "-0.01em" }}>{t("Debt free")}</h2>
              <p style={{ fontSize: 15, color: "var(--au-color-text-2)" }}>{t("Every debt is paid off.")}</p>
            </section>
          ) : (
            <>
              <section className="au-totals">
                <h2 className="au-hero-label" style={{ letterSpacing: 0 }}>
                  {t("Debt left")}
                </h2>
                <p className="au-display-lg">{money0(vm.debtLeft)}</p>
                <p className="au-totals-sub" style={vm.paidThisMonth > 0 ? undefined : { color: "var(--au-color-text-3)" }}>
                  {vm.paidThisMonth > 0
                    ? t("{amount} paid this month", { amount: `+${money0(vm.paidThisMonth)}` })
                    : t("Nothing paid yet this month")}
                </p>
              </section>

              <div className="au-share" role="img" aria-label={`${t("Share of what is left")}: ${share}.`}>
                {/* Largest first (screens/07: "sorted ... largest first"); the rows
                    below keep the plan's attack order. */}
                {[...vm.debts]
                  .filter((d) => d.balance > 0)
                  .sort((a, b) => b.balance - a.balance)
                  .map((d) => (
                    <span key={d.id} style={{ flex: `${d.balance} 0 0`, background: d.colour, boxShadow: `0 0 12px ${rgba(d.colour, 0.6)}` }} />
                  ))}
              </div>

              <ul className="au-goals" aria-label={t("Your debts")}>
                {vm.debts.map((d) => {
                  const paid = d.original > 0 ? (d.original - d.balance) / d.original : 0;
                  const done = d.balance <= 0;
                  const when = d.clearsOn ? etaDate(d.clearsOn, vm.today) : null;
                  return (
                    <li key={d.id}>
                      <button
                        className="au-glass au-goal"
                        onClick={taps.onPlan}
                        aria-label={
                          t("{name}, {pct}% paid, {left} left of {total}", {
                            name: d.name,
                            pct: Math.round(paid * 100),
                            left: money0(d.balance),
                            total: money0(d.original),
                          }) + (when ? `, ${t("paid off by")} ${when}` : "")
                        }
                      >
                        <GoalRing pct={done ? 1 : paid} colour={d.colour} done={done} />
                        <span className="au-goal-mid">
                          <span className="au-goal-name">{d.name}</span>
                          <span className="au-goal-sub">
                            {t("{left} left of {total}", { left: money0(d.balance), total: money0(d.original) })}
                          </span>
                        </span>
                        <span className="au-goal-end">
                          {done ? (
                            <span className="au-goal-eta" style={{ color: "var(--au-color-teal-text)" }}>
                              {t("Done")}
                            </span>
                          ) : when ? (
                            <>
                              <span className="au-goal-eta">{when}</span>
                              <span className="au-goal-eta-sub">{t("paid off by")}</span>
                            </>
                          ) : (
                            <>
                              <span className="au-goal-eta" style={{ color: "var(--au-color-rose-text)" }}>
                                {t("Waiting")}
                              </span>
                              <span className="au-goal-eta-sub">{t("not in the plan yet")}</span>
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <section className="au-glass au-payday" aria-labelledby="au-next">
                <div className="au-payday-col">
                  <h2 id="au-next" className="au-list-title">
                    {vm.next
                      ? t("Payday on {date} sends {amount}", { date: shortDate(vm.next.date), amount: money0(vm.next.total) })
                      : t("Nothing is set to go at the debts")}
                  </h2>
                  {vm.next && (
                    <div className="au-payday-chips">
                      {vm.next.chips.map((c) => (
                        <span key={c.key} className="au-chip" style={{ background: rgba(c.colour, 0.16), color: CHIP_TEXT[c.colour] ?? "#E4E5EE" }}>
                          {money0(c.amount)} {c.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button className="au-btn au-btn--ghost" onClick={taps.onPlan}>
                  {t("Plan")}
                </button>
              </section>
            </>
          )}
        </main>
      </div>
    </>
  );
}
