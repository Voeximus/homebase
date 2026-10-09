// ── Phase 2: health and workout parity, and the undo that makes it safe ───────
//
// WHAT THIS SUITE IS FOR
//
// Phase 2 flipped the rule the write door was built on. Phase 1 exposed what was
// safe; this phase exposes everything the app can do and makes every change
// reversible, because his instruction was "Muse has to have every functionality
// given in the app and the app must become a database for patterns and information
// storage" — and because Homebase never moves money, so the worst a wrong write can
// do is make data wrong.
//
// That trade is only worth taking if the undo actually works. So the four things
// this file exists to prove, in order of how much they would cost to get wrong:
//
//   1  AN UNDO PUTS BACK EXACTLY WHAT WAS THERE. Every write is driven, its undo is
//      applied, and the whole store is compared byte for byte against a snapshot
//      taken before the write.
//   2  AN UNDO IS SURGICAL, NOT A SNAPSHOT RESTORE. A meal day and a session are
//      single json documents that BOTH phones write. So each test that undoes a
//      document change has the phone log something in between, and demands that it
//      survives. A snapshot restore would pass test 1 and silently eat the phone's
//      work, which is the exact bug the undo is supposed to be protection against.
//   3  THE DOOR'S SET SHAPE IS THE APP'S SET SHAPE. A set logged after the fact must
//      carry no `done` key, so it counts by trainingMath's reps > 0 rule. A
//      `done: false` would store a set that can never count: the reply would say
//      logged, every screen would show the numbers, and the volume would read zero.
//      So the door's set is compared against one built by the app's own copyLastSet.
//   4  THE DOCUMENT RACE FAILS CLOSED. When the phone wins three times, nothing is
//      written and the reply says so — it does not blind-write on the fourth try.
//
// WHAT IS FAKED, AND WHAT IS NOT. Only the database seam, and it is shared with
// tests/museWrite.test.ts (tests/helpers/museHealthDb.ts) so the two suites cannot
// disagree about what a stale compare-and-set means. Every tool, every undo handler,
// every one of the app's maths modules and the real handler run for real.
//
// THE UNDO CORE IS NOT HERE. This phase's undo core — where a before-state is
// stored, how a token is looked up, what stops a second undo — is separate work.
// This suite drives the handlers in HEALTH_UNDO directly, which is the half the
// health tools own, and proves the handler carries the token out.

import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../supabase/functions/_shared/muse/az.ts";
import { handleWrite, type Deps, type Secrets } from "../supabase/functions/muse-write/handler.ts";
import { TOOLS } from "../supabase/functions/muse-write/tools.ts";
import {
  HEALTH_TOOLS,
  HEALTH_UNDO,
  __testables,
} from "../supabase/functions/muse-write/healthTools.ts";
import { mergeUndo } from "../supabase/functions/muse-write/undoContract.ts";
// The registry the DOOR dispatches through, and the step validator that reads a `kind`
// back out of the database. Both are the merge's half of the undo story.
import { UNDO_REGISTRY } from "../supabase/functions/muse-write/undoRegistry.ts";
import { checkStep } from "../supabase/functions/_shared/muse/undo.ts";
import type { Ctx, ToolOutcome } from "../supabase/functions/muse-write/kit.ts";
import type {
  CallRecord,
  Db,
  Outcome,
  Person,
} from "../supabase/functions/muse-write/db.ts";
import { HealthRows } from "./helpers/museHealthDb.ts";
import { copyLastSet, editLoggedSet, sessionCounts } from "../src/lib/sessionOps";
import { contribution, itemFromServing, itemFromTotals, mealTotals } from "../src/lib/mealLog";
import { isLogged, isWarmup, findExercise } from "../src/lib/trainingMath";
import { BUNDLED_EXERCISES } from "../src/lib/exerciseData";
import type { ExerciseEntry, SetEntry } from "../src/lib/workoutLog";
import type { LoggedItem, Meal } from "../src/lib/mealLog";

// 7 PM Arizona on 26 Sep 2026, spelled as the instant a UTC runtime would see — the
// window where a fired clock default answers about tomorrow. He works nights, so
// that window is most of his waking day.
const AT = new Date("2026-09-27T02:00:00Z");
const TODAY = "2026-09-26";
const YESTERDAY = "2026-09-25";

const GINO_SECRET = "gino-write-secret-0123456789";
const XINYAN_SECRET = "xinyan-write-secret-0123456789";
const SECRETS: Secrets = { gino: GINO_SECRET, xinyan: XINYAN_SECRET };

// ── the fake ─────────────────────────────────────────────────────────────────

interface AuditRow {
  person: Person;
  tool: string;
  idemKey: string | null;
  args: Record<string, unknown>;
  outcome: Outcome;
  result?: unknown;
  rowIds?: string[];
  note?: string;
}

/** The health half comes from HealthRows; this adds the audit log, the counters and
 *  the two seams the health tools never touch, so `implements Db` is honest. */
class HFake extends HealthRows implements Db {
  /**
   * The household duplicate guard — "Xinyan already did that four minutes ago".
   *
   * It landed on `main` while this branch was being written, so without it every write
   * here 500s: handleWrite calls it, the fake has no such method, and its own catch
   * reports "something went wrong on my side". Always null, because this file's subject
   * is the before-state and the undo; the guard itself is driven against a real audit
   * log, through both people's keys, in tests/museWrite.test.ts.
   */
  recentSameWrite() {
    return Promise.resolve(null);
  }

  audit: AuditRow[] = [];
  calls = new Map<string, number>();
  reminders: { id: string; person: Person; message: string }[] = [];
  pending: { tool: string }[] = [];
  pushes: { title: string; owner: string }[] = [];
  /** The ledger no health tool may touch. Snapshotted in the tests below. */
  ledger = { transactions: [{ id: "t1" }], recurring: [{ id: "r1", name: "Electric" }] };

  findCall(person: Person, tool: string, idemKey: string): Promise<CallRecord | null> {
    const row = this.audit.find((r) => r.person === person && r.tool === tool && r.idemKey === idemKey);
    return Promise.resolve(
      row ? { outcome: row.outcome, args: row.args, result: row.result, note: row.note ?? null } : null,
    );
  }
  claimCall(c: { person: Person; tool: string; idemKey: string; args: Record<string, unknown> }) {
    const clash = this.audit.some((r) => r.person === c.person && r.tool === c.tool && r.idemKey === c.idemKey);
    if (clash) return Promise.resolve<"claimed" | "duplicate">("duplicate");
    this.audit.push({ ...c, outcome: "pending" });
    return Promise.resolve<"claimed" | "duplicate">("claimed");
  }
  releaseCall(person: Person, tool: string, idemKey: string): Promise<void> {
    this.audit = this.audit.filter(
      (r) => !(r.person === person && r.tool === tool && r.idemKey === idemKey && r.outcome === "pending"),
    );
    return Promise.resolve();
  }
  finishCall(c: {
    person: Person; tool: string; idemKey: string; outcome: Outcome;
    result?: unknown; rowIds?: string[]; ms: number; note?: string;
  }): Promise<void> {
    const row = this.audit.find((r) => r.person === c.person && r.tool === c.tool && r.idemKey === c.idemKey);
    if (row) Object.assign(row, { outcome: c.outcome, result: c.result, rowIds: c.rowIds, note: c.note });
    return Promise.resolve();
  }
  logCall(c: { person: Person; tool: string; args: Record<string, unknown>; outcome: Outcome; note: string }) {
    this.audit.push({ ...c, idemKey: null });
    return Promise.resolve();
  }
  bump(person: Person, bucket: string): Promise<number> {
    const k = `${person}|${bucket}`;
    const n = (this.calls.get(k) ?? 0) + 1;
    this.calls.set(k, n);
    return Promise.resolve(n);
  }
  countOpenReminders(): Promise<number> {
    return Promise.resolve(this.reminders.length);
  }
  insertReminder(r: { person: Person; message: string }): Promise<string> {
    const id = `rem-${this.reminders.length + 1}`;
    this.reminders.push({ id, person: r.person, message: r.message });
    return Promise.resolve(id);
  }
  transactionExists(id: string): Promise<boolean> {
    return Promise.resolve(this.ledger.transactions.some((t) => t.id === id));
  }
  recurringName(id: string): Promise<string | null> {
    return Promise.resolve(this.ledger.recurring.find((r) => r.id === id)?.name ?? null);
  }
  insertPending(r: { tool: string }) {
    this.pending.push({ tool: r.tool });
    return Promise.resolve({ id: "pen-1", expiresAt: "2026-09-27T19:00:00.000Z" });
  }
}

