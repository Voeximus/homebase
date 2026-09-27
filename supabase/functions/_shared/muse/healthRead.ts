// The health and workout half of the read door's catalogue.
//
// WHY THIS IS A SEPARATE FILE FROM tools.ts. Phase 1 exposed what was safe —
// five finance questions and five health ones. Phase 2's instruction is different
// and he wrote it himself: "Muse has to have every functionality given in the app
// and the app must become a database for patterns and information storage." So
// this file is the health side of PARITY: a tool for everything the Health screens
// can show, down to a single meal's items and a single set's reps.
//
// THE PRIVACY TRADE IS HIS, MADE DELIBERATELY. Phase 1 refused to return
// individual rows at all ("returning individual ledger rows turns a chat into a
// copy of the ledger"). That refusal stands for bank descriptors and it is gone
// for everything else, because he asked for it and because a meal he typed and a
// set he lifted are not a stranger's words. What has NOT changed is Rule 4: every
// string still goes out through scrub(), because a food name is still a string
// somebody typed and it still lands in an assistant's context.
//
// THE FIVE RULES STILL BIND, and each one bites somewhere below:
//   1  NO ARITHMETIC. Every macro total, every hard set, every streak, every
//      estimated max comes out of the app's own function in ./lib. The one
//      exception is the same one tools.ts already allows itself: `target − eaten`
//      on a day, which is remaining() out of mealLog.ts, so even that is imported.
//   2  NO CLOCKS. `now` arrives as an argument. Every date default below is
//      isoDate(now), never todayISO(), and every function that takes a `today`
//      gets one passed.
//   3  NO ASSEMBLING A FUNCTION'S INPUTS. Where the app assembles something in a
//      view module, the tool hands over the parts and says nothing picked — see
//      health.next_workout in tools.ts, which set that precedent.
//   4  EVERY STRING OUT IS SCRUBBED, including names from the app's own tables.
//   5  EVERY TABLE READ IS PAGED AND FAILS CLOSED. See load.ts / paging.ts.
//
// ONE THING THAT LOOKS LIKE A NUMBER AND IS NOT. `health.day` reports a day by
// its CALENDAR date in Arizona, so a meal eaten at 1 AM is filed under the next
// day. health.macros_today already says that out loud and every tool here repeats
// it, because in the app he can page between two days and see it in a second, and
// in a chat he cannot.

import {
  BadArgs,
  idArg,
  intArg,
  optDateArg,
  optTextArg,
  textArg,
  type Json,
  type Tool,
} from "./args.ts";
import { isoDate } from "./lib/format.ts";
import { LABEL_MAX, money, scrub, scrubOr } from "./scrub.ts";
import { contribution, dayTotals, mealTotals, remaining, searchFoods, buildLibrary } from "./lib/mealLog.ts";
import type { DayLog, LoggedItem, Meal } from "./lib/mealLog.ts";
import { unitFor, type Food } from "./lib/nutrition.ts";
import { BUNDLED_FOODS } from "./lib/foodData.ts";
import { adherenceStats, dayStatusOf, weeklyAdherence } from "./lib/adherence.ts";
import { bestSet, personalRecords, searchExercises, totalSets, workoutDuration, workoutVolume } from "./lib/workoutLog.ts";
import type { ExerciseEntry, SetEntry, Workout } from "./lib/workoutLog.ts";
import { BUNDLED_EXERCISES } from "./lib/exerciseData.ts";
import { e1rm, findExercise, isDone, isLogged, isWarmup, lastTime, recentRecords, repRecords } from "./lib/trainingMath.ts";

// ── caps ─────────────────────────────────────────────────────────────────────
//
// Every list this file returns is capped, and the reply says how many there were
// so a cut list is never mistaken for the whole of something. The caps are sized
// for a chat reply, not for the table: forty search hits is already more than an
// assistant will read out.
const MAX_MEALS = 30;
const MAX_ITEMS = 40;
const MAX_SEARCH = 25;
const MAX_WEIGHTS = 120;
const MAX_SESSIONS = 30;
const MAX_EXERCISES = 30;
const MAX_SETS = 40;
const MAX_RECORDS = 15;
const MAX_REMINDERS = 30;

