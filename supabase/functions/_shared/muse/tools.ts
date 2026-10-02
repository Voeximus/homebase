// The read door's catalogue. What is in TOOLS exists; nothing else does.
//
// (Counts are deliberately not written here. Two branches built on this file at
// once and both had to correct the word "eleven" in this very comment. The count
// now comes off TOOLS itself, in catalogue.ts, and every sentence that states one —
// the OpenAPI descriptions, the "no such tool" reply — is generated from there.)
//
// ONE FILE PER DOMAIN. This one holds the finance summaries; toolsFinance.ts holds
// phase 2's finance parity, healthRead.ts the health and workout reads, and
// memoryTools.ts the memory store. They are registered below and nothing about how a
// memory works lives in here.
//
// TWO OF THESE DO NOT ANSWER ABOUT THE HOUSEHOLD'S OWN FIGURES. schedule.list_reminders
// answers about rows the WRITE door made — it is here because it is a question, and
// because the write door's cancel and edit tools need an id that something has to hand
// out. And the memory tools answer about what the ASSISTANT was told to remember, which
// is the one thing in this door that is not a fact about the house.
//
// RULE 1 — no arithmetic in here. Every number below comes out of a function in
// src/lib, imported through the generated copies in ./lib. The repo has the
// receipts for what happens otherwise: cron-notify re-implemented the app's bill
// maths by hand and told the phones "Electric $85" while every screen said $100,
// pinged a semiannual bill every month, and announced three bills as due tonight
// that were not due at all. In a chat there is no screen beside the number to
// notice.
//
// The only arithmetic anywhere in this file is `target - spent` on a budget line,
// and it is here because the question is literally "how much is left": the screen
// does the same subtraction on the same two figures (src/views/redesign/buildVMs.ts),
// and the alternative is making the assistant do the sum, which is worse.
//
// RULE 2 — no clocks. `now` arrives as an argument, built once per request by
// nowAZ(). Every call that takes a date gets one explicitly; not one default is
// allowed to fire. tests/museRead.test.ts runs every tool under UTC and under
// Arizona and requires identical output.
//
// RULE 3 — no assembling a function's inputs. Where the app assembles something in a
// view module, the assembly is EXTRACTED into src/lib/headline.ts and both the screen
// and the tool call it — the tool never re-runs the steps itself. Four sequences live
// there now: the budget envelope, the firepower tile, "still due before payday", and
// the forward projection's options. Three tools were absent from this file until they
// did, and the reason is worth keeping: each one would have called only real functions,
// computed every number honestly, and still disagreed with his screen.
//
// So no tool below reads `data` and works something out. It calls one assembly
// function and reports its fields. If a figure needs a step that is not in headline.ts,
// the step goes there first — not here.
//
// RULE 4 — every string out goes through scrub(). Including the ones that came
// from the app's own source, so that "which strings were checked" is not a
// judgement call a reader has to make line by line.
//
// RULE 5 — every table read is paged and fails closed. See load.ts / paging.ts.
//
// THE WORDING IS A DRAFT UNTIL HE HAS READ IT. The plan puts a phase before this
// one whose whole job is that he approves the exact sentences that come back,
// because in a chat the sentences ARE the product — he has rejected whole builds
// for being made before he saw anything. Every sentence this door can say is in one
// of three places, so editing them is finding a table rather than reading code:
//   · CHECK_SAYS below, one line per self-check per outcome;
//   · the `note` on each tool, which is the one place a number would mislead
//     without a sentence beside it;
//   · sentenceFor / groupSentence in worthALook.ts.

import { coverFor } from "./lib/pendingCover.ts";
import { selfAudit, danglingLinks, type AuditCheck } from "./lib/selfAudit.ts";
import {
  LEAN_VARIABLE,
  orderedDebts,
  planMath,
  sumTargets,
  spentByCategoryBetween,
} from "./lib/plan.ts";
import {
  billsBeforeNextPayday,
  envelopeStatus,
  firepowerStatus,
  FORECAST_MONTHS,
  lowestPoint,
  monthGetter,
  runForecast,
} from "./lib/headline.ts";
import { cashAccounts, totalBalance, totalPendingHold } from "./lib/recurring.ts";
import { isoDate } from "./lib/format.ts";
import { reviewLedger } from "./lib/ledgerReview.ts";
import { currentWeekAvg, latestWeight, ratePerWeek } from "./lib/weightLog.ts";
import { dayTotals, remaining } from "./lib/mealLog.ts";
import { bestSet, SEED_ROUTINES, type Routine } from "./lib/workoutLog.ts";
import { BUNDLED_EXERCISES } from "./lib/exerciseData.ts";
import { bandLabel, hardSetsByRegion, lastTime } from "./lib/trainingMath.ts";
import { REGIONS, REGION_BY_ID } from "./lib/muscleRegions.ts";
import { describe, pendingFor } from "./reminders.ts";
import { catalogueOf, readEntries } from "./catalogue.ts";
// The argument readers and the tool shape, moved out of this file by phase 2 so every
// half of the read door refuses a bad date, a bad integer and a bad string the same way.
import { BadArgs, dateArg, intArg, lastDayOf, textArg, type Json, type Tool } from "./args.ts";
import { FINANCE_TOOLS } from "./toolsFinance.ts";
import { LABEL_MAX, NAME_MAX, money, scrub, scrubName, scrubOr } from "./scrub.ts";
import { redactSuggestions } from "./worthALook.ts";
import { HEALTH_ABSENT, HEALTH_READS } from "./healthRead.ts";
// The memory store's three read tools. Their own file, so nothing about how a memory
// works lives in here and nothing about finance or health lives in there.
import { MEMORY_READ_TOOLS } from "./memoryTools.ts";

// The shape of a tool, the argument checks, and BadArgs live in args.ts, so every tool
// file can use them without one importing another. Re-exported here because handler.ts,
// openapi.ts and the tests have always asked tools.ts for them, and moving a file should
// not move a door's front door.
//
// THE MEMORY BRANCH SOLVED THIS TOO, as ./reply.ts, holding Json and BadArgs for exactly
// the reason args.ts holds them: two tool files importing a class out of each other is an
// import cycle whose failure mode is an uninitialised binding at load time rather than a
// compile error — it works in the tests and fails in the deployed function. Three branches
// found the same wall. One file answers it.
export type { Json, Tool, ToolContext } from "./args.ts";
export { BadArgs } from "./args.ts";