let db: HFake;

beforeEach(() => {
  db = new HFake();
});

function ctxFor(person: Person = "gino", at: Date = AT): Ctx {
  const clock = clockNow(at);
  return {
    db,
    push: () => Promise.resolve(),
    person,
    at: clock.at,
    az: clock.az,
    appUrl: "https://example.test/homebase/",
  };
}

/** Run one health tool for real, with no handler around it — so a test can make
 *  twenty calls without meeting the hourly cap, which is the handler's business and
 *  is already proved in tests/museWrite.test.ts. */
function run(tool: string, args: Record<string, unknown>, person: Person = "gino", at: Date = AT): Promise<ToolOutcome> {
  const def = HEALTH_TOOLS[tool];
  if (!def) throw new Error(`no such health tool: ${tool}`);
  return def.run(args, ctxFor(person, at));
}

/** Apply a write's undo record through the registry, exactly as the undo core will.
 *  Fails loudly on a kind nothing knows how to apply. */
function undo(out: ToolOutcome, person: Person = "gino"): Promise<ToolOutcome> {
  if (!out.ok) throw new Error(`cannot undo a refusal: ${out.say}`);
  if (!out.undo) throw new Error("that write returned no undo record");
  const handler = HEALTH_UNDO[out.undo.kind];
  if (!handler) throw new Error(`no undo handler for ${out.undo.kind}`);
  return handler.apply(out.undo.before, ctxFor(person));
}

/** Everything the store holds, as one comparable value. An undo has to bring this
 *  back to what it was, and "the version stamp moved" is allowed — a restore is a
 *  write, so it bumps the version. Nothing else may differ. */
function snapshot(): string {
  return JSON.stringify(
    {
      weights: [...db.weights.entries()].sort(),
      savedMeals: db.savedMeals,
      foods: db.foods,
      macroTargets: [...db.macroTargets.entries()].sort(),
      // A day row with no meals, no mark and no note is normalised away, because in
      // this app it IS the same day as no row at all: load.day falls back to an empty
      // day when the row is missing, and dayStatusOf reads both as "none". The door
      // writing the first meal onto a day creates the row, and its undo takes the
      // meal back off rather than DELETING the row — deleting a document both phones
      // write, to satisfy a byte comparison, is the more dangerous of the two.
      mealDays: [...db.mealDays.entries()]
        .filter(([, d]) => d.meals.length > 0 || d.status !== null || d.note !== null)
        .sort()
        .map(([k, d]) => [k, { meals: d.meals, status: d.status, note: d.note }]),
      workouts: db.workouts.map((w) => ({ ...w, updatedAt: "(a version)" })),
      routines: db.routines,
    },
    null,
    0,
  );
}

const said = (out: ToolOutcome) => (out.ok ? out.say : out.say);

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A real logged portion: the shape src/lib/mealLog.ts stores, per-100g scaled by
 *  grams. Anything else is a shape the app cannot read. */
const portion = (over: Partial<LoggedItem> = {}): LoggedItem => ({
  id: "it-seed",
  foodId: "chicken-breast",
  name: "Chicken breast",
  role: "protein",
  grams: 200,
  per100: { kcal: 165, p: 31, c: 0, f: 3.6 },
  ...over,
});

function stockDay(date = TODAY, meals: Meal[] = [{ id: "meal-seed", name: "Breakfast", items: [portion()] }]) {
  db.mealDays.set(`gino|${date}`, {
    id: `md-${date}`,
    meals: JSON.parse(JSON.stringify(meals)),
    status: null,
    note: null,
    updatedAt: "v0",
  });
}

const aSet = (over: Partial<SetEntry> = {}): SetEntry => ({ id: "s-1", reps: 8, weight: 300, ...over });

function stockSession(over: Partial<{ id: string; done: boolean; date: string; exercises: ExerciseEntry[] }> = {}) {
  const row = {
    id: over.id ?? "wk-1",
    person: "gino" as Person,
    date: over.date ?? TODAY,
    name: "Lower A",
    notes: "",
    exercises: over.exercises ?? [
      { id: "ex-1", exerciseId: "", name: "Leg press", muscle: "legs", sets: [aSet()] },
    ],
    done: over.done ?? false,
    updatedAt: "v0",
  };
  db.workouts.push(JSON.parse(JSON.stringify(row)));
  return row;
}

// ═════════════════════════════════════════════════════════════════════════════

describe("the catalogue", () => {
  it("is registered on the door, so every health tool is reachable", () => {
    for (const name of Object.keys(HEALTH_TOOLS)) {
      expect(TOOLS[name], `${name} is not on the write door`).toBeTruthy();
    }
  });

  it("names every tool health.* or schedule.*, so a finance write cannot hide in here", () => {
    for (const name of Object.keys(HEALTH_TOOLS)) {
      expect(name).toMatch(/^health\./);
    }
  });

  it("declares its fields, and the handler refuses anything else", async () => {
    for (const [name, tool] of Object.entries(HEALTH_TOOLS)) {
      expect(tool.fields.length, `${name} declares no fields`).toBeGreaterThan(0);
      // `person` is never a field. A secret that could aim a write at the other
      // person would make losing one phone cost both people's data.
      expect(tool.fields, `${name} takes a person`).not.toContain("person");
      expect(tool.kind, `${name} is queued`).toBe("direct");
    }
  });

  it("has an undo handler for every kind any tool can return, and no orphan handlers", async () => {
    // Driven rather than read off a list: each tool is run for real and the `kind`
    // it actually returns is looked up. A kind that no handler claims would be a
    // write that says it can be undone and cannot.
    const kinds = new Set<string>();
    for (const [name, call] of Object.entries(EVERY_HEALTH_WRITE)) {
      db = new HFake();
      call.setup?.();
      const out = await run(name, call.args, call.person ?? "gino");
      expect(out.ok, `${name}: ${said(out)}`).toBe(true);
      if (out.ok && out.undo) kinds.add(out.undo.kind);
    }
    // Checked against UNDO_REGISTRY, not HEALTH_UNDO. They hold the same handlers today,
    // and the difference is the point: UNDO_REGISTRY is what `system.undo` actually
    // dispatches through, so this asserts the kind is reachable THROUGH THE DOOR rather
    // than merely present in this file's own object. That distinction was not academic —
    // before the merge, every one of these kinds was in HEALTH_UNDO and none of them was
    // reachable, because nothing had registered it.
    for (const kind of kinds) {
      expect(UNDO_REGISTRY[kind], `no undo handler for ${kind}`).toBeTruthy();
    }
    // And the other way: a handler nothing reaches is dead code that looks like a
    // safety net. Two are shared inverses reached only from another tool's undo, so
    // the check is that every handler is reachable from the kinds above or is named
    // here with a reason.
    const reachedIndirectly = new Set(["day.put-meal-back"]);
    for (const kind of Object.keys(HEALTH_UNDO)) {
      expect(kinds.has(kind) || reachedIndirectly.has(kind), `${kind} is never returned by any tool`).toBe(true);
    }
  });

  it("merges into one registry without two handlers claiming a kind", () => {
    expect(() => mergeUndo(HEALTH_UNDO)).not.toThrow();
    expect(() => mergeUndo(HEALTH_UNDO, HEALTH_UNDO)).toThrow(/claim/);
    // And the registry the door reads really is built from this file's handlers — the
    // assertion that would have failed before the merge, when mergeUndo was never called.
    expect(Object.keys(UNDO_REGISTRY).sort()).toEqual(Object.keys(HEALTH_UNDO).sort());
  });

  it("every kind a tool can return is a name the step validator accepts", () => {
    // A `kind` is written into a database column and read back by checkStep, which
    // refuses a name it cannot parse. A handler named `weight_set` or `Weight.Set` would
    // pass every test in this file and then be unreadable the moment it was stored.
    for (const kind of Object.keys(UNDO_REGISTRY)) {
      expect(() => checkStep({ kind: "run_handler", handler: kind, before: null }), kind).not.toThrow();
    }
  });
});

