// Phase 2's finance reads: a tool for every remaining thing the app can show him.
//
// WHAT CHANGED SINCE PHASE 1, IN ONE SENTENCE
//
// Phase 1's rule was "expose what is safe". His instruction for Phase 2 is "Muse has
// to have every functionality given in the app and the app must become a database
// for patterns and information storage", so the rule is now "expose everything the
// app shows him, and make every change reversible". These are the reads half of
// that.
//
// THE ONE REVERSAL WORTH READING TWICE: individual charges and search.
//
// Phase 1 forbade both, in writing: ABSENT carried "finance.search_transactions —
// returning individual ledger rows turns a chat into a copy of the ledger.
// Forbidden, not disabled." That was a privacy judgement, and it was HIS to make.
// He has made it the other way, deliberately, because the app shows him these rows
// and an assistant that cannot see a charge cannot answer "what was that $47 on
// Tuesday" — which is most of what he would ask.
//
// So the trade is accepted, and exactly one line of it is NOT: `raw_description`,
// the untouched bank descriptor, still never leaves either door. That is not
// squeamishness about a copy of the ledger; it is the injection surface. Every other
// string in a charge has been through the app at least once — `description` is
// Plaid's cleaned merchant name or something one of them typed. `raw_description` is
// the only field written verbatim by whoever sent the money, with no cleaning
// anywhere in the app, and its only use is a disambiguation the app does in code
// (a club's fuel pump from its store). Nothing an assistant asks needs it, and
// everything an attacker with access to a memo line would want does. It stays in
// ABSENT.
//
// WHICH TOOLS MAY SAY A DESCRIPTION IS DECLARED, NOT INFERRED. See SAYS_DESCRIPTION
// below. The Rule 4 tests assert the descriptor canary appears in no reply from any
// tool NOT on that list, and that no reply from any tool at all carries a URL, a
// newline or an injection line — including the two that do say descriptions. So
// "which strings were checked" stays a table a reader can look at rather than a
// judgement call made line by line.
//
// THE FIVE RULES STILL BIND, and two of them bit here:
//   · Rule 1, no arithmetic: every figure below comes out of a shared function.
//     finance.firepower and finance.next_bills exist at all only because the two
//     assemblies they needed moved into src/lib/headline.ts first. Before that they
//     were correctly ABSENT, because a number the app does not show has nothing to
//     be checked against — which is the condition that produced "Electric $85" while
//     every screen said $100.
//   · Rule 2, no clocks: `now` arrives as an argument. finance.bill_calendar takes a
//     month and defaults to `now`'s month, never the runtime's.
//
// STILL ABSENT AFTER THIS PHASE: finance.forecast. The function exists
// (src/lib/forecast.ts, generated into ./lib already) and the screen it came from
// does not, so there is still nothing to check a spoken number against. That is a
// decision, not an oversight, and it keeps its entry in ABSENT.

import {
  BadArgs,
  dateArg,
  intArg,
  optionalBoolArg,
  optionalMonthArg,
  optionalMoneyArg,
  optionalTextArg,
  textArg,
} from "./args.ts";
import { isoDate, monthKeyOf } from "./lib/format.ts";
import { inAnyLine, plannedMonthly } from "./lib/plan.ts";
import { isCreditAccount, liveOn } from "./lib/recurring.ts";
import { monthCalendar } from "./lib/schedule.ts";
import { DEFAULT_CATEGORIES } from "./lib/seed.ts";
import { billKey, merchantKey } from "./lib/categorize.ts";
import type { Transaction } from "./lib/types.ts";
import { LABEL_MAX, NAME_MAX, money, scrub, scrubName, scrubOr } from "./scrub.ts";
import { sayChange } from "./undo.ts";
import type { Json, Tool } from "./tools.ts";

/**
 * The only tools allowed to put a ledger `description` in a reply.
 *
 * Declared here, in the door's own source, so the promise is a list rather than a
 * habit — and read by the Rule 4 tests, so adding a tool that says a description
 * without adding it here fails the build.
 */
export const SAYS_DESCRIPTION: ReadonlySet<string> = new Set([
  "finance.transaction",
  "finance.search_transactions",
  "finance.bank_pending",
]);

