// Compute the four tab view-models from the live store — the bridge between the
// presentational bento tabs and the real data. Mirrors OnePager's derivation math
// exactly (planMath / payoffSchedule / spentByCategory / lens filtering) so the
// reskin shows the same numbers, just in the new shell.

import type { AppData, Transaction, Debt } from "../../types";
import {
  orderedDebts,
  payoffSchedule,
  payoffClears,
  PAY_DAYS,
  SAVINGS_SPLIT,
  LEAN_VARIABLE,
  variableSpentBetween,
  variableSpentThisMonth,
  avgVariableSpend,
  commitmentProgress,
  billExpected,
  previousPayday,
  isOpenDebt,
  inAnyLine,
  payCycleFor,
  type PayoffEvent,
} from "../../lib/plan";
import { firepowerStatus } from "../../lib/headline";
// The Home Bills tile reads the Bills sheet's own window, from the same call.
import { billsBeforeNextPayday, monthGetter } from "../../lib/headline";
import { transferIds } from "../../lib/flow";
import { unusualCharges } from "../../lib/unusual";
import { totalBalance, cashAccounts, totalPendingHold } from "../../lib/recurring";
import { weekView } from "../../lib/weekPlan";
import { inActivityLedger, isTransferRow, needsReviewTx, countedTx } from "../../lib/activityRules";
import { ownAccounts, jointAccounts, type Lens } from "../../lib/lens";
import { OWNER_NAME, OWNER_COLOR, type Owner } from "../../lib/owner";
import { t } from "../../lib/i18n";
import type { HomeVM } from "./vm";
import type { InsightsVM } from "./InsightsTab";
import type { ActivityVM, ActivityMonth, ActivityRow, ActivityFate } from "./ActivityTab";
import type { ProfileVM } from "./ProfileTab";
import type { EnvelopeVM } from "./CategorySheet";

const pad = (n: number) => String(n).padStart(2, "0");
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dateKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtMY = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

// An account row's dot is its owner's colour — the same accent the avatar and the
// health side use (owner.ts), not a second palette — and grey for Joint.
const ownerDot = (accountOwner: string) =>
  accountOwner === "Gino"
    ? OWNER_COLOR.gino
    : accountOwner === "Xinyan"
      ? OWNER_COLOR.xinyan
      : "#687180";

const shortDebt = (n: string) => {
  const m = n.match(/…(\d{4})/);
  return m ? t("Card …{last4}", { last4: m[1] }) : n;
};

export interface VMExtras {
  email: string;
  lang: "en" | "zh";
}

export interface FinanceVMs {
  home: HomeVM;
  insights: InsightsVM;
  activity: ActivityVM;
  profile: ProfileVM;
  // The budget envelopes — each bar AND the transactions behind it, from one
  // calculation. FinanceTabs looks one up by key; it must never recompute.
  envelopes: EnvelopeVM[];
  // The single shared deploy plan — Home, the attack ladder, and the deploy slip
  // all read THIS, so their send-amounts and debt-free date never diverge.
  deploy: {
    ordered: Debt[];
    schedule: PayoffEvent[]; // the payoff projection (drives the ladder + debt-free date)
    totalDebt: number;
  };
}

