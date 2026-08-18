// Formatting + small date helpers used across the app.

export function formatMoney(n: number, opts: { sign?: boolean } = {}): string {
  const str = Math.abs(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (opts.sign) return (n < 0 ? "−" : "+") + str;
  return (n < 0 ? "−" : "") + str;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Today's calendar date in the USER'S timezone, "YYYY-MM-DD".
 *
 * This used to be `new Date().toISOString().slice(0, 10)`, which is UTC. The
 * household is in Arizona (UTC-7, no DST), so from 5pm local onward UTC has
 * already rolled over and every entry was stamped with TOMORROW's date: an
 * evening purchase on the 31st filed into next month's budget, and one made on
 * the last evening of a pay cycle fell outside the cycle it belonged to. Every
 * window that READS these dates is local — plan.ts's payCycleFor emits local
 * ISO dates, buildVMs' monthKeyOf reads local month — so the stamp has to be
 * local too or the two never line up. Same conversion as mealLog.ts's
 * todayStr(), spelled with getFullYear/getMonth/getDate to match plan.ts's
 * internal `iso()` helper exactly.
 */
export function todayISO(): string {
  return isoDate(new Date());
}

/**
 * Any Date as its LOCAL calendar date, "YYYY-MM-DD". The one place this
 * conversion is written.
 *
 * It earned its own export because the repo had grown FOUR independent spellings
 * of it — this one, plan.ts's internal `iso()`, mealLog.ts's `todayStr()` (via
 * getTimezoneOffset) and an inline copy in BillsSheet.tsx. All four agree today,
 * which is precisely why the divergence was invisible: `toISOString().slice(0,10)`
 * is a fifth spelling that LOOKS like the others and is silently UTC, and that is
 * how the evening-entry bug got in. One function means the next person cannot
 * accidentally pick the wrong one.
 */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** This month's "YYYY-MM" key, LOCAL — carried the identical UTC bug. */
export function currentMonthKey(): string {
  return monthKeyOf(new Date());
}

/** Any Date as its LOCAL "YYYY-MM" month key. The one place this is written —
 *  the month key decides which month a charge is budgeted in, so a UTC spelling
 *  here moves an evening purchase on the last of the month into the next one. */
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** "June 2026" for a "YYYY-MM" key. */
export function monthLabel(key: string): string {
  const d = new Date(key + "-01T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** "Mon, Jun 9" style label for a row. */
export function formatDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
