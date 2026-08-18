import type { Account, Recurring } from "../types";
import { CADENCE_TO_MONTHLY } from "./household";
import { todayISO } from "./format";

/** A recurring item's amount normalized to a monthly figure. */
export function monthlyAmount(r: Recurring): number {
  return r.amount * (CADENCE_TO_MONTHLY[r.cadence] ?? 1);
}

/** Is this row inside its lifetime on `isoDate`? The window columns (schema_v27)
 *  were enforced on the CALENDAR path only — schedule.ts inWindow(), which the
 *  Bills screen and the Forecast tab both inherit — and nowhere on the PLAN path.
 *  So a bill that cannot fire this month was still charged against firepower:
 *  in August 2026 the two car lines, the second insurance term and Mom's paused
 *  support added $1,163.92 to "fixed", and Home's "available at debt" tile read
 *  about $1,000 below what the Forecast tab showed for the same month. The
 *  mirror case is quieter and runs forever: a row whose ends_on has passed keeps
 *  eating firepower with nothing on the calendar to explain it.
 *
 *  NOTE this is all-or-nothing on a single date, while the calendar PRORATES a
 *  boundary month (it divides by the full due-day count, then drops the days
 *  outside the window). So in the month a bill starts or stops partway, the plan
 *  and the calendar still differ by the surviving fraction. Closing that would
 *  mean giving the plan path a real per-month schedule rather than a monthly
 *  average, which is a larger change than this. */
export function liveOn(r: Recurring, isoDate: string): boolean {
  if (r.startsOn && isoDate < r.startsOn) return false;
  if (r.endsOn && isoDate > r.endsOn) return false;
  return true;
}

export interface AccountFlow {
  inflow: number; // income + transfers in
  outflow: number; // bills + transfers out
  net: number;
}

/** Monthly money in/out for a single account, including transfers either way. */
export function accountFlow(
  accountId: string,
  recurring: Recurring[],
  isoDate: string = todayISO(),
): AccountFlow {
  let inflow = 0;
  let outflow = 0;
  for (const r of recurring) {
    if (!r.active || !liveOn(r, isoDate)) continue;
    const m = monthlyAmount(r);
    if (r.direction === "in" && r.accountId === accountId) inflow += m;
    else if (r.direction === "out" && r.accountId === accountId) outflow += m;
    else if (r.direction === "transfer") {
      if (r.accountId === accountId) outflow += m; // leaves this account
      if (r.toAccountId === accountId) inflow += m; // arrives in this account
    }
  }
  return { inflow, outflow, net: inflow - outflow };
}

/** Household-wide monthly income vs bills (transfers excluded — they're internal).
 *  Honors each row's lifetime window on `isoDate`, so a bill that cannot fire is
 *  not charged against the household's month. See liveOn(). */
export function householdMonthly(
  recurring: Recurring[],
  isoDate: string = todayISO(),
): {
  income: number;
  bills: number;
  net: number;
} {
  let income = 0;
  let bills = 0;
  for (const r of recurring) {
    if (!r.active || r.direction === "transfer" || !liveOn(r, isoDate)) continue;
    const m = monthlyAmount(r);
    if (r.direction === "in") income += m;
    else bills += m;
  }
  return { income, bills, net: income - bills };
}

/** A credit card is debt, not an account that holds cash. */
export const isCreditAccount = (a: Account): boolean => /credit/i.test(a.type);

/** Only the accounts that actually hold money (cards filtered out). */
export const cashAccounts = (accounts: Account[]): Account[] =>
  accounts.filter((a) => !isCreditAccount(a));

export function totalBalance(accounts: Account[]): number {
  // Credit cards are debt, not cash — keep them out of the cash total.
  return cashAccounts(accounts).reduce((s, a) => s + a.balance, 0);
}

/** Total "still processing" hold across the cash accounts — the bank's
 *  current−available gap (pending debits not yet itemized to us). Display-only;
 *  the cash balance is already net of it. */
export function totalPendingHold(accounts: Account[]): number {
  return cashAccounts(accounts).reduce((s, a) => s + (a.pendingHold ?? 0), 0);
}