// ── ARGS ──────────────────────────────────────────────────────────────────────
//
// `person` IS NOT AN ARGUMENT, on any tool. It is forced from the secret, and a
// `person` key in the body is a refusal rather than an override. §5 of the plan
// sets that rule for writes and reminders — "This is not a default; a default is
// not a guard" — and the same reasoning applies to a read: a secret that could ask
// about the other person makes losing one phone cost both people's data, and
// Phase 3's own gate is "her secret returns her health figures and not his".
//
// The cost is real and worth stating: he cannot ask his own assistant how her
// weight is trending, which he can see in the app today. Reversing that is one
// line here, and it should be his decision rather than a side effect.
//
// Every tool declares the arguments it takes, and the handler refuses any key that
// is not on that list — so a misspelled argument is an error rather than a silently
// ignored instruction, and `person` is refused everywhere at once.

// ── finance.audit ─────────────────────────────────────────────────────────────
//
// Three of the eight checks put a raw ledger description or a single charge's date
// into `detail`, so `detail` cannot simply be forwarded:
//   splits-sum            `${t.date} ${t.description} (slices … vs charge …)`
//   one-payment-per-cycle `… is claimed by N charges (${date} $${amount}, …)`
//   links-point-somewhere `${date} ${description} ($…) points at a deleted …`
// The other five name a bill row, a hardcoded budget-line label, or category ids.
//
// So there is an ALLOWLIST, and it is an allowlist rather than a blocklist on
// purpose: a check added to selfAudit.ts later is not on it, and gets the door's
// own sentence. Failing closed means a new check can never leak on its first day.
const DETAIL_SAFE: ReadonlySet<string> = new Set([
  "schedule-vs-plan",
  "bar-vs-rows",
  "no-orphan-categories",
  "lines-sum-to-envelope",
  "settled-means-settled",
]);

/** What the door says when it will not forward the app's own words. Per check, per
 *  status, written here so every sentence in a reply has a source you can read. */
const CHECK_SAYS: Record<string, { ok: string; fail: string }> = {
  "schedule-vs-plan": {
    ok: "Your bills add up the same way on every screen.",
    fail: "Some bills add up differently on different screens. Open the app to see which.",
  },
  "bar-vs-rows": {
    ok: "Every budget line matches the charges behind it.",
    fail: "A budget line does not match the charges behind it. Open the app to see which.",
  },
  "no-orphan-categories": {
    ok: "Every category money went into is watched by a budget line.",
    fail: "Money went into a category nothing watches. Open the app to see which.",
  },
  "lines-sum-to-envelope": {
    ok: "The budget lines add up to the budget.",
    fail: "The budget lines do not add up to the budget.",
  },
  "splits-sum": {
    ok: "Every split charge adds up to what was paid.",
    fail: "Some split charges do not add up. Open the app to see which.",
  },
  "settled-means-settled": {
    ok: "Every bill marked paid was paid in full.",
    fail: "A bill is marked paid with money still owed. Open the app to see which.",
  },
  "one-payment-per-cycle": {
    ok: "No bill is recorded as paid twice.",
    fail: "A bill looks like it was paid for twice. Open the app to see which.",
  },
  "links-point-somewhere": {
    ok: "Every charge still points at something real.",
    fail: "Some charges point at something that was deleted. Open the app to see which.",
  },
};

const UNKNOWN_CHECK = {
  ok: "This check passed.",
  fail: "This check failed. Open the app to see why.",
};

function sayCheck(c: AuditCheck): { [k: string]: Json } {
  const says = CHECK_SAYS[c.id] ?? UNKNOWN_CHECK;
  const fallback = c.status === "fail" ? says.fail : says.ok;
  // The app's own wording when it is short enough to survive Rule 4's cap intact,
  // and the door's own when it is not. Never a sliced one: Rule 4 caps by DROPPING
  // what does not fit, because half a sentence about money is worse than none.
  const detail = DETAIL_SAFE.has(c.id) ? (scrub(c.detail) ?? fallback) : fallback;
  const out: { [k: string]: Json } = {
    id: c.id,
    question: scrubOr(c.question, "What this check compares is in the app."),
    status: c.status,
    detail,
  };
  if (c.a) out.a = { label: scrubOr(c.a.label, "one figure", LABEL_MAX), value: money(c.a.value) };
  if (c.b) out.b = { label: scrubOr(c.b.label, "the other", LABEL_MAX), value: money(c.b.value) };
  return out;
}

const financeAudit: Tool = {
  name: "finance.audit",
  summary: "Does the app disagree with itself? Runs every self-check and says which passed.",
  async run({ load, now }) {
    const data = await load.appData();
    const result = selfAudit(data, now);
    // Both figures come straight off the exported function rather than being
    // counted again here. They are DIFFERENT quantities and are named as such: the
    // check's own sentence counts broken LINKS (a row can dangle twice), this
    // counts the rows. Two spellings of one number is how this repo got five
    // different cycle keys.
    const { links, broken } = danglingLinks(data);
    return {
      clean: result.clean,
      failures: result.failures,
      checks: result.checks.map(sayCheck),
      links: { checked: links, rows_pointing_at_something_deleted: broken.length },
    };
  },
};

// ── finance.position ──────────────────────────────────────────────────────────
const financePosition: Tool = {
  name: "finance.position",
  summary: "How much cash there actually is right now, in total and per account.",
  async run({ load }) {
    const { accounts } = await load.appData();
    // No "posted" figure is invented. `balance` is already the bank's AVAILABLE
    // number and `pendingHold` is display-only — the cash total is already net of
    // it (src/lib/recurring.ts). Adding them to make a "posted" line would be the
    // door doing arithmetic, and it would overstate what there is.
    return {
      available: money(totalBalance(accounts)),
      still_processing: money(totalPendingHold(accounts)),
      note: "Available is what the bank says can be spent. The processing figure is already taken out of it, not on top.",
      accounts: cashAccounts(accounts).map((a) => ({
        name: scrubOr(a.name, "an account"),
        owner: scrubOr(a.owner, "the household", LABEL_MAX),
        balance: money(a.balance),
        still_processing: money(a.pendingHold ?? 0),
      })),
    };
  },
};

// ── finance.budget_status ─────────────────────────────────────────────────────
const financeBudgetStatus: Tool = {
  name: "finance.budget_status",
  summary: "What is left in the variable budget this pay cycle, in total and per line.",
  async run({ load, now }) {
    const data = await load.appData();
    // ONE call, not five. This tool used to hold its own copy of the sequence
    // buildVMs.ts runs — monthly envelope, this cycle's window, the cycle's
    // allowance, the cycle's graded spend, the per-category partition — and a copy
    // of a sequence drifts exactly the way a copy of a formula does, with the
    // arithmetic hidden in the ORDER of the calls. Rule 3: the assembly lives in
    // src/lib/headline.ts, which the screen calls too, so the number here is the
    // number there. `now` is handed in rather than read.
    const { cycle, target, spent, lines } = envelopeStatus(data.transactions, now);
    return {
      cycle: {
        start: cycle.start,
        end: cycle.end,
        label: scrubOr(cycle.label, `${cycle.start} to ${cycle.end}`),
        day: cycle.dayIndex,
        days: cycle.days,
      },
      envelope: { target: money(target), spent: money(spent), left: money(target - spent) },
      lines: lines.map((l) => ({
        key: l.key,
        label: scrubOr(l.label, l.key),
        target: money(l.target),
        spent: money(l.spent),
        left: money(l.target - l.spent),
      })),
      // The trap, travelling in the reply itself rather than only in API.md — the
      // assistant may have been given the openapi description and nothing else.
      // Reported as a monthly budget, every one of these figures is wrong by half.
      note: "This is a pay cycle, not a month: each target is one cycle's share of a monthly figure. A negative `left` means over by that much.",
    };
  },
};

