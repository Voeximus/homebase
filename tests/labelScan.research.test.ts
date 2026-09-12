import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { onGrid } from "../src/lib/labelScan/rules";
import { US_CHECKABLE, US_INVOLVES, runChecks, verify, verifyColumn } from "../src/lib/labelScan/verify";
import { suggestRepairs } from "../src/lib/labelScan/repair";
import type { FieldKey, ParsedPanel, ReadValue } from "../src/lib/labelScan/types";

// This file holds the TypeScript verifier to the research in docs/research/label-parity.
//
// It does two separate things, and keeping them apart is the point:
//
//  1. A FAITHFUL PORT of label_channel.py / per_field.py — same checks, same channel,
//     same split — asserted to reproduce the Python counts EXACTLY. That proves the
//     fixture, the channel and the harness are the research's, so any gap in part 2
//     is caused by a rule, never by the plumbing.
//
//  2. The same experiments run through the PRODUCTION verify() and suggestRepairs(),
//     which encode the regulation more exactly than the research script did (the
//     rounding intervals at 50 kcal, 5 g fat, 5 and 140 mg sodium; a fiber allowance;
//     a repair search that runs the OCR channel backwards). Those numbers are asserted
//     against the research within the stated bands and printed.
//
// One finding from building this: the research's RANDOM 576-trial experiment is not
// reproducible even in Python. corruptions() returns a list built from a set, whose
// order depends on PYTHONHASHSEED, so random.choice picks differently each run. Over
// nine hash seeds it gave 92.2–94.8% caught, 68.8–75.0% correct repair and 2.4–4.2%
// wrong repair; the report's 93.2 / 72.7 / 4.0 is one draw. The EXHAUSTIVE per-field
// experiment is deterministic, so that is what the exact assertions use.

interface FixturePanel {
  name: string;
  servingGrams: number;
  declared: Record<string, number>;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/us-label-panels.json", import.meta.url), "utf-8")) as {
  panels: FixturePanel[];
};
const panels = fixture.panels;
const train = panels.slice(0, 96);
const test = panels.slice(96);

const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

// ── 1. the faithful port ─────────────────────────────────────────────────────

type Py = Record<string, number>;
const DV: Record<string, number> = { fat: 78, sat: 20, chol: 300, sodium: 2300, carb: 275, fiber: 28, added: 50 };

const near = (x: number, step: number) => Math.abs(x - Math.round(x / step) * step) <= 1e-6;
function pyOnLattice(field: string, v: number): boolean {
  if (v < 0) return false;
  if (field === "kcal") return v <= 50 ? near(v, 5) : near(v, 10);
  if (field === "fat" || field === "sat" || field === "trans") return v < 5 ? near(v, 0.5) : near(v, 1);
  if (field === "chol") return near(v, 5);
  if (field === "sodium") return v === 0 || (v <= 140 ? near(v, 5) : near(v, 10));
  return near(v, 1);
}
function pyInterval(field: string, d: number): [number, number] {
  if (field === "kcal") {
    if (d === 0) return [0, 5];
    const s = d <= 50 ? 5 : 10;
    return [d - s / 2, d + s / 2];
  }
  if (field === "fat" || field === "sat" || field === "trans") {
    if (d === 0) return [0, 0.5];
    const s = d < 5 ? 0.5 : 1;
    return [d - s / 2, d + s / 2];
  }
  if (field === "chol") return d === 0 ? [0, 2] : [d - 2.5, d + 2.5];
  if (field === "sodium") {
    if (d === 0) return [0, 5];
    const s = d <= 140 ? 5 : 10;
    return [d - s / 2, d + s / 2];
  }
  return d === 0 ? [0, 0.5] : [d - 0.5, d + 0.5];
}
function pyDvAllowed(field: string, d: number): Set<number> {
  const [lo, hi] = pyInterval(field, d);
  const a = Math.floor((lo / DV[field]) * 100 + 0.5);
  const b = Math.floor((hi / DV[field]) * 100 + 0.5);
  const s = new Set<number>([Math.floor((d / DV[field]) * 100 + 0.5)]);
  for (let i = a; i <= b; i++) s.add(i);
  return s;
}
function pyEnergyGap(p: Py): number {
  const [klo, khi] = pyInterval("kcal", p.kcal);
  const [plo, phi] = pyInterval("prot", p.prot);
  const [clo, chi] = pyInterval("carb", p.carb);
  const [flo, fhi] = pyInterval("fat", p.fat);
  const elo = 4 * plo + 4 * clo + 9 * flo;
  const ehi = 4 * phi + 4 * chi + 9 * fhi;
  if (khi < elo) return khi - elo;
  if (klo > ehi) return klo - ehi;
  return 0;
}
function q(xs: number[], a: number): number {
  const i = (xs.length - 1) * a;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}
