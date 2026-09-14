// Merge the exercise library into src/lib/exerciseData.ts.
//   node scripts/exercisedata/merge.mjs
//
// Inputs (all in this folder):
//   raw/*.json      per-muscle rows from the workout-exercise-library workflow (never edited)
//   legacy.json     the 186 ids and names the app shipped with, frozen. Ids are read from here,
//                   never recomputed, and the merge fails if any of them disappears or is renamed.
//   homebase.json   exercises we author ourselves, with explicit ids
//   regions.json    hand-authored main/helper muscle regions and mode for every exercise
//   overrides.json  library fixes: coarse muscle, merged near-duplicates, aliases for old names
//
// Deterministic: files are read in sorted order and the output is sorted with a plain
// code-point comparison, so the same inputs always write the same bytes. Nothing is written
// when any check fails.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { REGIONS } from "../../src/lib/muscleRegions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, "raw");
export const OUT = join(here, "..", "..", "src", "lib", "exerciseData.ts");

const MUSCLES = new Set(["chest", "back", "legs", "shoulders", "arms", "core", "fullbody", "cardio"]);
const EQUIP = new Set(["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "band", "other"]);
const TYPES = new Set(["compound", "isolation", "cardio"]);
const MODES = new Set(["weighted", "bodyweight", "band", "timed", "cardio"]);
const REGION_IDS = new Set(REGIONS.map((r) => r.id));

const readJson = (file) => JSON.parse(readFileSync(join(here, file), "utf8"));
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Same rule as SPEC §4.5 norm() — two names that normalise alike are the same exercise.
export const norm = (name) => {
  const s = name.toLowerCase().trim()
    .replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/\bflye\b/g, "fly").replace(/\bskull crusher\b/g, "skullcrusher")
    .replace(/\btricep\b/g, "triceps");
  return s.replace(/(\S{2,}[^s])s$/, "$1"); // last word over 3 letters: drop one final "s", not "ss"
};

// Everything merge() reads, from disk. Tests pass an edited copy to check the failures.
export function readInputs() {
  const rawFiles = {};
  const rawErrors = [];
  for (const f of readdirSync(RAW).filter((f) => f.endsWith(".json")).sort(byCodePoint)) {
    try {
      rawFiles[f] = JSON.parse(readFileSync(join(RAW, f), "utf8"));
    } catch (e) {
      rawErrors.push(`raw/${f}: ${e.message}`);
    }
  }
  return {
    rawFiles,
    rawErrors,
    legacy: readJson("legacy.json"),
    homebase: readJson("homebase.json"),
    regions: readJson("regions.json"),
    overrides: readJson("overrides.json"),
  };
}

export function merge({ rawFiles, rawErrors = [], legacy, homebase, regions, overrides: ov } = readInputs()) {
  const errors = [...rawErrors];
  const fileStats = [];

  // ── raw rows, first name wins (files in sorted order) ──
  const raw = [];
  for (const f of Object.keys(rawFiles).sort(byCodePoint)) {
    const arr = rawFiles[f];
    if (!Array.isArray(arr)) { errors.push(`raw/${f}: not an array`); continue; }
    for (const o of arr) raw.push({ ...o, _file: f.replace(/\.json$/, "") });
    fileStats.push([f, `${arr.length} rows`]);
  }

  const legacyIdByName = new Map(legacy.map((e) => [e.name, e.id]));

  const clean = [];
  const seenName = new Set();
  const seenId = new Set();
  const add = (o, id, origin, duplicateIsError) => {
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) { errors.push(`${origin}: row with no name`); return; }
    const key = name.toLowerCase().replace(/\s+/g, " ");
    if (seenName.has(key)) {
      if (duplicateIsError) errors.push(`${origin}: "${name}" is already in the library`);
      return;
    }
    seenName.add(key);
    if (!id) { errors.push(`${origin}: "${name}" has no frozen id — add it to legacy.json or homebase.json`); return; }
    if (seenId.has(id)) { errors.push(`${origin}: id ${id} used twice`); return; }
    seenId.add(id);
    const muscle = MUSCLES.has(o.muscle) ? o.muscle : MUSCLES.has(o._file) ? o._file : null;
    if (!muscle) errors.push(`${origin}: "${name}" has no valid muscle`);
    const equipment = EQUIP.has(o.equipment) ? o.equipment : "other";
    const type = TYPES.has(o.type) ? o.type : muscle === "cardio" ? "cardio" : "compound";
    clean.push({ id, name, muscle, equipment, type });
  };
  for (const o of raw) add(o, legacyIdByName.get(typeof o.name === "string" ? o.name.trim() : ""), `raw/${o._file}.json`, false);
  for (const o of homebase) add(o, o.id, "homebase.json", true);

  const byId = new Map(clean.map((e) => [e.id, e]));
  for (const { id, name } of legacy) {
    const e = byId.get(id);
    if (!e) errors.push(`legacy id ${id} ("${name}") disappeared`);
    else if (e.name !== name) errors.push(`legacy id ${id} renamed "${name}" → "${e.name}"`);
  }

  // ── overrides ──
  for (const [id, muscle] of Object.entries(ov.muscle ?? {})) {
    if (!byId.has(id)) errors.push(`overrides.muscle: unknown id ${id}`);
    else if (!MUSCLES.has(muscle)) errors.push(`overrides.muscle: ${id} → invalid muscle "${muscle}"`);
    else byId.get(id).muscle = muscle;
  }
  for (const [id, into] of Object.entries(ov.mergedInto ?? {})) {
    if (!byId.has(id) || !byId.has(into)) errors.push(`overrides.mergedInto: ${id} → ${into} names an unknown id`);
    else if (ov.mergedInto[into]) errors.push(`overrides.mergedInto: ${into} is itself merged`);
    else Object.assign(byId.get(id), { mergedInto: into, hidden: true });
  }
  for (const [id, aliases] of Object.entries(ov.aliases ?? {})) {
    if (!byId.has(id)) errors.push(`overrides.aliases: unknown id ${id}`);
    else byId.get(id).aliases = [...aliases];
  }

  // ── regions + mode ──
  for (const key of Object.keys(regions)) {
    if (!key.startsWith("_") && !byId.has(key)) errors.push(`regions.json: unknown id ${key}`);
  }
  for (const e of clean) {
    const r = regions[e.id];
    if (!r) { errors.push(`regions.json: missing ${e.id} ("${e.name}")`); continue; }
    if (r.name !== e.name) errors.push(`regions.json: ${e.id} is labelled "${r.name}" but the library calls it "${e.name}"`);
    if (!MODES.has(r.mode)) errors.push(`regions.json: ${e.id} invalid mode "${r.mode}"`);
    const primary = r.primary ?? [];
    const secondary = r.secondary ?? [];
    const all = [...primary, ...secondary];
    for (const id of all) if (!REGION_IDS.has(id)) errors.push(`regions.json: ${e.id} unknown region "${id}"`);
    if (new Set(all).size !== all.length) errors.push(`regions.json: ${e.id} lists a region twice`);
    if ((r.mode === "cardio") !== (e.type === "cardio")) errors.push(`regions.json: ${e.id} mode "${r.mode}" disagrees with type "${e.type}"`);
    if (r.mode === "cardio" && all.length) errors.push(`regions.json: ${e.id} is cardio and must have no regions`);
    if (r.mode !== "cardio" && !primary.length) errors.push(`regions.json: ${e.id} needs at least one main region`);
    if (r.mode === "band" && e.equipment !== "band") errors.push(`regions.json: ${e.id} mode band but equipment "${e.equipment}"`);
    Object.assign(e, { primary: [...primary], secondary: [...secondary], mode: r.mode });
  }

  // ── one exercise per normalised name among visible entries and all aliases ──
  const owner = new Map();
  const claim = (label, id, what) => {
    const k = norm(label);
    const prev = owner.get(k);
    if (prev && prev.id !== id) errors.push(`"${label}" (${what} of ${id}) normalises the same as ${prev.what} of ${prev.id}`);
    else if (!prev) owner.set(k, { id, what });
  };
  for (const e of clean) if (!e.hidden) claim(e.name, e.id, "name");
  for (const e of clean) for (const a of e.aliases ?? []) claim(a, e.id, "alias");

  if (errors.length) return { source: null, errors, fileStats, count: clean.length };

  clean.sort((a, b) => byCodePoint(a.muscle, b.muscle) || byCodePoint(a.name.toLowerCase(), b.name.toLowerCase()) || byCodePoint(a.name, b.name));

  const q = JSON.stringify;
  const line = (e) => {
    const parts = [`id: ${q(e.id)}`, `name: ${q(e.name)}`, `muscle: ${q(e.muscle)}`, `equipment: ${q(e.equipment)}`, `type: ${q(e.type)}`];
    if (e.aliases?.length) parts.push(`aliases: [${e.aliases.map(q).join(", ")}]`);
    parts.push(`primary: [${e.primary.map(q).join(", ")}]`, `secondary: [${e.secondary.map(q).join(", ")}]`, `mode: ${q(e.mode)}`);
    if (e.mergedInto) parts.push(`mergedInto: ${q(e.mergedInto)}`, "hidden: true");
    return `  { ${parts.join(", ")} },`;
  };

  const source = `// ── The offline exercise library ─────────────────────────────────────────────
// Common gym exercises (name / muscle / equipment / type, plus main and helper
// muscle regions and how a set is logged) the workout tracker searches when
// building routines or logging a session. Lazy-imported so it stays out of the
// finance-mode bundle. GENERATED by scripts/exercisedata/merge.mjs — do not
// hand-edit. ${clean.length} exercises.

export type Muscle = "chest" | "back" | "legs" | "shoulders" | "arms" | "core" | "fullbody" | "cardio";

export interface Exercise {
  id: string;
  name: string;
  muscle: Muscle;
  equipment: string;
  type: "compound" | "isolation" | "cardio";
  // ── optional, workout mode v1 (regions are RegionId strings from muscleRegions.ts;
  // typed as string here so this generated file needs no import) ──
  primary?: string[]; // main muscles
  secondary?: string[]; // helpers
  mode?: "weighted" | "bodyweight" | "band" | "timed" | "cardio";
  aliases?: string[]; // other names old logs and routines used
  mergedInto?: string; // near-duplicate folded into this id; kept so old logs still resolve
  hidden?: boolean; // true for merged entries: not shown when browsing
}

export const BUNDLED_EXERCISES: Exercise[] = [
${clean.map(line).join("\n")}
];
`;

  return { source, errors, fileStats, count: clean.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { source, errors, fileStats, count } = merge();
  console.log("── files ──");
  for (const [f, s] of fileStats) console.log(`  ${f.padEnd(18)} ${s}`);
  if (errors.length) {
    console.error(`\n✗ ${errors.length} problem(s), nothing written:`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  writeFileSync(OUT, source, "utf8");
  console.log(`\nkept ${count} exercises\n→ wrote ${OUT}`);
}
