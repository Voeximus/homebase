import { describe, it, expect } from "vitest";
import {
  MANDATORY,
  MANDATORY_CN_2011,
  allowedRefPct,
  energyFactors,
  onGrid,
  referenceValue,
  roundingInterval,
} from "../src/lib/labelScan/rules";

// The rules are data read from the regulations, so these tests pin the data to the
// text: each expectation names the clause it comes from. A wrong reference value here
// would not throw anywhere — it would quietly move every percentage check.

describe("US — 21 CFR 101.9", () => {
  it("DRVs from (c)(9); protein excluded (PDCAAS-adjusted), trans fat and total sugars have none", () => {
    expect(referenceValue("us", "fat")).toBe(78);
    expect(referenceValue("us", "sat")).toBe(20);
    expect(referenceValue("us", "chol")).toBe(300);
    expect(referenceValue("us", "sodium")).toBe(2300);
    expect(referenceValue("us", "carb")).toBe(275);
    expect(referenceValue("us", "fiber")).toBe(28);
    expect(referenceValue("us", "added")).toBe(50);
    expect(referenceValue("us", "prot")).toBeUndefined();
    expect(referenceValue("us", "trans")).toBeUndefined();
    expect(referenceValue("us", "sugar")).toBeUndefined();
    expect(referenceValue("us", "kcal")).toBeUndefined();
  });

  it("calories: 5s up to and including 50, 10s above", () => {
    expect(onGrid("us", "kcal", 45)).toBe(true);
    expect(onGrid("us", "kcal", 50)).toBe(true);
    expect(onGrid("us", "kcal", 55)).toBe(false);
    expect(onGrid("us", "kcal", 190)).toBe(true);
    expect(onGrid("us", "kcal", 185)).toBe(false);
    expect(roundingInterval("us", "kcal", 0)).toEqual([0, 5]);
    expect(roundingInterval("us", "kcal", 45)).toEqual([42.5, 47.5]);
    // 50 is reached from both sides: 47.5 in 5s, up to 55 in 10s.
    expect(roundingInterval("us", "kcal", 50)).toEqual([47.5, 55]);
    expect(roundingInterval("us", "kcal", 190)).toEqual([185, 195]);
  });

  it("fats: half grams below 5 g, whole grams above, under 0.5 g is 0", () => {
    expect(onGrid("us", "fat", 3.5)).toBe(true);
    expect(onGrid("us", "fat", 3.7)).toBe(false);
    expect(onGrid("us", "sat", 5.5)).toBe(false);
    expect(onGrid("us", "trans", 0)).toBe(true);
    expect(roundingInterval("us", "fat", 0)).toEqual([0, 0.5]);
    expect(roundingInterval("us", "fat", 0.5)).toEqual([0.5, 0.75]);
    expect(roundingInterval("us", "sat", 3.5)).toEqual([3.25, 3.75]);
    // 5 g: from 4.75 (half-gram rounding) up to 5.5 (whole-gram rounding).
    expect(roundingInterval("us", "fat", 5)).toEqual([4.75, 5.5]);
    expect(roundingInterval("us", "fat", 9)).toEqual([8.5, 9.5]);
  });

  it("cholesterol in 5 mg; sodium in 5 mg to 140, 10 mg above", () => {
    expect(onGrid("us", "chol", 15)).toBe(true);
    expect(onGrid("us", "chol", 12)).toBe(false);
    expect(roundingInterval("us", "chol", 0)).toEqual([0, 2]);
    expect(roundingInterval("us", "chol", 5)).toEqual([2, 7.5]);
    expect(onGrid("us", "sodium", 135)).toBe(true);
    expect(onGrid("us", "sodium", 145)).toBe(false);
    expect(onGrid("us", "sodium", 150)).toBe(true);
    expect(roundingInterval("us", "sodium", 0)).toEqual([0, 5]);
    expect(roundingInterval("us", "sodium", 5)).toEqual([5, 7.5]);
    expect(roundingInterval("us", "sodium", 65)).toEqual([62.5, 67.5]);
    expect(roundingInterval("us", "sodium", 140)).toEqual([137.5, 145]);
    expect(roundingInterval("us", "sodium", 150)).toEqual([145, 155]);
  });

  it("carbs, fiber, sugars, protein: whole grams; 'less than 1 g' is [0, 1]", () => {
    expect(onGrid("us", "prot", 6)).toBe(true);
    expect(onGrid("us", "carb", 6.5)).toBe(false);
    expect(roundingInterval("us", "carb", 22)).toEqual([21.5, 22.5]);
    expect(roundingInterval("us", "fiber", 0)).toEqual([0, 0.5]);
    expect(roundingInterval("us", "prot", 1, true)).toEqual([0, 1]);
  });

  it("%DV may come from the declared OR the actual amount, so it is a range (101.9(d)(7)(ii))", () => {
    // 9 g fat: declared gives 11.5 → 12; actual 8.5–9.5 g gives 10.9–12.2 → 11 or 12.
    expect(allowedRefPct("us", "fat", 9)).toEqual([11, 12]);
    // 3.5 g saturated fat: 3.25–3.75 g → 16.25–18.75% → 16..19.
    expect(allowedRefPct("us", "sat", 3.5)).toEqual([16, 17, 18, 19]);
    expect(allowedRefPct("us", "sodium", 65)).toEqual([3]);
    expect(allowedRefPct("us", "prot", 6)).toEqual([]);
    expect(allowedRefPct("us", "sugar", 9)).toEqual([]);
  });

  it("general factors 4/4/9, no separate fiber factor (US carbohydrate includes fiber)", () => {
    expect(energyFactors("us", "kcal")).toEqual({ prot: 4, carb: 4, fat: 9 });
  });

  it("every Nutrition Facts line is mandatory, in printed order", () => {
    expect(MANDATORY.us).toEqual(["kcal", "fat", "sat", "trans", "chol", "sodium", "carb", "fiber", "sugar", "added", "prot"]);
  });
});