/** The calendar-day footnote, said the same way everywhere it applies. */
const DAY_NOTE =
  "This is the calendar day in Arizona, so a night shift is split across two days: anything eaten after midnight counts against tomorrow.";

// ── shared shapes ────────────────────────────────────────────────────────────

const macros = (m: { kcal: number; p: number; c: number; f: number }): { [k: string]: Json } => ({
  kcal: money(m.kcal),
  protein_g: money(m.p),
  carbs_g: money(m.c),
  fat_g: money(m.f),
});

/**
 * Is this stored portion the shape the app's own maths can read?
 *
 * `meal_days.meals` and `saved_meals.items` are jsonb with no shape enforced by the
 * database, and contribution() reads `item.per100.kcal` — so one portion written by
 * an older app version, or one hand-edited row, throws a TypeError. In the app that
 * is a render crash somebody notices. Here it would take the whole day's answer down
 * with it, so the one bad portion is reported as unreadable and the rest is
 * answered. The alternative is a 503 that says the ledger could not be read, which
 * would be a different and untrue sentence.
 */
function readable(it: unknown): it is LoggedItem {
  if (!it || typeof it !== "object") return false;
  const item = it as LoggedItem;
  const per = item.per100;
  return (
    typeof item.grams === "number" &&
    !!per &&
    typeof per.kcal === "number" &&
    typeof per.p === "number" &&
    typeof per.c === "number" &&
    typeof per.f === "number"
  );
}

/** One logged portion, with what it actually contributes. `contribution()` is the
 *  app's own function — the door never multiplies grams by per-100g itself. */
function sayItem(stored: LoggedItem): { [k: string]: Json } {
  if (!readable(stored)) {
    // Typed as LoggedItem and not actually one — that is the whole point of the
    // check — so the two fields worth reporting are read defensively.
    const loose = stored as unknown as { id?: unknown; name?: unknown };
    return {
      id: typeof loose.id === "string" ? loose.id : null,
      name: scrubOr(loose.name, "a food"),
      grams: null,
      readable: false,
      note: "This portion is stored in a shape the app's own maths cannot read, so it counts toward nothing.",
    };
  }
  const item = stored;
  const c = contribution(item);
  const out: { [k: string]: Json } = {
    id: item.id,
    name: scrubOr(item.name, "a food"),
    grams: money(item.grams),
    ...macros(c),
  };
  if (item.qty != null && item.unit) {
    out.qty = money(item.qty);
    out.unit = scrubOr(item.unit.name, "each", LABEL_MAX);
  }
  return out;
}

function sayMeal(meal: Meal): { [k: string]: Json } {
  // Only the portions the maths can read are totalled, and the count of the others
  // goes out beside it — so a short total is never mistaken for a light meal.
  const good = meal.items.filter(readable);
  const out: { [k: string]: Json } = {
    id: meal.id,
    name: scrubOr(meal.name, "a meal"),
    ...macros(mealTotals({ ...meal, items: good })),
    items_total: meal.items.length,
    items: meal.items.slice(0, MAX_ITEMS).map(sayItem),
  };
  if (good.length !== meal.items.length) out.items_unreadable = meal.items.length - good.length;
  return out;
}

/** The day with unreadable portions taken out, so every function below it can be
 *  handed something its own maths can read. `unreadable` is reported rather than
 *  hidden: a total that is short because a row is broken is not a light day. */
function cleanDay(day: DayLog): { day: DayLog; unreadable: number } {
  let unreadable = 0;
  const meals = day.meals.map((m) => {
    const good = (m.items ?? []).filter(readable);
    unreadable += (m.items ?? []).length - good.length;
    return good.length === (m.items ?? []).length ? m : { ...m, items: good };
  });
  return { day: unreadable === 0 ? day : { ...day, meals }, unreadable };
}

