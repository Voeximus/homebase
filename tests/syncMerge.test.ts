import { describe, it, expect } from "vitest";
import {
  createSyncTracker,
  derivedSetId,
  mergeExercises,
  mergeSets,
  mergeWorkout,
  mergeWorkoutLists,
  removedIds,
  removedSetIds,
  repairDuplicateSetIds,
  unionById,
  type SyncSet,
} from "../src/lib/syncMerge";
import type { ExerciseEntry, Workout } from "../src/lib/workoutLog";

// "Never lose a set" is a claim about ORDER: which copy of a session survives
// when two phones and a slow network interleave. Each test below replays one
// interleaving that used to lose (or duplicate) a set and checks the survivor.

const s = (id: string | undefined, weight = 100, reps = 5, extra: Partial<SyncSet> = {}): SyncSet => ({
  ...(id === undefined ? {} : { id }),
  weight,
  reps,
  ...extra,
});
const ex = (id: string, sets: SyncSet[], name = `Exercise ${id}`): ExerciseEntry => ({ id, exerciseId: "", name, muscle: "chest", sets });
const wk = (id: string, exercises: ExerciseEntry[], over: Partial<Workout> = {}): Workout => ({
  id,
  date: "2026-09-14",
  person: "gino",
  name: "Workout",
  notes: "",
  exercises,
  done: false,
  ...over,
});
const ids = (sets: SyncSet[]) => sets.map((x) => x.id);
const setsOf = (w: Workout, exId = "e1") => w.exercises.find((e) => e.id === exId)!.sets as SyncSet[];

describe("the unsaved flag clears only when no newer edit arrived", () => {
  it("a save of the newest edit clears it", () => {
    const t = createSyncTracker();
    const g = t.edit("w|1");
    expect(t.isDirty("w|1")).toBe(true);
    expect(t.settle("w|1", g)).toBe(true);
    expect(t.isDirty("w|1")).toBe(false);
  });

  it("race: edit 1, save starts, edit 2, save 1 lands — still unsaved, and a refetch of the gen-1 copy does not replace local", () => {
    const t = createSyncTracker();
    const key = "w|s1";
    // edit (gen 1): one set ticked
    t.edit(key);
    const gen1 = wk("s1", [ex("e1", [s("a", 100, 5, { done: true })])]);
    // save 1 starts from gen 1
    const saveStartedAt = t.generation(key);
    // edit (gen 2): a second set ticked while save 1 is in the air
    t.edit(key);
    let local = [wk("s1", [ex("e1", [s("a", 100, 5, { done: true }), s("b", 100, 5, { done: true })])])];
    // save 1 lands
    expect(t.settle(key, saveStartedAt)).toBe(false);
    expect(t.isDirty(key)).toBe(true);
    // the refetch its own write triggers answers with the gen-1 copy
    const fetchNo = t.beginFetch();
    local = mergeWorkoutLists(local, [gen1], (id) => t.protects(`w|${id}`, fetchNo), () => undefined);
    expect(ids(setsOf(local[0]))).toEqual(["a", "b"]);
    expect(setsOf(local[0])[1].done).toBe(true);
  });

  it("the save of the newer edit then clears it, and a later refetch is truth again", () => {
    const t = createSyncTracker();
    const g1 = t.edit("k");
    const g2 = t.edit("k");
    expect(t.settle("k", g1)).toBe(false);
    expect(t.settle("k", g2)).toBe(true);
    const f = t.beginFetch();
    expect(t.protects("k", f)).toBe(false);
  });

  it("a refetch already in the air when the save landed still merges (its copy predates the save)", () => {
    const t = createSyncTracker();
    const g = t.edit("k");
    const early = t.beginFetch(); // started before the save landed
    t.settle("k", g);
    const late = t.beginFetch(); // started after
    expect(t.isDirty("k")).toBe(false);
    expect(t.protects("k", early)).toBe(true);
    expect(t.protects("k", late)).toBe(false);
  });

  it("a gave-up or deleted key is forgotten regardless of generation", () => {
    const t = createSyncTracker();
    t.edit("k");
    t.edit("k");
    const inAir = t.beginFetch();
    t.forget("k");
    expect(t.isDirty("k")).toBe(false);
    expect(t.protects("k", inAir)).toBe(true);
    expect(t.protects("k", t.beginFetch())).toBe(false);
  });

  it("keys are independent, and a never-edited key is clean at generation 0", () => {
    const t = createSyncTracker();
    const ga = t.edit("a");
    t.edit("b");
    expect(t.generation("c")).toBe(0);
    expect(t.isDirty("c")).toBe(false);
    expect(t.settle("a", ga)).toBe(true);
    expect(t.isDirty("b")).toBe(true);
  });
});

