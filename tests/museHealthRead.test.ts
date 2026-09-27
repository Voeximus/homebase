// ── Phase 2: the health and workout READS ─────────────────────────────────────
//
// Rule 1 for the twelve new read tools, and it is the rule this whole bridge exists
// for: every number is checked against the app's own function called directly on the
// same fixture, never against a literal. A literal passes for ever while the app's
// rule moves underneath it — which is how cron-notify came to tell the phones
// "Electric $85" while every screen in the app said $100, and in a chat there is no
// screen beside the number to notice.
//
// Rule 2 (no clocks), Rule 4 (every string scrubbed) and Rule 5 (paged, fails
// closed) are proved for the whole catalogue in tests/museRead.test.ts, which runs
// every tool — these twelve included — under UTC and under Arizona and seeds a
// canary descriptor, a URL and an injection line into the fixture. What is here is
// what that generic loop cannot see: whether each answer is the RIGHT answer.
//
// Only the paged table reader and the audit sink are faked, and both are seams the
// door defines itself. Every tool and every one of the app's maths modules runs for
// real.

import { describe, expect, it } from "vitest";
import { handleMuseRead } from "../supabase/functions/_shared/muse/handler.ts";
import type { Db as ReadDb, DbRow } from "../supabase/functions/_shared/muse/paging.ts";
import { adherenceStats, dayStatusOf, weeklyAdherence } from "../src/lib/adherence";
import { personalRecords, totalSets, workoutVolume } from "../src/lib/workoutLog";
import { lastTime, repRecords } from "../src/lib/trainingMath";
import { buildLibrary, mealTotals, searchFoods } from "../src/lib/mealLog";
import type { DayLog } from "../src/lib/mealLog";
import { BUNDLED_FOODS } from "../src/lib/foodData";
import { BUNDLED_EXERCISES } from "../src/lib/exerciseData";
import { DAILY } from "../src/lib/nutrition";
import type { ExerciseEntry, Workout } from "../src/lib/workoutLog";

// 1 Oct 2026, 05:00 UTC is 30 Sep 22:00 in Arizona — a different day AND a different
// month, which is the harshest thing a fired clock default can get wrong. The
// fixture below is dated so that Arizona's "today" is 2026-09-26; the instant is
// chosen the same way as tests/museWrite.test.ts so the two suites agree about which
// day the door thinks it is.
const AT = new Date("2026-09-27T02:00:00Z");
const TODAY = "2026-09-26";

const READ_SECRET = "gino-read-secret-that-is-long-enough-1234";
const HER_SECRET = "xinyan-read-secret-that-is-long-enough-1";

// ── the fixture ──────────────────────────────────────────────────────────────
// Snake_case, the way PostgREST hands rows back. Written once and copied per call,
// so a test that edits it cannot leak into the next one.

