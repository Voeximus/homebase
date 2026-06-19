import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileUp,
  Flag,
  Landmark,
  List,
  LogOut,
  Plus,
  RefreshCw,
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
import { accountFlow, cashAccounts, totalBalance } from "../lib/recurring";
import {
  commitmentProgress,
  HABITS,
  LEAN_VARIABLE,
  lineSpent,
  ONE_TIMES,
  orderedDebts,
  payoffSchedule,
  planMath,
  PAY_DAYS,
  SAVINGS_SPLIT,
  spentByCategory,
  sumTargets,
  upcomingIncome,
  variableSpentThisMonth,
  type BudgetLine,
} from "../lib/plan";
import {
  eventsForMonth,
  monthlySchedule,
  type ScheduleEntry,
} from "../lib/schedule";
import { getCategory } from "../lib/seed";
import { t } from "../lib/i18n";
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
import { ModeToggle, type AppMode } from "../components/ModeToggle";
import { LangToggle } from "../components/LanguageProvider";
import { LensToggle } from "../components/LensToggle";
import { ownAccounts, jointAccounts, type Lens } from "../lib/lens";
import type { Owner } from "../lib/owner";
import {
  useCountUp,
  usePrefersReducedMotion,
  useReveal,
  useScrolled,
} from "../lib/hooks";
import { usePlaidLink } from "react-plaid-link";
import { createLinkToken, exchangePublicToken, syncNow } from "../lib/plaidClient";
import { LedgerSheet } from "../components/LedgerSheet";
import { merchantKey } from "../lib/categorize";

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
/** A titled summary card in the Full view's container grid; tap to drill in. */
function ContainerCard({
  title,
  value,
  sub,
  tone = "default",
  onClick,
}: {
  title: string;
  value?: string;
  sub?: string;
  tone?: "default" | "accent" | "mint";
  onClick: () => void;
}) {
  const vc =
    tone === "accent" ? "text-accent" : tone === "mint" ? "text-mint" : "text-bone";
  return (
    <button
      onClick={onClick}
      className="flex h-full w-full flex-col rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.98]"
    >
      <div className="flex items-center justify-between">
        <p className="eyebrow text-faint">{title}</p>
        <ChevronRight size={15} className="text-faint" />
      </div>
      {value && <p className={`num mt-2 text-xl font-semibold ${vc}`}>{value}</p>}
      {sub && (
        <p className={`truncate text-[11px] text-taupe ${value ? "mt-0.5" : "mt-2"}`}>
          {sub}
        </p>
      )}
    </button>
  );
}

