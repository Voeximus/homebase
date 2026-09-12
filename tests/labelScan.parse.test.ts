import { describe, it, expect } from "vitest";
import { parseLabel } from "../src/lib/labelScan/parse";
import type { FieldKey, OcrPage, ParsedPanel } from "../src/lib/labelScan/types";
import fixture from "./fixtures/us-label-panels.json";
import {
  DRV,
  HARSH,
  percentDV,
  renderPanel,
  tableSpec,
  usPanelSpec,
  type Line,
  type UsField,
} from "./helpers/labelLayout";

// The parser's promise is narrow and absolute: whatever the OCR engine split,
// merged, skewed or shuffled, every number printed on the panel comes back as
// exactly the number printed, attached to the right row and the right column —
// and nothing is "corrected" on the way (types.ts rule 1). These tests hold it
// to that on the 192 real US panels from the research, under deliberately
// hostile tokenisation, and on hand-built EU and Chinese panels.

type Panel = { name: string; servingGrams: number; declared: Partial<Record<UsField, number>> };
const PANELS = (fixture as { panels: Panel[] }).panels;

const SEEDS = [1, 2, 3, 4, 5];

/** Every way a parsed US panel can differ from what was printed, as readable strings. */
function diffUs(p: Panel, servings: number, got: ParsedPanel | null): string[] {
  if (!got) return ["returned null"];
  const out: string[] = [];
  if (got.regime !== "us") out.push(`regime ${got.regime}`);
  if (got.columns.length !== 1) out.push(`${got.columns.length} columns`);
  const col = got.columns[0];
  if (!col) return out;
  if (col.basis !== "serving") out.push(`basis ${col.basis}`);
  if (got.serving?.value !== p.servingGrams) out.push(`serving ${got.serving?.value} ≠ ${p.servingGrams}`);
  if (got.servingsPerContainer?.value !== servings) out.push(`servings ${got.servingsPerContainer?.value} ≠ ${servings}`);
  const declaredKeys = Object.keys(p.declared) as UsField[];
  for (const f of declaredKeys) {
    const v = p.declared[f]!;
    if (col.fields[f]?.value !== v) out.push(`${f} ${col.fields[f]?.value} ≠ ${v}`);
    const pct = percentDV(f, v);
    if (pct !== undefined && col.refPct[f]?.value !== pct) out.push(`${f}% ${col.refPct[f]?.value} ≠ ${pct}`);
  }
  for (const f of Object.keys(col.fields)) if (!(f in p.declared)) out.push(`extra field ${f}`);
  for (const f of Object.keys(col.refPct)) if (!(f in p.declared) || !(f in DRV)) out.push(`extra % ${f}`);
  return out;
}

describe("round trip — the 192 real US panels", () => {
  it("recovers every declared value and %DV exactly from a clean layout", () => {
    const failures: string[] = [];
    PANELS.forEach((p, i) => {
      const page = renderPanel(usPanelSpec({ ...p, servings: 8 }), { seed: i });
      const d = diffUs(p, 8, parseLabel(page));
      if (d.length) failures.push(`#${i} ${p.name}: ${d.join("; ")}`);
    });
    expect(failures).toEqual([]);
  });

  it.each(SEEDS)("recovers them all under split/merge/skew/shuffle/noise, seed %i", (seed) => {
    const failures: string[] = [];
    PANELS.forEach((p, i) => {
      const servings = 2 + ((i * 7 + seed) % 11);
      const page = renderPanel(usPanelSpec({ ...p, servings }), HARSH(seed * 1000 + i));
      const d = diffUs(p, servings, parseLabel(page));
      if (d.length) failures.push(`#${i} ${p.name}: ${d.join("; ")}`);
    });
    const rate = ((PANELS.length - failures.length) / PANELS.length) * 100;
    // The rate is in the message so a regression reports how bad, not just that.
    expect(failures, `seed ${seed}: ${rate.toFixed(1)}% of panels fully recovered`).toEqual([]);
  });

  // A phone held off level ROTATES the panel (rows slope and columns lean), which
  // is not the shear above. At 3° the FDA sample label's whole %DV column once
  // slipped a row; real photos run 2–6°, so the round trip holds at ±6°.
  it.each(SEEDS)("recovers them all from a photo tilted up to ±6°, seed %i", (seed) => {
    const failures: string[] = [];
    PANELS.forEach((p, i) => {
      const servings = 2 + ((i * 7 + seed) % 11);
      const page = renderPanel(usPanelSpec({ ...p, servings }), { ...HARSH(seed * 1000 + i), tilt: 6 });
      const d = diffUs(p, servings, parseLabel(page));
      if (d.length) failures.push(`#${i} ${p.name}: ${d.join("; ")}`);
    });
    const rate = ((PANELS.length - failures.length) / PANELS.length) * 100;
    expect(failures, `tilt seed ${seed}: ${rate.toFixed(1)}% of panels fully recovered`).toEqual([]);
  });

  it("keeps raw as the printed text and points at the source token", () => {
    const p = PANELS[0];
    const page = renderPanel(usPanelSpec({ ...p, servings: 8 }), HARSH(77));
    const got = parseLabel(page)!;
    for (const [f, rv] of Object.entries(got.columns[0].fields)) {
      expect(rv.token, f).toBeDefined();
      // The token the value points at really contains the raw digits.
      expect(page.tokens[rv.token!].text, f).toContain(rv.raw.replace(/^</, ""));
    }
  });
});