// ── one call per tool, and its undo ──────────────────────────────────────────
//
// The list is the spine of this file: every loop below drives all of it, so a tool
// added to healthTools.ts and not to this list fails the first test here.

interface Call {
  args: Record<string, unknown>;
  person?: Person;
  setup?: () => void;
  /** True when the undo is a document restore rather than a surgical edit, so the
   *  suite knows to expect the `fragile` sentence. */
  fragile?: boolean;
}

const EVERY_HEALTH_WRITE: Record<string, Call> = {
  "health.log_weight": { args: { weight: 198.4 } },
  "health.delete_weight": {
    args: { date: TODAY },
    setup: () => db.weights.set(`gino|${TODAY}`, 199.2),
  },
  "health.log_meal": { args: { items: [{ name: "Chicken breast", kcal: 330, p: 62, c: 0, f: 7, grams: 200 }] } },
  "health.log_saved_meal": {
    args: { name: "Usual breakfast" },
    setup: () => db.savedMeals.push({ id: "sm-1", name: "Usual breakfast", items: [portion()] }),
  },
  "health.delete_meal": { args: { date: TODAY, meal_id: "meal-seed" }, setup: () => stockDay() },
  "health.edit_meal": { args: { date: TODAY, meal_id: "meal-seed", name: "Lunch" }, setup: () => stockDay() },
  "health.mark_day": { args: { date: YESTERDAY, mark: "estimated", note: "rice and chicken" } },
  "health.save_meal": {
    args: { name: "Post-gym", date: TODAY, meal_id: "meal-seed" },
    setup: () => stockDay(),
  },
  "health.update_saved_meal": {
    args: { id: "sm-1", name: "Renamed" },
    setup: () => db.savedMeals.push({ id: "sm-1", name: "Usual breakfast", items: [portion()] }),
  },
  "health.delete_saved_meal": {
    args: { id: "sm-1" },
    setup: () => db.savedMeals.push({ id: "sm-1", name: "Usual breakfast", items: [portion()] }),
  },
  "health.add_food": { args: { name: "Protein bar", role: "protein", kcal: 380, p: 30, c: 40, f: 10 } },
  "health.delete_food": {
    args: { id: "food-1" },
    setup: () =>
      db.foods.push({
        id: "food-1", name: "Protein bar", role: "protein",
        kcal: 380, p: 30, c: 40, f: 10, serving: 60, note: null, barcode: null,
      }),
  },
  "health.set_macro_target": { args: { kcal: 2800, p: 130, c: 410, f: 70 } },
  "health.start_session": { args: { name: "Lower A" } },
  "health.log_sets": {
    args: { session_id: "wk-1", exercise: "Leg press", sets: [{ reps: 8, weight: 300 }] },
    setup: () => void stockSession(),
  },
  "health.edit_set": {
    args: { session_id: "wk-1", set_id: "s-1", reps: 10 },
    setup: () => void stockSession(),
  },
  "health.delete_set": {
    args: { session_id: "wk-1", set_id: "s-1" },
    setup: () => void stockSession(),
  },
  "health.finish_session": {
    args: { session_id: "wk-1", notes: "felt strong" },
    setup: () => void stockSession(),
    fragile: true,
  },
  "health.log_workout": {
    args: {
      date: YESTERDAY,
      name: "Upper A",
      exercises: [{ name: "Incline dumbbell press", sets: [{ reps: 8, weight: 70 }, { reps: 7, weight: 70 }] }],
    },
  },
  "health.delete_session": {
    args: { session_id: "wk-1" },
    setup: () => void stockSession({ done: true }),
  },
  "health.save_routine": {
    args: { name: "My push day", exercises: [{ name: "Leg press", sets: 3 }] },
  },
  "health.delete_routine": {
    args: { id: "rt-1" },
    setup: () =>
      db.routines.push({
        id: "rt-1", person: "gino", name: "My push day", meta: "",
        exercises: [{ name: "Leg press", muscle: "legs", sets: 3, reps: "" }],
      }),
  },
};

describe("every health write, and its undo", () => {
  it("names all of them, so this list cannot fall behind healthTools.ts", () => {
    expect(Object.keys(EVERY_HEALTH_WRITE).sort()).toEqual(Object.keys(HEALTH_TOOLS).sort());
  });

  for (const [name, call] of Object.entries(EVERY_HEALTH_WRITE)) {
    it(`${name} returns an undo record with a sentence`, async () => {
      call.setup?.();
      const out = await run(name, call.args, call.person ?? "gino");
      expect(out.ok, said(out)).toBe(true);
      if (!out.ok) return;
      expect(out.undo, `${name} returned no undo record`).toBeTruthy();
      expect(out.undo!.kind).toMatch(/^[a-z-]+\.[a-z-]+$/);
      // The sentence is read back to him before the undo runs, so it has to say what
      // it would do rather than name a row id.
      expect(out.undo!.says.length, `${name}'s undo says nothing`).toBeGreaterThan(8);
      expect(out.say.length).toBeGreaterThan(8);
      // A fragile undo names what could overwrite it. A surgical one must NOT claim
      // fragility it does not have — that sentence is only worth anything when it is
      // true.
      if (call.fragile) expect(out.undo!.fragile, `${name} should say what can overwrite it`).toBeTruthy();
      else expect(out.undo!.fragile, `${name} claims a fragility it does not have`).toBeUndefined();
    });

    it(`${name} can be undone back to exactly what was there`, async () => {
      call.setup?.();
      const before = snapshot();
      const out = await run(name, call.args, call.person ?? "gino");
      expect(out.ok, said(out)).toBe(true);
      if (!out.ok) return;
      expect(snapshot(), `${name} changed nothing`).not.toBe(before);
      const back = await undo(out, call.person ?? "gino");
      expect(back.ok, said(back)).toBe(true);
      expect(snapshot(), `${name}'s undo did not restore the store`).toBe(before);
    });

    it(`${name} touches no ledger row`, async () => {
      call.setup?.();
      const ledger = JSON.stringify(db.ledger);
      const out = await run(name, call.args, call.person ?? "gino");
      expect(out.ok, said(out)).toBe(true);
      // The health tools have no verb that could reach a transaction, a bill or a
      // debt — this is the assertion that says so out loud rather than trusting it.
      expect(JSON.stringify(db.ledger)).toBe(ledger);
      expect(db.pending).toHaveLength(0);
    });

    it(`${name} answers the same in UTC and in Arizona`, async () => {
      // Rule 2. At this instant a UTC runtime is already on the 27th, so a fired
      // clock default would file the write under the wrong day — and he works
      // nights, so that window is most of his waking day.
      const answers: string[] = [];
      for (const tz of ["UTC", "America/Phoenix"]) {
        process.env.TZ = tz;
        db = new HFake();
        call.setup?.();
        const out = await run(name, call.args, call.person ?? "gino");
        expect(out.ok, said(out)).toBe(true);
        // Ids are random per call, so the comparison is over the dates and the
        // sentence — which is where a wrong clock shows up.
        answers.push(out.ok ? out.say.replace(/[0-9a-f-]{36}/g, "(an id)") : "refused");
      }
      process.env.TZ = "America/Phoenix";
      expect(answers[0]).toBe(answers[1]);
    });
  }
});

