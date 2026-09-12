import { ChevronRight, Flame, Receipt } from "lucide-react";
import { catColor, catIcon } from "../../lib/catColor";
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
  onOwed?: () => void;
}

export function HomeTab({ vm, taps = {} }: { vm: HomeVM; taps?: Taps }) {
  return (
    <div className="flex flex-col gap-0">
      {/* ── The hero ──────────────────────────────────────────────────────────
          ONE number, at a size nothing else on the screen gets, and it is the
          one that decides something. This used to be `debt left` on a gradient
          slab — a figure that moves once a fortnight, given the loudest place
          on a screen you open every day. What moves daily, and what you open
          the app to find out, is whether you can spend.

          And it is the HONEST version of that: not the envelope remainder,
          which would read "$531 left" the evening before rent, but cash minus
          everything still due before payday minus the floor you set.

          The subtraction is printed underneath rather than asserted. A
          headline you cannot check is a headline you have to trust, and being
          checkable is the entire point of this app. */}
      <div className="px-5 pb-1 pt-3">
        <div className="eyebrow" style={{ color: "#8b96a5" }}>
          {t("truly free")}
        </div>
        <div className="mt-1 text-[46px] font-extrabold leading-none tracking-[-0.035em] tabular-nums">
          {money(vm.trulyFree)}
        </div>
        <div className="mt-1.5 text-[13px] text-taupe">
          {t("after everything due before {date}", { date: vm.paydayLabel })} ·{" "}
          {t("{n} days", { n: vm.daysToPayday })} ·{" "}
          <span className="font-semibold text-bone">
            {money(Math.floor(vm.trulyFree / vm.daysToPayday))}
          </span>{" "}
          {t("a day")}
        </div>

        <button
          onClick={taps.onCash}
          className="mt-3.5 flex w-full overflow-hidden rounded-[13px] border text-center transition active:scale-[0.99]"
          style={{ background: "#141a23", borderColor: "#222b38" }}
        >
          <span className="flex-1 px-2 py-2.5">
            <span className="block text-[14.5px] font-bold tabular-nums">{money(vm.cash)}</span>
            <span className="mt-0.5 block text-[9.5px] text-faint">{t("in the bank")}</span>
          </span>
          <span className="flex-1 border-l px-2 py-2.5" style={{ borderColor: "#222b38" }}>
            <span className="block text-[14.5px] font-bold tabular-nums">
              −{money(vm.committed)}
            </span>
            <span className="mt-0.5 block text-[9.5px] text-faint">{t("bills to come")}</span>
          </span>
          <span className="flex-1 border-l px-2 py-2.5" style={{ borderColor: "#222b38" }}>
            <span className="block text-[14.5px] font-bold tabular-nums">
              −{money(vm.cashFloor)}
            </span>
            <span className="mt-0.5 block text-[9.5px] text-faint">{t("your floor")}</span>
          </span>
        </button>

        {vm.processing > 0 && (
          <div className="mt-2 text-[11.5px]" style={{ color: "#e9b23c" }}>
            {t("{amount} of that is still settling at the bank", {
              amount: money2(vm.processing),
            })}
          </div>
        )}
      </div>

      {/* ── Owed to you (reimbursable set-asides still outstanding) ── */}
      {vm.owedToYou > 0 && (
        <button
          onClick={taps.onOwed}
          className="mx-4 mt-3 flex items-center justify-between rounded-[16px] border px-4 py-3 text-left transition active:scale-[0.99]"
          style={{ background: "#0f1f1a", borderColor: "#17443a" }}
        >
          <span className="text-[12.5px] font-medium" style={{ color: "#3fd08a" }}>
            {t("Owed to you")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[18px] font-bold text-bone">{money2(vm.owedToYou)}</span>
            <ChevronRight size={16} style={{ color: "#8b96a5" }} />
          </span>
        </button>
      )}

      {/* ── Bento grid ── */}
      <div className="grid grid-cols-2 gap-3 p-4">
        {/* Spent this cycle — cash moved into the hero's derivation strip, so
            this slot goes to the other half of the picture: what you have
            actually put through the envelopes so far. */}
        <button
          onClick={taps.onBudget}
          className="rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a23", borderColor: "#222b38" }}
        >
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "#8b96a5" }}>
            <Receipt size={14} /> {t("Spent this cycle")}
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-bone">{money(vm.budgetSpent)}</div>
          <div className="mt-0.5 text-[11px]" style={{ color: "#8b96a5" }}>
            {t("of {amount} · day {n} of {total}", {
              amount: money(vm.budgetTarget),
              n: vm.budgetCycleDay,
              total: vm.budgetCycleDays,
            })}
          </div>
        </button>

        {/* Debt */}
        <button
          onClick={taps.onDebt}
          className="rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a23", borderColor: "#2e3947" }}
        >
          {/* This tile used to print money(vm.debtLeft) and vm.debtProgressPct —
              the SAME two facts the gradient hero states 150px above it, in the
              same units. Two of the four slots on the home screen were spent
              saying one thing twice.

              The hero keeps the headline. The tile keeps the bar (a % you can
              see beats a % you have to read) and now carries the two debt facts
              that were on no screen at all: when it is gone, and what leaves on
              payday. Both were already on the view-model, unused. */}
          {/* Ink, not a category colour. This label was set in the indigo that
              `transport` uses and measured 3.86:1 — and beyond the contrast, a
              category hue on a text label is exactly the confusion the palette
              rule exists to prevent: categories are dots and fills, never
              type. Its neighbour tile already used faint; now they match. */}
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "#8b96a5" }}>
            <Flame size={14} /> {t("Payoff")}
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-bone">{vm.debtFreeBy}</div>
          <div className="mt-0.5 text-[11px]" style={{ color: "#8b96a5" }}>
            {vm.nextAmount > 0
              ? t("{amount} on {date}", { amount: money(vm.nextAmount), date: vm.nextDate })
              : t("{pct}% cleared", { pct: Math.round(vm.debtProgressPct) })}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "#2e3947" }}>
            <div
              className="h-full"
              style={{
                width: `${vm.debtProgressPct}%`,
                background: "linear-gradient(90deg,#6a75e0,#38c6e8)",
              }}
            />
          </div>
        </button>

        {/* ── The pace bar ──────────────────────────────────────────────────
            The fill is the money; the TICK is where you should be by now.

            A plain bar answers "how much of the limit is gone" and has no way
            to answer "is that a lot for day six" — which mid-cycle is the only
            question worth asking. Putting elapsed time on the same track turns
            an arithmetic problem into a glance: fill past tick means you are
            spending faster than the cycle is passing.

            The donut that used to sit here moved to Insights, where composition
            is the actual question. It was never able to draw "over" anyway. */}
        <button
          onClick={taps.onBudget}
          className="col-span-2 rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a23", borderColor: "#222b38" }}
        >
          {(() => {
            const pctMoney = Math.min(100, (vm.budgetSpent / Math.max(1, vm.budgetTarget)) * 100);
            const pctTime = Math.min(
              100,
              (vm.budgetCycleDay / Math.max(1, vm.budgetCycleDays)) * 100,
            );
            const ahead = pctMoney > pctTime + 2; // a 2pt deadband, or it flickers
            const over = vm.budgetSpent > vm.budgetTarget;
            const tone = over ? "#f0645c" : ahead ? "#e9b23c" : "#3fd08a";
            return (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow" style={{ color: "#8b96a5" }}>
                    {t("This cycle")}
                  </span>
                  <span className="text-[11.5px] text-faint">{vm.budgetCycleLabel}</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between">
                  <span className="text-[23px] font-bold tabular-nums text-bone">
                    {money(vm.budgetSpent)}
                  </span>
                  <span className="text-[12.5px] text-faint">
                    {t("of {amount}", { amount: money(vm.budgetTarget) })}
                  </span>
                </div>
                <div
                  className="relative mt-2.5 h-3 rounded-full"
                  style={{ background: "#2e3947" }}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
                    style={{ width: `${pctMoney}%`, background: tone }}
                  />
                  {/* where the cycle says you should be. The ring of panel colour
                      keeps it readable wherever the fill happens to end. */}
                  <span
                    className="absolute -top-1 -bottom-1 w-[2px] rounded"
                    style={{
                      left: `${pctTime}%`,
                      background: "#f0f4f8",
                      boxShadow: "0 0 0 3px #141a23",
                    }}
                    aria-hidden
                  />
                </div>
                <div className="mt-3 flex items-baseline justify-between text-[11.5px]">
                  <span className="font-semibold" style={{ color: tone }}>
                    {over
                      ? t("over budget")
                      : ahead
                        ? t("ahead of pace")
                        : t("on pace")}
                  </span>
                  <span className="text-faint">
                    {t("{amount} left · {n} days", {
                      amount: money(Math.max(0, vm.budgetTarget - vm.budgetSpent)),
                      n: Math.max(0, vm.budgetCycleDays - vm.budgetCycleDay),
                    })}
                  </span>
                </div>
              </>
            );
          })()}
        </button>

        {/* Bills — critical daily glance */}
        <button
          onClick={taps.onBills}
          className="col-span-2 flex items-center gap-3 rounded-[18px] border p-4 text-left transition active:scale-[0.98]"
          style={{ background: "#141a23", borderColor: "#222b38" }}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#271c10", color: "#c07a1e" }}
          >
            <Receipt size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13.5px] font-semibold text-bone">{t("Bills")}</span>
              <span className="text-[12px]" style={{ color: "#8b96a5" }}>
                {t("{amount} left", { amount: money(vm.bills.left) })}
              </span>
            </div>
            <div className="truncate text-[11.5px]" style={{ color: "#8b96a5" }}>
              {t("next: {name} · {date}", { name: vm.bills.nextName, date: vm.bills.nextDate })}
            </div>
          </div>
          <ChevronRight size={18} style={{ color: "#8b96a5" }} />
        </button>

        {/* Anomaly alert */}
        {vm.anomalyCount > 0 && (
          <button
            onClick={taps.onAnomaly}
            className="col-span-2 flex items-center gap-3 rounded-[18px] border p-3.5 text-left transition active:scale-[0.98]"
            style={{ background: "#1d1526", borderColor: "#331a18" }}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: "#f0645c" }}
            />
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ color: "#f0a49d" }}>
                {t("Unusual purchases")}
              </div>
              <div className="text-[12px]" style={{ color: "#a8b4c2" }}>
                {t("{n} buys ran higher than usual", { n: vm.anomalyCount })}
              </div>
            </div>
            <ChevronRight size={18} style={{ color: "#8b96a5" }} />
          </button>
        )}

        {/* Recent */}
        <button
          onClick={taps.onRecent}
          className="col-span-2 rounded-[18px] border p-3.5 text-left transition active:scale-[0.98]"
          style={{ background: "#141a23", borderColor: "#222b38" }}
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="eyebrow text-taupe">{t("Recent")}</span>
            <span className="text-[12px]" style={{ color: "#a8b4c2" }}>
              {t("{amount} since Mon", { amount: money(vm.sinceMonday) })}
            </span>
          </div>
          <div className="flex flex-col gap-2.5">
            {vm.recent.slice(0, 3).map((r) => {
              const Icon = catIcon(r.catId);
              const c = r.income ? "#3fd08a" : catColor(r.catId);
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
                    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "#8b96a5" }}>
                      {r.pending && <span className="font-semibold" style={{ color: "#e9b23c" }}>◌ {t("Processing")}</span>}
                      {r.pending ? "" : r.sub}
                    </div>
                  </div>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: r.income ? "#3fd08a" : "#f0f4f8" }}
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