const pyPanel = (f: FixturePanel): Py => ({ ...f.declared, _serving: f.servingGrams });
// The one calibrated allowance, fitted on the TRAIN half exactly as the research did.
const trainGaps = train.map((f) => pyEnergyGap(pyPanel(f)) / Math.max(f.declared.kcal, 1)).sort((a, b) => a - b);
const M_LO = Math.min(0, q(trainGaps, 0.01));
const M_HI = Math.max(0, q(trainGaps, 0.99));
function pyAtwaterOk(p: Py): boolean {
  const g = pyEnergyGap(p) / Math.max(p.kcal, 1);
  return M_LO - 0.01 <= g && g <= M_HI + 0.01;
}
function pyHierarchyOk(p: Py): boolean {
  const t = 0.51;
  let ok = true;
  if ("sat" in p) ok &&= p.sat + (p.trans ?? 0) <= p.fat + t;
  if ("sugar" in p) ok &&= p.sugar <= p.carb + t;
  if ("added" in p && "sugar" in p) ok &&= p.added <= p.sugar + t;
  if ("fiber" in p) ok &&= p.fiber <= p.carb + t;
  ok &&= p.prot + p.carb + p.fat <= p._serving * 1.02 + 1.5;
  return ok;
}
const fieldsOf = (p: Py) => Object.keys(p).filter((k) => !k.startsWith("_"));
const pyLatticeOk = (p: Py) => fieldsOf(p).every((k) => k.endsWith("%") || pyOnLattice(k, p[k]));
const pyDvOk = (p: Py) => Object.keys(DV).every((k) => !(k in p && `${k}%` in p) || pyDvAllowed(k, p[k]).has(p[`${k}%`]));
const PY_FULL = (p: Py) => pyAtwaterOk(p) && pyLatticeOk(p) && pyDvOk(p) && pyHierarchyOk(p);

function withDv(p: Py): Py {
  const out: Py = { ...p };
  for (const k of Object.keys(DV)) if (k in p) out[`${k}%`] = Math.floor((p[k] / DV[k]) * 100 + 0.5);
  return out;
}
const fmt = (v: number) => String(v);

// label_channel.py CONFUSE and corruptions(): the FORWARD channel, printed → read.
const CONFUSE: Record<string, string> = {
  "0": "689", "1": "74", "2": "7", "3": "8", "4": "1", "5": "68", "6": "508", "7": "12", "8": "3069", "9": "80",
};
function corruptions(s: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < s.length; i++) for (const c of CONFUSE[s[i]] ?? "") out.add(s.slice(0, i) + c + s.slice(i + 1));
  if (s.includes(".")) out.add(s.replace(".", ""));
  out.add(`${s}9`);
  if (s.length > 1) {
    out.add(s.slice(1));
    out.add(s.slice(0, -1));
  }
  out.delete(s);
  return [...out].filter((x) => x && !x.startsWith(".") && x.split(".").length <= 2);
}

// Python float() accepts every string this channel can produce ("0.", "09"), as does Number().
const parse = (x: string) => Number(x);

interface Tally {
  n: number;
  caught: number;
  fixed: number;
  wrongfix: number;
  /** Production only: the misread passed every check AND the misread field was marked "checked" — the harm that matters. */
  vouched?: number;
}
const tally = (): Tally => ({ n: 0, caught: 0, fixed: 0, wrongfix: 0 });

function pyDecode(read: Py, truth: Py): "fixed" | "wrong" | "ambiguous" | "none" {
  const fits = new Map<string, [string, number]>();
  for (const kk of fieldsOf(read)) {
    for (const cand of [fmt(read[kk]), ...corruptions(fmt(read[kk]))]) {
      const vv = parse(cand);
      if (Number.isNaN(vv) || vv === read[kk]) continue;
      if (PY_FULL({ ...read, [kk]: vv })) fits.set(`${kk}=${vv}`, [kk, vv]);
    }
  }
  if (fits.size === 1) {
    const [[k, v]] = [...fits.values()];
    return truth[k] === v ? "fixed" : "wrong";
  }
  return fits.size > 1 ? "ambiguous" : "none";
}

