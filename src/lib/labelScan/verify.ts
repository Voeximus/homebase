// The label checks itself. Every relation a regulation forces between two printed
// numbers is a check; a misread digit usually breaks one. What each check is worth
// was MEASURED on 192 real US labels (docs/research/label-parity), and the verdict
// tables below are the output of that measurement, not a judgement call.
import {
  MANDATORY,
  MANDATORY_CN_2011,
  allowedRefPct,
  energyFactors,
  onGrid,
  referenceValue,
  roundingInterval,
} from "./rules";
import type {
  CheckFailure,
  CheckName,
  FieldKey,
  FieldVerdict,
  PanelColumn,
  ParsedPanel,
  ReadValue,
  Regime,
  Verification,
} from "./types";

export interface VerifyOptions {
  /**
   * US only: let printed calories sit BELOW the 4/4/9 estimate by up to 4 kcal per
   * gram of declared fiber, because 101.9(c)(1)(i) lets a maker subtract insoluble
   * fiber and count soluble fiber at 2 kcal/g. On by default. What it costs in
   * detection was measured in tests/labelScan.research.test.ts ("fiber allowance").
   */
  fiberAllowance?: boolean;
  /** Relative slack on the energy check, as a fraction of the printed energy. Default 0.01, the research's calibrated margin. */
  energyMargin?: number;
}

/** One relation that was actually evaluated on this column, passing or not. */
export interface CheckOutcome {
  /** Stable identity of the relation: "energy:kcal", "ref:fat", "parts:fat", "mass", "units:energy", "grid:sodium". */
  id: string;
  check: CheckName;
  fields: FieldKey[];
  ok: boolean;
  message: string;
}

// ── wording ──────────────────────────────────────────────────────────────────

const NAME: Record<FieldKey, string> = {
  kcal: "Calories",
  kj: "Energy",
  fat: "Total fat",
  sat: "Saturated fat",
  trans: "Trans fat",
  chol: "Cholesterol",
  sodium: "Sodium",
  salt: "Salt",
  carb: "Total carbs",
  fiber: "Fiber",
  sugar: "Total sugars",
  added: "Added sugars",
  prot: "Protein",
};

const UNIT: Record<FieldKey, string> = {
  kcal: "kcal",
  kj: "kJ",
  fat: "g",
  sat: "g",
  trans: "g",
  chol: "mg",
  sodium: "mg",
  salt: "g",
  carb: "g",
  fiber: "g",
  sugar: "g",
  added: "g",
  prot: "g",
};

const REGIME_NAME: Record<Regime, string> = { us: "US", eu: "EU", cn: "Chinese" };

export function fieldName(field: FieldKey): string {
  return NAME[field];
}

export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
}

/** "9 g", "65 mg", "190 kcal" — a number with the unit its FieldKey fixes. */
export function formatAmount(field: FieldKey, v: number): string {
  return `${formatNumber(v)} ${UNIT[field]}`;
}

const lower = (field: FieldKey) => NAME[field].toLowerCase();

// ── the checks ───────────────────────────────────────────────────────────────

const interval = (regime: Regime, field: FieldKey, rv: ReadValue) =>
  roundingInterval(regime, field, rv.value, rv.lessThan);

/** A printed percentage agrees with the amount it restates. */
export function refFits(regime: Regime, field: FieldKey, amount: ReadValue, pct: ReadValue): boolean {
  const ref = referenceValue(regime, field);
  if (ref === undefined) return true;
  const allowed = allowedRefPct(regime, field, amount.value, amount.lessThan);
  const [lo, hi] = interval(regime, field, amount);
  // "<1%" says only that the share is under 1%.
  if (pct.lessThan) return allowed[0] < pct.value || (lo / ref) * 100 < pct.value;
  if (Number.isInteger(pct.value) || regime !== "eu") return allowed.includes(pct.value);
  // Some EU labels print %RI with a decimal. Compare at the precision it was printed with.
  const step = Number.isInteger(pct.value * 10) ? 0.1 : 0.01;
  return pct.value + step / 2 >= (lo / ref) * 100 - 1e-9 && pct.value - step / 2 <= (hi / ref) * 100 + 1e-9;
}