export function buildFinanceVMs(
  data: AppData,
  owner: Owner,
  lens: Lens,
  extra: VMExtras,
): FinanceVMs {
  const now = new Date();
  const monthKey = monthKeyOf(now);
  const todayKey = dateKeyOf(now);
  const personal = lens === "me";
  const otherLabel = owner === "gino" ? "Xinyan" : "Gino";
  const otherAccountIds = new Set(
    data.accounts.filter((a) => a.owner === otherLabel).map((a) => a.id),
  );
  const myAccounts = personal ? ownAccounts(data.accounts, owner) : data.accounts;

  // ── core plan math ──
  // TWO horizons, deliberately. The debt/firepower math is MONTHLY because income
  // and bills are monthly. The BUDGET is graded per PAY CYCLE, because that's the
  // unit money actually arrives in — a calendar month splits one paycheck's
  // spending across two reports and hides where you stand until it's too late.
  //
  // ONE call, not a dozen. BOTH sequences this module used to spell out itself now
  // live in src/lib/headline.ts:
  //   · the envelope — monthly target, the cycle, its allowance, its graded spend,
  //     the per-category partition;
  //   · the hero tile's firepower — planMath, then the two subtractions planMath
  //     cannot see (month-to-date overspend, and cash out in categories no line
  //     grades) and the clamp at zero.
  // They live there because the Muse read door answers both questions, and a door
  // that re-applied those steps would be honestly computed and still disagree with
  // this screen — in a chat, with no screen beside the number to notice. A copy of a
  // sequence drifts exactly the way a copy of a formula does, with the arithmetic
  // hidden in the ORDER of the calls. Same functions, same order, same numbers on
  // this screen as before.
  const head = firepowerStatus(data, now);
  const { math, envelope, monthlyTarget, firepower } = head;
  const spentMonth = head.spentThisMonth;
  // The same idea on the cycle horizon — what the budget bar shows. NOT the same
  // number as head.overspendThisMonth: one grades a month, the other a pay cycle.
  const overspend = head.overspendThisCycle;
  const cycle = envelope.cycle;
  const target = envelope.target; // the allowance for THIS cycle
  const spent = envelope.spent;
  const lineFor = new Map(envelope.lines.map((l) => [l.key, l]));
  const ordered = orderedDebts(data.debts);
  // Project the payoff from the SUSTAINABLE pace — a trailing average of ACTUAL
  // variable spend — so the debt-free date tracks real behavior: a one-off
  // over-budget month barely moves it, a sustained trend does. This month's spend
  // above that pace dents the next payday once (that cash is already gone).
  const projVariable = avgVariableSpend(data.transactions, now, 3, monthlyTarget);
  const projFirepower = Math.max(0, math.income - math.fixedNonDebt - projVariable);
  // The deploy plan (lump-now + flow-after) is built below — after the bills
  // section — because it needs the bills-before-next-payday hold-back.
  const totalOriginal = data.debts.reduce((s, d) => s + d.originalBalance, 0);
  const cleared = totalOriginal - math.totalDebt;
  const clearedPct = totalOriginal > 0 ? (cleared / totalOriginal) * 100 : 0;
  const commit = commitmentProgress(now);

  // ── cash (lens-aware) ──
  const totalCash = totalBalance(data.accounts);
  const jointCash = personal ? totalBalance(jointAccounts(data.accounts)) : 0;
  const cash = personal ? totalBalance(myAccounts) + jointCash : totalCash;
  // Counted over the same accounts the total adds up (own + Joint in Mine), so the
  // tile never says "1 account" under a figure that sums two.
  const cashAcctCount = cashAccounts(
    personal ? [...myAccounts, ...jointAccounts(data.accounts)] : data.accounts,
  ).length;
  // "still processing" hold — mirror the cash lens (own + joint when personal)
  const processing = personal
    ? totalPendingHold(myAccounts) + totalPendingHold(jointAccounts(data.accounts))
    : totalPendingHold(data.accounts);

  // ── per-line budget (the 6 lean envelopes) ──
  //
  // The bar AND the transactions behind it are built together, from the same
  // `cycle` window and the same `perCycle` target. They used to be computed in
  // two places — the bar here, the drill-in list in FinanceTabs — and the two
  // drifted apart when the budget moved to pay cycles: the bar read $79.58 for
  // the cycle while the list it opened read $44.13 for the calendar month, of a
  // monthly $250 target. A number and the rows that justify it have to come from
  // one calculation, or the next horizon change silently splits them again.
  // The same exclusion the bar applies (spentByCategoryBetween): money moving between
  // their own accounts was not spent, and a row the bar leaves out cannot be listed
  // under it.
  const moved = transferIds(data.transactions);
  const envelopes: EnvelopeVM[] = LEAN_VARIABLE.map((l) => {
    const inLine = (catId: string) => l.cats.includes(catId);
    const raw: { id: string; name: string; date: string; amount: number }[] = [];
    let pendingAmt = 0;
    for (const t of data.transactions) {
      if (moved.has(t.id)) continue;
      // Pending charges are INCLUDED, and must be — spentByCategoryBetween, the
      // source of the bar, includes them. The two have to share a predicate or the
      // rows stop explaining the bar; they were once made to agree by hiding
      // pending from both, which agreed on a number $1,005 short of the truth.
      if (
        t.type !== "expense" ||
        t.date < cycle.start ||
        t.date > cycle.end ||
        t.appliesTo
      )
        continue;
      // Split-aware: a split txn contributes only the slices this line claims, at
      // their slice amount — the same partition spentByCategoryBetween uses, so
      // the rows always sum to the bar.
      const amt =
        t.splits && t.splits.length
          ? t.splits.filter((s) => inLine(s.categoryId)).reduce((s, x) => s + x.amount, 0)
          : inLine(t.categoryId)
            ? t.amount
            : 0;
      if (amt <= 0) continue;
      if (t.pending) pendingAmt += amt;
      raw.push({ id: t.id, name: t.description || t.categoryId, date: t.date, amount: amt });
    }
    raw.sort((a, b) => b.date.localeCompare(a.date));
    return {
      key: l.key,
      label: l.label,
      catId: l.cats[0],
      // Both figures come from the one shared assembly above, so the bar, the rows
      // behind it and the door all read the same two numbers.
      spent: lineFor.get(l.key)!.spent,
      pending: pendingAmt,
      target: lineFor.get(l.key)!.target,
      txns: raw.map((r) => ({
        id: r.id,
        name: r.name,
        amount: r.amount,
        dateLabel: new Date(r.date + "T00:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      })),
    };
  });
  const lineRows = envelopes.map((e) => ({
    catId: e.catId,
    label: e.label,
    spent: e.spent,
    target: e.target,
  }));
  const donut = lineRows.filter((r) => r.spent > 0).map((r) => ({ catId: r.catId, amount: r.spent }));

  // debtFreeBy / monthsToGo are derived from the deploy plan (built after bills).

  // ── the listed ledger: the household's, then the lens over it ──
  // inActivityLedger (src/lib/activityRules.ts) is the ONE rule for which rows the
  // lists show — FinanceTabs builds the All-activity ledger from it too, so the two
  // lists cannot drift apart again. "Set aside · excluded" drops out (like a
  // transfer); "set aside · reimbursable" stays VISIBLE until settled (it's owed to
  // you); a bank-feed bill or debt payment is listed even though the feed marks it
  // settled ("already in the anchored balance", not "hide").
  const inLens = (tx: Transaction) => !personal || !tx.accountId || !otherAccountIds.has(tx.accountId);
  const household = data.transactions
    .filter(inActivityLedger)
    .sort((a, b) =>
      a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date),
    );
  const visible = personal ? household.filter(inLens) : household;
  // The same pairing the counted figures skip, over the same rows they are summed from.
  const movedV = transferIds(visible);

  const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? id;
  const envLabel = (catId: string) =>
    LEAN_VARIABLE.find((l) => l.cats.includes(catId))?.label ?? catName(catId);

  const relDay = (date: string) => {
    if (date === todayKey) return t("today");
    const d = new Date(date + "T00:00:00");
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dateKeyOf(d) === dateKeyOf(y)) return t("yesterday");
    return fmtDay(d);
  };

  // ── Home recent (3) ──
  const recent = visible.slice(0, 3).map((tx) => ({
    id: tx.id,
    merchant: tx.description || catName(tx.categoryId),
    catId: tx.categoryId,
    sub: `${catName(tx.categoryId)} · ${relDay(tx.date)}`,
    amount: tx.amount,
    income: tx.type === "income",
    pending: !!tx.pending,
  }));

  // ── spent this week — the household's Sun–Sat week, the week the $/week plan runs on.
  // BOTH lenses are weekView's own spentTotal: graded line spend (pending included, as
  // on every bar) with money back netted. All runs it over the household's rows, so it
  // equals finance.week to the cent; Mine runs the SAME rule over the lens's rows, so
  // a person's week is a part of the household's and never larger than it. (Mine used
  // to add up line spend without netting money back, so one refund on a personal
  // account put a person's week above the household's.) This used to be "since
  // Monday": a Monday-start window with no end, posted rows only, every expense in the
  // list — a third weekly number that agreed with neither the plan nor Muse.
  const week = weekView(data, data.weekPlans ?? [], todayKey, "this");
  const spentThisWeek = personal
    ? weekView({ ...data, transactions: data.transactions.filter(inLens) }, data.weekPlans ?? [], todayKey, "this")
        .spentTotal
    : week.spentTotal;

  // ── simple anomaly count: a free-form charge > 2.5× its category's monthly mean.
  //    Judged over the HOUSEHOLD's charges, then filtered to the lens — so Mine is a
  //    strict subset of All, and the same Joint charge is never "unusual" on one phone
  //    and normal on the other. (Judging each lens on its own rows recomputed every
  //    category's mean over one person's few charges, which flagged ordinary buys.)
  //    The count still matches what the lens-filtered list can show.
  //
  //    THE RULE ITSELF MOVED to src/lib/unusual.ts on 2026-10-10, unchanged, so the
  //    read door's finance.unusual answers from the same function instead of a copy —
  //    this screen is being retired, and the write door's dismiss_unusual had nothing
  //    to point at. What stays here is only what this screen draws from it.
  const anomalies = unusualCharges(household, monthKey).filter(({ tx }) => inLens(tx)).map(({ tx: t, ratio }) => ({
    id: t.id,
    merchant: t.description || catName(t.categoryId),
    catId: t.categoryId,
    catLabel: catName(t.categoryId),
    amount: t.amount,
    ratio,
  }));
  const anomalyIds = anomalies.map((a) => a.id);
  const anomalyCount = anomalies.length;

  // ── the Home Bills tile — still due before the next payday ──
  // The same window, the same call and the same paid rule as the Bills sheet's header
  // and the read door's finance.next_bills (src/lib/headline.ts). This tile used to
  // read the CALENDAR month with its own spelling of "paid", so at every month end —
  // exactly when rent on the 1st sits in the next month — it read "$0 left" and
  // "next: — ·" under a sheet that said thousands were still due.
  const due = billsBeforeNextPayday(monthGetter(data, now), now);
  // "next" is the next bill still AHEAD — never an overdue one. When every bill left
  // in the window is overdue, the tile reads "Nothing else due before payday" beside
  // the red overdue figure rather than naming the same bill as both.
  const nextDue = due.bills.find((b) => !b.overdue);

  // ── Debt payoff projection (for the attack-ladder view + the debt-free date) ──
  // Month-to-date against the MONTHLY pace, deliberately: `projVariable` is a
  // 30-day average, so the overspend debited against it has to be a 30-day figure
  // too. This used to read the per-CYCLE `spent`, comparing half a period against
  // a whole one — a ~15-day total almost never clears a 30-day pace, so the dent
  // came out 0 for essentially every input and a blown month never moved the
  // debt-free date at all. NOT the same number as the hero tile's
  // `overspendThisMonth` (src/lib/headline.ts): that grades the month against the
  // budget TARGET, this grades it against the SUSTAINABLE pace. Two different
  // questions about one month — they are meant to differ.
  const monthDent = Math.max(0, spentMonth - projVariable);
  const schedule = payoffSchedule(ordered, projFirepower, now, PAY_DAYS, SAVINGS_SPLIT, monthDent);
  // The Home tile's "what leaves on payday" is the first payday that actually SENDS
  // money at the debt. The first paydays of a schedule can send $0 — this month's
  // spend above the pace is debited from them first — and schedule[0] then read
  // "$0", which the tile could only hide.
  const next = schedule.find((e) => e.toDebt > 0.005) ?? null;
  // A schedule that ran out its 240-payday guard without clearing the debt is
  // the same SHAPE as one that finished — a non-empty array — so `schedule.length`
  // was reading "it gave up in Aug '36" as "you are debt-free in Aug '36".
  // payoffClears() asks the only question that separates them.
  const clears = payoffClears(schedule);
  const debtFreeBy = clears ? fmtMY(schedule[schedule.length - 1].date) : "—";
  const monthsToGo = clears
    ? Math.max(1, Math.round((schedule[schedule.length - 1].date.getTime() - now.getTime()) / 2.592e9))
    : 0;
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
  // When the plan does not clear: how far short a month the planned paychecks fall of
  // living costs plus the recent spending pace — the honest reason there is no date.
  // At the planned pay (a floor), so the screen says "at this pace", never a promise.
  const payoffShortBy = clears ? 0 : Math.max(0, projVariable - (math.income - math.fixedNonDebt));
  const deploy = { ordered, schedule, totalDebt: math.totalDebt };

  // ── Tracking: what was actually sent at debt this cycle (live from tagged txns).
  // Cycle starts at the previous payday (− a few days of early-post grace).
  const cycleAnchor = previousPayday(now);
  cycleAnchor.setDate(cycleAnchor.getDate() - 4);
  const cycleStartKey = dateKeyOf(cycleAnchor);
  // Open debts only (2026-10-25): a closed debt takes no payments, and the bank sync no
  // longer credits one — its pattern names a lender whose NEW loan this money may be on.
  const debtPatterns = data.debts
    .filter(isOpenDebt)
    .map((d) => d.trackPattern)
    .filter((p): p is string => !!p)
    .map((p) => p.toUpperCase());
  // A card payment the bank sync links files as a BILL on the debt-linked recurring
  // row (the card-payment bill), never as kind "debt", and a provider-linked card
  // has no trackPattern — so neither older case could ever see it. Resolve a bill
  // row's debt the way the store's money engine does (its own debtId, else the
  // recurring row's linkedDebtId) and count it when that debt is open. One OR per
  // row, so nothing is counted twice.
  const openDebtIds = new Set(data.debts.filter(isOpenDebt).map((d) => d.id));
  const billDebt = (t: Transaction) =>
    t.appliesTo?.kind === "bill"
      ? (t.appliesTo.debtId ?? data.recurring.find((r) => r.id === t.appliesTo!.recurringId)?.linkedDebtId)
      : undefined;
  const deployedThisCycle = data.transactions
    .filter(
      (t) =>
        t.date >= cycleStartKey &&
        (t.appliesTo?.kind === "debt" ||
          (t.type === "expense" &&
            // `amount` is always positive — the sign is `type` — so this read
            // `t.amount < 0` and never matched anything until 2026-10-26.
            (debtPatterns.some((p) => (t.description ?? "").toUpperCase().includes(p)) ||
              openDebtIds.has(billDebt(t) ?? "")))),
    )
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  // ── "Owed to you" — reimbursable set-asides (real cash out until repaid) ──
  const isReimbursable = (tx: Transaction) =>
    tx.type === "expense" && tx.appliesTo?.kind === "setaside" && tx.appliesTo.reason === "reimbursable";
  const owed = data.transactions
    .filter((tx) => isReimbursable(tx) && !tx.appliesTo!.settled && inLens(tx))
    .sort((a, b) => b.date.localeCompare(a.date));
  const owedToYou = owed.reduce((s, tx) => s + tx.amount, 0);

  // Candidate paybacks: real income not yet linked, within the current lens. Match
  // a single deposit (exact amount, on/within 60 days after the spend), then keep
  // the suggestion ONLY if that deposit isn't claimed by another equal-amount row —
  // a deposit two reimbursables both match is ambiguous → fall back to manual.
  const DAY = 864e5;
  const creditPool = data.transactions.filter((tx) => tx.type === "income" && !tx.appliesTo && inLens(tx));
  const rawMatch = new Map<string, string>(); // reimbursableId -> creditId
  const claims = new Map<string, number>(); // creditId -> # reimbursables claiming it
  for (const tx of owed) {
    const spent = new Date(tx.date + "T00:00:00").getTime();
    const cands = creditPool.filter((c) => {
      if (Math.abs(c.amount - tx.amount) > 0.01) return false;
      const got = new Date(c.date + "T00:00:00").getTime();
      return got >= spent && got - spent <= 60 * DAY;
    });
    if (cands.length === 1) {
      rawMatch.set(tx.id, cands[0].id);
      claims.set(cands[0].id, (claims.get(cands[0].id) ?? 0) + 1);
    }
  }
  const owedList = owed.map((tx) => {
    const cid = rawMatch.get(tx.id);
    const c = cid && claims.get(cid) === 1 ? data.transactions.find((t) => t.id === cid) : undefined;
    return {
      id: tx.id,
      merchant: tx.description || catName(tx.categoryId),
      amount: tx.amount,
      dateLabel: relDay(tx.date),
      note: tx.appliesTo?.note,
      ...(c ? { suggested: { id: c.id, label: `${c.description || catName(c.categoryId)} · ${relDay(c.date)}` } } : {}),
    };
  });
  // Recently-settled reimbursables, newest first — the undo path for a mis-confirm.
  const owedSettled = data.transactions
    .filter((tx) => isReimbursable(tx) && !!tx.appliesTo!.settled && inLens(tx))
    .sort((a, b) => (b.appliesTo?.settledAt ?? b.date).localeCompare(a.appliesTo?.settledAt ?? a.date))
    .slice(0, 8)
    .map((tx) => ({ id: tx.id, merchant: tx.description || catName(tx.categoryId), amount: tx.amount, dateLabel: relDay(tx.date) }));

  const home: HomeVM = {
    firepower,
    overspent: overspend,
    owedToYou,
    owedList,
    owedSettled,
    debtFreeBy,
    payoffShortBy,
    deployedThisCycle,
    // the "Send X at the debt" tile is the DEBT portion only — in the final
    // payoff phase `total` also includes the savings skim (surfaced separately in
    // the slip), so using toDebt keeps the label honest.
    nextAmount: next ? next.toDebt : 0,
    nextDate: next ? fmtDay(next.date) : "—",
    cash,
    cashAccounts: cashAcctCount,
    processing,
    debtLeft: math.totalDebt,
    debtProgressPct: clearedPct,
    budgetSpent: spent,
    budgetCycleLabel: cycle.label,
    budgetCycleDay: cycle.dayIndex,
    budgetCycleDays: cycle.days,
    budgetTarget: target,
    donut,
    anomalyCount,
    anomalyIds,
    anomalies,
    streakDay: commit.day,
    streakTotal: commit.total,
    recent,
    spentThisWeek,
    bills: {
      left: due.total,
      nextName: nextDue?.name ?? "",
      nextDate: nextDue ? fmtDay(new Date(nextDue.due + "T00:00:00")) : "",
      overdue: due.overdueTotal,
    },
    household: personal,
  };

  // ── Insights ──
  // Open debts only: a closed debt (finished and kept) is not a rung to
  // climb. orderedDebts itself still lists it, on purpose — the attack-ladder sheet
  // shows it as "Cleared" and the door lists it as closed.
  const openOrdered = ordered.filter(isOpenDebt);
  const ladder = openOrdered.map((d, i) => {
    const done = d.balance <= 0.005;
    const isTarget = !done && openOrdered.slice(0, i).every((x) => x.balance <= 0.005);
    return {
      rank: i + 1,
      name: shortDebt(d.name),
      amount: d.balance,
      live: !!d.providerAccountId,
      apr: d.apr,
      target: isTarget,
    };
  });
  const insights: InsightsVM = {
    budgetSpent: spent,
    budgetCycleLabel: cycle.label,
    budgetCycleDay: cycle.dayIndex,
    budgetCycleDays: cycle.days,
    budgetTarget: target,
    donut,
    categories: lineRows,
    income: math.income,
    living: math.fixedNonDebt,
    variable: math.variable,
    // The PLAN's share for debt — income less living less the variable budget — so
    // the bar and the four stats beside it add up to the income. This was the live,
    // month-to-date firepower (that share less this month's overspend and outside-
    // the-budget cash, clamped at 0): the right number for "what is free right now",
    // the wrong one for "where every dollar goes", where it left the debt share unaccounted for
    // and dropped the Debt slice from the bar entirely in any month that ran over.
    atDebt: Math.max(0, math.firepower),
    debtFreeBy,
    monthsToGo,
    interest: totalInterest,
    clears,
    // The same "short a month" figure as Home's Payoff tile, so the two screens say
    // the same thing when there is no date.
    shortBy: payoffShortBy,
    ladder,
    household: personal,
  };

  // ── Activity (this-month + recent rows, fate-badged) ──
  const accountOwnerOf = (id?: string) => (id ? data.accounts.find((a) => a.id === id)?.owner : undefined);
  const fateOf = (tx: Transaction): { fate: ActivityFate; badge: string } => {
    // Set-asides first: an IOU keeps its "owed back to you" pill whatever else it is.
    if (tx.appliesTo?.kind === "setaside") {
      return tx.appliesTo.reason === "reimbursable"
        ? { fate: "setaside", badge: t("Set aside · owed back to you") }
        : { fate: "setaside", badge: t("Set aside") };
    }
    // Money moved between their own accounts — BOTH legs, the card payment and the
    // card's credit for it. The counted figures already skip these (transferIds);
    // the list called one leg "Income" and asked about the other, a card payment
    // that was never spending sitting in the review queue for months.
    if (isTransferRow(tx, movedV))
      return { fate: "skip", badge: t("{Kind} · not in budget", { Kind: t("Transfer") }) };
    if (tx.type === "income")
      return tx.categoryId === "refund"
        ? { fate: "income", badge: t("Money back") }
        : { fate: "income", badge: t("Income · not in budget") };
    if (tx.appliesTo) {
      const k = tx.appliesTo.kind;
      return {
        fate: "skip",
        badge: t("{Kind} · not in budget", { Kind: t(`${k[0].toUpperCase()}${k.slice(1)}`) }),
      };
    }
    if (tx.splits && tx.splits.length > 1)
      return { fate: "envelope", badge: t("Split · {n} ways", { n: tx.splits.length }) };
    // A charge that is still PROCESSING is not a question yet. Its category is
    // provisional on purpose (a pending bill takes "bills" and gets its real link
    // when it settles), the bank can still reverse it, and the posted twin will
    // ask again a day later. Asking now is asking twice about money that may not
    // even be spent — so a hold never enters the queue.
    if (tx.pending) return { fate: "envelope", badge: t("Processing") };
    // needsReview is the importer's OWN verdict: "I could not tell, ask once". It
    // is the only honest signal here — it knows about a multi-department merchant,
    // where the category shown is a coin flip rather than a reading.
    //
    // This used to also flag `!hasRule(description)`, which is not a signal of
    // anything: it means only that he has never tapped "Remember this merchant"
    // on that name. 43 of the 98 rows in the queue were sitting there for that
    // reason alone — T-Mobile, Spotify, Booking.com, Amazon Prime — every one of
    // them already filed correctly. Opening a "review" and finding the answer
    // already filled in is what made the queue not worth reading, and a queue not
    // worth reading hides the handful of rows that are genuinely undecided.
    //
    // `other` stays, but only when he has not answered it himself: Misc is the
    // absence of a category, so an unfiled row IS an open question — while one he
    // deliberately put in Misc is a closed one.
    //
    // The rule lives in src/lib/activityRules.ts now, so the All-activity ledger
    // asks exactly the same question about the same charge.
    if (needsReviewTx(tx, movedV)) return { fate: "review", badge: t("Needs review") };
    // A category no budget line grades (education, car, interest, a bill filed as
    // spending) is real cash out but is NOT in the budget — it must not wear the
    // same tinted "→ Category" pill as a row the bar is adding up.
    if (!inAnyLine(tx.categoryId))
      return { fate: "skip", badge: t("{Kind} · not in budget", { Kind: t(catName(tx.categoryId)) }) };
    return { fate: "envelope", badge: t("→ {label}", { label: t(envLabel(tx.categoryId)) }) };
  };
  // The Activity tab is THIS month (matches the "June 2026" header) and is NOT
  // capped — so the "Needs review" badge count equals what the filter shows, and
  // every reviewable charge is reachable (the all-time triage bench is LedgerSheet).
  // Group activity by month so the tab can flip back through prior months. Every
  // month present in the visible ledger (plus the current one) gets a group,
  // newest first; [0] is the current month.
  const toRows = (txns: typeof visible): ActivityRow[] =>
    txns.map((tx) => {
      const f = fateOf(tx);
      // A paycheck reads as one, with whose it is, rather than the bank's payroll
      // string cut off mid-word. TxnSheet still shows what the bank wrote.
      const paycheck = tx.type === "income" && tx.categoryId === "salary";
      const payOwner = paycheck ? accountOwnerOf(tx.accountId) : undefined;
      const merchant = paycheck
        ? payOwner
          ? `${t("Paycheck")} · ${t(payOwner)}`
          : t("Paycheck")
        : tx.description || catName(tx.categoryId);
      return {
        id: tx.id,
        merchant,
        catId: tx.categoryId,
        sub: relDay(tx.date),
        amount: tx.amount,
        fate: f.fate,
        badgeLabel: tx.pending ? t("Processing") : f.badge,
        pending: !!tx.pending,
        // The "$X counted" figure's own predicate, so the In budget filter lists
        // exactly the rows that figure adds up.
        counted: countedTx(tx, movedV),
        credit: tx.type === "income",
      };
    });

  const activityMonthKeys = Array.from(new Set([monthKey, ...visible.map((tx) => tx.date.slice(0, 7))]))
    .sort()
    .reverse();
  const monthGroups: ActivityMonth[] = activityMonthKeys.map((mk) => {
    const mrows = toRows(visible.filter((tx) => tx.date.slice(0, 7) === mk));
    const [yy, mm] = mk.split("-").map(Number);
    return {
      monthKey: mk,
      monthLabel: new Date(yy, mm - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      rows: mrows,
      counted: variableSpentThisMonth(visible, mk),
      needsReview: mrows.filter((r) => r.fate === "review").length,
    };
  });

  // The budget grades a PAY CYCLE; the ledger grouped by calendar month. At every
  // month boundary those disagree — a charge on the 31st counts toward this
  // cycle's spend but files under last month, so the budget number can't be
  // reconciled against anything you can see. This puts the cycle first, so the
  // list you scroll IS the list the envelope is adding up.
  const cycleGroupOf = (c: { start: string; end: string; label: string }, title: string): ActivityMonth => {
    const rows = toRows(visible.filter((tx) => tx.date >= c.start && tx.date <= c.end));
    return {
      monthKey: `cycle:${c.start}`,
      monthLabel: `${title} · ${c.label}`,
      rows,
      counted: variableSpentBetween(visible, c.start, c.end),
      needsReview: rows.filter((r) => r.fate === "review").length,
    };
  };
  const cycleGroup = cycleGroupOf(cycle, t("This cycle"));
  // One tap back is the cycle before — the one last payday's charges belong to —
  // and only then the calendar months.
  const [csy, csm, csd] = cycle.start.split("-").map(Number);
  const prevCycle = payCycleFor(new Date(csy, csm - 1, csd - 1));
  const lastCycleGroup = cycleGroupOf(prevCycle, t("Last cycle"));
  const months: ActivityMonth[] = [cycleGroup, lastCycleGroup, ...monthGroups];
  // Every pending hold is now its own row in the list. When those rows add up to the
  // bank's hold exactly, the card can say so plainly; when they do not (the bank
  // holding a lump it has not itemized), it keeps the old "~" wording.
  const heldRows = visible.filter((tx) => tx.pending && tx.type === "expense");
  const processingCount = heldRows.length;
  const processingItemized =
    processingCount > 0 && Math.abs(heldRows.reduce((s, tx) => s + tx.amount, 0) - processing) < 0.01;
  const activity: ActivityVM = { spentThisWeek, processing, processingCount, processingItemized, months };

  // ── Profile ──
  // Same lens rule as the Cash sheet/total: own + joint in "me", all in "all".
  const profileAccounts = personal
    ? [...myAccounts, ...jointAccounts(data.accounts)]
    : data.accounts;
  const linked = data.accounts.filter((a) => a.providerAccountId);
  // The bank login's count is the CASH accounts it brings — the ones listed under
  // Accounts below. The two cards it also syncs are named on the next row, as debt.
  // A household figure in both lenses, because the login is the household's.
  const connected = cashAccounts(linked).length;
  const linkedCards = data.debts
    .filter((d) => d.providerAccountId)
    .map((d) => (d.name.match(/…(\d{4})/) ? `…${d.name.match(/…(\d{4})/)![1]}` : d.name));
  // This device's owner first, then the spouse, then Joint.
  const accountRank = (o: string) => (o === OWNER_NAME[owner] ? 0 : o === "Joint" ? 2 : 1);
  // What a variable bill's estimate is actually made of. billExpected returns a set
  // amount before it averages anything, and averages however many charges exist (one
  // to three) — so "est. from last 3" was false for both of those. A bill that has
  // not started yet says when it starts.
  const variableEst = (r: (typeof data.recurring)[number]) => {
    const x = billExpected(r, data.transactions).toFixed(2);
    if (r.startsOn && r.startsOn > todayKey)
      return t("${x} · from {date}", { x, date: fmtDay(new Date(r.startsOn + "T00:00:00")) });
    if (r.knownAmount != null) return t("${x} · set amount", { x });
    const n = Math.min(
      3,
      data.transactions.filter(
        (tx) => tx.type === "expense" && tx.appliesTo?.kind === "bill" && tx.appliesTo.recurringId === r.id,
      ).length,
    );
    return n === 0 ? t("${x} · no bills yet", { x }) : t("~${x} · est. from last {n}", { x, n });
  };
  const profile: ProfileVM = {
    ownerName: OWNER_NAME[owner],
    ownerColor: OWNER_COLOR[owner],
    email: extra.email,
    bankName: linked.length ? "Bank of America" : t("Connect a bank"),
    bankSub: linked.length
      ? t("Connected · {n} accounts", { n: connected })
      : t("Tap to connect"),
    cardsSub: linkedCards.length
      ? t("{cards} linked · auto-syncs", { cards: linkedCards.join(" + ") })
      : t("Track a card as debt"),
    accounts: cashAccounts(profileAccounts)
      .map((a, i) => ({ a, i }))
      .sort((x, y) => accountRank(x.a.owner) - accountRank(y.a.owner) || x.i - y.i)
      .map(({ a }) => ({
        name: `${a.name} …${a.last4 ?? ""}`,
        owner: a.owner,
        balance: a.balance,
        dot: ownerDot(a.owner),
      })),
    lang: extra.lang,
    lens,
    variableBills: data.recurring
      .filter((r) => r.variable && r.active)
      .map((r) => ({
        id: r.id,
        name: r.name,
        icon: /electric|srp/i.test(r.name) ? ("electric" as const) : ("phone" as const),
        est: variableEst(r),
        on: !!r.variable,
      })),
  };

  return { home, insights, activity, profile, envelopes, deploy };
}