export function OnePager({
  mode,
  onMode,
  owner,
  lens,
  onLens,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
  owner: Owner;
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  const store = useStore();
  const { data, payDebtExtra, payBill, markBillPaid, deleteTransaction, setRecurringVariable } =
    store;
  const { signOut } = useAuth();

  const scrolled = useScrolled(130);
  const personal = lens === "me";

  // global sheets
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
  // Full-view drill-in: which titled container is expanded full-page.
  const [openContainer, setOpenContainer] = useState<
    "cash" | "debt" | "bills" | "budget" | "activity" | null
  >(null);

  // ── the math (single source of truth, all live) ──
  const target = sumTargets(LEAN_VARIABLE);
  const math = planMath(data.recurring, data.debts, target);
  const ordered = orderedDebts(data.debts);
  const today = new Date();
  const schedule = payoffSchedule(ordered, math.firepower, today, PAY_DAYS, SAVINGS_SPLIT);
  const upcoming = upcomingIncome(data.recurring, today);
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

  // ── owner lens · display-only (the math above stays household-level) ──
  const myAccountsList = useMemo(
    () => (personal ? ownAccounts(data.accounts, owner) : data.accounts),
    [personal, data.accounts, owner],
  );
  // Personal activity shows everything EXCEPT the other person's own accounts —
  // so your accounts + joint + untagged legacy history all surface in your view.
  const otherAccountIds = useMemo(() => {
    const otherLabel = owner === "gino" ? "Xinyan" : "Gino";
    return new Set(
      data.accounts.filter((a) => a.owner === otherLabel).map((a) => a.id),
    );
  }, [data.accounts, owner]);
  const cashShown = totalBalance(myAccountsList);
  const jointCash = personal ? totalBalance(jointAccounts(data.accounts)) : 0;
  const netFlowShown = personal
    ? myAccountsList.reduce((s, a) => s + accountFlow(a.id, data.recurring).net, 0)
    : netFlow;

  // bills (current month)
  const { entries } = monthlySchedule(data.recurring, monthKey, data.transactions);
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
        .filter((tx) => !tx.appliesTo?.settled)
        .filter(
          (tx) => !personal || !tx.accountId || !otherAccountIds.has(tx.accountId),
        )
        .sort((a, b) =>
          a.date === b.date
            ? b.createdAt.localeCompare(a.createdAt)
            : b.date.localeCompare(a.date),
        )
        .slice(0, 6),
    [data.transactions, personal, otherAccountIds],
  );

  // Full ledger: the same lens predicate as `recent`, but everything (no slice).
  const ledgerTxns = useMemo(
    () =>
      data.transactions
        .filter((tx) => !tx.appliesTo?.settled)
        .filter((tx) => !personal || !tx.accountId || !otherAccountIds.has(tx.accountId)),
    [data.transactions, personal, otherAccountIds],
  );
  const ruleSet = useMemo(
    () => new Set(data.merchantRules.map((r) => r.pattern)),
    [data.merchantRules],
  );
  const hasRule = (desc: string) => ruleSet.has(merchantKey(desc));

  // setup guard
  if (data.debts.length === 0 || math.income <= 0) {
    return (
      <div className="mx-auto min-h-screen max-w-[640px] px-4 pt-16">
        <Card className="p-2">
          <EmptyState icon={<Target size={24} />} title={t("Set up your household")}>
            {t("Load your income, bills and debts and the whole plan maps itself out here.")}
          </EmptyState>
          <Button className="mb-4 w-full" onClick={() => setSettingsOpen(true)}>
            {t("Open setup")}
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
          <div className="flex h-14 items-center gap-2">
            <ModeToggle mode={mode} onMode={onMode} />
            <LensToggle lens={lens} onLens={onLens} />
            <div className="min-w-0 flex-1">
              {scrolled && !personal && (
                <button
                  onClick={() => scrollTo("cash")}
                  className="block max-w-full truncate text-left leading-tight"
                >
                  <span className="num text-base font-semibold text-mint">
                    {formatMoney(cashShown)}
                  </span>
                  <span className="ml-1.5 text-[11px] text-faint">
                    {t("Day {day}", { day: commit.day })}
                    {next ? ` · ${fmtDay(next.date)} ` : " "}
                  </span>
                  {next && (
                    <span className="num text-[11px] font-semibold text-accent">
                      {formatMoney(next.total)}
                    </span>
                  )}
                </button>
              )}
            </div>
            <LangToggle />
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
          {personal && (
            /* pinned vitals strip — frozen telemetry: cash · debt */
            <div className="flex gap-2 pb-2.5">
              <button
                onClick={() => setAccountsOpen(true)}
                className="flex-1 rounded-xl bg-tile px-3 py-2 text-left transition active:scale-[0.98]"
              >
                <p className="eyebrow text-faint">{t("Cash")}</p>
                <p className="num text-sm font-semibold text-mint">
                  {formatMoney(cashShown)}
                </p>
              </button>
              <button
                onClick={() => setSprintOpen(true)}
                className="flex-1 rounded-xl bg-tile px-3 py-2 text-left transition active:scale-[0.98]"
              >
                <p className="eyebrow text-faint">{t("Debt left")}</p>
                <p className="num text-sm font-semibold text-bone">
                  {formatMoney(math.totalDebt)}
                </p>
              </button>
            </div>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-[640px] space-y-3 px-4 pb-28 pt-4">
        {/* ── FULL · container grid (titled, tap to drill in) ── */}
        {!personal && !openContainer && (
          <div className="grid grid-cols-2 gap-3">
            <ContainerCard
              title={t("Cash")}
              value={formatMoney(totalCash)}
              sub={t("{n} accounts", { n: data.accounts.length })}
              tone="mint"
              onClick={() => setOpenContainer("cash")}
            />
            <ContainerCard
              title={t("Debt")}
              value={formatMoney(math.totalDebt)}
              sub={
                payoffDate
                  ? t("free {date}", {
                      date: payoffDate
                        .toLocaleDateString("en-US", { month: "short", year: "2-digit" })
                        .replace(" ", " '"),
                    })
                  : t("on track")
              }
              tone="accent"
              onClick={() => setOpenContainer("debt")}
            />
            <ContainerCard
              title={t("Bills")}
              value={formatMoney(leftOut)}
              sub={t("{n} due", { n: leftBills.length })}
              onClick={() => setOpenContainer("bills")}
            />
            <ContainerCard
              title={t("Budget")}
              value={formatMoney(spent)}
              sub={t("of {amount}", { amount: formatMoney(target) })}
              onClick={() => setOpenContainer("budget")}
            />
            <div className="col-span-2">
              <ContainerCard
                title={t("Activity")}
                sub={recent[0]?.description ?? t("Nothing logged yet.")}
                onClick={() => setOpenContainer("activity")}
              />
            </div>
          </div>
        )}
        {!personal && openContainer && (
          <button
            onClick={() => setOpenContainer(null)}
            className="flex items-center gap-1 text-sm font-medium text-taupe transition hover:text-bone"
          >
            <ChevronLeft size={16} /> {t("All")}
          </button>
        )}
        {/* ── HERO · next move — moves into the Debt container in Full ── */}
        {!personal && openContainer === "debt" && (
        <Reveal id="nextmove">
          <div className="hero-bar overflow-hidden rounded-xl border border-edgehero bg-hero p-5">
            <Eyebrow color="text-accent">
              <Zap size={11} className="-mt-0.5 mr-1 inline" />
              {t("Your next move")} {next ? `· ${fmtDay(next.date)}` : ""}
            </Eyebrow>

            {next ? (
              <>
                <div className="slip-recess mt-3 rounded-xl p-4">
                  <p className="text-[22px] font-medium leading-snug text-bone">
                    {t("On your {date} check, send {amount}", {
                      date: fmtDay(next.date),
                      amount: formatMoney(next.total),
                    })}
                  </p>
                  <div className="mt-3 space-y-1.5">
                    {next.toSavings > 0 && (
                      <SplitChip
                        label={
                          next.savingsKind === "emergency"
                            ? t("Emergency fund")
                            : t("Investing / goals")
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
                  {t("Mark sent")} <ArrowRight size={16} />
                </button>
                <p
                  className={`mt-2.5 text-center text-[11px] ${
                    lightCheck ? "text-gold/90" : "text-faint"
                  }`}
                >
                  {lightCheck
                    ? t("This check is light (the trip) — send what you comfortably can; the plan just slides a little.")
                    : t("Send what you comfortably can. Tap the slip to see the whole payday-by-payday plan.")}
                </p>
                <button
                  onClick={() => setScheduleOpen(true)}
                  className="mt-1 w-full text-center text-[11px] font-medium text-accent/80"
                >
                  {t("See the full payoff plan →")}
                </button>
              </>
            ) : (
              <p className="mt-3 text-sm text-taupe">
                {t("No firepower scheduled — check the budget.")}
              </p>
            )}
          </div>
        </Reveal>
        )}

        {/* ── CASH + STREAK (pinned into the vitals strip in Mine) ── */}
        {!personal && openContainer === "cash" && (
        <Reveal id="cash">
          <div className="grid grid-cols-2 gap-3">
            {/* cash */}
            <button
              onClick={() => setAccountsOpen(true)}
              className="rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.99]"
            >
              <Eyebrow>{personal ? t("Your cash") : t("Cash on hand")}</Eyebrow>
              <CountMoney
                value={cashShown}
                className="num mt-1 block text-2xl font-medium tracking-tight text-bone"
              />
              {personal ? (
                jointCash > 0 && (
                  <p className="mt-1.5 text-[11px] text-faint">
                    + {t("Joint")} {formatMoney(jointCash)}
                  </p>
                )
              ) : (
                <OwnerBar accounts={cashAccounts(data.accounts)} total={totalCash} />
              )}
              <p className="mt-2 text-[11px] text-mint">
                {t("{amount}/mo net", { amount: formatMoney(netFlowShown, { sign: true }) })}
              </p>
            </button>
            {/* streak */}
            <button
              onClick={() => setHabitsOpen(true)}
              className="flex flex-col items-center rounded-xl border border-edge bg-tile p-4 text-center transition active:scale-[0.99]"
            >
              <Eyebrow>{t("The habit")}</Eyebrow>
              <StreakRing day={commit.day} total={commit.total} pct={commit.pct} />
              <div className="mt-2 flex gap-1.5 text-sm">
                {HABITS.map((h) => (
                  <span key={h.label}>{h.icon}</span>
                ))}
              </div>
            </button>
          </div>
        </Reveal>
        )}

        {/* ── SPRINT · the road — moves into the Debt container in Full ── */}
        {!personal && openContainer === "debt" && (
        <Reveal id="sprint">
          <button
            onClick={() => setSprintOpen(true)}
            className="block w-full rounded-xl border border-edge bg-tile p-5 text-left transition active:scale-[0.99]"
          >
            <Eyebrow>
              {t("The sprint · debt-free {date}", {
                date: payoffDate ? payoffDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '") : t("soon"),
              })}
            </Eyebrow>
            <div className="mt-1 flex items-end justify-between">
              <CountMoney
                value={math.totalDebt}
                className="num text-2xl font-medium tracking-tight text-bone"
              />
              <span className="rounded-full bg-mint/15 px-2.5 py-0.5 text-[11px] font-semibold text-mint">
                {t("Free by {date}", {
                  date: payoffDate ? payoffDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '") : t("soon"),
                })}
              </span>
            </div>
            <RunnerRoad startLabel={kMoney(totalOriginal)} pct={clearedPct} />
            <p className="mt-2 text-[11px] text-taupe">
              <span className="font-medium text-accent">
                {t("firing {amount}/mo", { amount: formatMoney(math.firepower) })}
              </span>{" "}
              · {t("{cleared} of {total} cleared · tap for the ladder", {
                cleared: formatMoney(cleared),
                total: formatMoney(totalOriginal),
              })}
            </p>
          </button>
        </Reveal>
        )}

        {!personal && openContainer === "budget" && (
          <>
        {/* ── FIREPOWER + SPENT ── */}
        <Reveal id="metrics">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setIncomeOpen(true)}
              className="rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.99]"
            >
              <Eyebrow>{t("Firepower / mo")}</Eyebrow>
              <CountMoney
                value={math.firepower}
                className="num mt-1 block text-2xl font-medium tracking-tight text-accent"
              />
              <p className="mt-1 text-[11px] text-taupe">{t("income − living − variable")}</p>
            </button>
            <button
              onClick={() => scrollTo("budget")}
              className="rounded-xl border border-edge bg-tile p-4 text-left transition active:scale-[0.99]"
            >
              <Eyebrow>{t("Spent this month")}</Eyebrow>
              <p className="num mt-1 text-2xl font-medium tracking-tight text-bone">
                {formatMoney(spent)}
              </p>
              <p className="text-[11px] text-taupe">
                {t("of {amount} lean", { amount: formatMoney(target) })}
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
            <Eyebrow>{t("This month's envelopes")}</Eyebrow>
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
                        {t(l.label)}
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
          </>
        )}

        {/* ── BILLS ── */}
        {!personal && openContainer === "bills" && (
        <Reveal id="bills">
          <div className="rounded-xl border border-edge bg-tile p-5">
            <div className="flex items-center justify-between">
              <Eyebrow>{t("This month's bills")}</Eyebrow>
              <span className="text-[11px] text-taupe">
                <span className="text-mint">{t("{amount} paid", { amount: formatMoney(paidOut) })}</span> ·{" "}
                {t("{amount} left", { amount: formatMoney(leftOut) })}
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
                      {e.variable ? "~" : ""}
                      {formatMoney(e.amount)}
                    </span>
                    {e.variable && (
                      <span className="text-[9px] font-semibold uppercase tracking-wide opacity-60">
                        {t("est")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setCalOpen((v) => !v)}
              className="mt-4 flex w-full items-center justify-between rounded-xl bg-raised px-4 py-2.5 text-left"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-taupe">
                <CalendarDays size={14} /> {t("Money calendar")}
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
              <Eyebrow color="text-faint">{t("Coming up")}</Eyebrow>
              <div className="mt-2 space-y-1.5">
                {upcoming.map((p) => (
                  <div
                    key={`${p.label}-${p.date.toISOString().slice(0, 10)}`}
                    className="flex items-center justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] text-bone">{t(p.label)}</p>
                      <p className="text-[11px] text-faint">~{fmtDay(p.date)}</p>
                    </div>
                    <span className="text-[13px] font-semibold text-mint">
                      +{formatMoney(p.amount)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-faint">
                {t("Soft dates — your 15th & month-end checks can land ±a few days (weekends, holidays).")}
              </p>
            </div>
          </div>
        </Reveal>
        )}

        {/* ── UPCOMING BILLS · personal ── */}
        {personal && (
          <Reveal>
            <div className="rounded-xl border border-edge bg-tile p-5">
              <div className="flex items-center justify-between">
                <Eyebrow>{t("Upcoming bills")}</Eyebrow>
                <span className="text-[11px] text-taupe">
                  {t("{amount} left", { amount: formatMoney(leftOut) })}
                </span>
              </div>
              {leftBills.length === 0 ? (
                <p className="mt-3 text-sm text-faint">
                  {t("All bills paid this month.")}
                </p>
              ) : (
                <div className="mt-3 space-y-2.5">
                  {[...leftBills]
                    .sort((a, b) => a.day - b.day)
                    .slice(0, 5)
                    .map((e, i) => (
                      <div
                        key={`${e.recurringId ?? e.label}-${e.day}-${i}`}
                        className="flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[13px] text-bone">{e.label}</p>
                          <p className="text-[11px] text-faint">
                            {fmtDay(
                              new Date(today.getFullYear(), today.getMonth(), e.day),
                            )}
                            {e.variable ? ` · ${t("varies")}` : ""}
                          </p>
                        </div>
                        <span className="num text-[13px] font-semibold text-bone">
                          {e.variable ? "~" : ""}
                          {formatMoney(e.amount)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </Reveal>
        )}

        {/* ── ACTIVITY (personal, or its Full container) ── */}
        {(personal || openContainer === "activity") && (
        <Reveal id="activity">
          <div className="rounded-xl border border-edge bg-tile p-2">
            <div className="flex items-center justify-between px-3 pt-3">
              <Eyebrow>{t("Just happened")}</Eyebrow>
              <button
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true);
                  await syncNow(true);
                  setSyncing(false);
                }}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-taupe transition active:bg-white/5 disabled:opacity-60"
              >
                <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
                {syncing ? t("Syncing…") : t("Refresh")}
              </button>
            </div>
            {recent.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-faint">
                {t("Nothing logged yet.")}
              </p>
            ) : (
              <div className="mt-1 divide-y divide-edge">
                {recent.map((t) => (
                  <TransactionRow
                    key={t.id}
                    txn={t}
                    categories={data.categories}
                    accounts={data.accounts}
                    onClick={() => setTxnDetail(t)}
                  />
                ))}
              </div>
            )}
            <div className="flex gap-2 p-3">
              <Button variant="ghost" className="flex-1" onClick={() => setLedgerOpen(true)}>
                <List size={16} /> {t("All activity")}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => setImportOpen(true)}>
                <FileUp size={16} /> {t("Import")}
              </Button>
            </div>
          </div>
        </Reveal>
        )}

        <p className="pt-1 text-center text-[11px] text-faint">
          {t("One event ripples everywhere — cash, debt, and the plan stay in step.")}
        </p>
      </main>

      {/* floating add */}
      <button
        onClick={() => setAddOpen(true)}
        className="fixed right-5 z-30 flex items-center justify-center rounded-full bg-accent text-bg shadow-lg transition active:scale-95"
        style={{ height: 52, width: 52, bottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
        aria-label="Add transaction"
      >
        <Plus size={24} />
      </button>

      {/* ── sheets ── */}
      <LedgerSheet open={ledgerOpen} onClose={() => setLedgerOpen(false)} txns={ledgerTxns} hasRule={hasRule} />
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
        variable={
          data.recurring.find((r) => r.id === payBillFor?.recurringId)?.variable ?? false
        }
        onClose={() => setPayBillFor(null)}
        onPay={payBill}
        onMarkPaid={markBillPaid}
        onSetVariable={setRecurringVariable}
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
          ✓ {t("paid off")}
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
        <span className="text-[10px] text-faint">{t("of {total}", { total })}</span>
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
        {t(MONTHS[month])} · {t("dots mark income, bills & transfers")}
      </p>
    </div>
  );
}

// ── sheets ───────────────────────────────────────────────────────────────────
export function AccountsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, setAccountBalance } = useStore();
  const [edit, setEdit] = useState<Account | null>(null);
  const [val, setVal] = useState("");
  return (
    <Sheet open={open} onClose={onClose} title={t("Cash & accounts")}>
      <div className="space-y-2">
        {cashAccounts(data.accounts).map((a) => {
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
                    {a.owner} · {t("{amount}/mo", { amount: formatMoney(f.net, { sign: true }) })}
                  </p>
                </div>
                {editing ? (
                  <span className="text-sm text-faint">{t("editing…")}</span>
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
                    <span className="block text-[10px] text-accent">{t("tap to set")}</span>
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
                    {t("Set")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        <p className="px-1 text-[11px] text-faint">
          {t("Set each account to the real balance from your bank — every event moves it from there.")}
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
    <Sheet open={open} onClose={onClose} title={t("The 90-day commitment")}>
      <div className="space-y-4">
        <p className="text-sm text-taupe">
          {t("The real point isn't a deadline — it's 90 days of dedicated good habits. Debt-free is the scoreboard; the habits are the win.")}
        </p>
        <div className="rounded-xl bg-raised p-4 text-center">
          <p className="text-3xl font-semibold text-bone">
            {t("Day {day}", { day: commit.day })}{" "}
            <span className="text-lg text-faint">{t("of {total}", { total: commit.total })}</span>
          </p>
          <p className="mt-1 text-[11px] text-taupe">
            {t("holding through {date}", { date: fmtFull(commit.endDate) })}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {HABITS.map((h) => (
            <div
              key={h.label}
              className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-sm text-bone"
            >
              <span className="text-lg">{h.icon}</span> {t(h.label)}
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
    <Sheet open={open} onClose={onClose} title={t("The payoff plan")}>
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
          <span className="text-sm text-taupe">{t("Interest you'll pay")}</span>
          <span className="font-semibold text-ember">~{formatMoney(totalInterest)}</span>
        </div>
        {schedule.map((ev, i) => (
          <div key={i} className="rounded-xl border border-edge bg-raised p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-bone">{fmtFull(ev.date)}</p>
              <p className="text-sm font-bold text-accent">
                {t("send {amount}", { amount: formatMoney(ev.total) })}
              </p>
            </div>
            <div className="mt-2 space-y-1">
              {ev.toSavings > 0 && (
                <Line
                  label={ev.savingsKind === "emergency" ? t("Emergency fund") : t("Investing")}
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
              {ev.remaining <= 0.005 ? t("🎉 debt-free!") : t("{amount} to go", { amount: formatMoney(ev.remaining) })}
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
          {t("PAID OFF")}
        </span>
      )}
    </div>
  );
}

export function SprintSheet({
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
      <Sheet open={open} onClose={onClose} title={t("The attack ladder")}>
        <div className="space-y-2.5">
          <p className="text-xs text-taupe">{t("Snowball order · smallest first")}</p>
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
                      {d.providerAccountId && (
                        <span className="flex items-center gap-0.5 rounded-full bg-accent/15 px-1.5 text-[10px] font-medium text-accent">
                          <CreditCard size={9} /> {t("live")}
                        </span>
                      )}
                    </div>
                    {cd && !done && (
                      <p className="text-[11px] text-faint">{t("clears ~{date}", { date: fmtDay(cd) })}</p>
                    )}
                  </div>
                  <span className={`text-sm font-bold ${done ? "text-mint" : "text-bone"}`}>
                    {done ? t("Cleared") : formatMoney(d.balance)}
                  </span>
                </div>
                {!done && (
                  <div className="mt-2">
                    {pct > 0 && <ProgressBar value={pct} color={d.color} />}
                    <button
                      onClick={() => setPayFor(d)}
                      className={`w-full rounded-lg bg-accent/15 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25 ${pct > 0 ? "mt-2" : ""}`}
                    >
                      {t("Make a payment")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
            <span className="text-sm text-taupe">{t("Total to clear")}</span>
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
      title={debt ? t("Pay {name}", { name: debt.name }) : t("Payment")}
    >
      {debt && (
        <div className="space-y-4">
          <p className="text-sm text-taupe">
            {t("Balance:")} <span className="font-semibold text-bone">{formatMoney(debt.balance)}</span>
          </p>
          <div>
            <label className={labelClass}>{t("Payment amount")}</label>
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
              <label className={labelClass}>{t("From account")}</label>
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
            {t("Apply payment")}
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
    <Sheet open={open} onClose={onClose} title={t("Where every dollar goes")}>
      <div className="space-y-4">
        <div className="flex h-9 w-full overflow-hidden rounded-xl">
          <div className="flex items-center justify-center bg-steel text-[10px] font-semibold text-bg" style={{ width: widthOf(math.fixedNonDebt) }}>
            {t("Living")}
          </div>
          <div className="flex items-center justify-center bg-gold text-[10px] font-semibold text-bg" style={{ width: widthOf(math.variable) }}>
            {t("Variable")}
          </div>
          <div className="flex items-center justify-center bg-accent text-[10px] font-semibold text-bg" style={{ width: widthOf(math.firepower) }}>
            {t("Debt")}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <Stat label={t("Income")} value={formatMoney(math.income)} tone="text-mint" />
          <Stat label={t("Living")} value={formatMoney(math.fixedNonDebt)} />
          <Stat label={t("Variable")} value={formatMoney(math.variable)} />
          <Stat label={t("At the debt")} value={formatMoney(math.firepower)} tone="text-accent" />
        </div>
        <p className="text-[11px] text-faint">
          {t("Holding the lean budget is what frees ~{amount}/mo to attack the debt. The one-time hits below come from your cash cushion, not this firepower.", { amount: formatMoney(math.firepower) })}
        </p>
        <div className="space-y-1.5">
          {ONE_TIMES.map((o) => (
            <div key={o.label} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2">
              <span>{o.icon}</span>
              <span className="flex-1 text-sm text-bone">{t(o.label)}</span>
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

export function MarkSentSheet({
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
    <Sheet open={open} onClose={onClose} title={t("Record this payment")}>
      {done ? (
        <div className="flex flex-col items-center py-6 text-center">
          <span className="pop flex h-16 w-16 items-center justify-center rounded-full bg-mint text-bg">
            <Check size={32} />
          </span>
          <p className="mt-4 text-lg font-semibold text-bone">{t("Sent!")}</p>
          <p className="mt-1 text-sm text-taupe">
            {t("Cash, debt and the sprint all moved.")}
          </p>
          <Button className="mt-5 w-full" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-taupe">
            {t("Recording {amount} across these debts. This moves the cash and drops each balance.", { amount: formatMoney(next.payments.reduce((s, p) => s + p.amount, 0)) })}
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
              {t("Plus {amount} to {target} — move that yourself in your bank.", {
                amount: formatMoney(next.toSavings),
                target: next.savingsKind === "emergency" ? t("your emergency fund") : t("investing"),
              })}
            </p>
          )}
          <div>
            <label className={labelClass}>{t("From account")}</label>
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
            {busy ? t("Recording…") : t("Confirm — record payment")}
          </Button>
          <p className="text-[11px] text-faint">
            {t("Only do this once you've actually sent it. Deleting the entries later fully reverses everything.")}
          </p>
        </div>
      )}
    </Sheet>
  );
}

export function EnvelopeSheet({
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
        title={line ? `${line.icon} ${t(line.label)}` : t("Envelope")}
      >
        {line && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
              <span className="text-sm text-taupe">{t("Spent / budget")}</span>
              <span className="font-semibold text-bone">
                {formatMoney(spent)}{" "}
                <span className="font-normal text-faint">/ {formatMoney(line.target)}</span>
              </span>
            </div>
            {txns.length === 0 ? (
              <p className="py-6 text-center text-sm text-faint">
                {t("Nothing logged here this month yet.")}
              </p>
            ) : (
              <div className="divide-y divide-edge">
                {txns.map((txn) => (
                  <button
                    key={txn.id}
                    onClick={() => setEdit(txn)}
                    className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-[13px] text-bone">{txn.description}</p>
                      <p className="text-[11px] text-faint">
                        {formatDate(txn.date)} · {t("tap to recategorize or delete")}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium text-bone">
                      {formatMoney(txn.amount)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Sheet>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={t("Transaction")}>
        {edit && (
          <div className="space-y-4">
            <div>
              <p className="break-words text-sm font-medium text-bone">{edit.description}</p>
              <p className="mt-0.5 text-xs text-taupe">
                {formatDate(edit.date)} · {formatMoney(edit.amount)}
              </p>
            </div>
            <div>
              <label className={labelClass}>{t("Category — tap to change")}</label>
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
                    <span className="text-[10px] leading-tight text-taupe">{t(c.name)}</span>
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
              <Trash2 size={18} /> {t("Delete transaction")}
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
  variable,
  onClose,
  onPay,
  onMarkPaid,
  onSetVariable,
}: {
  entry: ScheduleEntry | null;
  monthKey: string;
  accounts: Account[];
  defaultAccountId?: string;
  variable: boolean;
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
  onSetVariable: (id: string, variable: boolean) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  // Local mirror of the variable flag so the toggle feels instant.
  const [isVar, setIsVar] = useState(variable);
  // The amount to actually pay/record. For a variable bill it's editable
  // (prefilled with the rolling-average estimate); for a fixed bill it's locked.
  const [amountStr, setAmountStr] = useState("");
  useEffect(() => {
    if (entry) {
      setAccountId(defaultAccountId || accounts[0]?.id || "");
      setIsVar(variable);
      setAmountStr(entry.amount.toFixed(2));
    }
  }, [entry, defaultAccountId, accounts, variable]);

  const amount = isVar ? parseFloat(amountStr) || 0 : entry?.amount ?? 0;
  const amountValid = amount > 0;

  return (
    <Sheet open={!!entry} onClose={onClose} title={entry ? t("Pay {name}", { name: entry.label }) : t("Pay bill")}>
      {entry && (
        <div className="space-y-4">
          {/* Amount — editable when the bill varies month to month */}
          {isVar ? (
            <div>
              <label className={labelClass}>{t("Amount this month")}</label>
              <div className="flex items-center rounded-xl bg-raised px-4 py-3">
                <span className="text-lg font-bold text-taupe">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  className="num w-full bg-transparent pl-1 text-lg font-bold text-bone outline-none"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                />
              </div>
              <p className="mt-1 text-[11px] text-faint">
                {t("Estimated ~{amount} from recent bills — enter the real amount.", {
                  amount: formatMoney(entry.amount),
                })}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
              <span className="text-sm text-taupe">{t("Amount")}</span>
              <span className="text-lg font-bold text-bone">{formatMoney(entry.amount)}</span>
            </div>
          )}

          {/* Does this bill vary? — flips it into rolling-average projection */}
          {entry.recurringId && (
            <button
              type="button"
              onClick={async () => {
                const next = !isVar;
                setIsVar(next);
                if (next) setAmountStr(entry.amount.toFixed(2));
                if (entry.recurringId) await onSetVariable(entry.recurringId, next);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-raised px-4 py-3 text-left"
            >
              <span className="min-w-0">
                <span className="block text-sm text-bone">
                  {t("Amount varies month to month")}
                </span>
                <span className="block text-[11px] text-faint">
                  {t("Project it from the average of recent payments.")}
                </span>
              </span>
              <span
                className={`relative h-6 w-10 shrink-0 rounded-full transition ${isVar ? "bg-accent" : "bg-edge"}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-bone transition-all ${isVar ? "left-[18px]" : "left-0.5"}`}
                />
              </span>
            </button>
          )}

          <div>
            <label className={labelClass}>{t("From account")}</label>
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
            disabled={!accountId || !amountValid || busy}
            onClick={async () => {
              if (!entry.recurringId || !accountId || !amountValid) return;
              setBusy(true);
              await onPay(entry.recurringId, monthKey, amount, entry.day, accountId);
              setBusy(false);
              onClose();
            }}
          >
            {busy ? t("Working…") : t("Pay now — move the cash")}
          </Button>
          <button
            onClick={async () => {
              if (!entry.recurringId || !amountValid) return;
              setBusy(true);
              await onMarkPaid(entry.recurringId, monthKey, amount, entry.day);
              setBusy(false);
              onClose();
            }}
            disabled={busy || !amountValid}
            className="w-full rounded-xl bg-raised py-3 text-sm font-semibold text-bone transition hover:brightness-110 disabled:opacity-40"
          >
            {t("Already paid — just mark it")}
          </button>
          <p className="text-[11px] text-faint">
            {t("\"Pay now\" moves the cash (and drops the card for a card minimum). \"Already paid\" just marks it — for a bill already in your balance.")}
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
    <Sheet open={!!txn} onClose={onClose} title={t("Transaction")}>
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
                {txn.description || t(cat.name)}
              </p>
              <p className="text-sm text-taupe">
                {t(cat.name)} · {formatDate(txn.date)}
              </p>
            </div>
            <p className={`text-lg font-bold ${txn.type === "income" ? "text-mint" : "text-bone"}`}>
              {txn.type === "income" ? "+" : "−"}
              {formatMoney(txn.amount).replace("−", "")}
            </p>
          </div>
          {txn.appliesTo && txn.appliesTo.kind !== "income" && !txn.appliesTo.settled && (
            <p className="rounded-lg bg-raised px-3 py-2 text-[11px] text-taupe">
              {t("Deleting this reverses everything it touched — the cash and any linked debt or goal.")}
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
            <Trash2 size={18} /> {t("Delete transaction")}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

// "Connect a bank" — the Plaid Link flow. Fetches a link_token from the edge
// function, opens Plaid Link, and on success hands the public_token back to be
// exchanged. The server does token custody, account discovery, and sync; the
// new accounts + categorized transactions then arrive over realtime.
function ConnectBank() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSuccess = async (public_token: string, metadata: any) => {
    setBusy(true);
    setStatus(t("Linking your accounts…"));
    const { data, error } = await exchangePublicToken(public_token, metadata?.institution?.name);
    setBusy(false);
    setLinkToken(null);
    if (error) { setStatus("⚠️ " + error.message); return; }
    setStatus(t("Linked {n} accounts — transactions are syncing.", { n: data?.accounts ?? 0 }));
  };

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const start = async () => {
    setBusy(true);
    setStatus(null);
    const { token, error } = await createLinkToken();
    setBusy(false);
    if (error || !token) { setStatus("⚠️ " + (error ?? "no link token")); return; }
    setLinkToken(token);
  };

  return (
    <div className="space-y-2">
      <Button variant="soft" className="w-full" disabled={busy} onClick={start}>
        <Landmark size={16} /> {busy ? t("Connecting…") : t("Connect a bank")}
      </Button>
      {status && <p className="rounded-lg bg-raised px-3 py-2 text-sm text-taupe">{status}</p>}
    </div>
  );
}

// Connected credit cards, each shown as a debt you can track. Linking a card to
// a debt means the bank feed keeps that debt's balance current automatically.
function CreditCardLinks() {
  const { data, linkDebtToCard, unlinkDebtCard, createDebtFromCard } = useStore();
  const cards = data.accounts.filter(
    (a) => /credit/i.test(a.type) && a.providerAccountId,
  );
  if (cards.length === 0) return null;
  return (
    <div className="rounded-xl border border-edge bg-tile p-3">
      <div className="flex items-center gap-1.5">
        <CreditCard size={14} className="text-taupe" />
        <Eyebrow>{t("Cards as debt")}</Eyebrow>
      </div>
      <div className="mt-2.5 space-y-2">
        {cards.map((c) => (
          <CreditCardRow
            key={c.id}
            card={c}
            linkedDebt={data.debts.find(
              (d) => d.providerAccountId === c.providerAccountId,
            )}
            unlinkedDebts={data.debts.filter((d) => !d.providerAccountId)}
            onLink={linkDebtToCard}
            onUnlink={unlinkDebtCard}
            onCreate={createDebtFromCard}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-faint">
        {t("A linked card updates its debt automatically on every bank sync.")}
      </p>
    </div>
  );
}

function CreditCardRow({
  card,
  linkedDebt,
  unlinkedDebts,
  onLink,
  onUnlink,
  onCreate,
}: {
  card: Account;
  linkedDebt?: Debt;
  unlinkedDebts: Debt[];
  onLink: (debtId: string, accountId: string) => Promise<void>;
  onUnlink: (debtId: string) => Promise<void>;
  onCreate: (accountId: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState("__new__");
  const [busy, setBusy] = useState(false);
  const label = `${card.name}${card.last4 ? ` ····${card.last4}` : ""}`;
  return (
    <div className="rounded-lg bg-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-bone">{label}</span>
        <span className="num shrink-0 text-sm font-semibold text-ember">
          {formatMoney(Math.max(0, card.balance))}
        </span>
      </div>
      {linkedDebt ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 text-[12px] text-mint">
            <Check size={12} className="shrink-0" />
            <span className="truncate">
              {t("Tracked as {name} · auto-syncs", { name: linkedDebt.name })}
            </span>
          </span>
          <button
            onClick={async () => {
              setBusy(true);
              await onUnlink(linkedDebt.id);
              setBusy(false);
            }}
            disabled={busy}
            className="shrink-0 text-[12px] text-faint underline-offset-2 hover:underline disabled:opacity-40"
          >
            {t("Unlink")}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <select
            className={`${inputClass} flex-1`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="__new__" className="bg-tile">
              {t("Track as a new debt")}
            </option>
            {unlinkedDebts.map((d) => (
              <option key={d.id} value={d.id} className="bg-tile">
                {t("Link to {name}", { name: d.name })}
              </option>
            ))}
          </select>
          <button
            onClick={async () => {
              setBusy(true);
              if (choice === "__new__") await onCreate(card.id);
              else await onLink(choice, card.id);
              setBusy(false);
            }}
            disabled={busy}
            className="shrink-0 rounded-lg bg-accent/15 px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-40"
          >
            {busy ? t("…") : t("Track")}
          </button>
        </div>
      )}
    </div>
  );
}

// Settings — moved here from App so OnePager owns the whole surface.
export function SettingsSheet({
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
    <Sheet open={open} onClose={onClose} title={t("Settings")}>
      <div className="space-y-3">
        <div className="rounded-xl bg-mint/10 p-3 text-sm">
          <p className="font-semibold text-mint">☁️ {t("Cloud sync is on")}</p>
          <p className="mt-0.5 text-mint/70">
            {t("Signed in as {email}. Changes sync live to every device you're both signed in on.", { email: session?.user.email ?? "" })}
          </p>
        </div>
        <ConnectBank />
        <CreditCardLinks />
        <Button variant="soft" className="w-full" onClick={onImport}>
          <FileUp size={16} /> {t("Import bank statement")}
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
          {busy ? t("Setting up…") : t("Set up my household")}
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
                t("Delete ALL accounts, recurring, transactions, debts and goals? This can't be undone."),
              )
            ) {
              await resetAll();
              onClose();
            }
          }}
        >
          {t("Clear all data")}
        </Button>
      </div>
    </Sheet>
  );
}
