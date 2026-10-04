import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeHealth } from "../src/dev/fakeHealthStore";
import { buildWorkoutFixtures } from "../src/dev/workoutFixtures";
import { BUNDLED_EXERCISES } from "../src/lib/exerciseData";
import { SEED_ROUTINES, type Workout } from "../src/lib/workoutLog";

// ?workoutlab is the one place workout mode's UI gets checked, and there is no
// sandbox database. So the two things worth proving about the harness are that
// its store really cannot reach Supabase, and that the fake behaves like the
// real store wherever a screen could tell the difference.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUPABASE = resolve(ROOT, "src/lib/supabase.ts");

/** Every file reachable from `entry` through RUNTIME imports. `import type` and
 *  `export type` are erased by the compiler, so they are not followed; a mixed
 *  `import { type A, b }` still is. Bare specifiers (packages) are not followed. */
function runtimeImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(ROOT, entry)];
  const stmt = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs: string[] = [];
    for (const m of src.matchAll(stmt)) if (!m[2]) specs.push(m[4]);
    for (const m of src.matchAll(bare)) specs.push(m[1]);
    for (const m of src.matchAll(dynamic)) specs.push(m[1]);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(isFile);
      if (hit) queue.push(hit);
    }
  }
  return seen;
}
const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
const rel = (files: Set<string>) => [...files].map((f) => relative(ROOT, f).replace(/\\/g, "/"));

describe("the harness store never reaches Supabase", () => {
  it("the scan is not vacuous: the REAL store does reach supabase.ts", () => {
    // If this ever fails, the scanner has stopped following imports and the
    // checks below would pass for the wrong reason.
    expect(runtimeImportGraph("src/store/HealthStore.tsx").has(SUPABASE)).toBe(true);
  });

  it("fakeHealthStore.ts has no runtime path to supabase.ts", () => {
    const graph = runtimeImportGraph("src/dev/fakeHealthStore.ts");
    expect(rel(graph)).not.toContain("src/lib/supabase.ts");
    // …and in particular it only borrows the HealthStore TYPE, never the module.
    expect(rel(graph)).not.toContain("src/store/HealthStore.tsx");
  });

  it("the fixtures have no runtime path to supabase.ts", () => {
    expect(rel(runtimeImportGraph("src/dev/workoutFixtures.ts"))).not.toContain("src/lib/supabase.ts");
  });
});

const w = (id: string, over: Partial<Workout> = {}): Workout => ({
  id,
  date: "2026-09-14",
  person: "gino",
  name: "Upper A",
  notes: "",
  exercises: [],
  done: false,
  ...over,
});