// Relations where one printed amount is a part of another. US total carbohydrate
// INCLUDES fiber; EU carbohydrate EXCLUDES fibre by definition (Annex I), and Chinese
// labels do it both ways, so fiber <= carbs is only a US rule.
const PARTS: Record<Regime, Array<{ id: string; subs: FieldKey[]; total: FieldKey }>> = {
  us: [
    { id: "parts:fat", subs: ["sat", "trans"], total: "fat" },
    { id: "parts:sugar", subs: ["sugar"], total: "carb" },
    { id: "parts:added", subs: ["added"], total: "sugar" },
    { id: "parts:fiber", subs: ["fiber"], total: "carb" },
  ],
  eu: [
    { id: "parts:fat", subs: ["sat", "trans"], total: "fat" },
    { id: "parts:sugar", subs: ["sugar"], total: "carb" },
    { id: "parts:added", subs: ["added"], total: "sugar" },
  ],
  cn: [
    { id: "parts:fat", subs: ["sat", "trans"], total: "fat" },
    { id: "parts:sugar", subs: ["sugar"], total: "carb" },
  ],
};

function energyCheck(
  regime: Regime,
  col: PanelColumn,
  unit: "kcal" | "kj",
  opts: Required<VerifyOptions>,
): CheckOutcome | null {
  const { prot, carb, fat, fiber } = col.fields;
  const e = col.fields[unit];
  if (!e || !prot || !carb || !fat) return null;
  const k = energyFactors(regime, unit);
  const [plo, phi] = interval(regime, "prot", prot);
  const [clo, chi] = interval(regime, "carb", carb);
  const [flo, fhi] = interval(regime, "fat", fat);
  // FDA (and both other rulebooks) apply the factors to the ACTUAL amounts before
  // rounding. So the printed energy must be reachable from SOME choice of actual
  // protein, carbs and fat inside their rounding intervals. Measured on 192 real US
  // labels: 191 need nothing more. The one exception (label 154) is a bar with 3 g of
  // fiber printing 3.75 kcal under what its ranges allow, and the fiber allowance below
  // explains it. The research's 1% margin is kept: no fixture label needs it any more,
  // it costs 4 of 6,360 simulated misreads, and the sample is only 192 labels.
  let lo = k.prot * plo + k.carb * clo + k.fat * flo;
  let hi = k.prot * phi + k.carb * chi + k.fat * fhi;
  const fields: FieldKey[] = [unit, "prot", "carb", "fat"];
  const [elo, ehi] = interval(regime, unit, e);
  const margin = opts.energyMargin * Math.max(e.value, 1);
  const fits = (low: number, high: number) => ehi >= Math.max(0, low) - margin && elo <= high + margin;
  let id = `energy:${unit}`;
  if (fiber) {
    const [blo, bhi] = interval(regime, "fiber", fiber);
    if (regime === "us") {
      // A label may print fewer calories than 4/4/9 when the maker subtracted fiber, and
      // without this allowance label 154 is a false alarm. Allowing it costs detection:
      // on the held-out labels 25 more misreads stop raising a conflict, 17 of them
      // protein (silent rate 12.3% → 17.3%). So the allowance only ever PREVENTS A FALSE
      // ALARM: a label that adds up only because of it passes under a different id, and
      // the fields whose "checked" rests on the energy check (calories, protein) do not
      // get it from that pass — a person looks. Measured: not one extra calories or
      // protein misread ends up both silent and "checked".
      if (!fits(lo, hi) && opts.fiberAllowance) {
        const allowed = fits(lo - 4 * Math.min(bhi, chi), hi);
        if (allowed) id = `energy:${unit}+fiber`;
        lo -= 4 * Math.min(bhi, chi);
        // Listed even when it still fails: a larger fiber value could make it pass, and
        // repair.ts relies on a failure naming every field that could change its outcome.
        fields.push("fiber");
      }
    } else if (regime === "eu") {
      // EU carbohydrate excludes fibre, which carries its own 2 kcal / 8 kJ per gram.
      lo += (k.fiber ?? 0) * blo;
      hi += (k.fiber ?? 0) * bhi;
      fields.push("fiber");
    } else {
      // A Chinese label's carbohydrate may or may not include the fiber it declares, so
      // allow both: fiber inside carbs at 8 instead of 17 kJ/g, or fiber on top at 8.
      lo -= (k.carb - (k.fiber ?? 0)) * Math.min(bhi, chi);
      hi += (k.fiber ?? 0) * bhi;
      fields.push("fiber");
    }
  }
  lo = Math.max(0, lo);
  const ok = fits(lo, hi);
  const said = unit === "kcal" ? `Calories say ${formatNumber(e.value)}` : `Energy says ${formatAmount("kj", e.value)}`;
  const range = `${Math.round(lo)}–${Math.round(hi)}${unit === "kj" ? " kJ" : ""}`;
  return { id, check: "energy", fields, ok, message: `${said} but the macros allow ${range}.` };
}

