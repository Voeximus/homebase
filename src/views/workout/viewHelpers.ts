// ── Helpers for the exercise page, the Exercises tab and the Progress tab ─────
// The decisions those three screens make, kept out of the components so they can
// be tested without rendering: which library rows a search shows, how a region is
// named, which sessions count as "your last 3", and how the hard-set rows are
// ordered and scaled. Nothing here touches the store or the clock.
//
// The study notes are the one heavy piece. `loadEvidence` is the only way the
// views reach src/lib/evidence.ts, and it is a dynamic import, so the notes stay
// out of the main bundle until an exercise page or the Exercises tab opens.

import type { Exercise, Muscle } from "../../lib/exerciseData";
import type { Grade, StudyNote } from "../../lib/evidence";
import { getLang, t } from "../../lib/i18n";
import { REGIONS, REGION_BY_ID, isRegionId, type RegionId } from "../../lib/muscleRegions";
import { bandLabel, findExercise, isLogged, isWarmup, normName } from "../../lib/trainingMath";
import type { Person, SetEntry, Workout } from "../../lib/workoutLog";

// ── study notes (lazy) ────────────────────────────────────────────────────────
type EvidenceModule = typeof import("../../lib/evidence");
let evidence: Promise<EvidenceModule> | null = null;
/** The evidence module, fetched once. A failed fetch is forgotten so the next page can retry. */
export function loadEvidence(): Promise<EvidenceModule> {
  if (!evidence) {
    evidence = import("../../lib/evidence").catch((err) => {
      evidence = null;
      throw err;
    });
  }
  return evidence;
}

export const GRADE_GLYPH: Record<Grade, string> = { A: "■", B: "◧", C: "□" };
export const GRADE_LABEL: Record<Grade, string> = {
  A: "Tested over weeks",
  B: "Measured in one workout",
  C: "Reasoned, not tested",
};

/** Notes about this exercise or a close variation — the ones worth a count on a list row. */
export const ownNoteCount = (notes: StudyNote[]) => notes.filter((n) => n.attach !== "category").length;

/**
 * The English key for a category note's label. notesFor() only says a note is a
 * category note, not which category, so it is read back from the exercise the
 * same way evidence.ts matched it (band by mode or equipment, core by muscle).
 */
export function categoryLabel(ex: Exercise, note: StudyNote): string {
  const band = ex.mode === "band" || ex.equipment === "band";
  const core = ex.muscle === "core";
  // An exercise in both categories: the band notes are the ones about bands.
  const isBand = band && core ? /band/.test(note.id) : band;
  return isBand ? "About all band exercises" : "About all core exercises";
}

// ── regions ───────────────────────────────────────────────────────────────────
/** A region's display name. Falls back to the region's own Chinese name when t() has none. */
export function regionName(id: RegionId): string {
  const r = REGION_BY_ID[id];
  const s = t(r.en);
  return s === r.en && getLang() === "zh" ? r.zh : s;
}

/** Main and helper regions of a library row, unknown ids dropped, a main muscle never repeated as a helper. */
export function regionsOf(ex: Exercise | undefined): { primary: RegionId[]; secondary: RegionId[] } {
  const primary = [...new Set((ex?.primary ?? []).filter(isRegionId))];
  const secondary = [...new Set((ex?.secondary ?? []).filter(isRegionId))].filter((r) => !primary.includes(r));
  return { primary, secondary };
}

/** "Main: Lats, Mid traps & rhomboids · cable" — the faint line under a library row. */
export function libraryLine(ex: Exercise): string {
  const { primary } = regionsOf(ex);
  if (!primary.length) return `${t(ex.muscle)} · ${t(ex.equipment)}`;
  return t("Main: {muscles} · {equipment}", {
    muscles: primary.slice(0, 3).map(regionName).join(", "),
    equipment: t(ex.equipment),
  });
}

// ── the Exercises tab ─────────────────────────────────────────────────────────
export const AREAS = ["All", "Chest", "Back", "Shoulders", "Arms", "Core", "Legs", "Cardio"] as const;
export type Area = (typeof AREAS)[number];
const AREA_MUSCLE: Record<Exclude<Area, "All">, Muscle> = {
  Chest: "chest",
  Back: "back",
  Shoulders: "shoulders",
  Arms: "arms",
  Core: "core",
  Legs: "legs",
  Cardio: "cardio",
};

/**
 * Library rows for a search and a body-area chip. Every word typed must appear in
 * the name or one of its aliases, so "chest-supported row" still finds the dumbbell
 * row an old routine called that. Merged near-duplicates (hidden) never show.
 */