// ── finance.debts ─────────────────────────────────────────────────────────────
const financeDebts: Tool = {
  name: "finance.debts",
  summary: "What is owed, in the order the plan attacks it, and the total.",
  async run({ load, now }) {
    const data = await load.appData();
    // The total comes off planMath, which is where the app's total comes from —
    // not from adding the balances up here. planMath is called exactly as
    // buildVMs calls it, except that the date is handed in rather than defaulted:
    // its default is the machine's local date, which in an edge function is UTC and
    // therefore tomorrow from 5 PM Arizona onward.
    const math = planMath(
      data.recurring,
      data.debts,
      sumTargets(LEAN_VARIABLE),
      isoDate(now),
      data.transactions,
    );
    return {
      // No payoff month and no debt-free date. payoffSchedule() takes seven
      // arguments the app assembles in a view module, so a door that assembled
      // them would be the door doing the arithmetic (Rule 3). It ships once that
      // assembly is a shared function.
      total: money(math.totalDebt),
      debts: orderedDebts(data.debts).map((d) => ({
        id: d.id,
        name: scrubOr(d.name, "a debt"),
        balance: money(d.balance),
        original_balance: money(d.originalBalance),
        apr: d.apr == null ? null : money(d.apr),
        min_payment: d.minPayment == null ? null : money(d.minPayment),
      })),
      // In the reply, not only in API.md, because API.md calls a made-up payoff date
      // "the single most tempting wrong number in this whole system" and an
      // assistant may be holding nothing but the openapi description. A balance and
      // an APR are exactly the two numbers it takes to invent one.
      note: "No payoff date, debt-free month or months-remaining is computed here. Do not work one out from the balance and the rate. A name may carry the last digits of a card: do not read them out.",
    };
  },
};

// ── finance.spend_by_category ─────────────────────────────────────────────────
/** How far back a window may reach. Two years is more history than the ledger has
 *  and more than any question asks for. */
const WINDOW_MAX_MONTHS = 24;

/**
 * The windows this tool will answer about, and why it is not any window.
 *
 * THE HOLE THIS ORIGINALLY CLOSED — AND WHY THE RULE OUTLIVED IT.
 *
 * This rule was written when `finance.search_transactions` was FORBIDDEN, on the
 * grounds that "returning individual ledger rows turns a chat into a copy of the
 * ledger". With a free choice of window, this tool rebuilt most of it: ask one day
 * at a time, and for most days a category's total IS one charge's exact amount on
 * its exact date. Measured against the household's own snapshot, 96 single-day calls
 * returned 246 (day, category, amount) cells and 157 of them were a single charge.
 * That was the banned tool, minus the merchant string, through a different door.
 *
 * HE HAS SINCE LIFTED THAT PROHIBITION, deliberately — see the note under ABSENT at
 * the bottom of this file. `finance.search_transactions` exists, and it answers "what
 * was that $47 on Tuesday" honestly, one charge at a time, with the cleaned
 * description the app itself shows. So this rule can no longer be justified by the
 * sentence above, and leaving that justification standing would be a rule resting on
 * a premise the project has abandoned — which is how a restriction turns into folklore.
 *
 * WHAT IT NOW RESTS ON, and it is enough on its own: a whole month, or a month so
 * far, is the grid every budget SCREEN uses. A total over "the last 30 days" is a
 * figure nothing in the app displays, so nobody can check it against anything — which
 * is Rule 3's argument, not a privacy one. Keeping the boundary also means the
 * reconstruction above is pointless rather than merely rude: a caller who wants
 * individual charges has a tool that gives them, said as charges, instead of building
 * them out of category totals that look like budget figures and are not.
 *
 * The mechanism is unchanged, because it was right for both reasons. A minimum LENGTH
 * would not do it — two windows one day apart can be subtracted, and 1–28 and 1–29
 * differ by exactly the 29th. Taking away the choice of BOUNDARY does: every
 * answerable window lines up on the same grid, so subtracting two of them gives
 * another month's total rather than one day's.
 *
 * WHAT IT COSTS: "the last 30 days" and "since Tuesday" cannot be asked. "This
 * month so far", "last month", "the last three months" and "August" all can, which
 * are the questions that actually get asked — and the pay-cycle question has its own
 * tool in `finance.budget_status`.
 *
 * WHAT IT DOES NOT CLOSE, said plainly: a category with only one charge in a whole
 * month still shows that charge's amount, dated no closer than the month. And asking
 * the same month-so-far window on two different days still shows the day between
 * them. The hourly read cap is what bounds the rest.
 */
function monthWindow(args: Record<string, unknown>, today: string): { from: string; to: string } {
  const from = dateArg(args, "from");
  const to = dateArg(args, "to");
  if (from.slice(8) !== "01") {
    throw new BadArgs(
      `from has to be the first of a month, like ${from.slice(0, 7)}-01. This door answers about whole months, or a month so far.`,
    );
  }
  if (from > to) throw new BadArgs("The window starts after it ends.");
  const endsMonth = to === lastDayOf(to.slice(0, 7));
  if (!endsMonth && to !== today) {
    throw new BadArgs(
      `to has to be the last day of a month (${lastDayOf(to.slice(0, 7))}) or today (${today}). This door answers about whole months, or a month so far.`,
    );
  }
  const months = monthsBetween(from.slice(0, 7), to.slice(0, 7)) + 1;
  if (months > WINDOW_MAX_MONTHS) {
    throw new BadArgs(`That window is ${months} months. I go back ${WINDOW_MAX_MONTHS} at most.`);
  }
  return { from, to };
}

/** Whole months from one "YYYY-MM" to another. */
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