describe("the fake store behaves like the real one", () => {
  it("upsertWorkout puts a new session first and replaces an existing one in place", () => {
    const f = createFakeHealth({ workouts: [w("a"), w("b")] });
    f.actions.upsertWorkout(w("c"));
    expect(f.getState().workouts.map((x) => x.id)).toEqual(["c", "a", "b"]);
    f.actions.upsertWorkout(w("a", { done: true, name: "Renamed" }));
    const s = f.getState().workouts;
    expect(s.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(s[1]).toMatchObject({ done: true, name: "Renamed" });
  });

  it("deleteWorkout removes only that session", () => {
    const f = createFakeHealth({ workouts: [w("a"), w("b")] });
    f.actions.deleteWorkout("a");
    expect(f.getState().workouts.map((x) => x.id)).toEqual(["b"]);
  });

  it("routines are appended and deleted by id", () => {
    const f = createFakeHealth();
    const r = (id: string) => ({ id, person: "gino" as const, name: id, exercises: [] });
    f.actions.addRoutine(r("r1"));
    f.actions.addRoutine(r("r2"));
    f.actions.deleteRoutine("r1");
    expect(f.getState().routines.map((x) => x.id)).toEqual(["r2"]);
  });

  it("every write hands out a NEW state and tells subscribers, so the screens re-render", () => {
    const f = createFakeHealth();
    let calls = 0;
    const off = f.subscribe(() => calls++);
    const before = f.getState();
    f.actions.upsertWorkout(w("a"));
    expect(f.getState()).not.toBe(before);
    expect(calls).toBe(1);
    off();
    f.actions.deleteWorkout("a");
    expect(calls).toBe(1);
  });

  it("getDay sees a setDay made a line earlier, and an empty day otherwise", () => {
    const f = createFakeHealth();
    expect(f.actions.getDay("gino", "2026-09-14")).toEqual({ date: "2026-09-14", person: "gino", meals: [] });
    f.actions.setDay({ date: "2026-09-14", person: "gino", meals: [{ id: "m", name: "Lunch", items: [] }] });
    expect(f.actions.getDay("gino", "2026-09-14").meals).toHaveLength(1);
    expect(f.actions.getDay("xinyan", "2026-09-14").meals).toHaveLength(0);
  });

  it("weigh-ins are one per person and day; clearing one person keeps the other", () => {
    const f = createFakeHealth();
    f.actions.setWeight("gino", "2026-09-14", 184);
    f.actions.setWeight("gino", "2026-09-14", 183.6);
    f.actions.setWeight("gino", "2026-09-13", 184.2);
    f.actions.setWeight("xinyan", "2026-09-14", 128);
    expect(f.getState().weights.filter((x) => x.person === "gino")).toHaveLength(2);
    expect(f.getState().weights.find((x) => x.person === "gino" && x.date === "2026-09-14")?.weight).toBe(183.6);
    f.actions.deleteWeight("gino", "2026-09-13");
    expect(f.getState().weights.filter((x) => x.person === "gino")).toHaveLength(1);
    f.actions.clearWeights("gino");
    expect(f.getState().weights).toEqual([{ person: "xinyan", date: "2026-09-14", weight: 128 }]);
  });

  it("saved meals and macro targets round-trip", () => {
    const f = createFakeHealth();
    f.actions.addSavedMeal("  ", []);
    const id = f.getState().savedMeals[0].id;
    expect(f.getState().savedMeals[0].name).toBe("Saved meal");
    f.actions.updateSavedMeal(id, "Oats", []);
    expect(f.getState().savedMeals[0].name).toBe("Oats");
    f.actions.deleteSavedMeal(id);
    expect(f.getState().savedMeals).toEqual([]);
    f.actions.setMacroTarget("xinyan", { kcal: 1550, p: 140, c: 145, f: 45 });
    expect(f.getState().macroTargets.xinyan.kcal).toBe(1550);
  });
});

describe("the example history", () => {
  // A Monday. The history is built relative to whatever date it is given.
  const TODAY = new Date(2026, 8, 14, 9, 30);
  const { workouts, routines } = buildWorkoutFixtures(TODAY);
  const gino = workouts.filter((x) => x.person === "gino");
  const xin = workouts.filter((x) => x.person === "xinyan");
  const allSets = (ws: Workout[]) => ws.flatMap((x) => x.exercises.flatMap((e) => e.sets));

  it("has one unfinished session, Gino's, dated two days before today", () => {
    const open = workouts.filter((x) => !x.done);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ person: "gino", date: "2026-09-12" });
    // partly logged: some sets ticked, some still empty rows
    const sets = allSets(open);
    expect(sets.some((s) => s.done)).toBe(true);
    expect(sets.some((s) => !s.done && s.reps === 0 && s.weight === 0)).toBe(true);
  });

  it("moves with the date it is built on", () => {
    const later = buildWorkoutFixtures(new Date(2026, 10, 3)).workouts.filter((x) => !x.done);
    expect(later.map((x) => x.date)).toEqual(["2026-11-01"]);
  });

  it("never has a session dated today or later, and finished Gino sessions stop before the unfinished one", () => {
    expect(workouts.every((x) => x.date < "2026-09-14")).toBe(true);
    expect(gino.filter((x) => x.done).every((x) => x.date < "2026-09-12")).toBe(true);
  });

  it("covers twelve weeks of Gino's four routines, in lb, with the seed routine names", () => {
    const names = new Set(gino.map((x) => x.name));
    expect([...names].sort()).toEqual(["Lower A", "Lower B", "Upper A", "Upper B"]);
    const dates = gino.map((x) => x.date).sort();
    const spanDays = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000;
    expect(spanDays).toBeGreaterThanOrEqual(7 * 11);
    expect(gino.filter((x) => x.done).length).toBeGreaterThanOrEqual(40);
    const seedNames = new Set(SEED_ROUTINES.gino.flatMap((r) => r.exercises.map((e) => e.name)));
    for (const x of gino) for (const e of x.exercises) expect(seedNames).toContain(e.name);
    for (const s of allSets(gino)) expect(Number.isInteger(s.weight) && s.weight >= 0).toBe(true);
  });

  it("progresses slowly: the top leg press weight rises, but by a few steps, not a leap", () => {
    const top = (x: Workout) =>
      Math.max(0, ...x.exercises.filter((e) => e.name === "Leg press").flatMap((e) => e.sets.map((s) => s.weight)));
    const lowerA = gino.filter((x) => x.done && x.name === "Lower A").sort((a, b) => a.date.localeCompare(b.date));
    const first = top(lowerA[0]);
    const last = top(lowerA[lowerA.length - 1]);
    expect(last).toBeGreaterThan(first);
    expect(last - first).toBeLessThanOrEqual(60);
  });

  it("mixes legacy sets (no ids) with newer sets carrying id, done, doneAt and kind, warm-ups included", () => {
    const legacy = gino.filter((x) => allSets([x]).every((s) => !("id" in s) && !("done" in s) && !("kind" in s)));
    expect(legacy.length).toBeGreaterThanOrEqual(4);
    for (const s of allSets(legacy)) expect(Object.keys(s).sort()).toEqual(["reps", "weight"]);
    const newer = allSets(gino.filter((x) => x.done && !legacy.includes(x)));
    expect(newer.every((s) => typeof s.id === "string" && typeof s.done === "boolean" && s.kind)).toBe(true);
    expect(newer.some((s) => s.kind === "warmup" && s.done && typeof s.doneAt === "number")).toBe(true);
    // one set typed in but never ticked — it has numbers and must not count
    expect(newer.some((s) => s.done === false && s.reps > 0)).toBe(true);
    // an old leftover row that was never done
    expect(allSets(legacy).some((s) => s.reps === 0)).toBe(true);
  });

  it("ticked times run forward through a session and fall on its own day", () => {
    for (const x of gino.filter((g) => g.done)) {
      const times = allSets([x]).flatMap((s) => (s.doneAt ? [s.doneAt] : []));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      for (const t of times) {
        const d = new Date(t);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        expect(iso).toBe(x.date);
      }
    }
  });

  it("gives Xinyan walks logged by duration and a home circuit twice a week", () => {
    const walks = xin.filter((x) => x.exercises.length === 1 && x.exercises[0].duration != null);
    expect(walks.length).toBeGreaterThanOrEqual(30);
    expect(walks.every((x) => x.exercises[0].sets.length === 0 && x.exercises[0].duration! > 0)).toBe(true);
    const circuits = xin.filter((x) => x.name === "Home strength");
    expect(circuits.length).toBeGreaterThanOrEqual(20);
    const byWeek = new Map<number, number>();
    for (const c of circuits) {
      const wk = Math.floor((Date.parse("2026-09-14") - Date.parse(c.date)) / (7 * 86400000));
      byWeek.set(wk, (byWeek.get(wk) ?? 0) + 1);
    }
    expect(Math.max(...byWeek.values())).toBe(2);
    const seedNames = new Set(SEED_ROUTINES.xinyan[0].exercises.map((e) => e.name));
    for (const c of circuits) for (const e of c.exercises) expect(seedNames).toContain(e.name);
  });

  it("every exerciseId it uses is a real library row with the same name", () => {
    const byId = new Map(BUNDLED_EXERCISES.map((e) => [e.id, e.name]));
    for (const x of workouts)
      for (const e of x.exercises) if (e.exerciseId) expect(byId.get(e.exerciseId)).toBe(e.name);
  });

  it("ids are unique, and rebuilding gives the same ones", () => {
    const ids = [...workouts.map((x) => x.id), ...workouts.flatMap((x) => x.exercises.map((e) => e.id))];
    const setIds = allSets(workouts).flatMap((s) => (s.id ? [s.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(setIds).size).toBe(setIds.length);
    expect(buildWorkoutFixtures(TODAY).workouts.map((x) => x.id)).toEqual(workouts.map((x) => x.id));
    expect(routines.every((r) => r.person === "gino" && !r.seed)).toBe(true);
  });
});