describe("US edge text", () => {
  const base = {
    servingGrams: 55,
    household: "2/3 cup",
    servings: 8,
    declared: { kcal: 230, fat: 8, sat: 1, trans: 0, chol: 0, sodium: 1200, carb: 37, fiber: 1, sugar: 1, added: 10, prot: 3 },
  };

  it("reads <1g, less than 1g, 1,200mg, the added-sugars phrase and a bare Trans Fat row", () => {
    const spec = usPanelSpec({ ...base, amountText: { fiber: "<1g", sugar: "less than 1g" } });
    const got = parseLabel(renderPanel(spec, { seed: 3, split: 0.5, jitter: 1 }))!;
    const col = got.columns[0];
    expect(col.fields.fiber).toMatchObject({ value: 1, raw: "<1", lessThan: true });
    expect(col.fields.sugar).toMatchObject({ value: 1, raw: "less than 1", lessThan: true });
    expect(col.fields.sodium).toMatchObject({ value: 1200, raw: "1,200" });
    expect(col.refPct.sodium?.value).toBe(52);
    expect(col.fields.added).toMatchObject({ value: 10, raw: "10" });
    expect(col.refPct.added?.value).toBe(20);
    expect(col.fields.trans).toMatchObject({ value: 0, raw: "0" });
    expect(col.refPct.trans).toBeUndefined();
    expect(got.serving).toMatchObject({ value: 55, raw: "55" });
    expect(got.servingText).toBe("2/3 cup (55g)");
    expect(got.servingsPerContainer?.value).toBe(8);
    expect(got.regimeEvidence).toContain("Nutrition Facts");
  });

  it("reads 'about 8 servings per container' and 'Servings Per Container About 8'", () => {
    for (const text of ["about 8 servings per container", "Servings Per Container About 8"]) {
      const spec = usPanelSpec(base);
      spec.lines[1] = { size: 12, cells: [{ text, x: 0 }] };
      const got = parseLabel(renderPanel(spec, { seed: 1 }))!;
      expect(got.servingsPerContainer, text).toMatchObject({ value: 8, raw: "8" });
    }
  });

  it("the '99' case: a Total Fat whose g was read as 9 comes back as 99, untouched", () => {
    const spec = usPanelSpec({ ...base, declared: { ...base.declared, fat: 9 }, amountText: { fat: "99" } });
    const got = parseLabel(renderPanel(spec, HARSH(99)))!;
    const col = got.columns[0];
    // Rule 1: the 12% beside it only fits 9 g, but deciding that is verify()'s job.
    expect(col.fields.fat).toMatchObject({ value: 99, raw: "99" });
    expect(col.refPct.fat?.value).toBe(12);
    expect(got.warnings.some((w) => w.includes('"99" has no unit'))).toBe(true);
  });

  it("maps a letter in a digit slot, keeps the raw letter, and says so", () => {
    const spec = usPanelSpec({ ...base, amountText: { trans: "Og", chol: "Omg" } });
    const got = parseLabel(renderPanel(spec, { seed: 2 }))!;
    const col = got.columns[0];
    expect(col.fields.trans).toMatchObject({ value: 0, raw: "O" });
    expect(col.fields.chol).toMatchObject({ value: 0, raw: "O" });
    expect(got.warnings.filter((w) => w.includes('read the letters in "O"')).length).toBe(2);
  });

  it("matches label letters fuzzily without touching numbers: 'Tota1 Fat', 'Saturted Fat'", () => {
    const spec = usPanelSpec(base);
    for (const line of spec.lines) {
      for (const c of line.cells) c.text = c.text.replace("Total Fat", "Tota1 Fat").replace("Saturated", "Saturted");
    }
    const col = parseLabel(renderPanel(spec, { seed: 4 }))!.columns[0];
    expect(col.fields.fat?.value).toBe(8);
    expect(col.fields.sat?.value).toBe(1);
  });

  it("the merged-token torture case: 'TotalFat9g12%'", () => {
    const tok = (text: string, x: number, y: number, h = 14) => ({ text, x, y, w: text.length * 7.7, h });
    const page: OcrPage = {
      width: 400,
      height: 300,
      engine: "test",
      // Deliberately out of reading order.
      tokens: [
        tok("Sodium65mg3%", 20, 188),
        tok("NutritionFacts", 20, 20, 26),
        tok("TotalFat9g12%", 20, 148),
        tok("Serving size", 20, 70),
        tok("(40g)", 280, 70),
        tok("Calories190", 20, 110, 22),
        tok("Protein6g", 20, 208),
        tok("SaturatedFat3.5g18%", 34, 168),
      ],
    };
    const got = parseLabel(page)!;
    const col = got.columns[0];
    expect(got.regime).toBe("us");
    expect(col.fields.kcal).toMatchObject({ value: 190, raw: "190" });
    expect(col.fields.fat).toMatchObject({ value: 9, raw: "9" });
    expect(col.refPct.fat).toMatchObject({ value: 12, raw: "12" });
    expect(col.fields.sat).toMatchObject({ value: 3.5, raw: "3.5" });
    expect(col.refPct.sat?.value).toBe(18);
    expect(col.fields.sodium).toMatchObject({ value: 65, raw: "65" });
    expect(col.refPct.sodium?.value).toBe(3);
    expect(col.fields.prot?.value).toBe(6);
    expect(got.serving?.value).toBe(40);
  });
});