/** The most rows one search will return. A chat cannot use more than this, and a
 *  reply that scrolled past what an assistant can hold is a reply that gets
 *  summarised by something other than the app. */
const SEARCH_MAX = 50;
/** The most bills, rules, accounts or changes any one list tool returns. Every one
 *  of these lists is tens of rows in his real data; the cap is here so a reply size
 *  cannot be surprised by a table that grew. */
const LIST_MAX = 200;

/**
 * One charge, as the door says it.
 *
 * Built key by key rather than spread, so a column added to `transactions` later
 * cannot ride out of the door on the next deploy. That is the same rule
 * finance.worth_a_look follows, and it is why `raw_description` is absent by
 * construction here and not by a filter.
 */
function sayCharge(t: Transaction): { [k: string]: Json } {
  const out: { [k: string]: Json } = {
    id: t.id,
    date: t.date,
    amount: money(t.amount),
    // Income or expense. The amount is always positive and the sign lives here,
    // which is worth stating because a chat will otherwise assume a sign.
    kind: t.type,
    category_id: scrubName(t.categoryId, NAME_MAX) || "(no category id I can say)",
    // The cleaned merchant name, or one fixed sentence. NEVER a sliced one: Rule 4
    // caps by DROPPING what does not fit, because half a merchant name reads as a
    // different merchant.
    merchant: scrubOr(t.description, "(a name I cannot say safely)"),
    account_id: t.accountId ?? null,
    from_bank: !!t.provider,
    still_processing: !!t.pending,
    needs_review: !!t.needsReview,
    category_chosen_by_hand: !!t.userCategorized,
    unusual_flag_dismissed: !!t.anomalyAck,
    records_money_moved_elsewhere: !!t.recordOnly,
  };
  // What this charge is attached to, in the app's own vocabulary. This is the field
  // the $1,732 parking-charge bug lived in, so it is reported in full: a charge that
  // is quietly settling a bill cycle is the thing most worth being able to see.
  const at = t.appliesTo;
  if (at) {
    const applies: { [k: string]: Json } = { kind: scrubName(at.kind, LABEL_MAX) || "something" };
    if (at.recurringId) applies.bill_id = at.recurringId;
    if (at.monthKey) applies.month = scrubName(at.monthKey, LABEL_MAX) || null;
    if (at.day != null) applies.day = at.day;
    if (at.debtId) applies.debt_id = at.debtId;
    if (at.goalId) applies.goal_id = at.goalId;
    if (at.appliedAmount != null) applies.applied_to_debt = money(at.appliedAmount);
    if (at.reason) applies.reason = scrubName(at.reason, LABEL_MAX) || null;
    if (at.settled != null) applies.settled = !!at.settled;
    if (at.settledByTxnId) applies.settled_by_charge_id = at.settledByTxnId;
    if (at.note) applies.note = scrub(at.note) ?? null;
    out.applies_to = applies;
  } else {
    out.applies_to = null;
  }
  if (t.splits?.length) {
    out.splits = t.splits.map((s) => ({
      category_id: scrubName(s.categoryId, NAME_MAX) || "(no category id I can say)",
      amount: money(s.amount),
    }));
  }
  return out;
}

// ── finance.categories ────────────────────────────────────────────────────────
//
// The smallest tool in this phase and the most load-bearing one, because without it
// the write door's category argument could only ever be guessed at.
//
// Phase 1's finance.categorize_charge took a category id and checked its SHAPE
// (`/^[a-z][a-z0-9-]{1,40}$/`), with a comment saying the app's list was
// deliberately not copied into the door. That reasoning was right about copies and
// wrong about consequences: the list lives in code only — src/lib/seed.ts
// DEFAULT_CATEGORIES, mirrored into state by the store, with no table anywhere — and
// the read door never served it. So the one write that needed a category id could
// only be called by guessing one, and a guess that passes the shape check writes a
// category the app does not know.
//
// The list is not copied here either. It is the app's own constant, imported through
// the generated copy, which is exactly what src/store/FinanceStore.tsx hands the
// maths modules.
const financeCategories: Tool = {
  name: "finance.categories",
  summary: "Every category a charge can be filed under, and whether the budget grades it.",
  run() {
    return Promise.resolve({
      note:
        "other is the ABSENCE of a category, not a category. Filing one charge there is fine; " +
        "teaching a merchant rule to use it stops the app ever trying on that merchant again.",
      categories: DEFAULT_CATEGORIES.map((c) => ({
        id: c.id,
        name: scrubOr(c.name, c.id),
        kind: c.type,
        // Whether a budget line watches it. This is the difference between "this
        // spend is graded against the envelope" and "this spend is real cash that
        // cuts firepower and appears on no bar" — the reason electronics and car
        // exist as their own categories at all.
        on_a_budget_line: inAnyLine(c.id),
      })),
    });
  },
};