/** Every check that could be evaluated on this column, passing or failing. Pure. */
export function runChecks(panel: ParsedPanel, columnIndex = 0, options: VerifyOptions = {}): CheckOutcome[] {
  const opts: Required<VerifyOptions> = {
    fiberAllowance: options.fiberAllowance ?? true,
    energyMargin: options.energyMargin ?? 0.01,
  };
  const regime = panel.regime;
  const col = panel.columns[columnIndex];
  if (!col) return [];
  const f = col.fields;
  const out: CheckOutcome[] = [];

  // grid — a value the regulation could never print.
  for (const key of Object.keys(f) as FieldKey[]) {
    const rv = f[key]!;
    out.push({
      id: `grid:${key}`,
      check: "grid",
      fields: [key],
      ok: onGrid(regime, key, rv.value),
      message: `${NAME[key]} ${formatAmount(key, rv.value)} is not a value a ${REGIME_NAME[regime]} label can print.`,
    });
  }

  // ref — the percentage column is a second copy of the amount.
  for (const key of Object.keys(col.refPct) as FieldKey[]) {
    const amount = f[key];
    const pct = col.refPct[key]!;
    if (!amount || referenceValue(regime, key) === undefined) continue;
    const allowed = allowedRefPct(regime, key, amount.value, amount.lessThan);
    const shown = allowed.length === 1 ? `${allowed[0]}%` : `${allowed[0]}–${allowed[allowed.length - 1]}%`;
    out.push({
      id: `ref:${key}`,
      check: "ref",
      fields: [key],
      ok: refFits(regime, key, amount, pct),
      message: `The ${formatNumber(pct.value)}% beside ${lower(key)} doesn't fit ${formatAmount(key, amount.value)}, which allows ${shown}.`,
    });
  }

  // energy — from the macros, in each unit the label prints.
  for (const unit of ["kcal", "kj"] as const) {
    const o = energyCheck(regime, col, unit, opts);
    if (o) out.push(o);
  }

  // units — kJ and kcal are two copies of one energy; salt is sodium × 2.5.
  if (f.kj && f.kcal) {
    const [jlo, jhi] = interval(regime, "kj", f.kj);
    const [clo, chi] = interval(regime, "kcal", f.kcal);
    // Each component's kJ/kcal factor ratio lies between fat's 37/9 and carbohydrate
    // and protein's 17/4 (fibre's 8/2 when fibre is declared), so any mix does too.
    const rMin = f.fiber ? 8 / 2 : 37 / 9;
    const rMax = 17 / 4;
    const margin = 0.01 * Math.max(f.kj.value, 1);
    out.push({
      id: "units:energy",
      check: "units",
      fields: ["kj", "kcal"],
      ok: jhi + margin >= rMin * clo && jlo - margin <= rMax * chi,
      message: `${formatAmount("kj", f.kj.value)} and ${formatAmount("kcal", f.kcal.value)} can't both be right: ${formatAmount("kcal", f.kcal.value)} is ${Math.round(rMin * f.kcal.value)}–${Math.round(rMax * f.kcal.value)} kJ.`,
    });
  }
  if (f.salt && f.sodium) {
    const [slo, shi] = interval(regime, "salt", f.salt);
    const [nlo, nhi] = interval(regime, "sodium", f.sodium);
    out.push({
      id: "units:salt",
      check: "units",
      fields: ["salt", "sodium"],
      ok: shi + 1e-9 >= (nlo * 2.5) / 1000 && slo - 1e-9 <= (nhi * 2.5) / 1000,
      message: `Salt ${formatAmount("salt", f.salt.value)} doesn't fit sodium ${formatAmount("sodium", f.sodium.value)}, which is ${formatNumber((f.sodium.value * 2.5) / 1000)} g of salt.`,
    });
  }

  // parts — a part can't exceed its total.
  for (const rel of PARTS[regime]) {
    const total = f[rel.total];
    const subs = rel.subs.filter((s) => f[s]);
    if (!total || subs.length === 0) continue;
    let ok: boolean;
    if (regime === "us") {
      // The research tolerance: 0.51 g on the printed numbers. Measured 0 false alarms on 192 labels.
      const sum = subs.reduce((a, s) => a + (f[s]!.lessThan ? 0 : f[s]!.value), 0);
      ok = sum <= total.value + 0.51;
    } else {
      // Unmeasured regimes: derived from rounding alone — the smallest the parts could
      // actually be must not exceed the largest the total could actually be.
      const sum = subs.reduce((a, s) => a + interval(regime, s, f[s]!)[0], 0);
      ok = sum <= interval(regime, rel.total, total)[1] + 1e-9;
    }
    const partText = subs.map((s) => `${lower(s)} ${formatAmount(s, f[s]!.value)}`).join(" plus ");
    out.push({
      id: rel.id,
      check: "parts",
      fields: [...subs, rel.total],
      ok,
      message: `${partText[0].toUpperCase()}${partText.slice(1)} is more than ${lower(rel.total)} ${formatAmount(rel.total, total.value)}.`,
    });
  }

  // mass — the macros can't weigh more than the food they are in.
  const grams =
    col.basis === "100g" ? 100 : col.basis === "serving" ? (col.servingGrams ?? panel.serving?.value) : undefined;
  // Per 100 ml is skipped: syrup and honey weigh well over 100 g per 100 ml.
  // EU carbohydrate excludes fibre, so there fibre is mass on top of it.
  const massKeys = (["prot", "carb", "fat", ...(regime === "eu" ? (["fiber"] as const) : [])] as FieldKey[]).filter(
    (k) => f[k],
  );
  if (grams !== undefined && grams > 0 && massKeys.length > 0) {
    const sum = massKeys.reduce((a, k) => a + (f[k]!.lessThan ? 0 : f[k]!.value), 0);
    out.push({
      id: "mass",
      check: "mass",
      fields: massKeys,
      ok: sum <= grams * 1.02 + 1.5,
      message: `The protein, carbs and fat add up to ${formatNumber(sum)} g, more than the ${formatNumber(grams)} g they are in.`,
    });
  }

  return out;
}

