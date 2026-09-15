import { describe, it, expect } from "vitest";
import { BUNDLED_EXERCISES } from "../src/lib/exerciseData";
import { searchExercises, type Workout } from "../src/lib/workoutLog";
import { findExercise, hardSetsByRegion, lastTime } from "../src/lib/trainingMath";
import { restDefault } from "../src/lib/restTimer";

// Seams between the workout v1 pieces that were built in separate branches.
describe("workout v1 — pieces fit together", () => {
  it("search never offers a hidden near-duplicate, but old logs still resolve it", () => {
    const names = searchExercises("burpee", BUNDLED_EXERCISES).map((e) => e.name);
    expect(names).toContain("Burpee");
    expect(names).not.toContain("Burpees");
    // an old log's "Burpees" (by name or by its old id) resolves to the entry it was folded into
    expect(findExercise(BUNDLED_EXERCISES, "Burpees")?.id).toBe("ex-burpee");
    expect(findExercise(BUNDLED_EXERCISES, "Burpees", "ex-burpees")?.id).toBe("ex-burpee");
  });

  // The hidden "Burpees" came first in the library and answered for "Burpee", so
  // an entry saved with exerciseId ex-burpee never matched a name lookup.
  it("a burpee picked from search counts on its exercise page and as last time", () => {
    const w: Workout = {
      id: "w1",
      date: "2026-09-10",
      person: "xinyan",
      name: "Home",
      notes: "",
      done: true,
      exercises: [{ id: "e1", exerciseId: "ex-burpee", name: "Burpee", muscle: "cardio", sets: [{ reps: 10, weight: 0, done: true }] }],
    };
    expect(findExercise(BUNDLED_EXERCISES, "Burpee")?.id).toBe("ex-burpee");
    expect(lastTime([w], "xinyan", "Burpee", BUNDLED_EXERCISES)?.date).toBe("2026-09-10");
  });

  it("ticked cardio sets are not 'sets with no muscle detail'", () => {
    const w: Workout = {
      id: "w2",
      date: "2026-09-10",
      person: "xinyan",
      name: "Steps",
      notes: "",
      done: true,
      exercises: [
        { id: "e1", exerciseId: "", name: "Walking", muscle: "cardio", sets: [{ reps: 8000, weight: 0, done: true }] },
        { id: "e2", exerciseId: "ex-burpee", name: "Burpee", muscle: "cardio", sets: [{ reps: 10, weight: 0, done: true }] },
      ],
    };
    expect(hardSetsByRegion([w], BUNDLED_EXERCISES, "xinyan", "2026-09-10")).toEqual({ byRegion: {}, unplaced: 0 });
  });

  it("restDefault reads the library's mode and the set's kind", () => {
    const find = (n: string) => findExercise(BUNDLED_EXERCISES, n);
    expect(restDefault(find("Burpee"), { reps: 10, weight: 0 })).toBe(0);
    expect(restDefault(find("Barbell curl"), { reps: 8, weight: 60, kind: "warmup" })).toBe(60);
    expect(restDefault(find("Barbell curl"), { reps: 8, weight: 60 })).toBe(90);
    expect(restDefault(find("Bench dip"), { reps: 12, weight: 0 })).toBe(60);
  });
});
