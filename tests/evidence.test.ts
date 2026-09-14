import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDY_NOTES, notesFor, type Grade } from "../src/lib/evidence";
import { BUNDLED_EXERCISES, type Exercise } from "../src/lib/exerciseData";
import register from "../docs/research/workout-mode/evidence.json";
import { buildEvidence, OUT } from "../scripts/evidence/build.mjs";

interface Source { citation: string; url: string; citeInApp?: boolean }
interface ShowOn { exercise?: string; category?: string; help?: string; as?: string; ifPresent?: boolean }
interface Claim { id: string; correctGrade: string; correctedClaim: string; sources: Source[]; showOn?: ShowOn[] }

const kept = register.kept as Claim[];
const keptById = new Map(kept.map((c) => [c.id, c]));
const droppedIds = register.dropped.map((d) => d.id);

const ex = (name: string): Exercise => {
  const e = BUNDLED_EXERCISES.find((x) => x.name === name);
  if (!e) throw new Error(`no exercise "${name}"`);
  return e;
};
const ids = (name: string) => notesFor(ex(name)).map((n) => n.id);
const attachOf = (name: string, id: string) => notesFor(ex(name)).find((n) => n.id === id)?.attach;

// A dropped id as a whole token: "E5" in a string or comment, but not "#E5E7EB" or an SVG
// path command like "L1 2".
const mentions = (text: string, id: string) =>
  new RegExp(`(?<![A-Za-z0-9_#.-])${id.replace(/[-]/g, "\\-")}(?![A-Za-z0-9_.-])(?![\\s,]*-?\\d)`).test(text);

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));

