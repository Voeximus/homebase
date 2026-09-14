// Build src/lib/evidence.ts (the study notes on an exercise page) from the verified
// evidence register, docs/research/workout-mode/evidence.json.
//   node scripts/evidence/build.mjs      (run scripts/exercisedata/merge.mjs first)
//
// Only KEPT claims reach the app, and only through their showOn list:
//   { exercise, as }       → a library exercise, matched by name or alias. A name that does not
//                            resolve fails the build, unless the entry is marked ifPresent.
//   { category, as }       → every exercise in a group: "equipment:band", "muscle:core".
//   { help }               → an info sheet, not an exercise page; skipped here.
// A kept claim with no resolving showOn entry is left out. The text is correctedClaim word for
// word (a leading "Myth check:" included), the grade is correctGrade, and sources marked
// citeInApp:false are dropped. Nothing is written when any check fails.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { BUNDLED_EXERCISES } from "../../src/lib/exerciseData.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
export const IN = join(ROOT, "docs", "research", "workout-mode", "evidence.json");
export const OUT = join(ROOT, "src", "lib", "evidence.ts");

const GRADES = new Set(["A", "B", "C"]);
const ATTACH_RANK = { this: 0, variation: 1, category: 2 };

// The category tests, twice: as functions (checked here) and as the source written into
// evidence.ts. Keep each pair saying the same thing.
const CATEGORIES = {
  "equipment:band": {
    test: (ex) => ex.mode === "band" || ex.equipment === "band",
    ts: `(ex) => ex.mode === "band" || ex.equipment === "band"`,
  },
  "muscle:core": {
    test: (ex) => ex.muscle === "core",
    ts: `(ex) => ex.muscle === "core"`,
  },
};

// Same rule as SPEC §4.5 norm() and scripts/exercisedata/merge.mjs.
const norm = (name) => {
  const s = name.toLowerCase().trim()
    .replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/\bflye\b/g, "fly").replace(/\bskull crusher\b/g, "skullcrusher")
    .replace(/\btricep\b/g, "triceps");
  return s.replace(/(\S{2,}[^s])s$/, "$1"); // last word over 3 letters: drop one final "s", not "ss"
};

