// Everything an assistant may change on the health and workout side, and the
// inverse of every one of them.
//
// WHAT CHANGED FROM PHASE 1, AND WHY
//
// Phase 1 allowed three health writes and made a fourth (`health.log_meal`) wait
// for a tap in the app. His instruction for this phase is his own sentence: "Muse
// has to have every functionality given in the app and the app must become a
// database for patterns and information storage." So the rule flipped from "expose
// what is safe" to "expose everything, and make every change reversible", and his
// justification is sound: Homebase never moves money — it records, categorises and
// computes — so the worst a wrong write does is make data wrong, and wrong data can
// be undone as long as what was there first was written down.
//
// THE QUEUE HAD TO GO, AND NOT ONLY BECAUSE HE PREFERS IT. Nothing in src/ reads
// `muse_pending` — `grep -rn "muse_pending" src/` finds nothing — so a queued row
// sat there until cron-reminders marked it expired a day later. The tap it was
// waiting for does not exist. Direct with a captured before-state is the version
// that does something at all.
//
// THE TWO DOCUMENT RACES ARE THE REAL HAZARD HERE, not the writes themselves.
// A meal day is ONE json document per person per date and a session is ONE json
// document, so every write replaces the whole thing — and both phones are in this
// app at the same time. So every write below goes through editDay or editSession,
// which read the document IMMEDIATELY before writing and only land if its
// `updated_at` is still the value they read. And every undo is SURGICAL: it removes
// the meal or the sets this door added, or puts back the one object it changed. It
// never restores a snapshot of a whole document, because a snapshot would erase
// whatever the phone logged in between — which is the bug the undo is supposed to
// be protection against, not a new instance of it.
//
// THE FIVE RULES STILL BIND
//   1  NO ARITHMETIC. Every set, portion and total below comes out of a function
//      the screens use: itemFromFood / itemFromTotals / mealTotals in mealLog,
//      editLoggedSet / finishWorkout / sessionCounts in sessionOps. Two rules that
//      existed only inside view files were MOVED into those modules for this phase
//      rather than copied here.
//   2  NO CLOCKS. `ctx.at` and `ctx.az` arrive built. Nothing here reads one.
//   3  NO ASSEMBLING A FUNCTION'S INPUTS. Where an amount or a set shape is a rule,
//      it is imported. The one rule re-stated in this file is `loggedSet` below,
//      and tests/museHealth.test.ts asserts it against the app's own copyLastSet.
//   4  EVERY STRING IS SCRUBBED on the way in as well as on the way out. A food
//      name an assistant heard over a phone line is going into a database row.
//   5  NO UNBOUNDED READ. Every read below is one row, a count, or a bounded list.

import type { Json } from "../_shared/muse/args.ts";
import { azDateISO, daysBetweenISO, isDateISO } from "../_shared/muse/az.ts";
import { scrubCap } from "../_shared/muse/scrub.ts";
import type { FoodRow, MacroRow, MealDayRow, RoutineRow, WorkoutRow } from "./db.ts";
import {
  DISPLAY,
  ROW_ID,
  dateFor,
  isObject,
  money,
  refuse,
  type Ctx,
  type Refusal,
  type Success,
  type Tool,
  type ToolOutcome,
} from "./kit.ts";
import type { UndoHandler, UndoRecord, UndoRegistry } from "./undoContract.ts";
import {
  gramsOf,
  itemFromFood,
  itemFromServing,
  itemFromTotals,
  mealTotals,
  type Amount,
  type LoggedItem,
  type Meal,
} from "../_shared/muse/lib/mealLog.ts";
import { SEED_FOODS, unitFor, type Food, type FoodRole } from "../_shared/muse/lib/nutrition.ts";
import { BUNDLED_FOODS } from "../_shared/muse/lib/foodData.ts";
import { BUNDLED_EXERCISES } from "../_shared/muse/lib/exerciseData.ts";
import { findExercise } from "../_shared/muse/lib/trainingMath.ts";
import {
  SEED_ROUTINES,
  type ExerciseEntry,
  type Routine,
  type RoutineExercise,
  type SetEntry,
  type Workout,
} from "../_shared/muse/lib/workoutLog.ts";
import { editLoggedSet, finishWorkout, sessionCounts } from "../_shared/muse/lib/sessionOps.ts";

// ── caps ─────────────────────────────────────────────────────────────────────
/** How many times a document write is retried when the phone wins the race. */
const MAX_ATTEMPTS = 3;
/** Foods in one meal, sets in one call, exercises in one logged session. */
const MAX_ITEMS = 12;
const MAX_SETS = 20;
const MAX_ENTRIES = 15;
/** The longest a name, note or session title may be once cleaned. */
const NAME_CAP = 60;
const NOTE_CAP = 200;
/** How far back a NEW entry may be dated, per kind of thing. A weigh-in three
 *  months old is a typo far more often than a memory; a workout is not — he logs a
 *  session he forgot to start, and the history editor lets him pick any day. */
const BACK_WEIGH_IN = 14;
const BACK_MEAL = 3;
const BACK_SESSION = 60;

// ── dates ────────────────────────────────────────────────────────────────────

/**
 * A date that names a row which ALREADY EXISTS, rather than a date a new entry is
 * filed under.
 *
 * kit.ts's dateFor() caps how far back a new entry may be dated, and that cap is
 * the right guard there: a misheard date on a new weigh-in is invisible in a chat.
 * It is the wrong guard for a delete or an edit, which name something that is
 * already in the database — a wrong date there finds nothing and says so. What is
 * still refused is the future, because Arizona's today is not the runtime's.
 */
function existingDate(payload: Record<string, unknown>, ctx: Ctx, field = "date"): { date: string } | Refusal {
  const today = azDateISO(ctx.az);
  const v = payload[field];
  if (v === undefined) return { date: today };
  if (!isDateISO(v)) return refuse(400, `I need ${field} as YYYY-MM-DD.`);
  if (daysBetweenISO(v, today) < 0) {
    return refuse(400, `${v} has not happened yet in Arizona. Today is ${today}.`);
  }
  return { date: v };
}

// ── small shared checks ──────────────────────────────────────────────────────

/** Did that check refuse? Generic so every helper below can return either its own
 *  answer or a Refusal, and one `if` sorts them out. */
function isRefusal<T>(v: T | Refusal): v is Refusal {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

/** The before-state, read back out of an audit row. It went in as JSON and comes
 *  back as JSON, so the cast is unavoidable — this names the one place it happens
 *  and each handler's own shape is the only thing that says what it means. */
function readBefore<T>(before: Json): T {
  return before as unknown as T;
}

/**
 * READ an id out of the payload — an id the read door handed out, echoed back.
 *
 * Named readId and not rowId, because `rowId` already means something else in this
 * codebase: mealLog's rowId() GENERATES an id. Two functions one letter apart doing
 * opposite things is the kind of confusion that gets one called where the other was
 * meant.
 *
 * See ROW_ID in kit.ts for why this is not a uuid check: meal ids from older app
 * versions and the code's own routine seeds are not uuids, and a uuid regex would
 * refuse rows that exist.
 */
function readId(payload: Record<string, unknown>, field: string): { id: string } | Refusal {
  const v = payload[field];
  if (typeof v !== "string" || !ROW_ID.test(v)) {
    return refuse(400, `I need ${field} as the read door gave it to you.`);
  }
  return { id: v };
}

/** A name or note going INTO a row. Cleaned and capped rather than refused, and
 *  the reply says when something was taken out — the same rule schedule.remind
 *  follows for a reminder that reaches a lock screen. */
function cleanText(v: unknown, cap: number): string {
  return scrubCap(v, cap);
}

/** A whole number of something, within a range. */
function count(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

/** A macro figure: a number, zero or more, and not absurd. */
function macro(v: unknown, max = 10_000): number | null {
  const n = money(v);
  if (n === null || n < 0 || n > max) return null;
  return n;
}

const newId = () => crypto.randomUUID();

// ── the meal-day document ────────────────────────────────────────────────────

interface DayPatch {
  meals?: unknown[];
  status?: string | null;
  note?: string | null;
}
type DayDecision<T> = { ok: true; patch: DayPatch; got: T } | Refusal;

/**
 * Read a day, decide what to write, write it — and only onto the version that was
 * read.
 *
 * `decide` is called INSIDE the loop, so every attempt sees the freshest document
 * and every refusal ("there is no meal with that id") is decided against what is
 * actually there rather than against a copy from a moment ago. A patch only names
 * the fields it changes: `status` and `note` are the other phone's business as much
 * as ours, and a tool that only adds a meal must not send them back at all.
 *
 * WHY `got` EXISTS. A caller usually needs something it saw while deciding — the
 * meal it removed, the mark that was there before — to write its sentence and its
 * undo record. Returning it through the decision means it comes from the attempt
 * that actually LANDED. A mutable variable set inside the callback would hold
 * whatever the last attempt saw, which on a retry is the losing read: the undo
 * record would then describe a state that was never replaced.
 */
async function editDay<T>(
  ctx: Ctx,
  date: string,
  decide: (day: MealDayRow | null) => DayDecision<T>,
): Promise<{ ok: true; before: MealDayRow | null; got: T } | Refusal> {
  const atISO = ctx.at.toISOString();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const day = await ctx.db.readMealDay(ctx.person, date);
    const decided = decide(day);
    if (isRefusal(decided)) return decided;
    if (!day) {
      const insert: Parameters<Ctx["db"]["insertMealDay"]>[0] = {
        person: ctx.person,
        date,
        meals: decided.patch.meals ?? [],
        atISO,
      };
      if (decided.patch.status !== undefined) insert.status = decided.patch.status;
      if (decided.patch.note !== undefined) insert.note = decided.patch.note;
      if ((await ctx.db.insertMealDay(insert)) === "ok") {
        return { ok: true, before: null, got: decided.got };
      }
      continue;
    }
    const landed = await ctx.db.updateMealDayIfUnchanged(day.id, day.updatedAt, { ...decided.patch, atISO });
    if (landed === "ok") return { ok: true, before: day, got: decided.got };
  }
  return refuse(
    503,
    "The phone was writing that same day at the same moment. Nothing was changed — try again in a few seconds.",
  );
}

/** The meals on a day, as the app's own shape. The column is opaque in db.ts on
 *  purpose; this is the one place it is read as meals. */
const mealsOf = (day: MealDayRow | null): Meal[] => (day ? (day.meals as Meal[]) : []);

// ── the session document ─────────────────────────────────────────────────────

interface SessionPatch {
  name?: string;
  notes?: string;
  exercises?: unknown[];
  done?: boolean;
}
type SessionDecision<T> = { ok: true; patch: SessionPatch; got: T } | Refusal;

/** The same read-decide-write-or-retry as editDay, on `workouts`, and `got` is
 *  there for the same reason. A session row is one document too, and
 *  src/store/HealthStore.tsx says why in its own words: "a blind upsert drops any
 *  set the other device added". */
async function editSession<T>(
  ctx: Ctx,
  id: string,
  decide: (row: WorkoutRow, session: Workout) => SessionDecision<T>,
): Promise<{ ok: true; before: WorkoutRow; got: T } | Refusal> {
  const atISO = ctx.at.toISOString();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await ctx.db.readWorkout(id);
    // Not found and somebody else's get the SAME sentence. Whose session an id
    // belongs to is not something this door will tell either of them.
    if (!row || row.person !== ctx.person) {
      return refuse(404, "There is no session of yours with that id. It may have been deleted since you read it.");
    }
    const decided = decide(row, toSession(row));
    if (isRefusal(decided)) return decided;
    if ((await ctx.db.updateWorkoutIfUnchanged(id, row.updatedAt, { ...decided.patch, atISO })) === "ok") {
      return { ok: true, before: row, got: decided.got };
    }
  }
  return refuse(
    503,
    "The phone was writing that same session at the same moment. Nothing was changed — try again in a few seconds.",
  );
}

/** A stored row as the app's Workout. Transcription, the same job rows.ts does on
 *  the read door: renaming, not computing. */
