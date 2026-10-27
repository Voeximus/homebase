// Aurora — the numbers the screens show. A TypeScript port of the design
// handoff's reference logic (aurora-design-handoff/logic/aurora-logic.mjs),
// kept function-for-function so the handoff's tests still pin every result
// (see logic.test.ts, which runs them against the handoff's own fixtures).
//
// Every function is pure. Dates are local calendar dates as 'YYYY-MM-DD'
// strings; arithmetic is done in UTC so time zones and DST never shift a day.
//
// One addition over the reference: buildForecast also takes `scheduled`, a list
// of already-dated income/bill events. Homebase's bills have windows, paid
// overrides and cadences ("semimonthly", "yearly") the reference's three
// cadences can't express, so the app expands its own schedule (aurora/adapt.ts)
// and hands the dates in. Recurring items still work exactly as in the reference.

export type Kind = "income" | "bill";
export interface Recurring {
  id: string;
  name: string;
  kind: Kind;
  amount: number;
  cadence: "weekly" | "biweekly" | "monthly";
  next: string;
}
export interface Goal {
  id: string;
  name: string;
  target: number;
  saved: number;
  autofillPerPayday: number;
}
export type EventKind = Kind | "transfer" | "extra";
export interface ForecastEvent {
  id: string;
  name: string;
  amount: number;
  kind: EventKind;
}
export interface ForecastDay {
  date: string;
  balance: number;
  events: ForecastEvent[];
}
/** A dated income or bill, already expanded from whatever schedule the app keeps. */
export interface ScheduledEvent {
  id: string;
  name: string;
  date: string;
  /** Signed: income positive, bills and transfers out negative. */
  amount: number;
  /** "transfer" is money the plan moves out on a payday (Homebase: the payoff plan's
   *  sends) — subtracted like a goal's auto-fill, never shown as a bill. */
  kind: Kind | "transfer";
}

// ---------- dates ----------
const toUTC = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
};
const fromUTC = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromUTC(toUTC(d) + n * 86400000);
export const daysBetween = (a: string, b: string) => Math.round((toUTC(b) - toUTC(a)) / 86400000); // b - a
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUTC(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last)));
}
/** Today as a local calendar date. */
export function localISO(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** All occurrences of a recurring item from its `next` date up to and including `until`. */
export function occurrences(item: Recurring, until: string): string[] {
  const out: string[] = [];
  let d = item.next;
  while (d <= until) {
    out.push(d);
    d = item.cadence === "monthly" ? addMonths(d, 1) : addDays(d, item.cadence === "weekly" ? 7 : 14);
  }
  return out;
}

/** First income date strictly after today (the "next payday"), or null if no income is known. */
export function nextPayday(recurring: Recurring[], today: string, scheduled: ScheduledEvent[] = []): string | null {
  const dates = recurring
    .filter((r) => r.kind === "income")
    .flatMap((r) => occurrences(r, addDays(today, 62)))
    .concat(scheduled.filter((e) => e.kind === "income").map((e) => e.date))
    .filter((d) => d > today)
    .sort();
  return dates[0] ?? null;
}

// ---------- forecast ----------
/**
 * Projected end-of-day balance of the spending account for today + `days` days.
 * Day 0 is today and equals the current balance (today's spending is already in it).
 * Each later day: minus the discretionary estimate, plus income, minus bills,
 * and on paydays minus each goal's auto-fill (moved out to savings). Auto-fills
 * stop once a goal is full; the running total is tracked across paydays.
 * `extra` adds one-off events, e.g. a purchase being considered ({date, amount}).
 */
export function buildForecast({
  today,
  balance,
  days,
  recurring,
  scheduled = [],
  goals = [],
  discretionaryPerDay,
  extra = [],
}: {
  today: string;
  balance: number;
  days: number;
  recurring: Recurring[];
  scheduled?: ScheduledEvent[];
  goals?: Goal[];
  discretionaryPerDay: number;
  extra?: { date: string; amount: number; name?: string }[];
}): ForecastDay[] {
  const until = addDays(today, days);
  const byDate = new Map<string, ForecastEvent[]>();
  const push = (date: string, ev: ForecastEvent) => {
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(ev);
  };
  for (const r of recurring) {
    for (const d of occurrences(r, until)) {
      if (d > today) push(d, { id: r.id, name: r.name, amount: r.kind === "income" ? r.amount : -r.amount, kind: r.kind });
    }
  }
  for (const e of scheduled) {
    if (e.date > today && e.date <= until) push(e.date, { id: e.id, name: e.name, amount: e.amount, kind: e.kind });
  }
  for (const e of extra) push(e.date, { id: "extra", name: e.name ?? "Planned purchase", amount: e.amount, kind: "extra" });

  const saved: Record<string, number> = Object.fromEntries(goals.map((g) => [g.id, g.saved]));
  const out: ForecastDay[] = [];
  let bal = balance;
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    const events = [...(byDate.get(date) ?? [])];
    if (events.some((e) => e.kind === "income")) {
      for (const g of goals) {
        const need = g.target - saved[g.id];
        if (g.autofillPerPayday > 0 && need > 0) {
          const amt = Math.min(g.autofillPerPayday, need);
          saved[g.id] += amt;
          events.push({ id: `autofill:${g.id}`, name: `${g.name} auto-fill`, amount: -amt, kind: "transfer" });
        }
      }
    }
    if (i > 0) bal -= discretionaryPerDay;
    for (const e of events) bal += e.amount; // day-0 events are only `extra` (recurring ones start tomorrow)
    out.push({ date, balance: round2(bal), events });
  }
  return out;
}

