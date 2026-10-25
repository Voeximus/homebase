// finance.add_history_row — the parts that decide, kept apart from the part that writes.
//
// WHAT THE TOOL IS FOR, 2026-10-10. Reconciling the three bank statements line by line
// against the ledger found real bank rows the ledger did not have — one of them a Zelle
// the categorizer had been told to skip. Fixing the categorizer stops the next one going
// missing; it cannot bring back the ones that already did, because the bank feed only
// ever re-sends rows that changed at the bank. So the door needs a way to write ONE row
// a statement shows and the ledger is missing.
//
// THE ONE PROPERTY IT MUST HAVE: IT MOVES NO BALANCE. The money on that statement line
// left (or arrived) weeks ago, and it is already inside the balance the bank reports and
// the app anchors to. finance.add_transaction is the wrong tool for that — it goes down
// apply_money_event, which subtracts the amount from the account, so a missing $40 row
// added that way would make the account read $40 poorer than the bank says it is.
//
// The app already has exactly this kind of row: the statement import (ImportSheet →
// FinanceStore.commitImport) writes every line it takes as `record_only`, "a record of
// money that moved outside the app, already inside the anchored balance". This tool
// writes the same row, with the same column choices, one at a time:
//
//   date, amount (positive), type, category_id, description   — the statement line
//   account_id     — the account the statement is for (display + per-person activity)
//   applies_to     — null: a loose row settles no bill (attach one afterwards with
//                    finance.link_charge_to_bill, which has the cycle guard)
//   record_only    — TRUE, so deleting it never credits the account
//                    (schema_v28_record_only.sql; reverse_money_event reads it)
//   provider       — not written, so null: it did not come from the bank feed, and the
//                    door must never pretend a row did
//   raw_description — not written: no tool on either door touches that column
//
// What happens to such a row downstream, checked when this was written:
//   · it COUNTS as spending — src/lib/plan.ts spentByCategoryBetween gates on
//     `type`, the date window, `!appliesTo` and the household-transfer pairing, and
//     never on record_only;
//   · it moves NO balance and NO debt — it is inserted directly rather than through
//     apply_money_event; reverse_money_event (and the app's own delete, and the
//     door's delete_charge, which refuses it outright) skip cash for record_only; and a
//     debt only ever moves for a row whose applies_to names it;
//   · the bank sync's duplicate guard SEES it — a posted record_only row with no
//     provider id is armed there as a STATEMENT COPY (supabase/functions/_shared/
//     dedupGuard.ts), so if the bank later delivers the same charge — on the same date
//     or up to three days off, in the feed's clean wording or the statement's — the
//     bank's copy is absorbed instead of doubling the money. (Until a review later the
//     same day, that guard matched the exact date and merchant key only, while this
//     tool's own duplicate check looked three days either side and stripped the
//     statement's noise: a row this tool accepted could be invisible to the sync, and
//     a cursor reset or a re-link would have put it in twice. Both now use one rule,
//     _shared/sameCharge.ts.)
//
// Pure: no database, no clock (the Arizona instant arrives in the ShapeCtx), and no
// import from toolsFinance.ts — that file imports THIS one, and the registry is built at
// module load, so a cycle here would be a door that does not start.

import { problemPad, refuse, UUID, type Refusal, type ShapeCtx, type Shaped } from "./kit.ts";
import { azDateISO, daysBetweenISO, isDateISO } from "../_shared/muse/az.ts";
import { scrubCap } from "../_shared/muse/scrub.ts";
import {
  classify,
  classifyCredit,
  creditCategory,
  merchantKey,
  stripStatementNoise,
  type LearnedRules,
} from "../_shared/muse/lib/categorize.ts";
import { DEFAULT_CATEGORIES } from "../_shared/muse/lib/seed.ts";
import { addDaysISO } from "../_shared/muse/lib/format.ts";
import { SAME_CHARGE_DAYS, sameMerchant } from "../_shared/sameCharge.ts";
import { CLOSED_DEBT_FILING, closedDebtPayment, closedTrackedDebts } from "../_shared/trackedDebts.ts";

