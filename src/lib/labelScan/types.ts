// ── Label scan: the shared contract ──────────────────────────────────────────
//
// Photograph a nutrition label → numbers you can trust, WITHOUT trusting any
// single reader. The design, and the measurements behind every rule below, are
// in docs/research/label-parity/label-parity.html. Read its "theories" section
// before changing a rule here: several obvious-sounding ideas were measured and
// FAILED.
//
// The pipeline, and which module owns each stage:
//
//   capture      components/LabelScanner.tsx   camera, framing, sharpness gate
//   recognize    ./ocr.ts        pixels  → OcrPage   (text + boxes, fixed model)
//   parse        ./parse.ts      OcrPage → ParsedPanel (grammar, columns, raw values)
//   verify       ./verify.ts     ParsedPanel → Verification (the label checks itself)
//   suggest      ./repair.ts     ParsedPanel → Repair[] (evidence-backed, NEVER applied)
//   rules        ./rules.ts      the three regulations as data: grids, reference values, energy factors
//   food         ./food.ts       confirmed panel → per-100 g food for the app
//
// THE NON-NEGOTIABLE RULES (each one is a measured result, not a preference):
//
//  1. THE PARSER NEVER CHANGES A DIGIT. It reports what it read, raw. Deciding
//     whether "99" was really "9" is the verifier's job, and doing it in two
//     places means neither one can be trusted.
//  2. A REPAIR IS A SUGGESTION. When exactly one repair fits every check it was
//     still the WRONG repair 4.0% of the time (15.5% for added-sugars %DV).
//     The app shows the evidence and a person taps to accept.
//  3. SERVING SIZE IS ALWAYS CONFIRMED BY A PERSON. A serving read 10x too large
//     was caught 0 times in 96: every other number stays consistent with it.
//  4. A FIELD WITH NO SECOND COPY CAN NEVER BE "checked". US total sugars has no
//     %DV and went silent 43% of the time. It is "unchecked" at best, forever.
//  5. DETERMINISM IS THE BOUNDARY. Same photo in, same answer out: pinned model
//     weights, no sampling, no network in recognize/parse/verify. Anything
//     non-deterministic (a server vision model) may only PROPOSE a ParsedPanel,
//     which then goes through the same verify().

/** Which rulebook printed this label. Decides grids, reference values and energy maths. */
export type Regime = "us" | "eu" | "cn";

/**
 * Every quantity a label can carry that the app reads. Units are fixed per key
 * so a value never needs a unit beside it:
 *   kcal (kcal) · kj (kJ) · fat, sat, trans, carb, fiber, sugar, added, prot, salt (g) · chol, sodium (mg)
 */
export type FieldKey =
  | "kcal"
  | "kj"
  | "fat"
  | "sat"
  | "trans"
  | "chol"
  | "sodium"
  | "salt"
  | "carb"
  | "fiber"
  | "sugar"
  | "added"
  | "prot";

/** What the numbers in a column are per. US panels are per serving; EU always has per 100 g/ml; CN may be either. */
export type Basis = "serving" | "100g" | "100ml";

// ── recognize ─────────────────────────────────────────────────────────────────

/** One recognised run of text and where it sat in the image, in image pixels. */
export interface OcrToken {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Recognition confidence 0..1, when the engine reports one. Advisory only — never a substitute for verify(). */
  conf?: number;
}

export interface OcrPage {
  width: number;
  height: number;
  tokens: OcrToken[];
  /** Identifies the exact weights that produced this, e.g. "pp-ocrv6-tiny@<sha256-prefix>". Part of the determinism promise. */
  engine: string;
  ms?: number;
}

// ── parse ─────────────────────────────────────────────────────────────────────

/** A number exactly as read. `value` is the parse of `raw`; nothing is corrected here (rule 1). */
export interface ReadValue {
  value: number;
  /** The text the number came from, untouched — "99", "2.5", "<1", "1,200". */
  raw: string;
  /** The label said "less than" / "<" this value (US "less than 1g", EU "<0.5 g"). */
  lessThan?: boolean;
  /** Index into OcrPage.tokens, so the confirm screen can point at the source. */
  token?: number;
}

