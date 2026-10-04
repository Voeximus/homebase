import { t } from "../../lib/i18n";
import { Bar, Card, Chip, Hero, LimePill, ROW_SEP, SectionTitle } from "./kit";

const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

export interface InsightsVM {
  budgetSpent: number;
  budgetCycleLabel: string;
  budgetCycleDay: number;
  budgetCycleDays: number;
  budgetTarget: number;
  donut: { catId: string; amount: number }[];
  categories: { catId: string; label: string; spent: number; target: number }[];
  income: number;
  living: number;
  variable: number;
  atDebt: number;
  debtFreeBy: string;
  monthsToGo: number;
  interest: number;
  ladder: { rank: number; name: string; amount: number; live?: boolean; apr?: number; target?: boolean }[];
}

interface InsightsTaps {
  onCategory?: (catId: string) => void;
}

// ── The Budget screen ────────────────────────────────────────────────────────
//
// The closest of the three to his reference, which had a Budgets screen of its
// own: a ring in the black card, then one card per category with a letter chip
// and a bar. Every figure comes from `vms.insights`, built by the single composed
// firepowerStatus call in buildVMs; this file does no arithmetic beyond turning
// two numbers into an arc length and a bar width.
//
// THE RING IS THE ONE PLACE THE LIME IS A STROKE rather than a fill, and it is
// legal because it is drawn on the hero card, where it measures 13.4:1. On the
// cream page it would be 1.27:1 and invisible — which is why every bar below is
// the ink instead.

const R = 38;
const CIRC = 2 * Math.PI * R;

