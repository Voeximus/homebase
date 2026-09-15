import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  addSet,
  clearSessionStart,
  copyLastSet,
  discardTarget,
  editSet,
  elapsedParts,
  finishSummary,
  finishWorkout,
  fmtWeight,
  ghostFor,
  ghostsFor,
  initSessionStart,
  logMode,
  needsWeight,
  newSet,
  NO_GHOST,
  readSessionStart,
  removeExercise,
  removeSet,
  replaceEntry,
  sessionCounts,
  sessionRecords,
  sessionStartKey,
  shortDay,
  showsWeight,
  tickSet,
  toggleWarmup,
  untick,
  type Ghost,
} from "../src/lib/sessionOps";
import { isDone } from "../src/lib/trainingMath";
import { ActiveSession } from "../src/views/workout/ActiveSession";
import { personalRecords, totalSets, type Exercise, type ExerciseEntry, type SetEntry, type Workout } from "../src/lib/workoutLog";

// The logger's rules, one tap at a time. Nothing here renders except the last
// block, which only checks what the logger DRAWS for a given workout.

// ── builders ──────────────────────────────────────────────────────────────────
const ex = (over: Partial<Exercise> & { id: string; name: string }): Exercise => ({
  muscle: "chest",
  equipment: "barbell",
  type: "compound",
  ...over,
});

const BENCH = ex({ id: "ex-bench", name: "Bench press", mode: "weighted", primary: ["chest_lower"], secondary: ["delt_front"] });
const PUSHUP = ex({ id: "ex-pushup", name: "Push-up", equipment: "bodyweight", mode: "bodyweight", primary: ["chest_lower"] });
const BAND_ROW = ex({ id: "ex-band-row", name: "Band row", muscle: "back", equipment: "band", mode: "band", primary: ["lats"] });
const PLANK = ex({ id: "ex-plank", name: "Plank", muscle: "core", equipment: "bodyweight", type: "isolation", mode: "timed", primary: ["abs"] });
const BIKE = ex({ id: "ex-bike", name: "Bike", muscle: "cardio", equipment: "machine", type: "cardio", mode: "cardio" });
// weighted mode, but done with bodyweight equipment (a weight is optional)
const DIP = ex({ id: "ex-dip", name: "Dip", equipment: "bodyweight", mode: "weighted", primary: ["triceps_long"] });
const LIB = [BENCH, PUSHUP, BAND_ROW, PLANK, BIKE, DIP];

const set = (weight: number, reps: number, over: Partial<SetEntry> = {}): SetEntry => ({ weight, reps, ...over });
const W = (weight: number, reps: number, over: Partial<SetEntry> = {}) => set(weight, reps, { kind: "warmup", ...over });
const entry = (sets: SetEntry[], over: Partial<ExerciseEntry> = {}): ExerciseEntry => ({
  id: "e1",
  exerciseId: "",
  name: "Bench press",
  muscle: "chest",
  sets,
  ...over,
});
const workout = (exercises: ExerciseEntry[], over: Partial<Workout> = {}): Workout => ({
  id: "w-now",
  date: "2026-09-14",
  person: "gino",
  name: "Upper A",
  notes: "",
  exercises,
  done: false,
  ...over,
});
const g = (weight: number, reps: number): Ghost => ({ weight, reps });
const ids = () => {
  let n = 0;
  const make = () => `id-${++n}`;
  return Object.assign(make, { count: () => n });
};

