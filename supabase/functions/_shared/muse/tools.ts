// The read door's catalogue, and nothing outside it exists. The finance and health
// tools are below; the memory store's three are registered from ./memoryTools.ts,
// so the count is whatever TOOLS holds rather than a number spelled in a comment
// that a later tool would make wrong.
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
// RULE 3 — no assembling a function's inputs. Where the app assembles something in
// a view module, the tool is NOT here: `finance.firepower` and `finance.next_bills`
// need src/lib/headline.ts to exist first, and `finance.forecast` needs the screen
// back before there is any ground truth to match. Their absence is deliberate and
// documented in ABSENT below.
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

import { selfAudit, danglingLinks, type AuditCheck } from "./lib/selfAudit.ts";
import {
  LEAN_VARIABLE,
  orderedDebts,
  planMath,
  payCycleFor,
  perCycle,
  lineSpent,
  sumTargets,
  spentByCategoryBetween,
  variableSpentBetween,
} from "./lib/plan.ts";
import { cashAccounts, totalBalance, totalPendingHold } from "./lib/recurring.ts";
import { isoDate } from "./lib/format.ts";
import { reviewLedger } from "./lib/ledgerReview.ts";
import { currentWeekAvg, latestWeight, ratePerWeek } from "./lib/weightLog.ts";
import { dayTotals, remaining } from "./lib/mealLog.ts";
import { bestSet, SEED_ROUTINES, type Routine } from "./lib/workoutLog.ts";
import { BUNDLED_EXERCISES } from "./lib/exerciseData.ts";
import { bandLabel, hardSetsByRegion, lastTime } from "./lib/trainingMath.ts";
import { REGIONS, REGION_BY_ID } from "./lib/muscleRegions.ts";
import { LABEL_MAX, NAME_MAX, money, scrub, scrubName, scrubOr } from "./scrub.ts";
import type { Loader } from "./load.ts";
import type { Person } from "./auth.ts";
import { redactSuggestions } from "./worthALook.ts";
import { BadArgs } from "./reply.ts";
// The memory store's three read tools. Their own file, so nothing about how a
// memory works lives in here and nothing about finance or health lives in there.
import { MEMORY_READ_TOOLS } from "./memoryTools.ts";
import type { Json } from "./reply.ts";

// `Json` and `BadArgs` moved to ./reply.ts when the memory store added a second
// tool file: two tool files importing them out of each other is an import cycle
// whose failure mode is an uninitialised binding at load time, not a compile
// error. They are re-exported here so handler.ts and the tests keep importing
// them from where they always did.
export type { Json } from "./reply.ts";
export { BadArgs };

export interface ToolContext {
  /** Forced from the secret. Never read from the request body — see ARGS below. */
  person: Person;
  /** The Arizona "now", built once per request. The door's only clock reading. */
  now: Date;
  load: Loader;
  args: Record<string, unknown>;
}

export interface Tool {
  name: string;
  /** One plain sentence, used in the catalogue and in the OpenAPI description. */
  summary: string;
  /**
   * The arguments, for the OpenAPI description and for the handler's own refusal
   * of a key that is not on the list. `person` is never one of them.
   *
   * `type` is declared HERE rather than guessed in openapi.ts, which used to read
   * `name === "days" ? "integer" : "string"`. That worked for the one integer
   * argument that exists and would have quietly described the next one as a
   * string — and the plan already names it (`finance.forecast`, months ahead). An
   * assistant told "string" sends "3", and intArg refuses it, and the refusal
   * reads like the assistant's mistake.
   */
  args?: { name: string; type: "string" | "integer"; required: boolean; description: string }[];
  run(ctx: ToolContext): Promise<{ [k: string]: Json }>;
}

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function dateArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !DATE.test(v)) {
    throw new BadArgs(`${name} has to be a date like 2026-09-01.`);
  }
  // A well-shaped string that is not a real day ("2026-02-31") would compare as a
  // string against real dates and quietly include or exclude a day. Checked
  // arithmetically rather than by building a Date, because building one here would
  // trip the door's own no-clocks guard for no reason.
  const [y, m, d] = v.split("-").map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1];
  if (m < 1 || m > 12 || d < 1 || !last || d > last) throw new BadArgs(`${v} is not a real date.`);
  return v;
}

function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const v = args[name];
  if (v == null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BadArgs(`${name} has to be a whole number between ${min} and ${max}.`);
  }
  return v;
}

