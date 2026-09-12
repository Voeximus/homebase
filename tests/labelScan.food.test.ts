import { describe, it, expect } from "vitest";
import { toLabelFood } from "../src/lib/labelScan/food";
import type { ParsedPanel, ReadValue } from "../src/lib/labelScan/types";

// toLabelFood is the arithmetic at the end of the confirm screen: a panel a
// person has confirmed → the per-100 g food the app stores. The load-bearing
// rule it carries is types.ts rule 3 — the serving that scales a per-serving
// label is the one a PERSON confirmed, never the one the camera read.

const rv = (value: number, extra: Partial<ReadValue> = {}): ReadValue => ({ value, raw: String(value), ...extra });

/** The research's worked example: a US chocolate-chip snack bar, 40 g serving. */
const usSnackBar = (): ParsedPanel => ({
  regime: "us",
  regimeEvidence: "Nutrition Facts",
  serving: rv(40),
  servingText: "1 bar (40g)",
  columns: [
    {
      basis: "serving",
      servingGrams: 40,
      fields: { kcal: rv(190), fat: rv(9), sat: rv(3.5), sodium: rv(65), carb: rv(22), sugar: rv(9), prot: rv(6) },
      refPct: { fat: rv(12), sat: rv(18), sodium: rv(3), carb: rv(8) },
    },
  ],
  warnings: [],
});

/** An EU panel that prints energy only in kJ, per 100 g. */
const euKjOnly = (): ParsedPanel => ({
  regime: "eu",
  regimeEvidence: "Nutrition declaration · kJ",
  columns: [
    {
      basis: "100g",
      fields: { kj: rv(1674), fat: rv(17), sat: rv(9.8), carb: rv(56), sugar: rv(28), prot: rv(6.4), salt: rv(0.52) },
      refPct: {},
    },
  ],
  warnings: [],
});

describe("toLabelFood — a US per-serving label", () => {
  it("scales the per-serving numbers to per 100 g by the confirmed serving", () => {
    const food = toLabelFood(usSnackBar(), { servingGrams: 40, name: "Chocolate chip snack bars" });
    expect(food).toEqual({
      name: "Chocolate chip snack bars",
      kcal: 475, // 190 × 100 / 40
      f: 22.5, // 9 × 100 / 40
      c: 55, // 22 × 100 / 40
      p: 15, // 6 × 100 / 40
      serving: 40,
      source: "label",
    });
  });

  it("uses the CONFIRMED serving, not the one the camera read (rule 3)", () => {
    const panel = usSnackBar();
    panel.serving = rv(400); // the 10x misread no check can catch
    panel.columns[0].servingGrams = 400;
    const food = toLabelFood(panel, { servingGrams: 40, name: "Bar" });
    expect(food.kcal).toBe(475);
    expect(food.serving).toBe(40);
  });

  it("carries barcode, brand and engine through untouched", () => {
    const food = toLabelFood(
      usSnackBar(),
      { servingGrams: 40, name: "  Bar  ", brand: " Acme ", barcode: "0049000028911" },
      "pp-ocrv6-tiny@abc123",
    );
    expect(food.name).toBe("Bar");
    expect(food.brand).toBe("Acme");
    expect(food.barcode).toBe("0049000028911");
    expect(food.engine).toBe("pp-ocrv6-tiny@abc123");
    expect(food.source).toBe("label");
  });

  it("rounds to one decimal, like every catalog answer in lib/barcode.ts", () => {
    const food = toLabelFood(usSnackBar(), { servingGrams: 28, name: "Bar" });
    expect(food.kcal).toBe(678.6); // 190 × 100 / 28 = 678.571…
    expect(food.f).toBe(32.1); // 9 × 100 / 28 = 32.142…
  });

  it("reads from the chosen column", () => {
    const panel = usSnackBar();
    panel.columns.push({
      basis: "serving",
      servingGrams: 240,
      fields: { kcal: rv(1140), fat: rv(54), carb: rv(132), prot: rv(36) },
      refPct: {},
    });
    const food = toLabelFood(panel, { servingGrams: 240, name: "Box", columnIndex: 1 });
    expect(food).toMatchObject({ kcal: 475, f: 22.5, c: 55, p: 15, serving: 240 });
  });
});