export function filterLibrary(library: Exercise[], query: string, area: Area): Exercise[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return library
    .filter((ex) => {
      if (ex.hidden) return false;
      if (area !== "All" && ex.muscle !== AREA_MUSCLE[area]) return false;
      if (!tokens.length) return true;
      const hay = [ex.name, ...(ex.aliases ?? [])].join(" ").toLowerCase();
      return tokens.every((tk) => hay.includes(tk));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The browse view: one group per body area in chip order, then full-body lifts, which have no chip. */
export function groupByArea(list: Exercise[]): { label: string; items: Exercise[] }[] {
  const groups = AREAS.slice(1).map((a) => ({
    label: a as string,
    items: list.filter((ex) => ex.muscle === AREA_MUSCLE[a as Exclude<Area, "All">]),
  }));
  groups.push({ label: "Full body", items: list.filter((ex) => ex.muscle === "fullbody") });
  return groups.filter((g) => g.items.length > 0);
}

// ── the Progress tab ──────────────────────────────────────────────────────────
export const TICKS = [4, 10, 18] as const;

export interface RegionRow {
  id: RegionId;
  value: number;
  pct: number; // bar width, 0–100
  band: string; // English key from bandLabel
}

/**
 * Hard-set rows, biggest first (ties keep body order). Muscles with no sets are
 * left out unless `showAll`. The bar scale is the top value, but never under 20,
 * so a light week does not draw a full bar and the 18 mark always fits.
 */
export function progressRows(
  byRegion: Partial<Record<RegionId, number>>,
  showAll: boolean,
): { rows: RegionRow[]; hidden: number; scale: number } {
  const order = new Map(REGIONS.map((r, i) => [r.id, i]));
  const all = REGIONS.map((r) => ({ id: r.id, value: byRegion[r.id] ?? 0 })).sort(
    (a, b) => b.value - a.value || order.get(a.id)! - order.get(b.id)!,
  );
  const scale = Math.max(20, all[0]?.value ?? 0);
  const pct = (v: number) => Math.min(100, (v / scale) * 100);
  const shown = showAll ? all : all.filter((r) => r.value > 0);
  return {
    rows: shown.map((r) => ({ ...r, pct: pct(r.value), band: bandLabel(r.value) })),
    hidden: all.length - shown.length,
    scale,
  };
}

// ── formatting ────────────────────────────────────────────────────────────────
/** Hard sets can be halves: 7.5 stays 7.5, 8 is 8. */
export const fmtSets = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const fmtWeight = (w: number) => String(Math.round(w * 10) / 10);

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD_ZH = "日一二三四五六";
/** "Tue 3 Sep" (Chinese: "9月3日 周二") from a local YYYY-MM-DD. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  if (!Number.isFinite(dow)) return iso;
  return getLang() === "zh" ? `${m}月${d}日 周${WD_ZH[dow]}` : `${WD[dow]} ${d} ${MON[m - 1]}`;
}

/** "185×5 · 185×5 · 185×4"; a set with no weight reads as reps. */
export function setsText(sets: SetEntry[]): string {
  return sets.map((s) => (s.weight > 0 ? `${fmtWeight(s.weight)}×${s.reps}` : t("{r} reps", { r: s.reps }))).join(" · ");
}

// ── your numbers ──────────────────────────────────────────────────────────────
export const REP_COLUMNS = [1, 3, 5, 8, 10, 12] as const;

export interface PastSession {
  workoutId: string;
  date: string;
  workoutName: string;
  working: SetEntry[]; // done working sets, in logged order
  warmups: number; // done warm-ups, only counted
  minutes: number; // time-based logs with no sets
}

/**
 * The person's most recent finished sessions that did this exercise, newest first.
 * Matched the way trainingMath matches (library id, then name, then alias, else
 * the normalised name), so a session logged as "Chest-supported row" still counts.
 * A session only appears if something was actually done in it.
 */
export function sessionsWith(
  workouts: Workout[],
  person: Person,
  name: string,
  library: Exercise[],
  limit = 3,
): PastSession[] {
  const keyOf = (n: string, id?: string) => {
    const ex = findExercise(library, n, id);
    return ex ? `#${ex.id}` : `~${normName(n)}`;
  };
  const key = keyOf(name);
  const out: PastSession[] = [];
  const ordered = workouts
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.done && w.person === person)
    .sort((a, b) => b.w.date.localeCompare(a.w.date) || b.i - a.i);
  for (const { w } of ordered) {
    const entries = w.exercises.filter((e) => keyOf(e.name, e.exerciseId) === key);
    if (!entries.length) continue;
    const done = entries.flatMap((e) => e.sets.filter(isLogged)); // a tick with no reps logged nothing
    const minutes = entries.reduce((n, e) => n + (e.sets.length ? 0 : e.duration ?? 0), 0);
    if (!done.length && !minutes) continue;
    out.push({
      workoutId: w.id,
      date: w.date,
      workoutName: w.name,
      working: done.filter((s) => !isWarmup(s)),
      warmups: done.filter(isWarmup).length,
      minutes,
    });
    if (out.length >= limit) break;
  }
  return out;
}