/** How far back a statement row may be dated. 24 months is as far as the bank feed
 *  itself ever reaches back on a first sync, so nothing older can be "missing" from a
 *  ledger the feed built — anything older is a typo far more often than a find. */
export const HISTORY_BACK_MONTHS = 24;

/** Either side of the row's date the duplicate guard looks. A statement's posting date
 *  and the feed's date for the same charge can differ by a day or two around a weekend,
 *  so an exact-date match would miss the very duplicate this exists to catch. The SAME
 *  number the bank sync's guard uses for a statement copy (sameCharge.ts), so a row this
 *  tool calls new is a row the sync will recognise if the bank delivers it later. */
export const DUPLICATE_WINDOW_DAYS = SAME_CHARGE_DAYS;

/** Longer than add_transaction's 40, because a statement line's merchant text is longer
 *  than a word or two of a cash note — "Zelle payment to <a full name> Conf# …" runs
 *  past 40 — and merchantKey() reads the first 28 characters after its own trimming, so
 *  a short cap would cut the very text the key and the duplicate guard compare. */
export const HISTORY_DESCRIPTION_CAP = 60;

const CATEGORY_TYPE = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.type]));

/** The earliest date a history row may carry, given Arizona's today: the same calendar
 *  day 24 months back (a 29 February with no 29 February two years earlier becomes the
 *  28th). Months, not a count of days, because "the last 24 months" is a calendar
 *  statement and a day count drifts by a day every leap year. */
export function earliestHistoryDate(today: string): string {
  const back: string = `${Number(today.slice(0, 4)) - HISTORY_BACK_MONTHS / 12}${today.slice(4)}`;
  // isDateISO is a type guard, so its false branch would narrow `back` to `never`;
  // asked as a plain yes/no, the 29 February fallback keeps its type.
  const real: boolean = isDateISO(back);
  return real ? back : `${back.slice(0, 8)}28`;
}

/** Dollars and cents, as a bank prints them: above zero, at most two decimals, and not
 *  absurd. A third decimal is a sign the figure was computed rather than read off the
 *  statement, and the duplicate guard compares to the cent. */
function centsArg(v: unknown): number | Refusal {
  const say = "I need the amount as dollars and cents above zero, exactly as the statement prints it — 18.40, not -18.40.";
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100_000) return refuse(400, say);
  if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) return refuse(400, say);
  return v;
}

export interface HistoryPlan {
  accountId: string;
  date: string;
  amount: number;
  type: "expense" | "income";
  description: string;
  /** The category the caller named, or null to let the app's own classifier decide. */
  categoryId: string | null;
  /** The caller has seen the likely duplicate and says the statement really shows two. */
  confirmed: boolean;
  /** Which of the app's own refusals he has told the caller to override, or null. */
  override: HistoryOverride | null;
}

/**
 * The two refusals a person can override, by name. ADDED 2026-10-10 after a review.
 *
 * The first version let ANY named category straight past the app's own judgement: a
 * category_id skipped classify() entirely, so a transfer between their own accounts,
 * sent with category "other", was written as a $40 expense — and its other leg is
 * dropped by the feed, so nothing would ever pair with it and cancel it. Spending went
 * up by money the household still had. Statement reconciliation is exactly the job
 * that turns up every own-account transfer as "missing from the ledger", because the
 * app leaves those out on purpose — so that was not a corner case, it was the main road.
 *
 * Now the app's judgement always runs, and getting past it takes the override that
 * names what is being overridden. A name rather than `true`, so an override sent for
 * one reason cannot carry a row past a different one, and so the reply can say exactly
 * what was overridden. `confirm` stays the duplicate's own answer and overrides nothing
 * here.
 *   kept_out     — the app keeps this row out of the ledger on purpose: money between
 *                  their own accounts, or anything else its labels drop
 *   bill_payment — the app reads it as a payment on a bill
 * A debt payment has NO override: see fileHistoryRow.
 */