export interface PanelColumn {
  basis: Basis;
  /** Present when the column is per serving and states its own serving, e.g. dual-column US labels. */
  servingGrams?: number;
  fields: Partial<Record<FieldKey, ReadValue>>;
  /**
   * The label's second copy of each amount as a percentage of a reference:
   * US %DV, CN NRV%, EU %RI (optional there). Keyed by the SAME FieldKey as
   * the amount it restates.
   */
  refPct: Partial<Record<FieldKey, ReadValue>>;
}

export interface ParsedPanel {
  regime: Regime;
  /** How sure the parser is of the regime — "Nutrition Facts" is decisive, a lone "kJ" is a hint. */
  regimeEvidence: string;
  /** Serving size in grams (or ml) as read. ALWAYS confirmed by a person (rule 3), even when read cleanly. */
  serving?: ReadValue;
  /** The serving line exactly as printed, for display: "2/3 cup (55g)". */
  servingText?: string;
  servingsPerContainer?: ReadValue;
  /**
   * The columns found, most useful first. Single-column labels have one. A US
   * dual-column label has "per serving" and "per container"; an EU/CN label
   * often has "per 100 g" and "per portion".
   */
  columns: PanelColumn[];
  /** Things the parser noticed and could not resolve — shown, never hidden. */
  warnings: string[];
}

// ── verify ────────────────────────────────────────────────────────────────────

/**
 *  checked    another number on the label confirms this one
 *  unchecked  nothing printed can confirm it (rule 4) — a person looks
 *  conflict   the label disagrees with itself around this number
 *  missing    the regulation expects it and it was not read
 */
export type FieldVerdict = "checked" | "unchecked" | "conflict" | "missing";

/** Which check produced a verdict. Kept so the confirm screen can say WHY. */
export type CheckName =
  | "energy" // calories/kJ reachable from the macros' rounding ranges
  | "grid" // the value sits on the regulation's legal rounding grid
  | "ref" // %DV / NRV% / %RI agrees with the amount it restates
  | "parts" // sat + trans <= fat, sugar <= carb, added <= sugar, fiber <= carb
  | "mass" // protein + carbs + fat <= serving grams
  | "units"; // kJ and kcal agree with each other (EU), salt = sodium x 2.5 (EU)

export interface CheckFailure {
  check: CheckName;
  /** Every field the failing relation involves. */
  fields: FieldKey[];
  /** One plain sentence a person can read: "Calories say 190 but the macros allow 210–250." */
  message: string;
}

export interface Verification {
  /** True only when there are no conflicts. Unchecked fields do NOT make this false. */
  consistent: boolean;
  column: Basis;
  fields: Partial<Record<FieldKey, FieldVerdict>>;
  refPct: Partial<Record<FieldKey, FieldVerdict>>;
  failures: CheckFailure[];
  /** What a person must look at before saving. Always includes "serving" (rule 3). */
  needsConfirm: Array<"serving" | FieldKey>;
}

// ── suggest ───────────────────────────────────────────────────────────────────

export interface Repair {
  /** The amount, or its percentage copy. */
  target: { field: FieldKey; kind: "amount" | "refPct" };
  from: ReadValue;
  to: number;
  /** The evidence, in words: "The 12% printed beside it only fits 9 g." */
  because: string;
  /** Which checks this repair makes pass that were failing. */
  fixes: CheckName[];
}

// ── food ──────────────────────────────────────────────────────────────────────

/** What the app stores: per 100 g, matching lib/nutrition Food and the food_cache FoodHit. */
export interface LabelFood {
  name: string;
  brand?: string;
  kcal: number;
  p: number;
  c: number;
  f: number;
  /** Grams in one labelled serving — the confirmed value, never the raw read. */
  serving?: number;
  barcode?: string;
  source: "label";
  /** The engine string from OcrPage, kept so a bad row can be traced to the weights that read it. */
  engine?: string;
}
