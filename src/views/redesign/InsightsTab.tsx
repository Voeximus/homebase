import { t } from "../../lib/i18n";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
// RESKINNED 2026-10-04. Every figure still comes from `vms.insights`, built by
// the single composed firepowerStatus call in buildVMs — this file does no
// arithmetic beyond turning two numbers into a bar width.
//
// WHAT WENT, and each for a reason rather than for tidiness:
//
//   · THE DONUT. A conic-gradient ring split by category, where each wedge wore
//     that category's own hue. It was the clearest statement of the old skin's
//     rule — colour as IDENTITY — and the thing it actually communicated, "which
//     slice is biggest", is read faster off a sorted list of bars. The VM still
//     carries `donut`; nothing draws it.
//   · PER-CATEGORY HUES. Groceries was green, dining was amber, transport blue.
//     With six of them nothing stood out, so the one category that is over
//     budget looked exactly like the five that are not. Now every bar is the
//     same neutral and only an over-budget one turns red, which is the single
//     thing this screen is for.
//
// WHAT PACE MEANS, because it is the only inference on the screen: the marker on
// each bar is where you would be if the cycle's allowance were spent evenly. A
// bar past its marker is ahead of pace, which is not the same as over budget and
// is not coloured as though it were.

function Bar({ spent, target, pace }: { spent: number; target: number; pace: number }) {
  const pct = target > 0 ? Math.min(100, (spent / target) * 100) : 0;
  const over = spent > target;
  return (
    <div className="relative mt-2 h-[6px] overflow-hidden rounded-full" style={{ background: "var(--color-recessed)" }}>
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${pct}%`, background: over ? "var(--color-ember)" : "var(--color-bone)" }}
      />
      {/* Where the cycle says you should be. Drawn ON the track, not in the fill,
          so it stays visible when the fill has passed it. */}
      {pace > 0 && pace < 100 && (
        <div
          className="absolute inset-y-0 w-px"
          style={{ left: `${pace}%`, background: "var(--color-bg)", opacity: 0.9 }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function InsightsTab({ vm, taps = {} }: { vm: InsightsVM; taps?: InsightsTaps }) {
  const left = vm.budgetTarget - vm.budgetSpent;
  const over = left < 0;
  const pace = vm.budgetCycleDays > 0 ? (vm.budgetCycleDay / vm.budgetCycleDays) * 100 : 0;
  const rows = [...vm.categories].sort((a, b) => b.spent - a.spent);

  return (
    <div className="pb-2">
      <header className="px-5 pt-1">
        <p className="text-[15px] text-taupe">
          {vm.budgetCycleLabel} ·{" "}
          {t("day {n} of {d}", { n: vm.budgetCycleDay, d: vm.budgetCycleDays })}
        </p>
        <h1 className="mt-0.5 text-[34px] font-bold leading-tight tracking-[-0.022em] text-bone">
          {t("Budget")}
        </h1>
      </header>

      <div className="mt-5 px-5">
        <p className="text-[15px] text-taupe">{over ? t("Over by") : t("Left to spend")}</p>
        <p
          className={`mt-0.5 text-[52px] font-light leading-[1.06] tracking-[-0.04em] tabular-nums ${
            over ? "text-ember" : "text-bone"
          }`}
        >
          {money2(Math.abs(left))}
        </p>
        <p className="mt-1 text-[14px] text-faint">
          {t("{spent} of {target} spent", {
            spent: money(vm.budgetSpent),
            target: money(vm.budgetTarget),
          })}
        </p>
        <div className="mt-3">
          <Bar spent={vm.budgetSpent} target={vm.budgetTarget} pace={pace} />
        </div>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 pl-5 text-[13px] font-semibold text-taupe">{t("By category")}</h2>
        <div className="overflow-hidden rounded-2xl bg-tile">
          {rows.map((c, i) => {
            const cOver = c.spent > c.target;
            const last = i === rows.length - 1;
            return (
              <button
                key={c.catId}
                onClick={() => taps.onCategory?.(c.catId)}
                className="block w-full px-4 py-3 text-left"
                style={last ? undefined : { boxShadow: "inset 0 -1px 0 var(--color-edge)" }}
              >
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-[16px] text-bone">{c.label}</span>
                  <span
                    className={`text-[15px] tabular-nums ${cOver ? "text-ember" : "text-taupe"}`}
                  >
                    {money(c.spent)}{" "}
                    <span className="text-faint">/ {money(c.target)}</span>
                  </span>
                </div>
                <Bar spent={c.spent} target={c.target} pace={pace} />
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 pl-5 text-[13px] font-semibold text-taupe">{t("The month")}</h2>
        <div className="overflow-hidden rounded-2xl bg-tile">
          {[
            { k: t("Coming in"), v: money(vm.income) },
            { k: t("Fixed living cost"), v: money(vm.living) },
            { k: t("Free to aim at the debt"), v: money(vm.atDebt), accent: true },
          ].map((r, i, arr) => (
            <div
              key={r.k}
              className="flex items-baseline gap-3 px-4 py-3"
              style={i === arr.length - 1 ? undefined : { boxShadow: "inset 0 -1px 0 var(--color-edge)" }}
            >
              <span className="min-w-0 flex-1 text-[16px] text-bone">{r.k}</span>
              <span className={`text-[16px] tabular-nums ${r.accent ? "text-accent" : "text-bone"}`}>
                {r.v}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 px-5 text-[13px] text-faint">
          {/* The door's own warning, kept word-for-word on the screen that shows
              the number: the household's cash floor is not in this figure. */}
          {t("What is free to aim at the debt — not what is safe to spend.")}
        </p>
      </section>

      {vm.ladder.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 pl-5 text-[13px] font-semibold text-taupe">
            {vm.debtFreeBy === "—"
              ? t("Payoff order")
              : t("Debt free {when}", { when: vm.debtFreeBy })}
          </h2>
          <div className="overflow-hidden rounded-2xl bg-tile">
            {vm.ladder.map((d, i) => (
              <div
                key={d.name + d.rank}
                className="flex items-baseline gap-3 px-4 py-3"
                style={
                  i === vm.ladder.length - 1
                    ? undefined
                    : { boxShadow: "inset 0 -1px 0 var(--color-edge)" }
                }
              >
                <span className="w-5 shrink-0 text-[15px] tabular-nums text-faint">{d.rank}</span>
                <span className="min-w-0 flex-1 truncate text-[16px] text-bone">{d.name}</span>
                {d.apr != null && (
                  <span className="text-[13px] tabular-nums text-taupe">{d.apr}%</span>
                )}
                <span className="text-[16px] tabular-nums text-bone">{money(d.amount)}</span>
              </div>
            ))}
          </div>
          {vm.monthsToGo > 0 && (
            <p className="mt-2 px-5 text-[13px] text-faint">
              {t("{n} months at this pace · {amount} of interest", {
                n: vm.monthsToGo,
                amount: money(vm.interest),
              })}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
