// ── The workout tracking engine ──────────────────────────────────────────────
// Sibling to mealLog: pure + local-first. Log sessions (exercises → sets of
// reps × weight), build/save routines, and read progress (volume, this-week
// count, auto-detected PRs). PRs are keyed by exercise NAME so seed / bundled /
// custom exercises all compare cleanly.

import type { Exercise } from "./exerciseData";
import { rowId, todayStr } from "./mealLog";

export type { Exercise };
export type Person = "gino" | "xinyan";

export interface SetEntry {
  reps: number;
  weight: number; // lb; 0 = bodyweight / cardio
}
export interface ExerciseEntry {
  id: string;
  exerciseId: string;
  name: string;
  muscle: string;
  sets: SetEntry[];
  duration?: number; // minutes — for cardio / time-based quick logs (no sets)
}
export interface Workout {
  id: string;
  date: string; // YYYY-MM-DD (local)
  person: Person;
  name: string;
  notes: string;
  exercises: ExerciseEntry[];
  done: boolean; // false = in progress today, true = finished
}
export interface RoutineExercise {
  name: string;
  muscle: string;
  sets: number;
  reps: string; // a target rep range, e.g. "6–8"
}
export interface Routine {
  id: string;
  person: Person;
  name: string;
  meta?: string;
  exercises: RoutineExercise[];
  seed?: boolean;
}

export { rowId, todayStr };

// ── metrics ───────────────────────────────────────────────────────────────────
/** Tonnage: Σ reps × weight (bodyweight sets count their reps). */
export function workoutVolume(w: Workout): number {
  let v = 0;
  for (const ex of w.exercises) for (const s of ex.sets) v += s.weight > 0 ? s.reps * s.weight : s.reps;
  return v;
}
export function totalSets(w: Workout): number {
  return w.exercises.reduce((n, ex) => n + ex.sets.length, 0);
}
/** Total minutes of time-based (cardio / quick) work in a session. */
export function workoutDuration(w: Workout): number {
  return w.exercises.reduce((n, ex) => n + (ex.duration ?? 0), 0);
}
/** Epley estimated 1-rep max — the fair way to compare sets at different reps. */
export function e1RM(weight: number, reps: number): number {
  if (weight <= 0 || reps <= 0) return 0;
  return weight * (1 + reps / 30);
}
export function bestSet(sets: SetEntry[]): { weight: number; reps: number; e1rm: number } {
  let best = { weight: 0, reps: 0, e1rm: 0 };
  for (const s of sets) {
    const e = e1RM(s.weight, s.reps);
    if (e > best.e1rm || (e === 0 && s.reps > best.reps && best.e1rm === 0)) {
      best = { weight: s.weight, reps: s.reps, e1rm: e };
    }
  }
  return best;
}

const nameKey = (s: string) => s.trim().toLowerCase();

export interface PR {
  name: string;
  muscle: string;
  weight: number;
  reps: number;
  e1rm: number;
  date: string;
}
/** Best estimated-1RM set per exercise across all finished workouts. */
export function personalRecords(workouts: Workout[]): PR[] {
  const by = new Map<string, PR>();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const b = bestSet(ex.sets);
      if (b.e1rm <= 0) continue;
      const k = nameKey(ex.name);
      const cur = by.get(k);
      if (!cur || b.e1rm > cur.e1rm) {
        by.set(k, { name: ex.name, muscle: ex.muscle, weight: b.weight, reps: b.reps, e1rm: b.e1rm, date: w.date });
      }
    }
  }
  return [...by.values()].sort((a, b) => b.e1rm - a.e1rm);
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / 86400000);

/** Distinct days trained in the last 7 (today inclusive). */
export function thisWeekCount(workouts: Workout[], today: string): number {
  const days = new Set<string>();
  for (const w of workouts) {
    const d = daysBetween(w.date, today);
    if (d >= 0 && d < 7) days.add(w.date);
  }
  return days.size;
}

// ── persistence (local-first) ──────────────────────────────────────────────────
const wKey = (p: Person) => `hb-workouts-${p}`;
const rKey = (p: Person) => `hb-routines-${p}`;