function sayFood(f: Food): { [k: string]: Json } {
  const unit = unitFor(f);
  return {
    id: f.id,
    name: scrubOr(f.name, "a food"),
    role: scrubOr(f.role, "other", LABEL_MAX),
    per_100g: macros({ kcal: f.kcal, p: f.p, c: f.c, f: f.f }),
    serving_g: f.serving == null ? null : money(f.serving),
    // The countable unit the portion sheet offers, whether the row carried one or
    // nutrition.ts inferred it from the name. The door reports which, because
    // "1 egg = 50 g" being a guess is worth knowing before it is spoken.
    unit: unit ? { name: scrubOr(unit.name, "each", LABEL_MAX), grams: money(unit.grams) } : null,
    unit_is_a_guess: !!unit && !f.unit,
    note: scrub(f.note ?? "") ?? null,
    // Where it came from, so "delete that food" can refuse before it tries: only a
    // library row is his to delete, and the other two are code.
    source: f.custom ? "library" : f.id.startsWith("fdc-") ? "bundled" : "seed",
  };
}

/** One set, exactly as the logger stored it, plus which of the app's three rules
 *  it satisfies — done, working, counted. A reader that had to re-derive those
 *  would be re-implementing isDone/isWarmup/isLogged, which is Rule 1. */
function saySet(s: SetEntry): { [k: string]: Json } {
  return {
    id: s.id ?? null,
    reps: s.reps,
    weight_lb: money(s.weight),
    done: isDone(s),
    warmup: isWarmup(s),
    counts_as_a_hard_set: isLogged(s) && !isWarmup(s),
    estimated_1rm_lb: money(e1rm(s.weight, s.reps) ?? 0) || null,
  };
}

function sayExercise(entry: ExerciseEntry): { [k: string]: Json } {
  const lib = findExercise(BUNDLED_EXERCISES, entry.name, entry.exerciseId);
  const top = bestSet(entry.sets);
  return {
    id: entry.id,
    name: scrubOr(entry.name, "a lift"),
    // The library entry this resolves to, or null for a custom lift he typed. The
    // same identity trainingMath uses, so "Tricep pushdowns" and "Triceps
    // pushdown" answer as one exercise here too.
    library_id: lib ? lib.id : null,
    custom: !lib,
    muscle: scrubOr(entry.muscle, "unsaid", LABEL_MAX),
    duration_min: entry.duration == null ? null : money(entry.duration),
    hard_sets: entry.sets.filter((s) => isLogged(s) && !isWarmup(s)).length,
    top_set: top.reps > 0
      ? { weight_lb: money(top.weight), reps: top.reps, estimated_1rm_lb: money(top.e1rm) }
      : null,
    sets_total: entry.sets.length,
    sets: entry.sets.slice(0, MAX_SETS).map(saySet),
  };
}

function saySessionSummary(w: Workout): { [k: string]: Json } {
  return {
    id: w.id,
    date: w.date,
    name: scrubOr(w.name, "a session"),
    finished: w.done,
    hard_sets: totalSets(w),
    volume_lb: money(workoutVolume(w)),
    minutes: money(workoutDuration(w)),
    exercises: w.exercises.slice(0, MAX_EXERCISES).map((e) => scrubOr(e.name, "a lift")),
  };
}

/** This person's sessions, newest first. The store orders by date descending and
 *  so does the history screen; ties keep the order the table gave them. */
function newestFirst(workouts: Workout[], person: string): Workout[] {
  return workouts
    .filter((w) => w.person === person)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.date.localeCompare(a.w.date) || b.i - a.i)
    .map((x) => x.w);
}

