// The three regulations as data: rounding grids, reference values, energy factors.
//
// Every number here was read from primary text, not remembered:
//   US  21 CFR 101.9 — (c) rounding and calorie methods, (c)(9) DRVs, (d)(7)(ii) %DV.
//   EU  Regulation 1169/2011 — Art. 32, Annex XIII Part B (reference intakes, checked
//       against https://www.legislation.gov.uk/eur/2011/1169/annex/XIII/data.xht and the
//       as-adopted text), Annex XIV (conversion factors); European Commission 2012
//       guidance on tolerances, Table 4 (rounding).
//   CN  GB 28050-2025 Table 1 (rounding and "0" limits) and Table A.1 (NRV); the 2011
//       edition, which is what is on shelves until 16 March 2027, differs only in which
//       nutrients are mandatory.
// The measurements that decide how verify.ts USES these values are in
// docs/research/label-parity and tests/labelScan.research.test.ts.
import type { FieldKey, Regime } from "./types.ts";

export interface EnergyFactors {
  /** per gram, in the unit asked for */
  prot: number;
  carb: number;
  fat: number;
  /** present where the regulation gives fiber its own factor (EU 2 kcal / 8 kJ, CN 8 kJ) */
  fiber?: number;
}

// Rounding is compared with a small tolerance because 0.1 and 0.05 are not exact in
// binary: 3 × 0.1 is 0.30000000000000004, and a label value must not fail a grid
// check over that.
const EPS = 1e-6;

const isMultiple = (v: number, step: number) => Math.abs(v - Math.round(v / step) * step) <= EPS;

/** Round half up to a whole number, the way every regulation here writes "nearest whole percent". */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5 + 1e-9);
}

// ── reference values ─────────────────────────────────────────────────────────

// 21 CFR 101.9(c)(9), adults and children 4 years and older. Protein is left out on
// purpose: its %DV is corrected for protein quality (PDCAAS) and optional, so the
// printed percentage cannot be recomputed from the grams. Trans fat and total sugars
// have no DRV at all.
const US_DRV: Partial<Record<FieldKey, number>> = {
  fat: 78,
  sat: 20,
  chol: 300,
  sodium: 2300,
  carb: 275,
  fiber: 28,
  added: 50,
};

// Regulation 1169/2011 Annex XIII Part B, "reference intake of an average adult
// (8 400 kJ/2 000 kcal)". There is no RI for fibre or for sodium: a label that prints
// a percentage prints it for salt.
const EU_RI: Partial<Record<FieldKey, number>> = {
  kj: 8400,
  kcal: 2000,
  fat: 70,
  sat: 20,
  carb: 260,
  sugar: 90,
  prot: 50,
  salt: 6,
};

// GB 28050-2025 Table A.1. Energy is referenced in kJ only, and there is no NRV for
// sugar — which is why sugar is the unchecked field in China too.
const CN_NRV: Partial<Record<FieldKey, number>> = {
  kj: 8400,
  prot: 60,
  fat: 60,
  sat: 20,
  carb: 300,
  fiber: 25,
  sodium: 2000,
};

const REFERENCE: Record<Regime, Partial<Record<FieldKey, number>>> = { us: US_DRV, eu: EU_RI, cn: CN_NRV };

/** The reference a percentage column is computed against: US DRV, CN NRV, EU RI. undefined = no second copy exists. */
export function referenceValue(regime: Regime, field: FieldKey): number | undefined {
  return REFERENCE[regime][field];
}

// ── rounding intervals ───────────────────────────────────────────────────────
//
// Every interval is CLOSED. None of the three texts says which way an exact half
// goes, so a checker that picked one would raise false alarms on labels that picked
// the other.