function Ring({ pct }: { pct: number }) {
  const shown = Math.max(0, Math.min(100, pct));
  return (
    <div className="relative h-[92px] w-[92px] shrink-0">
      <svg width="92" height="92" viewBox="0 0 92 92" role="img"
           aria-label={t("{n} percent of the budget spent", { n: Math.round(shown) })}>
        <circle cx="46" cy="46" r={R} fill="none" stroke="var(--color-edgehero)" strokeWidth="11" />
        <circle
          cx="46" cy="46" r={R} fill="none"
          stroke={shown > 100 - 0.01 ? "var(--color-ember)" : "var(--color-lime)"}
          strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${(shown / 100) * CIRC} ${CIRC}`}
          transform="rotate(-90 46 46)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[20px] font-bold leading-none tabular-nums">{Math.round(shown)}%</span>
        <span className="mt-px text-[10px]" style={{ opacity: 0.62 }}>{t("spent")}</span>
      </div>
    </div>
  );
}

export function InsightsTab({ vm, taps = {} }: { vm: InsightsVM; taps?: InsightsTaps }) {
  const left = vm.budgetTarget - vm.budgetSpent;
  const over = left < 0;
  const pct = vm.budgetTarget > 0 ? (vm.budgetSpent / vm.budgetTarget) * 100 : 0;
  const daysLeft = Math.max(0, vm.budgetCycleDays - vm.budgetCycleDay);
  const perDay = daysLeft > 0 ? left / daysLeft : left;
  const rows = [...vm.categories].sort((a, b) => b.spent - a.spent);

  return (
    <div className="pb-2">
      <header className="px-5 pt-1">
        <p className="text-[13px] text-taupe">
          {vm.budgetCycleLabel} ·{" "}
          {t("day {n} of {d}", { n: vm.budgetCycleDay, d: vm.budgetCycleDays })}
        </p>
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-bone">
          {t("Budget")}
        </h1>
      </header>

      <div className="mt-3.5">
        <Hero>
          <div className="flex items-center gap-[18px]">
            <Ring pct={pct} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px]" style={{ opacity: 0.66 }}>
                {over ? t("Over by") : t("Left to spend")}
              </div>
              <div
                className="mt-0.5 text-[32px] font-bold leading-[1.05] tracking-[-0.03em] tabular-nums"
                style={over ? { color: "var(--color-ember)" } : undefined}
              >
                {money0(Math.abs(left))}
              </div>
              <div className="mt-[3px] text-[12.5px]" style={{ opacity: 0.62 }}>
                {t("{spent} of {target}", {
                  spent: money0(vm.budgetSpent),
                  target: money0(vm.budgetTarget),
                })}
              </div>
              {!over && daysLeft > 0 && (
                <div className="mt-[7px]">
                  <LimePill>
                    {t("{n} days · ~{amount}/day", { n: daysLeft, amount: money0(perDay) })}
                  </LimePill>
                </div>
              )}
            </div>
          </div>
        </Hero>
      </div>

      <SectionTitle aside={vm.budgetCycleLabel}>{t("Categories")}</SectionTitle>
      <div className="mt-[9px] flex flex-col gap-2">
        {rows.map((c) => {
          const cOver = c.spent > c.target;
          return (
            <Card key={c.catId} className="!rounded-[18px]">
              <button
                onClick={() => taps.onCategory?.(c.catId)}
                className="block w-full px-[14px] py-3 text-left"
              >
                <div className="flex items-center gap-[11px]">
                  <Chip name={c.label} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-semibold text-bone">
                      {c.label}
                    </span>
                    <span className="mt-px block text-[12px] text-taupe tabular-nums">
                      {t("{spent} of {target}", {
                        spent: money0(c.spent),
                        target: money0(c.target),
                      })}
                    </span>
                  </span>
                  <span
                    className={`text-[14px] font-semibold tabular-nums ${cOver ? "text-ember" : "text-bone"}`}
                  >
                    {cOver
                      ? t("{amount} over", { amount: money0(c.spent - c.target) })
                      : t("{amount} left", { amount: money0(c.target - c.spent) })}
                  </span>
                </div>
                <Bar pct={c.target > 0 ? (c.spent / c.target) * 100 : 0} over={cOver} />
              </button>
            </Card>
          );
        })}
      </div>

      <SectionTitle>{t("The month")}</SectionTitle>
      <Card className="mt-[9px]">
        {[
          { k: t("Coming in"), v: money0(vm.income) },
          { k: t("Fixed living cost"), v: money0(vm.living) },
          { k: t("Free to aim at the debt"), v: money0(vm.atDebt) },
        ].map((r, i, arr) => (
          <div
            key={r.k}
            className="flex items-baseline gap-3 px-[14px] py-3"
            style={i === arr.length - 1 ? undefined : ROW_SEP}
          >
            <span className="min-w-0 flex-1 text-[15px] text-bone">{r.k}</span>
            <span className="text-[15px] font-semibold tabular-nums text-bone">{r.v}</span>
          </div>
        ))}
      </Card>
      <p className="mt-2 px-5 text-[12.5px] text-taupe">
        {/* The door's own warning, kept word-for-word on the screen that shows the
            number: the household's cash floor is not in this figure. */}
        {t("What is free to aim at the debt — not what is safe to spend.")}
      </p>

      {vm.ladder.length > 0 && (
        <>
          <SectionTitle aside={vm.debtFreeBy === "—" ? undefined : vm.debtFreeBy}>
            {vm.debtFreeBy === "—" ? t("Payoff order") : t("Debt free")}
          </SectionTitle>
          <Card className="mt-[9px]">
            {vm.ladder.map((d, i) => (
              <div
                key={d.name + d.rank}
                className="flex items-center gap-[11px] px-[14px] py-3"
                style={i === vm.ladder.length - 1 ? undefined : ROW_SEP}
              >
                <Chip name={d.name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold text-bone">
                    {d.name}
                  </span>
                  {d.apr != null && (
                    <span className="mt-px block text-[12px] text-taupe tabular-nums">
                      {d.apr}% APR
                    </span>
                  )}
                </span>
                <span className="text-[14px] font-semibold tabular-nums text-bone">
                  {money0(d.amount)}
                </span>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
