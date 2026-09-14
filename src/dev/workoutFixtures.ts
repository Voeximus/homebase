// ── ?workoutlab example history ──────────────────────────────────────────────
// Twelve weeks of the two real training patterns, built fresh at load so every
// date sits relative to TODAY — a fixed calendar would slide out of "this week"
// and "last 7 days" within a week and leave the Progress screen showing zeros.
//
// Every oddity here is one the real tables carry, because the screens have to
// stay honest on them:
//   • LEGACY sessions (the first five weeks of Gino's, six of Xinyan's): sets
//     are bare { reps, weight } with no id / done / kind, exercises came from a
//     routine so exerciseId is "", a planned set that was never done is still a
//     { reps: 0, weight: 0 } row, and one light first set was logged as an
//     ordinary set because the old app had no warm-ups.
//   • NEWER sessions: per-set id, done, doneAt, kind — with warm-ups on the big
//     lifts — plus one set that was typed in but never ticked.
//   • ONE unfinished Gino session from two days ago, which is what the
//     stale-session banner exists for.
// Plank holds are stored as seconds in `reps`, the way the old app took them;
// v1 has no seconds field. Weights are lb, whole numbers, like the old inputs.
// Pure data — no React, no store, nothing that can reach the network.

import { isoDate } from "../lib/format";
import type { ExerciseEntry, Routine, SetEntry, Workout } from "../lib/workoutLog";

export interface WorkoutFixtures {
  workouts: Workout[];
  routines: Routine[]; // custom only, like the store; the seeds come from code
}

// Library ids for the seed names the bundled library carries word for word. The
// rest ("Incline dumbbell press", "Band row" …) have no row, or only an alias —
// the case the name-then-alias lookup exists for. Newer sessions carry these;
// legacy ones started from a routine, which never set an id.
const LIB_ID: Record<string, string> = {
  "Triceps pushdown": "ex-triceps-pushdown",
  "Face pull": "ex-face-pull",
  "One-arm dumbbell row": "ex-one-arm-dumbbell-row",
  "Pull-up": "ex-pull-up",
  "Romanian deadlift": "ex-romanian-deadlift",
  "Walking": "ex-walking",
  "Incline push-up": "ex-incline-push-up",
  "Plank": "ex-plank",
  "Bodyweight squat": "ex-bodyweight-squat",
  "Glute bridge": "ex-glute-bridge",
  "Leg press": "ex-leg-press",
  "Standing calf raise": "ex-standing-calf-raise",
  "Walking lunge": "ex-walking-lunge",
  "Cable lateral raise": "ex-cable-lateral-raise",
  "Seated dumbbell shoulder press": "ex-seated-dumbbell-shoulder-press",
};

interface Lift {
  name: string;
  muscle: string;
  sets: number;
  lo: number; // the routine's rep range (seconds for a hold)
  hi: number;
  start: number; // lb at the first session; 0 = bodyweight
  step: number; // lb added once the top of the range is reached
  hold?: boolean; // a timed hold: `reps` carries seconds
  warm?: [fraction: number, reps: number][]; // warm-ups, as a share of the working weight
}

// Names, muscles and set counts match SEED_ROUTINES exactly.
const GINO: { name: string; lifts: Lift[] }[] = [
  {
    name: "Upper A",
    lifts: [
      { name: "Incline dumbbell press", muscle: "chest", sets: 3, lo: 6, hi: 8, start: 50, step: 5, warm: [[0.5, 10]] },
      { name: "Chest-supported row", muscle: "back", sets: 3, lo: 8, hi: 10, start: 55, step: 5 },
      { name: "Seated dumbbell shoulder press", muscle: "shoulders", sets: 2, lo: 8, hi: 10, start: 35, step: 5 },
      { name: "Cable lateral raise", muscle: "shoulders", sets: 2, lo: 12, hi: 15, start: 15, step: 5 },
      { name: "Triceps pushdown", muscle: "arms", sets: 2, lo: 10, hi: 12, start: 45, step: 5 },
    ],
  },
  {
    name: "Lower A",
    lifts: [
      { name: "Leg press", muscle: "legs", sets: 4, lo: 6, hi: 10, start: 270, step: 20, warm: [[0.35, 10], [0.65, 5]] },
      { name: "Romanian deadlift", muscle: "legs", sets: 3, lo: 8, hi: 10, start: 155, step: 10, warm: [[0.6, 8]] },
      { name: "Dumbbell split squat", muscle: "legs", sets: 2, lo: 10, hi: 12, start: 25, step: 5 },
      { name: "Standing calf raise", muscle: "legs", sets: 3, lo: 12, hi: 15, start: 140, step: 10 },
    ],
  },
  {
    name: "Upper B",
    lifts: [
      { name: "Pull-up", muscle: "back", sets: 3, lo: 6, hi: 10, start: 0, step: 0 },
      { name: "Flat dumbbell press", muscle: "chest", sets: 3, lo: 8, hi: 10, start: 55, step: 5, warm: [[0.5, 10]] },
      { name: "One-arm dumbbell row", muscle: "back", sets: 3, lo: 10, hi: 12, start: 55, step: 5 },
      { name: "Face pull", muscle: "shoulders", sets: 2, lo: 12, hi: 15, start: 35, step: 5 },
      { name: "Dumbbell hammer curl", muscle: "arms", sets: 2, lo: 10, hi: 12, start: 25, step: 5 },
    ],
  },
  {
    name: "Lower B",
    lifts: [
      { name: "Leg press", muscle: "legs", sets: 3, lo: 10, hi: 15, start: 230, step: 20, warm: [[0.4, 12]] },
      { name: "Romanian deadlift", muscle: "legs", sets: 3, lo: 8, hi: 10, start: 145, step: 10 },
      { name: "Walking lunge", muscle: "legs", sets: 2, lo: 10, hi: 12, start: 20, step: 5 },
      { name: "Standing calf raise", muscle: "legs", sets: 3, lo: 12, hi: 15, start: 130, step: 10 },
      { name: "Plank", muscle: "core", sets: 2, lo: 40, hi: 60, start: 0, step: 0, hold: true },
    ],
  },
];

