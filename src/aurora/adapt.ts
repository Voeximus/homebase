// Homebase data → the inputs Aurora's logic expects.
//
// The design was drawn for one checking account, a list of recurring items and
// savings goals. Homebase has three accounts the household treats as ONE pot, a
// bill calendar with windows and paid overrides, a payoff plan for the debts, and a
// weekly spending plan. This file is the only place that translates between the
// two, so the screens never do their own arithmetic:
//
//   balance            every account that holds cash (cards are debt), household-wide
//   scheduled events   unpaid bills from the calendar + paychecks, each on its date
//   discretionary/day  this week's plan ÷ 7 (the household's own number, not a guess)
//   cushion            $100 — Gino's answer to the design's open decision 5, 2026-10-26
//
// WHAT THE LINE COUNTS — money that leaves ON ITS OWN, and nothing else. Every bill on
// the calendar, autopays that pay a debt included (the card's minimum, Cherry's plan,
// Mom's support), the paychecks, and the week's everyday spending. It does NOT
// subtract the payoff plan's extra payday payments: those are a choice made each
// payday ("how much can I put on the card?"), and the jump the line makes on a payday
// is the answer to that question. Modelling them as scheduled money — this cycle's
// send, what of it had gone, the plan's dent, which bill each send covered — was tried
// on 2026-10-26 and every fix opened a new way to count dollars twice or not at all
// (three review rounds), so the line was cut back to what actually moves by itself.
//
// Three rules keep it honest (each found in review against live data or a probe):
//   · A bill that is overdue and still unpaid is still owed: it counts tomorrow, from
//     the cycle's start or a week back, whichever is earlier — a bill a day or two
//     late must not vanish just because a payday passed (billCycleFor's 7-day grace).
//     A bill paid a few days late across a month end is filed by the feed against NEXT
//     month's installment; here it settles the one it paid, so last month's is not
//     shown overdue and next month's is not shown paid — one payment, one bill.
//   · A bill charged to a card is listed but never subtracted: it reaches checking only
//     as the card's own bill, which is.
//   · A paycheck already in the balance (early, on time or late) is not added again,
//     matched by the account it lands in; one due today or yesterday that has not
//     posted yet lands tomorrow.

import type { Account, AppData, Recurring } from "../types";
import { DUE_DAYS, dueOn, monthCalendar, monthlySchedule, paydayLandsOn } from "../lib/schedule";
import { planForWeek, weekOf, weekView } from "../lib/weekPlan";
import { LEAN_VARIABLE, isOpenDebt, lineSpent, previousPayday, spentByCategoryBetween } from "../lib/plan";
import { isCreditAccount, totalBalance } from "../lib/recurring";
import { bankWouldLink, linkContextOf } from "../lib/billMatch";
import * as L from "./logic";

/** Decision 5, answered by Gino on 2026-10-26: keep a $100 cushion. */
export const CUSHION = 100;
/** The Original home's chart window (spec: 30 days). */
export const FORECAST_DAYS = 30;

const isoOf = (d: Date) => L.localISO(d);

/** The day a payoff-plan payment can go: the plan dates them on the 15th and the
 *  month's end, but the check funding it lands on the Friday before a weekend
 *  (paydayLandsOn), and the money can only leave once it has arrived. */