const financeSpendByCategory: Tool = {
  name: "finance.spend_by_category",
  summary: "Where the money went over whole months — category totals only, never rows.",
  args: [
    {
      name: "from",
      type: "string",
      required: true,
      description: "First day of the window, YYYY-MM-DD. It has to be the first of a month.",
    },
    {
      name: "to",
      type: "string",
      required: true,
      description: "Last day of the window, YYYY-MM-DD, inclusive. The last day of a month, or today.",
    },
  ],
  async run({ load, now, args }) {
    // `now` is used for ONE thing: deciding whether `to` is today, so "this month so
    // far" can be asked. It never becomes part of an answer, which is why this tool
    // still gives the same numbers at any hour in any timezone.
    //
    // monthWindow already refuses a window that starts after it ends, so the
    // phase-2 branch's separate check here would have been the second spelling of
    // one rule.
    const { from, to } = monthWindow(args, isoDate(now));
    const data = await load.appData();
    // The month-key form of this function is deliberately not exposed: it is this one
    // with the days filled in, and one way in is one thing to get wrong.
    const totals = spentByCategoryBetween(data.transactions, from, to);
    // The KEYS of this object are `transactions.category_id`, straight out of the
    // database — and that column is plain text with no constraint on it, so it is
    // no more trusted than any other stored string even though the app only ever
    // writes a slug from its own list. This was the one string leaving the door
    // that nothing checked, which is exactly the "is this one safe?" judgement
    // call Rule 4 exists to remove.
    //
    // A category id is an IDENTIFIER, not prose, so it is recognised rather than
    // cleaned — the same reasoning as a tool name. Anything appended to a slug is
    // dropped whole, and a value with no slug at the front is reported under one
    // fixed key rather than under itself.
    //
    // Two ids that come back as the same key are ADDED, never overwritten. A
    // silently dropped total would make the spending smaller than it was, and this
    // is the tool whose whole job is where the money went.
    const out: { [k: string]: Json } = {};
    let unnamed = 0;
    for (const [catId, amount] of Object.entries(totals)) {
      const key = scrubName(catId, NAME_MAX);
      if (!key) unnamed += amount;
      else out[key] = money(((out[key] as number | null) ?? 0) + amount);
    }
    if (unnamed) out["(no category id I can say)"] = money(unnamed);
    return {
      from,
      to,
      totals: out,
      note: "Whole months only, so say the months you asked about. A category with nothing in it is absent, which means zero. The charges behind a total are not available here at all.",
    };
  },
};

// ── finance.worth_a_look ──────────────────────────────────────────────────────
const financeWorthALook: Tool = {
  name: "finance.worth_a_look",
  summary: "What looks off but is a judgement call — the rule, the money, and the charges it is standing on so you can act on it.",
  async run({ load, now }) {
    const data = await load.appData();
    // No dismissals are passed. The app remembers dismissals per phone, in that
    // phone's own storage, and a door has no phone — so this answers about the
    // whole ledger and says so, rather than pretending to know what he waved away.
    const suggestions = reviewLedger(data, now, new Set<string>());
    const { suggestions: shown, total, left_out } = redactSuggestions(suggestions, data);
    return {
      total,
      left_out,
      dismissals_known: false,
      note: "This lists everything, including anything already dismissed on a phone. A suggestion carrying `charges` can be ACTED ON: link one with finance.link_charge_to_bill on the write door, using the charge id and the `bill` id. Say what it is before you do it, and every write comes back with an undo token.",
      // Built key by key rather than spread, so nothing can ride along on a field
      // added to the engine's own type later.
      suggestions: shown.map((s) => {
        const o: { [k: string]: Json } = { rule: s.rule, kind: s.kind, sentence: s.sentence };
        if (s.amount != null) o.amount = s.amount;
        if (s.month) o.month = s.month;
        if (s.bill) o.bill = s.bill;
        if (s.count != null) o.count = s.count;
        // The rows behind the suggestion. Without these the two rules that matter
        // most — an unlinked bill payment, a charge that may be in twice — could
        // only say that something was wrong and never what, and the sentence they
        // used to end with ("open the app") names an app that is being retired.
        if (s.charges) o.charges = s.charges as unknown as Json;
        return o;
      }),
    };
  },
};

// ── finance.firepower ─────────────────────────────────────────────────────────
//
// THE THREE MONEY QUESTIONS BELOW WERE ABSENT FOR ONE REASON, and it was Rule 3:
// their inputs were assembled inside a screen. All three now import that assembly
// from src/lib/headline.ts through the generated copy, which is the same function
// the screen calls — so the figure spoken in a chat is the figure on his screen, and
// the generator plus the build check make "the same function" literal rather than a
// claim. Nothing below computes anything: every number is a field off what the
// assembly returned, passed through money().
//
// WHY THIS ONE NEEDED IT. The hero tile's firepower is NOT planMath's firepower. The
// screen applies two subtractions on top that planMath cannot see — month-to-date
// overspend against the lean budget, and cash out in categories no budget line
// grades — and then clamps at zero. A door that called planMath and stopped would
// have been honestly computed and roughly $700 out on the household's own snapshot.
const financeFirepower: Tool = {
  name: "finance.firepower",
  summary: "How much is free THIS month to aim at the debt, and what has already been taken out of it.",
  async run({ load, now }) {
    const data = await load.appData();
    const head = firepowerStatus(data, now);
    return {
      month: head.monthKey,
      // The tile's figure. Zero is a real answer and means nothing is available —
      // the two subtractions below are where that story is told.
      available: money(head.firepower),
      plan: {
        income: money(head.math.income),
        living: money(head.math.fixedNonDebt),
        budgeted_variable: money(head.math.variable),
        before_subtractions: money(head.math.firepower),
      },
      taken_out: {
        overspent_this_month: money(head.overspendThisMonth),
        outside_the_budget: money(head.outsideBudgetCash),
      },
      spent_this_month: money(head.spentThisMonth),
      monthly_budget: money(head.monthlyTarget),
      // Two traps in one note, because an assistant may be holding nothing but the
      // openapi description. The first is the horizon; the second is the one API.md
      // calls out on its own, and this is the figure most likely to be mistaken for
      // it: firepower LOOKS like spendable cash and is not.
      note: "A whole month, not a pay cycle, and not money in the account — it is what is free to aim at the debt. The household's cash floor is not in it and this door does not know it, so never answer 'you can spend this'. Zero means nothing is available; the two figures under taken_out are why.",
    };
  },
};