// ── the undo must be surgical ────────────────────────────────────────────────

describe("an undo of a document change leaves the other phone's work alone", () => {
  it("taking back a logged meal keeps a meal the phone added in between", async () => {
    stockDay();
    const out = await run("health.log_meal", {
      items: [{ name: "Rice", kcal: 260, p: 5, c: 56, f: 1, grams: 200 }],
    });
    expect(out.ok, said(out)).toBe(true);

    // The phone logs its own meal AFTER the door's write. A snapshot restore would
    // take this with it; a surgical undo removes only the meal the door added.
    const doc = db.mealDays.get(`gino|${TODAY}`)!;
    doc.meals = [...doc.meals, { id: "phone-meal", name: "Snack", items: [portion({ id: "it-phone" })] }];
    doc.updatedAt = "v-phone";

    const back = await undo(out);
    expect(back.ok, said(back)).toBe(true);
    const meals = db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[];
    expect(meals.map((m) => m.id)).toEqual(["meal-seed", "phone-meal"]);
  });

  it("putting a deleted meal back keeps a meal the phone added in between", async () => {
    stockDay(TODAY, [
      { id: "m-a", name: "A", items: [portion({ id: "it-a" })] },
      { id: "m-b", name: "B", items: [portion({ id: "it-b" })] },
    ]);
    const out = await run("health.delete_meal", { date: TODAY, meal_id: "m-a" });
    expect(out.ok, said(out)).toBe(true);

    const doc = db.mealDays.get(`gino|${TODAY}`)!;
    doc.meals = [...doc.meals, { id: "phone-meal", name: "Snack", items: [] }];
    doc.updatedAt = "v-phone";

    const back = await undo(out);
    expect(back.ok, said(back)).toBe(true);
    const meals = db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[];
    // Back in its own position, and the phone's meal still there.
    expect(meals.map((m) => m.id)).toEqual(["m-a", "m-b", "phone-meal"]);
  });

  it("editing one meal and undoing it leaves the other meals as they are now", async () => {
    stockDay(TODAY, [
      { id: "m-a", name: "A", items: [portion({ id: "it-a" })] },
      { id: "m-b", name: "B", items: [portion({ id: "it-b" })] },
    ]);
    const out = await run("health.edit_meal", { date: TODAY, meal_id: "m-a", name: "Renamed" });
    expect(out.ok, said(out)).toBe(true);

    // The phone renames the OTHER meal in between.
    const doc = db.mealDays.get(`gino|${TODAY}`)!;
    doc.meals = (doc.meals as Meal[]).map((m) => (m.id === "m-b" ? { ...m, name: "Phone's name" } : m));
    doc.updatedAt = "v-phone";

    const back = await undo(out);
    expect(back.ok, said(back)).toBe(true);
    const meals = db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[];
    expect(meals.find((m) => m.id === "m-a")!.name).toBe("A");
    expect(meals.find((m) => m.id === "m-b")!.name).toBe("Phone's name");
  });

  it("taking back logged sets keeps a set the phone added in between", async () => {
    stockSession();
    const out = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Leg press",
      sets: [{ reps: 8, weight: 320 }, { reps: 6, weight: 340 }],
    });
    expect(out.ok, said(out)).toBe(true);

    const row = db.workouts.find((w) => w.id === "wk-1")!;
    const entry = (row.exercises as ExerciseEntry[])[0];
    entry.sets = [...entry.sets, { id: "s-phone", reps: 5, weight: 360 }];
    row.updatedAt = "v-phone";

    const back = await undo(out);
    expect(back.ok, said(back)).toBe(true);
    const sets = (db.workouts.find((w) => w.id === "wk-1")!.exercises as ExerciseEntry[])[0].sets;
    expect(sets.map((s) => s.id)).toEqual(["s-1", "s-phone"]);
  });

  it("undoing an edited set leaves the other sets as they are now", async () => {
    stockSession({
      exercises: [
        {
          id: "ex-1", exerciseId: "", name: "Leg press", muscle: "legs",
          sets: [aSet({ id: "s-1" }), aSet({ id: "s-2", reps: 6, weight: 320 })],
        },
      ],
    });
    const out = await run("health.edit_set", { session_id: "wk-1", set_id: "s-1", reps: 12 });
    expect(out.ok, said(out)).toBe(true);

    const row = db.workouts.find((w) => w.id === "wk-1")!;
    const entry = (row.exercises as ExerciseEntry[])[0];
    entry.sets = entry.sets.map((s) => (s.id === "s-2" ? { ...s, reps: 9 } : s));
    row.updatedAt = "v-phone";

    const back = await undo(out);
    expect(back.ok, said(back)).toBe(true);
    const sets = (db.workouts.find((w) => w.id === "wk-1")!.exercises as ExerciseEntry[])[0].sets;
    expect(sets.find((s) => s.id === "s-1")!.reps).toBe(8);
    expect(sets.find((s) => s.id === "s-2")!.reps).toBe(9);
  });

  it("undoing a started session refuses once sets have been logged into it", async () => {
    const out = await run("health.start_session", { name: "Lower A" });
    expect(out.ok, said(out)).toBe(true);
    if (!out.ok) return;
    const id = String(out.result.id);

    const logged = await run("health.log_sets", {
      session_id: id,
      exercise: "Leg press",
      sets: [{ reps: 8, weight: 300 }],
    });
    expect(logged.ok, said(logged)).toBe(true);

    // Those sets are not in the start's before-state, so throwing the row away now
    // would take them with it. The undo refuses and says why — an undo that lost
    // work would be the opposite of what it is for.
    const back = await undo(out);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.say).toMatch(/logged into it/i);
    expect(db.workouts).toHaveLength(1);
  });

  it("undoing a finish refuses once sets have been logged into the finished session", async () => {
    stockSession();
    const out = await run("health.finish_session", { session_id: "wk-1" });
    expect(out.ok, said(out)).toBe(true);

    const logged = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Leg press",
      sets: [{ reps: 10, weight: 280 }],
    });
    expect(logged.ok, said(logged)).toBe(true);

    // The `fragile` sentence on that undo promised this check, and here it is.
    const back = await undo(out);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.say).toMatch(/since it was finished/i);
    expect(db.workouts[0].done).toBe(true);
  });

  it("a second undo of the same change is refused rather than done twice", async () => {
    // The undo CORE owns "already undone"; these are the handlers' own guards, which
    // are what stops a double-undo becoming a new wrong write even when the core's
    // flag is missed.
    stockDay();
    const deleted = await run("health.delete_meal", { date: TODAY, meal_id: "meal-seed" });
    expect(deleted.ok).toBe(true);
    expect((await undo(deleted)).ok).toBe(true);
    const twice = await undo(deleted);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.say).toMatch(/already back/i);
    expect((db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[])).toHaveLength(1);
  });
});