// ── finance.transaction ───────────────────────────────────────────────────────
const financeTransaction: Tool = {
  name: "finance.transaction",
  summary: "One charge in full — amount, date, category, what it is attached to, and its flags.",
  args: [{ name: "id", type: "string", required: true, description: "The charge's id." }],
  async run({ load, args }): Promise<{ [k: string]: Json }> {
    const id = textArg(args, "id", 64);
    const { transactions } = await load.appData();
    const hit = transactions.find((t) => t.id === id);
    if (!hit) {
      return {
        found: false,
        note: "No charge with that id. It may have been deleted, or the id may be from another table.",
      };
    }
    return { found: true, charge: sayCharge(hit) };
  },
};

// ── finance.search_transactions ───────────────────────────────────────────────
//
// EVERY FILTER IS OPTIONAL AND NONE IS A CLOCK. A search with no window is a search
// of the whole ledger, newest first, capped — not a search of "the last 30 days",
// because a door that quietly narrowed the window would answer "no, there is no
// such charge" about a charge that exists.
//
// The merchant filter matches the way the app's own labeller matches, in three
// spellings, all of them the app's own functions rather than anything invented here:
//
//   merchantKey()  the labeller's key — strips the trailing store number, the date, the
//                  confirmation code, and upper-cases. So "trader joe" finds
//                  "TRADER JOE'S #457".
//   billKey()      case-folded with every non-alphanumeric character dropped. This is
//                  the one that earns its place: merchantKey KEEPS apostrophes on
//                  purpose (so "Trader Joe's" resolves in the built-in dictionary), and
//                  he dictates every message — "trader joes" has no apostrophe in it and
//                  never will. Without this the search misses the charge he is looking
//                  at, and reports "no such charge" about a charge that exists.
//   a plain substring, because he will say half a word.
const financeSearch: Tool = {
  name: "finance.search_transactions",
  summary: "Find charges — by window, amount, category, merchant, or what they are attached to.",
  args: [
    { name: "from", type: "string", required: false, description: "First day of the window, YYYY-MM-DD." },
    { name: "to", type: "string", required: false, description: "Last day of the window, YYYY-MM-DD, inclusive." },
    { name: "min_amount", type: "number", required: false, description: "Only charges at least this many dollars." },
    { name: "max_amount", type: "number", required: false, description: "Only charges at most this many dollars." },
    { name: "category_id", type: "string", required: false, description: "A category id from finance.categories." },
    { name: "merchant", type: "string", required: false, description: "Part of the merchant name, however he says it." },
    { name: "kind", type: "string", required: false, description: "income or expense." },
    { name: "needs_review", type: "boolean", required: false, description: "Only charges the app could not confidently label." },
    { name: "still_processing", type: "boolean", required: false, description: "Only charges the bank has not posted yet." },
    { name: "from_bank", type: "boolean", required: false, description: "True for bank-fed charges, false for hand-entered ones." },
    { name: "unattached", type: "boolean", required: false, description: "True for charges attached to no bill, debt or goal." },
    { name: "limit", type: "integer", required: false, description: `How many to return, up to ${SEARCH_MAX}. Default 20.` },
  ],
  async run({ load, args }) {
    const from = args.from == null ? null : dateArg(args, "from");
    const to = args.to == null ? null : dateArg(args, "to");
    if (from && to && from > to) throw new BadArgs("The window starts after it ends.");
    const minAmount = optionalMoneyArg(args, "min_amount");
    const maxAmount = optionalMoneyArg(args, "max_amount");
    if (minAmount != null && maxAmount != null && minAmount > maxAmount) {
      throw new BadArgs("The smallest amount is bigger than the largest one.");
    }
    const categoryId = optionalTextArg(args, "category_id", NAME_MAX);
    const merchant = optionalTextArg(args, "merchant", NAME_MAX);
    const kind = optionalTextArg(args, "kind", 16);
    if (kind !== null && kind !== "income" && kind !== "expense") {
      throw new BadArgs("kind is income or expense.");
    }
    const needsReview = optionalBoolArg(args, "needs_review");
    const processing = optionalBoolArg(args, "still_processing");
    const fromBank = optionalBoolArg(args, "from_bank");
    const unattached = optionalBoolArg(args, "unattached");
    const limit = intArg(args, "limit", 20, 1, SEARCH_MAX);

    const wantedKey = merchant ? merchantKey(merchant) : null;
    const wantedLoose = merchant ? billKey(merchant) : null;
    const wantedText = merchant ? merchant.toLowerCase() : null;

    const { transactions } = await load.appData();
    const matched = transactions.filter((t) => {
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (minAmount != null && t.amount < minAmount) return false;
      if (maxAmount != null && t.amount > maxAmount) return false;
      if (kind && t.type !== kind) return false;
      if (needsReview != null && !!t.needsReview !== needsReview) return false;
      if (processing != null && !!t.pending !== processing) return false;
      if (fromBank != null && !!t.provider !== fromBank) return false;
      if (unattached != null && !t.appliesTo !== unattached) return false;
      if (categoryId) {
        // A split charge is in a category if ANY slice is: that is how the budget
        // partition reads it (spentByCategoryBetween), so a search that only looked
        // at the primary category would miss the grocery run's household half and
        // disagree with the bar it is supposed to explain.
        const inPrimary = t.categoryId === categoryId;
        const inSlice = t.splits?.some((s) => s.categoryId === categoryId) ?? false;
        if (!inPrimary && !inSlice) return false;
      }
      if (wantedKey) {
        const desc = t.description ?? "";
        const hit =
          merchantKey(desc).includes(wantedKey) ||
          (!!wantedLoose && billKey(desc).includes(wantedLoose)) ||
          desc.toLowerCase().includes(wantedText ?? "");
        if (!hit) return false;
      }
      return true;
    });

    // Newest first, and by id after the date so the order is total — two charges on
    // the same day must not come back in a different order on two identical calls,
    // or "the first one" means something different each time it is said.
    matched.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

    return {
      // The honest count BEFORE the cap, and the cap said out loud. A list of 20 out
      // of 300 that did not say so would be summarised as "you have 20 of those".
      found: matched.length,
      returned: Math.min(matched.length, limit),
      more: matched.length > limit,
      // The totals of the WHOLE match, not of the page. "What did we spend at Sam's
      // this month" is the commonest shape of this question, and an assistant that is
      // told never to do arithmetic on what it is handed cannot answer it from a list
      // of charges — it refuses, correctly, and the person hears "open the app".
      // So the door adds them up, which is where addition belongs, and says plainly
      // that the figure covers every match rather than the ones shown.
      spent: money(matched.filter((t) => t.type === "expense").reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)),
      received: money(matched.filter((t) => t.type === "income").reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)),
      totals_cover: "every charge that matched, not only the ones listed here",
      note:
        matched.length > limit
          ? "There are more than these. Narrow the window or the amount to see the rest."
          : "That is all of them.",
      charges: matched.slice(0, limit).map(sayCharge),
    };
  },
};

