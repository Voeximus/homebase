// ── Macro-plan adherence ─────────────────────────────────────────────────────
// Derives a per-day status from the meal log, then the streak + compliance % +
// a recent strip for the history. A day with logged meals is "followed"; the
// 8 PM nudge marks empty days as "estimated" (followed, rough) or "skipped".

import type { DayLog, Person } from "./mealLog";

export type DayStatus = "logged" | "estimated" | "skipped" | "none";

export function dayStatusOf(day: DayLog | undefined): DayStatus {
  if (!day) return "none";
  // real logged food wins over any earlier nudge answer (if you marked "off-plan"
  // then actually logged a meal, the day is followed).
  if (day.meals.length > 0) return "logged";
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
  rangeDays = 30,
  recentDays = 14,
): AdherenceStats {
  const statusFn = (date: string) => dayStatusOf(byDate.get(`${person}|${date}`));

  // streak — consecutive followed days back from the latest DECIDED day. Today's
  // "none" (the day isn't over) is skipped: it neither counts nor breaks.
  let streak = 0;
  for (let d = 0; d < 400; d++) {
    const s = statusFn(minusDays(today, d));
    if (d === 0 && s === "none") continue;
    if (isFollowed(s)) streak++;
    else break;
  }

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
