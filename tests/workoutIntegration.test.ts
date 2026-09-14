import { describe, it, expect } from "vitest";
import { BUNDLED_EXERCISES } from "../src/lib/exerciseData";
import { searchExercises } from "../src/lib/workoutLog";
import { findExercise } from "../src/lib/trainingMath";
import { restDefault } from "../src/lib/restTimer";

// Seams between the workout v1 pieces that were built in separate branches.
describe("workout v1 — pieces fit together", () => {
  it("search never offers a hidden near-duplicate, but old logs still resolve it", () => {
    const names = searchExercises("burpee", BUNDLED_EXERCISES).map((e) => e.name);
    expect(names).toContain("Burpee");
    expect(names).not.toContain("Burpees");
    expect(findExercise(BUNDLED_EXERCISES, "Burpees")?.id).toBe("ex-burpees");
  });

  it("restDefault reads the library's mode and the set's kind", () => {
    const find = (n: string) => findExercise(BUNDLED_EXERCISES, n);
    expect(restDefault(find("Burpee"), { reps: 10, weight: 0 })).toBe(0);
    expect(restDefault(find("Barbell curl"), { reps: 8, weight: 60, kind: "warmup" })).toBe(60);
    expect(restDefault(find("Barbell curl"), { reps: 8, weight: 60 })).toBe(90);
    expect(restDefault(find("Bench dip"), { reps: 12, weight: 0 })).toBe(60);
  });
});