// ── finance.next_bills ────────────────────────────────────────────────────────
//
// Bills stay CALENDAR-MONTHLY in the app — rent really is due on the 1st — so this
// is deliberately not a re-scoped bill list. It answers the separate question a pay
// cycle raises: of the paycheck already in the account, how much is still spoken for
// before the next one arrives.
//
// A BILL IS NOT A CHARGE. Rule 2 of API.md forbids a merchant, a bank descriptor and
// a single charge; a bill row is none of those — he named it, the app's own screens
// show it, and `finance.audit` and `finance.worth_a_look` already say bill names. The
// amount is what the CALENDAR expects, not what any charge was.
const financeNextBills: Tool = {
  name: "finance.next_bills",
  summary: "What is still due before the next paycheck, and how much of it is already overdue.",
  async run({ load, now }) {
    const data = await load.appData();
    // THE STILL-CLEARING CHARGES, AND NOT load.pendingCharges(). That one reads
    // `pending_preview`, which holds charges the bank has reported that have NOT
    // entered the ledger — it is empty here and it is the wrong question. Rent paid
    // on the 1st is a real `transactions` row carrying `pending: true`, which is what
    // the app's own money maths excludes. Reading the other table found nothing and
    // reported rent overdue hours after it was paid.
    //
    // Signed the way pendingCover expects, which is the way a bank reports it:
    // negative is money going out. Transaction.amount is always positive and carries
    // its direction in `type`, so the sign is put back here rather than inside the
    // matcher, where it would be one more thing to get wrong.
    // ── AND THE CHARGE THAT HAS ALREADY POSTED ──────────────────────────────
    // `paying_now` below only sees a charge while it is PENDING, which is a window of
    // a day or three. The moment the bank posts it the cover vanishes and this tool
    // goes back to the word "overdue" — the same wrong answer, just later. Rent posts
    // two days after it is paid and stays unlinked until somebody links it.
    //
    // So the posted case is answered by the rule that already exists. W7 in
    // ledgerReview.ts offers a charge that looks like a bill nobody linked, and it is
    // already gated hard: the account arm's first version produced five suggestions,
    // all five false (99 Ranch Market against Grok AI), which is why it now demands
    // 1% on the amount and 3 days from the due day and DROPS a charge that fits two
    // bills rather than picking. A third spelling of bill-to-charge matching in this
    // file would drift from both of the two that exist.
    const unlinkedHits = new Map<string, { id: string; date: string; amount: number }>();
    for (const sug of reviewLedger(data, now, new Set<string>())) {
      if (sug.rule !== "W7") continue;
      const rid = sug.evidence.recurringId;
      const mk = sug.evidence.monthKey;
      const txId = sug.evidence.txnIds[0];
      const tx = txId ? data.transactions.find((t) => t.id === txId) : undefined;
      if (rid && mk && tx) unlinkedHits.set(`${rid}|${mk}`, { id: tx.id, date: tx.date, amount: tx.amount });
    }

    const pendingNow = data.transactions
      .filter((t) => t.pending)
      .map((t) => ({
        date: t.date,
        amount: t.type === "expense" ? -t.amount : t.amount,
        description: t.description,
        accountId: t.accountId ?? null,
      }));
    const { cycle, daysLeft, bills, total, overdueTotal } = billsBeforeNextPayday(
      monthGetter(data, now),
      now,
    );
    return {
      cycle: {
        start: cycle.start,
        end: cycle.end,
        label: scrubOr(cycle.label, `${cycle.start} to ${cycle.end}`),
        day: cycle.dayIndex,
        days: cycle.days,
        days_left: daysLeft,
      },
      total: money(total),
      // Named separately because it is a different kind of fact: not "coming up" but
      // "already past its date and still unpaid".
      overdue_total: money(overdueTotal),
      count: bills.length,
      bills: bills.map((b) => ({
        // The recurring row's id, spelled `bill` — the same word finance.worth_a_look
        // uses for the same thing, so one vocabulary covers both replies.
        bill: b.recurringId ?? null,
        name: scrubOr(b.name, "a bill"),
        amount: money(b.amount),
        // The resolved calendar date, carried out of dueBeforeNextPayday rather than
        // rebuilt here: the window crosses month boundaries, so a day number alone
        // cannot say which month it is in, and building the date here would be the
        // door assembling what the app already worked out.
        due: b.due,
        overdue: b.overdue,
        // The amount is a rolling average of real payments, not a contracted figure.
        estimate: b.variable,
        // ── PAID, OR JUST NOT SETTLED YET ───────────────────────────────────
        // A pending charge is excluded from every money figure in this app, on
        // purpose: a payment in flight can reverse, so counting it as spent would
        // be a guess dressed as a fact. That stays true — nothing here changes a
        // number. What it changes is the WORD. On 2026-10-02 this tool reported
        // rent "overdue" hours after it was paid, which is how somebody pays rent
        // twice.
        paying_now: (() => {
          const rec = data.recurring.find((r) => r.id === b.recurringId);
          const cover = coverFor(
            { name: b.name, amount: b.amount, due: b.due, accountId: rec?.accountId ?? null },
            pendingNow,
          );
          return cover ? { amount: money(cover.amount), on: cover.date, why: cover.why } : null;
        })(),
        // ── ALREADY LEFT THE ACCOUNT, JUST NOT TIED TO THE BILL ───────────────
        // Deliberately a DIFFERENT field from paying_now and a weaker claim than it.
        // A pending charge is a payment in flight. This is money that has already
        // gone — stronger evidence the bill is settled, and still not proof: it can
        // be a genuine second purchase at the same merchant for the same amount,
        // which is W7's own "CAN BE WRONG".
        //
        // It carries the charge id, so the answer can offer to fix itself with
        // finance.link_charge_to_bill rather than only describing the problem.
        maybe_already_paid: (() => {
          const hit = b.recurringId ? unlinkedHits.get(`${b.recurringId}|${b.due.slice(0, 7)}`) : undefined;
          return hit
            ? {
                charge: hit.id,
                amount: money(hit.amount),
                on: hit.date,
                why: "a charge on this bill's own account, for this amount, in this cycle, that nothing has tied to the bill",
              }
            : null;
        })(),
      })),
      // ── PER ACCOUNT, AND THIS IS THE POINT ─────────────────────────────────
      // A household total can be true and still hide the thing that matters. This
      // tool once answered "$0 due" — correctly — while the JOINT account held
      // $703.73 against rent of $1,726.88 due in two days. The money existed; it was
      // in the wrong account, and nothing here could see that because every bill's
      // paying account was null.
      //
      // `unassigned` is reported rather than folded into a total, because a bill
      // nobody has placed is a gap in the answer and should look like one.
      by_account: (() => {
        const byId = new Map(data.accounts.map((a) => [a.id, a]));
        const buckets = new Map<string, { owner: string; account: string; due: number; count: number }>();
        for (const b of bills) {
          const rec = data.recurring.find((r) => r.id === b.recurringId);
          const acct = rec?.accountId ? byId.get(rec.accountId) : undefined;
          const key = acct?.id ?? "unassigned";
          const row = buckets.get(key) ?? {
            owner: acct ? scrubOr(acct.owner, "someone") : "nobody has said",
            account: acct ? scrubOr(acct.name, "an account") : "no account set",
            due: 0,
            count: 0,
          };
          row.due += b.amount;
          row.count += 1;
          buckets.set(key, row);
        }
        return [...buckets.entries()].map(([id, r]) => ({
          account: id === "unassigned" ? null : id,
          owner: r.owner,
          name: r.account,
          // What that account actually holds, beside what is being asked of it. The
          // two numbers together are the thing a household total cannot say.
          balance: id === "unassigned" ? null : money(byId.get(id)?.balance ?? 0),
          due: money(r.due),
          count: r.count,
        }));
      })(),
      note: "OVERDUE MEANS NO CHARGE IS LINKED TO THIS CYCLE. It does not mean the money has not left — those are different facts and this tool only knows the first. Before saying anything is overdue, read `paying_now` and `maybe_already_paid`: the first is a payment still clearing, the second is money that has already gone out and was never tied to the bill. `maybe_already_paid` carries the charge id, so offer finance.link_charge_to_bill rather than telling him to pay it again. A bill carrying `paying_now` HAS BEEN PAID and is still clearing — say that, never \"overdue\". The figure beside it is unchanged on purpose: a pending payment can reverse, so it is not counted until it posts. The window opens when the current pay cycle opened, not today, so an unpaid bill whose date has already passed is still in here — it still has to come out of the check already banked. An estimate is a rolling average of what the bill has really been costing. This is not the whole month's bills. READ by_account BEFORE SAYING A TOTAL: a household total of $0 was once true while the joint account was $1,023 short of the rent coming out of it two days later.",
    };
  },
};

