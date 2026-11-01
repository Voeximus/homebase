import { CircleCheck, Flame } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon, conicFromSegments, gaugeSegs } from "../../lib/catColor";
import { t } from "../../lib/i18n";
import { barPct, budgetVerdict } from "./barPct";

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
  // Does the payoff plan clear at the current pace? When false there is no date, no
  // month count and no interest total to state. Optional so a mock compiles; absent
  // reads as true.
  clears?: boolean;
  // When it does not clear: how far short a month the planned pay falls ($/mo) — the
  // same figure as HomeVM.payoffShortBy. Optional; absent reads as 0.
  shortBy?: number;
  ladder: { rank: number; name: string; amount: number; live?: boolean; apr?: number; target?: boolean }[];
  // True in the Mine lens: every figure here is the household's.
  household?: boolean;
}

interface InsightsTaps {
  onCategory?: (catId: string) => void;
}

export function InsightsTab({ vm, taps = {} }: { vm: InsightsVM; taps?: InsightsTaps }) {
  const donutSegs = vm.donut.map((d) => ({ color: catColor(d.catId), value: d.amount }));
  // The ring is a GAUGE (gaugeSegs): spent ÷ target of it is coloured, the rest is the
  // empty track — drawn the same way as Home's "This cycle" donut.
  const ring = gaugeSegs(donutSegs, vm.budgetTarget);
  const verdict = budgetVerdict(vm.budgetSpent, vm.budgetTarget, vm.budgetCycleDay, vm.budgetCycleDays);
  const onTrack = verdict === "ok";
  const leftInBudget = vm.budgetTarget - vm.budgetSpent;
  const clears = vm.clears !== false;
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
          <div className="text-[12px]">{t("where the money goes")}</div>
          <div className="text-[26px] font-bold leading-none tracking-tight">{t("Insights")}</div>
          {/* Under Mine, these are still the household's figures — one plan. */}
          {vm.household && (
            <span
              className="mt-1.5 inline-block rounded-full px-1.5 py-px text-[10px] font-medium"
              style={{ background: "rgba(0,0,0,0.18)" }}
            >
              {t("Household")}
            </span>
          )}
        </div>
        {/* The pay cycle these figures are graded against. Was a hardcoded "June"
            with a dropdown chevron that opened nothing — and after the budget moved
            to pay cycles it named the wrong PERIOD as well as the wrong month. */}
        <div className="pb-1 text-right">
          <div className="text-[13px] font-semibold leading-tight">{vm.budgetCycleLabel}</div>
          <div className="text-[11px] leading-tight">
            {daysLeft === 0
              ? t("last day")
              : daysLeft === 1
                ? t("1 day left")
                : t("{n} days left", { n: daysLeft })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* ── Spending gauge ── */}
        <div
          className="flex items-center gap-4 rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="relative h-[120px] w-[120px] shrink-0">
            <div
              className="h-[120px] w-[120px] rounded-full"
              style={{ background: conicFromSegments(ring, 0) }}
            />
            <div
              className="absolute inset-[14px] flex flex-col items-center justify-center rounded-full"
              style={{ background: "#141a24" }}
            >
              <span className="text-[20px] font-bold text-bone">{money(vm.budgetSpent)}</span>
              <span className="text-[11px]" style={{ color: "var(--color-taupe)" }}>
                {t("of {amount}", { amount: money(vm.budgetTarget) })}
              </span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="eyebrow text-taupe">{t("Spent this cycle")}</div>
            {/* Which paycheck's run this is, and how far into it — the same pace
                line the Home tile carries, so the two screens agree. */}
            <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
              {t("day {n} of {total}", { n: vm.budgetCycleDay, total: vm.budgetCycleDays })}
            </div>
            <div
              className="mt-1.5 flex items-center gap-1.5 text-[15px] font-semibold"
              style={{ color: verdict === "over" ? "#f0556e" : verdict === "ahead" ? "#e3b341" : "#46d18a" }}
            >
              {onTrack && <CircleCheck size={16} />}
              {verdict === "over" ? t("Over") : verdict === "ahead" ? t("Ahead of pace") : t("On track")}
            </div>
            <div className="mt-1 text-[12px]" style={{ color: "var(--color-taupe)" }}>
              {leftInBudget >= 0
                ? t("{amount} left in the lean budget", { amount: money(leftInBudget) })
                : t("{amount} over the lean budget", { amount: money(-leftInBudget) })}
            </div>
          </div>
        </div>

        {/* ── Plan vs actual ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="eyebrow mb-3 text-taupe">{t("Lean budget · plan vs actual")}</div>
          <div className="flex flex-col gap-3.5">
            {vm.categories.map((c) => {
              const Icon = catIcon(c.catId);
              const color = catColor(c.catId);
              const over = c.spent > c.target;
              // barPct, not a bare division: a cycle's goal can set a line to 0.
              const pct = barPct(c.spent, c.target);
              return (
                <button
                  key={c.catId}
                  onClick={() => taps.onCategory?.(c.catId)}
                  className="flex min-h-[44px] w-full flex-col justify-center text-left transition active:scale-[0.99]"
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} style={{ color }} className="shrink-0" />
                    <span className="flex-1 text-[13px] font-medium text-bone">{t(c.label)}</span>
                    <span className="text-[12.5px] font-semibold text-bone">
                      {money(c.spent)}{" "}
                      {/* The goal at weight 400, as on the category sheet: spent reads first. */}
                      <span className="font-normal" style={{ color: "var(--color-taupe)" }}>/ {money(c.target)}</span>
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full"
                    style={{ background: "#222b38" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: over ? "#f0556e" : color }}
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
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="eyebrow mb-3 text-taupe">{t("Where every dollar goes")}</div>
          {/* This bar's three widths were the LITERALS 45.9% / 20.9% / 33.2%.
              They match the design-lab's mock numbers exactly, which is why it
              looked right in the harness and in the screenshots — but it never
              read vm.living / vm.variable / vm.atDebt at all. With any other
              month's numbers the picture and the four figures printed directly
              underneath it disagreed, and the picture was the one people trust.

              It is computed now. Segments under ~10% drop their label rather
              than squeeze it, and every slice keeps dark ink: white on the
              steel-blue measured 3.97:1, under what 10px text needs, while its
              two neighbours already used dark ink — so one bar had two
              different text treatments and the odd one out was the failing one. */}
          {(() => {
            const parts = [
              { key: "living", label: t("Living"), value: vm.living, bg: "#5b82b3" },
              { key: "variable", label: t("Variable"), value: vm.variable, bg: "#e3b341" },
              { key: "debt", label: t("Debt"), value: vm.atDebt, bg: "#34c5e8" },
            ].filter((seg) => seg.value > 0);
            const total = parts.reduce((a, seg) => a + seg.value, 0);
            if (total <= 0) return null;
            return (
              <div className="flex h-[30px] overflow-hidden rounded-[8px]">
                {parts.map((seg) => {
                  const pct = (seg.value / total) * 100;
                  return (
                    <div
                      key={seg.key}
                      className="flex items-center justify-center overflow-hidden text-[10px] font-semibold"
                      style={{ width: `${pct}%`, background: seg.bg, color: "#0d1218" }}
                      title={`${seg.label} · ${money(seg.value)} · ${Math.round(pct)}%`}
                    >
                      {pct >= 10 ? seg.label : ""}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            <Stat label={t("Income")} value={money(vm.income)} color="#46d18a" />
            <Stat label={t("Living")} value={money(vm.living)} color="var(--color-bone)" />
            <Stat label={t("Variable")} value={money(vm.variable)} color="var(--color-bone)" />
            <Stat label={t("At debt")} value={money(vm.atDebt)} color="#34c5e8" />
          </div>
        </div>

        {/* ── Debt-free ── the same flat indigo surface as Home's Payoff tile, not a
              second gradient competing with the hero. */}
        <div
          className="flex items-end justify-between rounded-[18px] border p-4"
          style={{ background: "#15172b", borderColor: "#282a4a" }}
        >
          <div>
            <div className="text-[11.5px]" style={{ color: "#a5b4fc" }}>{t("debt-free")}</div>
            {/* No date: say so in words, as Home's Payoff tile does — a bare dash
                headline read as broken or still loading. */}
            <div className="text-[26px] font-bold leading-none tracking-tight text-bone">
              {clears ? vm.debtFreeBy : t("No date yet")}
            </div>
            <div className="mt-1 text-[12px]" style={{ color: "#a5b4fc" }}>
              {!clears
                ? vm.shortBy
                  ? t("{amount}/mo short at this pace", { amount: money(vm.shortBy) })
                  : t("no date at this pace")
                : vm.monthsToGo === 1
                  ? t("~1 month to go")
                  : t("~{n} months to go", { n: vm.monthsToGo })}
            </div>
          </div>
          {/* No date means no interest total either; nothing is drawn rather than a dash. */}
          {clears && (
            <div className="text-right">
              <div className="text-[11.5px]" style={{ color: "#a5b4fc" }}>{t("interest you'll pay")}</div>
              <div className="text-[20px] font-bold text-bone">~{money(vm.interest)}</div>
            </div>
          )}
        </div>

        {/* ── Attack ladder ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-bone">
            <Flame size={16} style={{ color: "#fb923c" }} />
            {t("Attack ladder")}
            <span className="text-[12px] font-normal" style={{ color: "var(--color-taupe)" }}>
              {t("· in the order we pay")}
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
                    background: hi ? "#0e2230" : "transparent",
                    borderColor: hi ? "#1d5066" : "#232d3a",
                  }}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
                    style={{
                      background: hi ? "#34c5e826" : "#1a212c",
                      // The rank sat at 4.33:1 on its own chip — dimmer than the
                      // dim ink elsewhere, because the chip is LIGHTER than the
                      // card it sits on. It is a number the ladder exists to be
                      // read in order, so it takes the secondary ink.
                      color: hi ? "#34c5e8" : "var(--color-taupe)",
                    }}
                  >
                    {d.rank}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-bone">{d.name}</span>
                    {/* A 0% plan costs nothing, so it is not a warning. */}
                    {d.apr != null && d.apr > 0 && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        // Rose ink on the red tint: the red itself measured 4.1–4.4:1
                        // on its own tint at 10px, under AA.
                        style={{ background: "#f0556e26", color: "#f4a6b6" }}
                      >
                        {d.apr}%
                      </span>
                    )}
                    {d.live && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: "#46d18a26", color: "#46d18a" }}
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

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[15px] font-bold" style={{ color }}>
        {value}
      </div>
      <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
        {label}
      </div>
    </div>
  );
}