/** Lowest projected balance on any day before `payday` (today included). Whole window when payday is null. */
export function lowestBeforePayday(forecast: ForecastDay[], payday: string | null): ForecastDay {
  const window = forecast.filter((f) => !payday || f.date < payday);
  return lowest(window);
}
/** Lowest day in a list of forecast days. */
export function lowest(days: ForecastDay[]): ForecastDay {
  return days.reduce((lo, f) => (f.balance < lo.balance ? f : lo), days[0]);
}

export interface CushionAdvice {
  lowest: number;
  lowestDate: string;
  firstBelow: string;
  daysBelow: number;
  amount: number;
  moveBy: string;
}
/**
 * If the forecast dips under the cushion before payday: how much to move in, and when.
 * amount = (cushion − lowest), rounded UP to the next $50.
 * moveBy = the day before the first day that ends under the cushion, but never before today.
 */
export function cushionAdvice(forecast: ForecastDay[], cushion: number, payday: string | null): CushionAdvice | null {
  const today = forecast[0].date;
  const window = forecast.filter((f) => !payday || f.date < payday);
  const below = window.filter((f) => f.balance < cushion);
  if (below.length === 0) return null;
  const low = lowest(window);
  const dayBefore = addDays(below[0].date, -1);
  return {
    lowest: low.balance,
    lowestDate: low.date,
    firstBelow: below[0].date,
    daysBelow: below.length,
    amount: Math.ceil((cushion - low.balance) / 50) * 50,
    moveBy: dayBefore < today ? today : dayBefore,
  };
}

export interface StatusPillResult {
  tone: "calm" | "warning";
  text: string;
}
/** Status pill on Home: rose when the forecast goes under the cushion within 7 days. */
export function statusPill(forecast: ForecastDay[], cushion: number, _recurring?: unknown): StatusPillResult {
  const today = forecast[0].date;
  const soon = forecast.filter((f) => f.date <= addDays(today, 7));
  const firstBelow = soon.find((f) => f.balance < cushion);
  if (forecast[0].balance < 0) return { tone: "warning", text: "You're overdrawn" };
  if (firstBelow)
    return {
      tone: "warning",
      text: firstBelow.date === today ? "Under your cushion today" : `Under your cushion from ${shortDate(firstBelow.date)}`,
    };
  const bills = forecast.flatMap((f) => f.events.filter((e) => e.kind === "bill").map((e) => ({ ...e, date: f.date })));
  const big = bills.sort((a, b) => a.amount - b.amount)[0]; // most negative = largest bill
  return big
    ? { tone: "calm", text: `Steady until ${big.name.toLowerCase()} on ${shortDate(big.date)}` }
    : { tone: "calm", text: "Steady for the next month" };
}

/**
 * Up to 5 chips for the Horizon day picker, in date order: today, the largest
 * bill day, the lowest day before payday, payday, the last day of the window.
 * Duplicate dates are replaced by the next-largest bill day when there is one.
 */