// ── finance.forecast ──────────────────────────────────────────────────────────
//
// WHY THE LOW POINT IS THE ANSWER AND THE SURPLUS IS NOT. A surplus is income minus
// outgoings inside one calendar month — but rent lands on the 1st, funded by the
// paycheck from the 31st of the month BEFORE. So the month that earns the money and
// the month that spends it are different months, and a healthy surplus can sit on top
// of cash already promised to a bill three days later. The running balance crosses
// that boundary; the surplus does not. Hence `low` per month, and `lowest` across the
// run, and both are read off the app's own walk rather than worked out here.
//
// NO PAYOFF DATE, and the omission is deliberate rather than an oversight. forecast()
// does set a flag on the month a simulated card balance clears, and this door does
// not forward it. `finance.debts` refuses a payoff month in so many words — API.md
// calls an invented one "the single most tempting wrong number in this whole system" —
// and handing the same month back from here, computed from a spending DIAL's opening
// position, would be that number wearing a projection's clothes.
//
// TWO OF THE FOUR ASSUMPTIONS WERE DIALS on a screen that no longer exists, so they
// come back in the reply. A projection whose spending figure is an assumption sitting
// beside bills measured from the bank has to say which half is which, or Rule 3 of
// API.md ("say which half is measured") cannot be obeyed by anything reading it.
const financeForecast: Tool = {
  name: "finance.forecast",
  summary: "The balance run forward month by month: the low point in each, and the worst one.",
  args: [
    {
      name: "months",
      type: "integer",
      required: false,
      description: `How many months, counting this one. Default ${FORECAST_MONTHS}.`,
    },
  ],
  async run({ load, now, args }) {
    const months = intArg(args, "months", FORECAST_MONTHS, 1, FORECAST_MONTHS);
    const data = await load.appData();
    const { plan, months: rows } = runForecast(data, now, months);
    // The single worst moment. Picked by the app's own reduction, not here: which
    // month is "worst" is a judgement (least cash? earliest of the tied ones?) and
    // two callers deciding it separately is how two answers appear.
    const worst = lowestPoint(rows);
    return {
      from: plan.startMonth,
      months: rows.map((m) => ({
        month: m.monthKey,
        label: scrubOr(m.label, m.monthKey),
        // The first row is THIS month counted from today forward, so its figures are
        // "what is left" and must never be compared against a whole month's.
        partial: !!m.partial,
        income: money(m.income),
        paychecks: m.incomeEvents,
        bills: money(m.bills),
        spend: money(m.spend),
        surplus: money(m.surplus),
        close: money(m.close ?? null),
        low: m.low ? { day: m.low.day, balance: money(m.low.balance) } : null,
      })),
      lowest: worst
        ? {
            month: worst.monthKey,
            label: scrubOr(worst.label, worst.monthKey),
            day: worst.day,
            balance: money(worst.balance),
          }
        : null,
      assumed: {
        spending_per_cycle: money(plan.opts.cycleSpend),
        // Zero means the ledger held no complete pay cycle to take a median from, so
        // the figure above is the app's fallback rather than their own history.
        median_of_past_cycles: money(plan.typicalCycle),
        complete_cycles_measured: plan.cycles.length,
        to_the_card_per_month: money(plan.opts.cardPay ?? null),
        opening_cash: money(plan.opts.openingCash ?? null),
      },
      note: "Bills and income are measured from the bank; the spending figure is an assumption, and it is in assumed — say which half is which. The low point is the number a monthly surplus cannot tell you, because rent on the 1st is paid out of the month before. The first month is only what is left of it. No payoff date, debt-free month or card-clear month is here: do not work one out.",
    };
  },
};

// ── health.macros_today ───────────────────────────────────────────────────────
const healthMacrosToday: Tool = {
  name: "health.macros_today",
  summary: "What is left to eat today against the macro target.",
  async run({ load, now, person }) {
    const date = isoDate(now);
    const [day, target] = await Promise.all([load.day(person, date), load.macroTarget(person)]);
    const eaten = dayTotals(day);
    const left = remaining(target, eaten);
    const macros = (m: { kcal: number; p: number; c: number; f: number }) => ({
      kcal: money(m.kcal),
      protein_g: money(m.p),
      carbs_g: money(m.c),
      fat_g: money(m.f),
    });
    return {
      person,
      date,
      target: macros(target),
      eaten: macros(eaten),
      remaining: macros(left),
      meals_logged: day.meals.length,
      // The honest footnote, and it is not cosmetic. Everything on the meal side is
      // keyed to the CALENDAR date, so a main meal at 1 AM is filed under the next
      // date. In the app he can page between two days and see it in a second; in a
      // chat he gets one number and no way to notice. A per-person day-start hour
      // is the real fix and it is app work; until then this says so out loud rather
      // than stating remaining calories with confidence and being wrong.
      note: "This is the calendar day in Arizona, so a night shift is split across two days: anything eaten after midnight counts against tomorrow.",
    };
  },
};

// ── health.weight_trend ───────────────────────────────────────────────────────
const healthWeightTrend: Tool = {
  name: "health.weight_trend",
  summary: "Which way the weight is going — latest, this week's average, and lb per week.",
  async run({ load, now, person }) {
    const entries = await load.weights(person);
    const today = isoDate(now);
    const week = currentWeekAvg(entries, today);
    const rate = ratePerWeek(entries);
    return {
      person,
      latest: money(latestWeight(entries)),
      week_avg: week ? money(week.avg) : null,
      week_count: week ? week.count : 0,
      // Null rather than 0 with fewer than two weigh-ins, and a sentence saying so:
      // "not enough to tell" and "holding steady" are different answers, and a 0
      // in a chat reads as the second one.
      lb_per_week: rate == null ? null : money(rate),
      note:
        rate == null
          ? "Not enough weigh-ins yet to say which way it is going."
          : "Negative means losing. It is a line fitted through every weigh-in, not the last two.",
    };
  },
};