// ── modes ─────────────────────────────────────────────────────────────────────
describe("logMode / showsWeight / needsWeight", () => {
  it("uses the library mode, else guesses from type and equipment", () => {
    expect(logMode(BENCH)).toBe("weighted");
    expect(logMode(ex({ id: "a", name: "A", type: "cardio" }))).toBe("cardio");
    expect(logMode(ex({ id: "b", name: "B", equipment: "bodyweight" }))).toBe("bodyweight");
    expect(logMode(ex({ id: "c", name: "C" }))).toBe("weighted");
    expect(logMode(undefined)).toBeUndefined();
  });

  it("hides the weight box for bodyweight, band, timed and cardio; keeps it for weighted and unknown", () => {
    expect(showsWeight(BENCH)).toBe(true);
    expect(showsWeight(DIP)).toBe(true);
    expect(showsWeight(undefined)).toBe(true);
    for (const e of [PUSHUP, BAND_ROW, PLANK, BIKE]) expect(showsWeight(e)).toBe(false);
  });

  it("requires a weight only for a weighted library exercise not done with bodyweight equipment", () => {
    expect(needsWeight(BENCH)).toBe(true);
    for (const e of [PUSHUP, BAND_ROW, PLANK, BIKE, DIP, undefined]) expect(needsWeight(e)).toBe(false);
  });
});

// ── ghosts ────────────────────────────────────────────────────────────────────
describe("ghostsFor / ghostFor", () => {
  const last = [W(95, 5, { done: true }), set(185, 5, { done: true }), set(185, 5, { done: true }), set(185, 4, { done: true })];

  it("takes last time's value for the same position, warm-ups to warm-ups and working to working", () => {
    const e = entry([W(0, 0), set(0, 0), set(0, 0), set(0, 0)]);
    expect(ghostsFor(e, last)).toEqual([g(95, 5), g(185, 5), g(185, 5), g(185, 4)]);
  });

  it("does not hand a warm-up's numbers to a working set when today has no warm-up", () => {
    const e = entry([set(0, 0), set(0, 0)]);
    expect(ghostsFor(e, last)).toEqual([g(185, 5), g(185, 5)]);
  });

  it("matches working sets by their count among working sets, wherever the warm-ups sit", () => {
    // last time: 185×5, W 135×3, 190×3 — today: W, 1, 2
    const mixed = [set(185, 5, { done: true }), W(135, 3, { done: true }), set(190, 3, { done: true })];
    const e = entry([W(0, 0), set(0, 0), set(0, 0)]);
    expect(ghostsFor(e, mixed)).toEqual([g(135, 3), g(185, 5), g(190, 3)]);
  });

  it("falls back to the row above of the same kind — typed values first, else its own ghost", () => {
    const e = entry([set(0, 0), set(0, 0), set(0, 0), set(0, 0), set(0, 0)]);
    // last time had three working sets; row 4 inherits row 3's ghost, row 5 inherits row 4
    expect(ghostsFor(e, last).slice(3)).toEqual([g(185, 4), g(185, 4)]);
    const typed = entry([set(0, 0), set(0, 0), set(0, 0), set(200, 0), set(0, 0)]);
    expect(ghostsFor(typed, last)[4]).toEqual(g(200, 4));
  });

  it("with no last time, the first row is empty and later rows follow what was typed above", () => {
    const e = entry([set(135, 8), set(0, 0), set(0, 6), set(0, 0)]);
    expect(ghostsFor(e, null)).toEqual([NO_GHOST, g(135, 8), g(135, 8), g(135, 6)]);
  });

  it("never lets a warm-up above feed a working row, or a working row feed a warm-up", () => {
    const e = entry([W(95, 5), set(0, 0), W(0, 0)]);
    expect(ghostsFor(e, undefined)).toEqual([NO_GHOST, NO_GHOST, g(95, 5)]);
  });

  it("decides each box on its own: last time's reps with the row above's weight", () => {
    const bwLast = [set(185, 5, { done: true }), set(0, 5, { done: true })]; // second set logged without a weight
    const e = entry([set(0, 0), set(0, 0)]);
    expect(ghostsFor(e, bwLast)).toEqual([g(185, 5), g(185, 5)]);
  });

  it("ignores last time's sets that were never done", () => {
    const e = entry([set(0, 0)]);
    expect(ghostsFor(e, [set(225, 1, { done: false }), set(185, 5, { done: true })])).toEqual([g(185, 5)]);
  });

  it("ghostFor is one row of ghostsFor, NO_GHOST out of range, and reads currentSets when given", () => {
    const e = entry([W(0, 0), set(0, 0), set(0, 0)]);
    expect(ghostFor(e, 2, last)).toEqual(ghostsFor(e, last)[2]);
    expect(ghostFor(e, 9, last)).toEqual(NO_GHOST);
    expect(ghostFor(e, 0, last, [set(0, 0)])).toEqual(g(185, 5)); // row 0 is working in currentSets
  });

  it("does not change its inputs", () => {
    const e = entry([set(0, 0), set(0, 0)]);
    const before = JSON.stringify(e);
    ghostsFor(e, last);
    expect(JSON.stringify(e)).toBe(before);
  });
});

