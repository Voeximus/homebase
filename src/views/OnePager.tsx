import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  FileUp,
  Flag,
  LogOut,
  Plus,
  Settings,
  Target,
  Trash2,
  Zap,
} from "lucide-react";
import type { Account, Debt, Transaction } from "../types";
import { useStore } from "../store/FinanceStore";
import { useAuth } from "../auth/AuthProvider";
import {
  currentMonthKey,
  formatDate,
  formatMoney,
  monthLabel,
} from "../lib/format";
import { accountFlow, totalBalance } from "../lib/recurring";
import {
  commitmentProgress,
  HABITS,
  LEAN_VARIABLE,
  lineSpent,
  ONE_TIMES,
  orderedDebts,
  payoffSchedule,
  planMath,
  SAVINGS_SPLIT,
  spentByCategory,
  sumTargets,
  UPCOMING_INCOME,
  variableSpentThisMonth,
  type BudgetLine,
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
import { ImportSheet } from "../components/ImportSheet";
import {
  useActiveSection,
  useCountUp,
  usePrefersReducedMotion,
  useReveal,
  useScrolled,
} from "../lib/hooks";

// ── small helpers ────────────────────────────────────────────────────────────
function shortDebt(name: string): string {
  const m = /…(\d{4})/.exec(name) || /(\d{4})/.exec(name);
  if (m) return "…" + m[1];
  return name.replace(/^Affirm — /, "").replace(/ \(China\)/, "");
}
const isCard4728 = (name: string) => /4728/.test(name);
function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtFull(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function kMoney(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return "$" + Math.round(n);
}
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DOT: Record<string, string> = {
  in: "#46d18a",
  out: "#e5544e",
  transfer: "#5b82b3",
};

const SECTIONS = [
  { id: "nextmove", label: "Next move" },
  { id: "cash", label: "Cash" },
  { id: "sprint", label: "Sprint" },
  { id: "budget", label: "Budget" },
  { id: "bills", label: "Bills" },
  { id: "activity", label: "Activity" },
];

// ── animation atoms ──────────────────────────────────────────────────────────
/** Grow a value from 0 → target once, on mount, for CSS width/dashoffset fills. */
function useGrow(target: number, delay = 120): number {
  const reduced = usePrefersReducedMotion();
  const [v, setV] = useState(reduced ? target : 0);
  useEffect(() => {
    if (reduced) {
      setV(target);
      return;
    }
    const t = setTimeout(() => setV(target), delay);
    return () => clearTimeout(t);
  }, [target, delay, reduced]);
  return v;
}

function CountMoney({
  value,
  className,
  sign,
}: {
  value: number;
  className?: string;
  sign?: boolean;
}) {
  const v = useCountUp(value);
  return (
    <span className={className}>
      {formatMoney(v, sign ? { sign: true } : undefined)}
    </span>
  );
}

function Eyebrow({
  children,
  color = "text-taupe",
}: {
  children: ReactNode;
  color?: string;
}) {
  return <p className={`eyebrow ${color}`}>{children}</p>;
}

/** Fade-up reveal wrapper that also carries the section id + scroll anchor. */
function Reveal({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      id={id}
      ref={ref}
      className={`reveal ${shown ? "is-visible" : ""} ${
        id ? "scroll-mt-[104px]" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────
export function OnePager() {
  const store = useStore();
  const { data, payDebtExtra, payBill, markBillPaid, deleteTransaction } = store;
  const { signOut } = useAuth();

  const scrolled = useScrolled(130);
  const active = useActiveSection(SECTIONS.map((s) => s.id));

  // global sheets
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // drill sheets
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sprintOpen, setSprintOpen] = useState(false);
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [markSentOpen, setMarkSentOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [envLine, setEnvLine] = useState<BudgetLine | null>(null);
  const [payBillFor, setPayBillFor] = useState<ScheduleEntry | null>(null);
  const [txnDetail, setTxnDetail] = useState<Transaction | null>(null);

  // ── the math (single source of truth, all live) ──
  const target = sumTargets(LEAN_VARIABLE);
  const math = planMath(data.recurring, data.debts, target);
  const ordered = orderedDebts(data.debts);
  const today = new Date();
  const schedule = payoffSchedule(ordered, math.firepower, today, [15, 29], SAVINGS_SPLIT);
  const next = schedule[0] ?? null;
  const payoffDate = schedule.length ? schedule[schedule.length - 1].date : null;
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
  const totalOriginal = data.debts.reduce((s, d) => s + d.originalBalance, 0);
  const cleared = totalOriginal - math.totalDebt;
  const clearedPct = totalOriginal > 0 ? (cleared / totalOriginal) * 100 : 0;
  const commit = commitmentProgress(today);
  const totalCash = totalBalance(data.accounts);
  const monthKey = currentMonthKey();
  const spent = variableSpentThisMonth(data.transactions, monthKey);
  const byCat = spentByCategory(data.transactions, monthKey);
  const netFlow = data.accounts.reduce(
    (s, a) => s + accountFlow(a.id, data.recurring).net,
    0,
  );

  // bills (current month)
  const { entries } = monthlySchedule(data.recurring, monthKey);
  const outEntries = entries.filter((e) => e.direction === "out");
  const todayNum = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(today.getFullYear(), today.getMonth(), 1).getDay();
  const byDay = eventsForMonth(entries, daysInMonth);
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
  function billPaid(e: ScheduleEntry): boolean {
    if (!e.recurringId) return Math.min(e.day, daysInMonth) <= todayNum;
    return !!recordedTxn(e);
  }
  const paidOut = outEntries.filter(billPaid).reduce((s, e) => s + e.amount, 0);
  const leftBills = outEntries.filter((e) => !billPaid(e));
  const leftOut = leftBills.reduce((s, e) => s + e.amount, 0);

  const recent = useMemo(
    () =>
      [...data.transactions]
        .filter((t) => !t.appliesTo?.settled)
        .sort((a, b) =>
          a.date === b.date
            ? b.createdAt.localeCompare(a.createdAt)
            : b.date.localeCompare(a.date),
        )
        .slice(0, 6),
    [data.transactions],
  );

  // setup guard
  if (data.debts.length === 0 || math.income <= 0) {
    return (
      <div className="mx-auto min-h-screen max-w-[640px] px-4 pt-16">
        <Card className="p-2">
          <EmptyState icon={<Target size={24} />} title="Set up your household">
            Load your income, bills and debts and the whole plan maps itself out
            here.
          </EmptyState>
          <Button className="mb-4 w-full" onClick={() => setSettingsOpen(true)}>
            Open setup
          </Button>
        </Card>
        <SettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onImport={() => {
            setSettingsOpen(false);
            setImportOpen(true);
          }}
        />
        <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      </div>
    );
  }

  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const lightCheck = !!next && next.date < new Date("2026-06-30T00:00:00");

  return (
    <div className="min-h-screen">
      {/* ── sticky header + jump chips ── */}
      <div className="safe-top sticky top-0 z-40 border-b border-edge bg-bg/90 backdrop-blur">
        <div className="mx-auto max-w-[640px] px-4">
          <div className="flex h-14 items-center justify-between">
            {scrolled ? (
              <>
                <button
                  onClick={() => scrollTo("cash")}
                  className="text-left leading-tight"
                >
                  <span className="num text-base font-semibold text-mint">
                    {formatMoney(totalCash)}
                  </span>
                  <span className="ml-1.5 text-[11px] text-faint">cash</span>
                </button>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-taupe">
                    Day {commit.day} ·{" "}
                    {next && (
                      <>
                        {fmtDay(next.date)}{" "}
                        <span className="num font-semibold text-accent">
                          {formatMoney(next.total)}
                        </span>
                      </>
                    )}
                  </span>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="rounded-full p-1.5 text-taupe transition hover:bg-raised"
                    aria-label="Settings"
                  >
                    <Settings size={17} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="leading-none">
                  <p className="text-[15px] font-semibold text-bone">Homebase</p>
                  <Eyebrow color="text-faint">
                    {today
                      .toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })
                      .replace(",", " ·")}
                  </Eyebrow>
                </div>
                <div className="flex items-center gap-2">
                  <span className="hidden items-center gap-1.5 rounded-full bg-raised py-1 pl-1 pr-3 sm:flex">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-bg">
                      G
                    </span>
                    <span className="text-xs font-medium text-taupe">+ X</span>
                  </span>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="rounded-full p-2 text-taupe transition hover:bg-raised"
                    aria-label="Settings"
                  >
                    <Settings size={18} />
                  </button>
                  <button
                    onClick={() => signOut()}
                    className="rounded-full p-2 text-taupe transition hover:bg-raised"
                    aria-label="Logout"
                  >
                    <LogOut size={17} />
                  </button>
                </div>
              </>
            )}
          </div>
          {/* jump chips */}
          <div className="hide-scroll -mx-4 flex gap-2 overflow-x-auto px-4 pb-2.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${
                  active === s.id
                    ? "bg-accent text-bg"
                    : "bg-tile text-taupe hover:text-bone"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[640px] space-y-3 px-4 pb-28 pt-4">
        {/* ── HERO · the next move ── */}
        <Reveal id="nextmove">
          <div className="hero-bar overflow-hidden rounded-xl border border-edgehero bg-hero p-5">
            <Eyebrow color="text-accent">
              <Zap size={11} className="-mt-0.5 mr-1 inline" />
              Your next move {next ? `· ${fmtDay(next.date)}` : ""}
            </Eyebrow>

            {next ? (
              <>
                <div className="slip-recess mt-3 rounded-xl p-4">
                  <p className="text-[22px] font-medium leading-snug text-bone">
                    On your{" "}
                    <span className="text-accent">{fmtDay(next.date)}</span> check,
                    send{" "}
                    <CountMoney value={next.total} className="num font-semibold text-accent" />
                  </p>
                  <div className="mt-3 space-y-1.5">
                    {next.toSavings > 0 && (
                      <SplitChip
                        label={
                          next.savingsKind === "emergency"
                            ? "Emergency fund"
                            : "Investing / goals"
                        }
                        amount={next.toSavings}
                        tone="mint"
                      />
                    )}
                    {next.payments.map((p, i) => (
                      <SplitChip
                        key={i}
                        label={shortDebt(p.name)}
                        sub={isCard4728(p.name) ? "26.49%" : undefined}
                        amount={p.amount}
                        tone={isCard4728(p.name) ? "ember" : "default"}
                        cleared={p.clears}
                      />
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => setMarkSentOpen(true)}
                  className="breathe mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-semibold text-bg transition active:scale-[0.98]"
                >
                  Mark sent <ArrowRight size={16} />
                </button>
                <p
                  className={`mt-2.5 text-center text-[11px] ${
                    lightCheck ? "text-gold/90" : "text-faint"
                  }`}
                >
                  {lightCheck
                    ? "This check is light (the trip) — send what you comfortably can; the plan just slides a little."
                    : "Send what you comfortably can. Tap the slip to see the whole payday-by-payday plan."}
                </p>
                <button
                  onClick={() => setScheduleOpen(true)}
                  className="mt-1 w-full text-center text-[11px] font-medium text-accent/80"
                >
                  See the full payoff plan →
                </button>
              </>
            ) : (
              <p className="mt-3 text-sm text-taupe">
                No firepower scheduled — check the budget.
              </p>
            )}
          </div>
        </Reveal>

        {/* ── CASH + STREAK ── */}
        <Reveal id="cash">
          <div className="grid grid-cols-2 gap-3">
            {/* cash */}
            <button
              onClick={() => setAccountsOpen(true)}
              className="rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.99]"
            >
              <Eyebrow>Cash on hand</Eyebrow>
              <CountMoney
                value={totalCash}
                className="num mt-1 block text-2xl font-medium tracking-tight text-bone"
              />
              <OwnerBar accounts={data.accounts} total={totalCash} />
              <p className="mt-2 text-[11px] text-mint">
                {formatMoney(netFlow, { sign: true })}/mo net
              </p>
            </button>
            {/* streak */}
            <button
              onClick={() => setHabitsOpen(true)}
              className="flex flex-col items-center rounded-xl border border-edge bg-tile p-4 text-center transition active:scale-[0.99]"
            >
              <Eyebrow>The habit</Eyebrow>
              <StreakRing day={commit.day} total={commit.total} pct={commit.pct} />
              <div className="mt-2 flex gap-1.5 text-sm">
                {HABITS.map((h) => (
                  <span key={h.label}>{h.icon}</span>
                ))}
              </div>
            </button>
          </div>
        </Reveal>

        {/* ── SPRINT · the road ── */}
        <Reveal id="sprint">
          <button
            onClick={() => setSprintOpen(true)}
            className="block w-full rounded-xl border border-edge bg-tile p-5 text-left transition active:scale-[0.99]"
          >
            <Eyebrow>
              The sprint · debt-free{" "}
              {payoffDate ? payoffDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '") : "soon"}
            </Eyebrow>
            <div className="mt-1 flex items-end justify-between">
              <CountMoney
                value={math.totalDebt}
                className="num text-2xl font-medium tracking-tight text-bone"
              />
              <span className="rounded-full bg-mint/15 px-2.5 py-0.5 text-[11px] font-semibold text-mint">
                Free by {payoffDate ? payoffDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '") : "soon"}
              </span>
            </div>
            <RunnerRoad startLabel={kMoney(totalOriginal)} pct={clearedPct} />
            <p className="mt-2 text-[11px] text-taupe">
              <span className="font-medium text-accent">
                firing {formatMoney(math.firepower)}/mo
              </span>{" "}
              · {formatMoney(cleared)} of {formatMoney(totalOriginal)} cleared · tap for the ladder
            </p>
          </button>
        </Reveal>

        {/* ── FIREPOWER + SPENT ── */}
        <Reveal id="metrics">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setIncomeOpen(true)}
              className="rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.99]"
            >
              <Eyebrow>Firepower / mo</Eyebrow>
              <CountMoney
                value={math.firepower}
                className="num mt-1 block text-2xl font-medium tracking-tight text-accent"
              />
              <p className="mt-1 text-[11px] text-taupe">income − living − variable</p>
            </button>
            <button
              onClick={() => scrollTo("budget")}
              className="rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.99]"
            >
              <Eyebrow>Spent this month</Eyebrow>
              <p className="num mt-1 text-2xl font-medium tracking-tight text-bone">
                {formatMoney(spent)}
              </p>
              <p className="text-[11px] text-taupe">
                of {formatMoney(target)} lean
              </p>
              <div className="mt-2">
                <ProgressBar
                  value={target > 0 ? (spent / target) * 100 : 0}
                  color={spent > target ? "#e5544e" : spent > target * 0.8 ? "#e3b341" : "#46d18a"}
                />
              </div>
            </button>
          </div>
        </Reveal>

        {/* ── BUDGET · envelopes ── */}
        <Reveal id="budget">
          <div className="rounded-xl border border-edge bg-tile p-5">
            <Eyebrow>This month's envelopes</Eyebrow>
            <p className="mb-3 mt-0.5 text-xs text-taupe">{monthLabel(monthKey)}</p>
            <div className="grid grid-cols-2 gap-3">
              {LEAN_VARIABLE.map((l) => {
                const sp = lineSpent(l, byCat);
                const pct = l.target > 0 ? (sp / l.target) * 100 : 0;
                const over = sp > l.target + 0.005;
                const near = !over && pct > 80;
                const color = over ? "#e5544e" : near ? "#e3b341" : "#46d18a";
                return (
                  <button
                    key={l.key}
                    onClick={() => setEnvLine(l)}
                    className="rounded-xl bg-raised p-3 text-left transition active:scale-[0.98]"
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="text-base leading-none">{l.icon}</span>
                      <span className="text-xs font-medium leading-tight text-bone">
                        {l.label}
                      </span>
                    </div>
                    <p className="num mt-1.5 text-[13px] font-medium text-bone">
                      {formatMoney(sp)}
                      <span className="text-[11px] font-normal text-faint">
                        {" "}
                        / {formatMoney(l.target)}
                      </span>
                    </p>
                    <div className="mt-1.5">
                      <ProgressBar value={pct} color={color} track="rgba(0,0,0,0.3)" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        {/* ── BILLS ── */}
        <Reveal id="bills">
          <div className="rounded-xl border border-edge bg-tile p-5">
            <div className="flex items-center justify-between">
              <Eyebrow>This month's bills</Eyebrow>
              <span className="text-[11px] text-taupe">
                <span className="text-mint">{formatMoney(paidOut)} paid</span> ·{" "}
                {formatMoney(leftOut)} left
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {outEntries.map((e, i) => {
                const paid = billPaid(e);
                return (
                  <button
                    key={`${e.recurringId ?? e.label}-${e.day}-${i}`}
                    onClick={() => {
                      const rec = recordedTxn(e);
                      if (rec) return setTxnDetail(rec);
                      if (e.recurringId) setPayBillFor(e);
                    }}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition ${
                      paid
                        ? "bg-raised text-faint"
                        : "border border-gold/40 bg-gold/10 text-gold"
                    }`}
                  >
                    {paid && <Check size={12} />}
                    <span className={paid ? "line-through" : ""}>{e.label}</span>
                    <span className="font-medium">
                      {formatMoney(e.amount)}
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setCalOpen((v) => !v)}
              className="mt-4 flex w-full items-center justify-between rounded-xl bg-raised px-4 py-2.5 text-left"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-taupe">
                <CalendarDays size={14} /> Money calendar
              </span>
              <ChevronDown
                size={15}
                className={`text-taupe transition-transform ${calOpen ? "rotate-180" : ""}`}
              />
            </button>
            {calOpen && (
              <MiniCalendar
                year={today.getFullYear()}
                month={today.getMonth()}
                daysInMonth={daysInMonth}
                firstWeekday={firstWeekday}
                todayNum={todayNum}
                byDay={byDay}
                billPaid={billPaid}
              />
            )}

            <div className="mt-4 border-t border-edge pt-3">
              <Eyebrow color="text-faint">Coming up</Eyebrow>
              <div className="mt-2 space-y-1.5">
                {UPCOMING_INCOME.map((p) => (
                  <div key={p.label} className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] text-bone">{p.label}</p>
                      <p className="text-[11px] text-faint">{p.when}</p>
                    </div>
                    <span className="text-[13px] font-semibold text-mint">
                      +{formatMoney(p.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>

        {/* ── ACTIVITY ── */}
        <Reveal id="activity">
          <div className="rounded-xl border border-edge bg-tile p-2">
            <div className="px-3 pt-3">
              <Eyebrow>Just happened</Eyebrow>
            </div>
            {recent.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-faint">
                Nothing logged yet.
              </p>
            ) : (
              <div className="mt-1 divide-y divide-edge">
                {recent.map((t) => (
                  <TransactionRow
                    key={t.id}
                    txn={t}
                    categories={data.categories}
                    onClick={() => setTxnDetail(t)}
                  />
                ))}
              </div>
            )}
            <div className="flex gap-2 p-3">
              <Button className="flex-1" onClick={() => setAddOpen(true)}>
                <Plus size={16} /> Log a purchase
              </Button>
              <Button variant="ghost" onClick={() => setImportOpen(true)}>
                <FileUp size={16} /> Import
              </Button>
            </div>
          </div>
        </Reveal>

        <p className="pt-1 text-center text-[11px] text-faint">
          One event ripples everywhere — cash, debt, and the plan stay in step.
        </p>
      </main>

      {/* floating add */}
      <button
        onClick={() => setAddOpen(true)}
        className="fixed bottom-6 right-5 z-30 flex items-center justify-center rounded-full bg-accent text-bg shadow-lg transition active:scale-95"
        style={{ height: 52, width: 52 }}
        aria-label="Add transaction"
      >
        <Plus size={24} />
      </button>

      {/* ── sheets ── */}
      <AddTransactionSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onImport={() => {
          setSettingsOpen(false);
          setImportOpen(true);
        }}
      />
      <AccountsSheet open={accountsOpen} onClose={() => setAccountsOpen(false)} />
      <HabitsSheet
        open={habitsOpen}
        onClose={() => setHabitsOpen(false)}
        commit={commit}
      />
      <ScheduleSheet
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        schedule={schedule}
        totalInterest={totalInterest}
      />
      <SprintSheet
        open={sprintOpen}
        onClose={() => setSprintOpen(false)}
        ordered={ordered}
        schedule={schedule}
        totalDebt={math.totalDebt}
      />
      <IncomeSheet
        open={incomeOpen}
        onClose={() => setIncomeOpen(false)}
        math={math}
      />
      <MarkSentSheet
        open={markSentOpen}
        onClose={() => setMarkSentOpen(false)}
        next={next}
        accounts={data.accounts}
        onPay={payDebtExtra}
      />
      <EnvelopeSheet
        line={envLine}
        onClose={() => setEnvLine(null)}
        monthKey={monthKey}
      />
      <PayBillSheet
        entry={payBillFor}
        monthKey={monthKey}
        accounts={data.accounts}
        defaultAccountId={
          data.recurring.find((r) => r.id === payBillFor?.recurringId)?.accountId
        }
        onClose={() => setPayBillFor(null)}
        onPay={payBill}
        onMarkPaid={markBillPaid}
      />
      <TxnDetailSheet
        txn={txnDetail}
        categories={data.categories}
        onClose={() => setTxnDetail(null)}
        onDelete={deleteTransaction}
      />
    </div>
  );
}

// ── presentational atoms ─────────────────────────────────────────────────────
function SplitChip({
  label,
  sub,
  amount,
  tone = "default",
  cleared,
}: {
  label: string;
  sub?: string;
  amount: number;
  tone?: "default" | "ember" | "mint";
  cleared?: boolean;
}) {
  const accent =
    tone === "ember" ? "border-l-2 border-ember/60" : tone === "mint" ? "border-l-2 border-mint/60" : "";
  return (
    <div className={`flex items-center gap-2 rounded-lg bg-raised px-3 py-1.5 ${accent}`}>
      <ArrowRight size={12} className="shrink-0 text-faint" />
      <span className="text-[13px] text-bone">{label}</span>
      {sub && <span className="text-[11px] text-ember">{sub}</span>}
      {cleared && (
        <span className="rounded-full bg-mint/15 px-1.5 text-[10px] font-semibold text-mint">
          ✓ paid off
        </span>
      )}
      <span className="ml-auto text-[13px] font-semibold text-bone">
        {formatMoney(amount)}
      </span>
    </div>
  );
}

function OwnerBar({ accounts, total }: { accounts: Account[]; total: number }) {
  const colors: Record<string, string> = {
    Gino: "#5b82b3",
    Xinyan: "#46d18a",
    Joint: "#687180",
  };
  if (total <= 0) return null;
  return (
    <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full">
      {accounts.map((a) => (
        <div
          key={a.id}
          style={{
            width: `${(Math.max(0, a.balance) / total) * 100}%`,
            background: colors[a.owner] ?? "#8a8478",
          }}
        />
      ))}
    </div>
  );
}

function StreakRing({
  day,
  total,
  pct,
}: {
  day: number;
  total: number;
  pct: number;
}) {
  const grown = useGrow(pct);
  const r = 32;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, grown) / 100);
  return (
    <div className="relative mt-1 h-[84px] w-[84px]">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--color-raised)" strokeWidth="7" />
        <circle
          className="ring-pulse"
          cx="42"
          cy="42"
          r={r}
          fill="none"
          stroke="var(--color-gold)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          transform="rotate(-90 42 42)"
          style={{ transition: "stroke-dashoffset 800ms ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="num text-xl font-semibold text-bone">{day}</span>
        <span className="text-[10px] text-faint">of {total}</span>
      </div>
    </div>
  );
}

function RunnerRoad({ startLabel, pct }: { startLabel: string; pct: number }) {
  const grown = useGrow(Math.max(2, Math.min(100, pct)));
  return (
    <div className="mt-3">
      <div className="relative h-2 rounded-sm bg-raised">
        {/* ruler ticks at 25 / 50 / 75% */}
        {[25, 50, 75].map((t) => (
          <span
            key={t}
            className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-bg/70"
            style={{ left: `${t}%` }}
          />
        ))}
        <div
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{
            width: `${grown}%`,
            background: "linear-gradient(90deg,#176b73,#34c5e8)",
            transition: "width 900ms cubic-bezier(.2,.7,.3,1)",
          }}
        />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-bg bg-accent"
          style={{
            left: `${grown}%`,
            marginLeft: -7,
            transition: "left 900ms cubic-bezier(.2,.7,.3,1)",
          }}
        />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-faint">
        <span>{startLabel}</span>
        <span className="flex items-center gap-1 text-mint">
          <Flag size={10} /> NOV '26
        </span>
      </div>
    </div>
  );
}

function MiniCalendar({
  month,
  daysInMonth,
  firstWeekday,
  todayNum,
  byDay,
  billPaid,
}: {
  year: number;
  month: number;
  daysInMonth: number;
  firstWeekday: number;
  todayNum: number;
  byDay: Map<number, ScheduleEntry[]>;
  billPaid: (e: ScheduleEntry) => boolean;
}) {
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return (
    <div className="mt-2 rounded-xl bg-raised p-3">
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="pb-1 text-center text-[9px] text-faint">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} />;
          const evs = byDay.get(d) ?? [];
          const isToday = d === todayNum;
          return (
            <div key={d} className="flex min-h-[36px] flex-col items-center">
              <span
                className={`text-[10px] ${
                  isToday
                    ? "flex h-4 w-4 items-center justify-center rounded-full bg-accent font-bold text-bg"
                    : "text-taupe"
                }`}
              >
                {d}
              </span>
              <div className="mt-0.5 flex flex-wrap justify-center gap-0.5">
                {evs.slice(0, 4).map((e, j) => (
                  <span
                    key={j}
                    className="h-1 w-1 rounded-full"
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
      <p className="mt-2 text-[10px] text-faint">
        {MONTHS[month]} · dots mark income, bills & transfers
      </p>
    </div>
  );
}

// ── sheets ───────────────────────────────────────────────────────────────────
function AccountsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, setAccountBalance } = useStore();
  const [edit, setEdit] = useState<Account | null>(null);
  const [val, setVal] = useState("");
  return (
    <Sheet open={open} onClose={onClose} title="Cash & accounts">
      <div className="space-y-2">
        {data.accounts.map((a) => {
          const f = accountFlow(a.id, data.recurring);
          const editing = edit?.id === a.id;
          return (
            <div key={a.id} className="rounded-xl bg-raised p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-bone">
                    {a.name}{" "}
                    <span className="text-faint">····{a.last4}</span>
                  </p>
                  <p className="text-[11px] text-faint">
                    {a.owner} · {formatMoney(f.net, { sign: true })}/mo
                  </p>
                </div>
                {editing ? (
                  <span className="text-sm text-faint">editing…</span>
                ) : (
                  <button
                    onClick={() => {
                      setEdit(a);
                      setVal(a.balance.toFixed(2));
                    }}
                    className="text-right"
                  >
                    <span className="font-semibold text-bone">
                      {formatMoney(a.balance)}
                    </span>
                    <span className="block text-[10px] text-accent">tap to set</span>
                  </button>
                )}
              </div>
              {editing && (
                <div className="mt-3 flex gap-2">
                  <input
                    className={inputClass}
                    type="number"
                    inputMode="decimal"
                    autoFocus
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                  />
                  <Button
                    onClick={async () => {
                      await setAccountBalance(
                        a.id,
                        Math.round(parseFloat(val) * 100) / 100,
                      );
                      setEdit(null);
                    }}
                    disabled={val === "" || isNaN(parseFloat(val))}
                  >
                    Set
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        <p className="px-1 text-[11px] text-faint">
          Set each account to the real balance from your bank — every event moves
          it from there.
        </p>
      </div>
    </Sheet>
  );
}

function HabitsSheet({
  open,
  onClose,
  commit,
}: {
  open: boolean;
  onClose: () => void;
  commit: { day: number; total: number; pct: number; endDate: Date };
}) {
  return (
    <Sheet open={open} onClose={onClose} title="The 90-day commitment">
      <div className="space-y-4">
        <p className="text-sm text-taupe">
          The real point isn't a deadline — it's 90 days of dedicated good habits.
          Debt-free is the scoreboard; the habits are the win.
        </p>
        <div className="rounded-xl bg-raised p-4 text-center">
          <p className="text-3xl font-semibold text-bone">
            Day {commit.day}{" "}
            <span className="text-lg text-faint">of {commit.total}</span>
          </p>
          <p className="mt-1 text-[11px] text-taupe">
            holding through {fmtFull(commit.endDate)}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {HABITS.map((h) => (
            <div
              key={h.label}
              className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-sm text-bone"
            >
              <span className="text-lg">{h.icon}</span> {h.label}
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function ScheduleSheet({
  open,
  onClose,
  schedule,
  totalInterest,
}: {
  open: boolean;
  onClose: () => void;
  schedule: ReturnType<typeof payoffSchedule>;
  totalInterest: number;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="The payoff plan">
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
          <span className="text-sm text-taupe">Interest you'll pay</span>
          <span className="font-semibold text-ember">~{formatMoney(totalInterest)}</span>
        </div>
        {schedule.map((ev, i) => (
          <div key={i} className="rounded-xl border border-edge bg-raised p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-bone">{fmtFull(ev.date)}</p>
              <p className="text-sm font-bold text-accent">
                send {formatMoney(ev.total)}
              </p>
            </div>
            <div className="mt-2 space-y-1">
              {ev.toSavings > 0 && (
                <Line
                  label={ev.savingsKind === "emergency" ? "Emergency fund" : "Investing"}
                  amount={ev.toSavings}
                  mint
                />
              )}
              {ev.payments.map((p, j) => (
                <Line
                  key={j}
                  label={shortDebt(p.name)}
                  amount={p.amount}
                  cleared={p.clears}
                />
              ))}
            </div>
            <p className="mt-2 border-t border-edge pt-1.5 text-[11px] text-faint">
              {ev.remaining <= 0.005 ? "🎉 debt-free!" : `${formatMoney(ev.remaining)} to go`}
            </p>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function Line({
  label,
  amount,
  mint,
  cleared,
}: {
  label: string;
  amount: number;
  mint?: boolean;
  cleared?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`font-semibold ${mint ? "text-mint" : "text-bone"}`}>
        {formatMoney(amount)}
      </span>
      <span className="text-faint">→</span>
      <span className="text-taupe">{label}</span>
      {cleared && (
        <span className="rounded-full bg-mint/15 px-1.5 text-[9px] font-bold text-mint">
          PAID OFF
        </span>
      )}
    </div>
  );
}

function SprintSheet({
  open,
  onClose,
  ordered,
  schedule,
  totalDebt,
}: {
  open: boolean;
  onClose: () => void;
  ordered: Debt[];
  schedule: ReturnType<typeof payoffSchedule>;
  totalDebt: number;
}) {
  const { payDebtExtra, data } = useStore();
  const [payFor, setPayFor] = useState<Debt | null>(null);
  const clearDateOf = (id: string) => {
    const ev = schedule.find((e) => e.payments.some((p) => p.debtId === id && p.clears));
    return ev ? ev.date : null;
  };
  return (
    <>
      <Sheet open={open} onClose={onClose} title="The attack ladder">
        <div className="space-y-2.5">
          <p className="text-xs text-taupe">Snowball order · smallest first</p>
          {ordered.map((d, i) => {
            const done = d.balance <= 0.005;
            const isTarget = !done && ordered.slice(0, i).every((x) => x.balance <= 0.005);
            const cd = clearDateOf(d.id);
            const pct = d.originalBalance > 0 ? ((d.originalBalance - d.balance) / d.originalBalance) * 100 : 0;
            return (
              <div
                key={d.id}
                className={`rounded-xl border p-3 ${
                  isTarget ? "border-accent/50 bg-accent/10" : "border-edge bg-raised"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      done ? "bg-mint text-bg" : "bg-tile text-taupe"
                    }`}
                  >
                    {done ? <Check size={13} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-bone">{d.name}</span>
                      {d.apr != null && d.apr > 20 && (
                        <span className="rounded-full bg-ember/15 px-1.5 text-[10px] font-medium text-ember">
                          {d.apr}%
                        </span>
                      )}
                    </div>
                    {cd && !done && (
                      <p className="text-[11px] text-faint">clears ~{fmtDay(cd)}</p>
                    )}
                  </div>
                  <span className={`text-sm font-bold ${done ? "text-mint" : "text-bone"}`}>
                    {done ? "Cleared" : formatMoney(d.balance)}
                  </span>
                </div>
                {!done && (
                  <div className="mt-2">
                    {pct > 0 && <ProgressBar value={pct} color={d.color} />}
                    <button
                      onClick={() => setPayFor(d)}
                      className={`w-full rounded-lg bg-accent/15 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25 ${pct > 0 ? "mt-2" : ""}`}
                    >
                      Make a payment
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
            <span className="text-sm text-taupe">Total to clear</span>
            <span className="font-bold text-bone">{formatMoney(totalDebt)}</span>
          </div>
        </div>
      </Sheet>
      <PaymentSheet
        debt={payFor}
        accounts={data.accounts}
        onClose={() => setPayFor(null)}
        onPay={payDebtExtra}
      />
    </>
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
  useEffect(() => {
    if (debt) setAccountId((p) => p || accounts[0]?.id || "");
  }, [debt, accounts]);
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
          <p className="text-sm text-taupe">
            Balance: <span className="font-semibold text-bone">{formatMoney(debt.balance)}</span>
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
                  <option key={a.id} value={a.id} className="bg-tile">
                    {a.name} ····{a.last4}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button
            onClick={async () => {
              if (!debt || !valid) return;
              await onPay(debt.id, amt, accountId);
              setAmount("");
              onClose();
            }}
            disabled={!valid}
            className="w-full"
          >
            Apply payment
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function IncomeSheet({
  open,
  onClose,
  math,
}: {
  open: boolean;
  onClose: () => void;
  math: ReturnType<typeof planMath>;
}) {
  const widthOf = (v: number) => `${(v / math.income) * 100}%`;
  return (
    <Sheet open={open} onClose={onClose} title="Where every dollar goes">
      <div className="space-y-4">
        <div className="flex h-9 w-full overflow-hidden rounded-xl">
          <div className="flex items-center justify-center bg-steel text-[10px] font-semibold text-bg" style={{ width: widthOf(math.fixedNonDebt) }}>
            Living
          </div>
          <div className="flex items-center justify-center bg-gold text-[10px] font-semibold text-bg" style={{ width: widthOf(math.variable) }}>
            Variable
          </div>
          <div className="flex items-center justify-center bg-accent text-[10px] font-semibold text-bg" style={{ width: widthOf(math.firepower) }}>
            Debt
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <Stat label="Income" value={formatMoney(math.income)} tone="text-mint" />
          <Stat label="Living" value={formatMoney(math.fixedNonDebt)} />
          <Stat label="Variable" value={formatMoney(math.variable)} />
          <Stat label="At the debt" value={formatMoney(math.firepower)} tone="text-accent" />
        </div>
        <p className="text-[11px] text-faint">
          Holding the lean budget is what frees ~{formatMoney(math.firepower)}/mo to
          attack the debt. The one-time hits below come from your cash cushion, not
          this firepower.
        </p>
        <div className="space-y-1.5">
          {ONE_TIMES.map((o) => (
            <div key={o.label} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2">
              <span>{o.icon}</span>
              <span className="flex-1 text-sm text-bone">{o.label}</span>
              <span className="text-sm font-semibold text-bone">{formatMoney(o.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function Stat({
  label,
  value,
  tone = "text-bone",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl bg-raised py-3">
      <p className="text-xs text-taupe">{label}</p>
      <p className={`font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function MarkSentSheet({
  open,
  onClose,
  next,
  accounts,
  onPay,
}: {
  open: boolean;
  onClose: () => void;
  next: ReturnType<typeof payoffSchedule>[number] | null;
  accounts: Account[];
  onPay: (id: string, amount: number, fromAccountId?: string) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (open) {
      setAccountId((p) => p || accounts[0]?.id || "");
      setDone(false);
    }
  }, [open, accounts]);
  if (!next) return null;
  return (
    <Sheet open={open} onClose={onClose} title="Record this payment">
      {done ? (
        <div className="flex flex-col items-center py-6 text-center">
          <span className="pop flex h-16 w-16 items-center justify-center rounded-full bg-mint text-bg">
            <Check size={32} />
          </span>
          <p className="mt-4 text-lg font-semibold text-bone">Sent!</p>
          <p className="mt-1 text-sm text-taupe">
            Cash, debt and the sprint all moved.
          </p>
          <Button className="mt-5 w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-taupe">
            Recording <span className="font-semibold text-accent">{formatMoney(next.payments.reduce((s, p) => s + p.amount, 0))}</span> across these debts. This moves the cash and drops each balance.
          </p>
          <div className="space-y-1.5">
            {next.payments.map((p, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-raised px-3 py-2 text-sm">
                <span className="text-bone">{shortDebt(p.name)}</span>
                <span className="font-semibold text-bone">{formatMoney(p.amount)}</span>
              </div>
            ))}
          </div>
          {next.toSavings > 0 && (
            <p className="rounded-lg bg-mint/10 px-3 py-2 text-[11px] text-mint">
              Plus {formatMoney(next.toSavings)} to {next.savingsKind === "emergency" ? "your emergency fund" : "investing"} — move that yourself in your bank.
            </p>
          )}
          <div>
            <label className={labelClass}>From account</label>
            <select
              className={inputClass}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id} className="bg-tile">
                  {a.name} ····{a.last4}
                </option>
              ))}
            </select>
          </div>
          <Button
            className="w-full"
            disabled={!accountId || busy}
            onClick={async () => {
              setBusy(true);
              for (const p of next.payments) {
                await onPay(p.debtId, p.amount, accountId);
              }
              setBusy(false);
              setDone(true);
            }}
          >
            {busy ? "Recording…" : "Confirm — record payment"}
          </Button>
          <p className="text-[11px] text-faint">
            Only do this once you've actually sent it. Deleting the entries later
            fully reverses everything.
          </p>
        </div>
      )}
    </Sheet>
  );
}

function EnvelopeSheet({
  line,
  onClose,
  monthKey,
}: {
  line: BudgetLine | null;
  onClose: () => void;
  monthKey: string;
}) {
  const { data, setTransactionCategory, deleteTransaction } = useStore();
  const [edit, setEdit] = useState<Transaction | null>(null);
  const expenseCats = data.categories.filter(
    (c) => c.type === "expense" || c.type === "both",
  );
  const txns = line
    ? data.transactions
        .filter(
          (t) =>
            t.type === "expense" &&
            t.date.slice(0, 7) === monthKey &&
            !t.appliesTo &&
            line.cats.includes(t.categoryId),
        )
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];
  const spent = txns.reduce((s, t) => s + t.amount, 0);
  return (
    <>
      <Sheet
        open={!!line}
        onClose={onClose}
        title={line ? `${line.icon} ${line.label}` : "Envelope"}
      >
        {line && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
              <span className="text-sm text-taupe">Spent / budget</span>
              <span className="font-semibold text-bone">
                {formatMoney(spent)}{" "}
                <span className="font-normal text-faint">/ {formatMoney(line.target)}</span>
              </span>
            </div>
            {txns.length === 0 ? (
              <p className="py-6 text-center text-sm text-faint">
                Nothing logged here this month yet.
              </p>
            ) : (
              <div className="divide-y divide-edge">
                {txns.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setEdit(t)}
                    className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-[13px] text-bone">{t.description}</p>
                      <p className="text-[11px] text-faint">
                        {formatDate(t.date)} · tap to recategorize or delete
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium text-bone">
                      {formatMoney(t.amount)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Sheet>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title="Transaction">
        {edit && (
          <div className="space-y-4">
            <div>
              <p className="break-words text-sm font-medium text-bone">{edit.description}</p>
              <p className="mt-0.5 text-xs text-taupe">
                {formatDate(edit.date)} · {formatMoney(edit.amount)}
              </p>
            </div>
            <div>
              <label className={labelClass}>Category — tap to change</label>
              <div className="grid grid-cols-4 gap-2">
                {expenseCats.map((c) => (
                  <button
                    key={c.id}
                    onClick={async () => {
                      await setTransactionCategory(edit.id, c.id);
                      setEdit(null);
                    }}
                    className={`flex flex-col items-center gap-1 rounded-xl border py-2.5 transition ${
                      c.id === edit.categoryId
                        ? "border-accent bg-accent/15"
                        : "border-edge bg-raised"
                    }`}
                  >
                    <span className="text-xl">{c.icon}</span>
                    <span className="text-[10px] leading-tight text-taupe">{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <Button
              variant="danger"
              className="w-full"
              onClick={async () => {
                await deleteTransaction(edit.id);
                setEdit(null);
              }}
            >
              <Trash2 size={18} /> Delete transaction
            </Button>
          </div>
        )}
      </Sheet>
    </>
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
  return (
    <Sheet open={!!entry} onClose={onClose} title={entry ? `Pay ${entry.label}` : "Pay bill"}>
      {entry && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
            <span className="text-sm text-taupe">Amount</span>
            <span className="text-lg font-bold text-bone">{formatMoney(entry.amount)}</span>
          </div>
          <div>
            <label className={labelClass}>From account</label>
            <select
              className={inputClass}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id} className="bg-tile">
                  {a.name} ····{a.last4}
                </option>
              ))}
            </select>
          </div>
          <Button
            className="w-full"
            disabled={!accountId || busy}
            onClick={async () => {
              if (!entry.recurringId || !accountId) return;
              setBusy(true);
              await onPay(entry.recurringId, monthKey, entry.amount, entry.day, accountId);
              setBusy(false);
              onClose();
            }}
          >
            {busy ? "Working…" : "Pay now — move the cash"}
          </Button>
          <button
            onClick={async () => {
              if (!entry.recurringId) return;
              setBusy(true);
              await onMarkPaid(entry.recurringId, monthKey, entry.amount, entry.day);
              setBusy(false);
              onClose();
            }}
            disabled={busy}
            className="w-full rounded-xl bg-raised py-3 text-sm font-semibold text-bone transition hover:brightness-110 disabled:opacity-40"
          >
            Already paid — just mark it
          </button>
          <p className="text-[11px] text-faint">
            "Pay now" moves the cash (and drops the card for a card minimum).
            "Already paid" just marks it — for a bill already in your balance.
          </p>
        </div>
      )}
    </Sheet>
  );
}

function TxnDetailSheet({
  txn,
  categories,
  onClose,
  onDelete,
}: {
  txn: Transaction | null;
  categories: import("../types").Category[];
  onClose: () => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const cat = txn ? getCategory(categories, txn.categoryId) : null;
  return (
    <Sheet open={!!txn} onClose={onClose} title="Transaction">
      {txn && cat && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-full text-2xl"
              style={{ backgroundColor: cat.color + "33" }}
            >
              {cat.icon}
            </div>
            <div className="flex-1">
              <p className="break-words font-semibold text-bone">
                {txn.description || cat.name}
              </p>
              <p className="text-sm text-taupe">
                {cat.name} · {formatDate(txn.date)}
              </p>
            </div>
            <p className={`text-lg font-bold ${txn.type === "income" ? "text-mint" : "text-bone"}`}>
              {txn.type === "income" ? "+" : "−"}
              {formatMoney(txn.amount).replace("−", "")}
            </p>
          </div>
          {txn.appliesTo && txn.appliesTo.kind !== "income" && !txn.appliesTo.settled && (
            <p className="rounded-lg bg-raised px-3 py-2 text-[11px] text-taupe">
              Deleting this reverses everything it touched — the cash and any linked
              debt or goal.
            </p>
          )}
          <Button
            variant="danger"
            className="w-full"
            onClick={async () => {
              await onDelete(txn.id);
              onClose();
            }}
          >
            <Trash2 size={18} /> Delete transaction
          </Button>
        </div>
      )}
    </Sheet>
  );
}

// Settings — moved here from App so OnePager owns the whole surface.
function SettingsSheet({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: () => void;
}) {
  const { resetAll, seedHousehold } = useStore();
  const { session } = useAuth();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="space-y-3">
        <div className="rounded-xl bg-mint/10 p-3 text-sm">
          <p className="font-semibold text-mint">☁️ Cloud sync is on</p>
          <p className="mt-0.5 text-mint/70">
            Signed in as {session?.user.email}. Changes sync live to every device
            you're both signed in on.
          </p>
        </div>
        <Button variant="soft" className="w-full" onClick={onImport}>
          <FileUp size={16} /> Import bank statement
        </Button>
        <Button
          className="w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setStatus(null);
            const r = await seedHousehold();
            setStatus(r.message);
            setBusy(false);
          }}
        >
          {busy ? "Setting up…" : "Set up my household"}
        </Button>
        {status && (
          <p className="rounded-lg bg-raised px-3 py-2 text-sm text-taupe">{status}</p>
        )}
        <Button
          variant="danger"
          className="w-full"
          onClick={async () => {
            if (
              window.confirm(
                "Delete ALL accounts, recurring, transactions, debts and goals? This can't be undone.",
              )
            ) {
              await resetAll();
              onClose();
            }
          }}
        >
          Clear all data
        </Button>
      </div>
    </Sheet>
  );
}