// ── health.day ───────────────────────────────────────────────────────────────
//
// Phase 1's health.macros_today answers "what is left to eat today" and nothing
// else: one date, four numbers, a meal count. This is the whole day document —
// every meal, every portion in it, the day's status and note, and the target it
// is measured against. It is the tool three separate gaps in the plan needed: a
// day OTHER than today, the meals in it with their ids, and the status a nudge
// wrote. One tool, because they are one row.
const healthDay: Tool = {
  name: "health.day",
  summary: "One day of eating in full — every meal, every portion, the day's status, and what is left.",
  args: [{ name: "date", type: "string", required: false, description: "YYYY-MM-DD. Default today in Arizona." }],
  async run({ load, now, person, args }) {
    const date = optDateArg(args, "date", isoDate(now));
    const [raw, target] = await Promise.all([load.day(person, date), load.macroTarget(person)]);
    const { day, unreadable } = cleanDay(raw);
    const eaten = dayTotals(day);
    return {
      person,
      date,
      // Zero is the normal answer. Anything else means a stored portion is in a
      // shape the app's own maths cannot read, so the totals below are short by it.
      portions_unreadable: unreadable,
      // The app's own verdict on the day, not a re-derivation: "logged" means the
      // food covers enough of the target to count, "partial" means something was
      // logged and it does not. ADHERE_PCT lives in adherence.ts.
      day_status: dayStatusOf(day, target),
      marked: day.status ?? null,
      marked_note: scrub(day.note ?? "") ?? null,
      target: macros(target),
      eaten: macros(eaten),
      remaining: macros(remaining(target, eaten)),
      meals_total: day.meals.length,
      // The RAW meals, not the cleaned ones: sayMeal reports an unreadable portion
      // as itself, which is what makes it findable in the app.
      meals: raw.meals.slice(0, MAX_MEALS).map(sayMeal),
      note: DAY_NOTE,
    };
  },
};

// ── health.saved_meals ───────────────────────────────────────────────────────
const healthSavedMeals: Tool = {
  name: "health.saved_meals",
  summary: "The household's saved meals, with what each one comes to.",
  async run({ load }) {
    const meals = await load.savedMeals();
    return {
      total: meals.length,
      note: "Saved meals are shared by the household, not per person.",
      // Through sayMeal, which is the same shape a logged meal comes back as and
      // which reports an unreadable portion rather than throwing on it.
      meals: meals.slice(0, MAX_MEALS).map((m) => sayMeal({ id: m.id, name: m.name, items: m.items })),
    };
  },
};

// ── health.foods ─────────────────────────────────────────────────────────────
//
// The same library the meal builder searches, put together the same way:
// buildLibrary(bundled, custom) with custom first, then the curated seeds, then
// the bundled table, deduped by name. Searched by the app's own searchFoods, so a
// query that finds a food in the app finds it here.
//
// It is SEARCH-ONLY, and that is not a privacy fence — it is 878 bundled foods
// plus the seeds. A tool that returned the list would return a book.
const healthFoods: Tool = {
  name: "health.foods",
  summary: "Search the food library — the household's own foods first, then the built-in tables.",
  args: [
    { name: "query", type: "string", required: true, description: "What to search for. A number of 6+ digits searches barcodes." },
    { name: "limit", type: "integer", required: false, description: `How many hits, up to ${MAX_SEARCH}. Default 10.` },
  ],
  async run({ load, args }) {
    const query = textArg(args, "query", 80);
    const limit = intArg(args, "limit", 10, 1, MAX_SEARCH);
    const custom = await load.foods();
    const library = buildLibrary(BUNDLED_FOODS, custom);
    const hits = searchFoods(query, library, limit);
    return {
      query: scrubOr(query, "that"),
      library_total: library.length,
      household_foods: custom.length,
      found: hits.length,
      note: "Macros are per 100 g. The household's own foods win over a built-in one with the same name.",
      foods: hits.map(sayFood),
    };
  },
};