describe("US dual column", () => {
  const S = 170; // per-serving amount right edge
  const SP = 220; // its %DV
  const C = 290; // per-container amount
  const CP = 340; // its %DV
  const row = (label: string, a: string, ap: string | null, b: string, bp: string | null, indent = 0): Line => ({
    size: 13,
    cells: [
      { text: label, x: indent },
      { text: a, x: S, align: "right" },
      ...(ap ? [{ text: ap, x: SP, align: "right" as const }] : []),
      { text: b, x: C, align: "right" },
      ...(bp ? [{ text: bp, x: CP, align: "right" as const }] : []),
    ],
  });
  const spec = {
    lines: [
      { size: 26, cells: [{ text: "Nutrition Facts", x: 0 }] },
      { size: 12, cells: [{ text: "2 servings per container", x: 0 }] },
      { size: 14, cells: [{ text: "Serving size", x: 0 }, { text: "1 cup (255g)", x: CP, align: "right" as const }] },
      { size: 12, cells: [{ text: "Per serving", x: SP, align: "right" as const }, { text: "Per container", x: CP, align: "right" as const }] },
      { cells: [{ text: "Calories", x: 0, size: 20 }, { text: "220", x: SP, align: "right" as const, size: 26 }, { text: "440", x: CP, align: "right" as const, size: 26 }] },
      { size: 11, cells: [{ text: "% DV*", x: SP, align: "right" as const }, { text: "% DV*", x: CP, align: "right" as const }] },
      row("Total Fat", "5g", "6%", "10g", "13%"),
      row("Saturated Fat", "2g", "10%", "4g", "20%", 12),
      row("Trans Fat", "0g", null, "0g", null, 12),
      row("Cholesterol", "15mg", "5%", "30mg", "10%"),
      row("Sodium", "240mg", "10%", "480mg", "21%"),
      row("Total Carb.", "35g", "13%", "70g", "25%"),
      row("Dietary Fiber", "6g", "21%", "12g", "43%", 12),
      row("Total Sugars", "7g", null, "14g", null, 12),
      row("Incl. Added Sugars", "4g", "8%", "8g", "16%", 24),
      row("Protein", "9g", null, "18g", null),
    ] as Line[],
  };

  // Tilted seeds matter most here: with two amount columns, a leaning page walks
  // the per-container amounts toward the per-serving column centre down the panel.
  it.each([[0, 0], [1, 0], [2, 0], [3, 6], [4, 6], [5, 6]])("gives per serving first, per container second (seed %i, tilt ±%i°)", (seed, tilt) => {
    const got = parseLabel(renderPanel(spec, seed === 0 ? { seed: 5 } : { ...HARSH(seed), skew: 1, merge: 0.2, tilt }))!;
    expect(got.columns).toHaveLength(2);
    const [serving, container] = got.columns;
    expect(serving.basis).toBe("serving");
    expect(serving.servingGrams).toBe(255);
    expect(serving.fields).toMatchObject({ kcal: { value: 220 }, fat: { value: 5 }, sodium: { value: 240 }, added: { value: 4 }, prot: { value: 9 } });
    expect(serving.refPct).toMatchObject({ fat: { value: 6 }, sodium: { value: 10 }, added: { value: 8 } });
    expect(container.basis).toBe("serving");
    expect(container.fields).toMatchObject({ kcal: { value: 440 }, fat: { value: 10 }, sodium: { value: 480 }, added: { value: 8 }, prot: { value: 18 } });
    expect(container.refPct).toMatchObject({ fat: { value: 13 }, fiber: { value: 43 }, added: { value: 16 } });
    expect(got.servingsPerContainer?.value).toBe(2);
  });
});