export type HistoryOverride = "kept_out" | "bill_payment";
const OVERRIDES: readonly HistoryOverride[] = ["kept_out", "bill_payment"];

/**
 * Every problem with a call that can be found without the database — the tool's
 * `check`, run before the hourly write counter moves, and the first thing its `run` does.
 */
export function planHistoryRow(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<HistoryPlan> {
  const pad = problemPad();

  const accountId = typeof payload.account_id === "string" && UUID.test(payload.account_id)
    ? payload.account_id
    : null;
  if (!accountId) {
    pad.no("I need the id of the account the statement is for, which finance.accounts gives you.");
  }

  const today = azDateISO(ctx.az);
  const earliest = earliestHistoryDate(today);
  let date: string | null = null;
  if (!isDateISO(payload.date)) {
    pad.no("I need the POSTING date the statement shows for that line, as YYYY-MM-DD.");
  } else if (daysBetweenISO(payload.date, today) < 0) {
    pad.no(`${payload.date} has not happened yet in Arizona. Today is ${today}, and a statement row is in the past.`);
  } else if (payload.date < earliest) {
    pad.no(`${payload.date} is more than ${HISTORY_BACK_MONTHS} months back — the earliest a history row can be is ${earliest}.`);
  } else {
    date = payload.date;
  }

  const amount = pad.take(centsArg(payload.amount));

  const type = payload.type;
  if (type !== "expense" && type !== "income") {
    pad.no("type is expense (money that left the account) or income (money that arrived).");
  }

  const description = scrubCap(payload.description, HISTORY_DESCRIPTION_CAP);
  if (!description || !merchantKey(description)) {
    pad.no("Tell me who the money went to or came from: the bank's line, word for word as the statement prints it.");
  }

  let categoryId: string | null = null;
  if (payload.category_id !== undefined) {
    const c = payload.category_id;
    const kind = typeof c === "string" ? CATEGORY_TYPE.get(c) : undefined;
    if (!kind) {
      pad.no("That is not one of the app's categories. Ask finance.categories for the list, or leave category_id out and I will file it the way the app would.");
    } else if ((type === "expense" || type === "income") && kind !== type) {
      pad.no(
        kind === "income"
          ? `${c} is a category for money coming in, and this row is money going out.`
          : `${c} is a category for spending, and this row is money coming in.`,
      );
    } else {
      categoryId = c as string;
    }
  }

  let confirmed = false;
  if (payload.confirm !== undefined) {
    if (typeof payload.confirm !== "boolean") pad.no("confirm is either true or false.");
    else confirmed = payload.confirm;
  }

  let override: HistoryOverride | null = null;
  if (payload.override !== undefined) {
    if (!OVERRIDES.includes(payload.override as HistoryOverride)) {
      pad.no(`override is "kept_out" or "bill_payment", and only the one my refusal named.`);
    } else if (payload.category_id === undefined) {
      // An override says "the app is wrong about this row" — so what it IS has to come
      // from him too. Without a category there is nothing to file it under: the app's
      // own answer for it was "nowhere".
      pad.no("An override needs the category_id he gave the row — the app's own answer for it was to leave it out.");
    } else {
      override = payload.override as HistoryOverride;
    }
  }

  return pad.done(() => ({
    accountId: accountId!,
    date: date!,
    amount: amount!,
    type: type as "expense" | "income",
    description,
    categoryId,
    confirmed,
    override,
  }));
}

/**
 * The merchant keys a learned rule could be stored under for this description — the two
 * namespaces classify()'s learnedFor() looks in: the description's own key, and the key
 * of the description with the bank's statement noise stripped (a statement line copied
 * whole reads "CHECKCARD 0815 …", whose own key is the useless "CHECKCARD"). The tool
 * reads the rule for each, so a rule he taught on that merchant still wins.
 */
export function ruleKeysFor(description: string): string[] {
  const own = merchantKey(description);
  const stripped = merchantKey(stripStatementNoise(description));
  return stripped.length >= 2 && stripped !== own ? [own, stripped] : [own];
}

/** What the row will be filed as. */
export interface HistoryFiling {
  categoryId: string;
  /** A person named it — the sync's relabel sweep and the review queue leave it alone. */
  userCategorized: boolean;
  /** Ask about it once more: the app's own answer was a low-confidence guess (as the
   *  feed flags one), or a person overrode a row the app keeps out of the ledger. */
  needsReview: boolean;
  /** Why, in the app's own words, for the reply. Empty when the caller named it. */
  reason: string;
  /** The refusal he overrode, and what the app had said about the row, for the reply —
   *  which has to say out loud that the app's judgement was set aside, and on what. */
  overridden: { what: HistoryOverride; appSaid: string } | null;
}

/** A debt the bank sync credits by matching its pattern in a charge's description
 *  (debts.track_pattern — an instalment lender, a family loan paid by remittance). */
export interface TrackedDebt {
  name: string;
  trackPattern: string;
  /** Since 2026-10-25, what the sync's own rule reads about a CLOSED debt
   *  (_shared/trackedDebts.ts). Absent or null reads as open, not set, not a card. */
  closedAt?: string | null;
  trackedBaseline?: number | null;
  providerAccountId?: string | null;
}

/** The sync's own test (plaid/index.ts matchTrackedDebt): the pattern anywhere in the
 *  description, ignoring case — outflows only, which the caller ensures. */
export function trackedDebtFor(description: string, debts: readonly TrackedDebt[]): TrackedDebt | null {
  const up = description.toUpperCase();
  return debts.find((d) => d.trackPattern.trim() !== "" && up.includes(d.trackPattern.toUpperCase())) ?? null;
}

/**
 * The closed debt whose pattern is in the description, by the SYNC's rule — the one
 * plaid/index.ts uses to record such a payment instead of dropping it (closedDebtPayment
 * in _shared/trackedDebts.ts, 2026-10-25). Only a closed debt that would be armed if it
 * were open counts: a pattern, a baseline, not a linked card. Called through the sync's
 * own functions, not copied, so the door and the feed cannot drift apart on it.
 */
function closedDebtFor(description: string, debts: readonly TrackedDebt[]): TrackedDebt | null {
  const rows = debts.map((d, i) => ({
    id: String(i),
    track_pattern: d.trackPattern,
    tracked_baseline: d.trackedBaseline ?? null,
    provider_account_id: d.providerAccountId ?? null,
    closed_at: d.closedAt ?? null,
    debt: d,
  }));
  return closedDebtPayment(closedTrackedDebts(rows), description, false)?.debt.debt ?? null;
}

/** What the app itself says about the row, before anything the caller named. */
type Verdict =
  | { kind: "file"; categoryId: string; needsReview: boolean; reason: string }
  | { kind: "debt"; name: string }
  | { kind: "kept_out"; reason: string; income: boolean }
  | { kind: "bill_payment"; bill: string };

/**
 * The app's own judgement of the row — ALWAYS asked, whether or not a category was
 * named. For money out that is the app's own classify() — learned rules first, then his
 * history labels, then the keyword guesses — passed the description as its own raw line,
 * which is how the statement import calls it (buildImportPlan) so the bank's pump and
 * store tokens still count. For money in it is the feed's rule: classifyCredit decides
 * whether it is a transfer between their own accounts, and otherwise creditCategory
 * files it: a paycheck is `salary`, cash put back at an ATM `refund`, anything else
 * `other-income`.
 *
 * WHERE THIS DOOR AND THE FEED PART, named 2026-10-25 in review rather than hidden.
 * The door's reads are narrow on purpose — the rule under this merchant's own keys
 * (ruleKeysFor), the tracked debts — so two of that day's rules cannot reach a row
 * written here:
 *   · money in: creditCategory is asked WITHOUT the spend history (the door does not
 *     read every expense), so a merchant's refund or a friend's payback added here is
 *     `other-income`, where the feed would file the same row `refund`;
 *   · money out: a rule taught under ANOTHER spelling of the merchant
 *     (looseLearnedFor) is never loaded, so it cannot answer here, where on the feed
 *     it would seed the row.
 * Both land on the side the app answered before those rules existed, and the caller
 * can always name the category. Closing the gap means reading the full rule set and
 * the spend history here — a later piece, if the door's reads should widen.
 */
function verdictOf(plan: HistoryPlan, learned: LearnedRules, debts: readonly TrackedDebt[]): Verdict {
  if (plan.type === "income") {
    if (classifyCredit(plan.description) === "transfer") {
      return { kind: "kept_out", reason: "money between your own accounts", income: true };
    }
    // The feed's own category rule, asked without the spend history this door does not
    // read — so a paycheck is salary, cash put back at an ATM is a refund (2026-10-25:
    // classifyCredit no longer keeps that one out), and anything else other-income.
    const credit = creditCategory(plan.description);
    return { kind: "file", categoryId: credit.categoryId, needsReview: false, reason: credit.reason };
  }
  // A tracked debt first, the way the sync asks it first: there a matching outflow is
  // credited to the debt whatever classify() would have said about it.
  //
  // OPEN debts only, since 2026-10-25. FOUND in review that day: the sync stopped
  // crediting a CLOSED debt, but this door still refused a payment matching one, in a
  // sentence saying the feed would credit it. With the sync's first version of that
  // change, a payment on a new loan from the lender of a closed one would have been
  // dropped by the sync AND refused here — in the ledger nowhere. A closed debt's match
  // is judged below, the sync's way.
  const td = trackedDebtFor(
    plan.description,
    debts.filter((d) => !d.closedAt),
  );
  if (td) return { kind: "debt", name: scrubCap(td.name, 40) || "a tracked debt" };
  const c = classify(plan.description, -plan.amount, learned, plan.description);
  if (c.kind === "skip") {
    // A payment only a CLOSED debt matches, which the app would otherwise leave out: the
    // sync now RECORDS that row — a bill payment, flagged for a look, linked to nothing
    // (closedDebtPayment) — so this door files it the same way rather than refusing what
    // the feed itself would write. Asked before the "Debt:" label below, which names that
    // same lender and would refuse it with no way through. Anything classify() does NOT
    // skip goes on exactly as the sync sends it on, closed debt or not.
    const closed = closedDebtFor(plan.description, debts);
    if (closed) {
      return {
        kind: "file",
        categoryId: CLOSED_DEBT_FILING.category_id,
        needsReview: CLOSED_DEBT_FILING.needs_review,
        reason: `a payment matching ${scrubCap(closed.name, 40) || "a debt"}, which is closed and takes no payments`,
      };
    }
    // His history labels name the debts too ("Debt: ..."), and they map to skip — but a
    // debt payment is not "kept out", it is credited somewhere this row cannot reach.
    if (c.hisCategory?.startsWith("Debt:")) {
      return { kind: "debt", name: scrubCap(c.hisCategory.slice("Debt:".length).trim(), 40) || "a debt" };
    }
    return { kind: "kept_out", reason: scrubCap(c.reason, 60) || "one of its own rules", income: false };
  }
  if (c.kind === "bill") return { kind: "bill_payment", bill: scrubCap(c.billName ?? "", 40) || "one of the bills" };
  return { kind: "file", categoryId: c.appCategory ?? "other", needsReview: c.confidence === "low", reason: scrubCap(c.reason, 60) };
}

/**
 * File the row the way the app would have filed it, or refuse.
 *
 * THE APP'S JUDGEMENT ALWAYS RUNS (changed 2026-10-10 after a review — see
 * HistoryOverride for what the first version let through). What a named category
 * does depends on what the app said:
 *
 *   · The app would FILE it (any ordinary charge or deposit). A named category is an
 *     answer: used as given, marked `user_categorized` — the flag that tells the bank
 *     sync's relabel sweep and the review queue a person chose this — and not flagged.
 *     No category: the app's answer, flagged for review when it was a low-confidence
 *     guess, as the feed flags one.
 *
 *   · The app KEEPS IT OUT on purpose — classify() says skip (money moving between
 *     their own accounts, an overseas remittance the app keeps off the books), or
 *     classifyCredit calls a deposit a transfer between their own accounts. Writing it
 *     would put back the very row the app leaves out, and for an account-to-account
 *     move it would show money spent that the household still has: the feed drops the
 *     other leg, so nothing would ever pair with it and cancel it out. Refused, with a
 *     named category or without, unless override is "kept_out" — which the caller sends
 *     only after he has said the app is wrong about this row. An overridden row is
 *     also flagged for review, so it shows once more where he looks.
 *
 *   · The app reads it as a BILL payment. A payment on a bill settles a bill cycle, and
 *     on this door that only ever happens through a tool with the one-payment-per-cycle
 *     guard (finance.link_charge_to_bill). Filing it loose would leave the bill reading
 *     unpaid while the money counted, and if the bill is already marked paid for that
 *     month, the payment would be in the ledger twice. Refused unless override is
 *     "bill_payment" — the path for a bill that shows unpaid, followed by the link.
 *
 *   · It is a DEBT payment — an OPEN tracked debt's pattern (the sync's own test), or a
 *     history label naming a debt. NO OVERRIDE. A debt's balance is worked out from
 *     the payments the bank feed links to it; a row written here links to nothing, so
 *     it would count as spending AND leave the debt reading as if it had not been paid.
 *     There is no way to file that correctly from this tool, so it never does.
 *
 *   · It matches only a CLOSED debt (2026-10-25) and classify() would leave it out. The
 *     feed credits a closed debt nothing; it records such a payment as a bill payment
 *     flagged for a look, so this files it the same way — an ordinary "file" answer,
 *     and a named category is used as given like any other.
 *
 * An override that names something the app did not say is refused too: a stale or
 * pre-emptive override is a sign the caller is guessing, and the point of naming it is
 * that he decided.
 */
export function fileHistoryRow(
  plan: HistoryPlan,
  learned: LearnedRules,
  debts: readonly TrackedDebt[] = [],
): HistoryFiling | Refusal {
  const v = verdictOf(plan, learned, debts);

  if (v.kind === "debt") {
    return refuse(
      409,
      `That reads as a payment on a debt (${v.name}), and a debt payment is not spending: the debt's balance ` +
        `is worked out from the payments the bank feed links to it, so a row added here would count as spending ` +
        `and the debt would get no credit for it. I added nothing, and nothing overrides this one. If it is not ` +
        `a payment on ${v.name} at all, tell him — something is matching it to that debt by mistake.`,
    );
  }

  if (v.kind === "kept_out" || v.kind === "bill_payment") {
    if (plan.override === v.kind) {
      return {
        categoryId: plan.categoryId!, // planHistoryRow refuses an override without one
        userCategorized: true,
        needsReview: v.kind === "kept_out",
        reason: "",
        overridden: { what: v.kind, appSaid: v.kind === "kept_out" ? v.reason : v.bill },
      };
    }
    const wrong = plan.override ? ` (override "${plan.override}" does not apply to this one.)` : "";
    if (v.kind === "kept_out") {
      return refuse(
        409,
        (v.income
          ? "That reads as money moving between your own accounts, which the app does not record as income — the same dollars, not new money. "
          : `The app keeps that one out of the ledger on purpose (${v.reason}): money moving between your own accounts is not spending. `) +
          `I added nothing.${wrong} If he has told you the app is wrong and it really is money from outside the household, ` +
          `send it again with the category_id he gave it and override "kept_out", and tell him you are overriding the app.`,
      );
    }
    return refuse(
      409,
      `That reads as a payment on ${v.bill}, and a bill payment is recorded against the bill. I added nothing.${wrong} ` +
        `If ${v.bill} shows paid for that month already, the payment is already counted. If it shows unpaid, ` +
        `send this again with category_id "bills" and override "bill_payment", then attach the new row with finance.link_charge_to_bill.`,
    );
  }

  if (plan.override) {
    return refuse(
      409,
      `There is nothing to override: the app files that one as ${v.categoryId} on its own. I added nothing. ` +
        `Send it again without override.`,
    );
  }
  if (plan.categoryId) {
    return { categoryId: plan.categoryId, userCategorized: true, needsReview: false, reason: "", overridden: null };
  }
  return { categoryId: v.categoryId, userCategorized: false, needsReview: v.needsReview, reason: v.reason, overridden: null };
}

/** The window of dates the duplicate guard reads, both ends included. */
export function duplicateWindow(date: string): { from: string; to: string } {
  return { from: addDaysISO(date, -DUPLICATE_WINDOW_DAYS), to: addDaysISO(date, DUPLICATE_WINDOW_DAYS) };
}

/** A row the guard compares against: the read's narrow shape. */
export interface NearRow {
  id: string;
  date: string;
  amount: number;
  type: "income" | "expense";
  description: string;
  pending: boolean;
}

const cents = (n: number) => Math.round(n * 100);

/** The merchant test, read through the door's own copy of the categorizer. The rule
 *  itself is the statement import's (importStatement.ts sameMerchant) and lives in
 *  _shared/sameCharge.ts since 2026-10-10, where the bank sync's guard reads it too. */
const READ = { merchantKey, stripStatementNoise };

/**
 * Is this row already in the ledger?
 *
 * `duplicate` — same account (the read is already scoped to it), same direction, same
 * amount to the cent, dated within DUPLICATE_WINDOW_DAYS, and the same merchant: either
 * the same merchantKey(), which is the key the bank sync's own guard and the import
 * share, or the same merchant once the bank's statement noise is stripped from both, by
 * the statement import's own rule — which is how it recognises a feed row ("Safeway"
 * from the feed against "CHECKCARD 0528 SAFEWAY #1717 MESA AZ" copied off a statement).
 * The same test, in the same window, that the bank sync applies to this row once it is
 * written (claimStatementCopy in _shared/dedupGuard.ts) — so "not a duplicate here"
 * and "absorbed there if the bank delivers it" are one judgement, not two.
 *
 * `nearby` — the same direction and amount in the same window under a DIFFERENT
 * merchant. Not proof of anything (the feed's clean name and a truncated statement name
 * can fail to meet: "CHIPOTLE MEX G" against "Chipotle Mexican Grill"), so it is said in
 * the reply rather than refused, and the row is still written.
 */
export function findDuplicate(
  plan: Pick<HistoryPlan, "amount" | "type" | "description">,
  rows: readonly NearRow[],
): { duplicate: NearRow | null; nearby: NearRow[] } {
  const want = cents(plan.amount);
  const same = rows.filter((r) => r.type === plan.type && cents(r.amount) === want);
  const named = (r: NearRow) => sameMerchant(r.description, plan.description, READ);
  return {
    duplicate: same.find(named) ?? null,
    nearby: same.filter((r) => !named(r)),
  };
}

/** The refusal for a likely duplicate: which row, in words he can find it by. */
export function duplicateSays(r: NearRow): string {
  return (
    `That looks like it is already in the ledger: ${dollarsOf(r.amount)} on ${r.date}, ` +
    `"${scrubCap(r.description, 40)}"${r.pending ? " (still processing)" : ""}, id ${r.id}. I added nothing. ` +
    `If the statement really shows two of them, send it again with confirm set to true.`
  );
}

/** The note for rows that match on everything but the merchant. Already scrubbed. */
export function nearbySays(rows: readonly NearRow[]): string | undefined {
  if (!rows.length) return undefined;
  const first = rows[0];
  const more = rows.length > 1 ? ` (and ${rows.length - 1} more like it)` : "";
  return (
    `Check it is not the same money as the ${dollarsOf(first.amount)} on ${first.date}, ` +
    `"${scrubCap(first.description, 40)}"${more} — the same amount nearby under another name. ` +
    `If it is, undo this.`
  );
}

const dollarsOf = (n: number) => `$${n.toFixed(2)}`;