export function horizonKeyDays(forecast: ForecastDay[], payday: string | null) {
  const today = forecast[0].date;
  const last = forecast[forecast.length - 1].date;
  const billDays = forecast
    .map((f) => ({ date: f.date, bill: -f.events.filter((e) => e.kind === "bill").reduce((a, e) => a + e.amount, 0) }))
    .filter((d) => d.bill > 0)
    .sort((a, b) => b.bill - a.bill)
    .map((d) => d.date);
  const picks = [today];
  const add = (d: string | null | undefined) => {
    if (d && !picks.includes(d)) picks.push(d);
  };
  add(billDays[0]);
  add(lowestBeforePayday(forecast, payday).date);
  add(payday && payday <= last ? payday : null);
  add(last);
  for (const d of billDays.slice(1)) {
    if (picks.length >= 5) break;
    add(d);
  }
  return picks
    .sort()
    .slice(0, 5)
    .map((date) => ({
      date,
      label: date === today ? "Today" : shortDate(date),
      balance: forecast.find((f) => f.date === date)!.balance,
    }));
}

// ---------- safe to spend ----------
/**
 * dailyBudget = (balance at start of today − bills due after today and before payday − cushion if included) ÷ days until payday
 * safeToday   = dailyBudget − already spent today, floored at 0.
 * overToday   = how far today's spending is past the daily budget (0 if not).
 * "days until payday" counts today and stops the day before payday (30 days when no payday is known).
 */
export function safeToSpend({
  today,
  balance,
  spentToday,
  recurring,
  cushion,
  includeCushion = true,
}: {
  today: string;
  balance: number;
  spentToday: number;
  recurring: Recurring[];
  cushion: number;
  includeCushion?: boolean;
}) {
  const payday = nextPayday(recurring, today);
  const end = payday ? addDays(payday, -1) : addDays(today, 29);
  const days = daysBetween(today, end) + 1;
  const bills = recurring
    .filter((r) => r.kind === "bill")
    .flatMap((r) => occurrences(r, end).filter((d) => d > today).map(() => r.amount))
    .reduce((a, b) => a + b, 0);
  const startOfDay = balance + spentToday;
  const available = startOfDay - bills - (includeCushion ? cushion : 0);
  const dailyBudget = Math.max(0, available / days);
  return {
    payday,
    days,
    bills: round2(bills),
    dailyBudget: round2(dailyBudget),
    safeToday: round2(Math.max(0, dailyBudget - spentToday)),
    overToday: round2(Math.max(0, spentToday - dailyBudget)),
  };
}

/** Orb mood: 'tight' when less than a quarter of today's budget is left, or the forecast dips under the cushion within 7 days. */
export function mood({
  safeToday,
  dailyBudget,
  forecast,
  cushion,
  today,
}: {
  safeToday: number;
  dailyBudget: number;
  forecast: ForecastDay[];
  cushion: number;
  today: string;
}): "calm" | "tight" {
  const soon = forecast.filter((f) => f.date <= addDays(today, 7));
  if (dailyBudget <= 0 || safeToday < 0.25 * dailyBudget) return "tight";
  if (soon.some((f) => f.balance < cushion)) return "tight";
  return "calm";
}

/**
 * Orb "Next 7 days" bars: each day's daily budget, assuming the user spends exactly
 * the budget on the days before. Constant until payday, recalculated from payday on.
 * `hasBill` marks bill days (drawn amber).
 */
export function nextDaysBudget({
  today,
  forecast,
  recurring,
  cushion,
  includeCushion = true,
  budgetToday,
}: {
  today: string;
  forecast: ForecastDay[];
  recurring: Recurring[];
  cushion: number;
  includeCushion?: boolean;
  budgetToday: number;
}) {
  const payday = nextPayday(recurring, today);
  const out: { date: string; label: string; budget: number; hasBill: boolean }[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(today, i);
    const day = forecast.find((f) => f.date === date);
    let budget = budgetToday;
    if (payday && date >= payday && day) {
      const rolled = recurring.map((r) => ({ ...r, next: occurrences(r, addDays(date, 400)).find((d) => d >= date) ?? r.next }));
      budget = safeToSpend({ today: date, balance: day.balance + 0, spentToday: 0, recurring: rolled, cushion, includeCushion }).dailyBudget;
    }
    out.push({ date, label: i === 0 ? "Today" : weekday(date), budget, hasBill: (day?.events ?? []).some((e) => e.kind === "bill") });
  }
  return out;
}

// ---------- goals ----------
/** Date the goal fills at its current auto-fill, or null if paused (no auto-fill). */
export function goalEta(goal: Goal, recurring: Recurring[], today: string): string | null {
  if (goal.saved >= goal.target) return today;
  if (!goal.autofillPerPayday) return null;
  const n = Math.ceil((goal.target - goal.saved) / goal.autofillPerPayday);
  const pays = recurring
    .filter((r) => r.kind === "income")
    .flatMap((r) => occurrences(r, addDays(today, 365 * 5)))
    .filter((d) => d > today)
    .sort();
  return pays[n - 1] ?? null;
}