describe("EU", () => {
  const COLS = [230, 360];
  const rows = (energy: Array<Array<string | null>>, comma: boolean) => {
    const n = (s: string) => (comma ? s.replace(".", ",") : s);
    return [
      ...energy,
      ["Fat", n("9.5g"), n("2.9g")],
      ["of which saturates", n("1.2g"), n("0.4g")],
      ["Carbohydrate", "31g", n("9.3g")],
      ["of which sugars", "10g", n("3.0g")],
      ["Fibre", n("4.5g"), n("1.4g")],
      ["Protein", "12g", n("3.6g")],
      ["Salt", n("0.75g"), n("0.23g")],
    ];
  };
  const expectEu = (got: ParsedPanel | null) => {
    expect(got?.regime).toBe("eu");
    const [per100, portion] = got!.columns;
    expect(per100.basis).toBe("100g");
    expect(portion.basis).toBe("serving");
    expect(portion.servingGrams).toBe(30);
    expect(got!.serving?.value).toBe(30);
    const want100: Partial<Record<FieldKey, number>> = { kj: 1046, kcal: 250, fat: 9.5, sat: 1.2, carb: 31, sugar: 10, fiber: 4.5, prot: 12, salt: 0.75 };
    const wantPortion: Partial<Record<FieldKey, number>> = { kj: 314, kcal: 75, fat: 2.9, sat: 0.4, carb: 9.3, sugar: 3, fiber: 1.4, prot: 3.6, salt: 0.23 };
    for (const [f, v] of Object.entries(want100)) expect(per100.fields[f as FieldKey]?.value, `100g ${f}`).toBe(v);
    for (const [f, v] of Object.entries(wantPortion)) expect(portion.fields[f as FieldKey]?.value, `portion ${f}`).toBe(v);
  };
  const header = ["Typical values", "per 100g", "per 30g portion"];

  it.each([[0, 0], [1, 0], [2, 0], [3, 6], [4, 6], [5, 6]])("energy on one line '1046 kJ / 250 kcal' (seed %i, tilt ±%i°)", (seed, tilt) => {
    const spec = tableSpec({ title: ["Nutrition information"], header, columns: COLS, rows: rows([["Energy", "1046 kJ / 250 kcal", "314 kJ / 75 kcal"]], false) });
    expectEu(parseLabel(renderPanel(spec, seed ? { ...HARSH(seed), merge: 0.2, tight: 0, tilt } : { seed: 9 })));
  });

  it("energy merged as '1046kJ/250kcal'", () => {
    const spec = tableSpec({ title: ["Nutrition information"], header, columns: COLS, rows: rows([["Energy", "1046kJ/250kcal", "314kJ/75kcal"]], false) });
    expectEu(parseLabel(renderPanel(spec, { seed: 10, jitter: 1 })));
  });

  it.each([0, 1, 2])("energy on two lines, with decimal commas (seed %i)", (seed) => {
    const spec = tableSpec({
      title: ["Nutrition information"],
      header,
      columns: COLS,
      rows: rows([["Energy", "1046kJ", "314kJ"], [null, "250kcal", "75kcal"]], true),
    });
    const got = parseLabel(renderPanel(spec, seed ? { ...HARSH(seed), merge: 0.2 } : { seed: 11 }));
    expectEu(got);
    expect(got!.columns[0].fields.fat?.raw).toBe("9,5");
    expect(got!.warnings.some((w) => w.includes('read "9,5" as 9.5 (a decimal comma)'))).toBe(true);
  });

  it("sodium printed in grams becomes mg, and the conversion is reported", () => {
    const spec = tableSpec({
      title: ["Nutrition information"],
      header,
      columns: COLS,
      rows: [...rows([["Energy", "1046 kJ / 250 kcal", "314 kJ / 75 kcal"]], false), ["Sodium", "0.3g", "0.09g"]],
    });
    const got = parseLabel(renderPanel(spec, { seed: 12 }))!;
    expect(got.columns[0].fields.sodium).toMatchObject({ value: 300, raw: "0.3" });
    expect(got.columns[1].fields.sodium).toMatchObject({ value: 90, raw: "0.09" });
    expect(got.warnings.some((w) => w.includes("converted to 300 mg"))).toBe(true);
  });

  it("reads '<0.5 g' as less-than", () => {
    const spec = tableSpec({
      title: ["Nutrition information"],
      header,
      columns: COLS,
      rows: rows([["Energy", "1046 kJ / 250 kcal", "314 kJ / 75 kcal"]], false).map((r) => (r[0] === "Salt" ? ["Salt", "<0.5 g", "<0.5 g"] : r)),
    });
    const got = parseLabel(renderPanel(spec, { seed: 13 }))!;
    expect(got.columns[0].fields.salt).toMatchObject({ value: 0.5, raw: "<0.5", lessThan: true });
  });
});