describe("sets merge one by one when every set has an id", () => {
  it("[a, b, c] local + [a, b, d] remote → [a, b, c, d]", () => {
    expect(ids(mergeSets([s("a"), s("b"), s("c")], [s("a"), s("b"), s("d")]) as SyncSet[])).toEqual(["a", "b", "c", "d"]);
  });

  it("local wins for a set both sides have", () => {
    const out = mergeSets([s("a", 185, 5, { done: true })], [s("a", 135, 8), s("b")]) as SyncSet[];
    expect(out[0]).toEqual(s("a", 185, 5, { done: true }));
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("a set removed here stays removed while the remote still has it", () => {
    const local = [s("a"), s("c")];
    const out = mergeSets(local, [s("a"), s("b"), s("c")], new Set(["b"]));
    expect(ids(out as SyncSet[])).toEqual(["a", "c"]);
    expect(out).toBe(local); // nothing adopted → same array, no state churn
  });

  it("removed b stays removed even when the remote also has a new set d", () => {
    expect(ids(mergeSets([s("a"), s("c")], [s("a"), s("b"), s("c"), s("d")], new Set(["b"])) as SyncSet[])).toEqual(["a", "c", "d"]);
  });

  it("returns the local array itself when the remote adds nothing", () => {
    const local = [s("a"), s("b")];
    expect(mergeSets(local, [s("b"), s("a")])).toBe(local);
  });

  it("a set without an id on EITHER side → the local list whole", () => {
    const local = [s("a"), s(undefined)];
    expect(mergeSets(local, [s("a"), s("d")])).toBe(local);
    const local2 = [s("a")];
    expect(mergeSets(local2, [s("a"), s(undefined)])).toBe(local2);
    const local3 = [s("a")];
    expect(mergeSets(local3, [s("a"), s("")])).toBe(local3); // an empty id is no id
  });

  it("a remote list carrying the same new id twice adds it once", () => {
    expect(ids(mergeSets([s("a")], [s("a"), s("d"), s("d")]) as SyncSet[])).toEqual(["a", "d"]);
  });
});

describe("exercises merge, then their sets", () => {
  it("shared exercise merges by set; remote-only exercise is appended; a removed exercise is not", () => {
    const local = [ex("e1", [s("a"), s("b"), s("c")])];
    const remote = [ex("e1", [s("a"), s("b"), s("d")]), ex("e2", [s("x")]), ex("gone", [s("y")])];
    const out = mergeExercises(local, remote, { exercises: new Set(["gone"]) });
    expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(ids(out[0].sets as SyncSet[])).toEqual(["a", "b", "c", "d"]);
  });

  it("sets without ids: the whole local exercise wins, while an exercise with ids still merges", () => {
    const legacy = ex("old", [{ reps: 5, weight: 135 }]);
    const local = [legacy, ex("e1", [s("a")])];
    const remote = [ex("old", [{ reps: 5, weight: 135 }, { reps: 5, weight: 135 }]), ex("e1", [s("a"), s("b")])];
    const out = mergeExercises(local, remote);
    expect(out[0]).toBe(legacy);
    expect(ids(out[1].sets as SyncSet[])).toEqual(["a", "b"]);
  });

  it("set tombstones apply inside the shared exercise", () => {
    const out = mergeExercises([ex("e1", [s("a")])], [ex("e1", [s("a"), s("b")])], { sets: new Set(["b"]) });
    expect(ids(out[0].sets as SyncSet[])).toEqual(["a"]);
  });

  it("returns the local array itself when nothing is adopted", () => {
    const local = [ex("e1", [s("a")]), ex("e2", [s("b")])];
    expect(mergeExercises(local, [ex("e1", [s("a")])])).toBe(local);
  });

  it("the workout keeps local name, notes and done; returns local itself when unchanged", () => {
    const local = wk("w", [ex("e1", [s("a")])], { name: "Push", notes: "felt good" });
    const remote = wk("w", [ex("e1", [s("a"), s("b")])], { name: "Old", notes: "", done: true });
    const out = mergeWorkout(local, remote);
    expect(out.name).toBe("Push");
    expect(out.notes).toBe("felt good");
    expect(out.done).toBe(false);
    expect(ids(setsOf(out))).toEqual(["a", "b"]);
    expect(mergeWorkout(local, wk("w", [ex("e1", [s("a")])]))).toBe(local);
  });
});

describe("the workouts list after a refetch", () => {
  const unprotected = () => false;
  it("unprotected sessions take the remote copy whole", () => {
    const local = [wk("w", [ex("e1", [s("a"), s("b")])])];
    const remote = [wk("w", [ex("e1", [s("a")])])];
    expect(mergeWorkoutLists(local, remote, unprotected, () => undefined)).toEqual(remote);
  });

  it("a protected session merges; a protected local-only session stays at the front; an unprotected local-only one goes", () => {
    const local = [wk("new", []), wk("gone", []), wk("w", [ex("e1", [s("a"), s("c")])])];
    const remote = [wk("w", [ex("e1", [s("a"), s("b"), s("d")])]), wk("other", [])];
    const prot = (id: string) => id === "new" || id === "w";
    const out = mergeWorkoutLists(local, remote, prot, (id) => (id === "w" ? { sets: new Set(["b"]) } : undefined));
    expect(out.map((w) => w.id)).toEqual(["new", "w", "other"]);
    expect(ids(setsOf(out[1]))).toEqual(["a", "c", "d"]);
  });

  it("a protected session with no local copy takes the remote", () => {
    const remote = [wk("w", [ex("e1", [s("a")])])];
    expect(mergeWorkoutLists([], remote, () => true, () => undefined)).toEqual(remote);
  });
});

describe("what an edit deleted", () => {
  it("removedIds lists ids gone from the new list", () => {
    expect(removedIds([{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "c" }, { id: "a" }])).toEqual(["b"]);
    expect(removedIds(undefined, [{ id: "a" }])).toEqual([]);
  });

  it("removedSetIds looks across the whole workout and ignores sets without ids", () => {
    const prev = wk("w", [ex("e1", [s("a"), s("b"), s(undefined)]), ex("e2", [s("x")])]);
    const next = wk("w", [ex("e1", [s("a")])]);
    expect(removedSetIds(prev, next)).toEqual(["b", "x"]);
    expect(removedSetIds(undefined, next)).toEqual([]);
  });
});

describe("duplicate set ids from old app versions are repaired on load", () => {
  // An old phone adds a set by copying the last one — id, done and doneAt too.
  const copied = s("a", 185, 5, { done: true, doneAt: 1000 });

  it("the second copy gets a new id from the injected maker; the first keeps its id", () => {
    let n = 0;
    const make = () => `new${++n}`;
    const out = repairDuplicateSetIds(wk("w", [ex("e1", [copied, { ...copied }, { ...copied }])]), make);
    expect(ids(setsOf(out))).toEqual(["a", "new1", "new2"]);
    // everything else the copy carried is kept (such a copy looks ticked, by design)
    expect(setsOf(out)[1]).toEqual({ ...copied, id: "new1" });
  });

  it("the default new id is derived, so every load repairs the same way", () => {
    const row = wk("w", [ex("e1", [copied, { ...copied }])]);
    const once = repairDuplicateSetIds(row);
    const again = repairDuplicateSetIds(structuredClone(row));
    expect(ids(setsOf(once))).toEqual(["a", derivedSetId("a", 1)]);
    expect(again).toEqual(once);
  });

  it("never lands on an id another set in the exercise already has", () => {
    const out = repairDuplicateSetIds(wk("w", [ex("e1", [s("a"), s("a"), s("a~1")])]));
    const got = ids(setsOf(out));
    expect(got).toEqual(["a", "a~1~1", "a~1"]);
    expect(new Set(got).size).toBe(3);
  });

  it("an injected maker that keeps colliding still ends unique", () => {
    const out = repairDuplicateSetIds(wk("w", [ex("e1", [s("a"), s("a"), s("same")])]), () => "same");
    const got = ids(setsOf(out));
    expect(new Set(got).size).toBe(3);
  });

  it("only within one exercise: the same id in two exercises is left alone; no duplicates → same object", () => {
    const w = wk("w", [ex("e1", [s("a"), s(undefined), s(undefined)]), ex("e2", [s("a")])]);
    expect(repairDuplicateSetIds(w)).toBe(w);
  });

  it("repaired copies merge without showing a set twice (old phone added a third copy meanwhile)", () => {
    // this phone loaded [a, a] earlier, repaired to [a, a~1], and has an unsaved edit
    const local = repairDuplicateSetIds(wk("w", [ex("e1", [copied, { ...copied }])]));
    // the old phone copied again: [a, a, a]
    const remote = repairDuplicateSetIds(wk("w", [ex("e1", [copied, { ...copied }, { ...copied }])]));
    expect(ids(setsOf(mergeWorkout(local, remote)))).toEqual(["a", "a~1", "a~2"]);
  });
});

describe("meal days keep the whole-child union", () => {
  it("unionById adopts remote-only children and respects removals", () => {
    const local = [{ id: "m1" }, { id: "m3" }];
    expect(unionById(local, [{ id: "m1" }, { id: "m2" }, { id: "m4" }], new Set(["m2"]))).toEqual([{ id: "m1" }, { id: "m3" }, { id: "m4" }]);
    expect(unionById(local, [{ id: "m1" }])).toBe(local);
  });
});