// ── health.macro_targets ─────────────────────────────────────────────────────
const healthMacroTargets: Tool = {
  name: "health.macro_targets",
  summary: "The daily macro target, and whether it was set or is still the plan's default.",
  async run({ load, person }) {
    // The loader falls back to nutrition.ts's DAILY when there is no row, exactly
    // as the app does. Which of the two it was matters to an assistant about to
    // say "your target is 2800": one is a number he chose and one is a starting
    // guess nobody has touched. So the door reads the library default too and
    // compares, rather than asking the loader to confess.
    const [target, saved] = await Promise.all([load.macroTarget(person), load.savedTarget(person)]);
    return {
      person,
      target: macros(target),
      was_set: saved !== null,
      note: saved !== null
        ? "This is the target saved in the app."
        : "Nobody has set a target, so this is the starting plan's own numbers.",
    };
  },
};

// ── health.weight_log ────────────────────────────────────────────────────────
//
// The weigh-in list itself, which health.weight_trend deliberately does not give:
// that tool answers "which way is it going" in three numbers. This one is the
// screen's list, newest first, so "what did I weigh on Tuesday" has an answer and
// so "delete that weigh-in" has a date to name.
const healthWeightLog: Tool = {
  name: "health.weight_log",
  summary: "The weigh-ins themselves, newest first.",
  args: [
    { name: "from", type: "string", required: false, description: "YYYY-MM-DD, oldest day to include." },
    { name: "to", type: "string", required: false, description: "YYYY-MM-DD, newest day to include." },
    { name: "limit", type: "integer", required: false, description: `How many, up to ${MAX_WEIGHTS}. Default 30.` },
  ],
  async run({ load, now, person, args }) {
    const today = isoDate(now);
    const from = optDateArg(args, "from", "0000-01-01");
    const to = optDateArg(args, "to", today);
    if (from > to) throw new BadArgs("The window starts after it ends.");
    const limit = intArg(args, "limit", 30, 1, MAX_WEIGHTS);
    // The loader hands them over oldest first, which is what the trend functions
    // want. A list a person reads goes the other way.
    const inWindow = (await load.weights(person)).filter((e) => e.date >= from && e.date <= to);
    return {
      person,
      from: from === "0000-01-01" ? null : from,
      to,
      total_in_window: inWindow.length,
      note: "One weigh-in per day. Logging that day again replaces it.",
      weights: inWindow
        .slice()
        .reverse()
        .slice(0, limit)
        .map((e) => ({ date: e.date, weight_lb: money(e.weight) })),
    };
  },
};

// ── health.adherence ─────────────────────────────────────────────────────────
//
// The streak and compliance card, from src/lib/adherence.ts — which was not in
// the door at all before this phase, so the streak he can see on his phone had no
// answer here. Every number comes out of adherenceStats and weeklyAdherence; the
// only thing the door does is hand them the map, the person, the day and the
// target, all four of which arrive rather than being made up.
const healthAdherence: Tool = {
  name: "health.adherence",
  summary: "The macro-plan streak, how many days were followed, and the last few weeks.",
  args: [
    { name: "days", type: "integer", required: false, description: "The window compliance is counted over. Default 30." },
    { name: "weeks", type: "integer", required: false, description: "How many Monday-to-Sunday weeks to show. Default 6." },
  ],
  async run({ load, now, person, args }) {
    const rangeDays = intArg(args, "days", 30, 1, 180);
    const weeks = intArg(args, "weeks", 6, 1, 26);
    const today = isoDate(now);
    const [byDate, target] = await Promise.all([load.days(person), load.macroTarget(person)]);
    const stats = adherenceStats(byDate, person, today, target, rangeDays);
    const buckets = weeklyAdherence(byDate, person, today, target, weeks);
    return {
      person,
      today,
      streak_days: stats.streak,
      followed: stats.followed,
      missed: stats.missed,
      compliance_pct: stats.compliancePct,
      window_days: rangeDays,
      recent: stats.recent.map((d) => ({ date: d.date, status: d.status })),
      weeks: buckets.map((w) => ({
        week_of: w.startDate,
        current: w.isCurrent,
        followed: w.followed,
        skipped: w.skipped,
        days_so_far: w.elapsed,
        pct: w.pct,
      })),
      note:
        "A day counts as followed when the food logged covers enough of that day's target, or when it was marked as followed-roughly. An unlogged day counts against the week.",
    };
  },
};

