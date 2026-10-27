// Home — Original (decision 1, 2026-10-26). reference-html/01-home-original.html.
//
// One change from the mock, by decision 2: the left stat card is "Left this week"
// from the household's weekly plan, not the design's daily "Safe to spend today"
// (Gino retired the daily allowance on 2026-10-25 as "annoying, almost inaccurate").

import { t } from "../lib/i18n";
import { AuroraBackground, AvatarButton, ForecastChart, HeroAmount, ListRow, StatusPill, useKeptScroll } from "./components";
import { iconFor } from "./adapt";
import { sayPill } from "./say";
import { daysBetween, money0, money2, rowDate, shortDate, weekday, type ForecastDay, type StatusPillResult } from "./logic";

export interface ComingUpBill {
  id: string;
  name: string;
  date: string;
  amount: number;
  catId: string;
  overdue: boolean;
  onCard: boolean;
  recurringId?: string;
  day: number;
  monthKey: string;
  variable: boolean;
}

export interface HomeScreenVM {
  greeting: string;
  balance: number;
  pill: StatusPillResult;
  forecast: ForecastDay[];
  today: string;
  payday: string | null;
  week: { plan: number; left: number; over: boolean; daysLeft: number };
  comingUp: ComingUpBill[];
  /** Things the app wants seen that have no place in the mock (unusual buys, money
   *  owed back). Shown as one more list card, only when there is something. */
  notices: { id: string; title: string; sub: string; amount: string; tone?: "rose" | "teal"; onClick: () => void }[];
}

export function HomeScreen({
  vm,
  taps,
}: {
  vm: HomeScreenVM;
  taps: {
    onProfile: () => void;
    onBalance?: () => void;
    onBills: () => void;
    /** A Coming-up row: open that bill to pay or mark it — even one from last month. */
    onBill: (b: ComingUpBill) => void;
    onWeek: () => void;
  };
}) {
  const scroll = useKeptScroll("home");
  const daysToPay = vm.payday ? daysBetween(vm.today, vm.payday) : null;
  const weekValue = vm.week.over ? money0(vm.week.left) : money0(Math.max(0, vm.week.left));
  return (
    <>
      <AuroraBackground preset="home" />
      <div className="au-scroll" ref={scroll}>
        <main className="au-main">
          <header className="au-header">
            <p className="au-greeting" tabIndex={-1} data-au-focus="">
              {t(vm.greeting)}
            </p>
            <AvatarButton onClick={taps.onProfile} />
          </header>

          <section style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Tapping the balance opens the accounts behind it (the old Cash tile's job). */}
            <button
              onClick={taps.onBalance}
              style={{ display: "flex", flexDirection: "column", gap: 6, background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer", alignSelf: "flex-start" }}
            >
              <span className="au-hero-label">{t("In checking")}</span>
              <HeroAmount value={vm.balance} />
            </button>
            <StatusPill tone={vm.pill.tone} text={sayPill(vm.pill.text)} />
          </section>

          {vm.forecast.length > 1 ? (
            <ForecastChart days={vm.forecast} />
          ) : (
            <section className="au-glass" style={{ marginTop: 18, padding: "16px 18px", fontSize: 15, color: "var(--au-color-text-2)" }}>
              {t("Add your payday to see where your money is heading")}
            </section>
          )}

          <div className="au-stats" style={{ marginTop: 18 }}>
            <button
              className="au-glass au-stat"
              onClick={taps.onWeek}
              aria-label={`${t("Left this week")}, ${weekValue}, ${t("of {amount} this week", { amount: money0(vm.week.plan) })}`}
            >
              <span className="au-stat-label">{t("Left this week")}</span>
              <span className="au-stat-value" style={vm.week.over ? { color: "var(--au-color-rose-text)" } : undefined}>
                {weekValue}
              </span>
              <span className="au-stat-sub">{t("of {amount} this week", { amount: money0(vm.week.plan) })}</span>
            </button>
            {vm.payday && daysToPay != null && (
              <section
                className="au-glass au-stat"
                role="group"
                aria-label={`${t("Next payday")}, ${daysToPay} ${daysToPay === 1 ? t("day") : t("days")}, ${weekday(vm.payday)} ${shortDate(vm.payday)}`}
              >
                <span className="au-stat-label">{t("Next payday")}</span>
                <span className="au-stat-value">
                  {daysToPay} {daysToPay === 1 ? t("day") : t("days")}
                </span>
                <span className="au-stat-sub">{rowDate(vm.payday)}</span>
              </section>
            )}
          </div>

          <section className="au-glass au-list" aria-labelledby="au-up" style={{ marginTop: 12 }}>
            <div className="au-list-head">
              <h2 id="au-up" className="au-list-title">
                {t("Coming up")}
              </h2>
              <button className="au-link" onClick={taps.onBills}>
                {t("See all")}
              </button>
            </div>
            <ul className="au-rows">
              {vm.comingUp.length === 0 ? (
                <li className="au-row au-row--static">
                  <span className="au-row-empty">{t("Nothing due in the next 30 days")}</span>
                </li>
              ) : (
                vm.comingUp.map((b) => {
                  const when = b.overdue ? t("Overdue · {date}", { date: rowDate(b.date) }) : rowDate(b.date);
                  const sub = b.onCard ? t("{date} · on card", { date: when }) : when;
                  return (
                    <ListRow
                      key={b.id}
                      disc={iconFor(b.catId, b.name)}
                      title={b.name}
                      sub={sub}
                      subTone={b.overdue ? "rose" : undefined}
                      amount={money2(b.amount)}
                      onClick={() => taps.onBill(b)}
                      label={`${b.name}, ${sub}, ${money2(b.amount)}`}
                    />
                  );
                })
              )}
            </ul>
          </section>

          {vm.notices.length > 0 && (
            <section className="au-glass au-list au-list--rows" aria-label={t("Worth a look")} style={{ marginTop: 12 }}>
              <ul className="au-rows">
                {vm.notices.map((n) => (
                  <ListRow
                    key={n.id}
                    disc={n.tone === "teal" ? iconFor("salary") : { icon: "sparkle", fg: "#FF9CC8", bg: "rgba(255,122,182,0.14)", glow: "" }}
                    title={n.title}
                    sub={n.sub}
                    amount={n.amount}
                    amountTone={n.tone}
                    onClick={n.onClick}
                  />
                ))}
              </ul>
            </section>
          )}
        </main>
      </div>
    </>
  );
}
