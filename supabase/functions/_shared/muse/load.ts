// What each tool needs, read once per request, paged and fail-closed.
//
// Lazy on purpose: a weigh-in question must not read the ledger, and a budget
// question must not read the workout log. Each loader is memoised for the life of
// one request, so a tool that needs both `transactions` and `recurring` reads each
// table exactly once, and so two numbers in one reply can never come from two
// different reads of the same table.
//
// Every read goes through readAll (Rule 5). If any of them cannot be read
// cleanly, the exception travels all the way out and the door answers with one
// sentence and no numbers — see handler.ts.

import type { AppData } from "./lib/types.ts";
import type { BodyWeight } from "./lib/weightLog.ts";
import type { DayLog, SavedMeal } from "./lib/mealLog.ts";
import type { Food, MacroTarget } from "./lib/nutrition.ts";
import { DAILY } from "./lib/nutrition.ts";
import type { Routine, Workout } from "./lib/workoutLog.ts";
import type { Db } from "./paging.ts";
import { readAll } from "./paging.ts";
import type { Person } from "./auth.ts";
import {
  toAppData,
  toBodyWeight,
  toDayLog,
  toFood,
  toMacroTarget,
  toReminder,
  toRoutine,
  toSavedMeal,
  toWorkout,
  type ReminderRow,
} from "./rows.ts";

/** Memoise one promise per key, so a repeated read is the same read. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= make());
}

export interface Loader {
  /** Everything the finance maths modules take. */
  appData(): Promise<AppData>;
  /** One person's weigh-ins, oldest first — the same filter and sort the weight
   *  screen applies before handing them to weightLog's functions. */
  weights(person: Person): Promise<BodyWeight[]>;
  /** One person's day of meals, or an empty day — the same fallback the app uses
   *  when no row exists yet for that date. */
  day(person: Person, date: string): Promise<DayLog>;
  /** The person's macro target, falling back to the plan's own DAILY constant —
   *  which is what the app does when the row is missing. */
  macroTarget(person: Person): Promise<MacroTarget>;
  /**
   * The macro target that is actually SAVED, or null when nobody has set one.
   *
   * macroTarget() above cannot answer this: it has already substituted the
   * starting plan's numbers, and "the target you chose" and "the numbers nobody
   * has touched" are different answers to say out loud. Same read, so asking for
   * both costs one query.
   */
  savedTarget(person: Person): Promise<MacroTarget | null>;
  /** One person's logged sessions. */
  workouts(person: Person): Promise<Workout[]>;
  /** One person's saved custom routines (the code-defined seeds are added by the
   *  tool, exactly as the workout screen adds them). */
  routines(person: Person): Promise<Routine[]>;
  /**
   * EVERY one of this person's meal days, keyed `person|date` — the shape
   * src/lib/adherence.ts takes, because that is the map HealthStore hands it.
   *
   * A whole-table read rather than a window, for the same reason the app does it:
   * a streak is defined by walking back until it breaks, so a window would decide
   * the answer by where it was cut. It is paged and fails closed like every other
   * read, and the table is one row per person per day.
   */
  days(person: Person): Promise<Map<string, DayLog>>;
  /** The household's saved meals, oldest first — the order the meal screen lists
   *  them in. Shared, not per person, which is what the table is. */
  savedMeals(): Promise<SavedMeal[]>;
  /** The household's own food library (the `foods` table). The bundled and seed
   *  tables are code and are added by the tool, exactly as the meal builder's
   *  buildLibrary() does. */
  foods(): Promise<Food[]>;
  /** One person's reminder list, newest due first. */
  reminders(person: Person): Promise<ReminderRow[]>;
}

export function createLoader(db: Db): Loader {
  const appData = once(async () => {
    // Ordered by `id` everywhere, because paging needs a total order and every one
    // of these tables has a uuid primary key. The app orders transactions by date
    // for display; none of the maths cares about row order, so the stable key wins.
    const [transactions, debts, goals, accounts, recurring, paidBills, merchantRules] =
      await Promise.all([
        readAll(db, { table: "transactions", orderBy: "id" }),
        readAll(db, { table: "debts", orderBy: "id" }),
        readAll(db, { table: "savings_goals", orderBy: "id" }),
        readAll(db, { table: "accounts", orderBy: "id" }),
        readAll(db, { table: "recurring", orderBy: "id" }),
        readAll(db, { table: "paid_bills", orderBy: "id" }),
        readAll(db, { table: "merchant_rules", orderBy: "id" }),
      ]);
    return toAppData({ transactions, debts, goals, accounts, recurring, paidBills, merchantRules });
  });

  const perPerson = <T>(make: (person: Person) => Promise<T>) => {
    const cache = new Map<Person, Promise<T>>();
    return (person: Person) => {
      const hit = cache.get(person);
      if (hit) return hit;
      const p = make(person);
      cache.set(person, p);
      return p;
    };
  };

  const weights = perPerson(async (person) => {
    const rows = await readAll(db, { table: "body_weights", orderBy: "id", eq: { person } });
    // Sorted by DATE here, not by the paging key: currentWeekAvg and latestWeight
    // read dates, and ratePerWeek sorts internally anyway. This is the same two
    // lines src/views/CalibrationGauge.tsx does before calling them.
    return rows.map(toBodyWeight).sort((a, b) => a.date.localeCompare(b.date));
  });

  const savedTarget = perPerson(async (person) => {
    const rows = await readAll(db, { table: "macro_targets", orderBy: "person", eq: { person } });
    const row = rows[0];
    return row ? toMacroTarget(row) : null;
  });

  const macroTarget = async (person: Person): Promise<MacroTarget> =>
    (await savedTarget(person)) ?? DAILY[person];

  const workouts = perPerson(async (person) => {
    const rows = await readAll(db, { table: "workouts", orderBy: "id", eq: { person } });
    return rows.map(toWorkout);
  });

  const routines = perPerson(async (person) => {
    const rows = await readAll(db, { table: "workout_routines", orderBy: "id", eq: { person } });
    return rows.map(toRoutine);
  });

  const allDays = perPerson(async (person) => {
    const rows = await readAll(db, { table: "meal_days", orderBy: "id", eq: { person } });
    const out = new Map<string, DayLog>();
    for (const r of rows) {
      const log = toDayLog(r);
      out.set(`${person}|${log.date}`, log);
    }
    return out;
  });

  const savedMeals = once(async () => {
    const rows = await readAll(db, { table: "saved_meals", orderBy: "id" });
    return rows.map(toSavedMeal);
  });

  const foods = once(async () => {
    const rows = await readAll(db, { table: "foods", orderBy: "id" });
    return rows.map(toFood);
  });

  const reminders = perPerson(async (person) => {
    const rows = await readAll(db, { table: "reminders", orderBy: "id", eq: { person } });
    // Sorted by when it is due, soonest first, which is the order a list of
    // reminders is read in. Paging ordered by `id` because that is the total order
    // the table has — see the note on appData.
    return rows.map(toReminder).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  });

  const days = new Map<string, Promise<DayLog>>();

  return {
    appData,
    weights,
    macroTarget,
    savedTarget,
    workouts,
    routines,
    days: allDays,
    savedMeals,
    foods,
    reminders,
    day(person, date) {
      const key = `${person}|${date}`;
      const hit = days.get(key);
      if (hit) return hit;
      const p = (async () => {
        const rows = await readAll(db, {
          table: "meal_days",
          orderBy: "id",
          eq: { person, date },
        });
        const row = rows[0];
        return row ? toDayLog(row) : { date, person, meals: [] };
      })();
      days.set(key, p);
      return p;
    },
  };
}