// ── verdicts ─────────────────────────────────────────────────────────────────

/**
 * US: which fields a passing verify() actually vouches for. MEASURED, not chosen:
 * tests/labelScan.research.test.ts applies every single misread of every field to
 * the 96 held-out labels, and a field is listed when under 15% of its misreads pass
 * every check. That test fails if these lists drift from what it measures.
 *
 *   full    the measured label: every check that involves the field ran, with the
 *           energy check passing WITHOUT the fiber allowance (see energyCheck).
 *   refOnly the field and its %DV alone, nothing else on the label.
 *   refPct  the %DV itself (only its amount can check it).
 *
 * Total sugars is in none of them: 43% of its misreads went silent. Protein (12.3%)
 * and total carbs (9.0%) are the closest to the line.
 */
export const US_CHECKABLE: { full: FieldKey[]; refOnly: FieldKey[]; refPct: FieldKey[] } = {
  full: ["kcal", "fat", "sat", "trans", "chol", "sodium", "carb", "fiber", "added", "prot"],
  refOnly: ["fat", "sat", "chol", "sodium", "carb", "fiber", "added"],
  refPct: ["fat", "sat", "chol", "sodium", "carb", "fiber", "added"],
};

/**
 * The relations that involve each field on a complete US label. The "full" verdict
 * only applies when every one of them ran, because that is the condition it was
 * measured under. The research test checks this table against runChecks() on a
 * complete label, so it cannot silently fall out of step with the checks.
 */