// ── health.training_volume ────────────────────────────────────────────────────
const healthTrainingVolume: Tool = {
  name: "health.training_volume",
  summary: "Hard sets per muscle over the last few days, with the band each one sits in.",
  args: [{ name: "days", type: "integer", required: false, description: "How many days back, today included. Default 7." }],
  async run({ load, now, person, args }) {
    const days = intArg(args, "days", 7, 1, 90);
    const workouts = await load.workouts(person);
    const { byRegion, unplaced } = hardSetsByRegion(workouts, BUNDLED_EXERCISES, person, isoDate(now), days);
    // Body order, from the shared REGIONS list, and only the muscles with sets in
    // them. The screen sorts biggest-first for display; that ordering belongs to
    // the screen, so it is not repeated here.
    const regions = REGIONS.filter((r) => (byRegion[r.id] ?? 0) > 0).map((r) => ({
      id: r.id,
      muscle: scrubOr(REGION_BY_ID[r.id].en, r.id),
      hard_sets: money(byRegion[r.id] ?? 0),
      band: scrubOr(bandLabel(byRegion[r.id] ?? 0), "no band"),
    }));
    return {
      person,
      days,
      regions,
      sets_with_no_muscle_data: money(unplaced),
      note: "A set counts once for each muscle the lift works directly and half for each one it helps.",
    };
  },
};

// ── health.last_lift ──────────────────────────────────────────────────────────
const healthLastLift: Tool = {
  name: "health.last_lift",
  summary: "When this lift was last trained, the sets done, and the best set.",
  args: [{ name: "exercise", type: "string", required: true, description: "The lift's name, however he says it." }],
  async run({ load, person, args }) {
    const name = textArg(args, "exercise");
    const workouts = await load.workouts(person);
    // The library matches the name the way the app does — by id, then name, then
    // alias, then a normalised form — so "tricep pushdowns" and "triceps pushdown"
    // are one lift.
    const last = lastTime(workouts, person, name, BUNDLED_EXERCISES);
    const out: { [k: string]: Json } = {
      person,
      exercise: scrubOr(name, "that lift"),
      found: last !== null,
    };
    if (!last) {
      out.note = "No finished session with working sets of that lift.";
      return out;
    }
    const top = bestSet(last.sets);
    out.date = last.date;
    out.sets = last.sets.map((s) => ({
      weight_lb: money(s.weight),
      reps: s.reps,
      warmup: s.kind === "warmup",
    }));
    out.top_set = { weight_lb: money(top.weight), reps: top.reps, estimated_1rm_lb: money(top.e1rm) };
    out.note = "The estimated one-rep max is a formula, not a lift he has done.";
    return out;
  },
};

// ── health.next_workout ───────────────────────────────────────────────────────
//
// WHAT THIS TOOL DELIBERATELY DOES NOT DO. The plan asks "what am I training
// today", and the app has no answer to that: it lists the routines and he picks
// one. There is no rotation, no last-used marker, nothing that decides. A door that
// picked would be inventing a fact about his training and speaking it with the
// app's authority — the exact failure Rule 3 is about. So this hands over the
// routines and what he last lifted on each exercise, and says plainly that nothing
// picked.
const MAX_ROUTINES = 8;
const MAX_EXERCISES = 12;

const healthNextWorkout: Tool = {
  name: "health.next_workout",
  summary: "The routines to choose from, and what was lifted last time on each exercise.",
  async run({ load, person }) {
    const [custom, workouts] = await Promise.all([load.routines(person), load.workouts(person)]);
    // Seeds first, then his own — the same list the workout screen builds.
    const routines: Routine[] = [...SEED_ROUTINES[person], ...custom.filter((r) => r.person === person)];
    return {
      person,
      picks_one: false,
      note: "The app does not choose a routine; he does. This is the list, with what he lifted last time.",
      routines: routines.slice(0, MAX_ROUTINES).map((r) => ({
        id: r.id,
        name: scrubOr(r.name, "a routine"),
        meta: scrub(r.meta ?? "") ?? null,
        exercises: r.exercises.slice(0, MAX_EXERCISES).map((ex) => {
          const last = lastTime(workouts, person, ex.name, BUNDLED_EXERCISES);
          const top = last ? bestSet(last.sets) : null;
          return {
            name: scrubOr(ex.name, "a lift"),
            sets: ex.sets,
            reps: scrubOr(ex.reps, "as written in the app", LABEL_MAX),
            last_done: last ? last.date : null,
            last_top_set:
              top && last
                ? { weight_lb: money(top.weight), reps: top.reps, estimated_1rm_lb: money(top.e1rm) }
                : null,
          };
        }),
      })),
    };
  },
};

// ── schedule.list_reminders ───────────────────────────────────────────────────
//
// WHY A READ TOOL IS PART OF THE REMINDER STORY. Until this existed, an assistant
// could WRITE a reminder and had no way to see one, so a reminder set for the wrong
// hour could only be fixed in the database dashboard — the app has no reminders
// screen at all (nothing in `src/` reads the table). That also made
// `schedule.remind`'s own refusal untrue: it said "clear some in the app", and
// there is nothing in the app to clear them with.
//
// It is the same hole `finance.categorize_charge` still has and says so about: a
// write door that needs an id no read door hands out cannot be used. This closes it
// for reminders, which is why the write door's cancel and edit tools can exist.
//
// THE COUNTS ARE COUNTS, NOT MATHS. `total` is how many rows matched, `shown` is
// how many are in this reply. Rule 1 is about not re-deriving the household's
// FIGURES; the length of a list the door itself just filtered is not one of them.
const MAX_REMINDERS_PAGE = 50;
const DEFAULT_REMINDERS_PAGE = 20;
const MAX_REMINDERS_OFFSET = 500;