// per_field.py, run with PYTHONHASHSEED=0 (counts do not depend on the seed).
const PYTHON_PER_FIELD: Record<string, Tally> = {
  kcal: { n: 782, caught: 764, fixed: 480, wrongfix: 20 },
  fat: { n: 394, caught: 387, fixed: 326, wrongfix: 28 },
  "fat%": { n: 376, caught: 368, fixed: 326, wrongfix: 0 },
  sat: { n: 248, caught: 246, fixed: 187, wrongfix: 11 },
  "sat%": { n: 309, caught: 273, fixed: 163, wrongfix: 28 },
  trans: { n: 224, caught: 213, fixed: 192, wrongfix: 0 },
  chol: { n: 281, caught: 281, fixed: 220, wrongfix: 12 },
  "chol%": { n: 188, caught: 182, fixed: 147, wrongfix: 6 },
  sodium: { n: 866, caught: 829, fixed: 483, wrongfix: 52 },
  "sodium%": { n: 377, caught: 377, fixed: 259, wrongfix: 31 },
  carb: { n: 454, caught: 413, fixed: 278, wrongfix: 14 },
  "carb%": { n: 325, caught: 318, fixed: 275, wrongfix: 4 },
  fiber: { n: 157, caught: 157, fixed: 152, wrongfix: 0 },
  "fiber%": { n: 224, caught: 222, fixed: 174, wrongfix: 5 },
  sugar: { n: 444, caught: 253, fixed: 130, wrongfix: 11 },
  added: { n: 144, caught: 144, fixed: 95, wrongfix: 12 },
  "added%": { n: 226, caught: 214, fixed: 111, wrongfix: 35 },
  prot: { n: 341, caught: 299, fixed: 214, wrongfix: 0 },
};
const ORDER = ["kcal", "fat", "fat%", "sat", "sat%", "trans", "chol", "chol%", "sodium", "sodium%", "carb", "carb%", "fiber", "fiber%", "sugar", "added", "added%", "prot"];

// A seeded generator, so the random experiments give the same numbers on every run —
// the property the Python version turned out not to have.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample<T>(rand: () => number, xs: T[], n: number): T[] {
  const a = xs.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ── 2. the production verifier on the same panels ────────────────────────────

const rv = (value: number, raw = fmt(value)): ReadValue => ({ value, raw });

/** A fixture panel as the parser would hand it over: amounts, the %DV column, the serving. */
function toParsed(f: FixturePanel, opts: { refPct?: boolean } = {}): ParsedPanel {
  const fields: Partial<Record<FieldKey, ReadValue>> = {};
  const refPct: Partial<Record<FieldKey, ReadValue>> = {};
  for (const [k, v] of Object.entries(f.declared)) fields[k as FieldKey] = rv(v);
  if (opts.refPct !== false) {
    for (const k of Object.keys(DV)) {
      if (k in f.declared) refPct[k as FieldKey] = rv(Math.floor((f.declared[k] / DV[k]) * 100 + 0.5));
    }
  }
  return {
    regime: "us",
    regimeEvidence: "fixture",
    serving: rv(f.servingGrams),
    columns: [{ basis: "serving", servingGrams: f.servingGrams, fields, refPct }],
    warnings: [],
  };
}

/** The same panel with one token replaced by a misread. Token names follow the research: "fat" or "fat%". */
function misread(p: ParsedPanel, token: string, raw: string): ParsedPanel {
  const col = p.columns[0];
  const isPct = token.endsWith("%");
  const key = (isPct ? token.slice(0, -1) : token) as FieldKey;
  const value = rv(parse(raw), raw);
  const next = isPct
    ? { ...col, refPct: { ...col.refPct, [key]: value } }
    : { ...col, fields: { ...col.fields, [key]: value } };
  return { ...p, columns: [next] };
}

const tokensOf = (p: ParsedPanel) => [
  ...Object.keys(p.columns[0].fields),
  ...Object.keys(p.columns[0].refPct).map((k) => `${k}%`),
];
const truthOf = (p: ParsedPanel, token: string) =>
  token.endsWith("%") ? p.columns[0].refPct[token.slice(0, -1) as FieldKey]!.value : p.columns[0].fields[token as FieldKey]!.value;