function readTables(): Record<string, DbRow[]> {
  return {
    accounts: [], transactions: [], recurring: [], debts: [], savings_goals: [],
    paid_bills: [], merchant_rules: [],
    body_weights: [
      { id: "w1", person: "gino", date: "2026-09-24", weight: "199.2" },
      { id: "w2", person: "gino", date: "2026-09-25", weight: "198.8" },
      { id: "w3", person: "gino", date: TODAY, weight: "198.4" },
    ],
    macro_targets: [{ person: "gino", kcal: "2800", p: "130", c: "410", f: "70" }],
    meal_days: [
      {
        id: "md1", person: "gino", date: TODAY,
        meals: [
          { id: "m1", name: "Breakfast", items: [{ id: "i1", foodId: "oats", name: "Oats", role: "carb", grams: 100, per100: { kcal: 379, p: 13, c: 67, f: 7 } }] },
          { id: "m2", name: "Lunch", items: [{ id: "i2", foodId: "chicken-breast", name: "Chicken breast", role: "protein", grams: 250, per100: { kcal: 165, p: 31, c: 0, f: 3.6 } }] },
        ],
      },
      // A day with no food and an explicit answer to the nudge, which is the only
      // thing that makes a mark count — and the pair of rows that makes the streak
      // and the compliance figure non-trivial.
      { id: "md2", person: "gino", date: "2026-09-25", meals: [], status: "estimated", note: "rice and chicken" },
      { id: "md3", person: "gino", date: "2026-09-24", meals: [], status: "skipped" },
    ],
    saved_meals: [
      { id: "sm1", name: "Usual breakfast", items: [{ id: "i3", foodId: "oats", name: "Oats", role: "carb", grams: 80, per100: { kcal: 379, p: 13, c: 67, f: 7 } }] },
    ],
    foods: [
      { id: "f1", name: "House protein bar", role: "protein", kcal: "380", p: "30", c: "40", f: "10", serving: "60", note: null, barcode: null },
    ],
    workouts: [
      {
        id: "wk-old", person: "gino", date: "2026-09-20", name: "Lower A", notes: "", done: true,
        exercises: [{ id: "e1", exerciseId: "", name: "Leg press", muscle: "legs", sets: [{ id: "s1", reps: 8, weight: 300 }] }],
      },
      {
        id: "wk-new", person: "gino", date: "2026-09-24", name: "Lower B", notes: "knees ok", done: true,
        exercises: [
          // A working set and a warm-up, so "stored but not counted" is testable.
          { id: "e2", exerciseId: "", name: "Leg press", muscle: "legs", sets: [{ id: "s2", reps: 8, weight: 320 }, { id: "s3", reps: 12, weight: 135, kind: "warmup" }] },
          // Timed work with no sets at all, which the counts must not trip over.
          { id: "e3", exerciseId: "", name: "Walking", muscle: "cardio", sets: [], duration: 20 },
        ],
      },
      { id: "wk-open", person: "gino", date: TODAY, name: "Upper A", notes: "", done: false, exercises: [] },
      // Hers. Every tool must answer about whoever's key was used and nobody else.
      {
        id: "wk-hers", person: "xinyan", date: TODAY, name: "Home strength", notes: "", done: true,
        exercises: [{ id: "e4", exerciseId: "", name: "Bodyweight squat", muscle: "legs", sets: [{ id: "s4", reps: 15, weight: 0 }] }],
      },
    ],
    workout_routines: [
      { id: "rt1", person: "gino", name: "My push day", meta: "", exercises: [{ name: "Leg press", muscle: "legs", sets: 3, reps: "6-10" }] },
    ],
    reminders: [
      { id: "rm1", person: "gino", due_at: "2026-10-01T16:00:00Z", repeats: "once", message: "Muse: read the electric bill", source: "muse", sent_at: null, last_sent_at: null },
      { id: "rm2", person: "gino", due_at: "2026-09-20T16:00:00Z", repeats: "once", message: "Muse: already gone", source: "muse", sent_at: "2026-09-20T16:05:00Z", last_sent_at: null },
    ],
  };
}

function readDb(tables: Record<string, DbRow[]>): ReadDb {
  return {
    select({ table, orderBy, eq }) {
      const rows = () =>
        (tables[table] ?? [])
          .filter((r) => Object.entries(eq ?? {}).every(([k, v]) => String(r[k]) === v))
          .slice()
          .sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
      return {
        count: () => Promise.resolve(rows().length),
        page: (from, to) => Promise.resolve(rows().slice(from, to + 1)),
      };
    },
  };
}