// ── finance.accounts ──────────────────────────────────────────────────────────
//
// finance.position answers "how much cash is there" and deliberately lists only the
// CASH accounts, because a card balance added to a checking balance is not a number
// that means anything. This is the other question — what accounts exist at all — and
// it includes the cards, flagged as cards, with their balance labelled as what it is.
//
// NO last4, AND THAT IS DELIBERATE. ABSENT says no tool reads account numbers, and
// four digits of a card is four digits of a card. He can tell his accounts apart by
// name, in the app and in a chat.
const financeAccounts: Tool = {
  name: "finance.accounts",
  summary: "Every account, cards included — what it is, what it holds, and whether the bank feeds it.",
  async run({ load }) {
    const { accounts } = await load.appData();
    return {
      note:
        "On a cash account the balance is what can be spent. On a credit account it is what is OWED. " +
        "They are not added together anywhere.",
      accounts: [...accounts]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .slice(0, LIST_MAX)
        .map((a) => ({
          id: a.id,
          name: scrubOr(a.name, "an account"),
          owner: scrubOr(a.owner, "the household", LABEL_MAX),
          type: scrubName(a.type, LABEL_MAX) || "unknown",
          is_credit: isCreditAccount(a),
          balance: money(a.balance),
          still_processing: money(a.pendingHold ?? 0),
          bank_linked: !!a.providerAccountId,
        })),
    };
  },
};