export const US_INVOLVES: Partial<Record<FieldKey, string[]>> = {
  kcal: ["energy:kcal"],
  fat: ["energy:kcal", "ref:fat", "parts:fat", "mass"],
  sat: ["ref:sat", "parts:fat"],
  trans: ["parts:fat"],
  chol: ["ref:chol"],
  sodium: ["ref:sodium"],
  carb: ["energy:kcal", "ref:carb", "parts:sugar", "parts:fiber", "mass"],
  fiber: ["ref:fiber", "parts:fiber"],
  sugar: ["parts:sugar", "parts:added"],
  added: ["ref:added", "parts:added"],
  prot: ["energy:kcal", "mass"],
};

// EU and China were not measured, so they get the conservative rule straight from
// types.ts rule 4: a field is checked only when a printed SECOND COPY of it was
// compared and agreed — its percentage, kJ against kcal, or salt against sodium.
const SECOND_COPY: Partial<Record<FieldKey, string>> = { kj: "units:energy", kcal: "units:energy", salt: "units:salt", sodium: "units:salt" };

function amountChecked(regime: Regime, key: FieldKey, ran: (id: string, key: FieldKey) => boolean): boolean {
  if (regime === "us") {
    if (US_CHECKABLE.refOnly.includes(key) && ran(`ref:${key}`, key)) return true;
    const needs = US_INVOLVES[key];
    return !!needs && US_CHECKABLE.full.includes(key) && needs.every((id) => ran(id, key));
  }
  const copy = SECOND_COPY[key];
  return ran(`ref:${key}`, key) || (!!copy && ran(copy, key));
}

/** Run every deterministic check on one column of a parsed panel. Pure: same panel in, same verdict out. */
export function verify(panel: ParsedPanel, columnIndex = 0): Verification {
  return verifyColumn(panel, columnIndex);
}

/** verify() with the measured options exposed, so the research test can switch one off and see what it bought. */
export function verifyColumn(panel: ParsedPanel, columnIndex = 0, options: VerifyOptions = {}): Verification {
  const regime = panel.regime;
  const col: PanelColumn = panel.columns[columnIndex] ?? { basis: "serving", fields: {}, refPct: {} };
  const outcomes = runChecks(panel, columnIndex, options);
  const failed = outcomes.filter((o) => !o.ok);
  const failures: CheckFailure[] = failed.map(({ check, fields, message }) => ({ check, fields, message }));
  const inConflict = new Set(failed.flatMap((o) => o.fields));
  const ran = (id: string, key: FieldKey) => outcomes.some((o) => o.id === id && o.fields.includes(key));

  const fields: Partial<Record<FieldKey, FieldVerdict>> = {};
  const refPct: Partial<Record<FieldKey, FieldVerdict>> = {};

  // Chinese labels made to the 2011 standard omit saturated fat and sugar legally.
  const mandatory = regime === "cn" ? MANDATORY_CN_2011 : MANDATORY[regime];
  for (const key of mandatory) if (!col.fields[key]) fields[key] = "missing";

  for (const key of Object.keys(col.fields) as FieldKey[]) {
    fields[key] = inConflict.has(key) ? "conflict" : amountChecked(regime, key, ran) ? "checked" : "unchecked";
  }

  for (const key of Object.keys(col.refPct) as FieldKey[]) {
    if (ran(`ref:${key}`, key)) {
      const trusted = regime !== "us" || US_CHECKABLE.refPct.includes(key);
      refPct[key] = inConflict.has(key) ? "conflict" : trusted ? "checked" : "unchecked";
    } else {
      refPct[key] = "unchecked";
    }
  }
  // The percentage column is mandatory in the US and China (not the EU, Art. 32(4)).
  if (regime !== "eu") {
    for (const key of Object.keys(col.fields) as FieldKey[]) {
      if (!col.refPct[key] && referenceValue(regime, key) !== undefined) refPct[key] = "missing";
    }
  }

  const order = [...MANDATORY[regime], ...(Object.keys(col.fields) as FieldKey[])];
  const needsConfirm: Verification["needsConfirm"] = ["serving"];
  for (const key of order) {
    const v = fields[key];
    if (v && v !== "checked" && !needsConfirm.includes(key)) needsConfirm.push(key);
  }

  return { consistent: failures.length === 0, column: col.basis, fields, refPct, failures, needsConfirm };
}