export function sendDate(d: Date): string {
  const iso = isoOf(d);
  const day = paydayLandsOn(iso.slice(0, 7), Number(iso.slice(8, 10)));
  return `${iso.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

/** Which accounts a recurring row is paid from, so a bill charged to a card (which
 *  never touches checking until the card is paid) stays out of the cash forecast. */
function paidFromCard(r: Recurring | undefined, accounts: Account[]): boolean {
  if (!r?.accountId) return false;
  const a = accounts.find((x) => x.id === r.accountId);
  return !!a && isCreditAccount(a);
}

/**
 * Money that went at the debts between two dates, both included — Goals' "+$X paid
 * this month". A payment counts when it is linked to a debt, when it pays a bill that
 * pays a debt (a card's own bill, a payment plan), or when its description names a
 * lender with an OPEN debt. Only rows on a cash account (or with none): a charge on a
 * card is not a payment, and nothing is read from digits in a description — a debit
 * card's date stamp can spell an account's last four.
 */
export function debtPaymentsBetween(data: AppData, from: string, to: string): number {
  const linkedRec = new Set(data.recurring.filter((r) => r.linkedDebtId).map((r) => r.id));
  const cardIds = new Set(data.accounts.filter(isCreditAccount).map((a) => a.id));
  const patterns = data.debts
    .filter(isOpenDebt)
    .map((d) => d.trackPattern)
    .filter((p): p is string => !!p)
    .map((p) => p.toUpperCase());
  let sum = 0;
  for (const t of data.transactions) {
    if (t.type !== "expense" || t.date < from || t.date > to || t.recordOnly) continue;
    if (t.accountId && cardIds.has(t.accountId)) continue;
    const a = t.appliesTo;
    const onLinkedBill = a?.kind === "bill" && (!!a.debtId || (!!a.recurringId && linkedRec.has(a.recurringId)));
    const desc = (t.description ?? "").toUpperCase();
    if (a?.kind === "debt" || onLinkedBill || patterns.some((p) => desc.includes(p))) sum += t.amount;
  }
  return sum;
}

export interface AuroraInputs {
  today: string;
  balance: number;
  scheduled: L.ScheduledEvent[];
  /** The calendar's unpaid bills (debt-linked ones included), for "Coming up". An
   *  overdue one keeps its real due date and says so. */
  upcomingBills: {
    id: string;
    name: string;
    date: string;
    amount: number;
    catId: string;
    variable: boolean;
    overdue: boolean;
    /** Charged to a card: listed, but kept out of the cash forecast. */
    onCard: boolean;
    recurringId?: string;
    /** The installment's day and month, so a tap can open the right bill to pay. */
    day: number;
    monthKey: string;
  }[];
  discretionaryPerDay: number;
  cushion: number;
  payday: string | null;
}

/** How late a bill may be paid and still be that installment's payment (billCycleFor's
 *  own grace). */
const BILL_GRACE_DAYS = 7;

/**
 * The LAST-month installment a payment on `date` settles, when it is up to a week late
 * for it across a month end — the one case billCycleFor cannot see, since it never
 * looks back a month. Null otherwise, and null when an installment of the payment's
 * own month is already due by then: the payment is more likely that one's.
 */
export function lateIntoLastMonth(dueDays: number[] | undefined, date: string): { monthKey: string; day: number } | null {
  if (!dueDays?.length) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const dim = (yy: number, m0: number) => new Date(Date.UTC(yy, m0 + 1, 0)).getUTCDate();
  if (dueDays.some((dd) => Math.min(dd, dim(y, mo - 1)) <= d)) return null;
  const py = mo === 1 ? y - 1 : y;
  const pm0 = mo === 1 ? 11 : mo - 2;
  let best: { monthKey: string; day: number } | null = null;
  for (const dd of dueDays) {
    const day = Math.min(dd, dim(py, pm0));
    const due = `${py}-${String(pm0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const gap = L.daysBetween(due, date);
    if (gap >= 0 && gap <= BILL_GRACE_DAYS && (!best || day > best.day)) best = { monthKey: due.slice(0, 7), day };
  }
  return best;
}

/** How far from its date a paycheck may post and still be the same paycheck. */
const POST_DRIFT_DAYS = 4;
/** How late an unpaid bill stays counted after the payday that should have paid it. */
const LATE_BILL_DAYS = 7;

/**
 * Everything dated between today and the end of the window. Day 0 of the forecast
 * is the balance as it stands, so a bill still to leave that is due today or earlier
 * is placed on TOMORROW — otherwise it would never be subtracted at all.
 */
export function auroraInputs(data: AppData, now: Date, days = FORECAST_DAYS): AuroraInputs {
  const today = isoOf(now);
  const until = L.addDays(today, days + 7); // a week of slack past the chart
  const tomorrow = L.addDays(today, 1);
  const cycleStart = isoOf(previousPayday(now));
  const billFrom = [cycleStart, L.addDays(today, -LATE_BILL_DAYS)].sort()[0];
  const scheduled: L.ScheduledEvent[] = [];
  const upcomingBills: AuroraInputs["upcomingBills"] = [];
  const recOf = (id?: string) => (id ? data.recurring.find((r) => r.id === id) : undefined);

  // WHICH INSTALLMENTS ARE PAID. The feed files a bill payment with billCycleFor, which
  // looks at the payment's own month and the next, never back — so a bill paid a few
  // days late across a month end is filed against NEXT month's installment: last
  // month's reads unpaid though the money left, and next month's reads paid though
  // nothing has paid it. Here such a payment is filed where it belongs: a payment made
  // up to a week after a last-month installment fell due, with no installment of the
  // bill due in between, settles that one. Any other filing (a manual link included)
  // is kept. A bill with no recurring row (an annual fee) keeps the calendar's answer.
  type Inst = {
    key: string;
    recurringId?: string;
    due: string;
    monthKey: string;
    day: number;
    name: string;
    catId: string;
    variable: boolean;
    /** What is owed: the plan's figure (a paid installment's calendar amount is what was paid). */
    amount: number;
    /** The calendar's verdict, used only for an installment with no recurring row. */
    calPaid: boolean;
    paid: boolean;
  };
  const lookFrom = L.addDays(billFrom, -31);
  const insts: Inst[] = [];
  // Paychecks are gathered here and placed after the loop, in date order.
  const incomes: { id: string; name: string; date: string; amount: number; rec?: Recurring }[] = [];
  let y = Number(lookFrom.slice(0, 4));
  let m = Number(lookFrom.slice(5, 7)) - 1;
  for (let guard = 0; guard < 6; guard++) {
    const monthKey = `${y}-${String(m + 1).padStart(2, "0")}`;
    if (`${monthKey}-01` > until) break;
    const cal = monthCalendar(data.recurring, data.transactions, now, y, m, data.debts);
    const plan = monthlySchedule(data.recurring, monthKey, data.transactions, data.debts).entries;
    for (const b of cal.bills) {
      const due = dueOn(cal, b);
      if (due < lookFrom || due > until) continue;
      const planned = plan.find((e) => e.direction === "out" && e.recurringId === b.recurringId && e.day === b.day);
      insts.push({
        key: `${b.id}|${due}`,
        recurringId: b.recurringId,
        due,
        monthKey,
        day: b.day,
        name: b.name,
        catId: b.catId,
        variable: b.variable,
        amount: b.paid ? (planned?.amount ?? b.amount) : b.amount,
        calPaid: b.paid,
        paid: false,
      });
    }
    const monthDays = cal.daysInMonth;
    for (const e of plan) {
      if (e.direction !== "in") continue;
      const date = dueOn(cal, { day: Math.min(Math.max(e.day, 1), monthDays) });
      if (date < L.addDays(today, -POST_DRIFT_DAYS) || date > until) continue;
      incomes.push({ id: `${e.recurringId ?? e.label}|${date}`, name: e.label, date, amount: e.amount, rec: recOf(e.recurringId) });
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }

  // Each bill payment, filed where it belongs, then matched the way monthCalendar
  // matches: each installment takes the nearest of its month's payments for that bill.
  // A payment the feed left UNLINKED counts too, where the feed's own matcher
  // (bankWouldLink) places it: once a late payment has been filed against next month's
  // installment, the sync finds that installment taken and writes its real payment with
  // no link at all — so without this, the bill would read unpaid though it was paid.
  const pools = new Map<string, { day: number }[]>();
  const file = (recurringId: string, month: string, day: number, date: string) => {
    const rec = recOf(recurringId);
    const back = lateIntoLastMonth(rec ? (rec.dueDays ?? DUE_DAYS[rec.name]) : undefined, date);
    if (back && month >= date.slice(0, 7)) {
      month = back.monthKey;
      day = back.day;
    }
    const k = `${recurringId}|${month}`;
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k)!.push({ day });
  };
  const linkCtx = linkContextOf(data);
  for (const tx of data.transactions) {
    if (tx.type !== "expense" || tx.date > today || tx.date < L.addDays(lookFrom, -40) || tx.recordOnly) continue;
    const a = tx.appliesTo;
    if (a) {
      if (a.kind !== "bill" || a.settled === false || !a.recurringId || !a.monthKey) continue;
      file(a.recurringId, a.monthKey, a.day ?? Number(tx.date.slice(8, 10)), tx.date);
      continue;
    }
    const link = bankWouldLink(tx, linkCtx);
    if (link) file(link.bill.id, link.monthKey, link.day, tx.date);
  }
  for (const inst of [...insts].sort((a, b) => a.due.localeCompare(b.due))) {
    if (!inst.recurringId) {
      inst.paid = inst.calPaid;
      continue;
    }
    const left = pools.get(`${inst.recurringId}|${inst.monthKey}`);
    if (!left?.length) continue;
    const near = left.reduce((best, p) => (Math.abs(p.day - inst.day) < Math.abs(best.day - inst.day) ? p : best));
    left.splice(left.indexOf(near), 1);
    inst.paid = true;
  }

  for (const inst of insts) {
    if (inst.paid || inst.due < billFrom || inst.due > until) continue;
    const onCard = paidFromCard(recOf(inst.recurringId), data.accounts);
    upcomingBills.push({
      id: inst.key,
      name: inst.name,
      date: inst.due,
      amount: inst.amount,
      catId: inst.catId,
      variable: inst.variable,
      overdue: inst.due < today,
      onCard,
      recurringId: inst.recurringId,
      day: inst.day,
      monthKey: inst.monthKey,
    });
    if (onCard) continue;
    scheduled.push({ id: inst.key, name: inst.name, date: inst.due <= today ? tomorrow : inst.due, amount: -inst.amount, kind: "bill" });
  }

  // Has a paycheck already posted? Matched on the ACCOUNT it lands in and its category,
  // not its amount: the amount on the row is a planning floor and real checks run far
  // from it ($1,400 planned against $1,350–$3,140 deposited, live data 2026-10-27), and
  // each person is paid into their own account. Checks are matched in date order, so a
  // check that posted on time takes its own deposit before a later one can borrow it.
  // Without an account to go by, a deposit must be within half the planned amount.
  const deposits = data.transactions.filter(
    (tx) => tx.type === "income" && tx.date >= L.addDays(today, -2 * POST_DRIFT_DAYS) && tx.date <= today,
  );
  const usedDeposit = new Set<string>();
  const posted = (inc: (typeof incomes)[number]): boolean => {
    const rec = inc.rec;
    const hit = deposits.find(
      (tx) =>
        !usedDeposit.has(tx.id) &&
        tx.date >= L.addDays(inc.date, -POST_DRIFT_DAYS) &&
        tx.date <= L.addDays(inc.date, POST_DRIFT_DAYS) &&
        (!rec?.categoryId || tx.categoryId === rec.categoryId) &&
        (rec?.accountId && tx.accountId
          ? tx.accountId === rec.accountId
          : Math.abs(tx.amount - inc.amount) <= 0.5 * inc.amount),
    );
    if (hit) usedDeposit.add(hit.id);
    return !!hit;
  };
  incomes.sort((a, b) => a.date.localeCompare(b.date));
  for (const inc of incomes) {
    if (posted(inc)) continue; // already in the balance
    if (inc.date < L.addDays(today, -1)) continue; // long past and never seen: not counted — the safe side
    // Due today or yesterday and not in yet (the feed can lag a day): it lands tomorrow.
    scheduled.push({ id: inc.id, name: inc.name, date: inc.date <= today ? tomorrow : inc.date, amount: inc.amount, kind: "income" });
  }

  upcomingBills.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const week = planForWeek(weekOf(today).start, data.weekPlans ?? [], data);
  return {
    today,
    balance: totalBalance(data.accounts),
    scheduled,
    upcomingBills,
    discretionaryPerDay: week.total / 7,
    cushion: CUSHION,
    payday: L.nextPayday([], today, scheduled),
  };
}

/** The household's week, as the weekly plan and both Muses already read it. */
export function thisWeek(data: AppData, today: string) {
  const v = weekView(data, data.weekPlans ?? [], today, "this");
  const last = weekView(data, data.weekPlans ?? [], today, "last");
  const todayIndex = L.daysBetween(v.week.start, today);
  // Per day, on the budget lines — the same partition the week's figures add up —
  // less the money back that counted, on the day it came back. Not floored per day:
  // a day can go below zero, so the seven add up to exactly "Spent this week" (the
  // bars draw a day at or under zero as an empty stub).
  const perDay = (w: typeof v): number[] =>
    Array.from({ length: 7 }, (_, i) => {
      const d = L.addDays(w.week.start, i);
      const byCat = spentByCategoryBetween(data.transactions, d, d);
      const back = w.moneyBack.filter((mb) => mb.tx.date === d).reduce((s, mb) => s + mb.counted, 0);
      return LEAN_VARIABLE.reduce((s, l) => s + lineSpent(l, byCat), 0) - back;
    });
  const byDay = perDay(v);
  // Against last week up to the SAME weekday: a whole last week against a part of
  // this one would read "95% less" in green every Sunday.
  const upTo = (xs: number[]) => xs.slice(0, Math.max(0, todayIndex) + 1).reduce((s, x) => s + x, 0);
  const lastToDate = upTo(perDay(last));
  const change = lastToDate > 0 ? (upTo(byDay) - lastToDate) / lastToDate : null;
  return {
    start: v.week.start,
    plan: v.planTotal,
    spent: v.spentTotal,
    left: v.leftTotal,
    over: v.overBy != null,
    daysLeft: v.daysLeft,
    changeLabel: L.changeLabel(change),
    lessThanLast: change != null && change < 0,
    byDay,
    todayIndex,
  };
}

// ── category → icon + colour (data & logic: "Category icons") ──────────────
export type AuroraIcon =
  | "cart" | "coffee" | "income" | "fuel" | "bag" | "phone" | "rent" | "sparkle";
export interface IconStyle {
  icon: AuroraIcon;
  /** The icon's colour. */
  fg: string;
  /** The disc behind it (the colour at .12–.16 alpha). */
  bg: string;
  /** Activity's disc glow (the colour at .20–.25). */
  glow: string;
}
const VIOLET: IconStyle = { icon: "cart", fg: "#B7ACFF", bg: "rgba(155,140,255,0.14)", glow: "rgba(124,104,255,0.25)" };
const AMBER: Omit<IconStyle, "icon"> = { fg: "#FFC46B", bg: "rgba(255,196,107,0.14)", glow: "rgba(255,196,107,0.2)" };
const TEAL: Omit<IconStyle, "icon"> = { fg: "#3BE0CF", bg: "rgba(59,224,207,0.14)", glow: "rgba(59,224,207,0.25)" };
const SKY: Omit<IconStyle, "icon"> = { fg: "#6CB8FF", bg: "rgba(108,184,255,0.14)", glow: "rgba(108,184,255,0.2)" };
const ROSE: Omit<IconStyle, "icon"> = { fg: "#FF9CC8", bg: "rgba(255,122,182,0.14)", glow: "rgba(255,122,182,0.2)" };
const SILVER: Omit<IconStyle, "icon"> = { fg: "#C4C6D4", bg: "rgba(196,198,212,0.12)", glow: "rgba(196,198,212,0.2)" };
// Home's bill discs use the reference's own pair: phone violet-300 on .14, rent teal on .12.
const PHONE: IconStyle = { icon: "phone", fg: "#B7ACFF", bg: "rgba(183,172,255,0.14)", glow: "rgba(183,172,255,0.25)" };
const RENT: IconStyle = { icon: "rent", ...TEAL, bg: "rgba(59,224,207,0.12)" };

const INCOME_CATS = new Set(["salary", "freelance", "gift", "refund", "other-income", "interest"]);
const PHONE_NAME = /phone|verizon|t-?mobile|mobile|wireless|at&t/i;

/** One table for every list in Aurora (the spec's "Category icons"). */
export function iconFor(catId: string | undefined, name = "", income = false): IconStyle {
  if (income || (catId && INCOME_CATS.has(catId))) return { icon: "income", ...TEAL };
  if (PHONE_NAME.test(name)) return PHONE;
  switch (catId) {
    case "groceries":
      return VIOLET;
    case "dining":
      return { icon: "coffee", ...AMBER };
    case "transport":
    case "car":
      return { icon: "fuel", ...SKY };
    case "shopping":
    case "subscriptions":
    case "electronics":
      return { icon: "bag", ...ROSE };
    case "housing":
    case "utilities":
      return RENT;
    default:
      return { icon: "sparkle", ...SILVER };
  }
}

/** The category palette, always in this order (foundations: "Category palette"). */
export const CATEGORY_PALETTE = ["#9B8CFF", "#FF7AB6", "#3BE0CF", "#FFC46B", "#6CB8FF", "#C4C6D4"];
/** Light tints for a chip's text on its colour (components: "Chip (tinted)"). */
export const CHIP_TEXT: Record<string, string> = {
  "#9B8CFF": "#D4CCFF",
  "#3BE0CF": "#A6F3EA",
  "#FF7AB6": "#FFC6DF",
  "#FFC46B": "#FFE2B8",
  "#6CB8FF": "#C4E2FF",
  "#C4C6D4": "#E4E5EE",
};
export const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** The budget lines' short names for the ring legend (the full labels wrap two columns). */
export const LINE_SHORT: Record<string, string> = {
  groceries: "Groceries",
  gas: "Gas",
  dining: "Dining out",
  household: "Household",
  pets: "Pets",
  misc: "Misc",
};

/** "Good morning" 05–12, "Good afternoon" 12–17, "Good evening" 17–05 (device local time). */
export function greeting(now: Date): "Good morning" | "Good afternoon" | "Good evening" {
  const h = now.getHours();
  return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening";
}
