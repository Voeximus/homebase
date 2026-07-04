// ── Macro-plan adherence ─────────────────────────────────────────────────────
// Derives a per-day status from the meal log, then the streak + compliance % +
// a recent strip for the history. A day only counts as "logged" (adhered) when
// the logged intake meaningfully covers the day's target — logging a single
// banana shouldn't mark the day as followed. A logged-but-light day is "partial".
// The 8 PM nudge marks empty days as "estimated" (followed, rough) or "skipped".

import { dayTotals, type DayLog, type Macros, type Person } from "./mealLog";

export type DayStatus = "logged" | "partial" | "estimated" | "skipped" | "none";

// A day with meals counts as adhered once intake reaches this fraction of the
// kcal target — enough that it represents a real day of eating, not one snack.
export const ADHERE_PCT = 0.7;

export function dayStatusOf(day: DayLog | undefined, target?: Macros): DayStatus {
  if (!day) return "none";
  // real logged food: adhered only if it meaningfully covers the day's target;
  // otherwise it's a "partial" day (logged something, not a full day's plan).
  if (day.meals.length > 0) {
    if (target && target.kcal > 0) {
      return dayTotals(day).kcal >= target.kcal * ADHERE_PCT ? "logged" : "partial";
    }
    return "logged";
  }
  // no meals → an explicit nudge answer wins (off-plan, or estimated-followed)
  if (day.status === "skipped") return "skipped";
  if (day.status === "estimated") return "estimated";
  return "none";
}
export const isFollowed = (s: DayStatus) => s === "logged" || s === "estimated";

function fmtLocal(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function minusDays(date: string, d: number): string {
  const dt = new Date(date + "T00:00:00");
  dt.setDate(dt.getDate() - d);
  return fmtLocal(dt);
}
/** Shift an ISO date by n days (n may be negative). */
function shiftDays(date: string, n: number): string {
  const dt = new Date(date + "T00:00:00");
  dt.setDate(dt.getDate() + n);
  return fmtLocal(dt);
}
/** The Monday (week start) on/before a date. Weeks run Monday→Sunday. */
function mondayOf(date: string): string {
  const dt = new Date(date + "T00:00:00");
  const back = (dt.getDay() + 6) % 7; // 0=Sun → 6, 1=Mon → 0, …
  dt.setDate(dt.getDate() - back);
  return fmtLocal(dt);
}

export interface AdherenceStats {
  streak: number;
  followed: number;
  missed: number;
  compliancePct: number | null; // null = nothing tracked yet
  recent: { date: string; status: DayStatus }[]; // oldest → newest
}

export function adherenceStats(
  byDate: Map<string, DayLog>, // key = `${person}|${date}`
  person: Person,
  today: string,
  target?: Macros,
  rangeDays = 30,
  recentDays = 14,
): AdherenceStats {
  const statusFn = (date: string) => dayStatusOf(byDate.get(`${person}|${date}`), target);

  // streak — consecutive adhered days back from the latest DECIDED day. Today's
  // "none" (day not over) AND today's "partial" (still mid-day, not yet at goal)
  // are forgiven: neither counts nor breaks. A PAST partial/skipped/none breaks.
  let streak = 0;
  for (let d = 0; d < 400; d++) {
    const s = statusFn(minusDays(today, d));
    if (d === 0 && (s === "none" || s === "partial")) continue;
    if (isFollowed(s)) streak++;
    else break;
  }

  // compliance compares clearly-followed days against clearly-off (skipped) days.
  // "partial" + "none" are neutral — not yet a real follow, but not a real miss.
  let followed = 0;
  let missed = 0;
  for (let d = 0; d < rangeDays; d++) {
    const s = statusFn(minusDays(today, d));
    if (isFollowed(s)) followed++;
    else if (s === "skipped") missed++;
  }
  const tracked = followed + missed;
  const compliancePct = tracked > 0 ? Math.round((followed / tracked) * 100) : null;

  const recent: { date: string; status: DayStatus }[] = [];
  for (let d = recentDays - 1; d >= 0; d--) {
    const date = minusDays(today, d);
    recent.push({ date, status: statusFn(date) });
  }
  return { streak, followed, missed, compliancePct, recent };
}

// ── weekly view ──────────────────────────────────────────────────────────────
// Adherence people actually feel is WEEKLY — a fresh start every Monday, not a
// rolling 30-day blur. weeklyAdherence buckets the log into Mon→Sun weeks so the
// card can show "this week resets, and here's how the past weeks went".
export interface WeekDay {
  date: string;
  status: DayStatus;
  future: boolean; // later this week — not yet decided, shown blank
}
export interface WeekBucket {
  startDate: string; // the Monday
  isCurrent: boolean;
  days: WeekDay[]; // exactly 7, Mon→Sun
  followed: number; // clearly-followed days
  skipped: number; // days explicitly marked off-plan
  elapsed: number; // days up to & including today (7 for a past week)
  pct: number | null; // followed / elapsed — an unlogged day counts AGAINST you,
  // not as a free pass. null only before the week has begun (0 elapsed).
}

export function weeklyAdherence(
  byDate: Map<string, DayLog>,
  person: Person,
  today: string,
  target?: Macros,
  weeks = 6, // current week + the 5 before it
): WeekBucket[] {
  const statusFn = (date: string) => dayStatusOf(byDate.get(`${person}|${date}`), target);
  const curMonday = mondayOf(today);
  const out: WeekBucket[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = shiftDays(curMonday, -7 * w);
    const days: WeekDay[] = [];
    let followed = 0;
    let skipped = 0;
    let elapsed = 0;
    for (let d = 0; d < 7; d++) {
      const date = shiftDays(start, d);
      const future = date > today;
      const status = future ? "none" : statusFn(date);
      if (!future) {
        elapsed++;
        if (isFollowed(status)) followed++;
        else if (status === "skipped") skipped++;
      }
      days.push({ date, status, future });
    }
    out.push({
      startDate: start,
      isCurrent: w === 0,
      days,
      followed,
      skipped,
      elapsed,
      // fraction of the week's DAYS you followed the plan — unlogged days pull it
      // down (they're not "on plan"). A week with 1 logged day now reads ~14%, not 100%.
      pct: elapsed > 0 ? Math.round((followed / elapsed) * 100) : null,
    });
  }
  return out;
}