// ── tick ──────────────────────────────────────────────────────────────────────
describe("tickSet", () => {
  it("fills empty boxes from the ghost, keeps typed ones, and marks the set done with time and id", () => {
    const e = entry([set(0, 0), set(190, 0, { id: "s2", kind: "working", done: false })]);
    const make = ids();
    const r = tickSet(e, 1, [g(185, 5), g(185, 5)], BENCH, 1234, make);
    expect(r.error).toBeUndefined();
    expect(r.entry!.sets[1]).toEqual({ id: "s2", kind: "working", weight: 190, reps: 5, done: true, doneAt: 1234 });
    expect(make.count()).toBe(0); // an existing id is kept, no new one made
    expect(r.entry!.sets[0]).toBe(e.sets[0]); // other rows untouched
  });

  it("gives a legacy row without an id one on tick", () => {
    const e = entry([set(185, 5)]);
    const r = tickSet(e, 0, [NO_GHOST], BENCH, 99, ids());
    expect(r.entry!.sets[0]).toEqual({ weight: 185, reps: 5, id: "id-1", done: true, doneAt: 99 });
  });

  it("marks a legacy row with reps (already counted as done) explicitly done", () => {
    const e = entry([set(185, 5)]);
    expect(isDone(e.sets[0])).toBe(true);
    const r = tickSet(e, 0, [], BENCH, 5, ids());
    expect(r.entry!.sets[0].done).toBe(true);
  });

  it("refuses a weighted exercise with no weight typed or suggested, and changes nothing", () => {
    const e = entry([set(0, 5)]);
    const before = JSON.stringify(e);
    const make = ids();
    expect(tickSet(e, 0, [g(0, 5)], BENCH, 1, make)).toEqual({ error: "needs-weight" });
    expect(tickSet(e, 0, [], BENCH, 1, make)).toEqual({ error: "needs-weight" });
    expect(JSON.stringify(e)).toBe(before);
    expect(make.count()).toBe(0);
  });

  it("accepts a weighted set when only the ghost has the weight", () => {
    const r = tickSet(entry([set(0, 0)]), 0, [g(185, 5)], BENCH, 1, ids());
    expect(r.entry!.sets[0]).toMatchObject({ weight: 185, reps: 5, done: true });
  });

  it("needs no weight for bodyweight, band, timed and cardio — and never fills a hidden weight box", () => {
    for (const exercise of [PUSHUP, BAND_ROW, PLANK, BIKE]) {
      const r = tickSet(entry([set(0, 0)]), 0, [g(45, 12)], exercise, 1, ids());
      expect(r.error).toBeUndefined();
      expect(r.entry!.sets[0]).toMatchObject({ weight: 0, reps: 12, done: true });
    }
  });

  it("needs no weight for bodyweight equipment even when the mode says weighted, but uses the shown ghost", () => {
    expect(tickSet(entry([set(0, 8)]), 0, [], DIP, 1, ids()).error).toBeUndefined();
    expect(tickSet(entry([set(0, 0)]), 0, [g(25, 8)], DIP, 1, ids()).entry!.sets[0]).toMatchObject({ weight: 25, reps: 8 });
  });

  it("needs no weight for an exercise that isn't in the library", () => {
    const r = tickSet(entry([set(0, 10)], { name: "My move" }), 0, [], undefined, 1, ids());
    expect(r.entry!.sets[0]).toMatchObject({ weight: 0, reps: 10, done: true });
  });

  it("leaves a ticked set alone (un-ticking is untick) and ignores a row that doesn't exist", () => {
    const e = entry([set(185, 5, { id: "s1", done: true, doneAt: 7 })]);
    expect(tickSet(e, 0, [], BENCH, 99, ids()).entry).toBe(e);
    expect(tickSet(e, 3, [], BENCH, 99, ids()).entry).toBe(e);
  });

  it("does not change the entry it was given", () => {
    const e = entry([set(0, 0)]);
    const before = JSON.stringify(e);
    tickSet(e, 0, [g(185, 5)], BENCH, 1, ids());
    expect(JSON.stringify(e)).toBe(before);
  });

  // The first time an exercise is logged there is no ghost: 225 typed, reps
  // left empty, tick → a 0-rep "done" set that counted as a hard set.
  it("refuses a set with no reps typed or suggested, for every kind of exercise", () => {
    const make = ids();
    expect(tickSet(entry([set(225, 0)]), 0, [NO_GHOST], BENCH, 1, make)).toEqual({ error: "needs-reps" });
    for (const exercise of [PUSHUP, BAND_ROW, PLANK, BIKE, DIP, undefined]) {
      expect(tickSet(entry([set(0, 0)]), 0, [], exercise, 1, make).error).toBe("needs-reps");
    }
    expect(make.count()).toBe(0);
    // the weight is asked for first when both are missing
    expect(tickSet(entry([set(0, 0)]), 0, [], BENCH, 1, make)).toEqual({ error: "needs-weight" });
  });
});

