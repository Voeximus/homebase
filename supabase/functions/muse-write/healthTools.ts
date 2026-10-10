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
import type { FoodRow, MacroRow, MealDayRow, RoutineRow, SessionHead, WorkoutRow } from "./db.ts";
import {
  DISPLAY,
  EXAMPLE_ID,
  ROW_ID,
  dateFor,
  isObject,
  money,
  problemPad,
  problemsOf,
  refuse,
  shaped,
  shapeRefused,
  type Ctx,
  type Refusal,
  type ShapeCtx,
  type Shaped,
  type Success,
  type Tool,
  type ToolOutcome,
} from "./kit.ts";
import { itemSays, kindOfValue, labelOf, renameBy, unknownKeysSays, type ListShape } from "./shapes.ts";
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
import { BUNDLED_EXERCISES, type Exercise } from "../_shared/muse/lib/exerciseData.ts";
import { findExercise, normName } from "../_shared/muse/lib/trainingMath.ts";
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
function existingDate(payload: Record<string, unknown>, ctx: ShapeCtx, field = "date"): { date: string } | Refusal {
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

// Shaped, shaped, problemsOf, shapeRefused and problemPad — the every-problem answer of
// a shape check — live in kit.ts since review on 2026-10-10, when every flat tool in all
// four catalogues got a check of its own and all four needed them.

/** The date of a row that already exists, as a shape answer — the whole check of a
 *  tool that only names a day. */
function planExistingDate(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ date: string }> {
  const pad = problemPad();
  const when = pad.take(existingDate(payload, ctx));
  return pad.done(() => when!);
}

/** One id the read door handed out, as a shape answer. */
function planIds(payload: Record<string, unknown>, ...fields: string[]): Shaped<string[]> {
  const pad = problemPad();
  const ids = fields.map((f) => pad.take(readId(payload, f)));
  return pad.done(() => ids.map((x) => x!.id));
}

/** "kcal", "kcal and p", "kcal, p and f". */
const listAnd = (xs: readonly string[]): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

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
  /** Since 2026-10-10, for health.edit_session: the day a session is filed under. */
  date?: string;
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

// ── which session a call means ───────────────────────────────────────────────
//
// ADDED 2026-10-10. FOUND in the door's own audit log: an assistant sent
// health.delete_session with a 36-character id that had never existed — matched against
// every session id that person has ever had, current or deleted, it was none of them —
// read health.workouts three times, and sent the SAME invented id again half a minute
// later. The refusal both times was "There is no session of yours with that id", which
// named nothing it could have copied instead. It found the real one on its own, later.
//
// So every tool that names an existing session goes through here, and two things change:
//   · a session can be named by the DAY it was on, `session_date`, when that person had
//     exactly one session that day — which is how a person says it ("delete Monday's
//     workout") and leaves no 36-character string to mis-copy. Two that day is refused
//     with both listed, never resolved by picking one;
//   · an id that is not theirs is refused with their most recent sessions — date, name
//     and id — so the next try copies a real one.
// The list is the CALLER'S OWN sessions only, and an id that is the other person's gets
// the same sentence as one that does not exist: whose session an id is stays something
// this door does not say.

/** How many sessions a refusal lists. Enough to cover a week of them; the read door's
 *  health.workouts has the rest. */
const SESSION_LIST = 5;

/** One session, as a refusal names it: the day, the name, and the id to copy. */
function sessionLine(s: SessionHead): string {
  return `${s.date} ${scrubCap(s.name, 40) || "(no name)"}${s.done ? "" : " (not finished)"}, id ${s.id}`;
}

/** The caller's most recent sessions, as the end of a refusal. One more is read than is
 *  listed, so "and older ones" is a fact rather than a guess. */
async function recentSessionsSaid(ctx: Ctx): Promise<string> {
  const recent = await ctx.db.recentSessions(ctx.person, SESSION_LIST + 1);
  if (recent.length === 0) return " You have no sessions logged at all.";
  const more = recent.length > SESSION_LIST ? "; older ones are in health.workouts" : "";
  return ` Your most recent: ${recent.slice(0, SESSION_LIST).map(sessionLine).join("; ")}${more}.`;
}

/** What a session tool says when the call names no session at all. */
const WHICH_SESSION =
  "Tell me which session: its session_id from health.workouts, or session_date (YYYY-MM-DD) when it was your only session that day.";

/**
 * Which session a call names, as far as the payload and the Arizona calendar alone can
 * say — every problem with it, for a session tool's shape check.
 *
 * A session_id in the read door's shape, a session_date as YYYY-MM-DD that has already
 * happened, or both; at least one. The same three questions whichSession asks first,
 * asked here so they come back WITH every other problem in the call and before the
 * hourly counter is bumped. Whether the id or the day finds a session is a database
 * question, so it stays in whichSession, which each tool's run() calls after its checks.
 */
function sessionRefProblems(payload: Record<string, unknown>, ctx: ShapeCtx): string[] {
  const pad = problemPad();
  const byId = payload.session_id !== undefined;
  const byDay = payload.session_date !== undefined;
  if (!byId && !byDay) pad.no(WHICH_SESSION);
  if (byId) pad.take(readId(payload, "session_id"));
  if (byDay) pad.take(existingDate(payload, ctx, "session_date"));
  return problemsOf(pad.done(() => null));
}

/** A tool whose only field to check is the session it names. */
function planSessionRef(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<null> {
  return shaped(sessionRefProblems(payload, ctx), () => null);
}

/**
 * The session this call means — by `session_id`, or by `session_date` when that was the
 * caller's only session that day — or the refusal to give instead.
 *
 * Both may be sent; then they have to agree, because an id from one day and a date from
 * another means one of them is wrong and the door cannot tell which. The date is an
 * existing row's date, so it has no back-window (existingDate) — only the future is
 * refused.
 */
async function whichSession(payload: Record<string, unknown>, ctx: Ctx): Promise<{ id: string } | Refusal> {
  const byId = payload.session_id !== undefined;
  const byDay = payload.session_date !== undefined;
  if (!byId && !byDay) return refuse(400, WHICH_SESSION);
  let day: string | null = null;
  if (byDay) {
    const d = existingDate(payload, ctx, "session_date");
    if (isRefusal(d)) return d;
    day = d.date;
  }
  if (byId) {
    const sid = readId(payload, "session_id");
    if (isRefusal(sid)) return sid;
    const row = await ctx.db.readWorkout(sid.id);
    if (!row || row.person !== ctx.person) {
      return refuse(404, `There is no session of yours with that id.${await recentSessionsSaid(ctx)}`);
    }
    if (day !== null && row.date !== day) {
      return refuse(409, `That session is on ${row.date}, not ${day}. Send the one you are sure of, or both when they agree.`);
    }
    return { id: row.id };
  }
  const onDay = await ctx.db.sessionsOn(ctx.person, day!, SESSION_LIST + 1);
  if (onDay.length === 1) return { id: onDay[0].id };
  if (onDay.length === 0) return refuse(404, `You have no session on ${day}.${await recentSessionsSaid(ctx)}`);
  const howMany = onDay.length > SESSION_LIST ? `more than ${SESSION_LIST}` : String(onDay.length);
  return refuse(
    409,
    `You have ${howMany} sessions on ${day}, so the day alone does not say which. Send the session_id of the one you mean: ${onDay
      .slice(0, SESSION_LIST)
      .map(sessionLine)
      .join("; ")}.`,
  );
}

/**
 * Two json values, equal AS DOCUMENTS: key order does not count.
 *
 * Needed by the one undo here that compares content rather than counting sets
 * (session.restore-edit). A jsonb column hands an object's keys back in its own order,
 * not the order they were written in, so a string comparison of what the door wrote
 * against what it reads back would call an untouched session "changed since".
 */
function sameDoc(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameDoc(v, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined).sort();
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sameDoc(ao[k], bo[k]));
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

/** What one set takes. `weight_lb` — the read door's word — is accepted for `weight`
 *  (shapes.ts), so a set read off health.workout can be sent back as it came. */
const SET_KEYS = ["reps", "weight", "warmup"] as const;
const SET_SHAPE: ListShape = { takes: SET_KEYS };

/**
 * `{ reps, weight, warmup? }` out of whatever the caller sent — or every problem with it.
 *
 * FOUND 2026-10-10: A KEY THIS DID NOT KNOW WAS IGNORED, and a missing weight is zero.
 * Together that turned `{ reps: 8, weight_lb: 30 }` — the read door's own spelling —
 * into a BODYWEIGHT set: `weight_lb` was dropped without a word, the weight defaulted
 * to 0, and the reply said "logged". Nothing had gone wrong yet in the real log (it was
 * checked), but nothing would have said so when it did. Now the read door's word is
 * accepted, and any other key is refused by name, the way the top level of every call
 * already was.
 *
 * A set with no weight key AT ALL is still a bodyweight set: that is a real thing to
 * say ("8 pull-ups") and workoutVolume counts its reps instead of its tonnage.
 */
function readSet(raw: unknown): Shaped<{ reps: number; weight: number; warmup: boolean }> {
  if (!isObject(raw)) return { ok: false, problems: [`It is ${kindOfValue(raw)}, not an object like {"reps": 8, "weight": 135}.`] };
  const { value, unknown, clashes } = renameBy(raw, SET_SHAPE);
  const problems = [...clashes];
  if (unknown.length) problems.push(unknownKeysSays(unknown, SET_KEYS));
  const reps = count(value.reps, 0, 1000);
  if (reps === null) problems.push(value.reps === undefined ? "It has no reps." : "reps has to be a whole number.");
  // Zero is allowed and means bodyweight — workoutVolume counts a bodyweight set's
  // reps instead of its tonnage, so there is nothing to invent here.
  const weight = macro(value.weight === undefined ? 0 : value.weight, 2000);
  if (weight === null) problems.push("weight is a number of pounds, or zero for bodyweight.");
  if (value.warmup !== undefined && typeof value.warmup !== "boolean") problems.push("warmup is either true or false.");
  return shaped(problems, () => ({ reps: reps as number, weight: weight as number, warmup: value.warmup === true }));
}

/**
 * A whole list of sets, each one checked, every problem kept — or the sets, built the
 * history editor's way (loggedSet). `max` is how many one call may carry.
 */
function readSets(raw: unknown, max: number): Shaped<SetEntry[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [`sets has to be a list, like [{"reps": 8, "weight": 135}] — it was ${kindOfValue(raw)}.`] };
  }
  if (raw.length > max) return { ok: false, problems: [`That is more than ${max} sets at once.`] };
  const problems: string[] = [];
  const sets: SetEntry[] = [];
  raw.forEach((one, i) => {
    const s = readSet(one);
    if (s.ok) sets.push(loggedSet(s.value));
    else problems.push(itemSays(labelOf("Set", i), s.problems, isObject(one) ? one : null));
  });
  return shaped(problems, () => sets);
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

/** What one food in a meal takes. The read door's `calories`, `protein_g`, `carbs_g`
 *  and `fat_g` are accepted for the last four macro names (shapes.ts) — FOUND
 *  2026-10-10, after an assistant sent exactly the read door's words and was refused,
 *  more than once, for "needs p as a number of zero or more". */
const FOOD_KEYS = ["food_id", "qty", "grams", "name", "kcal", "p", "c", "f", "role"] as const;
const FOOD_SHAPE: ListShape = { takes: FOOD_KEYS };
const MACRO_KEYS = ["kcal", "p", "c", "f"] as const;

/**
 * One food, checked and understood but not yet looked up — the half of reading a
 * portion that needs no database, so it can run before anything is counted.
 *
 *   library  a food_id and an amount; the food itself is found later (foodsFrom)
 *   totals   anything else: a name and what it contained, with a weight or without
 */
type FoodPlan =
  | { from: "library"; label: string; id: string; qty: number | null; grams: number | null }
  | {
    from: "totals";
    totals: { name: string; role: FoodRole | undefined; kcal: number; p: number; c: number; f: number };
    grams: number | null;
  };

/** One food out of what the caller sent — every problem with it in one sentence that
 *  names it, or the plan for it. */
function planFood(raw: unknown, i: number): { ok: true; plan: FoodPlan } | { ok: false; problem: string } {
  if (!isObject(raw)) {
    return {
      ok: false,
      problem: itemSays(
        labelOf("Food", i),
        [`It is ${kindOfValue(raw)}, not an object. Give it a food_id and an amount, or a name and its macros.`],
        null,
      ),
    };
  }
  const { value, unknown, clashes } = renameBy(raw, FOOD_SHAPE);
  const problems = [...clashes];
  if (unknown.length) problems.push(unknownKeysSays(unknown, FOOD_KEYS));
  const name = cleanText(value.name, NAME_CAP);
  const label = labelOf("Food", i, name ? scrubCap(name, 40) : undefined);
  const fail = () => ({ ok: false as const, problem: itemSays(label, problems, raw) });

  if (value.food_id !== undefined) {
    if (MACRO_KEYS.some((k) => value[k] !== undefined)) {
      // Both at once is ambiguous rather than generous: the library food already
      // carries its macros, and a caller that sent both has two answers for what
      // this portion contained and no way to say which it meant.
      problems.push("Give a food_id and an amount, or a name and its macros — not both.");
    }
    const id = readId(value, "food_id");
    if (isRefusal(id)) problems.push(id.say);
    // How much of it: a count of its natural unit, or grams. Which unit a food is
    // counted in needs the food, so that half is decided in foodsFrom; the numbers
    // themselves are checked here.
    let qty: number | null = null;
    let grams: number | null = null;
    if (value.qty !== undefined) {
      qty = macro(value.qty, 100);
      if (qty === null || qty <= 0) problems.push("qty is a number above zero.");
    } else {
      grams = macro(value.grams, 5000);
      if (grams === null || grams <= 0) problems.push("It needs grams, or qty if the food is counted by the each.");
    }
    if (problems.length || isRefusal(id)) return fail();
    return { ok: true, plan: { from: "library", label, id: id.id, qty, grams } };
  }

  if (!name) {
    problems.push(value.name === undefined ? "Each food needs a name, or a food_id from the library." : "Its name is empty once cleaned.");
  }
  // EVERY missing macro in one sentence, not one per round trip.
  const macros: Record<string, number> = {};
  const missing: string[] = [];
  for (const k of MACRO_KEYS) {
    const v = macro(value[k]);
    if (v === null) missing.push(k);
    else macros[k] = v;
  }
  if (missing.length) {
    problems.push(`It needs ${listAnd(missing)} as ${missing.length === 1 ? "a number" : "numbers"} of zero or more.`);
  }
  if (value.role !== undefined && !isRole(value.role)) problems.push("role is protein, carb, veg, fat or other.");
  // WITH a weight it is a weighed portion; without one it is a serving — see
  // foodsFrom for why both go through a function in mealLog.
  let grams: number | null = null;
  if (value.grams !== undefined) {
    grams = macro(value.grams, 5000);
    if (grams === null || grams <= 0) problems.push("grams is its weight as a number above zero, or leave the weight out.");
  }
  if (problems.length) return fail();
  return {
    ok: true,
    plan: {
      from: "totals",
      totals: {
        name,
        role: value.role as FoodRole | undefined,
        kcal: macros.kcal,
        p: macros.p,
        c: macros.c,
        f: macros.f,
      },
      grams,
    },
  };
}

/** A whole meal's foods, each checked — every problem across every food, or the plans.
 *  `whenEmpty` is the tool's own sentence for a meal with nothing in it. */
function planFoods(raw: unknown, whenEmpty: string): Shaped<FoodPlan[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    const what = raw === undefined || Array.isArray(raw) ? "" : ` items has to be a list — it was ${kindOfValue(raw)}.`;
    return { ok: false, problems: [`${whenEmpty}${what}`] };
  }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, problems: [`That is more than ${MAX_ITEMS} foods in one meal. Split it into two.`] };
  }
  const problems: string[] = [];
  const plans: FoodPlan[] = [];
  raw.forEach((one, i) => {
    const p = planFood(one, i);
    if (p.ok) plans.push(p.plan);
    else problems.push(p.problem);
  });
  return shaped(problems, () => plans);
}