function usInterval(field: FieldKey, d: number): [number, number] {
  switch (field) {
    case "kcal":
      // Nearest 5 up to and including 50, nearest 10 above; under 5 may print 0.
      // 50 is reachable from both sides: 47.5 rounds to it in 5s, 54 rounds to it in 10s.
      if (d <= 0) return [0, 5];
      if (d < 50) return [Math.max(0, d - 2.5), d + 2.5];
      if (d === 50) return [47.5, 55];
      return [d - 5, d + 5];
    case "fat":
    case "sat":
    case "trans":
      // Under 0.5 g prints 0, so a printed 0.5 g only ever came from 0.5 g or more.
      if (d <= 0) return [0, 0.5];
      if (d === 0.5) return [0.5, 0.75];
      if (d < 5) return [Math.max(0, d - 0.25), d + 0.25];
      if (d === 5) return [4.75, 5.5];
      return [d - 0.5, d + 0.5];
    case "chol":
      // Under 2 mg prints 0; 2–5 mg may print "less than 5 mg", so 5 reaches down to 2.
      if (d <= 0) return [0, 2];
      if (d === 5) return [2, 7.5];
      return [Math.max(0, d - 2.5), d + 2.5];
    case "sodium":
      // Under 5 mg prints 0; 5 mg steps up to 140, 10 mg steps above.
      if (d <= 0) return [0, 5];
      if (d === 5) return [5, 7.5];
      if (d < 140) return [Math.max(0, d - 2.5), d + 2.5];
      if (d === 140) return [137.5, 145];
      return [d - 5, d + 5];
    case "carb":
    case "fiber":
    case "sugar":
    case "added":
    case "prot":
      // Nearest gram; under 1 g may print "less than 1 g"; under 0.5 g prints 0.
      if (d <= 0) return [0, 0.5];
      return [Math.max(0, d - 0.5), d + 0.5];
    case "kj":
      return [Math.max(0, d - 0.5), d + 0.5];
    case "salt":
      return [Math.max(0, d - 0.05), d + 0.05];
  }
}

/**
 * The EU guidance rounds in two tiers: coarse at or above a threshold, fine below it,
 * and "0" at or below a small limit. A whole number at the threshold (10 g) is
 * reachable from both tiers — 9.96 g rounds to 10.0 g in tenths.
 *
 * A value printed MORE precisely than the guidance asks (62.3 g carbohydrate) is
 * common on real European labels, and the guidance is not binding, so it is read at
 * the precision it was printed with rather than rejected.
 */
function tiered(d: number, zeroMax: number, bigAt: number, bigStep: number, smallStep: number): [number, number] {
  if (d <= 0) return [0, zeroMax];
  if (d >= bigAt && isMultiple(d, bigStep)) {
    return [d - (d - bigAt < EPS ? smallStep : bigStep) / 2, d + bigStep / 2];
  }
  return [Math.max(0, d - smallStep / 2), d + smallStep / 2];
}

function euInterval(field: FieldKey, d: number): [number, number] {
  switch (field) {
    case "kcal":
    case "kj":
      return d <= 0 ? [0, 0.5] : [d - 0.5, d + 0.5];
    case "fat":
    case "carb":
    case "sugar":
    case "prot":
    case "fiber":
      // ≥ 10 g → 1 g; < 10 g and > 0.5 g → 0.1 g; ≤ 0.5 g → "0" or "<0.5 g".
      return tiered(d, 0.5, 10, 1, 0.1);
    case "sat":
      // ≥ 10 g → 1 g; < 10 g and > 0.1 g → 0.1 g; ≤ 0.1 g → "0" or "<0.1 g".
      return tiered(d, 0.1, 10, 1, 0.1);
    case "salt":
      // ≥ 1 g → 0.1 g; < 1 g and > 0.0125 g → 0.01 g; ≤ 0.0125 g → "0" or "<0.01 g".
      return tiered(d, 0.0125, 1, 0.1, 0.01);
    case "sodium":
      // The guidance works in grams (≥ 1 g → 0.1 g; < 1 g and > 0.005 g → 0.01 g); FieldKey sodium is mg.
      return tiered(d, 5, 1000, 100, 10);
    default:
      // Not an EU nutrition declaration field (trans fat, cholesterol, added sugars).
      return usInterval(field, d);
  }
}