describe("untick", () => {
  it("writes done: false, drops doneAt, keeps the numbers and id", () => {
    const e = entry([set(185, 5, { id: "s1", done: true, doneAt: 7, kind: "working" })]);
    const next = untick(e, 0);
    expect(next.sets[0]).toEqual({ id: "s1", weight: 185, reps: 5, done: false, kind: "working" });
    expect("doneAt" in next.sets[0]).toBe(false);
    expect(e.sets[0].done).toBe(true);
  });

  it("really un-ticks a legacy row that counted as done only because it had reps", () => {
    const next = untick(entry([set(185, 5)]), 0);
    expect(isDone(next.sets[0])).toBe(false);
  });

  it("returns the same entry for a row that doesn't exist", () => {
    const e = entry([]);
    expect(untick(e, 0)).toBe(e);
  });
});

describe("toggleWarmup", () => {
  it("goes working (or no kind) → warm-up → working, stored as no kind, and leaves done alone", () => {
    const e = entry([set(95, 5, { done: true })]);
    const w = toggleWarmup(e, 0);
    expect(w.sets[0]).toEqual({ weight: 95, reps: 5, done: true, kind: "warmup" });
    expect(toggleWarmup(w, 0).sets[0]).toEqual({ weight: 95, reps: 5, done: true });
    expect(toggleWarmup(e, 5)).toBe(e);
  });
});

describe("editSet", () => {
  it("pins a legacy empty row as not done, so typing reps doesn't tick it", () => {
    const next = editSet(entry([set(0, 0)]), 0, { reps: 8 });
    expect(next.sets[0]).toEqual({ weight: 0, reps: 8, done: false });
    expect(isDone(next.sets[0])).toBe(false);
  });

  it("pins a legacy row with reps as done, so changing its reps doesn't untick it", () => {
    const next = editSet(entry([set(185, 5)]), 0, { reps: 0 });
    expect(next.sets[0]).toEqual({ weight: 185, reps: 0, done: true });
  });

  it("changes only the box given and turns junk into 0", () => {
    const e = entry([set(185, 5, { done: false })]);
    expect(editSet(e, 0, { weight: 17.5 }).sets[0]).toMatchObject({ weight: 17.5, reps: 5 });
    expect(editSet(e, 0, { weight: -5 }).sets[0].weight).toBe(0);
    expect(editSet(e, 0, { reps: Number.NaN }).sets[0].reps).toBe(0);
  });
});