const XINYAN: Lift[] = [
  { name: "Bodyweight squat", muscle: "legs", sets: 2, lo: 10, hi: 15, start: 0, step: 0 },
  { name: "Incline push-up", muscle: "chest", sets: 2, lo: 8, hi: 12, start: 0, step: 0 },
  { name: "Band row", muscle: "back", sets: 2, lo: 12, hi: 15, start: 0, step: 0 },
  { name: "Glute bridge", muscle: "legs", sets: 2, lo: 12, hi: 15, start: 0, step: 0 },
  { name: "Plank", muscle: "core", sets: 2, lo: 20, hi: 45, start: 0, step: 0, hold: true },
];

const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

/** Working weight and the reps of each working set at this lift's n-th session.
 *  Double progression: the top set climbs a rep a session through the range,
 *  then the weight goes up a step and the reps start low again. Later sets fade
 *  a rep or two. Bodyweight work climbs reps only, and more slowly. */
function prescribe(l: Lift, n: number): { weight: number; reps: number[] } {
  if (l.hold) {
    const top = Math.min(l.hi, l.lo + 5 * Math.floor(n / 2));
    return { weight: 0, reps: Array.from({ length: l.sets }, (_, i) => Math.max(10, top - 5 * i)) };
  }
  const width = l.hi - l.lo + 1;
  const weighted = l.start > 0;
  const top = weighted ? l.lo + (n % width) : Math.min(l.hi, l.lo + Math.floor(n / 3));
  const weight = weighted ? l.start + l.step * Math.floor(n / width) : 0;
  const bad = n === 6 ? 1 : 0; // one flat session mid-block, as happens
  const reps = Array.from({ length: l.sets }, (_, i) => {
    const drop = Math.floor((i + (n % 2)) / 2) + (i >= 3 ? 1 : 0);
    return Math.max(3, top - drop - bad);
  });
  return { weight, reps };
}

/** Local wall-clock instant on a date, in ms — the doneAt spelling. */
const at = (date: Date, h: number, m: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m).getTime();