function prodDecode(read: ParsedPanel, truth: ParsedPanel): "fixed" | "wrong" | "ambiguous" {
  const r = suggestRepairs(read);
  if (r.length !== 1) return "ambiguous";
  const token = r[0].target.kind === "refPct" ? `${r[0].target.field}%` : r[0].target.field;
  return truthOf(truth, token) === r[0].to ? "fixed" : "wrong";
}

const verdictOf = (v: ReturnType<typeof verify>, token: string) =>
  token.endsWith("%") ? v.refPct[token.slice(0, -1) as FieldKey] : v.fields[token as FieldKey];

// Heavy experiments are computed once and shared by the assertions below.
//   py      the faithful port
//   prod    production verify() + suggestRepairs(), as shipped
//   strict  production with the fiber allowance off — the condition "checked" is granted under
let exhaustive: { py: Record<string, Tally>; prod: Record<string, Tally>; strict: Record<string, Tally> } | undefined;
function runExhaustive() {
  if (exhaustive) return exhaustive;
  const py: Record<string, Tally> = {};
  const prod: Record<string, Tally> = {};
  const strict: Record<string, Tally> = {};
  for (const f of test) {
    const truthPy = withDv(pyPanel(f));
    const truthProd = toParsed(f);
    for (const k of fieldsOf(truthPy)) {
      for (const bad of corruptions(fmt(truthPy[k]))) {
        const v = parse(bad);
        if (Number.isNaN(v) || v === truthPy[k]) continue;

        const s = (py[k] ??= tally());
        s.n++;
        const readPy = { ...truthPy, [k]: v };
        if (!PY_FULL(readPy)) {
          s.caught++;
          const d = pyDecode(readPy, truthPy);
          if (d === "fixed") s.fixed++;
          if (d === "wrong") s.wrongfix++;
        }

        const t = (prod[k] ??= tally());
        const u = (strict[k] ??= tally());
        t.n++;
        u.n++;
        t.vouched ??= 0;
        u.vouched ??= 0;
        const readProd = misread(truthProd, k, bad);
        const vs = verifyColumn(readProd, 0, { fiberAllowance: false });
        if (!vs.consistent) u.caught++;
        else if (verdictOf(vs, k) === "checked") u.vouched++;
        const vd = verify(readProd);
        if (!vd.consistent) {
          t.caught++;
          const d = prodDecode(readProd, truthProd);
          if (d === "fixed") t.fixed++;
          if (d === "wrong") t.wrongfix++;
        } else if (verdictOf(vd, k) === "checked") {
          t.vouched++;
        }
      }
    }
  }
  exhaustive = { py, prod, strict };
  return exhaustive;
}

const total = (t: Record<string, Tally>) =>
  Object.values(t).reduce(
    (a, s) => ({ n: a.n + s.n, caught: a.caught + s.caught, fixed: a.fixed + s.fixed, wrongfix: a.wrongfix + s.wrongfix, vouched: (a.vouched ?? 0) + (s.vouched ?? 0) }),
    tally(),
  );

function printTable(title: string, t: Record<string, Tally>, ref?: Record<string, Tally>) {
  const hasV = Object.values(t).some((s) => s.vouched !== undefined);
  const lines = [
    title,
    `  ${"field".padEnd(9)} ${"misreads".padStart(8)} ${"caught".padStart(8)} ${"SILENT".padStart(8)}${hasV ? ` ${"VOUCHED".padStart(8)}` : ""} ${"auto-fix".padStart(9)} ${"WRONG fix".padStart(10)}${ref ? "   python silent" : ""}`,
  ];
  for (const k of ORDER) {
    const s = t[k];
    if (!s) continue;
    const r = ref?.[k];
    lines.push(
      `  ${k.padEnd(9)} ${String(s.n).padStart(8)} ${pct(s.caught, s.n).padStart(8)} ${pct(s.n - s.caught, s.n).padStart(8)}${hasV ? ` ${pct(s.vouched ?? 0, s.n).padStart(8)}` : ""} ${pct(s.fixed, s.n).padStart(9)} ${pct(s.wrongfix, s.n).padStart(10)}${r ? `   ${pct(r.n - r.caught, r.n).padStart(6)}` : ""}`,
    );
  }
  const a = total(t);
  lines.push(
    `  all: caught ${a.caught}/${a.n} = ${pct(a.caught, a.n)}${hasV ? `, silent AND marked checked ${a.vouched}/${a.n} = ${pct(a.vouched ?? 0, a.n)}` : ""}, correct repair ${pct(a.fixed, a.n)}, wrong repair ${pct(a.wrongfix, a.n)}`,
  );
  if (hasV) lines.push("  (VOUCHED = passed every check and the misread field was still marked \"checked\" — the harm that matters)");
  console.log(lines.join("\n"));
}

