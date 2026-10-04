import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { notesFor } from "../src/lib/evidence";
import { BUNDLED_EXERCISES, type Exercise } from "../src/lib/exerciseData";
import { REGIONS } from "../src/lib/muscleRegions";
import { todayStr, type ExerciseEntry, type SetEntry, type Workout } from "../src/lib/workoutLog";
import { ExerciseDetail } from "../src/views/workout/ExerciseDetail";
import { ProgressTab } from "../src/views/workout/ProgressTab";
import { StudyNoteList } from "../src/views/workout/StudyNotes";
import {
  categoryLabel,
  dayLabel,
  filterLibrary,
  fmtSets,
  groupByArea,
  libraryLine,
  ownNoteCount,
  progressRows,
  regionsOf,
  sessionsWith,
  setsText,
} from "../src/views/workout/viewHelpers";

// The exercise page, the Exercises tab and the Progress tab. What can go wrong
// silently: an old routine's name finds nothing in search, a merged duplicate shows
// twice, the hard-set list is ordered by something other than the count, "your last
// 3 sessions" includes the other person or an unfinished workout, and the study
// notes lose their exact wording or open their sources by default.
// vitest runs in node (no jsdom), so components are checked as static markup —
// effects never run there, which is also how the lazy notes are seen "still loading".

const LIB = BUNDLED_EXERCISES;
const ex = (name: string): Exercise => {
  const e = LIB.find((x) => x.name === name);
  if (!e) throw new Error(`no exercise "${name}"`);
  return e;
};

let seq = 0;
const set = (weight: number, reps: number, extra: Partial<SetEntry> = {}): SetEntry => ({ weight, reps, done: true, ...extra });
const entry = (name: string, sets: SetEntry[], extra: Partial<ExerciseEntry> = {}): ExerciseEntry => ({
  id: `e${++seq}`,
  exerciseId: "",
  name,
  muscle: "",
  sets,
  ...extra,
});
const workout = (date: string, exercises: ExerciseEntry[], extra: Partial<Workout> = {}): Workout => ({
  id: `w${++seq}`,
  date,
  person: "gino",
  name: "Upper A",
  notes: "",
  exercises,
  done: true,
  ...extra,
});

