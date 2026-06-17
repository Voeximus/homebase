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

/** Compact form for big hero numbers, e.g. 12345 -> "$12.3k". */
export function formatMoneyShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1000) {
    return `${sign}$${(abs / 1000).toLocaleString("en-US", {
      maximumFractionDigits: 1,
    })}k`;
  }
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "YYYY-MM" for a given ISO date. */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

/** "June 2026" for a "YYYY-MM" key. */
export function monthLabel(key: string): string {
  const d = new Date(key + "-01T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Step a "YYYY-MM" key forward/back by n months. */
export function shiftMonth(key: string, delta: number): string {
  const d = new Date(key + "-01T00:00:00");
  d.setMonth(d.getMonth() + delta);
  return d.toISOString().slice(0, 7);
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

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
