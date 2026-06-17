import type { Account, Recurring } from "../types";
import { CADENCE_TO_MONTHLY } from "./household";
import type { Cadence } from "../types";

/** A recurring item's amount normalized to a monthly figure. */
export function monthlyAmount(r: Recurring): number {
  return r.amount * (CADENCE_TO_MONTHLY[r.cadence] ?? 1);
}

const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "/wk",
  biweekly: "/2wks",
  semimonthly: "×2/mo",
  monthly: "/mo",
  yearly: "/yr",
};
export function cadenceLabel(c: Cadence): string {
  return CADENCE_LABEL[c] ?? "/mo";
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
): AccountFlow {
  let inflow = 0;
  let outflow = 0;
  for (const r of recurring) {
    if (!r.active) continue;
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

/** The recurring items that touch an account (as source or transfer destination). */
export function accountItems(
  accountId: string,
  recurring: Recurring[],
): Recurring[] {
  return recurring.filter(
    (r) => r.accountId === accountId || r.toAccountId === accountId,
  );
}

/** Household-wide monthly income vs bills (transfers excluded — they're internal). */
export function householdMonthly(recurring: Recurring[]): {
  income: number;
  bills: number;
  net: number;
} {
  let income = 0;
  let bills = 0;
  for (const r of recurring) {
    if (!r.active || r.direction === "transfer") continue;
    const m = monthlyAmount(r);
    if (r.direction === "in") income += m;
    else bills += m;
  }
  return { income, bills, net: income - bills };
}

export function totalBalance(accounts: Account[]): number {
  return accounts.reduce((s, a) => s + a.balance, 0);
}