// ── finance.bills ─────────────────────────────────────────────────────────────
const financeBills: Tool = {
  name: "finance.bills",
  summary: "Every recurring row in full — cadence, due days, window, and what the plan prices it at.",
  args: [
    {
      name: "include_off",
      type: "boolean",
      required: false,
      description: "True to include rows that are switched off. Default false.",
    },
  ],
  async run({ load, now, args }) {
    const includeOff = optionalBoolArg(args, "include_off") ?? false;
    const data = await load.appData();
    const today = isoDate(now);
    const rows = data.recurring.filter((r) => includeOff || r.active);
    return {
      note:
        "planned_monthly is what the PLAN prices this row at per month — for a variable bill that is " +
        "the amount you told it, else the rolling average of real payments. It is the same function the " +
        "calendar and the forecast price it with.",
      bills: rows.slice(0, LIST_MAX).map((r) => ({
        id: r.id,
        name: scrubOr(r.name, "a bill"),
        amount: money(r.amount),
        direction: r.direction,
        cadence: r.cadence,
        category_id: r.categoryId ? scrubName(r.categoryId, NAME_MAX) || null : null,
        owner: r.owner ? scrubOr(r.owner, "the household", LABEL_MAX) : null,
        active: r.active,
        variable: r.variable === true,
        known_amount: r.knownAmount == null ? null : money(r.knownAmount),
        due_days: r.dueDays ?? null,
        anchor_date: r.anchorDate ?? null,
        starts_on: r.startsOn ?? null,
        ends_on: r.endsOn ?? null,
        linked_debt_id: r.linkedDebtId ?? null,
        note: r.note ? scrub(r.note) ?? null : null,
        // Whether the row may fire TODAY, from the shared window function — a bill
        // paused until November is active and dormant at the same time, and those
        // are different answers to "is this a live bill".
        live_today: liveOn(r, today),
        planned_monthly: money(plannedMonthly(r, data.transactions)),
      })),
      count: rows.length,
    };
  },
};

// ── finance.bill_calendar ─────────────────────────────────────────────────────
//
// The month as the calendar screen draws it: every out-bill anchored to its DUE day,
// marked paid or not, with the actual paid date when a payment matched. Rule 2 —
// the month defaults to `now`'s month, never the runtime's.
const financeBillCalendar: Tool = {
  name: "finance.bill_calendar",
  summary: "One month's bills as the calendar shows them — due day, amount, and whether it is paid.",
  args: [
    { name: "month", type: "string", required: false, description: "Which month, YYYY-MM. Default this month." },
  ],
  async run({ load, now, args }) {
    const asked = optionalMonthArg(args, "month");
    const monthKey = asked ?? monthKeyOf(now);
    const [year, month] = monthKey.split("-").map(Number);
    const data = await load.appData();
    const cal = monthCalendar(data.recurring, data.transactions, now, year, month - 1, data.debts);
    const unpaid = cal.bills.filter((b) => !b.paid);
    return {
      month: cal.monthKey,
      label: scrubOr(cal.monthLabel, cal.monthKey),
      is_this_month: cal.isCurrentMonth,
      unpaid_count: unpaid.length,
      bills: cal.bills.slice(0, LIST_MAX).map((b) => ({
        bill_id: b.recurringId ?? null,
        name: scrubOr(b.name, "a bill"),
        category_id: scrubName(b.catId, NAME_MAX) || null,
        due_day: b.day,
        due_label: scrubOr(b.dateLabel, `day ${b.day}`, LABEL_MAX),
        amount: money(b.amount),
        paid: b.paid,
        paid_on: b.paidDate ? scrubOr(b.paidDate, "an earlier day", LABEL_MAX) : null,
        // An estimate, not a price. Said per row because a chat has no italics.
        amount_is_an_estimate: b.variable,
      })),
      note:
        "A bill sits on its DUE day whether it is paid or not; paid_on is when the payment actually landed, " +
        "which can be in an earlier month.",
    };
  },
};

