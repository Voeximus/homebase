import { CircleCheck, Flame } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon, conicFromSegments } from "../../lib/catColor";
import { t } from "../../lib/i18n";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

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

// The allocation bar's three earths. Computed against the panel, all-pairs,
// with the CVD simulation — see the note at the bar itself.
const ALLOC = { living: "#b18900", variable: "#b54a44", debt: "#3970c2" };

export function InsightsTab({ vm, taps = {} }: { vm: InsightsVM; taps?: InsightsTaps }) {
  const donutSegs = vm.donut.map((d) => ({ color: catColor(d.catId), value: d.amount }));
  const onTrack = vm.budgetSpent <= vm.budgetTarget;
  const leftInBudget = vm.budgetTarget - vm.budgetSpent;
  // Days AFTER today, so `day n of total` + `days left` reconciles to the cycle
  // length instead of overlapping on today and reading one too many.
  const daysLeft = Math.max(0, vm.budgetCycleDays - vm.budgetCycleDay);

  return (
    <div className="flex flex-col gap-0">
      {/* ── Gradient header ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="flex items-end justify-between rounded-b-[24px] px-6 py-4 text-white"
      >
        <div>
          <div className="text-[12px] opacity-90">{t("where the money goes")}</div>
          <div className="inscr text-[30px]">{t("Insights")}</div>
        </div>
        {/* The pay cycle these figures are graded against. Was a hardcoded "June"
            with a dropdown chevron that opened nothing — and after the budget moved
            to pay cycles it named the wrong PERIOD as well as the wrong month. */}
        <div className="pb-1 text-right">
          <div className="text-[13px] font-semibold leading-tight">{vm.budgetCycleLabel}</div>
          <div className="text-[11px] leading-tight opacity-80">
            {daysLeft === 0
              ? t("last day")
              : t("{n} days left", { n: daysLeft })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* ── Spending gauge ── */}
        <div
          className="flex items-center gap-4 rounded-[18px] border p-4"
          style={{ background: "#1c1811", borderColor: "#332b20" }}
        >
          <div className="relative h-[120px] w-[120px] shrink-0">
            <div
              className="h-[120px] w-[120px] rounded-full"
              style={{ background: conicFromSegments(donutSegs) }}
            />
            <div
              className="absolute inset-[14px] flex flex-col items-center justify-center rounded-full"
              style={{ background: "#1c1811" }}
            >
              <span className="figure text-[23px] text-bone">{money(vm.budgetSpent)}</span>
              <span className="text-[11px]" style={{ color: "#9e9180" }}>
                {t("of {amount}", { amount: money(vm.budgetTarget) })}
              </span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="text-[10.5px] font-semibold uppercase"
              style={{ color: "#9e9180", letterSpacing: "0.08em" }}
            >
              {t("Spent this cycle")}
            </div>
            {/* Which paycheck's run this is, and how far into it — the same pace
                line the Home tile carries, so the two screens agree. */}
            <div className="mt-0.5 text-[11px]" style={{ color: "#9e9180" }}>
              {t("day {n} of {total}", { n: vm.budgetCycleDay, total: vm.budgetCycleDays })}
            </div>
            <div
              className="mt-1.5 flex items-center gap-1.5 text-[15px] font-semibold"
              style={{ color: onTrack ? "#39c0b4" : "#eb7867" }}
            >
              {onTrack && <CircleCheck size={16} />}
              {onTrack ? t("On track") : t("Over")}
            </div>
            <div className="mt-1 text-[12px]" style={{ color: "#9e9180" }}>
              {t("{amount} left in the lean budget", { amount: money(leftInBudget) })}
            </div>
          </div>
        </div>

        {/* ── Plan vs actual ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#1c1811", borderColor: "#332b20" }}
        >
          <div
            className="mb-3 text-[10.5px] font-semibold uppercase"
            style={{ color: "#9e9180", letterSpacing: "0.08em" }}
          >
            {t("Lean budget · plan vs actual")}
          </div>
          <div className="flex flex-col gap-3.5">
            {vm.categories.map((c) => {
              const Icon = catIcon(c.catId);
              const color = catColor(c.catId);
              const over = c.spent > c.target;
              const pct = Math.min(100, (c.spent / c.target) * 100);
              return (
                <button
                  key={c.catId}
                  onClick={() => taps.onCategory?.(c.catId)}
                  className="flex min-h-[44px] w-full flex-col justify-center text-left transition active:scale-[0.99]"
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} style={{ color }} className="shrink-0" />
                    <span className="flex-1 text-[13px] font-medium text-bone">{c.label}</span>
                    <span className="text-[12.5px] font-semibold text-bone">
                      {money(c.spent)}{" "}
                      <span style={{ color: "#9e9180" }}>/ {money(c.target)}</span>
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full"
                    style={{ background: "#453a2b" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: over ? "#eb7867" : color }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Where every dollar goes ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#1c1811", borderColor: "#332b20" }}
        >
          <div
            className="mb-3 text-[10.5px] font-semibold uppercase"
            style={{ color: "#9e9180", letterSpacing: "0.08em" }}
          >
            {t("Where every dollar goes")}
          </div>
          {/* This bar's three widths were the LITERALS 45.9% / 20.9% / 33.2%.
              They match the design-lab's mock numbers exactly, which is why it
              looked right in the harness and in the screenshots — but it never
              read vm.living / vm.variable / vm.atDebt at all. With any other
              month's numbers the picture and the four figures printed directly
              underneath it disagreed, and the picture was the one people trust.
              It is computed now.

              The LABELS came out of the bar for the same class of reason. They
              were 10px dark text inside a 30px stripe, and the three fills the
              stripe could take would not all carry dark ink at that size — one
              of them measured 3.5:1 where small text needs 4.5. Trying to solve
              that inside the bar means choosing fills for their text contrast
              rather than for what they mean. So the bar is a picture now, the
              row underneath is its legend (each figure carries its own swatch),
              and the segments are free to be the right three earths:

                living  ochre      #b18900
                variable red earth #b54a44
                at debt  lapis     #3970c2
                worst pair ΔE 17.3 normal · 11.6 deuteranopia, all ≥ 3:1

              The 2px gaps are not decoration either — abutting fills of similar
              value blur into one another, and a gap of the panel behind is what
              keeps three segments reading as three. */}
          {(() => {
            const parts = [
              { key: "living", label: t("Living"), value: vm.living, bg: ALLOC.living },
              { key: "variable", label: t("Variable"), value: vm.variable, bg: ALLOC.variable },
              { key: "debt", label: t("Debt"), value: vm.atDebt, bg: ALLOC.debt },
            ].filter((seg) => seg.value > 0);
            const total = parts.reduce((a, seg) => a + seg.value, 0);
            if (total <= 0) return null;
            return (
              <div className="flex h-[26px] gap-[2px]">
                {parts.map((seg) => {
                  const pct = (seg.value / total) * 100;
                  return (
                    <div
                      key={seg.key}
                      className="rounded-[5px]"
                      style={{ width: `${pct}%`, background: seg.bg }}
                      title={`${seg.label} · ${money(seg.value)} · ${Math.round(pct)}%`}
                    />
                  );
                })}
              </div>
            );
          })()}
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            <Stat label={t("Income")} value={money(vm.income)} />
            <Stat label={t("Living")} value={money(vm.living)} swatch={ALLOC.living} />
            <Stat label={t("Variable")} value={money(vm.variable)} swatch={ALLOC.variable} />
            <Stat label={t("At debt")} value={money(vm.atDebt)} swatch={ALLOC.debt} />
          </div>
        </div>

        {/* ── Debt-free ── */}
        <div
          className="flex items-end justify-between rounded-[18px] p-4 text-white"
          style={{ background: "linear-gradient(135deg,#3f2160,#4f65b6)" }}
        >
          <div>
            <div className="text-[11.5px] opacity-90">{t("debt-free")}</div>
            <div className="figure text-[28px]">{vm.debtFreeBy}</div>
            <div className="mt-1 text-[12px] opacity-90">{t("~{n} months to go", { n: vm.monthsToGo })}</div>
          </div>
          <div className="text-right">
            <div className="text-[11.5px] opacity-90">{t("interest you'll pay")}</div>
            <div className="figure text-[23px]">~{money(vm.interest)}</div>
          </div>
        </div>

        {/* ── Attack ladder ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#1c1811", borderColor: "#332b20" }}
        >
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-bone">
            <Flame size={16} style={{ color: "#d47c2e" }} />
            {t("Attack ladder")}
            <span className="text-[12px] font-normal" style={{ color: "#9e9180" }}>
              {t("· smallest first")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {vm.ladder.map((d) => {
              const hi = !!d.target;
              return (
                <div
                  key={d.rank}
                  className="flex items-center gap-3 rounded-[12px] border p-3"
                  style={{
                    background: hi ? "#223059" : "transparent",
                    borderColor: hi ? "#2d3354" : "#332b20",
                  }}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
                    style={{
                      background: hi ? "#7f9ff726" : "#262016",
                      // The rank sat at 4.33:1 on its own chip — dimmer than the
                      // dim ink elsewhere, because the chip is LIGHTER than the
                      // card it sits on. It is a number the ladder exists to be
                      // read in order, so it takes the secondary ink.
                      color: hi ? "#7f9ff7" : "#9e9180",
                    }}
                  >
                    {d.rank}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-bone">{d.name}</span>
                    {d.apr != null && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: "#eb786726", color: "#eb7867" }}
                      >
                        {d.apr}%
                      </span>
                    )}
                    {d.live && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: "#39c0b426", color: "#39c0b4" }}
                      >
                        {t("live")}
                      </span>
                    )}
                  </div>
                  <span className="text-[13px] font-semibold text-bone">{money(d.amount)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="h-2" />
    </div>
  );
}

function Stat({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div>
      {/* The figure stays in ink. A number wearing its series colour is the
          habit that quietly makes every value on a dashboard unreadable; the
          swatch beside the label carries the identity instead. */}
      <div className="figure text-[17px] text-bone">{value}</div>
      <div
        className="mt-1 flex items-center justify-center gap-1 text-[10.5px]"
        style={{ color: "#9e9180" }}
      >
        {swatch && (
          <span
            className="inline-block h-[7px] w-[7px] shrink-0 rounded-[2px]"
            style={{ background: swatch }}
          />
        )}
        {label}
      </div>
    </div>
  );
}