export function buildEvidence(register = JSON.parse(readFileSync(IN, "utf8")), library = BUNDLED_EXERCISES) {
  const errors = [];
  const skipped = [];

  const byId = new Map(library.map((e) => [e.id, e]));
  const canonical = (e) => (e.mergedInto && byId.get(e.mergedInto)) || e;
  // exact name, then exact alias, then normalised name or alias
  const exact = new Map();
  const loose = new Map();
  for (const e of library) {
    for (const label of [e.name, ...(e.aliases ?? [])]) {
      if (!exact.has(label)) exact.set(label, canonical(e));
      if (!loose.has(norm(label)) || !e.hidden) loose.set(norm(label), canonical(e));
    }
  }
  const resolve = (name) => exact.get(name) ?? loose.get(norm(name));

  const notes = [];
  const byExercise = new Map(); // exercise id → Map(note id → attach)
  const byCategory = []; // [note id, category]

  for (const c of register.kept ?? []) {
    if (!Array.isArray(c.showOn)) continue;
    if (!GRADES.has(c.correctGrade)) { errors.push(`${c.id}: correctGrade "${c.correctGrade}" is not A, B or C`); continue; }
    if (typeof c.correctedClaim !== "string" || !c.correctedClaim) { errors.push(`${c.id}: no correctedClaim`); continue; }

    let attached = false;
    for (const s of c.showOn) {
      if (s.help) continue;
      if (!(s.as in ATTACH_RANK)) { errors.push(`${c.id}: showOn "as" is "${s.as}"`); continue; }
      if (s.exercise) {
        const ex = resolve(s.exercise);
        if (!ex) {
          if (s.ifPresent) skipped.push(`${c.id}: "${s.exercise}" is not in the library (ifPresent)`);
          else errors.push(`${c.id}: showOn exercise "${s.exercise}" is not in the library`);
          continue;
        }
        const m = byExercise.get(ex.id) ?? new Map();
        const prev = m.get(c.id);
        if (!prev || ATTACH_RANK[s.as] < ATTACH_RANK[prev]) m.set(c.id, s.as);
        byExercise.set(ex.id, m);
        attached = true;
      } else if (s.category) {
        const cat = CATEGORIES[s.category];
        if (!cat) { errors.push(`${c.id}: unknown category "${s.category}"`); continue; }
        if (s.as !== "category") { errors.push(`${c.id}: category entry must attach "as": "category"`); continue; }
        if (!library.some(cat.test)) {
          if (s.ifPresent) skipped.push(`${c.id}: no library exercise in "${s.category}" (ifPresent)`);
          else errors.push(`${c.id}: no library exercise in "${s.category}"`);
          continue;
        }
        byCategory.push([c.id, s.category]);
        attached = true;
      } else {
        errors.push(`${c.id}: showOn entry names no exercise, category or help sheet`);
      }
    }
    if (!attached) continue;

    const sources = (c.sources ?? [])
      .filter((src) => src.citeInApp !== false)
      .map((src) => ({ citation: src.citation, url: src.url }));
    notes.push({ id: c.id, grade: c.correctGrade, text: c.correctedClaim, sources });
  }

  const dropped = new Set((register.dropped ?? []).map((d) => d.id));
  for (const n of notes) if (dropped.has(n.id)) errors.push(`${n.id} is both kept and dropped`);

  // Name index for exercise objects that arrive without a library id (old logs).
  const byName = {};
  for (const e of library) {
    const target = canonical(e);
    if (!byExercise.has(target.id)) continue;
    for (const label of [e.name, ...(e.aliases ?? [])]) {
      const k = norm(label);
      if (!(k in byName) || !e.hidden) byName[k] = target.id;
    }
  }

  const q = JSON.stringify;
  const noteLines = notes.map((n) => [
    `  {`,
    `    id: ${q(n.id)},`,
    `    grade: ${q(n.grade)},`,
    `    text: ${q(n.text)},`,
    n.sources.length
      ? `    sources: [\n${n.sources.map((s) => `      { citation: ${q(s.citation)}, url: ${q(s.url)} },`).join("\n")}\n    ],`
      : `    sources: [],`,
    `  },`,
  ].join("\n"));
  const exerciseLines = [...byExercise.keys()].sort().map((id) =>
    `  ${q(id)}: [${[...byExercise.get(id)].map(([nid, as]) => `[${q(nid)}, ${q(as)}]`).join(", ")}],`);
  const nameLines = Object.keys(byName).sort().map((k) => `  ${q(k)}: ${q(byName[k])},`);
  const usedCategories = [...new Set(byCategory.map(([, cat]) => cat))].sort();

  const source = `// ── Study notes for the exercise page ────────────────────────────────────────
// What studies found about an exercise, shown word for word from the verified
// evidence register. GENERATED by scripts/evidence/build.mjs from
// docs/research/workout-mode/evidence.json — do not hand-edit. ${notes.length} notes.
// Lazy-load it with the exercise page; the logger and the maths never import it.

import type { Exercise } from "./exerciseData";

export type Grade = "A" | "B" | "C";

export interface StudyNote {
  id: string;
  grade: Grade;
  text: string; // correctedClaim, word for word
  attach: "this" | "variation" | "category"; // variation = tested on a similar exercise, not this one
  sources: { citation: string; url: string }[];
}

type Attach = StudyNote["attach"];

export const STUDY_NOTES: readonly Omit<StudyNote, "attach">[] = [
${noteLines.join("\n")}
];

// library exercise id → the notes that name it
const BY_EXERCISE: Record<string, [string, Attach][]> = {
${exerciseLines.join("\n")}
};

// normalised name or alias → library exercise id, for exercises that have notes
const ID_BY_NAME: Record<string, string> = {
${nameLines.join("\n")}
};

const IN_CATEGORY: Record<string, (ex: Exercise) => boolean> = {
${usedCategories.map((cat) => `  ${q(cat)}: ${CATEGORIES[cat].ts},`).join("\n")}
};

const BY_CATEGORY: [string, string][] = [
${byCategory.map(([nid, cat]) => `  [${q(nid)}, ${q(cat)}],`).join("\n")}
];

const norm = (name: string): string => {
  const s = name.toLowerCase().trim()
    .replace(/[-_]+/g, " ").replace(/\\s+/g, " ")
    .replace(/\\bflye\\b/g, "fly").replace(/\\bskull crusher\\b/g, "skullcrusher")
    .replace(/\\btricep\\b/g, "triceps");
  return s.replace(/(\\S{2,}[^s])s$/, "$1");
};

const NOTE_BY_ID = new Map(STUDY_NOTES.map((n, i) => [n.id, { n, i }]));
const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2 };
const ATTACH_RANK: Record<Attach, number> = { this: 0, variation: 1, category: 2 };

/** Every study note for this exercise: A, then B, then C (then this → variation → category). */
export function notesFor(ex: Exercise): StudyNote[] {
  const found = new Map<string, Attach>();
  const keep = (id: string, attach: Attach) => {
    const prev = found.get(id);
    if (!prev || ATTACH_RANK[attach] < ATTACH_RANK[prev]) found.set(id, attach);
  };
  const key = [ex.mergedInto, ex.id].find((k) => k && BY_EXERCISE[k]) ?? ID_BY_NAME[norm(ex.name)];
  for (const [nid, attach] of (key && BY_EXERCISE[key]) || []) keep(nid, attach);
  for (const [nid, cat] of BY_CATEGORY) if (IN_CATEGORY[cat](ex)) keep(nid, "category");
  return [...found]
    .flatMap(([nid, attach]) => {
      const hit = NOTE_BY_ID.get(nid);
      return hit ? [{ ...hit, attach }] : [];
    })
    .sort((a, b) => GRADE_RANK[a.n.grade] - GRADE_RANK[b.n.grade] || ATTACH_RANK[a.attach] - ATTACH_RANK[b.attach] || a.i - b.i)
    .map(({ n, attach }) => ({ ...n, attach }));
}
`;

  return { source, errors, skipped, notes, byExercise, byCategory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { source, errors, skipped, notes, byExercise } = buildEvidence();
  for (const s of skipped) console.log(`  skipped ${s}`);
  if (errors.length) {
    console.error(`\n✗ ${errors.length} problem(s), nothing written:`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  writeFileSync(OUT, source, "utf8");
  console.log(`\n${notes.length} notes on ${byExercise.size} exercises\n→ wrote ${OUT}`);
}