// ── finance.paid_bills ────────────────────────────────────────────────────────
//
// The overrides, and only the overrides. A row exists here only where the paid state
// differs from what the date and the ledger would say on their own, which is why the
// list is short and why an empty list is the healthy answer rather than a missing one.
const financePaidBills: Tool = {
  name: "finance.paid_bills",
  summary: "The hand-set paid/unpaid overrides — the ones that disagree with the ledger.",
  args: [
    { name: "month", type: "string", required: false, description: "Only this month, YYYY-MM." },
  ],
  async run({ load, args }) {
    const month = optionalMonthArg(args, "month");
    const { paidBills } = await load.appData();
    const rows = month ? paidBills.filter((b) => b.month === month) : paidBills;
    return {
      count: rows.length,
      note:
        "A row here exists only where somebody set the paid state by hand. No row means the app is " +
        "deciding from the ledger, which is the normal case.",
      overrides: rows.slice(0, LIST_MAX).map((b) => ({
        id: b.id,
        month: scrubName(b.month, LABEL_MAX) || null,
        // bill_key is "<label>@<day>", assembled by the app from a bill's own name.
        bill_key: scrubOr(b.billKey, "a bill", NAME_MAX),
        paid: b.paid,
      })),
    };
  },
};

// ── finance.merchant_rules ────────────────────────────────────────────────────
const financeMerchantRules: Tool = {
  name: "finance.merchant_rules",
  summary: "What the app has LEARNED about a merchant — the rules that beat every built-in one.",
  async run({ load }) {
    const { merchantRules } = await load.appData();
    return {
      count: merchantRules.length,
      note:
        "A learned rule beats every built-in rule, so a wrong one is permanent until it is changed. " +
        "bill means the charge pays that bill; variable means ordinary spending in that category; " +
        "skip means the feed drops the charge entirely.",
      rules: [...merchantRules]
        .sort((a, b) => a.pattern.localeCompare(b.pattern))
        .slice(0, LIST_MAX)
        .map((r) => ({
          id: r.id,
          // The normalised merchant key the rule matches on. It is his own learned
          // answer, visible in the app, and it is the argument finance.learn_merchant
          // takes — so it has to come back or the write could only be guessed at.
          merchant: scrubOr(r.pattern, "(a merchant key I cannot say safely)"),
          kind: r.kind,
          category_id: r.categoryId ? scrubName(r.categoryId, NAME_MAX) || null : null,
          bill_name: r.billName ? scrubOr(r.billName, "a bill") : null,
        })),
    };
  },
};

// ── finance.firepower AND finance.next_bills ARE NOT HERE ─────────────────────
//
// This branch wrote both, and both were deleted at the merge rather than merged.
//
// They were written against a `src/lib/headline.ts` this branch also created, holding
// `headlineFirepower` and `nextBills`. Main had independently created a file at the
// same path holding `firepowerStatus` and `billsBeforeNextPayday` — the same two
// assemblies, extracted for the same reason (Rule 3), by another branch, in the same
// week. Main's shipped first, is what `buildVMs.ts` and `BillsSheet.tsx` now call, is
// covered by scripts/gen-muse-shared.mjs and the build's drift check, and its two
// tools were proved against the real ledger. So main's are the ones that exist.
//
// Nothing was lost: main's replies are supersets of this branch's. `finance.firepower`
// also carries the month key and nests the plan and the two subtractions; its
// `plan.before_subtractions` is this branch's `planned`, `taken_out.overspent_this_month`
// is `over_the_budget`, and `taken_out.outside_the_budget` is `spent_outside_the_budget`.
// `finance.next_bills` also carries the cycle label, the days left, and each bill's
// resolved calendar date.
//
// The reason this is written down rather than just done: the same extraction happening
// twice in one week is the drift the shared-function rule exists to stop, and it nearly
// landed as two functions computing one figure at one path.

