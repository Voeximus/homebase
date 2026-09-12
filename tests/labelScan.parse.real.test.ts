import { describe, it, expect } from "vitest";
import { parseLabel } from "../src/lib/labelScan/parse";
import type { OcrPage, OcrToken, ParsedPanel } from "../src/lib/labelScan/types";
import label1 from "./fixtures/labels/fda-label-1.tokens.json";
import label1Photo from "./fixtures/labels/fda-label-1-photo-sim.tokens.json";
import dual from "./fixtures/labels/fda-dual-column.tokens.json";

// The parser against REAL recogniser output, not the synthetic layout helper.
// All three token files are PP-OCRv6 tiny (pp-ocrv6-tiny@9ef676d6ed3c,
// onnxruntime-web 1.29.0) run on the images beside them; tests/fixtures/labels/
// SOURCES.txt says where each image came from. Real tokens have a shape the
// helper under-represents: each label and its amount arrive as ONE token
// ("Total Fat 8g", "Cholesterol Omg"), each percentage as its own right-hand
// token, and the page carries a vitamins block and a footnote below the panel.
//
// The photo-sim page is the one that matters most. It is the same FDA label
// rotated 3° (right side higher), which puts every "%" token about half a row
// pitch above its own row's label — so a parser that only clusters rows picks
// the wrong row for the whole %DV column, and every value still looks like a
// number. That exact failure shipped once; this file keeps it from coming back.

const page = (tokens: OcrToken[], width: number, height: number): OcrPage => ({
  width,
  height,
  tokens,
  engine: "pp-ocrv6-tiny@9ef676d6ed3c",
});

/** FDA sample Label 1 exactly as printed. */
function expectLabel1(got: ParsedPanel | null) {
  expect(got).not.toBeNull();
  const p = got!;
  expect(p.regime).toBe("us");
  expect(p.columns).toHaveLength(1);
  const col = p.columns[0];
  expect(col.basis).toBe("serving");
  expect(col.fields).toEqual({
    kcal: { value: 230, raw: "230", token: expect.any(Number) },
    fat: { value: 8, raw: "8", token: expect.any(Number) },
    sat: { value: 1, raw: "1", token: expect.any(Number) },
    trans: { value: 0, raw: "O", token: expect.any(Number) },
    chol: { value: 0, raw: "O", token: expect.any(Number) },
    sodium: { value: 160, raw: "160", token: expect.any(Number) },
    carb: { value: 37, raw: "37", token: expect.any(Number) },
    fiber: { value: 4, raw: "4", token: expect.any(Number) },
    sugar: { value: 12, raw: "12", token: expect.any(Number) },
    added: { value: 10, raw: "10", token: expect.any(Number) },
    prot: { value: 3, raw: "3", token: expect.any(Number) },
  });
  const pct = Object.fromEntries(Object.entries(col.refPct).map(([k, v]) => [k, v.value]));
  expect(pct).toEqual({ fat: 10, sat: 5, chol: 0, sodium: 7, carb: 13, fiber: 14, added: 20 });
  expect(p.serving).toMatchObject({ value: 55, raw: "55" });
  expect(p.servingText).toBe("2/3 cup (55g)");
  expect(p.servingsPerContainer).toMatchObject({ value: 8, raw: "8" });
  // Both "O"s were read as zeros; that interpretation must be visible, never silent.
  expect(p.warnings.filter((w) => w.includes('read the letters in "O"'))).toHaveLength(2);
}

describe("real PP-OCRv6 tokens", () => {
  it("FDA Label 1, flat scan (653×1150)", () => {
    expectLabel1(parseLabel(page(label1 as OcrToken[], 653, 1150)));
  });

  it("FDA Label 1, simulated phone photo rotated 3° (1200×1600)", () => {
    expectLabel1(parseLabel(page(label1Photo as OcrToken[], 1200, 1600)));
  });

  it("FDA dual-column label: per serving, then per container (869×1147)", () => {
    const got = parseLabel(page(dual as OcrToken[], 869, 1147));
    expect(got?.regime).toBe("us");
    expect(got!.columns).toHaveLength(2);
    const [serving, container] = got!.columns;
    const values = (c: typeof serving) => Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, v.value]));
    const pcts = (c: typeof serving) => Object.fromEntries(Object.entries(c.refPct).map(([k, v]) => [k, v.value]));

    expect(serving.basis).toBe("serving");
    expect(serving.servingGrams).toBe(255);
    expect(values(serving)).toEqual({ kcal: 220, fat: 5, sat: 2, trans: 0, chol: 15, sodium: 240, carb: 35, fiber: 6, sugar: 7, added: 4, prot: 9 });
    expect(pcts(serving)).toEqual({ fat: 6, sat: 10, chol: 5, sodium: 10, carb: 13, fiber: 21, added: 8 });

    expect(container.basis).toBe("serving");
    expect(values(container)).toEqual({ kcal: 440, fat: 10, sat: 4, trans: 0, chol: 30, sodium: 480, carb: 70, fiber: 12, sugar: 14, added: 8, prot: 18 });
    expect(pcts(container)).toEqual({ fat: 13, sat: 20, chol: 10, sodium: 21, carb: 25, fiber: 43, added: 16 });

    expect(got!.serving).toMatchObject({ value: 255, raw: "255" });
    expect(got!.servingsPerContainer).toMatchObject({ value: 2, raw: "2" });
  });
});