describe("filterLibrary", () => {
  it("finds an exercise by an alias an old routine used", () => {
    const names = filterLibrary(LIB, "chest-supported row", "All").map((e) => e.name);
    expect(names).toContain("Chest-supported dumbbell row");
  });

  it("needs every typed word, in the name or an alias", () => {
    const names = filterLibrary(LIB, "hammer dumbbell", "All").map((e) => e.name);
    expect(names).toEqual(["Hammer curl"]); // only via its alias "Dumbbell hammer curl"
  });

  it("never shows a merged near-duplicate", () => {
    const names = filterLibrary(LIB, "burpee", "All").map((e) => e.name);
    expect(names).toContain("Burpee");
    expect(names).not.toContain("Burpees");
  });

  it("filters by the body-area chip and sorts by name", () => {
    const cardio = filterLibrary(LIB, "", "Cardio");
    expect(cardio.length).toBeGreaterThan(0);
    expect(cardio.every((e) => e.muscle === "cardio")).toBe(true);
    const names = cardio.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("groups the browse view by area, full body last, no empty groups", () => {
    const groups = groupByArea(filterLibrary(LIB, "", "All"));
    expect(groups.map((g) => g.label)).toEqual(["Chest", "Back", "Shoulders", "Arms", "Core", "Legs", "Cardio", "Full body"]);
    const shown = groups.reduce((n, g) => n + g.items.length, 0);
    expect(shown).toBe(LIB.filter((e) => !e.hidden).length);
  });

  it("writes the row line from the main muscles", () => {
    expect(libraryLine(ex("Lat pulldown"))).toBe("Main: Lats · cable");
    expect(libraryLine(ex("Rowing machine"))).toBe("cardio · machine");
  });
});

describe("regions and study-note labels", () => {
  it("never lists a main muscle again as a helper", () => {
    const fake: Exercise = { ...ex("Lat pulldown"), primary: ["lats", "biceps"], secondary: ["biceps", "nope", "traps_mid"] };
    expect(regionsOf(fake)).toEqual({ primary: ["lats", "biceps"], secondary: ["traps_mid"] });
    expect(regionsOf(undefined)).toEqual({ primary: [], secondary: [] });
  });

  it("names the category a category note is about", () => {
    const band = ex("Band row");
    const bandNote = notesFor(band).find((n) => n.attach === "category")!;
    expect(categoryLabel(band, bandNote)).toBe("About all band exercises");
    const plank = ex("Plank");
    const coreNote = notesFor(plank).find((n) => n.attach === "category")!;
    expect(categoryLabel(plank, coreNote)).toBe("About all core exercises");
  });

  it("counts only notes about this exercise or a close variation on list rows", () => {
    const notes = notesFor(ex("Band row"));
    expect(notes.some((n) => n.attach === "category")).toBe(true);
    expect(ownNoteCount(notes)).toBe(notes.filter((n) => n.attach !== "category").length);
  });
});

describe("progressRows", () => {
  it("orders by count, then body order, and hides muscles with no sets", () => {
    const { rows, hidden, scale } = progressRows({ lats: 6, biceps: 3, chest_upper: 6, traps_mid: 0 }, false);
    expect(rows.map((r) => r.id)).toEqual(["chest_upper", "lats", "biceps"]); // chest_upper comes first in REGIONS
    expect(hidden).toBe(REGIONS.length - 3);
    expect(scale).toBe(20);
    expect(rows[0].pct).toBe(30);
    expect(rows[2].band).toBe("Below the lowest band in the studies");
  });

  it("scales to the top value once it passes 20, and shows every muscle when asked", () => {
    const { rows, hidden, scale } = progressRows({ quads_vasti: 25, glute_max: 12.5 }, true);
    expect(scale).toBe(25);
    expect(hidden).toBe(0);
    expect(rows).toHaveLength(REGIONS.length);
    expect(rows[0]).toMatchObject({ id: "quads_vasti", pct: 100 });
    expect(rows[1]).toMatchObject({ id: "glute_max", pct: 50 });
    expect(rows.at(-1)).toMatchObject({ value: 0, band: "None" });
  });

  it("formats half sets", () => {
    expect(fmtSets(7.5)).toBe("7.5");
    expect(fmtSets(8)).toBe("8");
  });
});

describe("sessionsWith", () => {
  const row = "Chest-supported dumbbell row";
  const workouts: Workout[] = [
    workout("2026-09-01", [entry("Chest-supported row", [set(50, 10)])]),
    workout("2026-09-04", [entry(row, [set(30, 8, { kind: "warmup" }), set(55, 10), set(55, 9)])]),
    workout("2026-09-06", [entry(row, [set(60, 8)])], { person: "xinyan" }),
    workout("2026-09-07", [entry(row, [set(60, 8)])], { done: false }),
    workout("2026-09-08", [entry(row, [set(55, 10, { done: false })])]), // nothing ticked
    workout("2026-09-10", [entry("chest supported rows", [set(60, 8), set(60, 7)])]),
    workout("2026-09-11", [entry(row, [set(65, 6)])]),
  ];

  it("returns the person's last 3 finished sessions that did something, newest first", () => {
    const s = sessionsWith(workouts, "gino", row, LIB);
    expect(s.map((x) => x.date)).toEqual(["2026-09-11", "2026-09-10", "2026-09-04"]);
  });

  it("keeps warm-ups out of the set line but counts them", () => {
    const s = sessionsWith(workouts, "gino", row, LIB, 10).find((x) => x.date === "2026-09-04")!;
    expect(setsText(s.working)).toBe("55×10 · 55×9");
    expect(s.warmups).toBe(1);
  });

  it("matches an old alias spelling", () => {
    const s = sessionsWith(workouts, "gino", row, LIB, 10);
    expect(s.map((x) => x.date)).toContain("2026-09-01");
  });

  it("shows bodyweight sets as reps", () => {
    expect(setsText([set(0, 12), set(22.5, 5)])).toBe("12 reps · 22.5×5");
  });
});

describe("dayLabel", () => {
  it("reads as weekday, day, month", () => {
    expect(dayLabel("2026-09-08")).toBe("Tue 8 Sep");
    expect(dayLabel("2026-09-14")).toBe("Mon 14 Sep");
  });
});

describe("StudyNoteList", () => {
  const render = (e: Exercise, notes = notesFor(e)) =>
    renderToStaticMarkup(createElement(StudyNoteList, { exercise: e, notes }));

  it("shows two notes word for word, then Show more", () => {
    const squat = ex("Barbell back squat");
    const notes = notesFor(squat);
    expect(notes.length).toBeGreaterThan(2);
    const html = render(squat);
    expect(html.match(/data-note="/g)).toHaveLength(2);
    expect(html).toContain(notes[0].id);
    expect(html).toContain("Show more");
    // React escapes only &, <, >, " and ' — compare against the same escaping
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    expect(html).toContain(esc(notes[0].text));
  });

  it("marks the grade by shape and words, and keeps sources closed", () => {
    const html = render(ex("Barbell back squat"));
    expect(html).toContain("■");
    expect(html).toContain("Tested over weeks");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toContain('target="_blank"');
  });

  it("says when a note was tested on a similar exercise", () => {
    const html = render(ex("Overhead triceps extension"));
    expect(html).toContain("Tested on a similar exercise, not this one.");
  });

  it("uses the exact no-notes wording", () => {
    const html = render(ex("Lat pulldown"), []);
    expect(html).toContain(
      "No study notes for this exercise yet. The muscles shown come from anatomy, not from a study of this exercise.",
    );
    expect(html).not.toContain("Show more");
  });

  it("drops the sentence about the muscles shown when the page shows none (cardio)", () => {
    const html = renderToStaticMarkup(createElement(StudyNoteList, { exercise: ex("Walking"), notes: [], hasMuscles: false }));
    expect(html).toContain("No study notes for this exercise yet.");
    expect(html).not.toContain("muscles shown");
  });
});

describe("ExerciseDetail", () => {
  const detail = (name: string, workouts: Workout[] = []) =>
    renderToStaticMarkup(createElement(ExerciseDetail, { name, person: "gino", library: LIB, workouts, onBack: () => {} }));

  it("shows the map, the main and helper line, and study notes for a library exercise", () => {
    const html = detail("Barbell back squat");
    expect(html).toContain("data-region=");
    expect(html).toContain("<b class=\"font-[650]\">Main:</b> Rest of quads, Glute max, Adductors");
    expect(html).toContain("Helps:</b> Lower back");
    expect(html).toContain("What studies found");
    expect(html).toContain("Your numbers");
    expect(html).toContain("You haven&#x27;t logged this yet.");
  });

  it("for an exercise the person added: no map, the fixed no-notes line, still their numbers", () => {
    const html = detail("Grandma's sandbag carry", [workout("2026-09-10", [entry("Grandma's sandbag carry", [set(80, 5), set(80, 5)])])]);
    expect(html).toContain("You added this exercise, so there is no muscle map for it.");
    expect(html).not.toContain("data-region=");
    expect(html).toContain("What studies found");
    // no map on this page, so no sentence about "the muscles shown"
    expect(html).toContain("No study notes for this exercise yet.");
    expect(html).not.toContain("The muscles shown come from anatomy");
    expect(html).toContain("Your numbers");
    expect(html).toContain("80×5 · 80×5");
    expect(html).toContain("Thu 10 Sep");
  });
});

describe("ProgressTab", () => {
  it("lists trained muscles biggest first and counts sets with no muscle detail", () => {
    const today = todayStr();
    const workouts = [
      workout(today, [
        entry("Lat pulldown", [set(120, 10), set(120, 10), set(120, 9), set(60, 12, { kind: "warmup" })]),
        entry("Grandma's sandbag carry", [set(80, 5), set(80, 5)]),
      ]),
    ];
    const html = renderToStaticMarkup(
      createElement(ProgressTab, { person: "gino", workouts, library: LIB, onOpenExercise: () => {} }),
    );
    const order = [...html.matchAll(/data-region="(\w+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("lats"); // 3 sets as a main muscle; warm-up left out
    expect(order).toContain("biceps"); // helpers at 1.5
    expect(html).toContain("Sets with no muscle detail: 2");
    expect(html).toContain("Show all muscles");
  });
});