// ── finance.bank_status ───────────────────────────────────────────────────────
//
// WHY THIS IS A READ TOOL AT ALL. Every figure on the finance side is downstream of
// a sync that either happened or did not. A connection sitting in `needs_reauth` for
// a week makes every balance the door reports quietly stale, and in a chat there is
// no "as of" line under the number to notice. So this exists to make "is this
// current" answerable.
//
// It reads no secret and nothing that names one: not the Plaid item_id, not the
// vault secret's NAME, not the sync cursor.
const financeBankStatus: Tool = {
  name: "finance.bank_status",
  summary: "Whether each bank connection is healthy and when it last synced.",
  async run({ load }) {
    const rows = await load.bankConnections();
    return {
      count: rows.length,
      note:
        "Every balance the app reports comes from the last good sync. A connection that needs " +
        "re-authorising makes those numbers stale without making them look stale.",
      connections: rows.slice(0, LIST_MAX).map((c) => ({
        owner: scrubOr(c.owner, "the household", LABEL_MAX),
        bank: c.institution ? scrubOr(c.institution, "a bank") : null,
        status: scrubName(c.status, LABEL_MAX) || "unknown",
        last_sync_at: c.lastSyncAt,
        failures_in_a_row: c.consecutiveFailures,
        // The bank's own error text, written by the provider. Scrubbed like any
        // other string that somebody else wrote, and dropped whole rather than
        // sliced when it does not survive.
        last_error: c.lastError ? scrub(c.lastError) ?? "an error I cannot repeat safely" : null,
      })),
    };
  },
};

// ── finance.bank_pending ──────────────────────────────────────────────────────
const financeBankPending: Tool = {
  name: "finance.bank_pending",
  summary: "Charges the bank has taken but not posted — they are not in the ledger yet.",
  async run({ load }) {
    const rows = await load.pendingCharges();
    return {
      count: rows.length,
      note:
        "These never enter the ledger, which is what stops them being counted twice when they post. " +
        "The amount is signed the way the bank reports it: negative is money going out.",
      charges: rows.slice(0, LIST_MAX).map((p) => ({
        date: p.date,
        amount: money(p.amount),
        merchant: scrubOr(p.description, "(a name I cannot say safely)"),
        category_id: p.categoryId ? scrubName(p.categoryId, NAME_MAX) || null : null,
        owner: p.owner ? scrubOr(p.owner, "the household", LABEL_MAX) : null,
        account_id: p.accountId,
      })),
    };
  },
};

// ── system.changes ────────────────────────────────────────────────────────────
//
// "What did you change?" — and it has to be answerable, because Phase 2's whole
// argument for dropping the approval queue is that every change is written down with
// its before-state. A log nobody can read is not accountability, it is a claim.
//
// It reads muse_undo rather than muse_audit, and the difference matters. muse_audit
// records that a call happened and deliberately stores no amounts and no detail —
// it is the call log his settings screen renders. muse_undo records what the change
// WAS, in the sentence he was told at the time, with the token that reverses it.
// That is what this question wants.
//
// THE STEPS ARE NEVER EMITTED. They carry the before-state, which for a deleted
// charge is the whole row. It belongs in his database, not in an assistant's
// context. What comes back is the sentence, how many rows it touched, and whether it
// can still be undone.
const systemChanges: Tool = {
  name: "system.changes",
  summary: "What this assistant has changed, newest first, with the token to undo each one.",
  args: [
    { name: "limit", type: "integer", required: false, description: "How many to list, up to 50. Default 10." },
    { name: "undoable_only", type: "boolean", required: false, description: "True to skip the ones already undone." },
  ],
  async run({ load, person, args }) {
    const limit = intArg(args, "limit", 10, 1, 50);
    const undoableOnly = optionalBoolArg(args, "undoable_only") ?? false;
    const all = await load.changes(person);
    const rows = undoableOnly ? all.filter((r) => r.state === "undoable") : all;
    return {
      person,
      total: all.length,
      returned: Math.min(rows.length, limit),
      note:
        "Every one of these can be put back with system.undo and its token, unless something has " +
        "changed the same row since — then the undo refuses rather than overwriting the newer answer.",
      changes: rows.slice(0, limit).map(sayChange),
    };
  },
};

export const FINANCE_TOOLS: readonly Tool[] = [
  financeCategories,
  financeTransaction,
  financeSearch,
  financeAccounts,
  financeBills,
  financeBillCalendar,
  financePaidBills,
  financeMerchantRules,
  financeBankStatus,
  financeBankPending,
  systemChanges,
];