describe("addSet / removeSet", () => {
  it("adds an empty working set with a new id, copying nothing from the row above", () => {
    const e = entry([W(95, 5, { id: "a", done: true, doneAt: 3 })]);
    const next = addSet(e, () => "new-id");
    expect(next.sets).toHaveLength(2);
    expect(next.sets[1]).toEqual({ id: "new-id", reps: 0, weight: 0 });
    expect(newSet(() => "x")).toEqual({ id: "x", reps: 0, weight: 0 });
    expect(e.sets).toHaveLength(1);
  });

  // Scratch test S4: rows the new app created carried done: false, and the old
  // app version (no tick; edits with {...set, ...patch}, adds by copying the
  // last row) carried it along — nothing logged there ever counted.
  it("a row the new app created counts once an old app version types into it", () => {
    const make = ids();
    let e = addSet(entry([]), make); // like a routine start: one fresh row
    const oldEdit = (s: SetEntry, patch: Partial<SetEntry>) => ({ ...s, ...patch });
    e = { ...e, sets: [oldEdit(e.sets[0], { weight: 135, reps: 8 })] };
    e = { ...e, sets: [...e.sets, { ...e.sets[e.sets.length - 1] }] }; // old app's Add set
    const w = workout([e]);
    expect(e.sets.every(isDone)).toBe(true);
    expect(totalSets(w)).toBe(2);
    expect(finishWorkout(w).nothingLogged).toBe(false);
    expect(personalRecords([finishWorkout(w).workout], LIB)).toHaveLength(1);
  });

  it("typing into a fresh row in this app still doesn't count until it is ticked", () => {
    const e = editSet(addSet(entry([]), ids()), 0, { reps: 8 });
    expect(isDone(e.sets[0])).toBe(false);
  });

  it("removes the row at the index, and nothing when the index is out of range", () => {
    const e = entry([set(1, 1), set(2, 2), set(3, 3)]);
    expect(removeSet(e, 1).sets.map((s) => s.weight)).toEqual([1, 3]);
    expect(removeSet(e, 3)).toBe(e);
    expect(removeSet(e, -1)).toBe(e);
  });
});

describe("copyLastSet (the history editor's Add set)", () => {
  // Scratch test probe2: it copied the last row whole — id, tick, doneAt, kind.
  it("copies the last row's numbers only: a new id, no tick, no warm-up mark", () => {
    const e = entry([set(135, 8, { id: "a", done: false, kind: "warmup" }), set(185, 5, { id: "b", done: true, doneAt: 9 })]);
    const next = copyLastSet(e, () => "fresh");
    expect(next.sets[2]).toEqual({ id: "fresh", reps: 5, weight: 185 });
    const fromUnticked = copyLastSet(entry([set(135, 6, { id: "a", done: false, kind: "warmup" })]), () => "fresh");
    expect(fromUnticked.sets[1]).toEqual({ id: "fresh", reps: 6, weight: 135 });
    expect(isDone(fromUnticked.sets[1])).toBe(true); // counts by the reps rule: the editor has no tick
    expect(copyLastSet(entry([]), () => "fresh").sets).toEqual([{ id: "fresh", reps: 0, weight: 0 }]);
  });
});

describe("discardTarget", () => {
  // Discard deleted whatever was stale when Discard was TAPPED, not the session
  // the confirm was opened for.
  it("is the session the confirm was opened for, only while it exists and is unfinished", () => {
    const mon = workout([], { id: "mon", date: "2026-09-08" });
    const sun = workout([], { id: "sun", date: "2026-09-07" });
    expect(discardTarget([mon, sun], "mon")).toBe(mon);
    // the other phone finished Monday's session while the confirm was open
    expect(discardTarget([{ ...mon, done: true }, sun], "mon")).toBeNull();
    expect(discardTarget([sun], "mon")).toBeNull();
    expect(discardTarget([mon, sun], null)).toBeNull();
  });
});