function toSession(row: WorkoutRow): Workout {
  return {
    id: row.id,
    date: row.date,
    person: row.person,
    name: row.name,
    notes: row.notes,
    exercises: row.exercises as ExerciseEntry[],
    done: row.done,
  };
}

// ── sets logged after the fact ───────────────────────────────────────────────

/**
 * One set he is telling me he already did.
 *
 * THE RULE IS THE HISTORY EDITOR'S, and it is re-stated here rather than imported
 * because it lives inside a view module (src/views/WorkoutSection.tsx's addSet,
 * which calls copyLastSet, and its setSet, which is now editLoggedSet): an id, the
 * numbers, and NO `done` key at all — so the row counts by trainingMath's reps > 0
 * rule.
 *
 * Writing `done: false` instead would store a set that can NEVER count toward a
 * hard set, whatever is in it. That is what the live logger means by a number typed
 * into a box and not yet ticked, and it is the opposite of what "I did three sets
 * of eight" means. It is also invisible: the reply would say "logged", every
 * screen would show the numbers, and health.training_volume would report zero.
 *
 * tests/museHealth.test.ts builds the same set through the app's own copyLastSet
 * and asserts the two are identical, so this copy cannot drift from the editor.
 */
function loggedSet(x: { reps: number; weight: number; warmup?: boolean }): SetEntry {
  const s: SetEntry = { id: newId(), reps: x.reps, weight: x.weight };
  if (x.warmup) s.kind = "warmup";
  return s;
}

/** `{ reps, weight, warmup? }` out of whatever the caller sent. */
function readSet(raw: unknown): { reps: number; weight: number; warmup: boolean } | Refusal {
  if (!isObject(raw)) return refuse(400, "Each set is an object with reps and a weight.");
  const reps = count(raw.reps, 0, 1000);
  if (reps === null) return refuse(400, "Each set needs reps as a whole number.");
  // Zero is allowed and means bodyweight — workoutVolume counts a bodyweight set's
  // reps instead of its tonnage, so there is nothing to invent here.
  const weight = macro(raw.weight === undefined ? 0 : raw.weight, 2000);
  if (weight === null) return refuse(400, "A set's weight is a number of pounds, or zero for bodyweight.");
  if (raw.warmup !== undefined && typeof raw.warmup !== "boolean") {
    return refuse(400, "warmup is either true or false.");
  }
  return { reps, weight, warmup: raw.warmup === true };
}

// ── the food library, as the app assembles it ────────────────────────────────

/** A `foods` row as the app's Food. Mirrors mapFood in src/store/FinanceStore.tsx:
 *  the table IS the custom library, so `custom` is true rather than read. */
function toFood(row: FoodRow): Food {
  return {
    id: row.id,
    name: row.name,
    role: row.role as FoodRole,
    kcal: row.kcal,
    p: row.p,
    c: row.c,
    f: row.f,
    serving: row.serving ?? undefined,
    note: row.note ?? undefined,
    barcode: row.barcode ?? undefined,
    custom: true,
  };
}

/**
 * The food this id names, looked up the way the meal builder's library is built:
 * the household's own rows first, then the curated seeds, then the bundled table.
 * One database read, and only when the id is not one of the code tables.
 */
async function foodById(ctx: Ctx, id: string): Promise<Food | null> {
  const seed = SEED_FOODS.find((f) => f.id === id);
  if (seed) return seed;
  const bundled = BUNDLED_FOODS.find((f) => f.id === id);
  if (bundled) return bundled;
  const row = await ctx.db.readFood(id);
  return row ? toFood(row) : null;
}

/** One logged portion out of what the caller sent — either a library food and an
 *  amount, or something not in the library and what it contained. */
async function readItem(ctx: Ctx, raw: unknown): Promise<LoggedItem | Refusal> {
  if (!isObject(raw)) return refuse(400, "Each food is an object. Give it a food_id and an amount, or a name and its macros.");

  if (raw.food_id !== undefined) {
    if (raw.kcal !== undefined || raw.p !== undefined || raw.c !== undefined || raw.f !== undefined) {
      // Both at once is ambiguous rather than generous: the library food already
      // carries its macros, and a caller that sent both has two answers for what
      // this portion contained and no way to say which it meant.
      return refuse(400, "Give a food_id and an amount, or a name and its macros — not both.");
    }
    const id = readId(raw, "food_id");
    if (isRefusal(id)) return id;
    const food = await foodById(ctx, id.id);
    if (!food) return refuse(404, "There is no food with that id. Search for it first and use the id you get back.");
    const amount = readAmount(raw, food);
    if (isRefusal(amount)) return amount;
    // itemFromFood snapshots the food's per-100g values onto the portion, which is
    // why the log stays correct after that library food is edited. The app's own
    // function, so the door computes nothing.
    return itemFromFood(food, amount, newId());
  }

  const name = cleanText(raw.name, NAME_CAP);
  if (!name) return refuse(400, "Each food needs a name, or a food_id from the library.");
  const macros: Record<string, number> = {};
  for (const k of ["kcal", "p", "c", "f"] as const) {
    const v = macro(raw[k]);
    if (v === null) return refuse(400, `${name} needs ${k} as a number of zero or more.`);
    macros[k] = v;
  }
  if (raw.role !== undefined && !isRole(raw.role)) {
    return refuse(400, "role is protein, carb, veg, fat or other.");
  }
  const totals = {
    name,
    role: raw.role as FoodRole | undefined,
    kcal: macros.kcal,
    p: macros.p,
    c: macros.c,
    f: macros.f,
  };
  // WITH a weight it is a weighed portion; without one it is a serving. Both go
  // through a function in mealLog rather than being assembled here, and the
  // difference matters: the log stores per-100g values scaled by grams, so a
  // portion with no weight has to be stored as something. itemFromServing stores it
  // as one 100 g serving whose per-100g values are its totals, so the macros come
  // back exactly and the amount reads "1 serving" instead of a weight nobody
  // measured. Somebody saying "a chicken breast, about 330 calories" knows the
  // macros and not the grams, and that is the normal case from a chat.
  if (raw.grams === undefined) return itemFromServing(totals, newId());
  const grams = macro(raw.grams, 5000);
  if (grams === null || grams <= 0) {
    return refuse(400, `${name} needs its weight in grams as a number above zero, or leave the weight out.`);
  }
  return itemFromTotals({ ...totals, grams }, newId());
}

const ROLES: readonly string[] = ["protein", "carb", "veg", "fat", "other"];
const isRole = (v: unknown): v is FoodRole => typeof v === "string" && ROLES.includes(v);

/** How much of a food: grams, or a count of its natural unit. gramsOf() in
 *  mealLog turns the second into the first — the app's own rule, not ours. */
function readAmount(raw: Record<string, unknown>, food: Food): Amount | Refusal {
  if (raw.qty !== undefined) {
    const qty = macro(raw.qty, 100);
    if (qty === null || qty <= 0) return refuse(400, "qty is a number above zero.");
    const unit = unitFor(food);
    if (!unit) {
      return refuse(
        400,
        `${food.name} is not counted by the each, so I need grams instead.`,
      );
    }
    return { grams: gramsOf({ grams: 0, qty, unit }), qty, unit };
  }
  const grams = macro(raw.grams, 5000);
  if (grams === null || grams <= 0) return refuse(400, `${food.name} needs grams, or qty if it is counted by the each.`);
  return { grams };
}

// ── the reply sentence for a day ─────────────────────────────────────────────

const mealCount = (n: number) => `${n} ${n === 1 ? "meal" : "meals"}`;

/**
 * What a meal came to, in a sentence — or how many foods were in it, when it cannot
 * be worked out.
 *
 * THE GUARD IS NOT DEFENSIVE PADDING. `meals` and `saved_meals.items` are jsonb
 * columns with no shape enforced by the database, and mealTotals reads
 * `item.per100.kcal` — so one stored portion from an older app version, or one
 * hand-edited row, throws a TypeError. In the app that is a render crash somebody
 * notices; in a door it would turn a write that LANDED into a 500 that says nothing
 * happened, which is the worse of the two lies.
 *
 * So the shape is checked first and the sentence falls back to a count. The door
 * still computes nothing itself: when the shape is right, the number comes from
 * mealTotals.
 */
function mealSays(meal: Meal): string {
  const ok = meal.items.every((it) => {
    if (!it || typeof it !== "object") return false;
    const per = (it as LoggedItem).per100;
    return (
      typeof (it as LoggedItem).grams === "number" &&
      !!per &&
      typeof per.kcal === "number" &&
      typeof per.p === "number" &&
      typeof per.c === "number" &&
      typeof per.f === "number"
    );
  });
  if (!ok) {
    const n = meal.items.length;
    return `${n} ${n === 1 ? "food" : "foods"} (its macros are stored in a shape I could not add up)`;
  }
  const m = mealTotals(meal);
  return `${Math.round(m.kcal)} kcal, ${Math.round(m.p)} g protein`;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE TOOLS
// ═════════════════════════════════════════════════════════════════════════════

// ── health.log_weight ────────────────────────────────────────────────────────

const logWeight: Tool = {
  kind: "direct",
  does: "Record a weigh-in.",
  fields: ["weight", "date"],
  async run(payload, ctx) {
    const weight = money(payload.weight);
    if (weight === null) return refuse(400, "I need the weight as a number, in pounds.");
    // A plausible range, not a judgement about his body: the point is to catch a
    // misheard number (19.84, 1984) before it lands in the trend line, where a
    // single wild point bends the slope the app reports.
    if (weight < 50 || weight > 700) {
      return refuse(400, "That weight does not look like pounds. Say it as you read it off the scale.");
    }
    const when = dateFor(payload, ctx, BACK_WEIGH_IN);
    if (isRefusal(when)) return when;

    const previous = await ctx.db.readWeight(ctx.person, when.date);
    // Stored exactly as it was said. No rounding: the door does no arithmetic,
    // and a number that comes back different from the one he spoke is the small
    // end of the same problem.
    await ctx.db.upsertWeight(ctx.person, when.date, weight, ctx.at.toISOString());

    const who = DISPLAY[ctx.person];
    return {
      ok: true,
      result: { person: ctx.person, date: when.date, weight, replaced: previous },
      // rowIds stays empty: body_weights has one row per person per date, so the
      // person and the date in `result` already name the row exactly.
      rowIds: [],
      say: previous === null
        ? `Logged ${weight} lb for ${who} on ${when.date}.`
        : `Logged ${weight} lb for ${who} on ${when.date}. That replaced the ${previous} already saved for that day.`,
      undo: {
        kind: "weight.set",
        before: { date: when.date, weight: previous },
        says: previous === null
          ? `take the ${weight} lb weigh-in for ${when.date} back off`
          : `put ${previous} lb back for ${when.date}`,
      },
    };
  },
};

const undoWeightSet: UndoHandler = {
  does: "Put a weigh-in back to what it was, or take it off if there was none.",
  async apply(before, ctx) {
    const b = readBefore<{ date: string; weight: number | null }>(before);
    if (b.weight === null) {
      const gone = await ctx.db.deleteWeight(ctx.person, b.date);
      return {
        ok: true,
        result: { person: ctx.person, date: b.date, weight: null, existed: gone },
        rowIds: [],
        say: gone
          ? `Took the weigh-in for ${b.date} back off. There was none before.`
          : `There is no weigh-in for ${b.date} any more, so there was nothing to take off.`,
      };
    }
    await ctx.db.upsertWeight(ctx.person, b.date, b.weight, ctx.at.toISOString());
    return {
      ok: true,
      result: { person: ctx.person, date: b.date, weight: b.weight },
      rowIds: [],
      say: `Put ${b.weight} lb back for ${b.date}.`,
    };
  },
};

// ── health.delete_weight ─────────────────────────────────────────────────────

const deleteWeight: Tool = {
  kind: "direct",
  does: "Take a weigh-in off a day.",
  fields: ["date"],
  async run(payload, ctx) {
    const when = existingDate(payload, ctx);
    if (isRefusal(when)) return when;
    const previous = await ctx.db.readWeight(ctx.person, when.date);
    // Refused rather than reported as done, because "deleted" and "there was
    // nothing there" are different answers and an assistant must be able to say
    // which. A no-op reported as a success is how a wrong date goes unnoticed.
    if (previous === null) return refuse(404, `There is no weigh-in saved for ${when.date}.`);
    await ctx.db.deleteWeight(ctx.person, when.date);
    return {
      ok: true,
      result: { person: ctx.person, date: when.date, removed: previous },
      rowIds: [],
      say: `Took the ${previous} lb weigh-in for ${when.date} off ${DISPLAY[ctx.person]}'s log.`,
      undo: {
        kind: "weight.set",
        before: { date: when.date, weight: previous },
        says: `put ${previous} lb back for ${when.date}`,
      },
    };
  },
};

// ── health.log_saved_meal ────────────────────────────────────────────────────

const logSavedMeal: Tool = {
  kind: "direct",
  does: "Log one of the household's saved meals by name.",
  fields: ["name", "date"],
  async run(payload, ctx) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 80) {
      return refuse(400, "Tell me the name of the saved meal, as it is spelled in the app.");
    }
    const when = dateFor(payload, ctx, BACK_MEAL);
    if (isRefusal(when)) return when;

    const matches = await ctx.db.findSavedMealsByName(name);
    if (matches.length === 0) {
      const names = (await ctx.db.listSavedMealNames(8)).map((n) => scrubCap(n, 40)).filter(Boolean);
      const list = names.length ? ` Saved meals right now: ${names.join(", ")}.` : "";
      return refuse(404, `There is no saved meal called that.${list}`);
    }
    if (matches.length > 1) {
      return refuse(409, "More than one saved meal has that name. Pick it in the app so the right one lands.");
    }
    const saved = matches[0];

    // The portions are copied across EXACTLY as they sit in saved_meals. Each one
    // already carries its own per-100g snapshot, which is why the app's log stays
    // correct after a library food is edited.
    //
    // The id is generated ONCE, outside the retry loop: the app merges day
    // documents by meal id, so a retry that appends the same id can never show up
    // twice, and the undo has one id to remove.
    const meal: Meal = { id: newId(), name: saved.name, items: saved.items as LoggedItem[] };
    return addMeal(ctx, when.date, meal, `${scrubCap(saved.name, 40)}`);
  },
};

