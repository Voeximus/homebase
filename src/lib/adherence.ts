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

function minusDays(date: string, d: number): string {
  const dt = new Date(date + "T00:00:00");
  dt.setDate(dt.getDate() - d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
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