// ---------- month insights ----------
export interface PlanCategory {
  id: string;
  name: string;
  plan: number;
  spent: number;
  colour?: string;
}
export interface Insight {
  category: string;
  title: string;
  left: number;
  perDay: number;
  body: string;
}
/**
 * Category pace vs the month. A category is "ahead" when spent/plan is more than
 * 5 points ahead of the share of the month that has passed; "over" when spent > plan.
 * The single worst category becomes the tip.
 *
 * `period` is the app's addition: Homebase grades its budget over a PAY CYCLE,
 * not a calendar month, so the screen passes the cycle's day and length. Without
 * it the calendar month is used, exactly as the reference does.
 */
export function monthInsights(
  plan: { categories: PlanCategory[] },
  today: string,
  period?: { day: number; days: number },
) {
  const [y, m, dd] = today.split("-").map(Number);
  const d = period ? period.day : dd;
  const daysInMonth = period ? period.days : new Date(Date.UTC(y, m, 0)).getUTCDate();
  const elapsed = d / daysInMonth;
  const daysLeft = daysInMonth - d;
  const totalPlan = plan.categories.reduce((a, c) => a + c.plan, 0);
  const totalSpent = plan.categories.reduce((a, c) => a + c.spent, 0);
  const cats = plan.categories.map((c) => {
    const pace = c.plan > 0 ? c.spent / c.plan : c.spent > 0 ? Infinity : 0;
    return { ...c, pace, over: c.spent > c.plan, ahead: pace > elapsed + 0.05 };
  });
  const worst = cats.filter((c) => c.ahead).sort((a, b) => b.pace - a.pace)[0] ?? null;
  let insight: Insight | null = null;
  if (worst && d > 3) {
    const left = worst.plan - worst.spent;
    insight = worst.over
      ? { category: worst.name, title: `${worst.name} is over plan`, left, perDay: 0, body: `$${-left} over, with ${daysLeft} days to go.` }
      : {
          category: worst.name,
          title: `${worst.name} is running ahead`,
          left,
          perDay: daysLeft > 0 ? Math.floor(left / daysLeft) : 0,
          body: `$${left} left for ${daysLeft} days, about $${daysLeft > 0 ? Math.floor(left / daysLeft) : 0} a day.`,
        };
  }
  return { day: d, daysInMonth, daysLeft, totalPlan, totalSpent, left: totalPlan - totalSpent, categories: cats, insight };
}

// ---------- activity ----------
/** Money out this week (Mon–Sun containing today), income and transfers excluded, plus change vs last week. */
export function weeklySpend(
  transactions: { date: string; amount: number; category?: string }[],
  today: string,
  lastWeekSpent: number | null,
) {
  const dow = (new Date(toUTC(today)).getUTCDay() + 6) % 7; // Mon = 0
  const start = addDays(today, -dow);
  const end = addDays(start, 6);
  const spent = transactions
    .filter((t) => t.date >= start && t.date <= end && t.amount < 0 && t.category !== "Transfer")
    .reduce((a, t) => a - t.amount, 0);
  const change = lastWeekSpent ? (spent - lastWeekSpent) / lastWeekSpent : null;
  return {
    start,
    end,
    spent: round2(spent),
    change,
    label: changeLabel(change),
  };
}
/** "18% less than last week" — shared by the reference week and the household's Sunday week. */
export function changeLabel(change: number | null): string | null {
  return change == null ? null : `${Math.round(Math.abs(change) * 100)}% ${change < 0 ? "less" : "more"} than last week`;
}

// ---------- can I afford it ----------
/**
 * Compare buying today vs buying on payday. Each scenario is a full forecast;
 * its "lowest" is the lowest end-of-day balance over the whole window, which
 * runs at least 7 days past payday so a too-big purchase on payday is caught.
 * Waiting is "fine" when it is no worse than doing nothing (the unavoidable
 * pre-payday low) and never goes below $0.
 */