// ── health.log_meal ──────────────────────────────────────────────────────────
//
// Phase 1 queued this one and nothing ever read the queue. It lands now, and what
// makes that safe is that the undo removes exactly the meal it added.

const logMeal: Tool = {
  kind: "direct",
  does: "Log food into a day — library foods by id, or anything else by name with its weight and macros.",
  fields: ["date", "items", "name"],
  async run(payload, ctx) {
    const when = dateFor(payload, ctx, BACK_MEAL);
    if (isRefusal(when)) return when;
    const raw = payload.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      return refuse(400, "I need at least one food. Each one is either a food_id and an amount, or a name with its weight and macros.");
    }
    if (raw.length > MAX_ITEMS) {
      return refuse(400, `That is more than ${MAX_ITEMS} foods at once. Split it into two meals.`);
    }
    const items: LoggedItem[] = [];
    for (const one of raw) {
      const item = await readItem(ctx, one);
      if (isRefusal(item)) return item;
      items.push(item);
    }
    // An empty name is not a missing name. The app displays a meal by its position
    // when it has none ("Meal 1", "Meal 2"), which is what makes deletes renumber
    // — so storing a name we invented would break that.
    const meal: Meal = { id: newId(), name: cleanText(payload.name, NAME_CAP), items };
    const what = items.length === 1 ? scrubCap(items[0].name, 40) : `${items.length} foods`;
    return addMeal(ctx, when.date, meal, what);
  },
};

/** The one place a meal is appended to a day. Both logging tools end here, so the
 *  document race and the undo record are written once rather than twice. */
async function addMeal(ctx: Ctx, date: string, meal: Meal, what: string): Promise<ToolOutcome> {
  const landed = await editDay(ctx, date, (day) => ({
    ok: true as const,
    // status and note are deliberately absent from the patch: a day the other
    // phone marked skipped survives this write.
    patch: { meals: [...mealsOf(day), meal] },
    got: null,
  }));
  if (isRefusal(landed)) return landed;
  const total = mealsOf(landed.before).length + 1;
  return {
    ok: true,
    result: {
      person: ctx.person,
      date,
      meal_id: meal.id,
      meal: what,
      items: meal.items.length,
      meals_on_day: total,
    },
    rowIds: [],
    say:
      `Added ${what} to ${DISPLAY[ctx.person]}'s food log for ${date} — ${mealSays(meal)}. ` +
      `That day now has ${mealCount(total)}.`,
    undo: {
      kind: "day.remove-meal",
      before: { date, mealId: meal.id },
      says: `take ${what} back off ${date}`,
    },
  };
}

const undoDayRemoveMeal: UndoHandler = {
  does: "Take a meal this door added back off its day.",
  async apply(before, ctx) {
    const b = readBefore<{ date: string; mealId: string }>(before);
    const landed = await editDay(ctx, b.date, (day) => {
      const meals = mealsOf(day);
      const hit = meals.find((m) => m.id === b.mealId);
      if (!hit) {
        return refuse(404, `That meal is not on ${b.date} any more — somebody already took it off.`);
      }
      return { ok: true as const, patch: { meals: meals.filter((m) => m.id !== b.mealId) }, got: hit };
    });
    if (isRefusal(landed)) return landed;
    const left = mealsOf(landed.before).length - 1;
    return {
      ok: true,
      result: { person: ctx.person, date: b.date, meal_id: b.mealId, meals_on_day: left },
      rowIds: [],
      say: `Took ${scrubCap(landed.got.name, 40) || "that meal"} back off ${b.date}. That day now has ${mealCount(left)}.`,
    };
  },
};

// ── health.delete_meal ───────────────────────────────────────────────────────

const deleteMeal: Tool = {
  kind: "direct",
  does: "Take one meal off a day.",
  fields: ["date", "meal_id"],
  async run(payload, ctx) {
    const when = existingDate(payload, ctx);
    if (isRefusal(when)) return when;
    const id = readId(payload, "meal_id");
    if (isRefusal(id)) return id;

    // Captured from the winning attempt's read, not from an earlier one — see the
    // note in editDay. `at` is the position it sat in, so the undo puts it back
    // where it was rather than at the end: the app names an unnamed meal by its
    // position, so the order is what he sees.
    const landed = await editDay(ctx, when.date, (day) => {
      const meals = mealsOf(day);
      const i = meals.findIndex((m) => m.id === id.id);
      if (i === -1) return refuse(404, `There is no meal with that id on ${when.date}.`);
      return { ok: true as const, patch: { meals: meals.filter((_, j) => j !== i) }, got: { meal: meals[i], at: i } };
    });
    if (isRefusal(landed)) return landed;
    const { meal, at } = landed.got;
    const left = mealsOf(landed.before).length - 1;
    const what = scrubCap(meal.name, 40) || `the ${at + 1}${ordinal(at + 1)} meal`;
    return {
      ok: true,
      result: { person: ctx.person, date: when.date, meal_id: id.id, was: what, meals_on_day: left },
      rowIds: [],
      say: `Took ${what} off ${when.date} — that was ${mealSays(meal)}. That day now has ${mealCount(left)}.`,
      undo: {
        kind: "day.put-meal-back",
        before: { date: when.date, meal: meal as unknown as Json, at },
        says: `put ${what} back on ${when.date}`,
      },
    };
  },
};

