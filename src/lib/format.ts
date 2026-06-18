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

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
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