// GB 28050-2025 Table 1: [rounding interval, the "0" limit at or below which the value must print as 0].
const CN_TABLE1: Partial<Record<FieldKey, [number, number]>> = {
  kj: [1, 17],
  prot: [0.1, 0.5],
  fat: [0.1, 0.5],
  sat: [0.1, 0.1],
  trans: [0.1, 0.3],
  chol: [1, 5],
  carb: [0.1, 0.5],
  sugar: [0.1, 0.5],
  fiber: [0.1, 0.5],
  sodium: [1, 5],
};

function cnInterval(field: FieldKey, d: number): [number, number] {
  const row = CN_TABLE1[field];
  if (!row) return field === "kcal" ? (d <= 0 ? [0, 0.5] : [d - 0.5, d + 0.5]) : euInterval(field, d);
  const [step, zeroMax] = row;
  if (d <= 0) return [0, zeroMax];
  return [Math.max(0, d - step / 2), d + step / 2];
}

/** The range of ACTUAL amounts that a declared value could have been rounded from. */
export function roundingInterval(
  regime: Regime,
  field: FieldKey,
  declared: number,
  lessThan?: boolean,
): [number, number] {
  // "Less than 1 g" says only that the actual amount is under 1 g.
  if (lessThan) return [0, Math.max(0, declared)];
  if (regime === "us") return usInterval(field, declared);
  if (regime === "eu") return euInterval(field, declared);
  return cnInterval(field, declared);
}

// ── the legal grid ───────────────────────────────────────────────────────────

function usOnGrid(field: FieldKey, v: number): boolean {
  switch (field) {
    case "kcal":
      return v <= 50 ? isMultiple(v, 5) : isMultiple(v, 10);
    case "fat":
    case "sat":
    case "trans":
      return v < 5 ? isMultiple(v, 0.5) : isMultiple(v, 1);
    case "chol":
      return isMultiple(v, 5);
    case "sodium":
      return v <= 140 ? isMultiple(v, 5) : isMultiple(v, 10);
    case "carb":
    case "fiber":
    case "sugar":
    case "added":
    case "prot":
      return isMultiple(v, 1);
    case "kj":
      return isMultiple(v, 1);
    case "salt":
      return isMultiple(v, 0.01);
  }
}

// The EU guidance is not binding and real labels print finer than it asks, so the EU
// grid only rejects a value finer than the finest step the guidance ever uses for
// that nutrient. That keeps "3.72 g fat" illegal without flagging "62.3 g carbohydrate".
function euOnGrid(field: FieldKey, v: number): boolean {
  switch (field) {
    case "kcal":
    case "kj":
    case "sodium":
      return isMultiple(v, 1);
    case "salt":
      return isMultiple(v, 0.01);
    case "fat":
    case "sat":
    case "carb":
    case "sugar":
    case "prot":
    case "fiber":
      return isMultiple(v, 0.1);
    default:
      return usOnGrid(field, v);
  }
}

function cnOnGrid(field: FieldKey, v: number): boolean {
  const row = CN_TABLE1[field];
  if (!row) return field === "kcal" ? isMultiple(v, 1) : euOnGrid(field, v);
  const [step, zeroMax] = row;
  // At or below the "0" limit the only legal print is 0 (also written "0.0" / "0.00").
  if (v === 0) return true;
  return v > zeroMax + EPS && isMultiple(v, step);
}

/** Whether a declared value can legally be printed at all under this regime's rounding rules. */
export function onGrid(regime: Regime, field: FieldKey, value: number): boolean {
  if (!(value >= 0) || !Number.isFinite(value)) return false;
  if (regime === "us") return usOnGrid(field, value);
  if (regime === "eu") return euOnGrid(field, value);
  return cnOnGrid(field, value);
}

// ── the percentage column ────────────────────────────────────────────────────