export function buildWorkoutFixtures(now: Date = new Date()): WorkoutFixtures {
  // Counters live per build, so rebuilding (the lab's reset) gives the same ids.
  let seq = 0;
  const id = (p: string) => `fx-${p}${(++seq).toString(36)}`;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const addDays = (d: Date, k: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
  const todayIso = isoDate(today);
  const stale = addDays(today, -2);
  const staleIso = isoDate(stale);
  // Week 11 is the week holding the unfinished session; week 0 is eleven before.
  const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
  const week0 = addDays(monday(stale), -77);

  const workouts: Workout[] = [];
  const done: Record<string, number> = {}; // sessions so far, per routine + lift

  // ── Gino: Upper A Mon · Lower A Tue · Upper B Thu · Lower B Sat ─────────────
  const G_DAYS: [dayOffset: number, routine: number, h: number, m: number][] = [
    [0, 0, 17, 30],
    [1, 1, 17, 40],
    [3, 2, 17, 20],
    [5, 3, 10, 15],
  ];
  // A skipped Thursday, and a busy week that only got its Monday in.
  const skipped = (wk: number, routine: number) => (wk === 5 && routine === 2) || (wk === 8 && routine !== 0);

  const liftEntry = (
    l: Lift,
    routine: string,
    clock: { t: number },
    shape: "legacy" | "new",
  ): ExerciseEntry => {
    const key = `${routine}|${l.name}`;
    const n = done[key] ?? 0;
    done[key] = n + 1;
    const p = prescribe(l, n);
    const sets: SetEntry[] = [];
    if (shape === "legacy") {
      for (const r of p.reps) sets.push({ reps: r, weight: p.weight });
    } else {
      for (const [f, r] of l.warm ?? []) {
        sets.push({ id: id("s"), reps: r, weight: round5(p.weight * f), done: true, doneAt: (clock.t += 75_000), kind: "warmup" });
      }
      p.reps.forEach((r, i) => {
        clock.t += 140_000 + ((n + i) % 3) * 20_000;
        sets.push({ id: id("s"), reps: r, weight: p.weight, done: true, doneAt: clock.t, kind: "working" });
      });
    }
    clock.t += 120_000; // walking to the next station
    return {
      id: id("e"),
      exerciseId: shape === "new" ? LIB_ID[l.name] ?? "" : "",
      name: l.name,
      muscle: l.muscle,
      sets,
    };
  };

  let lastRoutine = -1;
  for (let wk = 0; wk < 12; wk++) {
    for (const [off, ri, h, m] of G_DAYS) {
      const date = addDays(week0, wk * 7 + off);
      const iso = isoDate(date);
      if (iso >= staleIso || skipped(wk, ri)) continue;
      const r = GINO[ri];
      const shape = wk < 5 ? "legacy" : "new";
      const clock = { t: at(date, h, m) };
      const exercises = r.lifts.map((l) => liftEntry(l, r.name, clock, shape));
      if (shape === "legacy") {
        // The old app's leftovers: a routine set that never happened stays as a
        // zero row, and a light opener went in as an ordinary set.
        if (wk === 2 && r.name === "Lower A") exercises[3].sets.push({ reps: 0, weight: 0 });
        if (wk === 3 && r.name === "Lower A") exercises[0].sets.unshift({ reps: 10, weight: 135 });
      } else if (wk === 11 && r.name === "Lower A") {
        // Typed in, never ticked — must not count as done.
        const last = exercises[3].sets[exercises[3].sets.length - 1];
        last.done = false;
        delete last.doneAt;
      }
      workouts.push({
        id: id("w-gino-"),
        date: iso,
        person: "gino",
        name: r.name,
        notes: wk === 7 && r.name === "Lower B" ? "Left knee a bit sore, went lighter on lunges" : "",
        exercises,
        done: true,
      });
      lastRoutine = ri;
    }
  }

  // ── Gino's unfinished session, two days ago: the next routine in rotation,
  // abandoned partway through its second exercise.
  {
    const r = GINO[(lastRoutine + 1) % GINO.length];
    const clock = { t: at(stale, 18, 5) };
    const exercises = r.lifts.map((l, i) => {
      const e = liftEntry(l, r.name, clock, "new");
      if (i === 0) return e; // finished whole
      // The second exercise got its warm-ups and one working set ticked; the
      // rest are the empty rows the routine laid out.
      let ticked = i === 1 ? 1 : 0;
      e.sets = e.sets.flatMap((s): SetEntry[] => {
        if (s.kind === "warmup") return i === 1 ? [s] : [];
        if (ticked-- > 0) return [s];
        return [{ id: s.id, reps: 0, weight: 0, done: false, kind: "working" }];
      });
      return e;
    });
    workouts.push({ id: id("w-gino-"), date: staleIso, person: "gino", name: r.name, notes: "", exercises, done: false });
  }

  // ── Xinyan: home circuit Wed + Sun, walks Mon · Tue · Fri (+ Sat every other week)
  for (let wk = 0; wk < 12; wk++) {
    const legacy = wk < 6;
    for (const off of [2, 6]) {
      const date = addDays(week0, wk * 7 + off);
      const iso = isoDate(date);
      if (iso >= todayIso || (wk === 3 && off === 2)) continue;
      const clock = { t: at(date, 19, 10) };
      const exercises = XINYAN.map((l) => liftEntry(l, "Home strength", clock, legacy ? "legacy" : "new"));
      workouts.push({ id: id("w-xin-"), date: iso, person: "xinyan", name: "Home strength", notes: "", exercises, done: true });
    }
    const walks: [number, number][] = [[0, 30], [1, 40], [4, 45]];
    if (wk % 2 === 0) walks.push([5, 35]);
    for (const [off, min] of walks) {
      const date = addDays(week0, wk * 7 + off);
      const iso = isoDate(date);
      if (iso >= todayIso) continue;
      // Older walks came from the quick-log "Walk" chip (no library id); newer
      // ones were picked from search as "Walking". Same activity, two names.
      const name = legacy ? "Walk" : "Walking";
      workouts.push({
        id: id("w-xin-"),
        date: iso,
        person: "xinyan",
        name,
        notes: "",
        exercises: [
          { id: id("e"), exerciseId: legacy ? "" : LIB_ID.Walking, name, muscle: "cardio", sets: [], duration: min + (wk % 3) * 5 },
        ],
        done: true,
      });
    }
  }

  const routines: Routine[] = [
    {
      id: "fx-routine-gino-arms",
      person: "gino",
      name: "Arms and core",
      meta: "",
      exercises: [
        { name: "Dumbbell hammer curl", muscle: "arms", sets: 3, reps: "10–12" },
        { name: "Triceps pushdown", muscle: "arms", sets: 3, reps: "10–12" },
        { name: "Plank", muscle: "core", sets: 2, reps: "1 set" },
      ],
    },
  ];

  // Newest first, the order the real store holds them in.
  workouts.sort((a, b) => b.date.localeCompare(a.date));
  return { workouts, routines };
}