const ordinal = (n: number) => (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

const undoDayPutMealBack: UndoHandler = {
  does: "Put a deleted meal back on its day, where it was.",
  async apply(before, ctx) {
    const b = readBefore<{ date: string; meal: Meal; at: number }>(before);
    const landed = await editDay(ctx, b.date, (day) => {
      const meals = mealsOf(day);
      // Already back is not an error to shout about, but it must not be reported as
      // a restore either — a second undo would otherwise add a duplicate meal.
      if (meals.some((m) => m.id === b.meal.id)) {
        return refuse(409, `That meal is already back on ${b.date}.`);
      }
      const at = Math.min(Math.max(0, b.at), meals.length);
      return { ok: true as const, patch: { meals: [...meals.slice(0, at), b.meal, ...meals.slice(at)] }, got: null };
    });
    if (isRefusal(landed)) return landed;
    return {
      ok: true,
      result: { person: ctx.person, date: b.date, meal_id: b.meal.id },
      rowIds: [],
      say: `Put ${scrubCap(b.meal.name, 40) || "that meal"} back on ${b.date}.`,
    };
  },
};

// ── health.edit_meal ─────────────────────────────────────────────────────────

const editMeal: Tool = {
  kind: "direct",
  does: "Rename a meal on a day, or replace what was in it.",
  fields: ["date", "meal_id", "name", "items"],
  async run(payload, ctx) {
    const when = existingDate(payload, ctx);
    if (isRefusal(when)) return when;
    const id = readId(payload, "meal_id");
    if (isRefusal(id)) return id;
    const wantsName = payload.name !== undefined;
    const wantsItems = payload.items !== undefined;
    if (!wantsName && !wantsItems) return refuse(400, "Tell me the new name, or the new list of foods, or both.");

    let items: LoggedItem[] | null = null;
    if (wantsItems) {
      const raw = payload.items;
      if (!Array.isArray(raw) || raw.length === 0) {
        return refuse(400, "A meal has to have at least one food. To get rid of it, delete the meal.");
      }
      if (raw.length > MAX_ITEMS) return refuse(400, `That is more than ${MAX_ITEMS} foods in one meal.`);
      items = [];
      for (const one of raw) {
        const item = await readItem(ctx, one);
        if (isRefusal(item)) return item;
        items.push(item);
      }
    }
    const name = wantsName ? cleanText(payload.name, NAME_CAP) : null;

    const landed = await editDay(ctx, when.date, (day) => {
      const meals = mealsOf(day);
      const hit = meals.find((m) => m.id === id.id);
      if (!hit) return refuse(404, `There is no meal with that id on ${when.date}.`);
      const next: Meal = { ...hit, ...(name !== null ? { name } : {}), ...(items ? { items } : {}) };
      return { ok: true as const, patch: { meals: meals.map((m) => (m.id === id.id ? next : m)) }, got: hit };
    });
    if (isRefusal(landed)) return landed;
    const old = landed.got;
    const now: Meal = { ...old, ...(name !== null ? { name } : {}), ...(items ? { items } : {}) };
    return {
      ok: true,
      result: {
        person: ctx.person,
        date: when.date,
        meal_id: id.id,
        name: scrubCap(now.name, 40) || null,
        items: now.items.length,
      },
      rowIds: [],
      say:
        `Changed that meal on ${when.date}. It was ${mealSays(old)} and it is now ${mealSays(now)}.`,
      undo: {
        // Surgical: the ONE meal goes back to what it was, and every other meal on
        // the day is left exactly as it is now. A snapshot of the whole day would
        // erase anything the phone logged in between.
        kind: "day.restore-meal",
        before: { date: when.date, meal: old as unknown as Json },
        says: `put that meal back to ${mealSays(old)}`,
      },
    };
  },
};

const undoDayRestoreMeal: UndoHandler = {
  does: "Put one meal back to what it was, leaving the rest of the day alone.",
  async apply(before, ctx) {
    const b = readBefore<{ date: string; meal: Meal }>(before);
    const landed = await editDay(ctx, b.date, (day) => {
      const meals = mealsOf(day);
      if (!meals.some((m) => m.id === b.meal.id)) {
        return refuse(404, `That meal is not on ${b.date} any more, so there is nothing to put back.`);
      }
      return { ok: true as const, patch: { meals: meals.map((m) => (m.id === b.meal.id ? b.meal : m)) }, got: null };
    });
    if (isRefusal(landed)) return landed;
    return {
      ok: true,
      result: { person: ctx.person, date: b.date, meal_id: b.meal.id },
      rowIds: [],
      say: `Put that meal on ${b.date} back to ${mealSays(b.meal)}.`,
    };
  },
};

// ── health.mark_day ──────────────────────────────────────────────────────────
//
// The 8 PM nudge's two answers, from a chat. A day with meals on it counts as
// followed on its own; these mark a day with nothing logged as either followed
// roughly (with a note saying what he ate) or off plan.

const MARKS: readonly string[] = ["estimated", "skipped", "clear"];

const markDay: Tool = {
  kind: "direct",
  does: "Mark a day as followed-roughly or off-plan, with a note, or clear the mark.",
  fields: ["date", "mark", "note"],
  async run(payload, ctx) {
    const when = existingDate(payload, ctx);
    if (isRefusal(when)) return when;
    const mark = typeof payload.mark === "string" ? payload.mark : "";
    if (!MARKS.includes(mark)) {
      return refuse(400, 'mark is "estimated" for followed roughly, "skipped" for off plan, or "clear".');
    }
    const note = payload.note === undefined ? null : cleanText(payload.note, NOTE_CAP);
    if (mark === "clear" && payload.note !== undefined) {
      return refuse(400, "Clearing the mark clears the note with it, so leave the note out.");
    }
    const status = mark === "clear" ? null : mark;

    const landed = await editDay(ctx, when.date, (day) => ({
      ok: true as const,
      patch: { status, note: status === null ? null : note ?? day?.note ?? null },
      got: { status: day?.status ?? null, note: day?.note ?? null },
    }));
    if (isRefusal(landed)) return landed;
    const { status: wasStatus, note: wasNote } = landed.got;
    const logged = mealsOf(landed.before).length;
    return {
      ok: true,
      result: { person: ctx.person, date: when.date, mark: status, note, meals_on_day: logged },
      rowIds: [],
      say:
        (status === null
          ? `Cleared the mark on ${when.date}.`
          : status === "estimated"
            ? `Marked ${when.date} as followed roughly.`
            : `Marked ${when.date} as off plan.`) +
        // The honest footnote: the mark only decides a day with nothing logged.
        // Saying "marked off plan" about a day with three meals on it would be a
        // sentence he would believe and the streak would disagree with.
        (logged > 0
          ? ` That day already has ${mealCount(logged)} logged, and logged food decides the day — the mark only counts on a day with nothing on it.`
          : ""),
      undo: {
        kind: "day.mark",
        before: { date: when.date, status: wasStatus, note: wasNote },
        says: wasStatus === null ? `clear the mark on ${when.date} again` : `put the ${wasStatus} mark back on ${when.date}`,
      },
    };
  },
};

const undoDayMark: UndoHandler = {
  does: "Put a day's mark and note back.",
  async apply(before, ctx) {
    const b = readBefore<{ date: string; status: string | null; note: string | null }>(before);
    const landed = await editDay(ctx, b.date, () => ({
      ok: true as const,
      patch: { status: b.status, note: b.note },
      got: null,
    }));
    if (isRefusal(landed)) return landed;
    return {
      ok: true,
      result: { person: ctx.person, date: b.date, mark: b.status, note: b.note },
      rowIds: [],
      say: b.status === null ? `Cleared the mark on ${b.date} again.` : `Put the ${b.status} mark back on ${b.date}.`,
    };
  },
};

// ── health.save_meal ─────────────────────────────────────────────────────────

const saveMeal: Tool = {
  kind: "direct",
  does: "Save a meal for re-use later — one already logged on a day, or a list of foods.",
  fields: ["name", "date", "meal_id", "items"],
  async run(payload, ctx) {
    const name = cleanText(payload.name, NAME_CAP);
    if (!name) return refuse(400, "A saved meal needs a name, so it can be logged by name later.");
    const fromDay = payload.meal_id !== undefined;
    const fromItems = payload.items !== undefined;
    if (fromDay === fromItems) {
      return refuse(400, "Give me a meal_id off a day, or a list of foods — one or the other.");
    }
    // A duplicate name is refused, and this is a guard the door adds rather than
    // one it inherits: health.log_saved_meal looks a meal up BY NAME and refuses
    // when two share one, so a second "Usual breakfast" makes both unloggable from
    // a chat. The app lets you make one because the app picks from a list.
    const clash = await ctx.db.findSavedMealsByName(name);
    if (clash.length > 0) {
      return refuse(409, `There is already a saved meal called ${scrubCap(name, 40)}. Pick another name, or change that one.`);
    }

    let items: LoggedItem[];
    if (fromDay) {
      const when = existingDate(payload, ctx);
      if (isRefusal(when)) return when;
      const id = readId(payload, "meal_id");
      if (isRefusal(id)) return id;
      const day = await ctx.db.readMealDay(ctx.person, when.date);
      const hit = mealsOf(day).find((m) => m.id === id.id);
      if (!hit) return refuse(404, `There is no meal with that id on ${when.date}.`);
      items = hit.items;
    } else {
      const raw = payload.items;
      if (!Array.isArray(raw) || raw.length === 0) return refuse(400, "A saved meal needs at least one food.");
      if (raw.length > MAX_ITEMS) return refuse(400, `That is more than ${MAX_ITEMS} foods in one meal.`);
      items = [];
      for (const one of raw) {
        const item = await readItem(ctx, one);
        if (isRefusal(item)) return item;
        items.push(item);
      }
    }

    const id = await ctx.db.insertSavedMeal({ name, items });
    return {
      ok: true,
      result: { id, name: scrubCap(name, 40), items: items.length },
      rowIds: [id],
      say: `Saved ${scrubCap(name, 40)} — ${mealSays({ id, name, items })}. You can log it by name now.`,
      undo: { kind: "saved-meal.delete", before: { id, name }, says: `delete the saved meal ${scrubCap(name, 40)}` },
    };
  },
};

const undoSavedMealDelete: UndoHandler = {
  does: "Delete a saved meal this door created.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string }>(before);
    const gone = await ctx.db.deleteSavedMeal(b.id);
    return {
      ok: true,
      result: { id: b.id, existed: gone },
      rowIds: [],
      say: gone
        ? `Deleted the saved meal ${scrubCap(b.name, 40)} again.`
        : `That saved meal is already gone.`,
    };
  },
};

// ── health.update_saved_meal / health.delete_saved_meal ──────────────────────

const updateSavedMeal: Tool = {
  kind: "direct",
  does: "Rename a saved meal, or change what is in it.",
  fields: ["id", "name", "items"],
  async run(payload, ctx) {
    const id = readId(payload, "id");
    if (isRefusal(id)) return id;
    const wantsName = payload.name !== undefined;
    const wantsItems = payload.items !== undefined;
    if (!wantsName && !wantsItems) return refuse(400, "Tell me the new name, or the new list of foods, or both.");
    const before = await ctx.db.readSavedMeal(id.id);
    if (!before) return refuse(404, "There is no saved meal with that id.");

    let name: string | undefined;
    if (wantsName) {
      name = cleanText(payload.name, NAME_CAP);
      if (!name) return refuse(400, "A saved meal needs a name.");
      const clash = (await ctx.db.findSavedMealsByName(name)).filter((m) => m.id !== id.id);
      if (clash.length > 0) return refuse(409, `Another saved meal is already called ${scrubCap(name, 40)}.`);
    }
    let items: LoggedItem[] | undefined;
    if (wantsItems) {
      const raw = payload.items;
      if (!Array.isArray(raw) || raw.length === 0) return refuse(400, "A saved meal needs at least one food.");
      if (raw.length > MAX_ITEMS) return refuse(400, `That is more than ${MAX_ITEMS} foods in one meal.`);
      items = [];
      for (const one of raw) {
        const item = await readItem(ctx, one);
        if (isRefusal(item)) return item;
        items.push(item);
      }
    }
    const landed = await ctx.db.updateSavedMeal(id.id, { name, items });
    if (!landed) return refuse(404, "There is no saved meal with that id.");
    return {
      ok: true,
      result: { id: id.id, name: scrubCap(name ?? before.name, 40), items: (items ?? before.items).length },
      rowIds: [id.id],
      // Changing a saved meal never touches a day it was already logged into:
      // every portion in a day carries its own snapshot. Said out loud because the
      // opposite is the reasonable guess.
      say:
        `Changed ${scrubCap(name ?? before.name, 40)}. Days it was already logged into are untouched — ` +
        `each one kept its own copy.`,
      undo: {
        kind: "saved-meal.restore",
        before: { id: id.id, name: before.name, items: before.items as Json },
        says: `put ${scrubCap(before.name, 40)} back to what it was`,
      },
    };
  },
};

const deleteSavedMeal: Tool = {
  kind: "direct",
  does: "Delete a saved meal.",
  fields: ["id"],
  async run(payload, ctx) {
    const id = readId(payload, "id");
    if (isRefusal(id)) return id;
    const before = await ctx.db.readSavedMeal(id.id);
    if (!before) return refuse(404, "There is no saved meal with that id.");
    await ctx.db.deleteSavedMeal(id.id);
    return {
      ok: true,
      result: { id: id.id, name: scrubCap(before.name, 40) },
      rowIds: [],
      say: `Deleted the saved meal ${scrubCap(before.name, 40)}. Days it was logged into keep their food.`,
      undo: {
        kind: "saved-meal.insert",
        before: { id: id.id, name: before.name, items: before.items as Json },
        says: `put the saved meal ${scrubCap(before.name, 40)} back`,
      },
    };
  },
};

const undoSavedMealRestore: UndoHandler = {
  does: "Put a saved meal back to its earlier name and contents.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string; items: unknown[] }>(before);
    const landed = await ctx.db.updateSavedMeal(b.id, { name: b.name, items: b.items });
    if (!landed) return refuse(404, "That saved meal has been deleted since, so there is nothing to put back.");
    return {
      ok: true,
      result: { id: b.id, name: scrubCap(b.name, 40) },
      rowIds: [b.id],
      say: `Put ${scrubCap(b.name, 40)} back to what it was.`,
    };
  },
};

const undoSavedMealInsert: UndoHandler = {
  does: "Put a deleted saved meal back, under its own id.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string; items: unknown[] }>(before);
    // The same id on purpose: a second undo then finds it already there rather
        // than creating a duplicate that log_saved_meal could not tell apart.
    const existing = await ctx.db.readSavedMeal(b.id);
    if (existing) return refuse(409, `${scrubCap(b.name, 40)} is already back.`);
    const id = await ctx.db.insertSavedMeal({ id: b.id, name: b.name, items: b.items });
    return {
      ok: true,
      result: { id, name: scrubCap(b.name, 40) },
      rowIds: [id],
      say: `Put the saved meal ${scrubCap(b.name, 40)} back.`,
    };
  },
};

// ── health.add_food / health.delete_food ─────────────────────────────────────

const addFood: Tool = {
  kind: "direct",
  does: "Add a food to the household's library, with its macros per 100 g.",
  fields: ["name", "role", "kcal", "p", "c", "f", "serving", "note", "barcode"],
  async run(payload, ctx) {
    const name = cleanText(payload.name, NAME_CAP);
    if (!name) return refuse(400, "A food needs a name.");
    if (payload.role !== undefined && !isRole(payload.role)) {
      return refuse(400, "role is protein, carb, veg, fat or other.");
    }
    const nums: Record<string, number> = {};
    for (const k of ["kcal", "p", "c", "f"] as const) {
      const v = macro(payload[k], 1000);
      if (v === null) return refuse(400, `${name} needs ${k} per 100 g as a number of zero or more.`);
      nums[k] = v;
    }
    let serving: number | null = null;
    if (payload.serving !== undefined) {
      serving = macro(payload.serving, 5000);
      if (serving === null || serving <= 0) return refuse(400, "serving is the usual portion in grams, above zero.");
    }
    const barcode = payload.barcode === undefined ? null : cleanText(payload.barcode, 32).replace(/\D/g, "") || null;
    // Refused, not silently allowed, and the reason is a real trap: mealLog's
    // buildLibrary dedupes the searchable library by lower-cased name with the
    // household's own foods first, so a second food with this name could never be
    // found by search. The app has the same trap; a door that let an assistant walk
    // into it would be adding a row only a delete could reveal.
    const clash = await ctx.db.findFoodByName(name);
    if (clash) {
      return refuse(
        409,
        `There is already a food called ${scrubCap(name, 40)} in the library, and search only ever finds the first one. Change that one instead, or pick another name.`,
      );
    }
    const row: FoodRow = {
      id: "",
      name,
      role: isRole(payload.role) ? payload.role : "other",
      kcal: nums.kcal,
      p: nums.p,
      c: nums.c,
      f: nums.f,
      serving,
      note: cleanText(payload.note, NOTE_CAP) || null,
      barcode,
    };
    const id = await ctx.db.insertFood(row);
    return {
      ok: true,
      result: { id, name: scrubCap(name, 40), per_100g: { kcal: nums.kcal, p: nums.p, c: nums.c, f: nums.f } },
      rowIds: [id],
      say: `Added ${scrubCap(name, 40)} to the library at ${Math.round(nums.kcal)} kcal per 100 g. It comes up in search now.`,
      undo: { kind: "food.delete", before: { id, name }, says: `take ${scrubCap(name, 40)} back out of the library` },
    };
  },
};