describe("replaceEntry / removeExercise", () => {
  it("swaps or drops one exercise by id", () => {
    const a = entry([set(1, 1)], { id: "a" });
    const b = entry([set(2, 2)], { id: "b" });
    const w = workout([a, b]);
    const b2 = { ...b, name: "Changed" };
    expect(replaceEntry(w, b2).exercises).toEqual([a, b2]);
    expect(removeExercise(w, "a").exercises).toEqual([b]);
    expect(w.exercises).toEqual([a, b]);
  });
});

// ── finish ────────────────────────────────────────────────────────────────────
describe("finishWorkout", () => {
  it("drops sets with no numbers and exercises left empty; keeps unticked sets that have numbers", () => {
    const w = workout([
      entry([set(185, 5, { done: true }), set(0, 0, { done: false }), set(185, 4, { done: false })], { id: "a" }),
      entry([set(0, 0), set(0, 0, { done: true })], { id: "b" }),
    ]);
    const { workout: out, nothingLogged } = finishWorkout(w);
    expect(nothingLogged).toBe(false);
    expect(out.done).toBe(true);
    expect(out.exercises.map((e) => e.id)).toEqual(["a"]);
    expect(out.exercises[0].sets).toEqual([set(185, 5, { done: true }), set(185, 4, { done: false })]);
    expect(w.exercises[0].sets).toHaveLength(3); // input untouched
  });

  it("keeps a timed entry with a duration and no sets", () => {
    const walk = entry([], { id: "walk", name: "Walk", duration: 30 });
    const { workout: out, nothingLogged } = finishWorkout(workout([walk]));
    expect(out.exercises).toEqual([walk]);
    expect(nothingLogged).toBe(false);
  });

  it("says nothing was logged when no set is done — even if some have typed numbers", () => {
    expect(finishWorkout(workout([])).nothingLogged).toBe(true);
    expect(finishWorkout(workout([entry([set(0, 0), set(0, 0)])])).nothingLogged).toBe(true);
    expect(finishWorkout(workout([entry([set(185, 5, { done: false })])])).nothingLogged).toBe(true);
  });

  it("counts a legacy row with reps as logged", () => {
    expect(finishWorkout(workout([entry([set(185, 5)])])).nothingLogged).toBe(false);
  });
});

describe("sessionCounts", () => {
  it("counts working sets done / planned and warm-ups done apart", () => {
    const w = workout([
      entry([W(95, 5, { done: true }), W(0, 0), set(185, 5, { done: true }), set(0, 0), set(185, 5)], { id: "a" }),
      entry([set(0, 10, { done: false })], { id: "b" }),
    ]);
    expect(sessionCounts(w)).toEqual({ done: 2, planned: 4, warmups: 1 });
  });

  it("a stored tick with no reps logged nothing: not done in the bar, not a set on the finish sheet", () => {
    const w = workout([entry([set(225, 0, { done: true, doneAt: 5 })])]);
    expect(sessionCounts(w)).toEqual({ done: 0, planned: 1, warmups: 0 });
    expect(finishSummary(w, null)).toMatchObject({ sets: 0, unticked: 1 });
    expect(finishWorkout(w).nothingLogged).toBe(true);
  });
});