const SLOW = 600_000;

describe("label parity research — the fixture", () => {
  it("is the research's split and every recovered value sits on the US grid", () => {
    expect(panels).toHaveLength(192);
    let on = 0;
    let all = 0;
    for (const f of panels) {
      for (const [k, v] of Object.entries(f.declared)) {
        all++;
        if (onGrid("us", k as FieldKey, v)) on++;
      }
    }
    // Research: 99.2% of raw recovered values were within storage precision of a grid
    // point BEFORE snapping. The fixture is the snapped panel, so it must be 100%.
    console.log(`fixture values on the US grid: ${on}/${all}`);
    expect(on).toBe(all);
  });

  it("the energy check: 0 false alarms on all 192 real labels at the 1% margin", () => {
    // Research: the allowance calibrated on the train half is zero; one held-out label
    // (chocolate chip snack bars, 150 kcal) printed 1.5 kcal under what its ranges allow.
    expect(M_LO).toBe(0);
    expect(M_HI).toBe(0);
    const needMargin = panels.filter((f) => pyEnergyGap(pyPanel(f)) !== 0);
    console.log(`labels needing any margin beyond pure rounding: ${needMargin.length}/192 — ${needMargin.map((f) => `${f.name.trim()} (${pyEnergyGap(pyPanel(f))} kcal)`).join("; ")}`);
    expect(needMargin).toHaveLength(1);
    expect(panels.indexOf(needMargin[0])).toBeGreaterThanOrEqual(96);

    // Production, as shipped: 0 energy false alarms.
    const alarms = (opts: Parameters<typeof runChecks>[2]) =>
      panels.map((f, i) => ({ f, i, o: runChecks(toParsed(f), 0, opts).find((o) => o.check === "energy") })).filter((x) => x.o && !x.o.ok);
    expect(alarms({})).toHaveLength(0);

    // Label 154 is the same one, and production sees it more sharply. The research
    // treated a printed 5 g of fat as 4.5–5.5 g; 101.9(c)(2) rounds fat below 5 g in half
    // grams, so 5 g can only have come from 4.75 g or more. With that, the bar misses
    // 4/4/9 by 3.75 kcal — beyond the 1% margin — and only the fiber allowance explains
    // it: it declares 3 g fiber with 10 g protein, the profile of a bar that subtracts
    // fiber. So the one label that ever needed slack is evidence FOR the allowance.
    const strict = alarms({ fiberAllowance: false });
    expect(strict.map((x) => x.i)).toEqual([154]);
    const rescued = runChecks(toParsed(panels[154])).find((o) => o.check === "energy")!;
    expect(rescued.id).toBe("energy:kcal+fiber");

    const noMargin = alarms({ energyMargin: 0 });
    console.log(
      `production energy alarms: shipped 0/192; allowance off ${strict.length}/192 (#${strict.map((x) => x.i).join(", #")}); ` +
        `margin 0 with the allowance ${noMargin.length}/192`,
    );
    expect(noMargin).toHaveLength(0);
  });

  it("with every check on, exactly one real label contradicts itself — and it really does", () => {
    // The research never ran its checks on the clean panels, so it never saw this.
    // USDA's record for "BREAD & BUTTER SWEET CHIPS" (Sapidus, GTIN 850012565086) stores
    // carbohydrate 14.3 g and total sugars 17.9 g per 100 g; at the 28 g serving that is
    // a label printing 4 g carbs and 5 g sugars. Sugars cannot exceed the carbohydrate
    // they are part of, so flagging it is correct, not a false alarm. It is in the
    // calibration half (index 39), so it touches none of the held-out numbers.
    const flagged = panels.map((f, i) => ({ f, i, v: verify(toParsed(f)) })).filter((x) => !x.v.consistent);
    expect(flagged.map((x) => x.i)).toEqual([39]);
    expect(flagged[0].v.failures.map((x) => x.check)).toEqual(["parts"]);
    expect(flagged[0].v.failures[0].fields).toEqual(["sugar", "carb"]);
  });
});