describe("China", () => {
  it.each([0, 1, 2])("GB 28050-2011 style: 能量/蛋白质/脂肪/碳水化合物/钠 per 100 g with NRV% (seed %i)", (seed) => {
    const spec = tableSpec({
      title: ["营养成分表"],
      header: ["项目", "每100克", "NRV%"],
      columns: [200, 280],
      rows: [
        ["能量", "1046千焦", "12%"],
        ["蛋白质", "6.0克", "10%"],
        ["脂肪", "12.5克", "21%"],
        ["碳水化合物", "30.2克", "10%"],
        ["钠", "350毫克", "18%"],
      ],
    });
    const got = parseLabel(renderPanel(spec, seed ? HARSH(seed) : { seed: 20 }))!;
    expect(got.regime).toBe("cn");
    expect(got.regimeEvidence).toContain("营养成分表");
    expect(got.columns).toHaveLength(1);
    const col = got.columns[0];
    expect(col.basis).toBe("100g");
    expect(col.fields).toMatchObject({ kj: { value: 1046 }, prot: { value: 6, raw: "6.0" }, fat: { value: 12.5 }, carb: { value: 30.2 }, sodium: { value: 350 } });
    expect(col.refPct).toMatchObject({ kj: { value: 12 }, prot: { value: 10 }, fat: { value: 21 }, carb: { value: 10 }, sodium: { value: 18 } });
    expect(col.fields.kcal).toBeUndefined();
  });

  it.each([[0, 0], [1, 0], [2, 0], [3, 6], [4, 6], [5, 6]])("GB 28050-2025 style: adds 饱和脂肪 and 糖, per 100 g and per 份 (seed %i, tilt ±%i°)", (seed, tilt) => {
    const spec = tableSpec({
      title: ["营养成分表"],
      header: ["项目", "每100克", "每份(30克)", "NRV%"],
      columns: [170, 250, 320],
      indent: { 3: 10, 5: 10 },
      rows: [
        ["能量", "1046千焦", "314千焦", "4%"],
        ["蛋白质", "6.0克", "1.8克", "3%"],
        ["脂肪", "12.5克", "3.8克", "6%"],
        ["—饱和脂肪", "4.0克", "1.2克", "6%"],
        ["碳水化合物", "30.2克", "9.1克", "3%"],
        ["—糖", "10.0克", "3.0克", null],
        ["钠", "350毫克", "105毫克", "5%"],
      ],
    });
    const got = parseLabel(renderPanel(spec, seed ? { ...HARSH(seed), merge: 0.2, tilt } : { seed: 21 }))!;
    expect(got.regime).toBe("cn");
    expect(got.columns).toHaveLength(2);
    const [per100, portion] = got.columns;
    expect(per100.basis).toBe("100g");
    expect(portion.basis).toBe("serving");
    expect(portion.servingGrams).toBe(30);
    expect(got.serving?.value).toBe(30);
    expect(got.servingText).toBe("每份(30克)");
    expect(per100.fields).toMatchObject({ kj: { value: 1046 }, sat: { value: 4 }, sugar: { value: 10 }, sodium: { value: 350 } });
    expect(portion.fields).toMatchObject({ kj: { value: 314 }, prot: { value: 1.8 }, sat: { value: 1.2 }, sugar: { value: 3 }, sodium: { value: 105 } });
    // The NRV% column follows the per-份 amounts here, so it belongs to that column.
    expect(portion.refPct).toMatchObject({ kj: { value: 4 }, sat: { value: 6 }, sodium: { value: 5 } });
    expect(portion.refPct.sugar).toBeUndefined();
    expect(per100.refPct).toEqual({});
  });

  it.each([0, 1, 2])("bilingual label (seed %i)", (seed) => {
    const spec = tableSpec({
      title: ["营养成分表 Nutrition Information"],
      header: ["项目/Items", "每100克/per 100g", "NRV%"],
      columns: [290, 350],
      rows: [
        ["能量/Energy", "1046kJ", "12%"],
        ["蛋白质/Protein", "6.0g", "10%"],
        ["脂肪/Fat", "12.5g", "21%"],
        ["饱和脂肪/Saturated fat", "4.0g", "20%"],
        ["碳水化合物/Carbohydrate", "30.2g", "10%"],
        ["糖/Sugars", "10.0g", null],
        ["钠/Sodium", "350mg", "18%"],
      ],
    });
    const got = parseLabel(renderPanel(spec, seed ? { ...HARSH(seed), merge: 0.2 } : { seed: 22 }))!;
    expect(got.regime).toBe("cn");
    const col = got.columns[0];
    expect(col.basis).toBe("100g");
    expect(col.fields).toMatchObject({ kj: { value: 1046 }, prot: { value: 6 }, fat: { value: 12.5 }, sat: { value: 4 }, carb: { value: 30.2 }, sugar: { value: 10 }, sodium: { value: 350 } });
    expect(col.refPct).toMatchObject({ kj: { value: 12 }, sat: { value: 20 }, sodium: { value: 18 } });
  });
});

