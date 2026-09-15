import { describe, it, expect } from "vitest";
import {
  isDone,
  isWarmup,
  normName,
  findExercise,
  e1rm,
  hardSetsByRegion,
  bandLabel,
  repRecords,
  recentRecords,
  lastTime,
} from "../src/lib/trainingMath";
import { bestSet, e1RM, personalRecords, totalSets } from "../src/lib/workoutLog";
import type { Exercise, SetEntry, Workout } from "../src/lib/workoutLog";

// ── builders ──────────────────────────────────────────────────────────────────
const ex = (over: Partial<Exercise> & { id: string; name: string }): Exercise => ({
  muscle: "legs",
  equipment: "barbell",
  type: "compound",
  ...over,
});

const LIB: Exercise[] = [
  ex({ id: "ex-x", name: "Exercise X", primary: ["quads_vasti"], secondary: ["glute_max"] }),
  ex({ id: "ex-bench", name: "Bench press", muscle: "chest", primary: ["chest_lower"], secondary: ["delt_front", "triceps_short"] }),
  ex({ id: "ex-pushdown", name: "Triceps pushdown", muscle: "arms", type: "isolation", aliases: ["Rope pushdown"] }),
  ex({ id: "ex-db-press", name: "Dumbbell bench press", muscle: "chest", aliases: ["Flat dumbbell press"] }),
];

const set = (weight: number, reps: number, over: Partial<SetEntry> = {}): SetEntry => ({ weight, reps, ...over });
const warm = (weight: number, reps: number): SetEntry => set(weight, reps, { kind: "warmup", done: true });