function textArg(args: Record<string, unknown>, name: string, max = 64): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) throw new BadArgs(`${name} is missing.`);
  if (v.length > max) throw new BadArgs(`${name} is too long.`);
  return v.trim();
}

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
    // The identical sequence src/views/redesign/buildVMs.ts runs, with `now` handed
    // in instead of read: monthly envelope, this cycle's window, the cycle's
    // allowance, the cycle's graded spend, and the per-category partition the lines
    // read. Same functions, same order, so the numbers are the screen's numbers.
    const monthlyTarget = sumTargets(LEAN_VARIABLE);
    const cycle = payCycleFor(now);
    const target = perCycle(monthlyTarget);
    const spent = variableSpentBetween(data.transactions, cycle.start, cycle.end);
    const byCat = spentByCategoryBetween(data.transactions, cycle.start, cycle.end);
    return {
      cycle: {
        start: cycle.start,
        end: cycle.end,
        label: scrubOr(cycle.label, `${cycle.start} to ${cycle.end}`),
        day: cycle.dayIndex,
        days: cycle.days,
      },
      envelope: { target: money(target), spent: money(spent), left: money(target - spent) },
      lines: LEAN_VARIABLE.map((l) => {
        const lineTarget = perCycle(l.target);
        const lineSpend = lineSpent(l, byCat);
        return {
          key: l.key,
          label: scrubOr(l.label, l.key),
          target: money(lineTarget),
          spent: money(lineSpend),
          left: money(lineTarget - lineSpend),
        };
      }),
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
    };
  },
};

// ── finance.spend_by_category ─────────────────────────────────────────────────
const financeSpendByCategory: Tool = {
  name: "finance.spend_by_category",
  summary: "Where the money went over a window — category totals only, never rows.",
  args: [
    { name: "from", type: "string", required: true, description: "First day of the window, YYYY-MM-DD." },
    { name: "to", type: "string", required: true, description: "Last day of the window, YYYY-MM-DD, inclusive." },
  ],
  async run({ load, args }) {
    const from = dateArg(args, "from");
    const to = dateArg(args, "to");
    if (from > to) throw new BadArgs("The window starts after it ends.");
    const data = await load.appData();
    // Both ends come from the request, so the clock is not involved at all. The
    // month-key form of this function is deliberately not exposed: it is this one
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
    return { from, to, totals: out };
  },
};

// ── finance.worth_a_look ──────────────────────────────────────────────────────
const financeWorthALook: Tool = {
  name: "finance.worth_a_look",
  summary: "What looks off but is a judgement call — the rule and the money, never the charge.",
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
      note: "This lists everything, including anything already dismissed on a phone.",
      // Built key by key rather than spread, so nothing can ride along on a field
      // added to the engine's own type later.
      suggestions: shown.map((s) => {
        const o: { [k: string]: Json } = { rule: s.rule, kind: s.kind, sentence: s.sentence };
        if (s.amount != null) o.amount = s.amount;
        if (s.month) o.month = s.month;
        if (s.bill) o.bill = s.bill;
        if (s.count != null) o.count = s.count;
        return o;
      }),
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

export const TOOLS: readonly Tool[] = [
  financeAudit,
  financePosition,
  financeBudgetStatus,
  financeDebts,
  financeSpendByCategory,
  financeWorthALook,
  healthMacrosToday,
  healthWeightTrend,
  healthTrainingVolume,
  healthLastLift,
  healthNextWorkout,
  ...MEMORY_READ_TOOLS,
];

export const TOOL_BY_NAME: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

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
    name: "finance.search_transactions",
    why: "Returning individual ledger rows turns a chat into a copy of the ledger. Forbidden, not disabled.",
  },
  {
    name: "finance.forecast",
    why: "The function exists but the screen it came from does not, so there is nothing to check a spoken number against. It ships after the forecast screen is back.",
  },
  {
    name: "finance.firepower",
    why: "The screen's figure is planMath's firepower minus two subtractions made in a view module. Until that lives in a shared function, a door that computed it would disagree with his screen.",
  },
  {
    name: "finance.next_bills",
    why: "Its window is assembled in a view module, same reason as firepower.",
  },
  { name: "anything that writes", why: "This is the read door. It has no write verb at all." },
  {
    name: "anything that deletes beyond recovery",
    why:
      "A removal here is recorded with what it removed, so it can be put back. The one thing no undo could restore is disconnecting the bank, which wipes every account and its whole history — that takes a code he types, not a chat command.",
  },
  {
    name: "account numbers and bank descriptors",
    why: "No tool reads them. A charge's description never leaves either door under any name.",
  },
];