describe("the regulation's row order as a prior", () => {
  const base = {
    servingGrams: 40,
    servings: 6,
    declared: { kcal: 190, fat: 9, sat: 3.5, trans: 0, chol: 0, sodium: 65, carb: 22, fiber: 2, sugar: 9, added: 5, prot: 6 },
  };

  it("a sub-row under Total Fat read as just 'Fat' is saturated fat — and the inference is reported", () => {
    const spec = usPanelSpec(base);
    for (const line of spec.lines) for (const c of line.cells) c.text = c.text.replace("Saturated Fat", "Fat");
    const got = parseLabel(renderPanel(spec, { seed: 30 }))!;
    expect(got.columns[0].fields.sat).toMatchObject({ value: 3.5, raw: "3.5" });
    expect(got.columns[0].refPct.sat?.value).toBe(18);
    expect(got.warnings.some((w) => w.includes("read as Saturated fat by its position under Fat"))).toBe(true);
  });

  it("a row whose label the OCR lost entirely is placed only when exactly one field fits there", () => {
    const spec = usPanelSpec(base);
    for (const line of spec.lines) for (const c of line.cells) c.text = c.text.replace("Saturated Fat ", "");
    const got = parseLabel(renderPanel(spec, { seed: 31 }))!;
    expect(got.columns[0].fields.sat?.value).toBe(3.5);
    expect(got.warnings.some((w) => w.includes("label not recognised; read as Saturated fat"))).toBe(true);
  });

  it("does not place an unknown row when two fields could fit (no guessing)", () => {
    const spec = usPanelSpec({ ...base, declared: { ...base.declared, trans: undefined } });
    for (const line of spec.lines) for (const c of line.cells) c.text = c.text.replace("Saturated Fat ", "");
    const got = parseLabel(renderPanel(spec, { seed: 32 }))!;
    // Between Total Fat and Cholesterol, both saturated and trans fat are unfilled.
    expect(got.columns[0].fields.sat).toBeUndefined();
    expect(got.columns[0].fields.trans).toBeUndefined();
    expect(got.warnings.some((w) => w.includes("has numbers but no recognised label; not used"))).toBe(true);
  });

  it("EU 'of which' with its noun lost follows its parent row", () => {
    const spec = tableSpec({
      title: ["Nutrition information"],
      header: ["Typical values", "per 100g"],
      columns: [260],
      rows: [
        ["Energy", "1046 kJ / 250 kcal"],
        ["Fat", "9.5g"],
        ["of which", "1.2g"],
        ["Carbohydrate", "31g"],
        ["of which sugars", "10g"],
        ["Protein", "12g"],
        ["Salt", "0.75g"],
      ],
    });
    const got = parseLabel(renderPanel(spec, { seed: 33 }))!;
    expect(got.columns[0].fields.sat?.value).toBe(1.2);
    expect(got.columns[0].fields.sugar?.value).toBe(10);
  });
});