// ── the document race ────────────────────────────────────────────────────────

describe("the day and session documents are one row each, and the phone is writing too", () => {
  it("a meal that lands after the door's read is not erased: the door retries onto the new version", async () => {
    stockDay();
    let once = false;
    db.onReadMealDay = () => {
      if (once) return;
      once = true;
      const doc = db.mealDays.get(`gino|${TODAY}`)!;
      doc.meals = [...doc.meals, { id: "phone-meal", name: "Snack", items: [] }];
      doc.updatedAt = "v-phone";
    };
    const out = await run("health.log_meal", { items: [{ name: "Rice", kcal: 260, p: 5, c: 56, f: 1, grams: 200 }] });
    expect(out.ok, said(out)).toBe(true);
    const meals = db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[];
    expect(meals.map((m) => m.id).slice(0, 2)).toEqual(["meal-seed", "phone-meal"]);
    expect(meals).toHaveLength(3);
  });

  it("when the phone wins every time, nothing is written and the reply says so", async () => {
    stockDay();
    let n = 0;
    db.onReadMealDay = () => {
      n += 1;
      const doc = db.mealDays.get(`gino|${TODAY}`)!;
      doc.updatedAt = `v-phone-${n}`;
    };
    const before = snapshot();
    const out = await run("health.log_meal", { items: [{ name: "Rice", kcal: 260, p: 5, c: 56, f: 1, grams: 200 }] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.say).toMatch(/same day at the same moment/i);
    }
    // Fails CLOSED. A fourth blind attempt is how the phone's meals get erased.
    expect(snapshot()).toBe(before);
  });

  it("a session the phone is editing is retried onto the new version, not over it", async () => {
    stockSession();
    let once = false;
    db.onReadWorkout = () => {
      if (once) return;
      once = true;
      const row = db.workouts.find((w) => w.id === "wk-1")!;
      const entry = (row.exercises as ExerciseEntry[])[0];
      entry.sets = [...entry.sets, { id: "s-phone", reps: 5, weight: 360 }];
      row.updatedAt = "v-phone";
    };
    const out = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Leg press",
      sets: [{ reps: 8, weight: 320 }],
    });
    expect(out.ok, said(out)).toBe(true);
    const sets = (db.workouts[0].exercises as ExerciseEntry[])[0].sets;
    expect(sets.map((s) => s.id).slice(0, 2)).toEqual(["s-1", "s-phone"]);
    expect(sets).toHaveLength(3);
  });

  it("a retried write does not log the same sets twice", async () => {
    // The set ids are generated ONCE, before the retry loop. If they were generated
    // per attempt, a retry would append a second copy of everything.
    stockSession();
    let n = 0;
    db.onReadWorkout = () => {
      n += 1;
      if (n > 1) return;
      db.workouts.find((w) => w.id === "wk-1")!.updatedAt = "v-phone";
    };
    const out = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Leg press",
      sets: [{ reps: 8, weight: 320 }],
    });
    expect(out.ok, said(out)).toBe(true);
    const sets = (db.workouts[0].exercises as ExerciseEntry[])[0].sets;
    expect(sets).toHaveLength(2);
  });
});

// ── the set shape is the app's set shape ─────────────────────────────────────