/**
 * The portions themselves, once the shape is known to be right. This is the half that
 * needs the database — a food_id outside the code tables is a row — and it still keeps
 * going past a problem, so two foods with bad ids are both named in one reply.
 */
async function foodsFrom(ctx: Ctx, plans: FoodPlan[]): Promise<LoggedItem[] | Refusal> {
  const items: LoggedItem[] = [];
  const problems: string[] = [];
  let allMissing = true;
  for (const plan of plans) {
    if (plan.from === "totals") {
      // itemFromServing stores a portion nobody weighed as one 100 g serving whose
      // per-100g values are its totals, so the macros come back exactly and the amount
      // reads "1 serving" instead of a weight nobody measured. Somebody saying "a
      // chicken breast, about 330 calories" knows the macros and not the grams, and
      // that is the normal case from a chat. Both are the app's own functions.
      items.push(
        plan.grams === null
          ? itemFromServing(plan.totals, newId())
          : itemFromTotals({ ...plan.totals, grams: plan.grams }, newId()),
      );
      continue;
    }
    const food = await foodById(ctx, plan.id);
    if (!food) {
      problems.push(`${plan.label}: There is no food with that id. Search for it first and use the id you get back.`);
      continue;
    }
    const amount = amountFor(plan, food);
    if (typeof amount === "string") {
      allMissing = false;
      problems.push(`${plan.label}: ${amount}`);
      continue;
    }
    // itemFromFood snapshots the food's per-100g values onto the portion, which is
    // why the log stays correct after that library food is edited. The app's own
    // function, so the door computes nothing.
    items.push(itemFromFood(food, amount, newId()));
  }
  // 404 only when every problem is a food that is not there — that is "the row it
  // named does not exist", which is what a 404 means on this door.
  if (problems.length) return refuse(allMissing ? 404 : 400, problems.join(" "));
  return items;
}