describe("EU — Regulation 1169/2011 and the 2012 Commission guidance", () => {
  it("reference intakes, Annex XIII Part B (verified against legislation.gov.uk, retained and as-adopted)", () => {
    expect(referenceValue("eu", "kj")).toBe(8400);
    expect(referenceValue("eu", "kcal")).toBe(2000);
    expect(referenceValue("eu", "fat")).toBe(70);
    expect(referenceValue("eu", "sat")).toBe(20);
    expect(referenceValue("eu", "carb")).toBe(260);
    expect(referenceValue("eu", "sugar")).toBe(90);
    expect(referenceValue("eu", "prot")).toBe(50);
    expect(referenceValue("eu", "salt")).toBe(6);
    expect(referenceValue("eu", "fiber")).toBeUndefined();
    expect(referenceValue("eu", "sodium")).toBeUndefined();
  });

  it("the guidance's own example: a declared 12 g of protein could be 11.5–12.4 g", () => {
    const [lo, hi] = roundingInterval("eu", "prot", 12);
    expect(lo).toBe(11.5);
    expect(hi).toBeGreaterThanOrEqual(12.4);
    expect(hi).toBeLessThanOrEqual(12.5);
  });

  it("two tiers: 1 g at or above 10 g, 0.1 g below, '0' at or below 0.5 g", () => {
    expect(roundingInterval("eu", "carb", 4.3)).toEqual([expect.closeTo(4.25, 9), expect.closeTo(4.35, 9)]);
    expect(roundingInterval("eu", "fat", 0)).toEqual([0, 0.5]);
    // 10 g is also 9.96 g rounded to tenths.
    expect(roundingInterval("eu", "fat", 10)[0]).toBeCloseTo(9.95, 9);
    // Printed finer than the guidance asks (common on real labels): read at that precision.
    expect(roundingInterval("eu", "carb", 62.3)).toEqual([expect.closeTo(62.25, 9), expect.closeTo(62.35, 9)]);
    expect(onGrid("eu", "carb", 62.3)).toBe(true);
    expect(onGrid("eu", "fat", 3.72)).toBe(false);
  });

  it("saturates to 0.1 g down to 0.1 g; salt to 0.01 g below 1 g and 0.1 g above", () => {
    expect(roundingInterval("eu", "sat", 0)).toEqual([0, 0.1]);
    expect(roundingInterval("eu", "salt", 0)).toEqual([0, 0.0125]);
    expect(roundingInterval("eu", "salt", 0.45)).toEqual([expect.closeTo(0.445, 9), expect.closeTo(0.455, 9)]);
    expect(roundingInterval("eu", "salt", 1.2)).toEqual([expect.closeTo(1.15, 9), expect.closeTo(1.25, 9)]);
    expect(onGrid("eu", "salt", 0.45)).toBe(true);
    expect(onGrid("eu", "salt", 0.455)).toBe(false);
  });

  it("Annex XIV factors, with fibre's own 2 kcal / 8 kJ", () => {
    expect(energyFactors("eu", "kcal")).toEqual({ prot: 4, carb: 4, fat: 9, fiber: 2 });
    expect(energyFactors("eu", "kj")).toEqual({ prot: 17, carb: 17, fat: 37, fiber: 8 });
  });

  it("%RI is a range like the US one", () => {
    // 22 g fat: 21.5–22.5 g of 70 g → 30.7–32.1% → 31 or 32.
    expect(allowedRefPct("eu", "fat", 22)).toEqual([31, 32]);
  });

  it("mandatory: energy in both units, fat, saturates, carbohydrate, sugars, protein, salt — fibre optional", () => {
    expect(MANDATORY.eu).toEqual(["kj", "kcal", "fat", "sat", "carb", "sugar", "prot", "salt"]);
  });
});