describe("finishSummary", () => {
  const min = 60000;
  const w = workout([
    entry([W(95, 5, { done: true, doneAt: 10 * min }), set(185, 5, { done: true, doneAt: 14 * min }), set(185, 5, { done: true, doneAt: 52 * min })], { id: "a" }),
    entry([set(0, 0), set(40, 10, { done: false })], { id: "b" }),
    entry([set(0, 0)], { id: "c" }),
  ]);

  it("times from the session start to the last tick, and counts what will be kept, dropped and not counted", () => {
    expect(finishSummary(w, 2 * min)).toEqual({ minutes: 50, sets: 2, warmups: 1, exercises: 1, empty: 2, unticked: 1 });
  });

  it("times from the first tick when the start is unknown or later than the last tick", () => {
    expect(finishSummary(w, null).minutes).toBe(42);
    expect(finishSummary(w, 60 * min).minutes).toBe(42);
  });

  it("has no time when no tick carries one", () => {
    expect(finishSummary(workout([entry([set(185, 5)])]), 0).minutes).toBeNull();
  });

  it("has no time when an old session gets a tick days later (two sittings, not a 2807-minute workout)", () => {
    const later = workout([entry([set(185, 5, { done: true, doneAt: 10 * min }), set(185, 5, { done: true, doneAt: 10 * min + 2 * 24 * 60 * min })])]);
    expect(finishSummary(later, null).minutes).toBeNull();
    const long = workout([entry([set(185, 5, { done: true, doneAt: 10 * min }), set(185, 5, { done: true, doneAt: 190 * min })])]);
    expect(finishSummary(long, null).minutes).toBe(180);
  });
});

describe("sessionRecords", () => {
  const past = (id: string, date: string, sets: SetEntry[], name = "Bench press"): Workout =>
    workout([entry(sets, { id: `${id}-e`, name })], { id, date, done: true });

  it("reports a set that beats the record standing before this session", () => {
    const history = [past("p1", "2026-09-01", [set(185, 5, { done: true })])];
    const now = past("w-now", "2026-09-14", [set(190, 5, { done: true }), set(185, 5, { done: true })]);
    expect(sessionRecords(history, now, "gino", LIB)).toEqual([{ name: "Bench press", weight: 190, reps: 5, date: "2026-09-14" }]);
  });

  it("treats the first session of an exercise as a baseline, and never counts warm-ups", () => {
    const now = past("w-now", "2026-09-14", [set(135, 8, { done: true }), set(145, 8, { done: true })]);
    expect(sessionRecords([], now, "gino", LIB)).toEqual([]);
    const warm = past("w-now", "2026-09-14", [W(500, 5, { done: true })]);
    expect(sessionRecords([past("p1", "2026-09-01", [set(185, 5, { done: true })])], warm, "gino", LIB)).toEqual([]);
  });

  it("leaves out records from another session the same day, and replaces this session's stale copy", () => {
    const history = [
      past("p1", "2026-09-01", [set(185, 5, { done: true })]),
      past("p2", "2026-09-14", [set(200, 5, { done: true })]), // this morning's record
      past("w-now", "2026-09-14", [set(999, 1, { done: true })]), // the store's older copy of this session
    ];
    const now = past("w-now", "2026-09-14", [set(195, 5, { done: true })]);
    expect(sessionRecords(history, now, "gino", LIB)).toEqual([]);
  });
});

// ── session start on the phone ──────────────────────────────────────────────────
function memoryStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
const brokenStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("session start", () => {
  it("is stored once under hb-session-start-<id>; later opens keep the first time", () => {
    const store = memoryStore();
    expect(sessionStartKey("w1")).toBe("hb-session-start-w1");
    expect(readSessionStart("w1", store)).toBeNull();
    expect(initSessionStart("w1", 1000, store)).toBe(1000);
    expect(initSessionStart("w1", 5000, store)).toBe(1000);
    expect(store.m.get("hb-session-start-w1")).toBe("1000");
    expect(readSessionStart("w1", store)).toBe(1000);
    clearSessionStart("w1", store);
    expect(readSessionStart("w1", store)).toBeNull();
  });

  it("treats junk as no start, and never throws when storage is blocked or missing", () => {
    const store = memoryStore();
    store.setItem("hb-session-start-w1", "yesterday");
    expect(readSessionStart("w1", store)).toBeNull();
    expect(readSessionStart("w1", brokenStore)).toBeNull();
    expect(initSessionStart("w1", 42, brokenStore)).toBe(42);
    expect(() => clearSessionStart("w1", brokenStore)).not.toThrow();
    expect(initSessionStart("w1", 42, undefined)).toBe(42);
  });
});