const deleteFood: Tool = {
  kind: "direct",
  does: "Take a food out of the household's library.",
  fields: ["id"],
  async run(payload, ctx) {
    const id = readId(payload, "id");
    if (isRefusal(id)) return id;
    const before = await ctx.db.readFood(id.id);
    if (!before) {
      // A seed or bundled food is code, not a row, and cannot be deleted from
      // anywhere — including the app. Said as itself rather than as "not found".
      const code = SEED_FOODS.find((f) => f.id === id.id) ?? BUNDLED_FOODS.find((f) => f.id === id.id);
      if (code) {
        return refuse(
          400,
          `${scrubCap(code.name, 40)} is one of the built-in foods, not one of yours. Those cannot be deleted from anywhere.`,
        );
      }
      return refuse(404, "There is no food in your library with that id.");
    }
    await ctx.db.deleteFood(id.id);
    return {
      ok: true,
      result: { id: id.id, name: scrubCap(before.name, 40) },
      rowIds: [],
      // The reassurance is true and worth saying: every logged portion carries its
      // own per-100g snapshot, which is exactly why the log survives this.
      say: `Took ${scrubCap(before.name, 40)} out of the library. Meals already logged with it keep their macros.`,
      undo: { kind: "food.insert", before: before as unknown as Json, says: `put ${scrubCap(before.name, 40)} back in the library` },
    };
  },
};

const undoFoodDelete: UndoHandler = {
  does: "Take a food this door added back out of the library.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string }>(before);
    const gone = await ctx.db.deleteFood(b.id);
    return {
      ok: true,
      result: { id: b.id, existed: gone },
      rowIds: [],
      say: gone ? `Took ${scrubCap(b.name, 40)} back out of the library.` : `That food is already gone.`,
    };
  },
};

const undoFoodInsert: UndoHandler = {
  does: "Put a deleted food back in the library, under its own id.",
  async apply(before, ctx) {
    const b = readBefore<FoodRow>(before);
    // Its own id, because every portion ever logged from it points at that id: a
    // restore under a new one would restore the food and orphan its history.
    const existing = await ctx.db.readFood(b.id);
    if (existing) return refuse(409, `${scrubCap(b.name, 40)} is already back in the library.`);
    const id = await ctx.db.insertFood({ ...b, id: b.id });
    return {
      ok: true,
      result: { id, name: scrubCap(b.name, 40) },
      rowIds: [id],
      say: `Put ${scrubCap(b.name, 40)} back in the library.`,
    };
  },
};

// ── health.set_macro_target ──────────────────────────────────────────────────

const setMacroTarget: Tool = {
  kind: "direct",
  does: "Set the daily macro target.",
  fields: ["kcal", "p", "c", "f"],
  async run(payload, ctx) {
    const nums: Record<string, number> = {};
    for (const k of ["kcal", "p", "c", "f"] as const) {
      const v = macro(payload[k], k === "kcal" ? 10_000 : 1000);
      if (v === null) return refuse(400, `The target needs ${k} as a number of zero or more.`);
      nums[k] = v;
    }
    if (nums.kcal < 800) {
      // Not a judgement, a misheard-number guard, same as the weigh-in range: a
      // target this low would make every day read as over budget and the streak
      // would quietly stop counting.
      return refuse(400, "That calorie target is below 800, which reads like a misheard number. Say it again if it is right.");
    }
    const target: MacroRow = { kcal: nums.kcal, p: nums.p, c: nums.c, f: nums.f };
    const before = await ctx.db.readMacroTarget(ctx.person);
    await ctx.db.upsertMacroTarget(ctx.person, target, ctx.at.toISOString());
    return {
      ok: true,
      result: { person: ctx.person, target, replaced: before },
      rowIds: [],
      say:
        `Set ${DISPLAY[ctx.person]}'s daily target to ${Math.round(target.kcal)} kcal, ` +
        `${Math.round(target.p)} g protein, ${Math.round(target.c)} g carbs, ${Math.round(target.f)} g fat.` +
        (before === null ? " There was no saved target before, only the starting plan's numbers." : ""),
      undo: {
        kind: "macro-target.set",
        before: { target: before as Json },
        says: before === null
          ? "go back to having no saved target, and the starting plan's numbers"
          : `put the target back to ${Math.round(before.kcal)} kcal`,
      },
    };
  },
};