describe("China — GB 28050-2025 (and 2011)", () => {
  it("NRVs, Table A.1: no sugar NRV, energy in kJ only", () => {
    expect(referenceValue("cn", "kj")).toBe(8400);
    expect(referenceValue("cn", "prot")).toBe(60);
    expect(referenceValue("cn", "fat")).toBe(60);
    expect(referenceValue("cn", "sat")).toBe(20);
    expect(referenceValue("cn", "carb")).toBe(300);
    expect(referenceValue("cn", "fiber")).toBe(25);
    expect(referenceValue("cn", "sodium")).toBe(2000);
    expect(referenceValue("cn", "sugar")).toBeUndefined();
    expect(referenceValue("cn", "kcal")).toBeUndefined();
  });

  it("NRV% is from the DECLARED value, so exactly one percentage is legal", () => {
    // 9.3 g protein: 15.5% → 16. A US-style range (9.25–9.35 g) would also allow 15.
    expect(allowedRefPct("cn", "prot", 9.3)).toEqual([16]);
    expect(allowedRefPct("cn", "kj", 2074)).toEqual([25]);
    expect(allowedRefPct("cn", "sugar", 5)).toEqual([]);
  });

  it("Table 1: 1 kJ and 0.1 g steps, and nothing printable between 0 and the '0' limit", () => {
    expect(onGrid("cn", "kj", 17)).toBe(false);
    expect(onGrid("cn", "kj", 18)).toBe(true);
    expect(onGrid("cn", "kj", 0)).toBe(true);
    expect(onGrid("cn", "prot", 0.5)).toBe(false);
    expect(onGrid("cn", "prot", 0.6)).toBe(true);
    expect(onGrid("cn", "sat", 0.1)).toBe(false);
    expect(onGrid("cn", "sat", 0.2)).toBe(true);
    expect(onGrid("cn", "trans", 0.3)).toBe(false);
    expect(onGrid("cn", "chol", 5)).toBe(false);
    expect(onGrid("cn", "sodium", 6)).toBe(true);
    expect(onGrid("cn", "fat", 21.65)).toBe(false);
    expect(roundingInterval("cn", "kj", 0)).toEqual([0, 17]);
    expect(roundingInterval("cn", "fat", 25)).toEqual([24.95, 25.05]);
    expect(roundingInterval("cn", "sodium", 480)).toEqual([479.5, 480.5]);
  });

  it("factors 17/17/37 kJ and fiber 8", () => {
    expect(energyFactors("cn", "kj")).toEqual({ prot: 17, carb: 17, fat: 37, fiber: 8 });
  });

  it("2025's '1+6' is the rulebook; 2011's '1+4' is what may legally be missing", () => {
    expect(MANDATORY.cn).toEqual(["kj", "prot", "fat", "sat", "carb", "sugar", "sodium"]);
    expect(MANDATORY_CN_2011).toEqual(["kj", "prot", "fat", "carb", "sodium"]);
  });
});