describe("label parity research — the faithful port reproduces Python exactly", () => {
  it(
    "per_field.py: every single misread on the 96 held-out labels",
    () => {
      const { py } = runExhaustive();
      printTable("PORT of per_field.py (must equal Python)", py);
      for (const k of ORDER) expect(py[k], k).toEqual(PYTHON_PER_FIELD[k]);
      // Python: caught 5940/6360 = 93.4%; exhaustive decode 4212 fixed (66.2%), 269 wrong (4.2%).
      expect(total(py)).toMatchObject({ n: 6360, caught: 5940, fixed: 4212, wrongfix: 269 });
    },
    SLOW,
  );
});

describe("label parity research — the production verifier", () => {
  it(
    "catches ≥ 92% of every single misread, and total sugars is never 'checked'",
    () => {
      const { py, prod, strict } = runExhaustive();
      printTable("PRODUCTION verify() + suggestRepairs(), every single misread, held-out 96", prod, py);
      printTable("PRODUCTION with the fiber allowance OFF — the condition US_CHECKABLE is measured under", strict, py);
      const a = total(prod);
      // Research 93.4%.
      expect(a.caught / a.n).toBeGreaterThanOrEqual(0.92);
      expect(Math.abs(a.caught / a.n - 5940 / 6360)).toBeLessThanOrEqual(0.02);

      // The verdict tables in verify.ts must be exactly what this measures. "full" is
      // granted only when the energy check passed without the fiber allowance, so it is
      // measured with the allowance off.
      const silent = (k: string) => 1 - strict[k].caught / strict[k].n;
      const fieldsKeys = ORDER.filter((k) => !k.endsWith("%"));
      const measuredFull = fieldsKeys.filter((k) => silent(k) < 0.15);
      const measuredRefPct = ORDER.filter((k) => k.endsWith("%") && silent(k) < 0.15).map((k) => k.slice(0, -1));
      expect([...US_CHECKABLE.full].sort()).toEqual([...measuredFull].sort());
      expect([...US_CHECKABLE.refPct].sort()).toEqual([...measuredRefPct].sort());
      expect(US_CHECKABLE.full).not.toContain("sugar");
      expect(silent("sugar")).toBeGreaterThan(0.3); // research 43.0%
    },
    SLOW,
  );

  it(
    "single-misread decode: correct and wrong repair rates, wrong ≤ 6%",
    () => {
      const { prod } = runExhaustive();
      const a = total(prod);
      console.log(
        `exhaustive decode — production: correct ${pct(a.fixed, a.n)}, wrong ${pct(a.wrongfix, a.n)} ` +
          `(Python exhaustive: correct 66.2%, wrong 4.2%; report's random draw: 72.7% / 4.0%)`,
      );
      expect(a.wrongfix / a.n).toBeLessThanOrEqual(0.06);
    },
    SLOW,
  );

  it(
    "decode against misreads the repair model does NOT know",
    () => {
      // Why this exists: suggestRepairs() runs the simulated channel exactly backwards,
      // so on that channel the true value is always among the candidates, and a clean
      // label always fits — a unique fit is then the truth almost by construction. The
      // near-zero wrong-repair rate above says the SEARCH is sound, not that repairs are
      // safe on a real camera. Real OCR also makes errors outside any model, so here the
      // misreads are ones the repair model cannot undo: two adjacent digits swapped
      // ("12" → "21") and a doubled digit ("12" → "122"). Any unique repair offered for
      // these is WRONG, which is the honest upper edge of the risk rule 2 guards against.
      let n = 0;
      let caught = 0;
      let wrong = 0;
      for (const f of test) {
        const truth = toParsed(f);
        for (const token of tokensOf(truth)) {
          const s = fmt(truthOf(truth, token));
          const bads = new Set<string>();
          for (let i = 0; i + 1 < s.length; i++) if (/\d\d/.test(s.slice(i, i + 2))) bads.add(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2));
          for (let i = 0; i < s.length; i++) if (/\d/.test(s[i])) bads.add(s.slice(0, i + 1) + s[i] + s.slice(i + 1));
          for (const bad of bads) {
            if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(bad) || parse(bad) === truthOf(truth, token)) continue;
            n++;
            const read = misread(truth, token, bad);
            if (verify(read).consistent) continue;
            caught++;
            if (suggestRepairs(read).length === 1) wrong++;
          }
        }
      }
      console.log(`unmodelled misreads (swapped / doubled digit): n=${n}, caught ${pct(caught, n)}, a unique — therefore wrong — repair offered for ${pct(wrong, n)}`);
      expect(n).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "the %DV-alone condition that verify.ts's refOnly list rests on",
    () => {
      // A partial read — a field and its %DV and nothing else — still earns "checked"
      // for the fields listed in US_CHECKABLE.refOnly. Measured here, not assumed.
      const t: Record<string, Tally> = {};
      for (const f of test) {
        const full = toParsed(f);
        for (const k of Object.keys(DV) as FieldKey[]) {
          const amount = full.columns[0].fields[k];
          const pctRv = full.columns[0].refPct[k];
          if (!amount || !pctRv) continue;
          const alone: ParsedPanel = { ...full, serving: undefined, columns: [{ basis: "serving", fields: { [k]: amount }, refPct: { [k]: pctRv } }] };
          for (const bad of corruptions(fmt(amount.value))) {
            if (parse(bad) === amount.value) continue;
            const s = (t[k] ??= tally());
            s.n++;
            if (!verify(misread(alone, k, bad)).consistent) s.caught++;
          }
        }
      }
      printTable("field + its %DV ALONE (grid and ref checks only)", t);
      const measured = Object.keys(t).filter((k) => 1 - t[k].caught / t[k].n < 0.15);
      expect([...US_CHECKABLE.refOnly].sort()).toEqual(measured.sort());
    },
    SLOW,
  );

  it("US_INVOLVES matches what runChecks actually evaluates on a complete label", () => {
    const complete = test.find((f) => ["sat", "trans", "sugar", "added", "fiber"].every((k) => k in f.declared))!;
    const outcomes = runChecks(toParsed(complete));
    for (const [key, ids] of Object.entries(US_INVOLVES)) {
      const actual = outcomes.filter((o) => o.check !== "grid" && o.fields.includes(key as FieldKey)).map((o) => o.id);
      expect([...actual].sort(), key).toEqual([...ids!].sort());
    }
  });

  it(
    "the %DV column's own absence: what each amount is worth without it",
    () => {
      // Reported, not encoded: without its %DV an amount is "unchecked" (US_INVOLVES
      // requires the ref check to have run). This prints whether that is conservative.
      const t: Record<string, Tally> = {};
      for (const f of test) {
        const full = toParsed(f);
        for (const k of Object.keys(DV) as FieldKey[]) {
          const amount = full.columns[0].fields[k];
          if (!amount) continue;
          const refPct = { ...full.columns[0].refPct };
          delete refPct[k];
          const without: ParsedPanel = { ...full, columns: [{ ...full.columns[0], refPct }] };
          for (const bad of corruptions(fmt(amount.value))) {
            if (parse(bad) === amount.value) continue;
            const s = (t[k] ??= tally());
            s.n++;
            if (!verify(misread(without, k, bad)).consistent) s.caught++;
          }
        }
      }
      printTable("amount with its OWN %DV removed (everything else present)", t);
    },
    SLOW,
  );

  it(
    "fiber allowance: what widening the low side by 4 kcal per gram of fiber costs",
    () => {
      const { prod, strict } = runExhaustive();
      const on = total(prod);
      const off = total(strict);
      const rows = ORDER.filter((k) => prod[k].caught !== strict[k].caught || prod[k].vouched !== strict[k].vouched).map(
        (k) =>
          `${k}: caught ${pct(strict[k].caught, strict[k].n)} → ${pct(prod[k].caught, prod[k].n)}; ` +
          `silent-and-checked ${pct(strict[k].vouched ?? 0, strict[k].n)} → ${pct(prod[k].vouched ?? 0, prod[k].n)}`,
      );
      console.log(
        `fiber allowance — caught without: ${off.caught}/${off.n} (${pct(off.caught, off.n)}); with: ${on.caught}/${on.n} (${pct(on.caught, on.n)}); ` +
          `misreads that stop raising a conflict because of it: ${off.caught - on.caught}\n` +
          `  silent AND marked checked — without: ${off.vouched}; with: ${on.vouched}\n  ${rows.join("\n  ") || "no field changed"}`,
      );
      // Split the cost: misreads on label 154 (which only the allowance keeps from being a
      // false alarm) versus misreads on labels that pass the strict check anyway, and what
      // the 1% margin costs now that no label needs it.
      let on154 = 0;
      let elsewhere = 0;
      let marginCost = 0;
      for (const f of test) {
        const truth = toParsed(f);
        for (const token of tokensOf(truth)) {
          for (const bad of corruptions(fmt(truthOf(truth, token)))) {
            if (parse(bad) === truthOf(truth, token)) continue;
            const read = misread(truth, token, bad);
            const dflt = verify(read).consistent;
            if (dflt && !verifyColumn(read, 0, { fiberAllowance: false }).consistent) {
              if (f === panels[154]) on154++;
              else elsewhere++;
            }
            if (dflt && !verifyColumn(read, 0, { energyMargin: 0 }).consistent) marginCost++;
          }
        }
      }
      console.log(
        `  of those ${off.caught - on.caught}: ${on154} are on label 154 itself, ${elsewhere} on labels that pass the strict check\n` +
          `  the 1% energy margin, with the allowance on: ${marginCost} misreads pass only because of it`,
      );
      const withFiber = panels.filter((f) => (f.declared.fiber ?? 0) > 0).length;
      console.log(`fixture labels declaring any fiber: ${withFiber}/192; declaring ≥ 5 g: ${panels.filter((f) => (f.declared.fiber ?? 0) >= 5).length}`);
      // Decision guards. The allowance may cost at most half a point of detection, and it
      // must not make a single calories or protein misread both silent and "checked" —
      // those are the fields whose confirmation rests on the energy check, and a pass that
      // needed the allowance does not confirm them.
      //
      // Other fields can move by a misread or two, and that is label 154, not a leak: with
      // the allowance off that clean label is itself a false alarm, so every misread on it
      // counts as "caught" for free. With it on, the label is consistent again and its %DV
      // misreads are judged on their own evidence, as on every other label.
      expect((off.caught - on.caught) / on.n).toBeLessThanOrEqual(0.005);
      for (const k of ["kcal", "prot"]) expect(prod[k].vouched, k).toBeLessThanOrEqual(strict[k].vouched!);
    },
    SLOW,
  );

  it(
    "seeded random trials: one misread (576) and two simultaneous misreads (576)",
    () => {
      const rand = mulberry32(20260912);
      const run = (nErr: number) => {
        const r = { n: 0, caught: 0, fixed: 0, wrong: 0, pyN: 0, pyCaught: 0 };
        for (const f of test) {
          const truthPy = withDv(pyPanel(f));
          const truthProd = toParsed(f);
          const keys = fieldsOf(truthPy);
          for (let trial = 0; trial < 6; trial++) {
            const chosen = sample(rand, keys, nErr);
            let readPy = { ...truthPy };
            let readProd = truthProd;
            let ok = true;
            for (const k of chosen) {
              const c = corruptions(fmt(truthPy[k]));
              if (c.length === 0) {
                ok = false;
                break;
              }
              const bad = c[Math.floor(rand() * c.length)];
              readPy = { ...readPy, [k]: parse(bad) };
              readProd = misread(readProd, k, bad);
            }
            if (!ok || chosen.every((k) => readPy[k] === truthPy[k])) continue;
            r.n++;
            if (!PY_FULL(readPy)) r.pyCaught++;
            if (!verify(readProd).consistent) {
              r.caught++;
              if (nErr === 1) {
                const d = prodDecode(readProd, truthProd);
                if (d === "fixed") r.fixed++;
                if (d === "wrong") r.wrong++;
              }
            }
          }
        }
        return r;
      };
      const one = run(1);
      const two = run(2);
      console.log(
        `seeded, one misread: n=${one.n}, caught ${pct(one.caught, one.n)} (port ${pct(one.pyCaught, one.n)}; research 93.2%), ` +
          `correct repair ${pct(one.fixed, one.n)} (research 72.7%), wrong ${pct(one.wrong, one.n)} (research 4.0%)`,
      );
      console.log(`seeded, two misreads: n=${two.n}, caught ${pct(two.caught, two.n)} (port ${pct(two.pyCaught, two.n)}; research 99.7%)`);
      expect(one.wrong / one.n).toBeLessThanOrEqual(0.06);
      expect(two.caught / two.n).toBeGreaterThanOrEqual(0.98);
    },
    SLOW,
  );
});