export function loadWorkouts(person: Person): Workout[] {
  try {
    const raw = localStorage.getItem(wKey(person));
    if (raw) {
      const arr = JSON.parse(raw) as Workout[];
      if (Array.isArray(arr)) return arr;
    }
  } catch {
    /* ignore */
  }
  return [];
}
export function saveWorkouts(person: Person, list: Workout[]): void {
  try {
    localStorage.setItem(wKey(person), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
export function loadRoutines(person: Person): Routine[] {
  try {
    const raw = localStorage.getItem(rKey(person));
    if (raw) {
      const arr = JSON.parse(raw) as Routine[];
      if (Array.isArray(arr)) return [...SEED_ROUTINES[person], ...arr];
    }
  } catch {
    /* ignore */
  }
  return [...SEED_ROUTINES[person]];
}
export function saveRoutines(person: Person, custom: Routine[]): void {
  // only persist the user's own routines; seeds are code-defined
  try {
    localStorage.setItem(rKey(person), JSON.stringify(custom.filter((r) => !r.seed)));
  } catch {
    /* ignore */
  }
}

// ── exercise search ─────────────────────────────────────────────────────────────
export function searchExercises(query: string, library: Exercise[], limit = 40): Exercise[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: { e: Exercise; s: number }[] = [];
  for (const e of library) {
    const n = e.name.toLowerCase();
    if (!tokens.every((tk) => n.includes(tk) || e.muscle.includes(tk) || e.equipment.includes(tk))) continue;
    let s: number;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 85;
    else if (n.startsWith(tokens[0])) s = 70;
    else s = 55;
    s -= n.length * 0.03;
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.e);
}

// ── seed routines (Gino's 4-day Upper/Lower; Xinyan's home circuit) ─────────────
const R = (name: string, muscle: string, sets: number, reps: string): RoutineExercise => ({ name, muscle, sets, reps });

export const SEED_ROUTINES: Record<Person, Routine[]> = {
  gino: [
    {
      id: "seed-gino-upper-a", person: "gino", seed: true, name: "Upper A", meta: "push-bias · ~12 sets",
      exercises: [
        R("Incline dumbbell press", "chest", 3, "6–8"),
        R("Chest-supported row", "back", 3, "8–10"),
        R("Seated dumbbell shoulder press", "shoulders", 2, "8–10"),
        R("Cable lateral raise", "shoulders", 2, "12–15"),
        R("Triceps pushdown", "arms", 2, "10–12"),
      ],
    },
    {
      id: "seed-gino-lower-a", person: "gino", seed: true, name: "Lower A", meta: "quad-bias · ~12 sets",
      exercises: [
        R("Leg press", "legs", 4, "6–10"),
        R("Romanian deadlift", "legs", 3, "8–10"),
        R("Dumbbell split squat", "legs", 2, "10–12"),
        R("Standing calf raise", "legs", 3, "12–15"),
      ],
    },
    {
      id: "seed-gino-upper-b", person: "gino", seed: true, name: "Upper B", meta: "pull-bias · ~13 sets",
      exercises: [
        R("Pull-up", "back", 3, "6–10"),
        R("Flat dumbbell press", "chest", 3, "8–10"),
        R("One-arm dumbbell row", "back", 3, "10–12"),
        R("Face pull", "shoulders", 2, "12–15"),
        R("Dumbbell hammer curl", "arms", 2, "10–12"),
      ],
    },
    {
      id: "seed-gino-lower-b", person: "gino", seed: true, name: "Lower B", meta: "posterior-bias · ~13 sets",
      exercises: [
        R("Leg press", "legs", 3, "10–15"),
        R("Romanian deadlift", "legs", 3, "8–10"),
        R("Walking lunge", "legs", 2, "10–12"),
        R("Standing calf raise", "legs", 3, "12–15"),
        R("Plank", "core", 2, "1 set"),
      ],
    },
  ],
  xinyan: [
    {
      id: "seed-xin-home", person: "xinyan", seed: true, name: "Home strength", meta: "2×/week · ~15 min",
      exercises: [
        R("Bodyweight squat", "legs", 2, "10–15"),
        R("Incline push-up", "chest", 2, "8–12"),
        R("Band row", "back", 2, "12–15"),
        R("Glute bridge", "legs", 2, "12–15"),
        R("Plank", "core", 2, "1 set"),
      ],
    },
    {
      id: "seed-xin-walk", person: "xinyan", seed: true, name: "Steps", meta: "your main exercise",
      exercises: [R("Walking", "cardio", 1, "~8,000 steps")],
    },
  ],
};