describe("toLabelFood — an EU per-100 g label with only kJ", () => {
  it("takes per-100 g values as printed and converts kJ to kcal", () => {
    const food = toLabelFood(euKjOnly(), { servingGrams: 30, name: "Biscuits" });
    expect(food.kcal).toBe(400.1); // 1674 / 4.184 = 400.09…
    expect(food.f).toBe(17);
    expect(food.c).toBe(56);
    expect(food.p).toBe(6.4);
    expect(food.serving).toBe(30); // the serving does not scale a per-100 g column
  });

  it("prefers a printed kcal over converting kJ", () => {
    const panel = euKjOnly();
    panel.columns[0].fields.kcal = rv(400);
    expect(toLabelFood(panel, { servingGrams: 30, name: "Biscuits" }).kcal).toBe(400);
  });

  it("treats a per-100 ml column as printed", () => {
    const panel = euKjOnly();
    panel.columns[0].basis = "100ml";
    expect(toLabelFood(panel, { servingGrams: 250, name: "Drink" }).f).toBe(17);
  });
});

describe("toLabelFood — overrides", () => {
  it("a person's value wins over the read, before any scaling", () => {
    const panel = usSnackBar();
    panel.columns[0].fields.fat = rv(99); // the misread
    const food = toLabelFood(panel, { servingGrams: 40, name: "Bar", overrides: { fat: 9 } });
    expect(food.f).toBe(22.5);
  });

  it("an override can supply a field the camera never read", () => {
    const panel = usSnackBar();
    delete panel.columns[0].fields.prot;
    const food = toLabelFood(panel, { servingGrams: 40, name: "Bar", overrides: { prot: 6 } });
    expect(food.p).toBe(15);
  });

  it("an overridden kcal wins over a kJ conversion", () => {
    const food = toLabelFood(euKjOnly(), { servingGrams: 30, name: "B", overrides: { kcal: 399 } });
    expect(food.kcal).toBe(399);
  });

  it("never mutates the panel", () => {
    const panel = usSnackBar();
    const before = JSON.stringify(panel);
    toLabelFood(panel, { servingGrams: 40, name: "Bar", overrides: { fat: 10, kcal: 200 } });
    expect(JSON.stringify(panel)).toBe(before);
  });
});

describe("toLabelFood — refuses loudly", () => {
  it("a serving of 0 or less", () => {
    expect(() => toLabelFood(usSnackBar(), { servingGrams: 0, name: "Bar" })).toThrow(/serving/);
    expect(() => toLabelFood(usSnackBar(), { servingGrams: -40, name: "Bar" })).toThrow(/serving/);
    expect(() => toLabelFood(usSnackBar(), { servingGrams: NaN, name: "Bar" })).toThrow(/serving/);
  });

  it("a panel with no energy in either unit", () => {
    const panel = usSnackBar();
    delete panel.columns[0].fields.kcal;
    expect(() => toLabelFood(panel, { servingGrams: 40, name: "Bar" })).toThrow(/energy/);
  });

  it("a panel missing an essential macro, naming every one", () => {
    const panel = usSnackBar();
    delete panel.columns[0].fields.fat;
    delete panel.columns[0].fields.prot;
    expect(() => toLabelFood(panel, { servingGrams: 40, name: "Bar" })).toThrow(/fat, protein/);
  });

  it("a column that doesn't exist", () => {
    expect(() => toLabelFood(usSnackBar(), { servingGrams: 40, name: "Bar", columnIndex: 3 })).toThrow(/column 3/);
  });

  it("a negative or non-finite override", () => {
    expect(() => toLabelFood(usSnackBar(), { servingGrams: 40, name: "Bar", overrides: { fat: -1 } })).toThrow(/fat/);
  });

  it("keeps real zeros — a zero-calorie label is a reading, not a gap", () => {
    const panel = usSnackBar();
    panel.columns[0].fields = { kcal: rv(0), fat: rv(0), carb: rv(0), prot: rv(0) };
    expect(toLabelFood(panel, { servingGrams: 355, name: "Diet cola" })).toMatchObject({ kcal: 0, p: 0, c: 0, f: 0 });
  });
});