// ── health.workouts ──────────────────────────────────────────────────────────
const healthWorkouts: Tool = {
  name: "health.workouts",
  summary: "The training history — one line per session, newest first.",
  args: [
    { name: "from", type: "string", required: false, description: "YYYY-MM-DD, oldest day to include." },
    { name: "to", type: "string", required: false, description: "YYYY-MM-DD, newest day to include." },
    { name: "limit", type: "integer", required: false, description: `How many sessions, up to ${MAX_SESSIONS}. Default 10.` },
  ],
  async run({ load, now, person, args }) {
    const today = isoDate(now);
    const from = optDateArg(args, "from", "0000-01-01");
    const to = optDateArg(args, "to", today);
    if (from > to) throw new BadArgs("The window starts after it ends.");
    const limit = intArg(args, "limit", 10, 1, MAX_SESSIONS);
    const all = newestFirst(await load.workouts(person), person).filter((w) => w.date >= from && w.date <= to);
    const open = all.filter((w) => !w.done);
    return {
      person,
      from: from === "0000-01-01" ? null : from,
      to,
      total_in_window: all.length,
      // A session with done = false is one he started and has not finished. It is
      // the row health.log_sets writes into, so it is named rather than buried in
      // the list.
      unfinished: open.slice(0, MAX_SESSIONS).map((w) => ({ id: w.id, date: w.date, name: scrubOr(w.name, "a session") })),
      note: "Hard sets are ticked working sets with reps. Warm-ups and unticked rows are kept but not counted.",
      sessions: all.slice(0, limit).map(saySessionSummary),
    };
  },
};

// ── health.workout ───────────────────────────────────────────────────────────
const healthWorkout: Tool = {
  name: "health.workout",
  summary: "One session in full — every exercise, every set, and the notes on it.",
  args: [{ name: "id", type: "string", required: true, description: "The session id, from health.workouts." }],
  async run({ load, person, args }) {
    const id = idArg(args, "id");
    const w = (await load.workouts(person)).find((x) => x.id === id && x.person === person);
    if (!w) {
      const missing: { [k: string]: Json } = {
        found: false,
        note: "No session of yours has that id. It may have been deleted, or it may be the other person's.",
      };
      return missing;
    }
    const out: { [k: string]: Json } = {
      found: true,
      person,
      ...saySessionSummary(w),
      notes: scrub(w.notes) ?? null,
      exercises_total: w.exercises.length,
      exercises_logged: w.exercises.slice(0, MAX_EXERCISES).map(sayExercise),
    };
    return out;
  },
};

