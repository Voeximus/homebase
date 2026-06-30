import { useState } from "react";
import { ChevronRight, Flame, Wallet, Target, Receipt } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon, conicFromSegments } from "../../lib/catColor";
import { t } from "../../lib/i18n";
import type { HomeVM } from "./vm";
import type { CushionPreset } from "../../lib/plan";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortName = (n: string) => n.replace(/\s*\(.*\)$/, "").trim();

interface Taps {
  onCash?: () => void;
  onDebt?: () => void;
  onBudget?: () => void;
  onNext?: () => void;
  onBills?: () => void;
  onAnomaly?: () => void;
  onRecent?: () => void;
  onOwed?: () => void;
  onCushion?: (preset: CushionPreset) => void;
  onDeploy?: () => void;
}

export function HomeTab({ vm, taps = {} }: { vm: HomeVM; taps?: Taps }) {
  const donutSegs = vm.donut.map((d) => ({ color: catColor(d.catId), value: d.amount }));
  const [showMath, setShowMath] = useState(false);
  return (
    <div className="flex flex-col gap-0">
      {/* ── Gradient hero — Stage 1: Deploy now (cash-aware) ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="rounded-b-[26px] px-6 pb-5 pt-4 text-white"
      >
        <div className="flex items-center gap-1.5 text-[12px] opacity-90">
          {vm.deployNow > 0 ? t("deploy at debt · right now") : t("hold · right now")}
        </div>
        <div className="mt-0.5 flex items-end justify-between">
          <div className="text-[40px] font-bold leading-none tracking-tight">
            {money(vm.deployNow)}
          </div>
          <div className="pb-1 text-[12px] opacity-90">{t("debt-free {date}", { date: vm.debtFreeBy })}</div>
        </div>

        {/* what the lump clears — or, at $0, the honest reason why */}
        {vm.deployNow > 0 ? (
          (() => {
            const cleared = vm.deployedDebts.filter((d) => d.clears).map((d) => shortName(d.name));
            const label = cleared.length
              ? t("clears {names}", { names: cleared.join(" + ") })
              : vm.deployedDebts.length
                ? t("toward {name}", { name: shortName(vm.deployedDebts[0].name) })
                : "";
            return label ? <div className="mt-1.5 text-[12.5px] opacity-95">{label}</div> : null;
          })()
        ) : vm.shortfall > 0 ? (
          <div
            className="mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: "rgba(0,0,0,0.18)", color: "#ffe0c2" }}
          >
            {t("{short} under your {target} cushion — keep building", {
              short: money(vm.shortfall),
              target: money(vm.cushionAmount),
            })}
          </div>
        ) : (
          <div className="mt-1.5 text-[12.5px] opacity-90">{t("cushion funded — nothing to deploy yet")}</div>
        )}

        {/* collapsible math: cash − bills − cushion = deploy */}
        <button
          onClick={() => setShowMath((s) => !s)}
          className="mt-2 inline-flex items-center text-[11px] underline underline-offset-2 opacity-80"
        >
          {showMath ? t("hide math") : t("show math")}
        </button>
        {showMath && (
          <div className="mt-1.5 space-y-0.5 text-[11.5px] opacity-90">
            <div className="flex justify-between">
              <span>{t("cash on hand")}</span>
              <span>{money(vm.cash)}</span>
            </div>
            <div className="flex justify-between">
              <span>− {t("bills before payday")}</span>
              <span>{money(vm.billsHoldback)}</span>
            </div>
            <div className="flex justify-between">
              <span>− {t("cushion ({preset})", { preset: vm.cushion })}</span>
              <span>{money(vm.cushionAmount)}</span>
            </div>
            <div className="mt-0.5 flex justify-between border-t border-white/25 pt-0.5 font-semibold">
              <span>{t("deploy now")}</span>
              <span>{money(vm.deployNow)}</span>
            </div>
          </div>
        )}

        {vm.overspent > 0 && (
          <div
            className="mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: "rgba(0,0,0,0.18)", color: "#ffe0c2" }}
          >
            {t("−{amount} · over budget this month", { amount: money(vm.overspent) })}
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
          <span className="text-[12.5px] font-medium" style={{ color: "#7fbf6a" }}>
            {t("Owed to you")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[18px] font-bold text-bone">{money2(vm.owedToYou)}</span>
            <ChevronRight size={16} style={{ color: "#7e8a98" }} />
          </span>
        </button>
      )}

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

        {/* Strategy dial — pick a cushion → see deploy now + debt-free date */}
        <div
          className="col-span-2 rounded-[18px] border p-3"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[11.5px]" style={{ color: "#8b97a6" }}>
            <Target size={14} /> {t("Strategy · safer ↔ faster")}
          </div>
          {vm.deployedThisCycle > 0 && (
            <div
              className="mb-2 rounded-[12px] px-2.5 py-1.5 text-[11.5px]"
              style={{ background: "#0e2a1c", color: "#7fbf6a" }}
            >
              {t("Deployed {amount} at debt this cycle", { amount: money(vm.deployedThisCycle) })}
            </div>
          )}
          {!vm.strategyReady ? (
            <div
              className="rounded-[12px] px-3 py-3 text-[12px]"
              style={{ background: "#161c26", color: "#9aa6b5" }}
            >
              {t("Waiting on your paychecks — {paid} of {total} in. The strategy opens once both land.", {
                paid: vm.paychecksIn,
                total: vm.paychecksExpected,
              })}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1.5">
            {vm.presets.map((p) => {
              const on = p.key === vm.cushion;
              return (
                <button
                  key={p.key}
                  onClick={() => taps.onCushion?.(p.key)}
                  className="rounded-[14px] border px-2 py-2.5 text-left transition active:scale-[0.97]"
                  style={{
                    background: on ? "rgba(52,197,232,0.14)" : "#0f1620",
                    borderColor: on ? "#34c5e8" : "#232d3a",
                  }}
                >
                  <div
                    className="text-[11px] font-semibold capitalize"
                    style={{ color: on ? "#34c5e8" : "#8b97a6" }}
                  >
                    {t(p.key)}
                  </div>
                  <div className="mt-1 text-[17px] font-bold leading-none text-bone">
                    {money(p.deployNow)}
                  </div>
                  <div className="mt-1 text-[10.5px]" style={{ color: "#6b7686" }}>
                    {t("keep {amount}", { amount: money(p.cushion) })}
                  </div>
                  <div className="mt-0.5 text-[10.5px]" style={{ color: "#6b7686" }}>
                    {p.deployNow > 0 ? t("free {date}", { date: p.debtFreeBy }) : t("hold")}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-2.5 px-1 text-[11.5px]" style={{ color: "#9aa6b5" }}>
            {vm.deployNow > 0
              ? t("Then each payday continues the snowball → debt-free {date}", { date: vm.debtFreeBy })
              : t("Hold this cycle; each payday still chips the snowball → debt-free {date}", { date: vm.debtFreeBy })}
          </div>
          {vm.deployNow > 0 && (
            <button
              onClick={taps.onDeploy}
              className="mt-2.5 w-full rounded-[14px] py-2.5 text-center text-[13px] font-semibold transition active:scale-[0.98]"
              style={{ background: "linear-gradient(150deg,#0e7490,#1d4ed8)", color: "#eaf6ff" }}
            >
              {t("Deploy {amount} now →", { amount: money(vm.deployNow) })}
            </button>
          )}
          {vm.deployNow > 0 && vm.deployClearsZeroApr && vm.cushion !== "safe" && (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-[12px] px-2.5 py-2 text-[11px]"
              style={{ background: "#2a2016", color: "#fbbf77" }}
            >
              <Flame size={13} className="mt-px shrink-0" />
              <span>
                {t(
                  "This clears a 0%-interest balance and thins your safety pad — a surprise expense would land on your high-interest card.",
                )}
              </span>
            </div>
          )}
            </>
          )}
        </div>

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
                    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "#7e8a98" }}>
                      {r.pending && <span className="font-semibold" style={{ color: "#e3b341" }}>◌ {t("Processing")}</span>}
                      {r.pending ? "" : r.sub}
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
