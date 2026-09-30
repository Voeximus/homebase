// What does this household actually net in a month?
//
// THE QUESTION THAT KEPT GETTING ANSWERED WRONG. Three different figures were given
// for it in one conversation — a "$780/month deficit", then "roughly break-even", then
// "+$400" — and every one came from summing `transactions` a slightly different way.
// None of the three was a calculation error. They were all correct sums of the wrong
// rows.
//
// So this module does not decide what a row means. flow.ts does that, one row at a
// time, with a reason attached; this only adds up the rows that move the household's
// net worth and SHOWS every row it left out.
//
// FOUR RULES, EACH FROM A SPECIFIC FAILURE:
//
//   1. WHOLE MONTHS ONLY. A partial month has a full month's rent and half a month's
//      income, so it always looks like a disaster. September was mid-flight when it
//      was first quoted as evidence.
//
//   2. TRANSFERS AND DEBT PAYMENTS ARE NOT SPENDING. Both cards are synced, so a card
//      payment appears twice — leaving checking and arriving at the card. One $2,500
//      payment inflated a month's income AND its spending by $2,500 at once.
//
//   3. ONE-OFFS ARE SEPARATED, NOT DELETED. A $1,250 car down payment made an ordinary
//      August look like a $1,225 loss. It is shown both ways — with and without — and
//      never silently dropped, because "excluding what I decided was unusual" is how a
//      model flatters itself.
//
//   4. NOTHING IS HIDDEN. Every excluded row is returned with its amount, its
//      description and the rule that excluded it. If the answer is wrong, the wrong
//      line is visible rather than buried in a total.

import type { Account, Transaction } from "../types";
import { classify, COUNTS_TOWARD_NET, type Flow } from "./flow";

/** A charge at or above this, from a merchant seen in only ONE of the months in the
 *  window, is called a one-off and reported separately.
 *
 *  WHY A SIZE FLOOR AS WELL AS RARITY. Without it, every restaurant visited once in
 *  three months becomes "unusual" and the exclusion list is hundreds of lines of
 *  ordinary life — which is worse than no list, because nobody reads it. $500 is
 *  roughly a third of one of this household's paychecks: big enough that a single one
 *  visibly bends a month, which is exactly the thing that needs pulling out. */
export const ONE_OFF_FLOOR = 500;

export interface MonthRate {
  /** "2026-08" */
  month: string;
  earned: number;
  spent: number;
  /** earned − spent, with every one-off still inside it. What the household is WORTH
   *  changed by — paying a card down does not appear here, because it does not make
   *  anyone poorer. */
  net: number;
  /** What actually moved in and out of the CHECKING accounts.
   *
   *  THE SECOND TRUE ANSWER, and the reason both are here. `net` says the household
   *  gained $1,560 in an average month; the checking accounts say $277. Neither is
   *  wrong — a card payment leaves cash and cancels debt, so it belongs in one and not
   *  the other. Reporting either one alone, under the name "what we net", is how the
   *  same question got three different answers. */
  cashChange: number;
  /** The same, with one-offs taken out — what an ordinary month of this shape looks like. */
  netOngoing: number;
  oneOffs: ExcludedRow[];
  /** Whole months only; false means the window cut this month short. */
  whole: boolean;
}

export interface ExcludedRow {
  date: string;
  amount: number;
  description: string;
  /** The rule that excluded it, in plain words. */
  why: string;
}

export interface RunRate {
  months: MonthRate[];
  /** The average of `netOngoing` across whole months — how fast the household's net
   *  worth grows, with one-offs taken out. */
  perMonth: number | null;
  /** The average monthly change in the checking accounts. The one a bank statement
   *  can be checked against, and the one that answers "is there more in there". */
  cashPerMonth: number | null;
  monthsCounted: number;
  /** Everything left out of the sums, so the answer can be checked rather than believed. */
  excluded: { flow: Flow; rows: ExcludedRow[]; total: number }[];
}

const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * What counts as "the same merchant" across months.
 *
 * DIGITS STRIPPED, and this was not foreseen — the first live run of this module
 * reported RENT as a one-off, twice. The bank writes a fresh reference into every
 * descriptor ("Nollie MA DES:Rent ID:XXXXX7762", then "ID:XXXXX6948"), so the most
 * reliably recurring charge in the household looked like a new merchant every month
 * and $1,732 was pulled out of two months as unusual.
 *
 * It was visible in two seconds because the reply lists what it excluded. That is the
 * argument for the design, made by the design.
 */