// ── health.exercise_progress ─────────────────────────────────────────────────
//
// Everything the exercise page shows for one lift: when it was last trained and
// the sets done, the heaviest weight at each rep target, and every session it
// appears in. All three come out of trainingMath — repRecords, lastTime and the
// same exKey identity, so a name spelled two ways is one lift here as well.
const healthExerciseProgress: Tool = {
  name: "health.exercise_progress",
  summary: "One lift over time — last time, the rep records, and the sessions it was in.",
  args: [
    { name: "exercise", type: "string", required: true, description: "The lift's name, however he says it." },
    { name: "limit", type: "integer", required: false, description: `How many past sessions, up to ${MAX_SESSIONS}. Default 6.` },
  ],
  async run({ load, person, args }) {
    const name = textArg(args, "exercise");
    const limit = intArg(args, "limit", 6, 1, MAX_SESSIONS);
    const workouts = await load.workouts(person);
    const lib = findExercise(BUNDLED_EXERCISES, name);
    const last = lastTime(workouts, person, name, BUNDLED_EXERCISES);
    const records = repRecords(workouts, person, name, BUNDLED_EXERCISES);
    // The sessions this lift appears in, using the library's identity rather than
    // a string compare — otherwise "Tricep pushdowns" would show half its history.
    const key = (entry: ExerciseEntry) => findExercise(BUNDLED_EXERCISES, entry.name, entry.exerciseId);
    const history = newestFirst(workouts, person)
      .filter((w) => w.done)
      .map((w) => ({ w, entries: w.exercises.filter((e) => (lib ? key(e)?.id === lib.id : e.name === name)) }))
      .filter((x) => x.entries.length > 0);
    return {
      person,
      exercise: scrubOr(lib ? lib.name : name, "that lift"),
      in_library: !!lib,
      library_id: lib ? lib.id : null,
      muscle: lib ? scrubOr(lib.muscle, "unsaid", LABEL_MAX) : null,
      last_done: last ? last.date : null,
      last_sets: last ? last.sets.map(saySet) : [],
      // Heaviest weight lifted for at least that many reps, ever. null = never.
      rep_records: {
        "1": money(records[1] ?? 0) || null,
        "3": money(records[3] ?? 0) || null,
        "5": money(records[5] ?? 0) || null,
        "8": money(records[8] ?? 0) || null,
        "10": money(records[10] ?? 0) || null,
        "12": money(records[12] ?? 0) || null,
      },
      sessions_total: history.length,
      sessions: history.slice(0, limit).map((x) => ({
        workout_id: x.w.id,
        date: x.w.date,
        exercises: x.entries.map(sayExercise),
      })),
      note: "An estimated one-rep max is a formula, not a lift he has done.",
    };
  },
};

// ── health.records ───────────────────────────────────────────────────────────
const healthRecords: Tool = {
  name: "health.records",
  summary: "Best lifts ever, and the sets that beat a record the day they were done.",
  args: [{ name: "limit", type: "integer", required: false, description: `How many of each, up to ${MAX_RECORDS}. Default 8.` }],
  async run({ load, person, args }) {
    const limit = intArg(args, "limit", 8, 1, MAX_RECORDS);
    const workouts = await load.workouts(person);
    const mine = workouts.filter((w) => w.person === person);
    return {
      person,
      best: personalRecords(mine, BUNDLED_EXERCISES).slice(0, limit).map((pr) => ({
        exercise: scrubOr(pr.name, "a lift"),
        muscle: scrubOr(pr.muscle, "unsaid", LABEL_MAX),
        weight_lb: money(pr.weight),
        reps: pr.reps,
        estimated_1rm_lb: money(pr.e1rm),
        date: pr.date,
      })),
      recent: recentRecords(workouts, person, BUNDLED_EXERCISES, limit).map((r) => ({
        exercise: scrubOr(r.name, "a lift"),
        weight_lb: money(r.weight),
        reps: r.reps,
        date: r.date,
      })),
      note:
        "A record is heavier than anything lifted for at least as many reps in an earlier session. The first session with a lift is a baseline, not a run of records.",
    };
  },
};

// ── health.exercises ─────────────────────────────────────────────────────────
//
// The library search the app's own sheet runs, so that logging sets can name a
// real lift. Without it the assistant would have to invent a name, and a name the
// library does not know is a lift with no muscles — which drops silently out of
// health.training_volume into `sets_with_no_muscle_data`.
const healthExercises: Tool = {
  name: "health.exercises",
  summary: "Search the exercise library by name, muscle or equipment.",
  args: [
    { name: "query", type: "string", required: true, description: "Name, muscle or equipment." },
    { name: "limit", type: "integer", required: false, description: `How many hits, up to ${MAX_SEARCH}. Default 10.` },
  ],
  async run({ args }) {
    const query = textArg(args, "query", 80);
    const limit = intArg(args, "limit", 10, 1, MAX_SEARCH);
    const hits = searchExercises(query, BUNDLED_EXERCISES, limit);
    return {
      query: scrubOr(query, "that"),
      library_total: BUNDLED_EXERCISES.filter((e) => !e.hidden).length,
      found: hits.length,
      note: "A lift that is not in here can still be logged by name, but it will not count toward any muscle.",
      exercises: hits.map((e) => ({
        id: e.id,
        name: scrubOr(e.name, "a lift"),
        muscle: scrubOr(e.muscle, "unsaid", LABEL_MAX),
        equipment: scrubOr(e.equipment, "unsaid", LABEL_MAX),
        type: e.type,
        logged_as: e.mode ?? (e.type === "cardio" ? "cardio" : "weighted"),
        works: (e.primary ?? []).map((r) => scrubOr(r, "a muscle", LABEL_MAX)),
        helps: (e.secondary ?? []).map((r) => scrubOr(r, "a muscle", LABEL_MAX)),
      })),
    };
  },
};

