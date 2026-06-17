import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Wallet,
} from "lucide-react";
import type { Account, Transaction } from "../types";
import { useStore } from "../store/FinanceStore";
import { currentMonthKey, formatDate, formatMoney } from "../lib/format";
import { accountFlow, totalBalance } from "../lib/recurring";
import {
  LEAN_VARIABLE,
  planMath,
  sumTargets,
  UPCOMING_INCOME,
  variableSpentThisMonth,
} from "../lib/plan";
import {
  eventsForMonth,
  monthlySchedule,
  type ScheduleEntry,
} from "../lib/schedule";
import { getCategory } from "../lib/seed";
import {
  Button,
  Card,
  EmptyState,
  inputClass,
  labelClass,
  ProgressBar,
  Sheet,
} from "../components/ui";
import { TransactionRow } from "../components/TransactionRow";
import { AddTransactionSheet } from "../components/AddTransactionSheet";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DOT: Record<string, string> = {
  in: "#34d399",
  out: "#fb7185",
  transfer: "#38bdf8",
};

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

export function Money() {
  const { data, deleteTransaction, setAccountBalance, payBill, markBillPaid } =
    useStore();
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [anchor, setAnchor] = useState<Account | null>(null);
  const [balInput, setBalInput] = useState("");
  const [payFor, setPayFor] = useState<ScheduleEntry | null>(null);

  const totalCash = totalBalance(data.accounts);
  const variable = sumTargets(LEAN_VARIABLE);
  const spent = variableSpentThisMonth(data.transactions, currentMonthKey());
  const math = planMath(data.recurring, data.debts, variable);
  const nextIn = UPCOMING_INCOME.reduce((s, p) => s + p.amount, 0);
  const widthOf = (v: number) => `${(v / math.income) * 100}%`;

  const recent = useMemo(
    () =>
      [...data.transactions]
        // Settled markers are reconciliation bookkeeping, not real activity.
        .filter((t) => !t.appliesTo?.settled)
        .sort((a, b) =>
          a.date === b.date
            ? b.createdAt.localeCompare(a.createdAt)
            : b.date.localeCompare(a.date),
        )
        .slice(0, 8),
    [data.transactions],
  );
  const selectedCat = selected ? getCategory(data.categories, selected.categoryId) : null;

  const monthKey = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}`;
  const { entries, unscheduled } = monthlySchedule(data.recurring, monthKey);
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const firstWeekday = new Date(cursor.y, cursor.m, 1).getDay();
  const byDay = eventsForMonth(entries, daysInMonth);

  const cmpMonth = cursor.y * 12 + cursor.m;
  const curMonth = now.getFullYear() * 12 + now.getMonth();
  const isCurrentMonth = cmpMonth === curMonth;
  const todayNum = now.getDate();

  // The real payment behind a bill installment, if one's been recorded.
  function recordedTxn(e: ScheduleEntry): Transaction | undefined {
    if (!e.recurringId) return undefined;
    return data.transactions.find(
      (t) =>
        t.type === "expense" &&
        t.appliesTo?.kind === "bill" &&
        t.appliesTo.recurringId === e.recurringId &&
        t.appliesTo.monthKey === monthKey &&
        t.appliesTo.day === e.day,
    );
  }
  // We don't guess the current month by date anymore — a bill is paid only if
  // you've recorded it (a real payment) or marked it already-paid. Whole past
  // months are taken as settled (coarse, safe — you're not back-filling history).
  const isPastMonth = cmpMonth < curMonth;
  function billPaid(e: ScheduleEntry): boolean {
    if (!e.recurringId) {
      // An annual auto-charged fee (e.g. Sam's Club) — it just posts on its day,
      // so treat it as paid once that day has passed.
      return isPastMonth || (isCurrentMonth && Math.min(e.day, daysInMonth) <= todayNum);
    }
    return !!recordedTxn(e) || isPastMonth;
  }
  function tapBill(e: ScheduleEntry) {
    if (!e.recurringId) return; // annual auto-fee — nothing to record
    const rec = recordedTxn(e);
    if (rec) return setSelected(rec); // recorded → open it to undo
    if (isPastMonth) return; // a closed month, nothing to do
    setPayFor(e); // this month → pay it, or mark it already paid
  }

  const outEntries = entries.filter((e) => e.direction === "out");
  const paidOut = outEntries.filter(billPaid).reduce((s, e) => s + e.amount, 0);
  const leftOut = outEntries.filter((e) => !billPaid(e)).reduce((s, e) => s + e.amount, 0);
  const leftCount = outEntries.filter((e) => !billPaid(e)).length;

  function shift(delta: number) {
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  if (!data.accounts.length || math.income <= 0) {
    return (
      <div className="px-4 pt-4 lg:px-6">
        <Card>
          <EmptyState icon={<Wallet size={24} />} title="Set up your household first">
            Open Settings → “Set up my household” to load accounts, bills and debts.
          </EmptyState>
        </Card>
      </div>
    );
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="space-y-5 px-4 pb-12 pt-4 lg:px-6">
      {/* Cash + accounts */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Wallet size={16} /> Total cash
        </div>
        <p className="mt-1 text-3xl font-bold tracking-tight text-white">
          {formatMoney(totalCash)}
        </p>
        <div className="mt-4 space-y-2">
          {data.accounts.map((a) => {
            const f = accountFlow(a.id, data.recurring);
            return (
              <button
                key={a.id}
                onClick={() => {
                  setAnchor(a);
                  setBalInput(a.balance.toFixed(2));
                }}
                className="flex w-full items-center justify-between rounded-xl bg-white/5 px-4 py-2.5 text-left transition hover:bg-white/10"
              >
                <div>
                  <p className="text-sm font-medium text-white">
                    {a.name} <span className="text-slate-500">····{a.last4}</span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {a.owner} · {formatMoney(f.net, { sign: true })}/mo
                  </p>
                </div>
                <p className="font-semibold text-white">{formatMoney(a.balance)}</p>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Tap an account to set its real balance from your bank — every event moves it from there.
        </p>
      </Card>

      {/* In vs out — where every dollar of income goes */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-white">In vs out · per month</p>
        <p className="text-xs text-slate-400">Where every dollar of income goes</p>
        <div className="mt-4 flex h-9 w-full overflow-hidden rounded-xl">
          <div
            className="flex items-center justify-center bg-slate-600 text-[10px] font-semibold text-white"
            style={{ width: widthOf(math.fixedNonDebt) }}
          >
            Living
          </div>
          <div
            className="flex items-center justify-center bg-amber-500 text-[10px] font-semibold text-white"
            style={{ width: widthOf(math.variable) }}
          >
            Variable
          </div>
          <div
            className="flex items-center justify-center bg-violet-500 text-[10px] font-semibold text-white"
            style={{ width: widthOf(math.firepower) }}
          >
            Debt
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          <div className="rounded-xl bg-white/5 py-3">
            <p className="text-xs text-slate-400">Income</p>
            <p className="font-semibold text-emerald-400">{formatMoney(math.income)}</p>
          </div>
          <div className="rounded-xl bg-white/5 py-3">
            <p className="text-xs text-slate-400">Living</p>
            <p className="font-semibold text-white">{formatMoney(math.fixedNonDebt)}</p>
          </div>
          <div className="rounded-xl bg-white/5 py-3">
            <p className="text-xs text-slate-400">Variable</p>
            <p className="font-semibold text-white">{formatMoney(math.variable)}</p>
          </div>
          <div className="rounded-xl bg-violet-600/20 py-3">
            <p className="text-xs text-violet-200">At debt</p>
            <p className="font-semibold text-white">{formatMoney(math.firepower)}</p>
          </div>
        </div>
        {/* Variable: the plan target vs what's actually been spent this month */}
        <div className="mt-3 rounded-xl bg-white/5 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Variable spent this month</span>
            <span className="font-bold text-white">
              {formatMoney(spent)}{" "}
              <span className="font-medium text-slate-500">of {formatMoney(variable)}</span>
            </span>
          </div>
          <div className="mt-2">
            <ProgressBar
              value={variable > 0 ? (spent / variable) * 100 : 0}
              color={spent > variable ? "#fb7185" : "#2dd4bf"}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {spent > variable
              ? `${formatMoney(spent - variable)} over the lean target`
              : `${formatMoney(variable - spent)} of headroom left`}
          </p>
        </div>
      </Card>

      {/* Coming up — next checks (a forecast, not yet landed) */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-white">Coming up</p>
        <p className="text-xs text-slate-400">Next checks landing</p>
        <div className="mt-3 space-y-1.5">
          {UPCOMING_INCOME.map((p) => (
            <div key={p.label} className="flex items-center justify-between py-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{p.label}</p>
                <p className="text-[11px] text-slate-500">
                  {p.when}
                  {p.note ? ` · ${p.note}` : ""}
                </p>
              </div>
              <span className="text-sm font-semibold text-emerald-400">
                +{formatMoney(p.amount)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-white/10 pt-2">
            <span className="text-sm font-medium text-slate-300">Total in</span>
            <span className="font-bold text-emerald-400">{formatMoney(nextIn)}</span>
          </div>
        </div>
      </Card>

      {/* Calendar — paid vs left, then the month grid */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <CalendarDays size={16} /> Money calendar
        </div>
        <p className="text-xs text-slate-400">
          Posting days from your bank history · check a bill to record it
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-white/5 py-3">
            <p className="text-xs text-slate-400">Paid so far</p>
            <p className="font-semibold text-emerald-400">{formatMoney(paidOut)}</p>
          </div>
          <div className="rounded-xl bg-violet-600/20 py-3">
            <p className="text-xs text-violet-200">Left to pay</p>
            <p className="font-semibold text-white">{formatMoney(leftOut)}</p>
          </div>
        </div>
      </Card>

      {/* Calendar grid with month flip */}
      <Card className="p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={() => shift(-1)}
            className="rounded-full p-2 text-slate-400 transition hover:bg-white/10"
            aria-label="Previous month"
          >
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-base font-semibold text-white">
            {MONTHS[cursor.m]} {cursor.y}
          </h2>
          <button
            onClick={() => shift(1)}
            className="rounded-full p-2 text-slate-400 transition hover:bg-white/10"
            aria-label="Next month"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
          {WEEKDAYS.map((w, i) => (
            <div key={`w${i}`} className="pb-1 text-center text-[10px] font-medium text-slate-500">
              {w}
            </div>
          ))}
          {cells.map((d, i) => {
            if (d === null) return <div key={`b${i}`} />;
            const evs = byDay.get(d) ?? [];
            const isToday = isCurrentMonth && d === todayNum;
            return (
              <div
                key={d}
                className={`flex min-h-[46px] flex-col items-center rounded-lg border p-1 sm:min-h-[60px] ${
                  evs.length
                    ? "border-white/[0.06] bg-white/[0.03]"
                    : "border-transparent"
                }`}
              >
                <span
                  className={`text-[11px] sm:text-xs ${
                    isToday
                      ? "flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 font-bold text-white"
                      : "text-slate-300"
                  }`}
                >
                  {d}
                </span>
                <div className="mt-1 flex flex-wrap justify-center gap-0.5">
                  {evs.slice(0, 4).map((e, j) => (
                    <span
                      key={j}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background: DOT[e.direction],
                        opacity: e.direction !== "in" && billPaid(e) ? 0.3 : 1,
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: DOT.in }} /> Income
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: DOT.out }} /> Bill
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: DOT.transfer }} /> Transfer
          </span>
          <span className="flex items-center gap-1 text-slate-500">
            <span className="h-2 w-2 rounded-full bg-rose-400/30" /> Paid
          </span>
        </div>
      </Card>

      {/* This month's bills — check a future one to record the payment */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-white">This month's bills</p>
          <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-slate-300">
            {leftCount} left
          </span>
        </div>
        <p className="text-xs text-slate-400">
          Checking a bill moves the cash · a card payment also drops the card
        </p>
        <div className="mt-2 divide-y divide-white/5">
          {outEntries.map((e, i) => {
            const paid = billPaid(e);
            const recorded = !!recordedTxn(e);
            const dd = Math.min(e.day, daysInMonth);
            return (
              <button
                key={`${e.recurringId ?? e.label}-${e.day}-${i}`}
                onClick={() => tapBill(e)}
                className="flex w-full items-center gap-3 py-2.5 text-left transition active:scale-[0.99]"
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ${
                    paid ? "border-emerald-500 bg-emerald-500" : "border-white/25"
                  }`}
                >
                  {paid && <Check size={12} className="text-white" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm ${
                      paid ? "text-slate-500 line-through" : "text-white"
                    }`}
                  >
                    {e.label}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {MONTHS[cursor.m].slice(0, 3)} {dd}
                    {ordinalSuffix(dd)}
                    {e.owner ? ` · ${e.owner}` : ""}
                    {paid && !recorded ? " · settled" : ""}
                  </p>
                </div>
                <span
                  className={`text-sm font-semibold ${
                    paid ? "text-slate-600" : "text-rose-300"
                  }`}
                >
                  −{formatMoney(e.amount)}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* No-fixed-day items */}
      {unscheduled.length > 0 && (
        <Card className="p-4">
          <p className="text-sm font-semibold text-white">No fixed day</p>
          <p className="text-xs text-slate-400">Varies month to month — pay from the Plan ladder</p>
          <div className="mt-2 space-y-1">
            {unscheduled.map((u) => (
              <div key={u.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-slate-300">{u.label}</span>
                <span className="text-sm font-medium text-slate-400">
                  ~{formatMoney(u.amount)}/mo
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Affirm is winding down across several dates — attack it from the Plan's ladder.
          </p>
        </Card>
      )}

      {/* Activity — log + recent */}
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-white">Recent activity</p>
            <p className="text-xs text-slate-400">Every event, newest first</p>
          </div>
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
          >
            <Plus size={14} /> Log
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Nothing logged yet — tap “Log” to add a purchase.
          </p>
        ) : (
          <div className="divide-y divide-white/5">
            {recent.map((t) => (
              <TransactionRow
                key={t.id}
                txn={t}
                categories={data.categories}
                onClick={() => setSelected(t)}
              />
            ))}
          </div>
        )}
      </Card>

      <AddTransactionSheet open={addOpen} onClose={() => setAddOpen(false)} />

      {/* Confirm + record a bill payment */}
      <PayBillSheet
        entry={payFor}
        monthKey={monthKey}
        accounts={data.accounts}
        defaultAccountId={
          data.recurring.find((r) => r.id === payFor?.recurringId)?.accountId
        }
        onClose={() => setPayFor(null)}
        onPay={payBill}
        onMarkPaid={markBillPaid}
      />

      {/* Set a real bank balance */}
      <Sheet
        open={!!anchor}
        onClose={() => setAnchor(null)}
        title={anchor ? `Set ${anchor.name} balance` : "Set balance"}
      >
        {anchor && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Enter the real balance from your bank app. Everything you record moves it from here.
            </p>
            <div>
              <label className={labelClass}>Actual balance</label>
              <input
                className={inputClass}
                type="number"
                inputMode="decimal"
                autoFocus
                value={balInput}
                onChange={(e) => setBalInput(e.target.value)}
              />
            </div>
            <Button
              className="w-full"
              disabled={balInput === "" || isNaN(parseFloat(balInput))}
              onClick={async () => {
                await setAccountBalance(
                  anchor.id,
                  Math.round(parseFloat(balInput) * 100) / 100,
                );
                setAnchor(null);
              }}
            >
              Set balance
            </Button>
          </div>
        )}
      </Sheet>

      {/* Transaction detail — delete to fully undo (cash + any debt/goal) */}
      <Sheet open={!!selected} onClose={() => setSelected(null)} title="Transaction">
        {selected && selectedCat && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-full text-2xl"
                style={{ backgroundColor: selectedCat.color + "33" }}
              >
                {selectedCat.icon}
              </div>
              <div className="flex-1">
                <p className="font-semibold text-white">
                  {selected.description || selectedCat.name}
                </p>
                <p className="text-sm text-slate-400">
                  {selectedCat.name} · {formatDate(selected.date)}
                </p>
              </div>
              <p
                className={`text-lg font-bold ${
                  selected.type === "income" ? "text-emerald-400" : "text-white"
                }`}
              >
                {selected.type === "income" ? "+" : "−"}
                {formatMoney(selected.amount).replace("−", "")}
              </p>
            </div>
            {selected.appliesTo && selected.appliesTo.kind !== "income" && (
              <p className="rounded-lg bg-white/5 px-3 py-2 text-[11px] text-slate-400">
                Deleting this reverses everything it touched — the cash and any
                linked debt or goal.
              </p>
            )}
            <Button
              variant="danger"
              className="w-full"
              onClick={async () => {
                await deleteTransaction(selected.id);
                setSelected(null);
              }}
            >
              <Trash2 size={18} /> Delete transaction
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function PayBillSheet({
  entry,
  monthKey,
  accounts,
  defaultAccountId,
  onClose,
  onPay,
  onMarkPaid,
}: {
  entry: ScheduleEntry | null;
  monthKey: string;
  accounts: Account[];
  defaultAccountId?: string;
  onClose: () => void;
  onPay: (
    recurringId: string,
    monthKey: string,
    amount: number,
    day?: number,
    fromAccountId?: string,
  ) => Promise<void>;
  onMarkPaid: (
    recurringId: string,
    monthKey: string,
    amount: number,
    day?: number,
  ) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (entry) setAccountId(defaultAccountId || accounts[0]?.id || "");
  }, [entry, defaultAccountId, accounts]);

  async function pay() {
    if (!entry?.recurringId || !accountId) return;
    setBusy(true);
    await onPay(entry.recurringId, monthKey, entry.amount, entry.day, accountId);
    setBusy(false);
    onClose();
  }
  async function markPaid() {
    if (!entry?.recurringId) return;
    setBusy(true);
    await onMarkPaid(entry.recurringId, monthKey, entry.amount, entry.day);
    setBusy(false);
    onClose();
  }

  return (
    <Sheet
      open={!!entry}
      onClose={onClose}
      title={entry ? `Pay ${entry.label}` : "Pay bill"}
    >
      {entry && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
            <span className="text-sm text-slate-300">Amount</span>
            <span className="text-lg font-bold text-white">
              {formatMoney(entry.amount)}
            </span>
          </div>
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
          <Button onClick={pay} disabled={!accountId || busy} className="w-full">
            {busy ? "Working…" : "Pay now — move the cash"}
          </Button>
          <p className="text-[11px] text-slate-500">
            Moves the cash out of that account and, for a card minimum, drops that
            card too.
          </p>
          <button
            onClick={markPaid}
            disabled={busy}
            className="w-full rounded-xl bg-white/5 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10 disabled:opacity-40"
          >
            Already paid — just mark it
          </button>
          <p className="text-[11px] text-slate-500">
            Use this for a bill already in your bank balance. Marks it paid without
            moving any money.
          </p>
        </div>
      )}
    </Sheet>
  );
}