const undoMacroTargetSet: UndoHandler = {
  does: "Put the macro target back, or back to having none at all.",
  async apply(before, ctx) {
    const b = readBefore<{ target: MacroRow | null }>(before);
    if (b.target === null) {
      const gone = await ctx.db.deleteMacroTarget(ctx.person);
      return {
        ok: true,
        result: { person: ctx.person, target: null, existed: gone },
        rowIds: [],
        say: `${DISPLAY[ctx.person]} has no saved target again, so the app is back to the starting plan's numbers.`,
      };
    }
    await ctx.db.upsertMacroTarget(ctx.person, b.target, ctx.at.toISOString());
    return {
      ok: true,
      result: { person: ctx.person, target: b.target },
      rowIds: [],
      say: `Put the target back to ${Math.round(b.target.kcal)} kcal.`,
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// THE WORKOUT SIDE
// ═════════════════════════════════════════════════════════════════════════════

/** An exercise entry for a session. The same three fields the app's own "add
 *  exercise" writes (src/views/WorkoutSection.tsx): the library id when the lift
 *  is in the library, and a name and a muscle either way, so a custom lift is a
 *  real entry rather than a special case. */
function newEntry(ex: { exerciseId: string; name: string; muscle: string }, sets: SetEntry[]): ExerciseEntry {
  return { id: newId(), exerciseId: ex.exerciseId, name: ex.name, muscle: ex.muscle, sets };
}

const MUSCLES: readonly string[] = ["chest", "back", "legs", "shoulders", "arms", "core", "fullbody", "cardio"];

/**
 * The lift this name means, resolved the way the app resolves it.
 *
 * findExercise matches by id, then name, then alias, then a normalised form, so
 * "tricep pushdowns" and "Triceps pushdown" are one lift here as well. A name the
 * library does not know is allowed — that is what a custom exercise IS in this app,
 * an entry with no library id — but then a muscle has to be given, because a lift
 * with no muscle drops silently out of health.training_volume into
 * `sets_with_no_muscle_data`.
 */
function resolveExercise(
  name: string,
  muscle: unknown,
): { exerciseId: string; name: string; muscle: string; custom: boolean } | Refusal {
  const lib = findExercise(BUNDLED_EXERCISES, name);
  if (lib) return { exerciseId: lib.id, name: lib.name, muscle: lib.muscle, custom: false };
  if (typeof muscle !== "string" || !MUSCLES.includes(muscle)) {
    return refuse(
      400,
      `${scrubCap(name, 40)} is not in the exercise library. Log it anyway by saying which muscle it works — one of ${MUSCLES.join(", ")} — or search the library for the name it is under.`,
    );
  }
  return { exerciseId: "", name, muscle, custom: true };
}

/** `{ name, muscle?, sets: [...] }` out of whatever the caller sent. */
function readEntry(raw: unknown): { entry: ExerciseEntry; custom: boolean } | Refusal {
  if (!isObject(raw)) return refuse(400, "Each exercise is an object with a name and its sets.");
  const name = cleanText(raw.name, NAME_CAP);
  if (!name) return refuse(400, "Each exercise needs a name.");
  const ex = resolveExercise(name, raw.muscle);
  if (isRefusal(ex)) return ex;
  const rawSets = raw.sets;
  const sets: SetEntry[] = [];
  if (rawSets !== undefined) {
    if (!Array.isArray(rawSets)) return refuse(400, `${scrubCap(name, 40)} needs its sets as a list.`);
    if (rawSets.length > MAX_SETS) return refuse(400, `That is more than ${MAX_SETS} sets on one exercise.`);
    for (const one of rawSets) {
      const s = readSet(one);
      if (isRefusal(s)) return s;
      sets.push(loggedSet(s));
    }
  }
  let duration: number | null = null;
  if (raw.minutes !== undefined) {
    duration = macro(raw.minutes, 600);
    if (duration === null || duration <= 0) return refuse(400, "minutes is a number above zero.");
  }
  if (sets.length === 0 && duration === null) {
    return refuse(400, `${scrubCap(name, 40)} needs either its sets or how many minutes it took.`);
  }
  const entry = newEntry(ex, sets);
  return { entry: duration === null ? entry : { ...entry, duration }, custom: ex.custom };
}

// ── health.start_session ─────────────────────────────────────────────────────

const startSession: Tool = {
  kind: "direct",
  does: "Start a session for today — empty, or laid out from one of the routines.",
  fields: ["date", "name", "routine"],
  async run(payload, ctx) {
    const when = dateFor(payload, ctx, BACK_SESSION);
    if (isRefusal(when)) return when;
    // The app shows at most one running session and cannot start a second, so this
    // refuses rather than leaving two half-logged sessions on one day to find later.
    const open = await ctx.db.findOpenSession(ctx.person, when.date);
    if (open) {
      return refuse(
        409,
        `There is already an unfinished session on ${when.date} (${scrubCap(open.name, 40) || "no name"}). Log into that one, or finish it first.`,
      );
    }

    let exercises: ExerciseEntry[] = [];
    let name = cleanText(payload.name, NAME_CAP);
    if (payload.routine !== undefined) {
      const wanted = cleanText(payload.routine, NAME_CAP);
      if (!wanted) return refuse(400, "Tell me the routine by name, as the app lists it.");
      const routine = await routineByName(ctx, wanted);
      if (isRefusal(routine)) return routine;
      // The routine's exercises, each with its planned number of EMPTY sets — the
      // same thing "Start from routine" does on the screen. Empty means no reps and
      // no weight, which counts as nothing until numbers are logged into it.
      exercises = routine.exercises.slice(0, MAX_ENTRIES).map((re: RoutineExercise) => {
        const ex = findExercise(BUNDLED_EXERCISES, re.name);
        return newEntry(
          { exerciseId: ex ? ex.id : "", name: re.name, muscle: re.muscle },
          Array.from({ length: Math.min(MAX_SETS, Math.max(1, re.sets)) }, () => loggedSet({ reps: 0, weight: 0 })),
        );
      });
      if (!name) name = routine.name;
    }

    const row: WorkoutRow = {
      id: newId(),
      person: ctx.person,
      date: when.date,
      name,
      notes: "",
      exercises,
      done: false,
      updatedAt: ctx.at.toISOString(),
    };
    if ((await ctx.db.insertWorkout(row)) !== "ok") {
      return refuse(503, "I could not start that session cleanly, so I did not start it. Try again.");
    }
    return {
      ok: true,
      result: {
        id: row.id,
        person: ctx.person,
        date: when.date,
        name: scrubCap(name, 40) || null,
        exercises: exercises.length,
      },
      rowIds: [row.id],
      say:
        `Started ${scrubCap(name, 40) || "a session"} for ${DISPLAY[ctx.person]} on ${when.date}` +
        (exercises.length ? ` with ${exercises.length} exercises laid out.` : " with nothing in it yet.") +
        " Log sets into it and finish it when you are done.",
      undo: {
        // `logged` is what the session held when the door made it — zero here, and
        // not zero for health.log_workout, which uses the same inverse for a session
        // that arrived with its sets already in it. The undo refuses if the session
        // holds MORE than that now, because those extra sets are not in the
        // before-state and deleting the row would take them with it.
        kind: "session.delete",
        before: { id: row.id, name, logged: { done: 0, warmups: 0 } },
        says: `throw that session away again`,
      },
    };
  },
};

/** A routine by name: the code seeds first, then his own saved ones — the same list
 *  the workout screen shows, in the same order. */
async function routineByName(ctx: Ctx, wanted: string): Promise<Routine | Refusal> {
  const same = (a: string) => a.trim().toLowerCase() === wanted.trim().toLowerCase();
  const seed = SEED_ROUTINES[ctx.person].find((r) => same(r.name));
  if (seed) return seed;
  const saved = await ctx.db.listRoutines(ctx.person);
  const hit = saved.find((r) => same(r.name));
  if (hit) return toRoutine(hit);
  const names = [...SEED_ROUTINES[ctx.person].map((r) => r.name), ...saved.map((r) => r.name)]
    .map((n) => scrubCap(n, 40))
    .filter(Boolean)
    .slice(0, 10);
  return refuse(404, `There is no routine called that.${names.length ? ` Yours are: ${names.join(", ")}.` : ""}`);
}

const toRoutine = (row: RoutineRow): Routine => ({
  id: row.id,
  person: row.person,
  name: row.name,
  meta: row.meta,
  exercises: row.exercises as RoutineExercise[],
});

const undoSessionDelete: UndoHandler = {
  does: "Throw away a session this door created.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string; logged?: { done: number; warmups: number } }>(before);
    const row = await ctx.db.readWorkout(b.id);
    if (!row || row.person !== ctx.person) {
      return {
        ok: true,
        result: { id: b.id, existed: false },
        rowIds: [],
        say: "That session is already gone.",
      };
    }
    // THE ONE PLACE AN UNDO COULD DESTROY WORK, so it is the one place an undo
    // refuses. Sets logged into the session after the door created it are not in the
    // before-state, and throwing the row away would take them with it.
    //
    // The comparison is against what the session held WHEN THE DOOR MADE IT, not
    // against zero: health.start_session creates an empty session and
    // health.log_workout creates one with its sets already in it, and both are
    // undone by deleting the row. An older record with no `logged` counts as zero,
    // which is what it meant.
    const then = b.logged ?? { done: 0, warmups: 0 };
    const now = sessionCounts(toSession(row));
    if (now.done > then.done || now.warmups > then.warmups) {
      const extra = now.done - then.done;
      return refuse(
        409,
        `That session has ${extra} more ${extra === 1 ? "set" : "sets"} logged into it than when it was created, and throwing it away would take those with it. Delete it on purpose if that is what you want.`,
      );
    }
    await ctx.db.deleteWorkout(b.id);
    return {
      ok: true,
      result: { id: b.id, existed: true },
      rowIds: [],
      say: `Threw ${scrubCap(b.name, 40) || "that session"} away again. Nothing had been logged into it since.`,
    };
  },
};

// ── health.log_sets ──────────────────────────────────────────────────────────

const logSets: Tool = {
  kind: "direct",
  does: "Add sets to an exercise in a session — creating the exercise if it is not in it yet.",
  fields: ["session_id", "exercise", "muscle", "sets", "minutes"],
  async run(payload, ctx) {
    const sid = readId(payload, "session_id");
    if (isRefusal(sid)) return sid;
    const name = cleanText(payload.exercise, NAME_CAP);
    if (!name) return refuse(400, "Tell me which lift, by name.");
    const ex = resolveExercise(name, payload.muscle);
    if (isRefusal(ex)) return ex;

    const rawSets = payload.sets;
    const sets: SetEntry[] = [];
    if (rawSets !== undefined) {
      if (!Array.isArray(rawSets) || rawSets.length === 0) return refuse(400, "Give me the sets as a list.");
      if (rawSets.length > MAX_SETS) return refuse(400, `That is more than ${MAX_SETS} sets at once.`);
      for (const one of rawSets) {
        const s = readSet(one);
        if (isRefusal(s)) return s;
        sets.push(loggedSet(s));
      }
    }
    let minutes: number | null = null;
    if (payload.minutes !== undefined) {
      minutes = macro(payload.minutes, 600);
      if (minutes === null || minutes <= 0) return refuse(400, "minutes is a number above zero.");
    }
    if (sets.length === 0 && minutes === null) {
      return refuse(400, "Give me either the sets or how many minutes it took.");
    }

    // The ids are generated ONCE, before the loop, for the same reason the meal id
    // is: a retry must not append the same sets twice, and the undo has to name
    // exactly the sets this call added.
    const addedIds = sets.map((s) => s.id ?? "").filter(Boolean);

    // Logging into a FINISHED session is allowed on purpose. "Log the sets I did
    // yesterday" is exactly that, and the app's history editor does it too. The
    // reply says so rather than refusing.
    const landed = await editSession(ctx, sid.id, (_row, session) => {
      // The lift already in the session, matched by the library's identity when it
      // is a library lift and by name when it is a custom one — so a second call
      // about the same lift adds sets to it rather than a second entry for it.
      const existing = session.exercises.find((e) =>
        ex.custom
          ? e.name.trim().toLowerCase() === ex.name.trim().toLowerCase()
          : findExercise(BUNDLED_EXERCISES, e.name, e.exerciseId)?.id === ex.exerciseId,
      );
      if (existing) {
        if (existing.sets.length + sets.length > MAX_SETS * 2) {
          return refuse(400, `${scrubCap(existing.name, 40)} would end up with more than ${MAX_SETS * 2} sets in one session.`);
        }
        // MINUTES ADD, they do not replace, and that is the door's own rule rather
        // than the app's — the app's history editor sets a duration outright. It is
        // stated here because it is a decision: sets APPEND on a second call about
        // the same lift, so minutes that replaced instead of adding would make this
        // one tool behave two ways. The alternative is the assistant doing the
        // addition, which is the arithmetic this whole bridge exists to keep out of
        // an assistant's head. The undo subtracts exactly what was added.
        const next: ExerciseEntry = {
          ...existing,
          sets: [...existing.sets, ...sets],
          ...(minutes === null ? {} : { duration: (existing.duration ?? 0) + minutes }),
        };
        return {
          ok: true as const,
          patch: { exercises: session.exercises.map((e) => (e.id === next.id ? next : e)) },
          got: { entryId: existing.id, entryName: existing.name, madeEntry: false },
        };
      }
      if (session.exercises.length >= MAX_ENTRIES) {
        return refuse(400, `That session already has ${session.exercises.length} exercises in it.`);
      }
      const entry = newEntry(ex, sets);
      return {
        ok: true as const,
        patch: { exercises: [...session.exercises, minutes === null ? entry : { ...entry, duration: minutes }] },
        got: { entryId: entry.id, entryName: entry.name, madeEntry: true },
      };
    });
    if (isRefusal(landed)) return landed;
    const { entryId, entryName, madeEntry } = landed.got;

    const what = scrubCap(entryName, 40) || "that lift";
    const how = sets.length
      ? `${sets.length} ${sets.length === 1 ? "set" : "sets"} of ${what}`
      : `${minutes} minutes of ${what}`;
    return {
      ok: true,
      result: {
        session_id: sid.id,
        date: landed.before.date,
        exercise_entry_id: entryId,
        exercise: what,
        custom: ex.custom,
        sets_added: sets.length,
        minutes_added: minutes,
        set_ids: addedIds,
      },
      rowIds: [sid.id],
      say:
        `Logged ${how} into the session on ${landed.before.date}.` +
        (ex.custom ? ` That lift is not in the library, so it counts toward ${ex.muscle} because you said so.` : "") +
        (landed.before.done ? " That session was already finished; the sets went in anyway, the way the app's editor does it." : ""),
      undo: {
        kind: "session.remove-sets",
        before: { id: sid.id, entryId, setIds: addedIds, minutes, removeEntry: madeEntry },
        says: `take ${how} back off that session`,
      },
    };
  },
};

const undoSessionRemoveSets: UndoHandler = {
  does: "Take sets this door added back off a session.",
  async apply(before, ctx) {
    const b = readBefore<{
      id: string;
      entryId: string;
      setIds: string[];
      minutes: number | null;
      removeEntry: boolean;
    }>(before);
    const wanted = new Set(b.setIds);
    const landed = await editSession(ctx, b.id, (_row, session) => {
      const entry = session.exercises.find((e) => e.id === b.entryId);
      if (!entry) {
        return refuse(404, "That exercise is not in the session any more, so there is nothing to take off.");
      }
      const kept = entry.sets.filter((s) => !(s.id && wanted.has(s.id)));
      const removed = entry.sets.length - kept.length;
      if (removed === 0 && b.minutes === null) {
        return refuse(409, "Those sets are already off that session.");
      }
      // Surgical, and it is the whole reason an undo is safe here: only the sets
      // this door added are taken out, so anything the phone logged in between
      // stays. An exercise the door CREATED goes with them, because it would
      // otherwise be left behind empty — but only if nothing else has been logged
      // into it since.
      const duration = b.minutes === null ? entry.duration : Math.max(0, (entry.duration ?? 0) - b.minutes);
      const empty = kept.length === 0 && !(duration && duration > 0);
      if (b.removeEntry && empty) {
        return {
          ok: true as const,
          patch: { exercises: session.exercises.filter((e) => e.id !== b.entryId) },
          got: removed,
        };
      }
      const next: ExerciseEntry = { ...entry, sets: kept };
      if (duration === undefined || duration === 0) delete next.duration;
      else next.duration = duration;
      return {
        ok: true as const,
        patch: { exercises: session.exercises.map((e) => (e.id === b.entryId ? next : e)) },
        got: removed,
      };
    });
    if (isRefusal(landed)) return landed;
    const removed = landed.got;
    return {
      ok: true,
      result: { session_id: b.id, sets_removed: removed },
      rowIds: [b.id],
      say: `Took ${removed} ${removed === 1 ? "set" : "sets"} back off the session on ${landed.before.date}.`,
    };
  },
};

// ── health.edit_set / health.delete_set ──────────────────────────────────────

const editSetTool: Tool = {
  kind: "direct",
  does: "Change one set's reps or weight, or mark it a warm-up.",
  fields: ["session_id", "set_id", "reps", "weight", "warmup"],
  async run(payload, ctx) {
    const sid = readId(payload, "session_id");
    if (isRefusal(sid)) return sid;
    const setId = readId(payload, "set_id");
    if (isRefusal(setId)) return setId;
    const patch: { reps?: number; weight?: number; warmup?: boolean } = {};
    if (payload.reps !== undefined) {
      const n = count(payload.reps, 0, 1000);
      if (n === null) return refuse(400, "reps is a whole number.");
      patch.reps = n;
    }
    if (payload.weight !== undefined) {
      const n = macro(payload.weight, 2000);
      if (n === null) return refuse(400, "weight is a number of pounds, or zero for bodyweight.");
      patch.weight = n;
    }
    if (payload.warmup !== undefined) {
      if (typeof payload.warmup !== "boolean") return refuse(400, "warmup is either true or false.");
      patch.warmup = payload.warmup;
    }
    if (Object.keys(patch).length === 0) return refuse(400, "Tell me the new reps, the new weight, or whether it was a warm-up.");

    const landed = await editSession(ctx, sid.id, (_row, session) => {
      for (const entry of session.exercises) {
        const i = entry.sets.findIndex((s) => s.id === setId.id);
        if (i === -1) continue;
        // editLoggedSet is the app's own history-editor rule, moved into
        // lib/sessionOps for this phase: the numbers change and the tick is cleared,
        // so the row counts by reps > 0. A door with its own version of that would
        // store a set the screen does not count.
        const next = editLoggedSet(entry, i, patch);
        return {
          ok: true as const,
          patch: { exercises: session.exercises.map((e) => (e.id === entry.id ? next : e)) },
          got: { was: entry.sets[i], entryId: entry.id, entryName: entry.name },
        };
      }
      return refuse(404, "There is no set with that id in that session.");
    });
    if (isRefusal(landed)) return landed;
    const { was: old, entryId, entryName } = landed.got;
    return {
      ok: true,
      result: {
        session_id: sid.id,
        set_id: setId.id,
        exercise: scrubCap(entryName, 40),
        was: { reps: old.reps, weight_lb: old.weight, warmup: old.kind === "warmup" },
        now: {
          reps: patch.reps ?? old.reps,
          weight_lb: patch.weight ?? old.weight,
          warmup: patch.warmup ?? old.kind === "warmup",
        },
      },
      rowIds: [sid.id],
      say:
        `Changed that set of ${scrubCap(entryName, 40) || "the lift"} on ${landed.before.date} from ` +
        `${old.reps} × ${old.weight} lb to ${patch.reps ?? old.reps} × ${patch.weight ?? old.weight} lb.`,
      undo: {
        kind: "session.restore-set",
        before: { id: sid.id, entryId, set: old as unknown as Json, at: null },
        says: `put that set back to ${old.reps} × ${old.weight} lb`,
      },
    };
  },
};

const deleteSet: Tool = {
  kind: "direct",
  does: "Take one set off a session.",
  fields: ["session_id", "set_id"],
  async run(payload, ctx) {
    const sid = readId(payload, "session_id");
    if (isRefusal(sid)) return sid;
    const setId = readId(payload, "set_id");
    if (isRefusal(setId)) return setId;

    const landed = await editSession(ctx, sid.id, (_row, session) => {
      for (const entry of session.exercises) {
        const i = entry.sets.findIndex((s) => s.id === setId.id);
        if (i === -1) continue;
        const next: ExerciseEntry = { ...entry, sets: entry.sets.filter((_, j) => j !== i) };
        return {
          ok: true as const,
          patch: { exercises: session.exercises.map((e) => (e.id === entry.id ? next : e)) },
          got: { was: entry.sets[i], entryId: entry.id, entryName: entry.name, at: i },
        };
      }
      return refuse(404, "There is no set with that id in that session.");
    });
    if (isRefusal(landed)) return landed;
    const { was: old, entryId, entryName, at } = landed.got;
    return {
      ok: true,
      result: { session_id: sid.id, set_id: setId.id, exercise: scrubCap(entryName, 40), was: { reps: old.reps, weight_lb: old.weight } },
      rowIds: [sid.id],
      say: `Took the ${old.reps} × ${old.weight} lb set of ${scrubCap(entryName, 40) || "that lift"} off the session on ${landed.before.date}.`,
      undo: {
        kind: "session.restore-set",
        before: { id: sid.id, entryId, set: old as unknown as Json, at },
        says: `put the ${old.reps} × ${old.weight} lb set back`,
      },
    };
  },
};

const undoSessionRestoreSet: UndoHandler = {
  does: "Put one set back to what it was, or back where it was.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; entryId: string; set: SetEntry; at: number | null }>(before);
    const landed = await editSession(ctx, b.id, (_row, session) => {
      const entry = session.exercises.find((e) => e.id === b.entryId);
      if (!entry) return refuse(404, "That exercise is not in the session any more, so there is nothing to put back.");
      const i = entry.sets.findIndex((s) => s.id === b.set.id);
      if (i !== -1) {
        // It is still there, so this undoes an EDIT: the one set goes back and
        // every other set in the session is left exactly as it is now.
        const next: ExerciseEntry = { ...entry, sets: entry.sets.map((s, j) => (j === i ? b.set : s)) };
        return {
          ok: true as const,
          patch: { exercises: session.exercises.map((e) => (e.id === entry.id ? next : e)) },
          got: null,
        };
      }
      if (b.at === null) return refuse(404, "That set has been deleted since, so there is nothing to change back.");
      const at = Math.min(Math.max(0, b.at), entry.sets.length);
      const next: ExerciseEntry = { ...entry, sets: [...entry.sets.slice(0, at), b.set, ...entry.sets.slice(at)] };
      return {
        ok: true as const,
        patch: { exercises: session.exercises.map((e) => (e.id === entry.id ? next : e)) },
        got: null,
      };
    });
    if (isRefusal(landed)) return landed;
    return {
      ok: true,
      result: { session_id: b.id, set_id: b.set.id, reps: b.set.reps, weight_lb: b.set.weight },
      rowIds: [b.id],
      say: `Put that set back to ${b.set.reps} × ${b.set.weight} lb.`,
    };
  },
};

// ── health.finish_session ────────────────────────────────────────────────────

const finishSession: Tool = {
  kind: "direct",
  does: "Finish a session, and name it or add a note while you are there.",
  fields: ["session_id", "name", "notes"],
  async run(payload, ctx) {
    const sid = readId(payload, "session_id");
    if (isRefusal(sid)) return sid;
    const name = payload.name === undefined ? null : cleanText(payload.name, NAME_CAP);
    const notes = payload.notes === undefined ? null : cleanText(payload.notes, NOTE_CAP);

    const landed = await editSession(ctx, sid.id, (row, session) => {
      if (row.done) return refuse(409, "That session is already finished.");
      const draft: Workout = {
        ...session,
        name: name ?? session.name,
        notes: notes ?? session.notes,
      };
      // finishWorkout is what the Finish button saves: sets with no numbers are
      // dropped, exercises left with nothing go with them, and unticked sets that
      // DO have numbers stay — kept but never counted. The door does not decide any
      // of that; it calls the same function the finish sheet previews.
      const result = finishWorkout(draft);
      if (result.nothingLogged) {
        return refuse(
          409,
          "Nothing is logged in that session, so finishing it would save an empty workout. Log some sets first, or delete it.",
        );
      }
      return {
        ok: true as const,
        patch: {
          name: result.workout.name,
          notes: result.workout.notes,
          exercises: result.workout.exercises,
          done: true,
        },
        got: {
          counts: sessionCounts(result.workout),
          dropped: session.exercises.length - result.workout.exercises.length,
        },
      };
    });
    if (isRefusal(landed)) return landed;
    const { counts, dropped } = landed.got;
    return {
      ok: true,
      result: {
        session_id: sid.id,
        date: landed.before.date,
        name: scrubCap(name ?? landed.before.name, 40) || null,
        hard_sets: counts.done,
        warmups: counts.warmups,
        exercises_dropped: dropped,
      },
      rowIds: [sid.id],
      say:
        `Finished the session on ${landed.before.date} with ${counts.done} working ${counts.done === 1 ? "set" : "sets"}` +
        (counts.warmups ? ` and ${counts.warmups} warm-ups` : "") +
        `.` +
        (dropped ? ` ${dropped} ${dropped === 1 ? "exercise" : "exercises"} with nothing in them were dropped, the way Finish does in the app.` : ""),
      undo: {
        kind: "session.unfinish",
        before: {
          id: sid.id,
          name: landed.before.name,
          notes: landed.before.notes,
          // The exercises BEFORE finish dropped the empty ones. Restoring them is
          // the only way "undo the finish" puts the session back as it was — and it
          // is a document restore, so it is marked fragile.
          exercises: landed.before.exercises as Json,
        },
        says: "put that session back to unfinished, with the empty sets it had",
        fragile:
          "Undoing a finish puts the whole session document back, so anything logged into it after it was finished would be lost. It refuses if it finds any.",
      },
    };
  },
};

const undoSessionUnfinish: UndoHandler = {
  does: "Put a finished session back to unfinished.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string; notes: string; exercises: unknown[] }>(before);
    const landed = await editSession(ctx, b.id, (row, session) => {
      if (!row.done) return refuse(409, "That session is not finished, so there is no finish to undo.");
      // The guard the `fragile` note promises. A set logged into the session after
      // it was finished is not in the before-state, so putting the document back
      // would erase it — and this undo exists to prevent lost work, not cause it.
      const now = sessionCounts(session);
      const then = sessionCounts({ ...session, exercises: b.exercises as ExerciseEntry[] });
      if (now.done > then.done || now.warmups > then.warmups) {
        return refuse(
          409,
          "Sets have been logged into that session since it was finished, and putting it back would lose them. Leave it finished, or take those sets off first.",
        );
      }
      return {
        ok: true as const,
        patch: { name: b.name, notes: b.notes, exercises: b.exercises, done: false },
        got: null,
      };
    });
    if (isRefusal(landed)) return landed;
    return {
      ok: true,
      result: { session_id: b.id, done: false },
      rowIds: [b.id],
      say: `Put the session on ${landed.before.date} back to unfinished.`,
    };
  },
};

