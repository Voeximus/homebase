// ── Body-weight log + automatic trend math ───────────────────────────────────
// The user logs ONE number a day; the app does all the averaging + trend. No
// "weeks on plan", no manual calibration. Weekly averages are Monday-start
// calendar weeks; the trend rate is a least-squares slope (robust to daily
// noise) in lb/week. Pure.

export type Person = "gino" | "xinyan";

export interface BodyWeight {
  person: Person;
  date: string; // YYYY-MM-DD (local)
  weight: number;
}

const parseDate = (d: string) => new Date(d + "T00:00:00").getTime();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The Monday that starts the week containing `date` (local). */
export function weekStartOf(date: string): string {
  const d = new Date(date + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // days since Monday
  d.setDate(d.getDate() - dow);
  return ymd(d);
}

export interface WeekAvg {
  week: string; // Monday YYYY-MM-DD
  avg: number;
  count: number;
}

/** Average weight per Monday-start week, oldest → newest. */
export function weeklyAverages(entries: BodyWeight[]): WeekAvg[] {
  const by = new Map<string, number[]>();
  for (const e of entries) {
    const w = weekStartOf(e.date);
    const arr = by.get(w);
    if (arr) arr.push(e.weight);
    else by.set(w, [e.weight]);
  }
  return [...by.entries()]
    .map(([week, ws]) => ({ week, avg: ws.reduce((a, b) => a + b, 0) / ws.length, count: ws.length }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/** The running average for the week that contains `today` (the "end-of-week average"). */
export function currentWeekAvg(entries: BodyWeight[], today: string): { avg: number; count: number } | null {
  const wk = weekStartOf(today);
  const ws = entries.filter((e) => weekStartOf(e.date) === wk).map((e) => e.weight);
  if (!ws.length) return null;
  return { avg: ws.reduce((a, b) => a + b, 0) / ws.length, count: ws.length };
}

/** Least-squares trend in lb/week (negative = losing). null if too little data. */
export function ratePerWeek(entries: BodyWeight[]): number | null {
  if (entries.length < 2) return null;
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const x0 = parseDate(sorted[0].date);
  const xs = sorted.map((e) => (parseDate(e.date) - x0) / 86400000);
  const ys = sorted.map((e) => e.weight);
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all on one day → no slope
  return ((n * sxy - sx * sy) / denom) * 7;
}

/** Number of distinct calendar weeks with at least one entry. */
export function weeksTracked(entries: BodyWeight[]): number {
  return new Set(entries.map((e) => weekStartOf(e.date))).size;
}

export function latestWeight(entries: BodyWeight[]): number | null {
  if (!entries.length) return null;
  return [...entries].sort((a, b) => b.date.localeCompare(a.date))[0].weight;
}