export function affordCheck({
  today,
  balance,
  recurring,
  scheduled = [],
  goals,
  discretionaryPerDay,
  cushion,
  price,
  days = 21,
}: {
  today: string;
  balance: number;
  recurring: Recurring[];
  scheduled?: ScheduledEvent[];
  goals: Goal[];
  discretionaryPerDay: number;
  cushion: number;
  price: number;
  days?: number;
}) {
  const payday = nextPayday(recurring, today, scheduled);
  const window = payday ? Math.max(days, daysBetween(today, payday) + 7) : Math.max(days, 30);
  const base = { today, balance, days: window, recurring, scheduled, goals, discretionaryPerDay };
  const baseline = lowest(buildForecast(base));
  const nowF = buildForecast({ ...base, extra: [{ date: today, amount: -price }] });
  const lowNow = lowest(nowF);
  const todayOk = lowNow.balance >= cushion;

  let wait: {
    lowest: number;
    lowestDate: string;
    forecast: ForecastDay[];
    fine: boolean;
    copy: { headline: string; body: string };
  } | null = null;
  if (payday) {
    const laterF = buildForecast({ ...base, extra: [{ date: payday, amount: -price }] });
    const lowLater = lowest(laterF);
    const fine = lowLater.balance >= Math.min(cushion, baseline.balance) && lowLater.balance >= 0;
    wait = {
      lowest: lowLater.balance,
      lowestDate: lowLater.date,
      forecast: laterF,
      fine,
      copy: fine
        ? { headline: "Yes — wait for payday.", body: `Buy it on ${shortDate(payday)} and nothing else has to give.` }
        : lowLater.balance >= 0
          ? { headline: "Even after payday, it pinches.", body: `You'd drop to ${money0(lowLater.balance)} on ${shortDate(lowLater.date)}.` }
          : { headline: "Not this pay period.", body: `Even after payday you'd hit ${money0(lowLater.balance)} on ${shortDate(lowLater.date)}.` },
    };
  }
  return {
    payday,
    baselineLowest: baseline.balance,
    buyToday: {
      lowest: lowNow.balance,
      lowestDate: lowNow.date,
      forecast: nowF,
      fine: todayOk,
      copy: todayOk
        ? {
            headline: "Yes, you can.",
            body: payday ? "You stay above your cushion all the way to payday." : "You stay above your cushion for the next month.",
          }
        : {
            headline: `You'd hit ${money0(lowNow.balance)} on ${shortDate(lowNow.date)}.`,
            body:
              lowNow.balance > 0
                ? "Buying today takes you under your cushion."
                : !payday
                  ? "Buying today drains your account."
                  : lowNow.date === addDays(payday, -1)
                    ? "Buying today drains you the day before payday."
                    : "Buying today drains you before payday.",
          },
    },
    waitForPayday: wait,
    recommended: (todayOk ? "today" : wait?.fine ? "wait" : "neither") as "today" | "wait" | "neither",
  };
}

// ---------- formatting ----------
const round2 = (n: number) => Math.round(n * 100) / 100;
export const MINUS = "−";
/** Whole dollars, typographic minus, never "−$0". */
export function money0(n: number, locale = "en-US", currency = "USD"): string {
  let v = Math.round(n);
  if (Object.is(v, -0)) v = 0;
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(v).replace("-", MINUS);
}
/** Dollars and cents, typographic minus, never "−$0.00". */
export function money2(n: number, locale = "en-US", currency = "USD"): string {
  let v = Math.round(n * 100) / 100;
  if (Object.is(v, -0) || v === 0) v = 0;
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(v)
    .replace("-", MINUS);
}
/** Split for the hero number: { sign, symbol, whole, cents } e.g. 1830.42 -> { '', '$', '1,830', '.42' } */
export function heroParts(n: number, locale = "en-US", currency = "USD") {
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(Math.abs(n));
  const pick = (t: string[]) =>
    parts
      .filter((p) => t.includes(p.type))
      .map((p) => p.value)
      .join("");
  return { sign: n < 0 ? MINUS : "", symbol: pick(["currency"]), whole: pick(["integer", "group"]), cents: pick(["decimal", "fraction"]) };
}
export const shortDate = (d: string | null | undefined) =>
  d ? new Date(toUTC(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
export const weekday = (d: string) => new Date(toUTC(d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
/** "Wed, Oct 28" — the row date format. */
export const rowDate = (d: string) =>
  new Date(toUTC(d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** "Friday, Oct 23" — the Activity group heading (year added when it isn't this year). */
export const longDate = (d: string, thisYear: number) => {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" };
  if (Number(d.slice(0, 4)) !== thisYear) opts.year = "numeric";
  return new Date(toUTC(d)).toLocaleDateString("en-US", opts);
};
/** ETA: "Jan 29" within 12 months, otherwise "Aug 2027". */
export const etaDate = (d: string, today: string) =>
  daysBetween(today, d) <= 365
    ? shortDate(d)
    : new Date(toUTC(d)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
