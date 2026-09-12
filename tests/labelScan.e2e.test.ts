import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseLabel, suggestRepairs, toLabelFood, verify } from "../src/lib/labelScan";
import type { OcrPage, ParsedPanel } from "../src/lib/labelScan";

// End to end, on what the camera really produced.
//
// Every other label-scan test builds its input by hand: the verifier's from
// ParsedPanel objects, the parser's from a synthetic layout. This one starts
// from the reader's ACTUAL output for the FDA's public-domain sample label
// (tests/fixtures/labels/fda-label-1.tokens.json, the golden file the OCR test
// pins) and runs it through every stage the app does. It is the only test that
// would notice the stages disagreeing about something none of them owns — which
// is exactly what the merge found on the tilted photo: each stage passed its own
// tests and the pipeline still slipped a column.

function realPage(name: string, width: number, height: number): OcrPage {
  const tokens = JSON.parse(readFileSync(`tests/fixtures/labels/${name}.tokens.json`, "utf8"));
  return { width, height, tokens, engine: "pp-ocrv6-tiny@9ef676d6ed3c" };
}

describe("FDA sample label, from real OCR tokens to a saved food", () => {
  const panel = parseLabel(realPage("fda-label-1", 653, 1150)) as ParsedPanel;

  it("reads the panel exactly as printed", () => {
    expect(panel?.regime).toBe("us");
    const col = panel.columns[0];
    const amounts = Object.fromEntries(Object.entries(col.fields).map(([k, v]) => [k, v!.value]));
    expect(amounts).toEqual({
      kcal: 230, fat: 8, sat: 1, trans: 0, chol: 0, sodium: 160,
      carb: 37, fiber: 4, sugar: 12, added: 10, prot: 3,
    });
    const pct = Object.fromEntries(Object.entries(col.refPct).map(([k, v]) => [k, v!.value]));
    expect(pct).toEqual({ fat: 10, sat: 5, chol: 0, sodium: 7, carb: 13, fiber: 14, added: 20 });
    expect(panel.serving?.value).toBe(55);
    expect(panel.servingsPerContainer?.value).toBe(8);
  });

  it("keeps the reader's letter-O zeros raw and says so (rule 1)", () => {
    // This font's 0 comes back from the reader as the letter O at every size.
    expect(panel.columns[0].fields.trans?.raw).toBe("O");
    expect(panel.columns[0].fields.chol?.raw).toBe("O");
    expect(panel.warnings.some((w) => /Trans fat/i.test(w))).toBe(true);
  });

  it("agrees with itself, and asks a person about exactly serving size and sugar", () => {
    const v = verify(panel, 0);
    expect(v.consistent).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.fields.sugar).toBe("unchecked"); // rule 4: no printed second copy, ever
    expect(v.needsConfirm).toEqual(["serving", "sugar"]); // rule 3 first
    expect(suggestRepairs(panel, 0)).toEqual([]); // nothing to repair on a clean read
  });

  it("saves per 100 g from the CONFIRMED serving", () => {
    const food = toLabelFood(panel, { servingGrams: 55, name: "FDA sample" }, "pp-ocrv6-tiny@9ef676d6ed3c");
    // 230 kcal, 8 g fat, 37 g carbs, 3 g protein per 55 g serving
    expect(food).toMatchObject({ kcal: 418.2, f: 14.5, c: 67.3, p: 5.5, serving: 55, source: "label" });
  });

  it("a person who corrects the serving changes what is saved — the read is never trusted for it", () => {
    const food = toLabelFood(panel, { servingGrams: 60, name: "FDA sample" });
    expect(food.kcal).toBe(383.3);
  });
});

describe("the same label photographed 3° off square, through every stage", () => {
  // Before the parser measured the column lean, this page slipped the whole %DV
  // column one row. Every stage passed its own tests; the checker caught it
  // (three "doesn't fit" flags) but the person would have had to retake. Now the
  // tilted read must come out identical to the flat one.
  const flat = parseLabel(realPage("fda-label-1", 653, 1150)) as ParsedPanel;
  const tilted = parseLabel(realPage("fda-label-1-photo-sim", 1200, 1600)) as ParsedPanel;
  const values = (p: ParsedPanel) => ({
    amounts: Object.fromEntries(Object.entries(p.columns[0].fields).map(([k, v]) => [k, v!.value])),
    pct: Object.fromEntries(Object.entries(p.columns[0].refPct).map(([k, v]) => [k, v!.value])),
    serving: p.serving?.value,
    servings: p.servingsPerContainer?.value,
  });

  it("reads exactly what the flat scan reads", () => {
    expect(values(tilted)).toEqual(values(flat));
  });

  it("agrees with itself and saves the same food", () => {
    const v = verify(tilted, 0);
    expect(v.consistent).toBe(true);
    expect(v.needsConfirm).toEqual(["serving", "sugar"]);
    expect(suggestRepairs(tilted, 0)).toEqual([]);
    expect(toLabelFood(tilted, { servingGrams: 55, name: "FDA sample" })).toMatchObject({ kcal: 418.2, f: 14.5, c: 67.3, p: 5.5 });
  });
});

describe("the dual-column label (per serving and per container)", () => {
  const panel = parseLabel(realPage("fda-dual-column", 869, 1147)) as ParsedPanel;

  it("reads both columns, and each agrees with itself", () => {
    expect(panel.columns.length).toBe(2);
    expect(panel.columns[0].fields.kcal?.value).toBe(220);
    expect(panel.columns[1].fields.kcal?.value).toBe(440);
    expect(verify(panel, 0).consistent).toBe(true);
    expect(verify(panel, 1).consistent).toBe(true);
  });

  it("saves from the per-serving column: 220 kcal in 255 g", () => {
    const food = toLabelFood(panel, { servingGrams: 255, name: "Dual" });
    expect(food.kcal).toBe(86.3);
  });
});