// ── health.log_workout ───────────────────────────────────────────────────────
//
// One call for a session that is already over — the thing he actually asks for
// ("I did legs yesterday, here it is"). start + log_sets + finish would be three
// writes against three rate-limit slots, and two of them could land without the
// third.

const logWorkout: Tool = {
  kind: "direct",
  does: "Log a whole session that is already done, in one go.",
  fields: ["date", "name", "notes", "exercises"],
  async run(payload, ctx) {
    const when = dateFor(payload, ctx, BACK_SESSION);
    if (isRefusal(when)) return when;
    const raw = payload.exercises;
    if (!Array.isArray(raw) || raw.length === 0) {
      return refuse(400, "I need at least one exercise, each with its sets or how long it took.");
    }
    if (raw.length > MAX_ENTRIES) return refuse(400, `That is more than ${MAX_ENTRIES} exercises in one session.`);
    const exercises: ExerciseEntry[] = [];
    const custom: string[] = [];
    for (const one of raw) {
      const read = readEntry(one);
      if (isRefusal(read)) return read;
      exercises.push(read.entry);
      if (read.custom) custom.push(read.entry.name);
    }
    const name = cleanText(payload.name, NAME_CAP);
    const notes = cleanText(payload.notes, NOTE_CAP);

    // Run through the app's own Finish, so a session logged from a chat is stored
    // exactly as one finished on the screen: empty sets dropped, and a refusal when
    // there is nothing in it at all.
    const finished = finishWorkout({
      id: newId(),
      date: when.date,
      person: ctx.person,
      name,
      notes,
      exercises,
      done: false,
    });
    if (finished.nothingLogged) {
      return refuse(400, "None of those sets has any reps in it, so there is nothing to log.");
    }
    const counts = sessionCounts(finished.workout);
    const row: WorkoutRow = {
      id: finished.workout.id,
      person: ctx.person,
      date: when.date,
      name: finished.workout.name,
      notes: finished.workout.notes,
      exercises: finished.workout.exercises,
      done: true,
      updatedAt: ctx.at.toISOString(),
    };
    if ((await ctx.db.insertWorkout(row)) !== "ok") {
      return refuse(503, "I could not save that session cleanly, so I did not save it. Try again.");
    }
    return {
      ok: true,
      result: {
        id: row.id,
        person: ctx.person,
        date: when.date,
        name: scrubCap(name, 40) || null,
        exercises: finished.workout.exercises.length,
        hard_sets: counts.done,
        warmups: counts.warmups,
      },
      rowIds: [row.id],
      say:
        `Logged ${scrubCap(name, 40) || "a session"} for ${DISPLAY[ctx.person]} on ${when.date}: ` +
        `${finished.workout.exercises.length} ${finished.workout.exercises.length === 1 ? "exercise" : "exercises"}, ` +
        `${counts.done} working ${counts.done === 1 ? "set" : "sets"}.` +
        (custom.length
          ? ` ${custom.map((n) => scrubCap(n, 40)).join(", ")} ${custom.length === 1 ? "is" : "are"} not in the exercise library, so ${custom.length === 1 ? "it counts" : "they count"} toward the muscle you named.`
          : ""),
      undo: {
        // The same inverse as start_session's, and `logged` is why it can be: the
        // undo refuses only if the session holds MORE than the door put in it.
        kind: "session.delete",
        before: { id: row.id, name, logged: { done: counts.done, warmups: counts.warmups } },
        says: "delete that whole session again",
      },
    };
  },
};

// ── health.delete_session ────────────────────────────────────────────────────