const ROLES: readonly string[] = ["protein", "carb", "veg", "fat", "other"];
const isRole = (v: unknown): v is FoodRole => typeof v === "string" && ROLES.includes(v);

/** How much of a food: grams, or a count of its natural unit. gramsOf() in
 *  mealLog turns the second into the first — the app's own rule, not ours. A
 *  sentence comes back when the food is not counted that way. */
function amountFor(plan: { qty: number | null; grams: number | null }, food: Food): Amount | string {
  if (plan.qty !== null) {
    const unit = unitFor(food);
    if (!unit) return `${scrubCap(food.name, 40) || "That food"} is not counted by the each, so I need grams instead.`;
    return { grams: gramsOf({ grams: 0, qty: plan.qty, unit }), qty: plan.qty, unit };
  }
  // planFood refuses a library food with neither, so grams is set whenever qty is not.
  return { grams: plan.grams as number };
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

/** log_weight's weight and date — both problems at once when both are wrong. */
function planWeight(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ weight: number; date: string }> {
  const pad = problemPad();
  const weight = money(payload.weight);
  if (weight === null) pad.no("I need the weight as a number, in pounds.");
  // A plausible range, not a judgement about his body: the point is to catch a
  // misheard number (19.84, 1984) before it lands in the trend line, where a
  // single wild point bends the slope the app reports.
  else if (weight < 50 || weight > 700) {
    pad.no("That weight does not look like pounds. Say it as you read it off the scale.");
  }
  const when = pad.take(dateFor(payload, ctx, BACK_WEIGH_IN));
  return pad.done(() => ({ weight: weight!, date: when!.date }));
}

const logWeight: Tool = {
  kind: "direct",
  does: "Record a weigh-in.",
  fields: ["weight", "date"],
  example: { weight: 182.4 },
  check: (payload, ctx) => problemsOf(planWeight(payload, ctx)),
  async run(payload, ctx) {
    const plan = planWeight(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { weight } = plan.value;
    const when = { date: plan.value.date };

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
  example: { date: "2026-09-01" },
  check: (payload, ctx) => problemsOf(planExistingDate(payload, ctx)),
  async run(payload, ctx) {
    const plan = planExistingDate(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = plan.value;
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

/** log_saved_meal's name and date — every problem with either. */
function planSavedMealLog(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ name: string; date: string }> {
  const pad = problemPad();
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name || name.length > 80) pad.no("Tell me the name of the saved meal, as it is spelled in the app.");
  const when = pad.take(dateFor(payload, ctx, BACK_MEAL));
  return pad.done(() => ({ name, date: when!.date }));
}

const logSavedMeal: Tool = {
  kind: "direct",
  does: "Log one of the household's saved meals by name.",
  fields: ["name", "date"],
  // A placeholder name, not a natural one. This tool looks a row up BY this name, and
  // handler.ts refuses any call that is exactly its tool's example — so a natural name
  // here ("Usual breakfast", which the test household really has) would turn away the
  // day somebody asked for the meal of that name. FOUND IN REVIEW 2026-10-10.
  example: { name: "Sample saved meal" },
  check: (payload, ctx) => problemsOf(planSavedMealLog(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSavedMealLog(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { name } = plan.value;
    const when = { date: plan.value.date };

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

/** log_meal's date and foods, every problem with either. */
function planMeal(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ date: string; plans: FoodPlan[] }> {
  const problems: string[] = [];
  const when = dateFor(payload, ctx, BACK_MEAL);
  if (isRefusal(when)) problems.push(when.say);
  const foods = planFoods(
    payload.items,
    "I need at least one food in items. Each one is either a food_id and an amount, or a name with its macros (and its weight in grams, if it was weighed).",
  );
  problems.push(...problemsOf(foods));
  if (isRefusal(when) || !foods.ok) return { ok: false, problems };
  return { ok: true, value: { date: when.date, plans: foods.value } };
}

const logMeal: Tool = {
  kind: "direct",
  does: "Log food into a day — library foods by id, or anything else by name with its weight and macros.",
  fields: ["date", "items", "name"],
  // Both kinds of food in one meal: a library food by id and a count, and anything else
  // by name with what it contained. `eggs` is one of the built-in foods in the code.
  // The meal's name says "Sample" because a call that is exactly the example is refused
  // (handler.ts) — see `example` in kit.ts.
  example: {
    name: "Sample breakfast",
    items: [
      { food_id: "eggs", qty: 2 },
      { name: "Greek yogurt", grams: 170, kcal: 150, p: 15, c: 8, f: 4 },
    ],
  },
  lists: { items: FOOD_SHAPE },
  check: (payload, ctx) => problemsOf(planMeal(payload, ctx)),
  async run(payload, ctx) {
    const plan = planMeal(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = { date: plan.value.date };
    const items = await foodsFrom(ctx, plan.value.plans);
    if (isRefusal(items)) return items;
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

/** delete_meal's day and meal id — both problems at once. */
function planMealDelete(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ date: string; id: string }> {
  const pad = problemPad();
  const when = pad.take(existingDate(payload, ctx));
  const id = pad.take(readId(payload, "meal_id"));
  return pad.done(() => ({ date: when!.date, id: id!.id }));
}

const deleteMeal: Tool = {
  kind: "direct",
  does: "Take one meal off a day.",
  fields: ["date", "meal_id"],
  example: { meal_id: EXAMPLE_ID },
  check: (payload, ctx) => problemsOf(planMealDelete(payload, ctx)),
  async run(payload, ctx) {
    const plan = planMealDelete(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = { date: plan.value.date };
    const id = { id: plan.value.id };

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

/** edit_meal's date, meal and changes — every problem with any of them. */
function planMealEdit(
  payload: Record<string, unknown>,
  ctx: ShapeCtx,
): Shaped<{ date: string; id: string; plans: FoodPlan[] | null }> {
  const problems: string[] = [];
  const when = existingDate(payload, ctx);
  if (isRefusal(when)) problems.push(when.say);
  const id = readId(payload, "meal_id");
  if (isRefusal(id)) problems.push(id.say);
  const wantsItems = payload.items !== undefined;
  if (payload.name === undefined && !wantsItems) problems.push("Tell me the new name, or the new list of foods, or both.");
  const foods = wantsItems
    ? planFoods(payload.items, "A meal has to have at least one food. To get rid of it, delete the meal.")
    : null;
  if (foods) problems.push(...problemsOf(foods));
  if (problems.length || isRefusal(when) || isRefusal(id) || (foods && !foods.ok)) return { ok: false, problems };
  return { ok: true, value: { date: when.date, id: id.id, plans: foods && foods.ok ? foods.value : null } };
}

const editMeal: Tool = {
  kind: "direct",
  does: "Rename a meal on a day, or replace what was in it.",
  fields: ["date", "meal_id", "name", "items"],
  example: { meal_id: EXAMPLE_ID, items: [{ name: "White rice", grams: 200, kcal: 260, p: 5, c: 57, f: 0.6 }] },
  lists: { items: FOOD_SHAPE },
  check: (payload, ctx) => problemsOf(planMealEdit(payload, ctx)),
  async run(payload, ctx) {
    const plan = planMealEdit(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = { date: plan.value.date };
    const id = { id: plan.value.id };
    const wantsName = payload.name !== undefined;

    let items: LoggedItem[] | null = null;
    if (plan.value.plans) {
      const built = await foodsFrom(ctx, plan.value.plans);
      if (isRefusal(built)) return built;
      items = built;
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

/** mark_day's day, mark and note — every problem with them. */
function planMark(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ date: string; mark: string }> {
  const pad = problemPad();
  const when = pad.take(existingDate(payload, ctx));
  const mark = typeof payload.mark === "string" ? payload.mark : "";
  if (!MARKS.includes(mark)) pad.no('mark is "estimated" for followed roughly, "skipped" for off plan, or "clear".');
  if (mark === "clear" && payload.note !== undefined) {
    pad.no("Clearing the mark clears the note with it, so leave the note out.");
  }
  return pad.done(() => ({ date: when!.date, mark }));
}

const markDay: Tool = {
  kind: "direct",
  does: "Mark a day as followed-roughly or off-plan, with a note, or clear the mark.",
  fields: ["date", "mark", "note"],
  // "Sample" in the note for the reason on log_meal's example.
  example: { mark: "estimated", note: "Sample note: ate out, roughly on plan" },
  check: (payload, ctx) => problemsOf(planMark(payload, ctx)),
  async run(payload, ctx) {
    const plan = planMark(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = { date: plan.value.date };
    const { mark } = plan.value;
    const note = payload.note === undefined ? null : cleanText(payload.note, NOTE_CAP);
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

/** save_meal's name and source — every problem with them. The meal off a day is read
 *  later; this only decides which of the two ways the call is asking for. */
function planSavedMeal(
  payload: Record<string, unknown>,
  ctx: ShapeCtx,
): Shaped<{ name: string; fromDay: { date: string; id: string } | null; plans: FoodPlan[] | null }> {
  const problems: string[] = [];
  const name = cleanText(payload.name, NAME_CAP);
  if (!name) problems.push("A saved meal needs a name, so it can be logged by name later.");
  const fromDay = payload.meal_id !== undefined;
  const fromItems = payload.items !== undefined;
  if (fromDay === fromItems) problems.push("Give me a meal_id off a day, or a list of foods — one or the other.");
  let day: { date: string; id: string } | null = null;
  if (fromDay && !fromItems) {
    const when = existingDate(payload, ctx);
    if (isRefusal(when)) problems.push(when.say);
    const id = readId(payload, "meal_id");
    if (isRefusal(id)) problems.push(id.say);
    if (!isRefusal(when) && !isRefusal(id)) day = { date: when.date, id: id.id };
  }
  let plans: FoodPlan[] | null = null;
  if (fromItems && !fromDay) {
    const foods = planFoods(payload.items, "A saved meal needs at least one food.");
    if (foods.ok) plans = foods.value;
    else problems.push(...foods.problems);
  }
  return shaped(problems, () => ({ name, fromDay: day, plans }));
}

const saveMeal: Tool = {
  kind: "direct",
  does: "Save a meal for re-use later — one already logged on a day, or a list of foods.",
  fields: ["name", "date", "meal_id", "items"],
  // The top-level name is a placeholder on purpose: a call that is exactly the example
  // is refused (handler.ts), and the inside of the list is natural enough that somebody
  // might really send it. A "Sample" name is what keeps the two apart. The shapes INSIDE
  // the list are the part worth copying, and those stay realistic.
  example: { name: "Sample shake", items: [{ name: "Protein shake", kcal: 160, p: 30, c: 6, f: 2 }] },
  lists: { items: FOOD_SHAPE },
  check: (payload, ctx) => problemsOf(planSavedMeal(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSavedMeal(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const name = plan.value.name;
    // A duplicate name is refused, and this is a guard the door adds rather than
    // one it inherits: health.log_saved_meal looks a meal up BY NAME and refuses
    // when two share one, so a second "Usual breakfast" makes both unloggable from
    // a chat. The app lets you make one because the app picks from a list.
    const clash = await ctx.db.findSavedMealsByName(name);
    if (clash.length > 0) {
      return refuse(409, `There is already a saved meal called ${scrubCap(name, 40)}. Pick another name, or change that one.`);
    }

    let items: LoggedItem[];
    const fromDay = plan.value.fromDay;
    if (fromDay) {
      const day = await ctx.db.readMealDay(ctx.person, fromDay.date);
      const hit = mealsOf(day).find((m) => m.id === fromDay.id);
      if (!hit) return refuse(404, `There is no meal with that id on ${fromDay.date}.`);
      items = hit.items;
    } else {
      const built = await foodsFrom(ctx, plan.value.plans ?? []);
      if (isRefusal(built)) return built;
      items = built;
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

/** update_saved_meal's id and changes — every problem with them. */
function planSavedMealEdit(payload: Record<string, unknown>): Shaped<{ id: string; plans: FoodPlan[] | null }> {
  const problems: string[] = [];
  const id = readId(payload, "id");
  if (isRefusal(id)) problems.push(id.say);
  const wantsName = payload.name !== undefined;
  const wantsItems = payload.items !== undefined;
  if (!wantsName && !wantsItems) problems.push("Tell me the new name, or the new list of foods, or both.");
  if (wantsName && !cleanText(payload.name, NAME_CAP)) problems.push("A saved meal needs a name.");
  let plans: FoodPlan[] | null = null;
  if (wantsItems) {
    const foods = planFoods(payload.items, "A saved meal needs at least one food.");
    if (foods.ok) plans = foods.value;
    else problems.push(...foods.problems);
  }
  if (problems.length || isRefusal(id)) return { ok: false, problems };
  return { ok: true, value: { id: id.id, plans } };
}

const updateSavedMeal: Tool = {
  kind: "direct",
  does: "Rename a saved meal, or change what is in it.",
  fields: ["id", "name", "items"],
  example: { id: EXAMPLE_ID, name: "Weekday breakfast" },
  lists: { items: FOOD_SHAPE },
  check: (payload) => problemsOf(planSavedMealEdit(payload)),
  async run(payload, ctx) {
    const plan = planSavedMealEdit(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const id = { id: plan.value.id };
    const wantsName = payload.name !== undefined;
    const before = await ctx.db.readSavedMeal(id.id);
    if (!before) return refuse(404, "There is no saved meal with that id.");

    let name: string | undefined;
    if (wantsName) {
      name = cleanText(payload.name, NAME_CAP);
      const clash = (await ctx.db.findSavedMealsByName(name)).filter((m) => m.id !== id.id);
      if (clash.length > 0) return refuse(409, `Another saved meal is already called ${scrubCap(name, 40)}.`);
    }
    let items: LoggedItem[] | undefined;
    if (plan.value.plans) {
      const built = await foodsFrom(ctx, plan.value.plans);
      if (isRefusal(built)) return built;
      items = built;
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
  example: { id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, "id")),
  async run(payload, ctx) {
    const plan = planIds(payload, "id");
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const id = { id: plan.value[0] };
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

/** add_food's name, role, four macros and serving — EVERY missing macro named, not
 *  the first one, so a food sent with two of the four hears about the other two. */
function planFoodRow(payload: Record<string, unknown>): Shaped<{
  name: string;
  nums: Record<string, number>;
  serving: number | null;
}> {
  const pad = problemPad();
  const name = cleanText(payload.name, NAME_CAP);
  if (!name) pad.no("A food needs a name.");
  if (payload.role !== undefined && !isRole(payload.role)) pad.no("role is protein, carb, veg, fat or other.");
  const nums: Record<string, number> = {};
  for (const k of ["kcal", "p", "c", "f"] as const) {
    const v = macro(payload[k], 1000);
    if (v === null) pad.no(`${name || "It"} needs ${k} per 100 g as a number of zero or more.`);
    else nums[k] = v;
  }
  let serving: number | null = null;
  if (payload.serving !== undefined) {
    serving = macro(payload.serving, 5000);
    if (serving === null || serving <= 0) pad.no("serving is the usual portion in grams, above zero.");
  }
  return pad.done(() => ({ name, nums, serving }));
}

const addFood: Tool = {
  kind: "direct",
  does: "Add a food to the household's library, with its macros per 100 g.",
  fields: ["name", "role", "kcal", "p", "c", "f", "serving", "note", "barcode"],
  example: { name: "Example protein bar", role: "protein", kcal: 380, p: 30, c: 40, f: 10, serving: 60 },
  check: (payload) => problemsOf(planFoodRow(payload)),
  async run(payload, ctx) {
    const plan = planFoodRow(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { name, nums, serving } = plan.value;
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
  example: { id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, "id")),
  async run(payload, ctx) {
    const plan = planIds(payload, "id");
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const id = { id: plan.value[0] };
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

/** set_macro_target's four numbers — every one that is missing or wrong, at once. */
function planMacroTarget(payload: Record<string, unknown>): Shaped<MacroRow> {
  const pad = problemPad();
  const nums: Record<string, number> = {};
  for (const k of ["kcal", "p", "c", "f"] as const) {
    const v = macro(payload[k], k === "kcal" ? 10_000 : 1000);
    if (v === null) pad.no(`The target needs ${k} as a number of zero or more.`);
    else nums[k] = v;
  }
  if (nums.kcal !== undefined && nums.kcal < 800) {
    // Not a judgement, a misheard-number guard, same as the weigh-in range: a
    // target this low would make every day read as over budget and the streak
    // would quietly stop counting.
    pad.no("That calorie target is below 800, which reads like a misheard number. Say it again if it is right.");
  }
  return pad.done(() => ({ kcal: nums.kcal, p: nums.p, c: nums.c, f: nums.f }));
}

const setMacroTarget: Tool = {
  kind: "direct",
  does: "Set the daily macro target.",
  fields: ["kcal", "p", "c", "f"],
  // Deliberately not round numbers. A call that is exactly the example is refused, and
  // 2400 / 160 / 250 / 70 is a target a person might really say.
  example: { kcal: 2350, p: 165, c: 245, f: 72 },
  check: (payload) => problemsOf(planMacroTarget(payload)),
  async run(payload, ctx) {
    const plan = planMacroTarget(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const target: MacroRow = plan.value;
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
  subject = scrubCap(name, 40),
): { exerciseId: string; name: string; muscle: string; custom: boolean } | Refusal {
  const lib = findExercise(BUNDLED_EXERCISES, name);
  if (lib) {
    // THE NAME AS IT WAS SAID, LINKED. FOUND 2026-10-10: a lift logged under its Chinese
    // name was saved as a custom exercise, because the library only knew English names —
    // 深蹲 was "not in the library" although the squat is. The library now carries the
    // standard Chinese gym names as aliases (scripts/exercisedata/overrides.json), so 深蹲
    // FINDS its library entry. What it is then CALLED is kept as it was said: a name in
    // another script than the library's is a language, not a spelling to correct, and
    // the history it joins is already written that way. The library id is what links
    // it, exactly as start_session keeps a routine's own name beside the id it resolved
    // to. A Latin name still becomes the library's spelling, so "tricep pushdowns" is
    // stored as "Triceps pushdown", the way it always has been.
    const own = OTHER_SCRIPT.test(name) ? name : lib.name;
    return { exerciseId: lib.id, name: own, muscle: lib.muscle, custom: false };
  }
  if (typeof muscle !== "string" || !MUSCLES.includes(muscle)) {
    // "Did you mean", from the library itself. FOUND 2026-10-10: this sentence used to
    // offer "give a muscle" or "search the library", and the assistant picked the muscle
    // every time it was offered — it never called health.exercises — so lifts the
    // library knows were stored as custom ones, each counted toward one muscle. Naming
    // the closest library entries makes the right answer the easy one.
    const near = closestExercises(name);
    const offer = near.length
      ? ` The closest names in it are ${near.map((e) => `${e.name} (${e.muscle})`).join(", ")} — send one of those as the name,`
      : " Search health.exercises for the name it is under,";
    return refuse(
      400,
      `${subject} is not in the exercise library.${offer} or keep this name and say which muscle it works — one of ${MUSCLES.join(", ")}.`,
    );
  }
  return { exerciseId: "", name, muscle, custom: true };
}

/** A name with a character outside the Latin scripts (and the punctuation and symbols
 *  around them) — Chinese, the other script the library carries aliases in. See
 *  resolveExercise. */
const OTHER_SCRIPT = /[^\u0020-\u024F\u1E00-\u1EFF\u2000-\u206F]/;

/** How many "did you mean" names a refusal offers, and how alike a name has to be to
 *  be offered at all. Below the floor it is noise: "Zercher thing" is not "Lat pulldown"
 *  just because both have an "er" in them. */
const NEAR_MAX = 3;
const NEAR_FLOOR = 0.35;

/** A name's two-character pieces, counted, with the spaces taken out — so "goblet
 *  squats" and "gobletsquat" agree, and a Chinese name (which has no spaces) works the
 *  same way an English one does. */
function pairsOf(s: string): Map<string, number> {
  const t = normName(s).replace(/\s+/g, "");
  const out = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const p = t.slice(i, i + 2);
    out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}

/** How alike two names are, from 0 to 1: the share of two-character pieces they have
 *  in common (the Sørensen–Dice score). A ranking, not a measurement — it decides which
 *  three names a refusal suggests, and nothing is ever stored from it. */
function likeness(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  let total = 0;
  for (const n of a.values()) total += n;
  for (const n of b.values()) total += n;
  if (total === 0) return 0;
  for (const [p, n] of a) shared += Math.min(n, b.get(p) ?? 0);
  return (2 * shared) / total;
}

/**
 * The library entries most like a name the library does not know, best first — by
 * their own name or any alias, the Chinese ones included. Hidden entries (near-duplicates
 * folded into another) are never offered, because the one to log is the one they were
 * folded into.
 */
export function closestExercises(name: string): Exercise[] {
  const want = pairsOf(name);
  if (want.size === 0) return [];
  const best = new Map<string, { ex: Exercise; score: number }>();
  for (const ex of BUNDLED_EXERCISES) {
    if (ex.hidden) continue;
    for (const label of [ex.name, ...(ex.aliases ?? [])]) {
      const score = likeness(want, pairsOf(label));
      if (score > (best.get(ex.id)?.score ?? 0)) best.set(ex.id, { ex, score });
    }
  }
  return [...best.values()]
    .filter((b) => b.score >= NEAR_FLOOR)
    .sort((a, b) => b.score - a.score || a.ex.name.localeCompare(b.ex.name))
    .slice(0, NEAR_MAX)
    .map((b) => b.ex);
}

/**
 * What one exercise in a logged workout takes. `exercise` is a second word for `name`
 * here and only here — it is what health.log_sets calls the same thing, and FOUND
 * 2026-10-10 it is the word assistants reached for: "Each exercise needs a name." was
 * refused for it again and again, from more than one phone. `duration_min` and
 * `duration` are the read door's words for `minutes`, and the reason one back-fill had
 * a THIRD round of refusals: the minutes were there all along, under a key this ignored.
 */
const ENTRY_KEYS = ["name", "muscle", "sets", "minutes"] as const;
const ENTRY_ALIASES: Readonly<Record<string, string>> = Object.freeze({ exercise: "name" });
const ENTRY_SHAPE: ListShape = { takes: ENTRY_KEYS, extra: ENTRY_ALIASES, lists: { sets: SET_SHAPE } };

/** `{ name, muscle?, sets?, minutes? }` out of whatever the caller sent — every problem
 *  with it in one sentence that names it, or the entry. `i` counts from zero. */
function readEntry(raw: unknown, i: number): { ok: true; entry: ExerciseEntry; custom: boolean } | { ok: false; problem: string } {
  if (!isObject(raw)) {
    return {
      ok: false,
      problem: itemSays(
        labelOf("Exercise", i),
        [`It is ${kindOfValue(raw)}, not an object like {"name": "Goblet squat", "sets": [{"reps": 10, "weight": 35}]}.`],
        null,
      ),
    };
  }
  const { value, unknown, clashes } = renameBy(raw, ENTRY_SHAPE);
  const problems = [...clashes];
  if (unknown.length) {
    // The likeliest wrong guess gets its own pointer: reps and weight belong to a SET.
    const setish = unknown.some((k) => k === "reps" || k === "weight" || k === "weight_lb");
    problems.push(unknownKeysSays(unknown, ENTRY_KEYS) + (setish ? " Reps and weight go inside sets, one object per set." : ""));
  }
  const name = cleanText(value.name, NAME_CAP);
  if (!name) {
    problems.push(value.name === undefined ? "It has no name — send the exercise's name as name." : "Its name is empty once cleaned.");
  }
  const ex = name ? resolveExercise(name, value.muscle, "It") : null;
  if (ex && isRefusal(ex)) problems.push(ex.say);

  let sets: SetEntry[] = [];
  if (value.sets !== undefined) {
    const read = readSets(value.sets, MAX_SETS);
    if (read.ok) sets = read.value;
    else problems.push(...read.problems);
  }
  let duration: number | null = null;
  if (value.minutes !== undefined) {
    duration = macro(value.minutes, 600);
    if (duration === null || duration <= 0) problems.push("minutes is a number above zero.");
  }
  if (value.sets === undefined && value.minutes === undefined) {
    problems.push("It needs its sets, or how many minutes it took.");
  } else if (Array.isArray(value.sets) && value.sets.length === 0 && value.minutes === undefined) {
    problems.push("Its sets list is empty — give the sets, or how many minutes it took.");
  }

  const label = labelOf("Exercise", i, name ? scrubCap(name, 40) : undefined);
  if (problems.length || !ex || isRefusal(ex)) return { ok: false, problem: itemSays(label, problems, raw) };
  const entry = newEntry(ex, sets);
  return { ok: true, entry: duration === null ? entry : { ...entry, duration }, custom: ex.custom };
}

// ── health.start_session ─────────────────────────────────────────────────────

/** start_session's date and routine name — the routine itself is looked up later. */
function planSessionStart(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ date: string; routine: string | null }> {
  const pad = problemPad();
  const when = pad.take(dateFor(payload, ctx, BACK_SESSION));
  let routine: string | null = null;
  if (payload.routine !== undefined) {
    routine = cleanText(payload.routine, NAME_CAP);
    if (!routine) pad.no("Tell me the routine by name, as the app lists it.");
  }
  return pad.done(() => ({ date: when!.date, routine }));
}

const startSession: Tool = {
  kind: "direct",
  does: "Start a session for today — empty, or laid out from one of the routines.",
  fields: ["date", "name", "routine"],
  // A placeholder name, for the same reason as log_saved_meal's: a call that is exactly
  // the example is refused, and "Evening lift" is a session somebody might really start.
  example: { name: "Sample session" },
  check: (payload, ctx) => problemsOf(planSessionStart(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSessionStart(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = { date: plan.value.date };
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
    if (plan.value.routine !== null) {
      const routine = await routineByName(ctx, plan.value.routine);
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

/** log_sets' session, lift, sets and minutes — every problem with any of them. Which
 *  session the id or the day finds is whichSession's, in run(), after this. */
function planLogSets(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{
  ex: { exerciseId: string; name: string; muscle: string; custom: boolean };
  sets: SetEntry[];
  minutes: number | null;
}> {
  const problems: string[] = sessionRefProblems(payload, ctx);
  const name = cleanText(payload.exercise, NAME_CAP);
  if (!name) problems.push("Tell me which lift, by name, as exercise.");
  const ex = name ? resolveExercise(name, payload.muscle) : null;
  if (ex && isRefusal(ex)) problems.push(ex.say);
  let sets: SetEntry[] = [];
  if (payload.sets !== undefined) {
    if (Array.isArray(payload.sets) && payload.sets.length === 0) problems.push("Give me the sets as a list with at least one set in it.");
    const read = readSets(payload.sets, MAX_SETS);
    if (read.ok) sets = read.value;
    else problems.push(...read.problems);
  }
  let minutes: number | null = null;
  if (payload.minutes !== undefined) {
    minutes = macro(payload.minutes, 600);
    if (minutes === null || minutes <= 0) problems.push("minutes is a number above zero.");
  }
  if (payload.sets === undefined && payload.minutes === undefined) {
    problems.push("Give me either the sets or how many minutes it took.");
  }
  if (problems.length || !ex || isRefusal(ex)) return { ok: false, problems };
  return { ok: true, value: { ex, sets, minutes } };
}

const logSets: Tool = {
  kind: "direct",
  does: "Add sets to an exercise in a session — creating the exercise if it is not in it yet. Name the session by session_id, or by session_date when it was your only one that day.",
  fields: ["session_id", "session_date", "exercise", "muscle", "sets", "minutes"],
  example: { session_id: EXAMPLE_ID, exercise: "Goblet squat", sets: [{ reps: 10, weight: 35 }, { reps: 8, weight: 35 }] },
  lists: { sets: SET_SHAPE },
  check: (payload, ctx) => problemsOf(planLogSets(payload, ctx)),
  async run(payload, ctx) {
    const plan = planLogSets(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { ex, sets, minutes } = plan.value;
    // Which session, AFTER every shape check, so a malformed call costs no read.
    const sid = await whichSession(payload, ctx);
    if (isRefusal(sid)) return sid;

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

/** edit_set's session, set id and changes — every problem with any of them. */
function planSetEdit(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{
  setId: string;
  patch: { reps?: number; weight?: number; warmup?: boolean };
}> {
  const pad = problemPad();
  pad.all(sessionRefProblems(payload, ctx));
  const setId = pad.take(readId(payload, "set_id"));
  const patch: { reps?: number; weight?: number; warmup?: boolean } = {};
  if (payload.reps !== undefined) {
    const n = count(payload.reps, 0, 1000);
    if (n === null) pad.no("reps is a whole number.");
    else patch.reps = n;
  }
  if (payload.weight !== undefined) {
    const n = macro(payload.weight, 2000);
    if (n === null) pad.no("weight is a number of pounds, or zero for bodyweight.");
    else patch.weight = n;
  }
  if (payload.warmup !== undefined) {
    if (typeof payload.warmup !== "boolean") pad.no("warmup is either true or false.");
    else patch.warmup = payload.warmup;
  }
  if (payload.reps === undefined && payload.weight === undefined && payload.warmup === undefined) {
    pad.no("Tell me the new reps, the new weight, or whether it was a warm-up.");
  }
  return pad.done(() => ({ setId: setId!.id, patch }));
}

const editSetTool: Tool = {
  kind: "direct",
  does: "Change one set's reps or weight, or mark it a warm-up. Name the session by session_id, or by session_date when it was your only one that day.",
  fields: ["session_id", "session_date", "set_id", "reps", "weight", "warmup"],
  example: { session_id: EXAMPLE_ID, set_id: EXAMPLE_ID, reps: 9 },
  check: (payload, ctx) => problemsOf(planSetEdit(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSetEdit(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const setId = { id: plan.value.setId };
    const { patch } = plan.value;
    const sid = await whichSession(payload, ctx);
    if (isRefusal(sid)) return sid;

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

/** delete_set's session and set id — every problem with either. */
function planSetRef(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<string> {
  const pad = problemPad();
  pad.all(sessionRefProblems(payload, ctx));
  const setId = pad.take(readId(payload, "set_id"));
  return pad.done(() => setId!.id);
}

const deleteSet: Tool = {
  kind: "direct",
  does: "Take one set off a session. Name the session by session_id, or by session_date when it was your only one that day.",
  fields: ["session_id", "session_date", "set_id"],
  example: { session_id: EXAMPLE_ID, set_id: EXAMPLE_ID },
  check: (payload, ctx) => problemsOf(planSetRef(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSetRef(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const setId = { id: plan.value };
    const sid = await whichSession(payload, ctx);
    if (isRefusal(sid)) return sid;

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
  does: "Finish a session, and name it or add a note while you are there. Name the session by session_id, or by session_date when it was your only one that day.",
  fields: ["session_id", "session_date", "name", "notes"],
  example: { session_id: EXAMPLE_ID, notes: "Felt strong" },
  check: (payload, ctx) => problemsOf(planSessionRef(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSessionRef(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const name = payload.name === undefined ? null : cleanText(payload.name, NAME_CAP);
    const notes = payload.notes === undefined ? null : cleanText(payload.notes, NOTE_CAP);
    const sid = await whichSession(payload, ctx);
    if (isRefusal(sid)) return sid;

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

/**
 * log_workout's date and exercises — EVERY problem with every exercise, in one answer.
 *
 * This is the parser a real back-fill needed: several workouts sent at once, each
 * refused again and again for a different reason each time, because the old loop
 * returned at the first bad exercise and the first bad field in it. Now each exercise
 * is read to the end and each one's problems are said together, under its number and
 * its name, with the keys it carried — so the second try can be the last.
 */
function planWorkout(
  payload: Record<string, unknown>,
  ctx: ShapeCtx,
): Shaped<{ date: string; exercises: ExerciseEntry[]; custom: string[] }> {
  const problems: string[] = [];
  const when = dateFor(payload, ctx, BACK_SESSION);
  if (isRefusal(when)) problems.push(when.say);
  const raw = payload.exercises;
  const exercises: ExerciseEntry[] = [];
  const custom: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    const what = raw === undefined || Array.isArray(raw) ? "" : ` exercises has to be a list — it was ${kindOfValue(raw)}.`;
    problems.push(`I need at least one exercise in exercises, each with its name and its sets or how many minutes it took.${what}`);
  } else if (raw.length > MAX_ENTRIES) {
    problems.push(`That is more than ${MAX_ENTRIES} exercises in one session.`);
  } else {
    raw.forEach((one, i) => {
      const read = readEntry(one, i);
      if (!read.ok) {
        problems.push(read.problem);
        return;
      }
      exercises.push(read.entry);
      if (read.custom) custom.push(read.entry.name);
    });
  }
  if (problems.length || isRefusal(when)) return { ok: false, problems };
  return { ok: true, value: { date: when.date, exercises, custom } };
}

const logWorkout: Tool = {
  kind: "direct",
  does: "Log a whole session that is already done, in one go.",
  fields: ["date", "name", "notes", "exercises"],
  // A lift with its sets and a cardio entry with its minutes, because those are the two
  // shapes an exercise can take — and the second is the one nobody could guess. The
  // session's name says "Sample" for the reason on log_meal's example.
  example: {
    name: "Sample legs day",
    exercises: [
      { name: "Goblet squat", sets: [{ reps: 10, weight: 35 }, { reps: 10, weight: 35 }] },
      { name: "Walking", minutes: 30 },
    ],
  },
  lists: { exercises: ENTRY_SHAPE },
  check: (payload, ctx) => problemsOf(planWorkout(payload, ctx)),
  async run(payload, ctx) {
    const plan = planWorkout(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const when = { date: plan.value.date };
    const { exercises, custom } = plan.value;
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
  does: "Delete a whole session. Name it by session_id, or by session_date when it was your only one that day. To fix part of a finished session, use health.edit_session instead.",
  fields: ["session_id", "session_date"],
  example: { session_id: EXAMPLE_ID },
  check: (payload, ctx) => problemsOf(planSessionRef(payload, ctx)),
  async run(payload, ctx) {
    const plan = planSessionRef(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const sid = await whichSession(payload, ctx);
    if (isRefusal(sid)) return sid;
    // Read again for the whole row: whichSession names a session, and the undo below has
    // to carry everything in it. Gone in between is the same answer it always was.
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

// ── health.edit_session ──────────────────────────────────────────────────────
//
// ADDED 2026-10-10. A FINISHED SESSION COULD BE DELETED AND NOTHING ELSE. FOUND in the
// audit log: within about a minute, one assistant alternated health.delete_session and
// health.log_workout over a run of back-dated sessions. Each held duration-only exercises,
// and the fix wanted was a different set of exercises with different minutes. edit_set
// and delete_set work one SET at a time, and a duration-only exercise has no set — so
// nothing could remove, replace or re-time a whole exercise, and the only route was delete
// and re-log: two writes per session, a new id for each, and the old ids dead in anything
// that held them.
// The app's own history editor (EditWorkoutSheet in src/views/WorkoutSection.tsx) does
// all of this in one save; this is that, from a chat, plus the date, which the screen
// shows and cannot change.
//
// THE EXERCISE LIST IS REPLACED WHOLE, in health.log_workout's own shape — name, muscle
// for a lift the library does not know, sets or minutes — through the same readEntry and
// the same finishWorkout. One shape for "a finished session's exercises" across the two
// tools, so an assistant that can log one can correct one; and one call for a case like
// that rather than a remove followed by three adds. The new exercises get new ids, exactly as
// a logged session's do.
//
// FINISHED SESSIONS ONLY. A running one is the live logger's, on a phone that may be
// mid-set, and log_sets / edit_set / finish_session already edit it the way the logger
// does. A finished one is history, which is what this corrects.
//
// THE UNDO COMPARES CONTENT, AND NEVER RESTORES A SNAPSHOT BLIND. It puts back only the
// fields this call changed, and only if each still holds EXACTLY what this call wrote
// (compared as documents — see sameDoc). Anything the phone changed in one of those
// fields since is the newer, deliberate answer, so the undo refuses rather than overwrite
// it; a field this call did not touch is never written at all. That is the
// compare-and-set every finance undo makes, on a document. It is also why this undo is
// not marked fragile: it cannot overwrite anything, only decline.

/** The fields health.edit_session writes, and so the only ones its undo will put back.
 *  Checked again on the way back IN — a before-state is read out of a table, and a door
 *  whose undo wrote whatever field that table named would have a write surface equal to
 *  the table's contents. */
const EDITABLE: readonly (keyof SessionPatch)[] = ["name", "notes", "date", "exercises"];

/** The handler's name, as stored in muse_undo. A NAME IN A DATABASE ROW — renaming it
 *  orphans every token already handed out, so a rename is a migration. */
const SESSION_RESTORE_EDIT = "session.restore-edit";

/**
 * edit_session's session, its corrections, and every exercise in a new list read to the
 * end — every problem with any of them, in one answer. Which session the id or the day
 * finds is whichSession's, in run(), after this; whether the session is finished, and
 * whether the new list has anything logged in it once the app's Finish has run, are
 * decided against the row inside editSession.
 */
function planEditSession(
  payload: Record<string, unknown>,
  ctx: ShapeCtx,
): Shaped<{ name?: string; notes?: string; date?: string; exercises?: ExerciseEntry[]; custom: string[] }> {
  const problems: string[] = sessionRefProblems(payload, ctx);
  if (
    payload.name === undefined &&
    payload.notes === undefined &&
    payload.date === undefined &&
    payload.exercises === undefined
  ) {
    problems.push("Tell me what to correct: name, notes, date, or exercises (the whole list the session should end up with).");
  }
  const name = payload.name === undefined ? undefined : cleanText(payload.name, NAME_CAP);
  const notes = payload.notes === undefined ? undefined : cleanText(payload.notes, NOTE_CAP);
  let date: string | undefined;
  if (payload.date !== undefined) {
    // A session MOVED to a day is filed under it like a new one, so the same back-window
    // as health.log_workout, and Arizona's today rather than the runtime's.
    const when = dateFor(payload, ctx, BACK_SESSION);
    if (isRefusal(when)) problems.push(when.say);
    else date = when.date;
  }
  let exercises: ExerciseEntry[] | undefined;
  const custom: string[] = [];
  if (payload.exercises !== undefined) {
    const raw = payload.exercises;
    if (!Array.isArray(raw) || raw.length === 0) {
      const what = Array.isArray(raw) ? "" : ` It was ${kindOfValue(raw)}.`;
      problems.push(
        `exercises is the whole list the session should end up with: at least one, each with its sets or how many minutes it took — the shape health.log_workout takes. To throw the whole session away, use health.delete_session.${what}`,
      );
    } else if (raw.length > MAX_ENTRIES) {
      problems.push(`That is more than ${MAX_ENTRIES} exercises in one session.`);
    } else {
      exercises = [];
      raw.forEach((one, i) => {
        const read = readEntry(one, i);
        if (!read.ok) {
          problems.push(read.problem);
          return;
        }
        exercises!.push(read.entry);
        if (read.custom) custom.push(read.entry.name);
      });
    }
  }
  return shaped(problems, () => ({ name, notes, date, exercises, custom }));
}

const editSessionTool: Tool = {
  kind: "direct",
  does: "Correct a finished session: its name, notes or date, or its whole exercise list — send every exercise it should end up with, in health.log_workout's shape. Name the session by session_id, or by session_date when it was your only one that day.",
  fields: ["session_id", "session_date", "name", "notes", "date", "exercises"],
  // The whole new list, in log_workout's two shapes — a lift with its sets and a cardio
  // entry with its minutes — because replacing the list is the correction nothing else
  // could make.
  example: {
    session_id: EXAMPLE_ID,
    exercises: [
      { name: "Goblet squat", sets: [{ reps: 10, weight: 35 }] },
      { name: "Walking", minutes: 25 },
    ],
  },
  lists: { exercises: ENTRY_SHAPE },
  check: (payload, ctx) => problemsOf(planEditSession(payload, ctx)),
  async run(payload, ctx) {
    // Every shape first, so a malformed call costs no read.
    const plan = planEditSession(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { name, notes, date, exercises, custom } = plan.value;
    const sid = await whichSession(payload, ctx);
    if (isRefusal(sid)) return sid;

    const landed = await editSession(ctx, sid.id, (row, session) => {
      if (!row.done) {
        return refuse(
          409,
          "That session is still running. Log into it with health.log_sets, or finish it with health.finish_session — this corrects one that is over.",
        );
      }
      const patch: SessionPatch = {};
      const was: Record<string, Json> = {};
      const now: Record<string, Json> = {};
      if (name !== undefined && name !== row.name) {
        patch.name = name;
        was.name = row.name;
        now.name = name;
      }
      if (notes !== undefined && notes !== row.notes) {
        patch.notes = notes;
        was.notes = row.notes;
        now.notes = notes;
      }
      if (date !== undefined && date !== row.date) {
        patch.date = date;
        was.date = row.date;
        now.date = date;
      }
      let counts: { done: number; warmups: number } | null = null;
      if (exercises !== undefined) {
        // The app's own Finish, as log_workout runs it: empty sets dropped, and a list
        // with nothing logged in it refused rather than saved as an empty workout.
        const finished = finishWorkout({ ...session, exercises });
        if (finished.nothingLogged) {
          return refuse(
            400,
            "None of those exercises has any reps or minutes in it, so the session would be empty. To throw it away, use health.delete_session.",
          );
        }
        patch.exercises = finished.workout.exercises;
        was.exercises = row.exercises as Json;
        now.exercises = finished.workout.exercises as unknown as Json;
        counts = sessionCounts(finished.workout);
      }
      if (Object.keys(patch).length === 0) {
        return refuse(409, "That session already reads that way. Nothing to change.");
      }
      return { ok: true as const, patch, got: { was, now, counts, onDate: row.date } };
    });
    if (isRefusal(landed)) return landed;
    const { was, now, counts, onDate } = landed.got;

    const parts: string[] = [];
    if (now.name !== undefined) parts.push(now.name ? `named it ${scrubCap(now.name, 40)}` : "cleared its name");
    if (now.notes !== undefined) parts.push(now.notes ? "changed its notes" : "cleared its notes");
    if (now.date !== undefined) parts.push(`moved it to ${String(now.date)}`);
    if (counts) {
      const n = (now.exercises as unknown[]).length;
      parts.push(
        `replaced its exercises with ${n} ${n === 1 ? "exercise" : "exercises"}, ${counts.done} working ${counts.done === 1 ? "set" : "sets"}`,
      );
    }
    const changed = Object.keys(now);
    return {
      ok: true,
      result: {
        session_id: sid.id,
        date: now.date ?? onDate,
        was_date: onDate,
        changed,
        ...(counts ? { exercises: (now.exercises as unknown[]).length, hard_sets: counts.done, warmups: counts.warmups } : {}),
      },
      rowIds: [sid.id],
      say:
        `Corrected the session on ${onDate}: ${parts.join("; ")}. It keeps its id.` +
        (custom.length
          ? ` ${custom.map((c) => scrubCap(c, 40)).join(", ")} ${custom.length === 1 ? "is" : "are"} not in the exercise library, so ${custom.length === 1 ? "it counts" : "they count"} toward the muscle you named.`
          : ""),
      undo: {
        kind: SESSION_RESTORE_EDIT,
        // Only the fields that changed, both ways: what to put back, and what has to
        // still be there for putting it back to be safe.
        before: { id: sid.id, was, now },
        says: "put that session back the way it was before this correction",
      },
    };
  },
};

/** Is each field this undo would put back the KIND of value that column holds? A date
 *  that is not a date, or an exercise list that is not a list, would be a write the
 *  session table refuses halfway — or worse, one it accepts. */
function wasReadable(was: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((f) =>
    f === "date" ? isDateISO(was.date) : f === "exercises" ? Array.isArray(was.exercises) : typeof was[f] === "string",
  );
}

const undoSessionRestoreEdit: UndoHandler = {
  does: "Put a corrected session back the way it was, unless it has been changed again since.",
  async apply(before, ctx) {
    // Checked rather than cast: a before-state is read back out of a table, and null or a
    // bare string there is a refusal with a sentence, never a TypeError and a 500.
    const b: { id?: unknown; was?: unknown; now?: unknown } = isObject(before) ? readBefore(before) : {};
    const fields = isObject(b.now) ? Object.keys(b.now) : [];
    if (
      typeof b.id !== "string" ||
      !ROW_ID.test(b.id) ||
      !isObject(b.was) ||
      !isObject(b.now) ||
      fields.length === 0 ||
      !fields.every((f) => (EDITABLE as readonly string[]).includes(f) && f in (b.was as object)) ||
      !wasReadable(b.was as Record<string, unknown>, fields)
    ) {
      return refuse(409, "I wrote that correction down in a shape I cannot read back, so I changed nothing. Correct the session again if the old version was right.");
    }
    const was = b.was as Record<string, unknown>;
    const now = b.now as Record<string, unknown>;
    const id = b.id;
    const landed = await editSession(ctx, id, (row) => {
      const current: Record<string, unknown> = { name: row.name, notes: row.notes, date: row.date, exercises: row.exercises };
      if (fields.some((f) => !sameDoc(current[f], now[f]))) {
        return refuse(
          409,
          "That session has been changed again since I corrected it, so I left it as it is now rather than overwrite that. Correct it again if the old version was the right one.",
        );
      }
      const patch: SessionPatch = {};
      // Shapes already checked by wasReadable above, so these are reads, not guesses.
      if ("name" in now) patch.name = was.name as string;
      if ("notes" in now) patch.notes = was.notes as string;
      if ("date" in now) patch.date = was.date as string;
      if ("exercises" in now) patch.exercises = was.exercises as unknown[];
      return { ok: true as const, patch, got: patch.date ?? row.date };
    });
    if (isRefusal(landed)) return landed;
    return {
      ok: true,
      result: { session_id: id, date: landed.got, put_back: fields },
      rowIds: [id],
      say: `Put the session on ${landed.got} back the way it was before the correction.`,
    };
  },
};

// ── health.save_routine / health.delete_routine ──────────────────────────────

/** What one exercise in a routine takes: the plan for it, not a record of it — how
 *  many sets, and the target reps as he would write them ("8-12"). `exercise` is a
 *  second word for `name` here too, for the same reason as in a logged workout. */
const ROUTINE_KEYS = ["name", "muscle", "sets", "reps"] as const;
const ROUTINE_SHAPE: ListShape = { takes: ROUTINE_KEYS, extra: ENTRY_ALIASES };

/** One routine exercise, every problem with it, or the exercise. */
function readRoutineExercise(raw: unknown, i: number): { ok: true; ex: RoutineExercise } | { ok: false; problem: string } {
  if (!isObject(raw)) {
    return {
      ok: false,
      problem: itemSays(labelOf("Exercise", i), [`It is ${kindOfValue(raw)}, not an object like {"name": "Goblet squat", "sets": 3, "reps": "8-12"}.`], null),
    };
  }
  const { value, unknown, clashes } = renameBy(raw, ROUTINE_SHAPE);
  const problems = [...clashes];
  if (unknown.length) problems.push(unknownKeysSays(unknown, ROUTINE_KEYS));
  const exName = cleanText(value.name, NAME_CAP);
  if (!exName) problems.push(value.name === undefined ? "It has no name — send the exercise's name as name." : "Its name is empty once cleaned.");
  const ex = exName ? resolveExercise(exName, value.muscle, "It") : null;
  if (ex && isRefusal(ex)) problems.push(ex.say);
  const sets = count(value.sets, 1, MAX_SETS);
  if (sets === null) problems.push(`sets is how many sets it has, a whole number from 1 to ${MAX_SETS}.`);
  // The target reps are TEXT ("8-12", "AMRAP"). A bare number is the same thing said
  // plainly, so it is kept as its text — FOUND 2026-10-10: `reps: 10` used to go
  // through the text cleaner, come out empty, and be dropped without a word, which is
  // the silently-ignored-field failure this whole change is about.
  let reps = "";
  if (typeof value.reps === "number" && Number.isInteger(value.reps) && value.reps > 0 && value.reps <= 1000) {
    reps = String(value.reps);
  } else if (value.reps !== undefined) {
    reps = cleanText(value.reps, 16);
    if (!reps) problems.push('reps is the target as text, like "8-12" or "10".');
  }
  const label = labelOf("Exercise", i, exName ? scrubCap(exName, 40) : undefined);
  if (problems.length || !ex || isRefusal(ex) || sets === null) return { ok: false, problem: itemSays(label, problems, raw) };
  return { ok: true, ex: { name: ex.name, muscle: ex.muscle, sets, reps } };
}

/** save_routine's name and source — every problem with them, every exercise read to
 *  the end. The session it may be saved from is read later; this only checks its id. */
function planRoutine(payload: Record<string, unknown>): Shaped<{ name: string; sid: string | null; exercises: RoutineExercise[] }> {
  const problems: string[] = [];
  const name = cleanText(payload.name, NAME_CAP);
  if (!name) problems.push("A routine needs a name.");
  const fromSession = payload.session_id !== undefined;
  const fromList = payload.exercises !== undefined;
  if (fromSession === fromList) {
    problems.push("Give me a session_id to save as a routine, or a list of exercises — one or the other.");
  }
  let sid: string | null = null;
  if (fromSession && !fromList) {
    const id = readId(payload, "session_id");
    if (isRefusal(id)) problems.push(id.say);
    else sid = id.id;
  }
  const exercises: RoutineExercise[] = [];
  if (fromList && !fromSession) {
    const raw = payload.exercises;
    if (!Array.isArray(raw) || raw.length === 0) {
      const what = Array.isArray(raw) ? "" : ` exercises has to be a list — it was ${kindOfValue(raw)}.`;
      problems.push(`A routine needs at least one exercise.${what}`);
    } else if (raw.length > MAX_ENTRIES) {
      problems.push(`That is more than ${MAX_ENTRIES} exercises in one routine.`);
    } else {
      raw.forEach((one, i) => {
        const read = readRoutineExercise(one, i);
        if (read.ok) exercises.push(read.ex);
        else problems.push(read.problem);
      });
    }
  }
  return shaped(problems, () => ({ name, sid, exercises }));
}

const saveRoutine: Tool = {
  kind: "direct",
  does: "Save a routine — from a session that was logged, or from a list of exercises.",
  fields: ["name", "session_id", "exercises", "meta"],
  // "Sample" in the name for the reason on log_meal's example.
  example: {
    name: "Sample routine",
    exercises: [
      { name: "Goblet squat", sets: 3, reps: "8-12" },
      { name: "Lat pulldown", sets: 3, reps: "10" },
    ],
  },
  lists: { exercises: ROUTINE_SHAPE },
  check: (payload) => problemsOf(planRoutine(payload)),
  async run(payload, ctx) {
    const plan = planRoutine(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { name } = plan.value;
    // Both the seeds and his own saved ones, because starting a routine looks the
    // name up across both and a duplicate would make one of them unreachable.
    const clash = await routineByName(ctx, name);
    if (!isRefusal(clash)) {
      return refuse(409, `There is already a routine called ${scrubCap(name, 40)}.`);
    }

    let exercises: RoutineExercise[];
    if (plan.value.sid !== null) {
      const row = await ctx.db.readWorkout(plan.value.sid);
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
      exercises = plan.value.exercises;
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
/** Which saved routine a call means, as far as that can be told without the database:
 *  an id in the right shape, or else a name. savedRoutineFrom does the looking. */
function planRoutineRef(payload: Record<string, unknown>): Shaped<null> {
  const pad = problemPad();
  if (payload.id !== undefined) pad.take(readId(payload, "id"));
  else if (!cleanText(payload.name, NAME_CAP)) pad.no("Tell me which routine, by id or by name.");
  return pad.done(() => null);
}

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
  example: { id: EXAMPLE_ID },
  check: (payload) => problemsOf(planRoutineRef(payload)),
  async run(payload, ctx) {
    const plan = planRoutineRef(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
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
  "health.edit_session": editSessionTool,
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
  [SESSION_RESTORE_EDIT]: undoSessionRestoreEdit,
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