let seq = 0;
const workout = (date: string, exercises: [name: string, sets: SetEntry[], exerciseId?: string][], over: Partial<Workout> = {}): Workout => ({
  id: `w${++seq}`,
  date,
  person: "gino",
  name: "Session",
  notes: "",
  done: true,
  exercises: exercises.map(([name, sets, exerciseId], i) => ({ id: `e${i}`, exerciseId: exerciseId ?? "", name, muscle: "legs", sets })),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("which sets count", () => {
  it("a tick decides when present", () => {
    expect(isDone(set(135, 5, { done: true }))).toBe(true);
    expect(isDone(set(135, 5, { done: false }))).toBe(false);
    expect(isDone(set(0, 0, { done: true }))).toBe(true);
  });
  it("legacy rows without a tick: reps > 0 means done", () => {
    expect(isDone({ reps: 5, weight: 135 })).toBe(true);
    expect(isDone({ reps: 0, weight: 0 })).toBe(false);
  });
  it("only kind 'warmup' is a warm-up", () => {
    expect(isWarmup(set(95, 5, { kind: "warmup" }))).toBe(true);
    expect(isWarmup(set(95, 5, { kind: "working" }))).toBe(false);
    expect(isWarmup(set(95, 5))).toBe(false);
  });
});

describe("normName", () => {
  it("case, spaces, hyphens and underscores", () => {
    expect(normName("  Pull-Up ")).toBe("pull up");
    expect(normName("pull__up")).toBe("pull up");
    expect(normName("Pull -  up")).toBe("pull up");
  });
  it("spelling variants old logs used", () => {
    expect(normName("Dumbbell flye")).toBe("dumbbell fly");
    expect(normName("Dumbbell flyes")).toBe(normName("Dumbbell fly"));
    expect(normName("Skull crushers")).toBe("skullcrusher");
    expect(normName("skullcrusher")).toBe("skullcrusher");
    expect(normName("Tricep pushdown")).toBe(normName("Triceps pushdown"));
    expect(normName("Overhead tricep")).toBe(normName("Overhead triceps"));
  });
  it("drops one plural s from the last word only when safe", () => {
    expect(normName("Romanian deadlifts")).toBe("romanian deadlift");
    expect(normName("Bench press")).toBe("bench press"); // ends "ss"
    expect(normName("Abs")).toBe("abs"); // 3 letters
    expect(normName("Lunges")).toBe("lunge");
    expect(normName("Bench presses")).toBe("bench presse"); // only one s, by rule
    expect(normName("Calves raise")).toBe("calves raise"); // not the last word
  });
});

describe("findExercise", () => {
  it("id first, even when the name disagrees", () => {
    expect(findExercise(LIB, "Something renamed", "ex-bench")?.id).toBe("ex-bench");
  });
  it("then normalised name, then alias", () => {
    expect(findExercise(LIB, "tricep pushdowns")?.id).toBe("ex-pushdown");
    expect(findExercise(LIB, "Flat dumbbell press")?.id).toBe("ex-db-press");
    expect(findExercise(LIB, "rope-pushdown", "stale-id")?.id).toBe("ex-pushdown");
  });
  it("unknown → undefined", () => {
    expect(findExercise(LIB, "Nordic curl")).toBeUndefined();
  });
  it("sees an exercise pushed into the same library array", () => {
    const lib = [...LIB];
    expect(findExercise(lib, "Band row")).toBeUndefined();
    lib.push(ex({ id: "hb-band-row", name: "Band row" }));
    expect(findExercise(lib, "band rows")?.id).toBe("hb-band-row");
  });
});

describe("e1rm", () => {
  it("Epley between 2 and 15 reps", () => {
    expect(e1rm(200, 5)).toBeCloseTo(233.33, 2);
    expect(e1rm(135, 12)).toBeCloseTo(189, 6);
    expect(e1rm(100, 15)).toBeCloseTo(150, 6);
  });
  it("a single is the weight itself", () => {
    expect(e1rm(200, 1)).toBe(200);
  });
  it("none above 15 reps, without weight, or without reps", () => {
    expect(e1rm(135, 16)).toBeNull();
    expect(e1rm(0, 5)).toBeNull();
    expect(e1rm(0, 20)).toBeNull();
    expect(e1rm(135, 0)).toBeNull();
    expect(e1rm(Number.NaN, 5)).toBeNull();
  });
  it("the old workoutLog e1RM keeps its number shape: 0 when there is none", () => {
    expect(e1RM(200, 1)).toBe(200);
    expect(e1RM(200, 5)).toBeCloseTo(233.33, 2);
    expect(e1RM(135, 16)).toBe(0);
    expect(e1RM(0, 5)).toBe(0);
  });
});

describe("hardSetsByRegion", () => {
  const today = "2026-09-12";

  it("main muscle 1, helper 0.5, warm-ups never count", () => {
    const w = workout(today, [["Exercise X", [warm(95, 8), set(185, 5, { done: true }), set(185, 5, { done: true }), set(185, 4, { done: true })]]]);
    const r = hardSetsByRegion([w], LIB, "gino", today);
    expect(r.byRegion).toEqual({ quads_vasti: 3, glute_max: 1.5 });
    expect(r.unplaced).toBe(0);
  });

  it("legacy {reps:5, weight:135} counts; {reps:0, weight:0} and un-ticked sets do not", () => {
    const w = workout(today, [["Exercise X", [{ reps: 5, weight: 135 }, { reps: 0, weight: 0 }, set(135, 5, { done: false })]]]);
    expect(hardSetsByRegion([w], LIB, "gino", today).byRegion).toEqual({ quads_vasti: 1, glute_max: 0.5 });
  });

  it("the 7-day window: 6 days ago is in, 7 days ago is out, the future is out", () => {
    const sets = () => [set(185, 5, { done: true })];
    const ws = [
      workout("2026-09-06", [["Exercise X", sets()]]),
      workout("2026-09-05", [["Exercise X", sets()]]),
      workout("2026-09-13", [["Exercise X", sets()]]),
    ];
    expect(hardSetsByRegion(ws, LIB, "gino", today).byRegion.quads_vasti).toBe(1);
    expect(hardSetsByRegion(ws, LIB, "gino", today, 8).byRegion.quads_vasti).toBe(2);
  });

  it("only that person's finished workouts", () => {
    const ws = [
      workout(today, [["Exercise X", [set(185, 5)]]], { person: "xinyan" }),
      workout(today, [["Exercise X", [set(185, 5)]]], { done: false }),
    ];
    expect(hardSetsByRegion(ws, LIB, "gino", today)).toEqual({ byRegion: {}, unplaced: 0 });
  });

  it("sets whose exercise has no region data are counted as unplaced", () => {
    const w = workout(today, [
      ["Triceps pushdown", [set(50, 12), set(50, 10), warm(20, 10)]],
      ["Mystery move", [set(10, 10)]],
      ["Bench press", [set(185, 5)]],
    ]);
    const r = hardSetsByRegion([w], LIB, "gino", today);
    expect(r.unplaced).toBe(3);
    expect(r.byRegion).toEqual({ chest_lower: 1, delt_front: 0.5, triceps_short: 0.5 });
  });

  it("matches the exercise by id, name or alias", () => {
    const w = workout(today, [["Old name", [set(185, 5)], "ex-x"]]);
    expect(hardSetsByRegion([w], LIB, "gino", today).byRegion.quads_vasti).toBe(1);
  });
});

describe("bandLabel", () => {
  it.each([
    [0, "None"],
    [3.5, "Below the lowest band in the studies"],
    [4, "Minimum band"],
    [4.5, "More growth for each set"],
    [10, "More growth for each set"],
    [10.5, "More in total, less for each extra set"],
    [18, "More in total, less for each extra set"],
    [18.5, "Less for each extra set"],
    [29.5, "Less for each extra set"],
    [30, "Least for each extra set"],
    [42.5, "Least for each extra set"],
    [43, "Not enough studies to say"],
  ])("%s hard sets → %s", (n, label) => {
    expect(bandLabel(n)).toBe(label);
  });
});

describe("repRecords", () => {
  it("heaviest weight for at least N reps; warm-ups excluded", () => {
    const ws = [
      workout("2026-09-01", [["Bench press", [warm(225, 12), set(185, 8), set(205, 5)]]]),
      workout("2026-09-08", [["bench-press", [set(225, 3), set(135, 12)]]]),
    ];
    expect(repRecords(ws, "gino", "Bench press", LIB)).toEqual({ 1: 225, 3: 225, 5: 205, 8: 185, 10: 135, 12: 135 });
  });

  it("un-ticked sets, other people, unfinished workouts and bodyweight sets do not count", () => {
    const ws = [
      workout("2026-09-01", [["Bench press", [set(300, 5, { done: false }), set(0, 20)]]]),
      workout("2026-09-01", [["Bench press", [set(300, 5)]]], { person: "xinyan" }),
      workout("2026-09-02", [["Bench press", [set(300, 5)]]], { done: false }),
    ];
    expect(repRecords(ws, "gino", "Bench press", LIB)).toEqual({ 1: null, 3: null, 5: null, 8: null, 10: null, 12: null });
  });

  it("an alias logged in an old routine is the same exercise", () => {
    const ws = [workout("2026-09-01", [["Flat dumbbell press", [set(70, 10)]]])];
    expect(repRecords(ws, "gino", "Dumbbell bench press", LIB)[10]).toBe(70);
  });
});

describe("recentRecords", () => {
  it("prior 185×5 and 205×3: 190×5 is a record, 200×3 is not", () => {
    const ws = [
      workout("2026-09-01", [["Bench press", [set(185, 5), set(205, 3)]]]),
      workout("2026-09-08", [["Bench press", [set(190, 5), set(200, 3)]]]),
    ];
    // (205×3 on the 1st is itself a record over 185×5; only the 8th is under test)
    const later = recentRecords(ws, "gino", LIB).filter((r) => r.date === "2026-09-08");
    expect(later).toEqual([{ name: "Bench press", weight: 190, reps: 5, date: "2026-09-08" }]);
  });

  it("the first set ever is a baseline, not a record; warm-ups never count", () => {
    const ws = [
      workout("2026-09-01", [["Bench press", [warm(135, 5), set(185, 5)]]]),
      workout("2026-09-03", [["Bench press", [warm(250, 5), set(180, 5)]]]),
    ];
    expect(recentRecords(ws, "gino", LIB)).toEqual([]);
  });

  it("newest first, respects the limit, ignores input order", () => {
    const ws = [
      workout("2026-09-10", [["Bench press", [set(200, 5)]]]),
      workout("2026-09-01", [["Bench press", [set(185, 5)]]]),
      workout("2026-09-05", [["Bench press", [set(195, 5)]]]),
    ];
    expect(recentRecords(ws, "gino", LIB).map((r) => r.date)).toEqual(["2026-09-10", "2026-09-05"]);
    expect(recentRecords(ws, "gino", LIB, 1)).toHaveLength(1);
  });

  // A first-ever session used to turn every heavier ramp set after the first
  // into a "record", several per exercise in one workout.
  it("the first session of an exercise is a baseline: its ramp sets are not records", () => {
    const first = workout("2026-09-01", [["Bench press", [set(95, 10), set(135, 8), set(185, 5)]]]);
    expect(recentRecords([first], "gino", LIB)).toEqual([]);
    const second = workout("2026-09-08", [["Bench press", [set(190, 5)]]]);
    expect(recentRecords([first, second], "gino", LIB)).toEqual([{ name: "Bench press", weight: 190, reps: 5, date: "2026-09-08" }]);
  });

  it("compares with earlier workouts only, and keeps one record per rep count per workout (the heaviest)", () => {
    const ws = [
      workout("2026-09-01", [["Bench press", [set(185, 5)]]]),
      workout("2026-09-08", [["Bench press", [set(190, 5), set(195, 5), set(185, 5)]]]),
    ];
    expect(recentRecords(ws, "gino", LIB)).toEqual([{ name: "Bench press", weight: 195, reps: 5, date: "2026-09-08" }]);
  });

  it("bodyweight sets set a baseline but are never records", () => {
    const ws = [
      workout("2026-09-01", [["Pull-up", [set(0, 8), set(0, 10)]]]),
      workout("2026-09-03", [["Pull-up", [set(0, 12), set(25, 5)]]]),
    ];
    expect(recentRecords(ws, "gino", LIB)).toEqual([{ name: "Pull-up", weight: 25, reps: 5, date: "2026-09-03" }]);
  });

  it("a tick with no reps is not a set: no hard set, no record, not last time", () => {
    const w = workout("2026-09-12", [["Exercise X", [set(225, 0, { done: true })]]]);
    expect(hardSetsByRegion([w], LIB, "gino", "2026-09-12")).toEqual({ byRegion: {}, unplaced: 0 });
    expect(totalSets(w)).toBe(0);
    expect(lastTime([w], "gino", "Exercise X", LIB)).toBeNull();
    expect(repRecords([w], "gino", "Exercise X", LIB)[1]).toBeNull();
  });
});

describe("lastTime", () => {
  it("the most recent finished session with the exercise, its done sets", () => {
    const current = workout("2026-09-12", [["Bench press", [set(190, 5, { done: true })]]], { done: false });
    const ws = [
      workout("2026-09-03", [["Bench press", [warm(95, 8), set(185, 5), set(185, 5), set(185, 4), set(0, 0)]]]),
      workout("2026-08-27", [["Bench press", [set(180, 5)]]]),
      workout("2026-09-09", [["Exercise X", [set(225, 5)]]]),
      workout("2026-09-10", [["Bench press", [set(185, 5)]]], { person: "xinyan" }),
      current,
    ];
    const r = lastTime(ws, "gino", " BENCH press", LIB, current.id);
    expect(r?.date).toBe("2026-09-03");
    expect(r?.sets.map((s) => `${s.weight}×${s.reps}`)).toEqual(["95×8", "185×5", "185×5", "185×4"]);
  });

  it("excludeWorkoutId skips that workout even if it is finished", () => {
    const a = workout("2026-09-01", [["Bench press", [set(180, 5)]]]);
    const b = workout("2026-09-05", [["Bench press", [set(185, 5)]]]);
    expect(lastTime([a, b], "gino", "Bench press", LIB, b.id)?.date).toBe("2026-09-01");
  });

  it("a session where the exercise has no done sets does not answer", () => {
    const a = workout("2026-09-01", [["Bench press", [set(180, 5)]]]);
    const b = workout("2026-09-05", [["Bench press", [set(0, 0)]]]);
    expect(lastTime([a, b], "gino", "Bench press", LIB)?.date).toBe("2026-09-01");
    expect(lastTime([b], "gino", "Bench press", LIB)).toBeNull();
  });
});

describe("workoutLog records skip warm-ups and un-ticked sets", () => {
  it("bestSet", () => {
    expect(bestSet([warm(225, 5), set(300, 5, { done: false }), set(185, 5)])).toEqual({
      weight: 185,
      reps: 5,
      e1rm: e1rm(185, 5),
    });
  });
  it("personalRecords keys by normalised name", () => {
    const ws = [
      workout("2026-09-01", [["Tricep pushdowns", [set(50, 10)]]]),
      workout("2026-09-08", [["Triceps pushdown", [warm(90, 10), set(60, 10)]]]),
    ];
    const prs = personalRecords(ws, LIB);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ name: "Triceps pushdown", weight: 60, reps: 10, date: "2026-09-08" });
  });

  // An old routine's alias name and the library name picked from search used to
  // show as two separate records.
  it("personalRecords: an alias and the library name are one exercise (V1 §8)", () => {
    const ws = [
      workout("2026-09-01", [["Flat dumbbell press", [set(60, 8)]]]),
      workout("2026-09-08", [["Dumbbell bench press", [set(55, 8)], "ex-db-press"]]),
    ];
    const prs = personalRecords(ws, LIB);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ name: "Dumbbell bench press", weight: 60, reps: 8 });
  });
  it("personalRecords: an exercise not in the library still keys by its normalised name", () => {
    const ws = [workout("2026-09-01", [["Sandbag carry", [set(80, 5)]]]), workout("2026-09-02", [["sandbag-carrys", [set(90, 5)]]])];
    expect(personalRecords(ws, LIB)).toHaveLength(1);
  });
  it("totalSets (the history row's 'N sets') counts done working sets only", () => {
    const w = workout("2026-09-08", [
      ["Bench press", [warm(95, 10), set(185, 5, { done: true }), set(185, 5, { done: false })]],
      ["Leg press", [set(270, 8), set(0, 0)]], // legacy: a done row and a planned row never done
    ]);
    expect(totalSets(w)).toBe(2);
  });
});