/**
 * Every percentage the regulation allows to be printed beside this declared amount. Empty when no reference exists.
 *
 * US: 101.9(d)(7)(ii) lets the %DV be worked from the declared amount OR the actual
 * amount before rounding, so every whole percent reachable from the rounding interval
 * is legal, plus the one from the declared value.
 * EU: Article 32 does not say which, so it is read the same way as the US.
 * CN: NRV% is the DECLARED value over the NRV, rounded to 1 — a single legal value,
 * which makes the Chinese percentage check exact rather than a range.
 */
export function allowedRefPct(regime: Regime, field: FieldKey, declared: number, lessThan?: boolean): number[] {
  const ref = referenceValue(regime, field);
  if (ref === undefined) return [];
  // Same operation order as the research code (x / ref * 100), so the two agree bit for bit.
  const pct = (x: number) => roundHalfUp((x / ref) * 100);
  if (regime === "cn" && !lessThan) return [pct(declared)];
  const [lo, hi] = roundingInterval(regime, field, declared, lessThan);
  const out = new Set<number>();
  for (let p = pct(lo); p <= pct(hi); p++) out.add(p);
  out.add(pct(declared));
  return [...out].sort((a, b) => a - b);
}

// ── energy ───────────────────────────────────────────────────────────────────

export function energyFactors(regime: Regime, unit: "kcal" | "kj"): EnergyFactors {
  if (regime === "us") {
    // 101.9(c)(1)(i)(A): the general factors. US total carbohydrate INCLUDES fiber, so
    // there is no separate fiber term; FDA's permission to subtract insoluble fiber is
    // handled in verify.ts as a low-side allowance. US labels never print kJ; the
    // general kJ factors are returned so a caller asking gets a physically sane answer.
    return unit === "kcal" ? { prot: 4, carb: 4, fat: 9 } : { prot: 17, carb: 17, fat: 37 };
  }
  // EU Annex XIV and GB 28050-2025 use the same general factors; China prints kJ, and
  // the kcal factors are there for a Chinese label that adds a kcal line.
  return unit === "kcal" ? { prot: 4, carb: 4, fat: 9, fiber: 2 } : { prot: 17, carb: 17, fat: 37, fiber: 8 };
}

/**
 * Annex XIV in full, for reference. Only protein, carbohydrate, fat and fibre have a
 * FieldKey; polyols, alcohol, organic acids and salatrims are why an EU energy figure
 * can legitimately sit off the four-factor estimate.
 */
export const EU_ANNEX_XIV = {
  carbohydrate: { kj: 17, kcal: 4 },
  polyols: { kj: 10, kcal: 2.4 },
  protein: { kj: 17, kcal: 4 },
  fat: { kj: 37, kcal: 9 },
  salatrims: { kj: 25, kcal: 6 },
  alcohol: { kj: 29, kcal: 7 },
  organicAcid: { kj: 13, kcal: 3 },
  fibre: { kj: 8, kcal: 2 },
  erythritol: { kj: 0, kcal: 0 },
} as const;

// ── mandatory fields ─────────────────────────────────────────────────────────

/**
 * Fields each regulation requires, in printed order.
 * US 101.9(c): every line is mandatory. EU Art. 30(1): energy (both units, Annex XV),
 * fat, saturates, carbohydrate, sugars, protein, salt — fibre is optional. CN: the
 * 2025 "1+6".
 */
export const MANDATORY: Record<Regime, FieldKey[]> = {
  us: ["kcal", "fat", "sat", "trans", "chol", "sodium", "carb", "fiber", "sugar", "added", "prot"],
  eu: ["kj", "kcal", "fat", "sat", "carb", "sugar", "prot", "salt"],
  cn: ["kj", "prot", "fat", "sat", "carb", "sugar", "sodium"],
};

/** GB 28050-2011's "1+4". A 2011 label is legal until 16 March 2027 and on shelves after it, so these are the only CN fields whose absence counts as missing. */
export const MANDATORY_CN_2011: FieldKey[] = ["kj", "prot", "fat", "carb", "sodium"];