describe("Chinese print details", () => {
  it("full-width digits stay full-width in raw, and 饱和脂肪(酸) is saturated fat", () => {
    const spec = tableSpec({
      title: ["营养成分表"],
      header: ["项目", "每100克", "NRV%"],
      columns: [220, 300],
      rows: [
        ["能量", "１０４６千焦", "１２％"],
        ["蛋白质", "6.0克", "10%"],
        ["脂肪", "１２．５克", "21%"],
        ["饱和脂肪(酸)", "4.0克", "20%"],
        ["碳水化合物", "30.2克", "10%"],
        ["钠", "350毫克", "18%"],
      ],
    });
    const got = parseLabel(renderPanel(spec, { seed: 40, split: 0.5 }))!;
    const col = got.columns[0];
    expect(col.fields.kj).toMatchObject({ value: 1046, raw: "１０４６" });
    expect(col.refPct.kj).toMatchObject({ value: 12, raw: "１２" });
    expect(col.fields.fat).toMatchObject({ value: 12.5, raw: "１２．５" });
    expect(col.fields.sat?.value).toBe(4);
  });

  it("份量 on its own line gives the serving", () => {
    const spec = tableSpec({
      title: ["营养成分表", "份量 30克"],
      header: ["项目", "每份", "NRV%"],
      columns: [200, 280],
      rows: [
        ["能量", "314千焦", "4%"],
        ["蛋白质", "1.8克", "3%"],
        ["脂肪", "3.8克", "6%"],
        ["碳水化合物", "9.1克", "3%"],
        ["钠", "105毫克", "5%"],
      ],
    });
    const got = parseLabel(renderPanel(spec, { seed: 41 }))!;
    expect(got.serving).toMatchObject({ value: 30, raw: "30" });
    expect(got.columns[0].basis).toBe("serving");
    expect(got.columns[0].servingGrams).toBe(30);
  });
});

describe("no panel", () => {
  it("a cereal box front returns null", () => {
    const spec = {
      lines: [
        { size: 30, cells: [{ text: "HONEY NUT CRUNCH", x: 0 }] },
        { size: 16, cells: [{ text: "Whole Grain Oats", x: 0 }] },
        { size: 14, cells: [{ text: "140 CALORIES PER SERVING", x: 0 }] },
        { size: 14, cells: [{ text: "0g TRANS FAT", x: 0 }, { text: "8g PROTEIN", x: 200 }] },
        { size: 12, cells: [{ text: "Good source of Fiber", x: 0 }] },
        { size: 12, cells: [{ text: "NET WT 12 OZ (340g)", x: 0 }] },
        { size: 14, cells: [{ text: "0 16000 27546 1", x: 40 }] },
      ],
    };
    for (const seed of [1, 2, 3]) expect(parseLabel(renderPanel(spec, HARSH(seed)))).toBeNull();
  });

  it("an empty page returns null", () => {
    expect(parseLabel({ width: 10, height: 10, tokens: [], engine: "test" })).toBeNull();
  });
});