describe("a set logged after the fact counts, the way the app's own editor counts it", () => {
  it("carries no `done` key, so trainingMath's reps > 0 rule counts it", async () => {
    stockSession();
    const out = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Leg press",
      sets: [{ reps: 8, weight: 300 }],
    });
    expect(out.ok, said(out)).toBe(true);
    const sets = (db.workouts[0].exercises as ExerciseEntry[])[0].sets;
    const added = sets[sets.length - 1];
    // The bug this test exists for: `done: false` would store a set that can NEVER
    // count. The reply would say logged, the screen would show 8 × 300, and
    // health.training_volume would report nothing.
    expect("done" in added).toBe(false);
    expect(isLogged(added)).toBe(true);
    expect(isWarmup(added)).toBe(false);
  });

  it("is byte-identical to one the app's own copyLastSet would add", () => {
    const entry: ExerciseEntry = {
      id: "ex-1", exerciseId: "", name: "Leg press", muscle: "legs",
      sets: [{ id: "prev", reps: 8, weight: 300 }],
    };
    // The app's rule, run for real: the editor's Add-set copies the numbers and
    // nothing else of the row above.
    const appSide = copyLastSet(entry, () => "fixed-id").sets[1];
    const doorSide = __testables.loggedSet({ reps: 8, weight: 300 });
    expect(Object.keys(doorSide).sort()).toEqual(Object.keys(appSide).sort());
    expect({ ...doorSide, id: "fixed-id" }).toEqual(appSide);
  });

  it("a warm-up is marked, and a working set carries no kind at all", () => {
    expect(__testables.loggedSet({ reps: 8, weight: 300 }).kind).toBeUndefined();
    expect(__testables.loggedSet({ reps: 12, weight: 95, warmup: true }).kind).toBe("warmup");
  });

  it("editing a set goes through the app's own editLoggedSet, so the tick is cleared", async () => {
    // A set Finish kept unticked must start counting once numbers are typed into it.
    stockSession({
      exercises: [
        { id: "ex-1", exerciseId: "", name: "Leg press", muscle: "legs", sets: [{ id: "s-1", reps: 8, weight: 300, done: false }] },
      ],
    });
    const out = await run("health.edit_set", { session_id: "wk-1", set_id: "s-1", reps: 10 });
    expect(out.ok, said(out)).toBe(true);
    const stored = (db.workouts[0].exercises as ExerciseEntry[])[0].sets[0];
    const appSide = editLoggedSet(
      { id: "ex-1", exerciseId: "", name: "Leg press", muscle: "legs", sets: [{ id: "s-1", reps: 8, weight: 300, done: false }] },
      0,
      { reps: 10 },
    ).sets[0];
    // JSON drops an `undefined`, so the stored row is compared against the app's
    // after the same trip through JSON that a jsonb column makes.
    expect(stored).toEqual(JSON.parse(JSON.stringify(appSide)));
    expect(isLogged(stored)).toBe(true);
  });

  it("a session logged in one call is stored the way the app's Finish stores one", async () => {
    const out = await run("health.log_workout", {
      date: YESTERDAY,
      name: "Upper A",
      exercises: [
        { name: "Incline dumbbell press", sets: [{ reps: 8, weight: 70 }, { reps: 0, weight: 0 }] },
      ],
    });
    expect(out.ok, said(out)).toBe(true);
    const row = db.workouts[0];
    expect(row.done).toBe(true);
    // finishWorkout drops sets with no numbers, which is what the Finish sheet
    // previews — so the empty row does not arrive as a set he did.
    const sets = (row.exercises as ExerciseEntry[])[0].sets;
    expect(sets).toHaveLength(1);
    expect(sessionCounts({ ...row, exercises: row.exercises as ExerciseEntry[] }).done).toBe(1);
  });

  it("a lift the library knows is stored under the library's own name and id", async () => {
    stockSession();
    const out = await run("health.log_sets", {
      session_id: "wk-1",
      // said the way he says it, not the way the library spells it
      exercise: "tricep pushdowns",
      sets: [{ reps: 12, weight: 50 }],
    });
    expect(out.ok, said(out)).toBe(true);
    const entry = (db.workouts[0].exercises as ExerciseEntry[]).find((e) => e.name !== "Leg press")!;
    const lib = findExercise(BUNDLED_EXERCISES, "tricep pushdowns");
    expect(lib, "the library should know this lift").toBeTruthy();
    expect(entry.exerciseId).toBe(lib!.id);
    expect(entry.name).toBe(lib!.name);
    expect(entry.muscle).toBe(lib!.muscle);
  });

  it("a lift the library does not know needs a muscle, and then counts toward it", async () => {
    stockSession();
    const without = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Zercher good morning thing",
      sets: [{ reps: 8, weight: 95 }],
    });
    expect(without.ok).toBe(false);
    if (!without.ok) {
      expect(without.status).toBe(400);
      // Told what to do about it, not just told no.
      expect(without.say).toMatch(/which muscle/i);
    }

    const withMuscle = await run("health.log_sets", {
      session_id: "wk-1",
      exercise: "Zercher good morning thing",
      muscle: "legs",
      sets: [{ reps: 8, weight: 95 }],
    });
    expect(withMuscle.ok, said(withMuscle)).toBe(true);
    const entry = (db.workouts[0].exercises as ExerciseEntry[]).find((e) => e.name !== "Leg press")!;
    expect(entry.exerciseId).toBe("");
    expect(entry.muscle).toBe("legs");
    // And the reply says it is a custom lift, because that changes what the volume
    // figures mean.
    if (withMuscle.ok) expect(withMuscle.say).toMatch(/not in the library/i);
  });

  it("a session laid out from a routine gets the app's own empty sets, which count as nothing", async () => {
    const out = await run("health.start_session", { routine: "Lower A" });
    expect(out.ok, said(out)).toBe(true);
    const row = db.workouts[0];
    const entries = row.exercises as ExerciseEntry[];
    // Four exercises with their planned number of empty rows, the same thing
    // "Start from routine" does on the screen.
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.sets.length).toBeGreaterThan(0);
      for (const s of e.sets) {
        expect(s.reps).toBe(0);
        expect(s.weight).toBe(0);
        expect(isLogged(s)).toBe(false);
      }
    }
    // Nothing is logged, so finishing it would save an empty workout — and does not.
    const finish = await run("health.finish_session", { session_id: row.id });
    expect(finish.ok).toBe(false);
  });

  it("minutes on the same lift add up, and the undo takes back exactly what was added", async () => {
    stockSession({ exercises: [] });
    const first = await run("health.log_sets", { session_id: "wk-1", exercise: "Walking", minutes: 20 });
    expect(first.ok, said(first)).toBe(true);
    const second = await run("health.log_sets", { session_id: "wk-1", exercise: "Walking", minutes: 15 });
    expect(second.ok, said(second)).toBe(true);
    const entries = () => db.workouts[0].exercises as ExerciseEntry[];
    expect(entries()[0].duration).toBe(35);
    const back = await undo(second);
    expect(back.ok, said(back)).toBe(true);
    // Back to 20, not to nothing and not to 35.
    expect(entries()[0].duration).toBe(20);
  });

  it("logging the same lift twice adds sets to it rather than a second entry for it", async () => {
    stockSession({ exercises: [] });
    await run("health.log_sets", { session_id: "wk-1", exercise: "Triceps pushdown", sets: [{ reps: 12, weight: 50 }] });
    const again = await run("health.log_sets", {
      session_id: "wk-1",
      // The same lift, spelled the way he actually says it. normName folds
      // tricep → triceps and drops the plural, so these are one exercise — the
      // spelling pair the app's own rule names in its comment.
      exercise: "tricep pushdowns",
      sets: [{ reps: 10, weight: 60 }],
    });
    expect(again.ok, said(again)).toBe(true);
    const entries = db.workouts[0].exercises as ExerciseEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0].sets).toHaveLength(2);
  });
});

// ── a portion's macros are exact ─────────────────────────────────────────────