const merchantKey = (description: string | undefined): string =>
  (description ?? "")
    .toLowerCase()
    .replace(/\d+/g, " ")
    .replace(/conf#?|id:?|indn:?|des:?|x+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The month before `todayISO`'s, and every month is whole up to and including it. */
function lastWholeMonth(todayISO: string): string {
  const y = Number(todayISO.slice(0, 4));
  const m = Number(todayISO.slice(5, 7));
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}`;
}

/**
 * @param todayISO the Arizona calendar date, passed in — this module reads no clock,
 *   like every other module the doors import.
 */
export function runRate(
  txns: readonly Transaction[],
  accounts: readonly Account[],
  todayISO: string,
): RunRate {
  const classified = classify(txns, accounts);
  const cutoff = lastWholeMonth(todayISO);
  // Cash is measured by ACCOUNT, not by flow. A checking balance does not care what a
  // row meant — every dollar that left is gone from it, including the ones that went
  // to a card. This is the one figure in the module that ignores the classification
  // entirely, and it is here to be checked against a bank statement.
  const cashIds = new Set(accounts.filter((a) => a.type === "checking").map((a) => a.id));

  // Which merchants appear in more than one month — the test for "ordinary", taken
  // from the household's own history rather than from a judgement about what a
  // merchant is. The same reasoning that settled Safeway: the data already answered.
  const monthsByMerchant = new Map<string, Set<string>>();
  for (const { txn, verdict } of classified) {
    if (verdict.flow !== "spent") continue;
    const key = merchantKey(txn.description);
    if (!key) continue;
    if (!monthsByMerchant.has(key)) monthsByMerchant.set(key, new Set());
    monthsByMerchant.get(key)!.add(monthOf(txn.date));
  }

  const byMonth = new Map<string, MonthRate>();
  const excludedByFlow = new Map<Flow, ExcludedRow[]>();

  for (const { txn, verdict } of classified) {
    const month = monthOf(txn.date);
    if (month > cutoff) continue; // the current month is not whole yet

    if (cashIds.has(txn.accountId ?? "")) {
      let cashRow = byMonth.get(month);
      if (!cashRow) {
        cashRow = { month, earned: 0, spent: 0, net: 0, cashChange: 0, netOngoing: 0, oneOffs: [], whole: true };
        byMonth.set(month, cashRow);
      }
      cashRow.cashChange += txn.type === "income" ? txn.amount : -txn.amount;
    }

    if (!COUNTS_TOWARD_NET[verdict.flow]) {
      const list = excludedByFlow.get(verdict.flow) ?? [];
      list.push({ date: txn.date, amount: round2(txn.amount), description: txn.description ?? "", why: verdict.why });
      excludedByFlow.set(verdict.flow, list);
      continue;
    }

    let row = byMonth.get(month);
    if (!row) {
      row = { month, earned: 0, spent: 0, net: 0, cashChange: 0, netOngoing: 0, oneOffs: [], whole: true };
      byMonth.set(month, row);
    }

    if (verdict.flow === "earned") {
      row.earned += txn.amount;
      continue;
    }

    row.spent += txn.amount;
    const key = merchantKey(txn.description);
    const seenInMonths = monthsByMerchant.get(key)?.size ?? 0;
    // A BILL IS NEVER A ONE-OFF, whatever its descriptor looks like. The household
    // has already said this charge is a recurring obligation by linking it to one;
    // no amount of reference-number noise should be able to overrule that.
    const isBill = ((txn.appliesTo ?? null) as { kind?: string } | null)?.kind === "bill";
    if (!isBill && txn.amount >= ONE_OFF_FLOOR && seenInMonths <= 1) {
      row.oneOffs.push({
        date: txn.date,
        amount: round2(txn.amount),
        description: txn.description ?? "",
        why: `$${round2(txn.amount).toLocaleString()} to a merchant that appears in only one month of this window`,
      });
    }
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const m of months) {
    m.earned = round2(m.earned);
    m.spent = round2(m.spent);
    m.net = round2(m.earned - m.spent);
    m.cashChange = round2(m.cashChange);
    m.netOngoing = round2(m.net + m.oneOffs.reduce((s, o) => s + o.amount, 0));
  }

  // The rate is the average of the ONGOING figure, because a rate is what repeats.
  // Quoting the raw average would put a car down payment into every future month.
  const perMonth = months.length ? round2(months.reduce((s, m) => s + m.netOngoing, 0) / months.length) : null;

  const excluded = [...excludedByFlow.entries()].map(([flow, rows]) => ({
    flow,
    rows: rows.sort((a, b) => b.amount - a.amount),
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
  }));

  const cashPerMonth = months.length
    ? round2(months.reduce((s, m) => s + m.cashChange, 0) / months.length)
    : null;

  return { months, perMonth, cashPerMonth, monthsCounted: months.length, excluded };
}