// ── schedule.reminders ───────────────────────────────────────────────────────
//
// The write door can CREATE a reminder and has never been able to list one, so
// "what reminders do I have" had no answer and "cancel that one" had no id. The
// message goes out as stored, marker and all, because the marker is the thing
// that says an assistant wrote it and Homebase did not.
const scheduleReminders: Tool = {
  name: "schedule.reminders",
  summary: "The reminders on the list, soonest first.",
  args: [
    { name: "include", type: "string", required: false, description: '"waiting" (default) or "all", which includes delivered ones.' },
    { name: "limit", type: "integer", required: false, description: `How many, up to ${MAX_REMINDERS}. Default 20.` },
  ],
  async run({ load, person, args }) {
    const include = optTextArg(args, "include", 16) || "waiting";
    if (include !== "waiting" && include !== "all") {
      throw new BadArgs('include is either "waiting" or "all".');
    }
    const limit = intArg(args, "limit", 20, 1, MAX_REMINDERS);
    const all = await load.reminders(person);
    // A repeating reminder never finishes, so `sent_at` stays null on it for ever
    // — which is right: it IS still waiting, every week.
    const shown = include === "all" ? all : all.filter((r) => r.sentAt === null);
    return {
      person,
      total: all.length,
      waiting: all.filter((r) => r.sentAt === null).length,
      note: "A daily or weekly reminder stays on the list for good. Homebase's cron delivers these within about 15 minutes of the time.",
      reminders: shown.slice(0, limit).map((r) => ({
        id: r.id,
        // Already capped and cleaned before it was stored, and cleaned again on
        // the way out, because Rule 4 does not make exceptions for our own rows.
        message: scrubOr(r.message, "a reminder", LABEL_MAX + 64),
        due_at: r.dueAt,
        repeats: scrubOr(r.repeats, "once", LABEL_MAX),
        delivered_at: r.sentAt,
        last_fired_at: r.lastSentAt,
        written_by: r.source === "muse" ? "an assistant" : "Homebase",
      })),
    };
  },
};

/** The health and workout half of the catalogue, in the order a person would ask:
 *  eating, then the body, then training, then the list of things to remember. */
export const HEALTH_READS: readonly Tool[] = [
  healthDay,
  healthSavedMeals,
  healthFoods,
  healthMacroTargets,
  healthWeightLog,
  healthAdherence,
  healthWorkouts,
  healthWorkout,
  healthExerciseProgress,
  healthRecords,
  healthExercises,
  scheduleReminders,
];

/**
 * What the health side of this door still will not do, and why.
 *
 * Merged into tools.ts's ABSENT list, so an assistant that asks for one of these
 * is told no AND told why in the same reply — the same treatment the finance side
 * already gets.
 */
export const HEALTH_ABSENT: readonly { name: string; why: string }[] = [
  {
    name: "health.solve_meal",
    why: "nutrition.ts can work out the grams of each food to hit a target, but the meal builder assembles its inputs on screen. A door that guessed them would hand back portions no screen agrees with.",
  },
  {
    name: "health.next_workout picking one",
    why: "The app does not choose a routine; he does. The tool lists them and says plainly that nothing picked.",
  },
  {
    name: "the other person's figures",
    why: "Every tool answers about whoever's key was used. There is no argument that aims one at the other person.",
  },
];
