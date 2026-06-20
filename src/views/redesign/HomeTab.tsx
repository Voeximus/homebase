import { ChevronRight, ArrowRight, Flame, Wallet, Target, Receipt } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon, conicFromSegments } from "../../lib/catColor";
import { t } from "../../lib/i18n";
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
}

export function HomeTab({ vm, taps = {} }: { vm: HomeVM; taps?: Taps }) {
  const donutSegs = vm.donut.map((d) => ({ color: catColor(d.catId), value: d.amount }));
  return (
    <div className="flex flex-col gap-0">
      {/* ── Gradient hero ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="rounded-b-[26px] px-6 pb-5 pt-4 text-white"
      >
        <div className="flex items-center gap-1.5 text-[12px] opacity-90">
          {t("free to fire at debt · this month")}
        </div>
        <div className="mt-0.5 flex items-end justify-between">
          <div className="text-[40px] font-bold leading-none tracking-tight">
            {money(vm.firepower)}
          </div>
          <div className="pb-1 text-[12px] opacity-90">{t("debt-free {date}", { date: vm.debtFreeBy })}</div>
        </div>
        {vm.overspent > 0 && (
          <div
            className="mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: "rgba(0,0,0,0.18)", color: "#ffe0c2" }}
          >
            {t("−{amount} · over budget this month", { amount: money(vm.overspent) })}
          </div>
        )}
      </div>

      {/* ── Bento grid ── */}
      <div className="grid grid-cols-2 gap-3 p-4">
        {/* Cash */}
        <button
          onClick={taps.onCash}
          className="rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#13211a", borderColor: "#1f3a2c" }}
        >
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "#46d18a" }}>
            <Wallet size={14} /> {t("Cash")}
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-bone">{money(vm.cash)}</div>
          {vm.processing > 0 ? (
            <div className="mt-0.5 text-[11px] font-medium" style={{ color: "#d9a441" }}>
              {t("~{amount} waiting to post", { amount: money2(vm.processing) })}
            </div>
          ) : (
            <div className="mt-0.5 text-[11px]" style={{ color: "#7e8a98" }}>
              {t("{n} accounts", { n: vm.cashAccounts })}
            </div>
          )}
        </button>

        {/* Debt */}
        <button
          onClick={taps.onDebt}
          className="rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#15172b", borderColor: "#282a4a" }}
        >
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "#818cf8" }}>
            <Flame size={14} /> {t("Debt left")}
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-bone">{money(vm.debtLeft)}</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "#222b38" }}>
            <div
              className="h-full"
              style={{
                width: `${vm.debtProgressPct}%`,
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
              style={{ background: conicFromSegments(donutSegs) }}
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
              <span className="text-[13.5px] font-semibold text-bone">{t("Budget")}</span>
              <span className="text-[11.5px] text-taupe">
                {t("of {amount}", { amount: money(vm.budgetTarget) })}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: "#222b38" }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (vm.budgetSpent / vm.budgetTarget) * 100)}%`,
                  background:
                    vm.budgetSpent <= vm.budgetTarget
                      ? "linear-gradient(90deg,#22c55e,#46d18a)"
                      : "#f0556e",
                }}
              />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-[11.5px]">
              <span style={{ color: vm.budgetSpent <= vm.budgetTarget ? "#46d18a" : "#f0556e" }}>
                {vm.budgetSpent <= vm.budgetTarget ? t("on track") : t("over")}
              </span>
              <span className="text-taupe">
                {t("{amount} left", { amount: money(Math.max(0, vm.budgetTarget - vm.budgetSpent)) })}
              </span>
            </div>
          </div>
          <ChevronRight size={18} style={{ color: "#6b7686" }} />
        </button>

        {/* Next move (full width, gradient) */}
        <button
          onClick={taps.onNext}
          className="col-span-2 flex items-center justify-between rounded-[18px] p-4 text-left text-white transition active:scale-[0.98]"
          style={{ background: "linear-gradient(150deg,#0e7490,#1d4ed8)" }}
        >
          <div>
            <div className="flex items-center gap-1.5 text-[11.5px] opacity-90">
              <Target size={14} /> {t("Next move · {date} payday", { date: vm.nextDate })}
            </div>
            <div className="mt-1.5 text-[22px] font-bold">
              {t("Send {amount} at the debt", { amount: money(vm.nextAmount) })}
            </div>
          </div>
          <ArrowRight size={22} />
        </button>

        {/* Bills — critical daily glance */}
        <button
          onClick={taps.onBills}
          className="col-span-2 flex items-center gap-3 rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#2a2016", color: "#fb923c" }}
          >
            <Receipt size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13.5px] font-semibold text-bone">{t("Bills")}</span>
              <span className="text-[12px]" style={{ color: "#8b97a6" }}>
                {t("{amount} left", { amount: money(vm.bills.left) })}
              </span>
            </div>
            <div className="truncate text-[11.5px]" style={{ color: "#7e8a98" }}>
              {t("next: {name} · {date}", { name: vm.bills.nextName, date: vm.bills.nextDate })}
            </div>
          </div>
          <ChevronRight size={18} style={{ color: "#6b7686" }} />
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
              <div className="text-[12px]" style={{ color: "#9aa6b2" }}>
                {t("{n} buys ran higher than usual", { n: vm.anomalyCount })}
              </div>
            </div>
            <ChevronRight size={18} style={{ color: "#6b7686" }} />
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
            <span className="text-[12px]" style={{ color: "#9aa6b2" }}>
              {t("{amount} since Mon", { amount: money(vm.sinceMonday) })}
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
                    <div className="text-[11px]" style={{ color: "#7e8a98" }}>
                      {r.sub}
                    </div>
                  </div>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: r.income ? "#46d18a" : "#e6edf3" }}
                  >
                    {r.income ? "+" : "-"}
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