async function askRead(
  tool: string,
  body: Record<string, unknown> = {},
  tables = readTables(),
  secret = READ_SECRET,
) {
  const res = await handleMuseRead(
    new Request(`https://example.test/functions/v1/muse-read/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      db: readDb(tables),
      secrets: { gino: READ_SECRET, xinyan: HER_SECRET },
      at: AT,
      audit: { record: () => Promise.resolve() },
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The app's own inputs, built from the same fixture the door pages over — so the
 *  comparison is function against function and not function against a number
 *  somebody typed here. */
function appDays(tables = readTables()): Map<string, DayLog> {
  const out = new Map<string, DayLog>();
  for (const r of tables.meal_days) {
    const log: DayLog = {
      date: String(r.date),
      person: "gino",
      meals: (r.meals ?? []) as DayLog["meals"],
      status: (r.status ?? undefined) as DayLog["status"],
      note: (r.note ?? undefined) as string | undefined,
    };
    out.set(`gino|${log.date}`, log);
  }
  return out;
}

function appWorkouts(person: "gino" | "xinyan" | null = null, tables = readTables()): Workout[] {
  return tables.workouts
    .filter((w) => person === null || w.person === person)
    .map((w) => ({
      id: String(w.id),
      date: String(w.date),
      person: w.person as "gino" | "xinyan",
      name: String(w.name),
      notes: String(w.notes),
      exercises: w.exercises as ExerciseEntry[],
      done: !!w.done,
    }));
}

const TARGET = { kcal: 2800, p: 130, c: 410, f: 70 };

// ═════════════════════════════════════════════════════════════════════════════

describe("health.day — one day of eating, in full", () => {
  it("totals the day with the app's own function, and names the day it means", async () => {
    const { status, body } = await askRead("health.day");
    expect(status).toBe(200);
    const day = appDays().get(`gino|${TODAY}`)!;
    const eaten = day.meals.reduce(
      (a, m) => {
        const t = mealTotals(m);
        return { kcal: a.kcal + t.kcal, p: a.p + t.p };
      },
      { kcal: 0, p: 0 },
    );
    expect(body.date).toBe(TODAY);
    expect((body.eaten as { kcal: number }).kcal).toBeCloseTo(eaten.kcal, 2);
    expect((body.eaten as { protein_g: number }).protein_g).toBeCloseTo(eaten.p, 2);
    // Target minus eaten, from mealLog's own remaining().
    expect((body.remaining as { kcal: number }).kcal).toBeCloseTo(TARGET.kcal - eaten.kcal, 2);
    // The verdict comes off the app's adherence module, not off a threshold spelled
    // here — ADHERE_PCT lives there and this door must not have a second copy.
    expect(body.day_status).toBe(dayStatusOf(day, TARGET));
    expect(body.portions_unreadable).toBe(0);
    // The footnote that stops "you have 900 calories left" being wrong at 1 AM.
    expect(String(body.note)).toMatch(/calendar day in Arizona/i);
  });

  it("gives every meal its id, which is what every write on a meal takes", async () => {
    const { body } = await askRead("health.day");
    const meals = body.meals as { id: string; name: string; items: { id: string }[] }[];
    expect(meals.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(meals[0].items.map((i) => i.id)).toEqual(["i1"]);
    expect(body.meals_total).toBe(2);
  });

  it("reads a day other than today, which health.macros_today cannot", async () => {
    const { body } = await askRead("health.day", { date: "2026-09-25" });
    expect(body.date).toBe("2026-09-25");
    expect(body.marked).toBe("estimated");
    expect(body.marked_note).toBe("rice and chicken");
    expect(body.meals_total).toBe(0);
    expect(body.day_status).toBe("estimated");
  });

  it("refuses a well-shaped date that is not a real day", async () => {
    // "2026-02-31" would compare as a string against real dates and quietly include
    // or exclude a day.
    const { status, body } = await askRead("health.day", { date: "2026-02-31" });
    expect(status).toBe(400);
    expect(String(body.says)).toContain("not a real date");
  });

  it("reports a portion the app's own maths cannot read instead of failing the call", async () => {
    // meals is jsonb with no shape enforced, and contribution() reads
    // item.per100.kcal — one old or hand-edited row would otherwise take the whole
    // day's answer down with it and report it as an unreadable ledger, which would
    // be a different and untrue sentence.
    const tables = readTables();
    tables.meal_days = [
      { id: "md1", person: "gino", date: TODAY, meals: [{ id: "m1", name: "Old", items: [{ id: "x", name: "Oats", kcal: 300 }] }] },
    ];
    const { status, body } = await askRead("health.day", {}, tables);
    expect(status).toBe(200);
    expect(body.portions_unreadable).toBe(1);
    const items = (body.meals as { items: { readable?: boolean }[] }[])[0].items;
    expect(items[0].readable).toBe(false);
    // And the totals are honestly short rather than silently wrong.
    expect((body.eaten as { kcal: number }).kcal).toBe(0);
  });
});

describe("health.adherence — the streak and the weeks behind it", () => {
  it("matches adherenceStats and weeklyAdherence exactly", async () => {
    const { body } = await askRead("health.adherence");
    const stats = adherenceStats(appDays(), "gino", TODAY, TARGET, 30);
    const weeks = weeklyAdherence(appDays(), "gino", TODAY, TARGET, 6);
    expect(body.streak_days).toBe(stats.streak);
    expect(body.followed).toBe(stats.followed);
    expect(body.missed).toBe(stats.missed);
    expect(body.compliance_pct).toBe(stats.compliancePct);
    expect((body.recent as { status: string }[]).map((d) => d.status)).toEqual(stats.recent.map((d) => d.status));
    expect((body.weeks as { pct: number | null }[]).map((w) => w.pct)).toEqual(weeks.map((w) => w.pct));
  });

  it("says out loud that an unlogged day counts against the week", async () => {
    // Without this sentence a percentage reads as "days I logged", which is the
    // opposite of what the app means by it.
    const { body } = await askRead("health.adherence");
    expect(String(body.note)).toMatch(/unlogged day counts against/i);
  });

  it("honours the window it was asked for", async () => {
    const { body } = await askRead("health.adherence", { days: 2, weeks: 1 });
    expect(body.window_days).toBe(2);
    expect(body.weeks as unknown[]).toHaveLength(1);
    expect(body.followed).toBe(adherenceStats(appDays(), "gino", TODAY, TARGET, 2).followed);
  });
});

describe("health.weight_log — the weigh-ins themselves", () => {
  it("lists them newest first, inside the window asked for", async () => {
    const { body } = await askRead("health.weight_log", { from: "2026-09-25" });
    expect((body.weights as { date: string }[]).map((w) => w.date)).toEqual([TODAY, "2026-09-25"]);
    expect(body.total_in_window).toBe(2);
    expect((body.weights as { weight_lb: number }[])[0].weight_lb).toBe(198.4);
  });

  it("refuses a window that starts after it ends", async () => {
    const { status, body } = await askRead("health.weight_log", { from: TODAY, to: "2026-09-01" });
    expect(status).toBe(400);
    expect(String(body.says)).toMatch(/starts after it ends/i);
  });

  it("answers about whoever's key was used", async () => {
    const { body } = await askRead("health.weight_log", {}, readTables(), HER_SECRET);
    expect(body.person).toBe("xinyan");
    expect(body.weights as unknown[]).toHaveLength(0);
  });
});

describe("health.workouts and health.workout — the training history", () => {
  it("counts hard sets and tonnage with the app's own functions", async () => {
    const { body } = await askRead("health.workouts");
    const sessions = body.sessions as { id: string; hard_sets: number; volume_lb: number; minutes: number }[];
    // Newest first, and the unfinished one is a session like any other in the list.
    expect(sessions.map((s) => s.id)).toEqual(["wk-open", "wk-new", "wk-old"]);
    const app = appWorkouts("gino").find((w) => w.id === "wk-new")!;
    const row = sessions.find((s) => s.id === "wk-new")!;
    expect(row.hard_sets).toBe(totalSets(app));
    // Stated as well as derived: the warm-up is stored and not counted.
    expect(row.hard_sets).toBe(1);
    expect(row.volume_lb).toBe(workoutVolume(app));
    expect(row.minutes).toBe(20);
  });

  it("names the unfinished session separately, because that is the row sets are logged into", async () => {
    const { body } = await askRead("health.workouts");
    expect((body.unfinished as { id: string }[]).map((u) => u.id)).toEqual(["wk-open"]);
  });

  it("shows only this person's sessions", async () => {
    const { body } = await askRead("health.workouts");
    expect((body.sessions as { id: string }[]).map((s) => s.id)).not.toContain("wk-hers");
    const hers = await askRead("health.workouts", {}, readTables(), HER_SECRET);
    expect((hers.body.sessions as { id: string }[]).map((s) => s.id)).toEqual(["wk-hers"]);
  });

  it("says of each set whether it counts, using the app's rules rather than a reader's", async () => {
    const { body } = await askRead("health.workout", { id: "wk-new" });
    expect(body.found).toBe(true);
    const sets = (body.exercises_logged as { sets: { id: string; warmup: boolean; counts_as_a_hard_set: boolean }[] }[])[0].sets;
    expect(sets.find((s) => s.id === "s2")!.counts_as_a_hard_set).toBe(true);
    expect(sets.find((s) => s.id === "s3")!.warmup).toBe(true);
    expect(sets.find((s) => s.id === "s3")!.counts_as_a_hard_set).toBe(false);
  });

  it("marks a lift the library does not know as custom, because that changes what the volume means", async () => {
    const { body } = await askRead("health.workout", { id: "wk-new" });
    const walking = (body.exercises_logged as { name: string; custom: boolean; duration_min: number | null }[])
      .find((e) => e.name === "Walking")!;
    expect(walking.duration_min).toBe(20);
    // Walking IS in the library, so this one is not custom — the assertion is that
    // the field reports the library's answer rather than a guess.
    expect(walking.custom).toBe(false);
  });

  it("does not say whose a session is when it is not yours", async () => {
    const { body } = await askRead("health.workout", { id: "wk-hers" });
    expect(body.found).toBe(false);
    expect(String(body.note)).not.toMatch(/xinyan/i);
  });

  it("refuses an id that is not shaped like one", async () => {
    const { status } = await askRead("health.workout", { id: "not an id at all!" });
    expect(status).toBe(400);
  });
});

describe("health.exercise_progress and health.records", () => {
  it("matches repRecords and lastTime for one lift", async () => {
    const { body } = await askRead("health.exercise_progress", { exercise: "leg press" });
    const workouts = appWorkouts();
    const records = repRecords(workouts, "gino", "Leg press", BUNDLED_EXERCISES);
    const last = lastTime(workouts, "gino", "Leg press", BUNDLED_EXERCISES)!;
    expect(body.last_done).toBe(last.date);
    expect((body.rep_records as Record<string, number | null>)["8"]).toBe(records[8]);
    expect((body.rep_records as Record<string, number | null>)["12"]).toBe(records[12]);
    expect(body.in_library).toBe(true);
    expect(body.sessions_total).toBe(2);
  });

  it("finds the same lift however he says it", async () => {
    const one = await askRead("health.exercise_progress", { exercise: "Leg press" });
    const two = await askRead("health.exercise_progress", { exercise: "leg press" });
    expect(two.body.last_done).toBe(one.body.last_done);
    expect(two.body.library_id).toBe(one.body.library_id);
  });

  it("says when a lift is not in the library at all", async () => {
    const { body } = await askRead("health.exercise_progress", { exercise: "Zercher good morning thing" });
    expect(body.in_library).toBe(false);
    expect(body.last_done).toBeNull();
    expect(body.sessions_total).toBe(0);
  });

  it("matches personalRecords", async () => {
    const { body } = await askRead("health.records");
    const prs = personalRecords(appWorkouts("gino"), BUNDLED_EXERCISES);
    const best = body.best as { weight_lb: number; reps: number; exercise: string }[];
    expect(best).toHaveLength(prs.length);
    expect(best[0].weight_lb).toBe(prs[0].weight);
    expect(best[0].reps).toBe(prs[0].reps);
    // The sentence that stops a formula being read as a lift he has done.
    expect(String(body.note)).toMatch(/earlier session/i);
  });
});

describe("health.foods and health.exercises — the two libraries", () => {
  it("searches the same food library the meal builder searches, assembled the same way", async () => {
    const { body } = await askRead("health.foods", { query: "protein bar" });
    const custom = [{
      id: "f1", name: "House protein bar", role: "protein" as const,
      kcal: 380, p: 30, c: 40, f: 10, serving: 60, custom: true,
    }];
    const expected = searchFoods("protein bar", buildLibrary(BUNDLED_FOODS, custom), 10);
    expect((body.foods as { name: string }[]).map((f) => f.name)).toEqual(expected.map((f) => f.name));
    expect(body.household_foods).toBe(1);
  });

  it("says where a food came from, so a delete can be refused before it is tried", async () => {
    const mine = await askRead("health.foods", { query: "House protein bar" });
    expect((mine.body.foods as { source: string }[])[0].source).toBe("library");
    const seeded = await askRead("health.foods", { query: "Chicken breast" });
    expect((seeded.body.foods as { source: string }[])[0].source).toBe("seed");
  });

  it("reports whether a countable unit was read off the row or inferred from the name", async () => {
    const { body } = await askRead("health.foods", { query: "eggs" });
    const egg = (body.foods as { name: string; unit: { grams: number } | null; unit_is_a_guess: boolean }[])
      .find((f) => f.name === "Eggs")!;
    expect(egg.unit?.grams).toBe(50);
    expect(egg.unit_is_a_guess).toBe(false);
  });

  it("finds a lift in the exercise library and says how it is logged", async () => {
    const { body } = await askRead("health.exercises", { query: "leg press" });
    const hits = body.exercises as { name: string; logged_as: string; works: string[] }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe("Leg press");
    expect(hits[0].logged_as).toBeTruthy();
    expect(hits[0].works.length).toBeGreaterThan(0);
  });

  it("refuses a search with nothing in it rather than answering about everything", async () => {
    const { status } = await askRead("health.exercises", { query: "   " });
    expect(status).toBe(400);
  });
});

describe("health.macro_targets and health.saved_meals", () => {
  it("says whether the target was ever set, or is still the starting plan's", async () => {
    const set = await askRead("health.macro_targets");
    expect(set.body.was_set).toBe(true);
    expect((set.body.target as { kcal: number }).kcal).toBe(2800);

    const tables = readTables();
    tables.macro_targets = [];
    const unset = await askRead("health.macro_targets", {}, tables);
    expect(unset.body.was_set).toBe(false);
    // The app's own fallback, not a number spelled here.
    expect((unset.body.target as { kcal: number }).kcal).toBe(DAILY.gino.kcal);
    expect(String(unset.body.note)).toMatch(/starting plan/i);
  });

  it("gives each saved meal its id and what it comes to", async () => {
    const { body } = await askRead("health.saved_meals");
    const meals = body.meals as { id: string; kcal: number; items_total: number }[];
    expect(meals.map((m) => m.id)).toEqual(["sm1"]);
    expect(meals[0].kcal).toBeCloseTo(379 * 0.8, 2);
    expect(meals[0].items_total).toBe(1);
    // Shared by the household, and said so — a per-person answer here would be wrong.
    expect(String(body.note)).toMatch(/shared by the household/i);
  });
});

describe("schedule.reminders — what is on the list", () => {
  it("lists the waiting ones by default and all of them on request", async () => {
    const waiting = await askRead("schedule.reminders");
    expect((waiting.body.reminders as { id: string }[]).map((r) => r.id)).toEqual(["rm1"]);
    expect(waiting.body.total).toBe(2);
    expect(waiting.body.waiting).toBe(1);

    const all = await askRead("schedule.reminders", { include: "all" });
    expect((all.body.reminders as { id: string }[]).map((r) => r.id)).toEqual(["rm2", "rm1"]);
  });

  it("keeps the marker on, because it is what says an assistant wrote it", async () => {
    const { body } = await askRead("schedule.reminders");
    expect((body.reminders as { message: string; written_by: string }[])[0].message).toMatch(/^Muse: /);
    expect((body.reminders as { written_by: string }[])[0].written_by).toBe("an assistant");
  });

  it("refuses an include it does not understand rather than guessing", async () => {
    const { status, body } = await askRead("schedule.reminders", { include: "everything" });
    expect(status).toBe(400);
    expect(String(body.says)).toMatch(/waiting/i);
  });

  it("answers about whoever's key was used", async () => {
    const { body } = await askRead("schedule.reminders", {}, readTables(), HER_SECRET);
    expect(body.person).toBe("xinyan");
    expect(body.total).toBe(0);
  });
});