describe("what goes into a meal comes back out of it", () => {
  it("a weighed portion's macros survive the round trip exactly", () => {
    const item = itemFromTotals({ name: "Chicken", grams: 200, kcal: 330, p: 62, c: 0, f: 7 }, "id");
    const back = contribution(item);
    expect(back.kcal).toBeCloseTo(330, 10);
    expect(back.p).toBeCloseTo(62, 10);
    expect(back.c).toBeCloseTo(0, 10);
    expect(back.f).toBeCloseTo(7, 10);
  });

  it("a portion nobody weighed is stored as one serving, with its macros exact", async () => {
    const out = await run("health.log_meal", {
      items: [{ name: "Chicken breast", kcal: 330, p: 62, c: 0, f: 7 }],
    });
    expect(out.ok, said(out)).toBe(true);
    const meals = db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[];
    const item = meals[0].items[0];
    // "1 serving", not a gram figure nobody measured — and the macros still exact.
    expect(item.qty).toBe(1);
    expect(item.unit?.name).toBe("serving");
    expect(contribution(item).kcal).toBeCloseTo(330, 10);
    const expected = itemFromServing({ name: "Chicken breast", kcal: 330, p: 62, c: 0, f: 7 }, item.id);
    expect(item.per100).toEqual(expected.per100);
  });

  it("a library food's amount is resolved by the app's own rule, by grams or by the each", async () => {
    // Eggs carry a natural unit of 50 g in the seed library, so "3 eggs" is 150 g —
    // and the door does not do that multiplication itself, mealLog's gramsOf does.
    const out = await run("health.log_meal", { items: [{ food_id: "eggs", qty: 3 }] });
    expect(out.ok, said(out)).toBe(true);
    const item = (db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[])[0].items[0];
    expect(item.grams).toBe(150);
    expect(item.qty).toBe(3);
    expect(item.unit?.name).toBe("egg");
    expect(item.foodId).toBe("eggs");
    // The macros are the library's, snapshotted onto the portion — which is why the
    // log stays right after that food is edited.
    expect(item.per100.kcal).toBe(143);
  });

  it("a food that is not counted by the each refuses qty and says to use grams", async () => {
    const out = await run("health.log_meal", { items: [{ food_id: "olive-oil", qty: 2 }] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toMatch(/grams/i);
  });

  it("a food_id and loose macros together is refused rather than resolved", async () => {
    const out = await run("health.log_meal", { items: [{ food_id: "eggs", grams: 100, kcal: 200, p: 10, c: 1, f: 15 }] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toMatch(/not both/i);
  });

  it("the sentence says what the meal came to, using the app's own totals", async () => {
    const out = await run("health.log_meal", {
      items: [{ name: "Chicken breast", kcal: 330, p: 62, c: 0, f: 7, grams: 200 }],
    });
    expect(out.ok, said(out)).toBe(true);
    if (out.ok) {
      const meals = db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[];
      const total = mealTotals(meals[0]);
      expect(out.say).toContain(`${Math.round(total.kcal)} kcal`);
    }
  });

  it("a stored portion in a shape the app cannot read does not crash the write", async () => {
    // saved_meals.items is jsonb with no shape enforced, and mealTotals reads
    // item.per100.kcal — so one old or hand-edited row would throw. A write that
    // LANDED must not come back as a 500 saying nothing happened.
    db.savedMeals.push({ id: "sm-1", name: "Old meal", items: [{ name: "Oats", kcal: 300 }] });
    const out = await run("health.log_saved_meal", { name: "Old meal" });
    expect(out.ok, said(out)).toBe(true);
    if (out.ok) expect(out.say).toMatch(/could not add up/i);
    expect((db.mealDays.get(`gino|${TODAY}`)!.meals as Meal[])).toHaveLength(1);
  });
});

// ── the guards ───────────────────────────────────────────────────────────────

describe("the guards the door adds, and says out loud", () => {
  it("refuses a second saved meal with the same name, because log_saved_meal matches by name", async () => {
    db.savedMeals.push({ id: "sm-1", name: "Usual breakfast", items: [portion()] });
    const out = await run("health.save_meal", { name: "usual breakfast", items: [{ name: "Oats", kcal: 300, p: 10, c: 54, f: 5, grams: 80 }] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(409);
    expect(db.savedMeals).toHaveLength(1);
  });

  it("refuses a second food with the same name, because search only ever finds the first", async () => {
    db.foods.push({
      id: "food-1", name: "Protein bar", role: "protein",
      kcal: 380, p: 30, c: 40, f: 10, serving: null, note: null, barcode: null,
    });
    const out = await run("health.add_food", { name: "protein BAR", kcal: 300, p: 20, c: 30, f: 8 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(409);
      expect(out.say).toMatch(/only ever finds the first/i);
    }
    expect(db.foods).toHaveLength(1);
  });

  it("refuses to delete a built-in food, and says it is not one of his", async () => {
    const out = await run("health.delete_food", { id: "chicken-breast" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toMatch(/built-in/i);
  });

  it("refuses to delete a built-in routine, and says it is not one he saved", async () => {
    const out = await run("health.delete_routine", { name: "Upper A" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toMatch(/built-in/i);
  });

  it("refuses a second unfinished session on the same day, and names the one that is open", async () => {
    stockSession({ id: "wk-1" });
    const out = await run("health.start_session", { name: "Another" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(409);
      expect(out.say).toMatch(/already an unfinished session/i);
    }
    expect(db.workouts).toHaveLength(1);
  });

  it("refuses to finish a session with nothing logged in it", async () => {
    stockSession({ exercises: [{ id: "ex-1", exerciseId: "", name: "Leg press", muscle: "legs", sets: [{ id: "s", reps: 0, weight: 0 }] }] });
    const out = await run("health.finish_session", { session_id: "wk-1" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toMatch(/nothing is logged/i);
    expect(db.workouts[0].done).toBe(false);
  });

  it("refuses a weigh-in that does not look like pounds", async () => {
    for (const weight of [19.84, 1984]) {
      const out = await run("health.log_weight", { weight });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.say).toMatch(/pounds/i);
    }
    expect(db.weights.size).toBe(0);
  });

  it("refuses a calorie target low enough to read as a misheard number", async () => {
    const out = await run("health.set_macro_target", { kcal: 280, p: 130, c: 410, f: 70 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toMatch(/misheard/i);
    expect(db.macroTargets.size).toBe(0);
  });

  it("deleting a weigh-in that was never there is a refusal, not a silent success", async () => {
    const out = await run("health.delete_weight", { date: YESTERDAY });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  it("marking a day that already has food on it says the food decides, not the mark", async () => {
    stockDay();
    const out = await run("health.mark_day", { date: TODAY, mark: "skipped" });
    expect(out.ok, said(out)).toBe(true);
    // Not a refusal: the app stores the mark either way. But a sentence that said
    // "marked off plan" about a day with three meals on it would be believed and the
    // streak would disagree with it.
    if (out.ok) expect(out.say).toMatch(/logged food decides the day/i);
  });

  it("a date in the future is refused in Arizona terms, not the runtime's", async () => {
    // At this instant a UTC runtime is already on the 27th. Arizona is not.
    const out = await run("health.log_weight", { weight: 198, date: "2026-09-27" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.say).toContain("Today is 2026-09-26");
  });

  it("a delete may name any past day, while a new entry may not be dated far back", async () => {
    // Two different guards on purpose: a misheard date on a NEW weigh-in is
    // invisible, and a delete names a row that either exists or does not.
    const old = await run("health.log_weight", { weight: 198, date: "2026-01-01" });
    expect(old.ok).toBe(false);
    db.weights.set("gino|2026-01-01", 210);
    const gone = await run("health.delete_weight", { date: "2026-01-01" });
    expect(gone.ok, said(gone)).toBe(true);
  });
});

// ── one person's key, one person's data ──────────────────────────────────────

describe("a key reaches one person's rows and not the other's", () => {
  it("cannot log a set into the other person's session, and is not told whose it is", async () => {
    stockSession();
    const out = await run("health.log_sets", { session_id: "wk-1", exercise: "Leg press", sets: [{ reps: 8, weight: 300 }] }, "xinyan");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(404);
      // The same sentence a missing id gets. Whose session an id belongs to is not
      // something either of them learns from this door.
      expect(out.say).toMatch(/no session of yours/i);
      expect(out.say).not.toMatch(/gino/i);
    }
  });

  it("cannot delete the other person's session", async () => {
    stockSession({ done: true });
    const out = await run("health.delete_session", { session_id: "wk-1" }, "xinyan");
    expect(out.ok).toBe(false);
    expect(db.workouts).toHaveLength(1);
  });

  it("cannot delete the other person's routine", async () => {
    db.routines.push({ id: "rt-1", person: "gino", name: "His", meta: "", exercises: [] });
    const out = await run("health.delete_routine", { id: "rt-1" }, "xinyan");
    expect(out.ok).toBe(false);
    expect(db.routines).toHaveLength(1);
  });

  it("logs a weigh-in against whoever's key was used", async () => {
    await run("health.log_weight", { weight: 128 }, "xinyan");
    expect(db.weights.get(`xinyan|${TODAY}`)).toBe(128);
    expect(db.weights.has(`gino|${TODAY}`)).toBe(false);
  });
});

// ── through the real handler ─────────────────────────────────────────────────

describe("the handler carries the undo token out, and the before-state stays in the log", () => {
  const post = (tool: string, args: Record<string, unknown>, key: string) =>
    new Request("https://example.test/functions/v1/muse-write", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GINO_SECRET}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ tool, args }),
    });

  const deps = (): Deps => ({
    db,
    push: (payload, owner) => {
      db.pushes.push({ title: payload.title, owner });
      return Promise.resolve();
    },
    secrets: SECRETS,
    appUrl: "https://example.test/homebase/",
    clock: clockNow(AT),
  });

  it("hands back a minted token, in the one shape system.undo accepts", async () => {
    // THIS TEST ASSERTED THE OPPOSITE UNTIL THE MERGE, and the change is the point of
    // the merge rather than a correction to it. The health branch minted its token from
    // (tool, idempotency-key) and stored the before-state in the audit row, which was a
    // reasonable seam to code against while no undo core existed. One did exist, on
    // another branch, with its own table and its own token shape — so these 22 tools were
    // handing back tokens that `system.undo` would refuse to parse, for changes that
    // `system.changes` could not list. The reply said "if he says undo, send the token
    // back". It would not have worked.
    const r = await handleWrite(post("health.log_weight", { weight: 198.4 }, "key-weight-0001"), deps());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const undoBody = r.body.undo as { token: string; says: string };
    // The shape system.undo checks, spelled here rather than imported, because this is
    // the claim: the two halves agree about what a token looks like.
    expect(undoBody.token).toMatch(/^u-[0-9a-hjkmnp-tv-z]{8}$/);
    expect(undoBody.says).toMatch(/take the 198.4 lb weigh-in/i);
    // And it names a real row in the change log, with the inverse recorded as one
    // `run_handler` step — the fifth step kind, which is where this half joins the core.
    const change = db.changes.find((c) => c.token === undoBody.token)!;
    expect(change, "the token names no change").toBeTruthy();
    expect(change.state).toBe("undoable");
    expect(change.steps).toEqual([
      { kind: "run_handler", handler: "weight.set", before: { date: TODAY, weight: null } },
    ]);
  });

  it("never says cannot_undo beside a token it minted", async () => {
    // FOUND 2026-10-09 on the finance side — a real token beside "Nothing was written
    // down that could put this back." This is the handler-minted half of the same
    // envelope: the token, its sentence, and no claim that the change is permanent.
    const r = await handleWrite(post("health.log_weight", { weight: 198.4 }, "key-weight-0009"), deps());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.undo as { token: string }).token).toMatch(/^u-[0-9a-hjkmnp-tv-z]{8}$/);
    expect(r.body.cannot_undo).toBeUndefined();
    expect(r.body.undo_with).toBeUndefined();
  });

  it("system.undo reaches a health change, through the same token and the same table", async () => {
    // THE CLAIM THIS WHOLE FILE COULD NOT MAKE BEFORE THE MERGE. Every test above drives
    // the handlers in HEALTH_UNDO directly, which proves the inverses are right and proves
    // nothing about whether anything can CALL them. It could not: HEALTH_UNDO was
    // registered nowhere, mergeUndo was never called, and the token shape did not match
    // the one system.undo parses. So this is the end-to-end path, through the door both
    // times, with nothing reaching into the registry by hand.
    db.weights.set(`gino|${TODAY}`, 199.2);
    const wrote = await handleWrite(post("health.log_weight", { weight: 198.4 }, "e2e-0001"), deps());
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
    expect(db.weights.get(`gino|${TODAY}`)).toBe(198.4);
    const token = (wrote.body.undo as { token: string }).token;

    const back = await handleWrite(post("system.undo", { token }, "e2e-0002"), deps());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // The weigh-in that was there before is back, to the tenth.
    expect(db.weights.get(`gino|${TODAY}`)).toBe(199.2);
    // And the change is marked undone, so a second undo of the same token is refused
    // rather than putting back a weight that is already back.
    expect(db.changes.find((c) => c.token === token)!.state).toBe("undone");
    const twice = await handleWrite(post("system.undo", { token }, "e2e-0003"), deps());
    expect(twice.status).toBe(409);
  });

  it("system.undo says the handler's own sentence when it cannot put it back", async () => {
    // A handler knows things the core cannot: "that meal is not on that day any more".
    // The refusal has to be ITS sentence, or the person cannot tell "I could not" from
    // "it was already done" — and those need different next steps.
    //
    // A weigh-in is the wrong tool for this test and that is worth a line: `weight.set`
    // deliberately has NO compare-and-set, because there is one weigh-in per day and
    // putting the old number back IS the whole inverse. A meal is a row inside a
    // document, so it can genuinely have gone.
    const wrote = await handleWrite(
      post("health.log_meal", { items: [{ name: "Rice", kcal: 260, p: 5, c: 56, f: 1, grams: 200 }] }, "e2e-0004"),
      deps(),
    );
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
    const token = (wrote.body.undo as { token: string }).token;

    // The phone's turn: somebody takes that meal off the day themselves.
    const doc = db.mealDays.get(`gino|${TODAY}`)!;
    doc.meals = [];
    doc.updatedAt = "v-phone";

    const back = await handleWrite(post("system.undo", { token }, "e2e-0005"), deps());
    expect(back.status).toBe(409);
    expect(String(back.body.message)).toMatch(/not on .* any more/i);
    // Nothing was written, and the change stays undoable rather than being marked done —
    // so asking again after putting the day right in the app finishes the job.
    expect(db.mealDays.get(`gino|${TODAY}`)!.meals).toEqual([]);
    expect(db.changes.find((c) => c.token === token)!.state).toBe("undoable");
  });

  it("keeps the before-state in the audit row, where the undo core will read it", async () => {
    db.weights.set(`gino|${TODAY}`, 199.2);
    await handleWrite(post("health.log_weight", { weight: 198.4 }, "key-weight-0002"), deps());
    const row = db.audit.find((a) => a.idemKey === "key-weight-0002")!;
    const stored = row.result as { undo: { kind: string; before: { weight: number } } };
    expect(stored.undo.kind).toBe("weight.set");
    expect(stored.undo.before.weight).toBe(199.2);
  });

  it("does NOT put the before-state in the reply, because a session document is not a reply", async () => {
    stockSession({ done: true });
    const r = await handleWrite(post("health.delete_session", { session_id: "wk-1" }, "key-del-0001"), deps());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const text = JSON.stringify(r.body);
    // The before-state of that delete is the whole session document. It belongs in
    // the audit row, not in something an assistant reads out.
    expect(text).not.toContain("exercises");
    expect(text).not.toContain("s-1");
    expect((r.body.undo as { token: string }).token).toBeTruthy();
  });

  it("a repeat under the same key replays the answer and the token, and writes nothing twice", async () => {
    const first = await handleWrite(post("health.log_weight", { weight: 198.4 }, "key-weight-0003"), deps());
    const again = await handleWrite(post("health.log_weight", { weight: 198.4 }, "key-weight-0003"), deps());
    expect(again.status).toBe(200);
    expect(again.body.repeated).toBe(true);
    expect(again.body.message).toBe(first.body.message);
    expect(again.body.undo).toEqual(first.body.undo);
    expect(db.weights.size).toBe(1);
    expect(db.audit.filter((a) => a.idemKey === "key-weight-0003")).toHaveLength(1);
  });

  it("refuses a field the tool does not take, by name, rather than ignoring it", async () => {
    const r = await handleWrite(post("health.log_sets", { session_id: "wk-1", reps: 8 }, "key-bad-0001"), deps());
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("does not take reps");
  });

  it("refuses a write aimed at the other person, whatever the body says", async () => {
    const r = await handleWrite(post("health.log_weight", { weight: 128, person: "xinyan" }, "key-aim-0001"), deps());
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/whoever's key was used/i);
    expect(db.weights.size).toBe(0);
  });
});

// ── the undo contract's own edges ────────────────────────────────────────────

// THE TOKEN'S OWN TESTS ARE NOT HERE ANY MORE.
//
// This branch minted its token from (tool, idempotency-key) and tested that it split back
// apart exactly one way. That token shape is gone: `system.undo` accepts one shape,
// `u-4k7m9qt2`, minted by _shared/muse/undo.ts and written into `muse_undo` — so a health
// change and a finance change are found the same way, and `system.changes` lists both.
// mintToken and TOKEN_SHAPE are tested in tests/museFinance.test.ts, against the core.
//
// What replaced it here is the end-to-end pair above: a weigh-in logged through the door
// and put back through the door, and a refusal that carries the handler's own sentence.