describe("dropped claims", () => {
  it("the scanner finds a real mention and ignores colours and path data", () => {
    expect(mentions(`const id = "E5";`, "E5")).toBe(true);
    expect(mentions(`// see R3`, "R3")).toBe(true);
    expect(mentions(`x lateral-raise-thumbs-down-myth y`, "lateral-raise-thumbs-down-myth")).toBe(true);
    expect(mentions(`color: #E5E7EB;`, "E5")).toBe(false);
    expect(mentions(`d="M0 0 L1 2"`, "L1")).toBe(false);
    expect(mentions(`"L12"`, "L1")).toBe(false);
  });

  it("appear nowhere in src/", () => {
    expect(droppedIds).toEqual(["lateral-raise-thumbs-down-myth", "E5", "R3", "L1"]);
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const id of droppedIds) if (mentions(text, id)) hits.push(`${id} in ${file}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("evidence.ts content", () => {
  it("holds only kept claims, with correctedClaim word for word and correctGrade", () => {
    expect(STUDY_NOTES.length).toBeGreaterThan(0);
    for (const n of STUDY_NOTES) {
      const c = keptById.get(n.id);
      expect(c, n.id).toBeDefined();
      expect(n.text, n.id).toBe(c!.correctedClaim);
      expect(n.grade, n.id).toBe(c!.correctGrade);
    }
    expect(new Set(STUDY_NOTES.map((n) => n.id)).size).toBe(STUDY_NOTES.length);
  });

  it("never carries a source marked citeInApp:false, and nothing else is added", () => {
    for (const n of STUDY_NOTES) {
      const expected = keptById.get(n.id)!.sources
        .filter((s) => s.citeInApp !== false)
        .map((s) => ({ citation: s.citation, url: s.url }));
      expect(n.sources, n.id).toEqual(expected);
    }
    const hidden = kept.flatMap((c) => c.sources.filter((s) => s.citeInApp === false).map((s) => s.citation));
    expect(hidden.length).toBeGreaterThan(0);
    const shown = new Set(STUDY_NOTES.flatMap((n) => n.sources.map((s) => s.citation)));
    for (const citation of hidden) expect(shown.has(citation), citation).toBe(false);
  });

  it("includes exactly the kept claims that reach an exercise page", () => {
    const labels = new Set(BUNDLED_EXERCISES.flatMap((e) => [e.name, ...(e.aliases ?? [])]));
    const expected = kept
      .filter((c) => (c.showOn ?? []).some((s) => (s.exercise && labels.has(s.exercise)) || s.category))
      .map((c) => c.id);
    expect(STUDY_NOTES.map((n) => n.id)).toEqual(expected);
    // help-sheet-only claims and training formulas stay out
    for (const id of ["light-load-to-failure", "lengthened-partials-general", "regional-growth-general", "E1", "formula-6"]) {
      expect(STUDY_NOTES.some((n) => n.id === id), id).toBe(false);
    }
  });

  it("is up to date with the register and the library", () => {
    const built = buildEvidence();
    expect(built.errors).toEqual([]);
    expect(readFileSync(OUT, "utf8").replace(/\r\n/g, "\n")).toBe(built.source);
  });

  it("fails the build when a showOn exercise is not in the library, unless ifPresent", () => {
    const edited = {
      ...register,
      kept: [
        { ...kept[0], showOn: [{ exercise: "Sky squat", as: "this" }] },
        { ...kept[1], showOn: [{ exercise: "Moon squat", as: "this", ifPresent: true }] },
      ],
    };
    const { errors, notes } = buildEvidence(edited);
    expect(errors).toEqual([`${kept[0].id}: showOn exercise "Sky squat" is not in the library`]);
    expect(notes).toEqual([]);
  });
});

describe("notesFor", () => {
  const RANK: Record<Grade, number> = { A: 0, B: 1, C: 2 };

  it("returns A, then B, then C for every exercise", () => {
    for (const e of BUNDLED_EXERCISES) {
      const grades = notesFor(e).map((n) => RANK[n.grade]);
      expect(grades, e.name).toEqual([...grades].sort((a, b) => a - b));
    }
  });

  it("attaches every note to at least one library exercise", () => {
    const reached = new Set(BUNDLED_EXERCISES.flatMap((e) => notesFor(e).map((n) => n.id)));
    for (const n of STUDY_NOTES) expect(reached.has(n.id), n.id).toBe(true);
  });

  it("gives the back squat its own claims, all as 'this'", () => {
    const notes = notesFor(ex("Barbell back squat"));
    expect(notes.map((n) => n.id).sort()).toEqual(
      ["glute-medius-little-growth", "hipthrust-emg-numbers", "hipthrust-vs-squat-glutes", "squat-depth-glutes", "squat-depth-quads", "squat-no-hamstrings", "squat-rectus-femoris"],
    );
    expect(notes.every((n) => n.attach === "this")).toBe(true);
    expect(notes.at(-1)?.grade).toBe("B");
  });

  it("marks similar-exercise claims as variation and skips ifPresent names that are not in the library", () => {
    expect(attachOf("Standing calf raise", "standing-vs-seated-calf")).toBe("this");
    expect(attachOf("Standing calf raise", "calf-stretched-half")).toBe("variation");
    expect(attachOf("Dumbbell calf raise", "calf-toe-direction")).toBe("variation");
    expect(attachOf("Push-up", "band-pushup-strength")).toBe("variation");
  });

  it("attaches category claims by band equipment/mode and by core muscle", () => {
    expect(attachOf("Band row", "band-row-anatomy")).toBe("this");
    expect(attachOf("Band row", "bands-vs-weights-strength")).toBe("category");
    expect(attachOf("Resistance band chest press", "band-colour-not-weight")).toBe("category");
    expect(attachOf("Plank", "ab-spot-reduction-myth")).toBe("category");
    expect(attachOf("Crunch", "ab-spot-reduction-myth")).toBe("category");
    expect(ids("Barbell curl")).not.toContain("ab-spot-reduction-myth");
    expect(ids("Push-up")).not.toContain("bands-vs-weights-strength");
    // a custom band exercise gets the band notes too
    const custom: Exercise = { id: "", name: "Band pull-apart", muscle: "shoulders", equipment: "band", type: "isolation", mode: "band" };
    expect(notesFor(custom).map((n) => n.id).sort()).toEqual(["band-colour-not-weight", "bands-vs-weights-strength"]);
  });

  it("keeps a 'Myth check:' claim word for word", () => {
    const myth = notesFor(ex("Seated calf raise")).find((n) => n.id === "seated-calf-soleus-myth");
    expect(myth?.text.startsWith("Myth check: ")).toBe(true);
  });

  it("finds an exercise that arrives without an id, by name or old alias", () => {
    const bare = (name: string): Exercise => ({ id: "", name, muscle: "chest", equipment: "dumbbell", type: "compound" });
    expect(notesFor(bare("Incline dumbbell press")).map((n) => n.id)).toEqual(ids("Incline dumbbell bench press"));
    expect(notesFor(bare("  leg  PRESS ")).map((n) => n.id)).toEqual(ids("Leg press"));
  });

  it("returns nothing for an exercise with no study notes", () => {
    expect(notesFor(ex("Hammer curl"))).toEqual([]);
    expect(notesFor(ex("Walking"))).toEqual([]);
  });

  it("returns copies the page cannot use to change another page's notes", () => {
    const [first] = notesFor(ex("Leg press"));
    first.attach = "category";
    expect(notesFor(ex("Leg press"))[0].attach).toBe("this");
  });
});

describe("lazy loading", () => {
  it("the logger and the maths never import evidence.ts", () => {
    for (const file of ["workoutLog.ts", "trainingMath.ts"]) {
      const path = join(SRC, "lib", file);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, "utf8"), file).not.toMatch(/from\s+["'][^"']*evidence["']/);
    }
  });
});