const deleteSession: Tool = {
  kind: "direct",
  does: "Delete a whole session.",
  fields: ["session_id"],
  async run(payload, ctx) {
    const sid = readId(payload, "session_id");
    if (isRefusal(sid)) return sid;
    const row = await ctx.db.readWorkout(sid.id);
    if (!row || row.person !== ctx.person) {
      return refuse(404, "There is no session of yours with that id.");
    }
    const counts = sessionCounts(toSession(row));
    await ctx.db.deleteWorkout(sid.id);
    return {
      ok: true,
      result: {
        session_id: sid.id,
        date: row.date,
        name: scrubCap(row.name, 40) || null,
        hard_sets: counts.done,
      },
      rowIds: [],
      say:
        `Deleted the session on ${row.date} (${scrubCap(row.name, 40) || "no name"}) — ` +
        `${counts.done} working ${counts.done === 1 ? "set" : "sets"}. Say undo and I will put it back exactly as it was.`,
      undo: {
        // The whole row, so the restore is byte for byte including every set id and
        // the ids the merge keys on. This is the case the "no delete without a
        // captured before-state" rule was written for.
        kind: "session.insert",
        before: {
          id: row.id,
          date: row.date,
          name: row.name,
          notes: row.notes,
          exercises: row.exercises as Json,
          done: row.done,
        },
        says: `put the session on ${row.date} back`,
      },
    };
  },
};

const undoSessionInsert: UndoHandler = {
  does: "Put a deleted session back, exactly as it was.",
  async apply(before, ctx) {
    const b = readBefore<{
      id: string;
      date: string;
      name: string;
      notes: string;
      exercises: unknown[];
      done: boolean;
    }>(before);
    const existing = await ctx.db.readWorkout(b.id);
    if (existing) return refuse(409, `That session is already back.`);
    const row: WorkoutRow = {
      id: b.id,
      person: ctx.person,
      date: b.date,
      name: b.name,
      notes: b.notes,
      exercises: b.exercises,
      done: b.done,
      updatedAt: ctx.at.toISOString(),
    };
    if ((await ctx.db.insertWorkout(row)) !== "ok") {
      return refuse(409, "Something already holds that session's id, so I did not put it back.");
    }
    return {
      ok: true,
      result: { session_id: b.id, date: b.date },
      rowIds: [b.id],
      say: `Put the session on ${b.date} back, exactly as it was.`,
    };
  },
};

// ── health.save_routine / health.delete_routine ──────────────────────────────

const saveRoutine: Tool = {
  kind: "direct",
  does: "Save a routine — from a session that was logged, or from a list of exercises.",
  fields: ["name", "session_id", "exercises", "meta"],
  async run(payload, ctx) {
    const name = cleanText(payload.name, NAME_CAP);
    if (!name) return refuse(400, "A routine needs a name.");
    const fromSession = payload.session_id !== undefined;
    const fromList = payload.exercises !== undefined;
    if (fromSession === fromList) {
      return refuse(400, "Give me a session_id to save as a routine, or a list of exercises — one or the other.");
    }
    // Both the seeds and his own saved ones, because starting a routine looks the
    // name up across both and a duplicate would make one of them unreachable.
    const clash = await routineByName(ctx, name);
    if (!isRefusal(clash)) {
      return refuse(409, `There is already a routine called ${scrubCap(name, 40)}.`);
    }

    let exercises: RoutineExercise[];
    if (fromSession) {
      const sid = readId(payload, "session_id");
      if (isRefusal(sid)) return sid;
      const row = await ctx.db.readWorkout(sid.id);
      if (!row || row.person !== ctx.person) return refuse(404, "There is no session of yours with that id.");
      const session = toSession(row);
      if (session.exercises.length === 0) return refuse(400, "That session has no exercises in it.");
      // The same shape the screen's "Save as routine" writes: the name, the muscle,
      // how many sets there were, and no target rep range — he types that in later.
      exercises = session.exercises.slice(0, MAX_ENTRIES).map((e) => ({
        name: e.name,
        muscle: e.muscle,
        sets: Math.max(1, e.sets.length),
        reps: "",
      }));
    } else {
      const raw = payload.exercises;
      if (!Array.isArray(raw) || raw.length === 0) return refuse(400, "A routine needs at least one exercise.");
      if (raw.length > MAX_ENTRIES) return refuse(400, `That is more than ${MAX_ENTRIES} exercises in one routine.`);
      exercises = [];
      for (const one of raw) {
        if (!isObject(one)) return refuse(400, "Each exercise is an object with a name and how many sets.");
        const exName = cleanText(one.name, NAME_CAP);
        if (!exName) return refuse(400, "Each exercise needs a name.");
        const ex = resolveExercise(exName, one.muscle);
        if (isRefusal(ex)) return ex;
        const sets = count(one.sets, 1, MAX_SETS);
        if (sets === null) return refuse(400, `${scrubCap(exName, 40)} needs how many sets, from 1 to ${MAX_SETS}.`);
        exercises.push({ name: ex.name, muscle: ex.muscle, sets, reps: cleanText(one.reps, 16) });
      }
    }

    const row: RoutineRow = {
      id: newId(),
      person: ctx.person,
      name,
      meta: cleanText(payload.meta, NAME_CAP),
      exercises,
    };
    if ((await ctx.db.insertRoutine(row)) !== "ok") {
      return refuse(503, "I could not save that routine cleanly, so I did not save it. Try again.");
    }
    return {
      ok: true,
      result: { id: row.id, name: scrubCap(name, 40), exercises: exercises.length },
      rowIds: [row.id],
      say: `Saved ${scrubCap(name, 40)} as a routine with ${exercises.length} ${exercises.length === 1 ? "exercise" : "exercises"}. You can start a session from it by name.`,
      undo: { kind: "routine.delete", before: { id: row.id, name }, says: `delete the routine ${scrubCap(name, 40)}` },
    };
  },
};

/**
 * The SAVED routine a call means, by id or by name.
 *
 * A seed routine is code and not a row, so it is refused as itself rather than as
 * "not found" — the app cannot delete one either, and telling him it does not exist
 * when he can see it on his screen is the worse sentence.
 */
async function savedRoutineFrom(
  payload: Record<string, unknown>,
  ctx: Ctx,
): Promise<RoutineRow | Refusal> {
  if (payload.id !== undefined) {
    const id = readId(payload, "id");
    if (isRefusal(id)) return id;
    const row = await ctx.db.readRoutine(id.id);
    if (!row || row.person !== ctx.person) return refuse(404, "There is no routine of yours with that id.");
    return row;
  }
  const name = cleanText(payload.name, NAME_CAP);
  if (!name) return refuse(400, "Tell me which routine, by id or by name.");
  const found = await routineByName(ctx, name);
  if (isRefusal(found)) return found;
  const saved = (await ctx.db.listRoutines(ctx.person)).find((r) => r.id === found.id);
  if (!saved) {
    return refuse(
      400,
      `${scrubCap(found.name, 40)} is one of the built-in routines, not one you saved. Those cannot be deleted from anywhere.`,
    );
  }
  return saved;
}

const deleteRoutine: Tool = {
  kind: "direct",
  does: "Delete one of your saved routines.",
  fields: ["id", "name"],
  async run(payload, ctx) {
    const found = await savedRoutineFrom(payload, ctx);
    if (isRefusal(found)) return found;
    const row = found;
    await ctx.db.deleteRoutine(row.id);
    return {
      ok: true,
      result: { id: row.id, name: scrubCap(row.name, 40) },
      rowIds: [],
      say: `Deleted the routine ${scrubCap(row.name, 40)}. Sessions already logged from it are untouched.`,
      undo: {
        kind: "routine.insert",
        before: { id: row.id, name: row.name, meta: row.meta, exercises: row.exercises as Json },
        says: `put the routine ${scrubCap(row.name, 40)} back`,
      },
    };
  },
};

const undoRoutineDelete: UndoHandler = {
  does: "Delete a routine this door saved.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string }>(before);
    const gone = await ctx.db.deleteRoutine(b.id);
    return {
      ok: true,
      result: { id: b.id, existed: gone },
      rowIds: [],
      say: gone ? `Deleted the routine ${scrubCap(b.name, 40)} again.` : "That routine is already gone.",
    };
  },
};

const undoRoutineInsert: UndoHandler = {
  does: "Put a deleted routine back, under its own id.",
  async apply(before, ctx) {
    const b = readBefore<{ id: string; name: string; meta: string; exercises: unknown[] }>(before);
    const existing = await ctx.db.readRoutine(b.id);
    if (existing) return refuse(409, `${scrubCap(b.name, 40)} is already back.`);
    const row: RoutineRow = { id: b.id, person: ctx.person, name: b.name, meta: b.meta, exercises: b.exercises };
    if ((await ctx.db.insertRoutine(row)) !== "ok") {
      return refuse(409, "Something already holds that routine's id, so I did not put it back.");
    }
    return {
      ok: true,
      result: { id: b.id, name: scrubCap(b.name, 40) },
      rowIds: [b.id],
      say: `Put the routine ${scrubCap(b.name, 40)} back.`,
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// THE REGISTRIES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every health and workout write, by name.
 *
 * `health.log_weight`, `health.log_saved_meal` and `health.log_meal` are phase 1's
 * — they moved here from tools.ts so the health side is one file, and log_meal is
 * the one that changed from queued to direct.
 */
export const HEALTH_TOOLS: Record<string, Tool> = {
  // eating
  "health.log_meal": logMeal,
  "health.log_saved_meal": logSavedMeal,
  "health.delete_meal": deleteMeal,
  "health.edit_meal": editMeal,
  "health.mark_day": markDay,
  "health.save_meal": saveMeal,
  "health.update_saved_meal": updateSavedMeal,
  "health.delete_saved_meal": deleteSavedMeal,
  "health.add_food": addFood,
  "health.delete_food": deleteFood,
  "health.set_macro_target": setMacroTarget,
  // the body
  "health.log_weight": logWeight,
  "health.delete_weight": deleteWeight,
  // training
  "health.start_session": startSession,
  "health.log_sets": logSets,
  "health.edit_set": editSetTool,
  "health.delete_set": deleteSet,
  "health.finish_session": finishSession,
  "health.log_workout": logWorkout,
  "health.delete_session": deleteSession,
  "health.save_routine": saveRoutine,
  "health.delete_routine": deleteRoutine,
};

/**
 * The inverse of every one of them.
 *
 * Fewer handlers than tools, because several tools are each other's inverse:
 * logging a weigh-in and deleting one both restore through `weight.set`, and adding
 * a meal and deleting one are `day.remove-meal` and `day.put-meal-back`.
 *
 * A `kind` here is a NAME IN A DATABASE ROW. Renaming one orphans every undo token
 * already handed out, so a rename is a migration and not a refactor.
 */
export const HEALTH_UNDO: UndoRegistry = {
  "weight.set": undoWeightSet,
  "day.remove-meal": undoDayRemoveMeal,
  "day.put-meal-back": undoDayPutMealBack,
  "day.restore-meal": undoDayRestoreMeal,
  "day.mark": undoDayMark,
  "saved-meal.delete": undoSavedMealDelete,
  "saved-meal.restore": undoSavedMealRestore,
  "saved-meal.insert": undoSavedMealInsert,
  "food.delete": undoFoodDelete,
  "food.insert": undoFoodInsert,
  "macro-target.set": undoMacroTargetSet,
  "session.delete": undoSessionDelete,
  "session.insert": undoSessionInsert,
  "session.remove-sets": undoSessionRemoveSets,
  "session.restore-set": undoSessionRestoreSet,
  "session.unfinish": undoSessionUnfinish,
  "routine.delete": undoRoutineDelete,
  "routine.insert": undoRoutineInsert,
};

/** Every kind a health tool can return, so a test can prove no tool returns an
 *  undo record nothing knows how to apply. */
export const HEALTH_UNDO_KINDS: readonly string[] = Object.keys(HEALTH_UNDO);

/** Exported for the tests: the set shape this door writes, so it can be compared
 *  against the app's own history-editor rule instead of against a literal. */
export const __testables = { loggedSet, toFood, toSession, existingDate, resolveExercise };

/** The type a tool's undo record is, re-exported so the registry's consumers do not
 *  have to reach into undoContract.ts for it. */
export type { UndoRecord, Success };