// ── formatting ─────────────────────────────────────────────────────────────────
describe("formatting", () => {
  it("shortDay spells the date the same on every ICU version", () => {
    expect(shortDay("2026-09-01")).toBe("Tue 1 Sep");
    expect(shortDay("2026-09-14")).toBe("Mon 14 Sep");
    expect(shortDay("2026-09-01", "zh")).toBe("9月1日 周二");
    expect(shortDay("not a date")).toBe("not a date");
  });

  it("fmtWeight keeps up to two decimals without trailing zeros", () => {
    expect(fmtWeight(185)).toBe("185");
    expect(fmtWeight(17.5)).toBe("17.5");
    expect(fmtWeight(1.25)).toBe("1.25");
    expect(fmtWeight(2.333)).toBe("2.33");
  });

  it("elapsedParts gives whole hours and minutes, never negative", () => {
    expect(elapsedParts(42 * 60000 + 59000)).toEqual({ h: 0, m: 42 });
    expect(elapsedParts(65 * 60000)).toEqual({ h: 1, m: 5 });
    expect(elapsedParts(-1)).toEqual({ h: 0, m: 0 });
  });
});

// ── what the logger draws ─────────────────────────────────────────────────────
describe("ActiveSession (static render)", () => {
  const noop = () => {};
  const history: Workout[] = [
    workout(
      [
        entry([W(95, 5, { done: true }), set(185, 5, { done: true }), set(185, 4, { done: true })], { id: "h1", name: "Bench press" }),
        entry([set(0, 12, { done: true })], { id: "h2", name: "Push-up" }),
      ],
      { id: "old", date: "2026-09-01", done: true },
    ),
  ];
  const html = (w: Workout) =>
    renderToStaticMarkup(
      createElement(ActiveSession, {
        workout: w,
        person: "gino",
        library: LIB,
        workouts: [...history, w],
        onChange: noop,
        onFinish: noop,
        onDiscard: noop,
        onOpenExercise: noop,
        onAddExercise: noop,
      }),
    );

  it("shows last time's working sets in one line and last time's numbers as placeholders", () => {
    const out = html(workout([entry([set(0, 0), set(0, 0)], { name: "Bench press" })]));
    expect(out).toContain("Last time (Tue 1 Sep): 185×5 · 185×4");
    expect(out).toContain('placeholder="185"');
    expect(out).toContain('placeholder="4"');
    expect(out).toContain("0 / 2 work sets");
  });

  it("has a weight box for a weighted exercise and none for a bodyweight one", () => {
    const weighted = html(workout([entry([set(0, 0)], { name: "Bench press" })]));
    const bodyweight = html(workout([entry([set(0, 0)], { name: "Push-up" })]));
    expect(weighted).toContain('aria-label="Weight for set 1"');
    expect(bodyweight).not.toContain("Weight for");
    expect(bodyweight).toContain('aria-label="Reps for set 1"');
    expect(bodyweight).toContain("Last time (Tue 1 Sep): 12 reps");
  });

  it("labels warm-ups W, numbers working sets on their own, and marks done ticks pressed", () => {
    const out = html(workout([entry([W(95, 5, { done: true }), set(185, 5, { done: true }), set(0, 0)], { name: "Bench press" })]));
    expect(out).toContain("W = warm-up");
    expect(out).toContain('aria-label="Set 2. Tap to make it a warm-up"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(out).toContain("1 / 2 work sets");
    expect(out).toContain("1 warm-up done");
  });

  it("says so for a first-time exercise and for an empty session", () => {
    expect(html(workout([entry([set(0, 0)], { name: "Dip" })]))).toContain("First time logging this");
    expect(html(workout([]))).toContain("No exercises yet. Add your first one.");
  });
});
