import { useEffect, useState } from "react";
import { Check, Flame, Target } from "lucide-react";
import type { Account, Debt } from "../types";
import { useStore } from "../store/FinanceStore";
import { formatMoney } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  inputClass,
  labelClass,
  ProgressBar,
  Sheet,
} from "../components/ui";
import {
  commitmentProgress,
  HABITS,
  LEAN_VARIABLE,
  ONE_TIMES,
  orderedDebts,
  payoffSchedule,
  planMath,
  SAVINGS_SPLIT,
  simulatePayoff,
  sumTargets,
} from "../lib/plan";

/** "…4728" out of "Credit card (…4728)" — short label for the schedule rows. */
function shortDebt(name: string): string {
  const m = /…(\d{4})/.exec(name) || /(\d{4})/.exec(name);
  if (m) return "…" + m[1];
  return name.replace(/^Affirm — /, "").replace(/ \(China\)/, "");
}

function clearsList(ev: { payments: { name: string; clears: boolean }[] }): string[] {
  return ev.payments.filter((p) => p.clears).map((p) => shortDebt(p.name));
}
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ThreeMonthPlan() {
  const { data, payDebtExtra } = useStore();
  const [payFor, setPayFor] = useState<Debt | null>(null);
  const variable = sumTargets(LEAN_VARIABLE);
  const math = planMath(data.recurring, data.debts, variable);
  const ordered = orderedDebts(data.debts);

  if (data.debts.length === 0 || math.income <= 0) {
    return (
      <div className="px-4 pt-4 lg:px-6">
        <Card>
          <EmptyState icon={<Target size={24} />} title="Set up your household first">
            Open Settings → “Set up my household” to load your income, bills and
            debts — then the plan maps itself out here.
          </EmptyState>
        </Card>
      </div>
    );
  }

  const payoff = simulatePayoff(ordered, math.firepower, new Date());
  const schedule = payoffSchedule(ordered, math.firepower, new Date(), [15, 29], SAVINGS_SPLIT);
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
  const totalOriginal = data.debts.reduce((s, d) => s + d.originalBalance, 0);
  const cleared = totalOriginal - math.totalDebt;
  const clearedPct = totalOriginal > 0 ? (cleared / totalOriginal) * 100 : 0;
  const commit = commitmentProgress(new Date());

  return (
    <div className="space-y-5 px-4 pb-12 pt-4 lg:px-6">
      {/* Hero — the 90-day commitment (the real point: habits, not a deadline) */}
      <div
        className="overflow-hidden rounded-3xl p-6 text-white shadow-lg"
        style={{
          backgroundImage:
            "linear-gradient(135deg, #4c2dd6 0%, #7c5cff 55%, #2dd4bf 150%)",
        }}
      >
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide opacity-80">
          <Flame size={14} /> The 3-Month Plan · 90 days of good habits
        </div>
        <p className="mt-3 text-sm opacity-80">Dedicated to the habits</p>
        <p className="text-4xl font-bold tracking-tight sm:text-5xl">
          Day {commit.day}{" "}
          <span className="text-2xl font-semibold opacity-70">of {commit.total}</span>
        </p>
        <p className="mt-1 text-sm opacity-90">
          Holding the line through ~{fmtDate(commit.endDate)}
        </p>
        <div className="mt-4">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-white transition-all duration-500"
              style={{ width: `${Math.max(2, commit.pct)}%` }}
            />
          </div>
          <p className="mt-2 text-xs opacity-90">
            {commit.day} of {commit.total} days · {Math.round(commit.pct)}%
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {HABITS.map((h) => (
            <span
              key={h.label}
              className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium"
            >
              <span>{h.icon}</span> {h.label}
            </span>
          ))}
        </div>
      </div>

      {/* Scoreboard — debt is the byproduct, not the headline */}
      <Card className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-white">The scoreboard</p>
            <p className="text-xs text-slate-400">Debt falling as the habits hold</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">at this pace</p>
            <p className="text-sm font-semibold text-violet-300">
              ~{fmtDate(payoff.payoffDate)}
            </p>
          </div>
        </div>
        <div className="mt-3">
          <ProgressBar value={clearedPct} color="#2dd4bf" />
          <div className="mt-2 flex justify-between text-xs text-slate-400">
            <span>
              {formatMoney(cleared)} of {formatMoney(totalOriginal)} cleared
            </span>
            <span>firing ~{formatMoney(math.firepower)}/mo</span>
          </div>
        </div>
      </Card>

      {/* The attack ladder — pay a debt right here */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-white">The attack ladder</p>
        <p className="text-xs text-slate-400">Snowball order · smallest first</p>
        <div className="mt-4 space-y-2.5">
          {ordered.map((d, i) => {
            const done = d.balance <= 0.005;
            const isTarget =
              !done && ordered.slice(0, i).every((x) => x.balance <= 0.005);
            const clearsMonth = payoff.perDebt.find((p) => p.id === d.id)?.clearsMonth;
            const clearDate = clearsMonth
              ? fmtDate(new Date(Date.now() + clearsMonth * 30.44 * 864e5))
              : null;
            const pct =
              d.originalBalance > 0
                ? ((d.originalBalance - d.balance) / d.originalBalance) * 100
                : 0;
            return (
              <div
                key={d.id}
                className={`rounded-2xl border p-3.5 ${
                  isTarget
                    ? "border-violet-500/60 bg-violet-500/10"
                    : "border-white/[0.06] bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      done ? "bg-emerald-500 text-white" : "bg-white/10 text-slate-300"
                    }`}
                  >
                    {done ? <Check size={15} /> : i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-white">{d.name}</p>
                      {isTarget && (
                        <span className="flex items-center gap-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-semibold text-violet-200">
                          <Flame size={10} /> Target
                        </span>
                      )}
                      {d.apr != null && (
                        <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300">
                          {d.apr}% APR
                        </span>
                      )}
                    </div>
                    {clearDate && !done && (
                      <p className="text-xs text-slate-400">clears ~{clearDate}</p>
                    )}
                  </div>
                  <p className={`text-sm font-bold ${done ? "text-emerald-400" : "text-white"}`}>
                    {done ? "Cleared" : formatMoney(d.balance)}
                  </p>
                </div>
                {!done && (
                  <div className="mt-2.5">
                    {pct > 0 && <ProgressBar value={pct} color={d.color} />}
                    <button
                      onClick={() => setPayFor(d)}
                      className={`w-full rounded-xl bg-violet-500/15 py-2 text-xs font-semibold text-violet-300 transition hover:bg-violet-500/25 ${
                        pct > 0 ? "mt-2" : ""
                      }`}
                    >
                      Make a payment
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
          <span className="text-sm text-slate-300">Total to clear</span>
          <span className="font-bold text-white">{formatMoney(math.totalDebt)}</span>
        </div>
      </Card>

      {/* The payoff schedule — exactly what to send, and when */}
      <Card className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-white">The payoff plan</p>
            <p className="text-xs text-slate-400">Exactly what to send, each paycheck</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">interest you'll pay</p>
            <p className="text-sm font-semibold text-rose-300">~{formatMoney(totalInterest)}</p>
          </div>
        </div>

        {schedule.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">
            No firepower to schedule — check the budget.
          </p>
        ) : (
          <>
            {/* The immediate, unambiguous instruction */}
            <div className="mt-4 rounded-2xl border border-violet-500/40 bg-violet-500/10 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
                👉 Your next move
              </p>
              <p className="mt-1.5 text-sm text-white">
                On your <span className="font-semibold">{fmtDate(schedule[0].date)}</span> paycheck,
                send <span className="font-bold text-violet-200">{formatMoney(schedule[0].total)}</span>{" "}
                to your debts — split exactly like this:
              </p>
              <div className="mt-3 space-y-1.5">
                {schedule[0].payments.map((p, j) => (
                  <div key={j} className="flex items-center gap-2 text-sm">
                    <span className="font-bold text-white">{formatMoney(p.amount)}</span>
                    <span className="text-slate-400">→</span>
                    <span className="text-slate-200">{shortDebt(p.name)}</span>
                    {p.clears && (
                      <span className="text-xs font-semibold text-emerald-300">paid off ✓</span>
                    )}
                  </div>
                ))}
              </div>
              {clearsList(schedule[0]).length > 0 && (
                <p className="mt-3 border-t border-white/10 pt-2 text-xs font-medium text-emerald-300">
                  That alone wipes out {joinNames(clearsList(schedule[0]))} —{" "}
                  {clearsList(schedule[0]).length} debt
                  {clearsList(schedule[0]).length > 1 ? "s" : ""} gone in one check.
                </p>
              )}
              <p className="mt-2 text-[11px] text-amber-300/80">
                Heads up: this check is light (the trip's sick days), so send what you comfortably
                can — if it's less, the plan just slides a little later. No strain.
              </p>
            </div>

            {/* The rest, paycheck by paycheck */}
            {schedule.length > 1 && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-slate-400">Then each paycheck after:</p>
                <div className="space-y-2">
                  {schedule.slice(1).map((ev, i) => (
                    <div
                      key={i}
                      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3.5"
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-white">{fmtDate(ev.date)}</p>
                        <p className="text-sm font-bold text-violet-300">
                          send {formatMoney(ev.total)}
                        </p>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {ev.toSavings > 0 && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-emerald-300">
                              {formatMoney(ev.toSavings)}
                            </span>
                            <span className="text-slate-500">→</span>
                            <span className="text-slate-300">
                              {ev.savingsKind === "emergency" ? "Emergency fund" : "Investing / goals"}
                            </span>
                            {ev.savingsKind === "emergency" && (
                              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                                {formatMoney(ev.emergencyBalance)} / {formatMoney(SAVINGS_SPLIT.emergencyTarget)}
                              </span>
                            )}
                          </div>
                        )}
                        {ev.payments.map((p, j) => (
                          <div key={j} className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-white">{formatMoney(p.amount)}</span>
                            <span className="text-slate-500">→</span>
                            <span className="text-slate-300">{shortDebt(p.name)}</span>
                            {p.clears && (
                              <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                                PAID OFF
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 border-t border-white/5 pt-1.5 text-[11px] text-slate-500">
                        {ev.remaining <= 0.005 ? "🎉 debt-free!" : `${formatMoney(ev.remaining)} to go`}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <p className="mt-3 text-[11px] text-slate-500">
          Smallest debts first (snowball) for fast wins. Once the …4728 card is all that's left,
          $500/check builds your emergency fund to {formatMoney(SAVINGS_SPLIT.emergencyTarget)} (then rolls into
          investing) and the rest keeps hitting the card.
        </p>
      </Card>

      {/* One-time hits */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-white">One-time hits</p>
        <p className="text-xs text-slate-400">
          Pay from your cash cushion — these don't touch the monthly firepower
        </p>
        <div className="mt-4 space-y-2">
          {ONE_TIMES.map((o) => (
            <div
              key={o.label}
              className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3.5 py-2.5"
            >
              <span className="text-lg">{o.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{o.label}</p>
                {o.note && <p className="truncate text-[11px] text-slate-500">{o.note}</p>}
              </div>
              <span className="text-sm font-semibold text-white">
                {formatMoney(o.amount)}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <PaymentSheet
        debt={payFor}
        accounts={data.accounts}
        onClose={() => setPayFor(null)}
        onPay={payDebtExtra}
      />
    </div>
  );
}

function PaymentSheet({
  debt,
  accounts,
  onClose,
  onPay,
}: {
  debt: Debt | null;
  accounts: Account[];
  onClose: () => void;
  onPay: (id: string, amount: number, fromAccountId?: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const amt = parseFloat(amount);
  const valid = amt > 0 && !!accountId;

  // Default to the first account whenever the sheet opens for a debt.
  useEffect(() => {
    if (debt) setAccountId((prev) => prev || accounts[0]?.id || "");
  }, [debt, accounts]);

  async function submit() {
    if (!debt || !valid) return;
    await onPay(debt.id, amt, accountId);
    setAmount("");
    onClose();
  }

  return (
    <Sheet
      open={!!debt}
      onClose={() => {
        setAmount("");
        onClose();
      }}
      title={debt ? `Pay ${debt.name}` : "Payment"}
    >
      {debt && (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            Balance:{" "}
            <span className="font-semibold text-white">{formatMoney(debt.balance)}</span>
          </p>
          <div>
            <label className={labelClass}>Payment amount</label>
            <input
              className={inputClass}
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {accounts.length > 0 && (
            <div>
              <label className={labelClass}>From account</label>
              <select
                className={inputClass}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} className="bg-slate-800">
                    {a.name} ····{a.last4}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            This moves the cash out of that account and drops the balance — one event, everywhere.
          </p>
          <Button onClick={submit} disabled={!valid} className="w-full">
            Apply payment
          </Button>
        </div>
      )}
    </Sheet>
  );
}