const scheduleListReminders: Tool = {
  name: "schedule.list_reminders",
  summary: "The reminders waiting to go off, with their ids and times.",
  args: [
    {
      name: "limit",
      type: "integer",
      required: false,
      description: `How many to return, 1 to ${MAX_REMINDERS_PAGE}. Default ${DEFAULT_REMINDERS_PAGE}.`,
    },
    {
      name: "offset",
      type: "integer",
      required: false,
      description: "How many to skip. Use next_offset from the previous reply.",
    },
  ],
  async run({ load, person, now, args }) {
    const limit = intArg(args, "limit", DEFAULT_REMINDERS_PAGE, 1, MAX_REMINDERS_PAGE);
    const offset = intArg(args, "offset", 0, 0, MAX_REMINDERS_OFFSET);
    const rows = await load.reminders(person);
    // "Pending" has ONE definition and it is not here — see reminders.ts. A second
    // spelling of it is how a cancelled reminder ends up invisible in this list and
    // still arriving on a lock screen.
    const pending = pendingFor(rows, person);
    const page = pending.slice(offset, offset + limit);
    const more = offset + page.length < pending.length;
    return {
      person,
      // Rule 5's habit, stated: the answer is about this Arizona day. A reply read
      // back tomorrow is a stale list of times.
      as_of: isoDate(now),
      total: pending.length,
      shown: page.length,
      offset,
      more,
      next_offset: more ? offset + page.length : null,
      reminders: page.map((r) => ({ ...describe(r, now) })),
      // No backticks in a sentence that leaves the door: scrub() removes them from
      // every string it cleans, and a door that emits a character its own cleaner
      // strips is saying one thing and checking another.
      note:
        "Only this person's reminders, and only the ones still waiting. A repeating one " +
        "shows the NEXT time it goes off, not the time it was first set for. Overdue " +
        "means its time has passed and it has not gone out — the 15-minute job is behind, " +
        "not that it was cancelled. Cancelling or changing one is the write door.",
    };
  },
};

// THE CATALOGUE. Every tool that exists, in the order an assistant meets them in the
// OpenAPI description. Add to it; never reorder to make room, and never take a name
// off it without moving that name into ABSENT below with a reason — "no such tool"
// has to be checkable against an intention rather than an oversight.
//
// It is also the ONE list this door's router, its OpenAPI description and API.md all
// come off. catalogue.ts turns it into entries, openapi.ts builds the served document
// from those, and tests/museCatalogue.test.ts fails if API.md's headings, either
// door's registry or either served document disagree by one name.
export const TOOLS: readonly Tool[] = [
  financeAudit,
  financePosition,
  financeBudgetStatus,
  financeFirepower,
  financeNextBills,
  financeForecast,
  financeDebts,
  financeSpendByCategory,
  financeWorthALook,
  healthMacrosToday,
  healthWeightTrend,
  healthTrainingVolume,
  healthLastLift,
  healthNextWorkout,
  scheduleListReminders,
  // Phase 2's parity, one file per domain so the phases can be read apart. Same Tool
  // shape, same rules, same handler. Appended rather than interleaved so the eleven
  // tools he has already read the wording of keep the order he read them in.
  ...FINANCE_TOOLS,
  ...HEALTH_READS,
  ...MEMORY_READ_TOOLS,
];

export const TOOL_BY_NAME: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * This door's half of the catalogue, normalised — the thing openapi.ts builds the
 * served document from, and the thing the cross-door test compares against API.md.
 *
 * It is derived from TOOLS above and validated by catalogueOf, which throws. So a
 * tool with a malformed name, an empty summary or a field spelled two ways fails at
 * module load: the door does not start rather than serving a description that is
 * subtly wrong about itself.
 */
export const CATALOGUE = catalogueOf(readEntries(TOOLS));

/**
 * What this door will never have, and why — the forbidden list, ABSENT rather than
 * disabled, and written down so "no such tool" can be checked against an intention
 * instead of an oversight.
 *
 * It is served at /muse-read/openapi.json's description and returned with a 404, so
 * an assistant that asks for one of these gets told no AND told why, rather than
 * improvising a way around it.
 */
export const ABSENT: readonly { name: string; why: string }[] = [
  {
    name: "raw bank descriptors (transactions.raw_description)",
    why:
      "The only string in a charge written verbatim by whoever sent the money, cleaned nowhere in " +
      "the app. Its one use is a disambiguation the app does in code, so nothing an assistant asks " +
      "needs it. Forbidden, not disabled: no tool reads the column.",
  },
  {
    name: "account and card numbers",
    why: "No tool reads them. Four digits of a card is four digits of a card; accounts are named.",
  },
  {
    name: "a payoff date, a debt-free month or a card-clear month",
    why: "No tool returns one and none may be worked out from a balance and a rate. finance.forecast simulates a card being paid down and deliberately does not forward the month it clears: that figure comes off a spending dial's opening position, and reading it out as a payoff date would be the most tempting wrong number in this system wearing a projection's clothes.",
  },
  {
    name: "disconnecting a bank",
    why:
      "It hard-deletes the accounts and their whole transaction history, and no undo can put real " +
      "bank history back. That takes a code he types in the app, not a chat message.",
  },
  {
    // Phase 1 said "no door has a delete verb", and that stopped being true the
    // day the write door grew one. It is stated accurately instead of quietly
    // dropped, because an assistant that reads a promise and finds the opposite
    // stops trusting the whole list. The write door deletes only where the row it
    // removes can be put back byte for byte; the one thing no undo can restore —
    // disconnecting the bank, which wipes the accounts and their whole transaction
    // history — takes a code he types, not a chat command.
    name: "anything that deletes beyond recovery",
    why:
      "Deleting lives on the write door, and only where the before-state was captured first so 'undo that' can put it back. The one thing no undo could restore is disconnecting the bank, which wipes every account and its whole history — that takes a code he types, not a chat command.",
  },
  {
    name: "asking about the other person",
    why: "Each key answers about its own owner. A key that could ask about both makes losing one phone cost two people's data.",
  },
  {
    name: "anything that writes",
    why: "This is the read door. It has no write verb at all. The write door has the changes, and every one of them records what it replaced.",
  },
  ...HEALTH_ABSENT,
];

/**
 * WHAT USED TO BE ON THIS LIST, AND WHY IT IS NOT — kept, because a reversal that
 * leaves no trace reads later as an oversight.
 *
 * `finance.search_transactions` and one charge by id were both forbidden in Phase 1,
 * in these words: "Returning individual ledger rows turns a chat into a copy of the
 * ledger. Forbidden, not disabled." That was a privacy judgement and it was HIS to
 * make. He has made it the other way, deliberately: the app shows him these rows,
 * and an assistant that cannot see a charge cannot answer "what was that $47 on
 * Tuesday", which is most of what he would ask. The trade he did NOT make is the
 * bank descriptor, which stays at the top of the list above.
 *
 * `finance.forecast` was written onto this list by the phase-2 finance branch, whose
 * reason was sound when it was written — the function existed and the screen it came
 * off did not, so a spoken number had nothing to be checked against. It came off
 * again at the merge rather than by a decision: main had already shipped the tool,
 * through the same fix that branch predicted (the assembly moved into
 * src/lib/headline.ts first). A name cannot be both absent and real, and
 * tests/museCatalogue.test.ts is what says so.
 */

