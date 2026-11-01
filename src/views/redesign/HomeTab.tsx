import { ChevronRight, Flame, Wallet, Receipt } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon, conicFromSegments, gaugeSegs } from "../../lib/catColor";
import { t } from "../../lib/i18n";
import { barPct, budgetVerdict } from "./barPct";
import type { HomeVM } from "./vm";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Taps {
  onCash?: () => void;
  onDebt?: () => void;
  onBudget?: () => void;
  onNext?: () => void;
  onBills?: () => void;
  onAnomaly?: () => void;
  onRecent?: () => void;
  onOwed?: () => void;
}

export function HomeTab({ vm, taps = {} }: { vm: HomeVM; taps?: Taps }) {
  const donutSegs = vm.donut.map((d) => ({ color: catColor(d.catId), value: d.amount }));
  const verdict = budgetVerdict(vm.budgetSpent, vm.budgetTarget, vm.budgetCycleDay, vm.budgetCycleDays);
  const payoff = vm.payoff;
  // How far the last three months ran over budget a month: measured, beside the date,
  // never moving it. 0 when within budget, and for the states with no plan to date.
  const overBy = payoff.kind === "plan" || payoff.kind === "short" ? payoff.overBy : 0;
  const overdue = vm.bills.overdue ?? 0;
  return (
    <div className="flex flex-col gap-0">
      {/* ── Gradient hero — debt tracking ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="rounded-b-[26px] px-6 pb-5 pt-4 text-white"
      >
        {/* Pure white on the deepened BRAND_GRADIENT: at 90% opacity on the old,
            brighter stops these labels measured about 2.3:1. */}
        <div className="flex items-center gap-1.5 text-[12px]">{t("debt left")}</div>
        <div className="mt-0.5 flex items-end justify-between">
          <div className="text-[40px] font-bold leading-none tracking-tight">{money(vm.debtLeft)}</div>
          <div className="pb-1 text-[12px]">
            {t("{pct}% cleared", { pct: Math.round(vm.debtProgressPct) })}
          </div>
        </div>
        {vm.deployedThisCycle > 0 && (
          <div className="mt-1.5 text-[12.5px]">
            {t("deployed {amount} at debt this cycle", { amount: money(vm.deployedThisCycle) })}
          </div>
        )}
        {vm.overspent > 0 && (
          <div
            className="mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: "rgba(0,0,0,0.18)", color: "#ffe0c2" }}
          >
            {t("−{amount} · over budget this cycle", { amount: money(vm.overspent) })}
          </div>
        )}
      </div>

      {/* ── Owed to you (reimbursable set-asides still outstanding) ── */}
      {vm.owedToYou > 0 && (
        <button
          onClick={taps.onOwed}
          className="mx-4 mt-3 flex items-center justify-between rounded-[16px] border px-4 py-3 text-left transition active:scale-[0.99]"
          style={{ background: "#13211a", borderColor: "#1f3a2c" }}
        >
          <span className="text-[12.5px] font-medium" style={{ color: "#46d18a" }}>
            {t("Owed to you")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[18px] font-bold text-bone">{money2(vm.owedToYou)}</span>
            <ChevronRight size={16} style={{ color: "var(--color-faint)" }} />
          </span>
        </button>
      )}

      {/* ── Bento grid ── */}
      <div className="grid grid-cols-2 gap-3 p-4">
        {/* Cash. flex-col on both tiles: a <button> centres its content, so the
            shorter Cash tile's label sat 7px lower than Payoff's in the same row. */}
        <button
          onClick={taps.onCash}
          className="flex flex-col rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#13211a", borderColor: "#1f3a2c" }}
        >
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "#46d18a" }}>
            <Wallet size={14} /> {t("Cash")}
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-bone">{money(vm.cash)}</div>
          {/* The balance is the bank's AVAILABLE figure: the holds are already taken
              out of it, not still to come off it. */}
          {vm.processing > 0 ? (
            <div className="mt-0.5 text-[11px] font-medium" style={{ color: "#e3b341" }}>
              {t("after {amount} still processing", { amount: money(vm.processing) })}
            </div>
          ) : (
            <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-faint)" }}>
              {vm.cashAccounts === 1 ? t("1 account") : t("{n} accounts", { n: vm.cashAccounts })}
            </div>
          )}
        </button>

        {/* Debt */}
        <button
          onClick={taps.onDebt}
          className="flex flex-col rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#15172b", borderColor: "#282a4a" }}
        >
          {/* This tile used to print money(vm.debtLeft) and vm.debtProgressPct —
              the SAME two facts the gradient hero states 150px above it, in the
              same units. Two of the four slots on the home screen were spent
              saying one thing twice.

              The hero keeps the headline. The tile keeps the bar (a % you can
              see beats a % you have to read) and now carries the two debt facts
              that were on no screen at all: when it is gone, and what leaves on
              payday. Both were already on the view-model, unused. */}
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "#818cf8" }}>
            <Flame size={14} /> {t("Payoff")}
          </div>
          {/* Always a real figure: the month the plan clears, with its condition
              ("if on budget") under it. Never a bare "—", never "no date".
              break-keep: Chinese may break between any two characters, so on a
              narrow phone a month split as "2026年10" / "月". It still wraps at a
              space ("Pay not set", "每月 $1,234"). */}
          <div className="mt-1.5 break-keep text-[22px] font-bold text-bone">
            {payoff.kind === "debtFree"
              ? t("Debt-free")
              : payoff.kind === "noPay"
                ? t("Pay not set")
                : payoff.kind === "plan"
                  ? payoff.date
                  : t("{amount}/mo", { amount: money(payoff.shortBy) })}
          </div>
          <div
            className="mt-0.5 text-[11px]"
            style={{
              color:
                payoff.kind === "plan"
                  ? "var(--color-taupe)"
                  : payoff.kind === "short"
                    ? "#f0556e"
                    : "var(--color-faint)",
            }}
          >
            {payoff.kind === "debtFree"
              ? t("Nothing left to pay")
              : payoff.kind === "noPay"
                ? t("Add your paychecks")
                : payoff.kind === "plan"
                  ? t("if on budget")
                  : t("short, even on budget")}
          </div>
          {/* One more line only when there is something to say: how far over budget
              a month (amber, as the Cash tile's line), or else the next send. */}
          {overBy > 0 ? (
            <div className="mt-0.5 text-[11px] font-medium" style={{ color: "#e3b341" }}>
              {t("{amount}/mo over budget", { amount: money(overBy) })}
            </div>
          ) : payoff.kind === "plan" && payoff.nextAmount > 0 ? (
            <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-faint)" }}>
              {t("{amount} on {date}", { amount: money(payoff.nextAmount), date: payoff.nextDate })}
            </div>
          ) : null}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "#222b38" }}>
            <div
              className="h-full"
              style={{
                width: `${payoff.kind === "debtFree" ? 100 : vm.debtProgressPct}%`,
                background: "linear-gradient(90deg,#6366f1,#22d3ee)",
              }}
            />
          </div>
        </button>

        {/* Budget — full-width container (donut + spend-vs-target bar) */}
        <button
          onClick={taps.onBudget}
          className="col-span-2 flex items-center gap-4 rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="relative h-16 w-16 shrink-0">
            <div
              className="h-16 w-16 rounded-full"
              style={{ background: conicFromSegments(gaugeSegs(donutSegs, vm.budgetTarget), 0) }}
            />
            <div
              className="absolute inset-[10px] flex items-center justify-center rounded-full"
              style={{ background: "#141a24" }}
            >
              <span className="text-[13px] font-bold text-bone">{money(vm.budgetSpent)}</span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5">
                <span className="text-[13.5px] font-semibold text-bone">{t("This cycle")}</span>
                {/* Under Mine, these are still the household's figures — one plan. */}
                {vm.household && (
                  <span
                    className="rounded-full px-1.5 py-px text-[10px] font-medium text-taupe"
                    style={{ background: "#1d2530" }}
                  >
                    {t("Household")}
                  </span>
                )}
              </span>
              <span className="text-[11.5px] text-taupe">
                {t("of {amount}", { amount: money(vm.budgetTarget) })}
              </span>
            </div>
            {/* Which paycheck this budget belongs to, and how far through it you
                are — the pace check that makes a mid-cycle number actionable. */}
            <div className="text-[10.5px] text-taupe">
              {vm.budgetCycleLabel} · {t("day {n} of {total}", {
                n: vm.budgetCycleDay,
                total: vm.budgetCycleDays,
              })}
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: "#222b38" }}>
              <div
                className="h-full rounded-full"
                style={{
                  // barPct, not a bare division: a cycle's goal can set every line to 0.
                  width: `${barPct(vm.budgetSpent, vm.budgetTarget)}%`,
                  // Solid, like every other bar: no two-stop mini-gradient.
                  background: vm.budgetSpent <= vm.budgetTarget ? "#46d18a" : "#f0556e",
                }}
              />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-[11.5px]">
              <span
                style={{
                  color: verdict === "over" ? "#f0556e" : verdict === "ahead" ? "#e3b341" : "#46d18a",
                }}
              >
                {verdict === "over" ? t("over") : verdict === "ahead" ? t("ahead of pace") : t("on track")}
              </span>
              <span className="text-taupe">
                {t("{amount} left", { amount: money(Math.max(0, vm.budgetTarget - vm.budgetSpent)) })}
              </span>
            </div>
          </div>
          <ChevronRight size={18} style={{ color: "var(--color-faint)" }} />
        </button>

        {/* Bills — critical daily glance */}
        <button
          onClick={taps.onBills}
          className="col-span-2 flex items-center gap-3 rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
            style={{ background: "#fb923c26", color: "#fb923c" }}
          >
            <Receipt size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13.5px] font-semibold text-bone">{t("Bills")}</span>
              <span className="text-[12px]" style={{ color: "var(--color-taupe)" }}>
                {t("{amount} left", { amount: money(vm.bills.left) })}
              </span>
            </div>
            <div className="truncate text-[11.5px]" style={{ color: "var(--color-faint)" }}>
              {vm.bills.nextDate
                ? t("next: {name} · {date}", { name: vm.bills.nextName, date: vm.bills.nextDate })
                : t("Nothing else due before payday")}
              {overdue > 0 && (
                <span style={{ color: "#f0556e" }}>
                  {" · "}
                  {t("{amount} already overdue", { amount: money(overdue) })}
                </span>
              )}
            </div>
          </div>
          <ChevronRight size={18} style={{ color: "var(--color-faint)" }} />
        </button>

        {/* Anomaly alert */}
        {vm.anomalyCount > 0 && (
          <button
            onClick={taps.onAnomaly}
            className="col-span-2 flex items-center gap-3 rounded-[18px] border p-3.5 text-left transition active:scale-[0.98]"
            style={{ background: "#1a1320", borderColor: "#3a2230" }}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: "#f0556e" }}
            />
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ color: "#f4a6b6" }}>
                {t("Unusual purchases")}
              </div>
              <div className="text-[12px]" style={{ color: "var(--color-taupe)" }}>
                {vm.anomalyCount === 1
                  ? t("1 buy ran higher than usual")
                  : t("{n} buys ran higher than usual", { n: vm.anomalyCount })}
              </div>
            </div>
            <ChevronRight size={18} style={{ color: "var(--color-faint)" }} />
          </button>
        )}

        {/* Recent */}
        <button
          onClick={taps.onRecent}
          className="col-span-2 rounded-[18px] border p-3.5 text-left transition active:scale-[0.98]"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="eyebrow text-taupe">{t("Recent")}</span>
            <span className="text-[12px]" style={{ color: "var(--color-taupe)" }}>
              {t("{amount} this week", { amount: money(vm.spentThisWeek) })}
            </span>
          </div>
          <div className="flex flex-col gap-2.5">
            {vm.recent.slice(0, 3).map((r) => {
              const Icon = catIcon(r.catId);
              const c = r.income ? "#46d18a" : catColor(r.catId);
              return (
                <div key={r.id} className="flex items-center gap-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
                    style={{ background: c + "26", color: c }}
                  >
                    <Icon size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-bone">{r.merchant}</div>
                    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--color-faint)" }}>
                      {r.pending && <span className="font-semibold" style={{ color: "#e3b341" }}>◌ {t("Processing")}</span>}
                      {r.pending ? "" : r.sub}
                    </div>
                  </div>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: r.income ? "#46d18a" : "var(--color-bone)" }}
                  >
                    {/* U+2212, the true minus: as wide as "+" and set at digit height. */}
                    {r.income ? "+" : "−"}
                    {money2(r.amount)}
                  </span>
                </div>
              );
            })}
          </div>
        </button>
      </div>
      <div className="h-2" />
    </div>
  );
}
