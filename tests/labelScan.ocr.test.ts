import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { PNG } from "pngjs";
import { createEngine, type Engine } from "../src/lib/labelScan/ocr/engine";
import { MODEL_DIR, MODEL_FILES, OCR_ENGINE } from "../src/lib/labelScan/ocr/manifest";
import { OcrUnavailableError } from "../src/lib/labelScan/ocr/errors";
import { convexHull, ctcDecode, cropQuad, detInputSize, fitWithin, minAreaRect, resample, sortQuads, type Quad } from "../src/lib/labelScan/ocr/pipeline";

// The reader, end to end, on a real US label — plus the geometry it rests on.
//
// The fixture is the FDA's own sample Nutrition Facts label (a US government
// work, public domain): https://www.fda.gov/media/132222/download, "Label 1"
// from https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/nutrition-facts-label-images-download
// rendered from its vector PDF at 250 dpi. It is a PNG on purpose: PNG decodes
// to the same pixels everywhere, so the golden token file below is the exact
// output a phone's browser produces too (checked: Chrome's worker and this Node
// run hash identically).
//
// The golden file pins rule 5. If a change to the pipeline, the thresholds, the
// weights or onnxruntime moves ANY token — text, box or confidence — this fails,
// and updating tests/fixtures/labels/fda-label-1.tokens.json must be a
// deliberate act (npx vite-node scripts/ocr-smoke.ts <png> --json).

const bytes = (p: string) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const modelFile = (k: keyof typeof MODEL_FILES) => bytes(`public/${MODEL_DIR}${MODEL_FILES[k].file}`);

describe("the pinned weights", () => {
  it("names the engine from the recognition model's hash", () => {
    expect(OCR_ENGINE).toBe("pp-ocrv6-tiny@9ef676d6ed3c");
  });

  it("refuses a model file that isn't the pinned bytes", async () => {
    const tampered = new Uint8Array(modelFile("det"));
    tampered[tampered.length - 1] ^= 0xff;
    await expect(
      createEngine(ort, { det: tampered.buffer, rec: modelFile("rec"), dict: modelFile("dict") }),
    ).rejects.toSatisfy((e: unknown) => e instanceof OcrUnavailableError && e.reason === "integrity");
  });
});

describe("recognize the FDA sample label", () => {
  let engine: Engine;
  let img: { data: Uint8Array; width: number; height: number };

  beforeAll(async () => {
    engine = await createEngine(ort, { det: modelFile("det"), rec: modelFile("rec"), dict: modelFile("dict") });
    const png = PNG.sync.read(readFileSync("tests/fixtures/labels/fda-label-1.png"));
    img = { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }, 60_000);

  it("reads the numbers that matter, as printed", async () => {
    const r = await engine.run(img.data, img.width, img.height);
    const texts = r.tokens.map((t) => t.text);
    for (const want of [
      "Nutrition Facts",
      "8 servings per container",
      "2/3 cup (55g)",
      "230",
      "Calories",
      "Total Fat 8g",
      "10%",
      "Saturated Fat 1g",
      "Sodium 160mg",
      "Total Carbohydrate 37g",
      "Dietary Fiber 4g",
      "Total Sugars 12g",
      "Includes 10g Added Sugars",
      "20%",
      "Protein 3g",
    ]) {
      expect(texts).toContain(want);
    }
    // Every box inside the image, in original pixel coordinates.
    for (const t of r.tokens) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(img.width);
      expect(t.y + t.h).toBeLessThanOrEqual(img.height);
    }
  }, 60_000);

  it("does NOT correct what it read — '0g' in this font comes back 'Og', and stays that way (rule 1: the verifier decides)", async () => {
    const r = await engine.run(img.data, img.width, img.height);
    expect(r.tokens.map((t) => t.text)).toContain("Trans Fat Og");
  }, 60_000);

  it("is deterministic: the same pixels give byte-identical tokens, equal to the golden file", async () => {
    const a = await engine.run(img.data, img.width, img.height);
    const b = await engine.run(img.data, img.width, img.height);
    expect(JSON.stringify(b.tokens)).toBe(JSON.stringify(a.tokens));
    const golden = JSON.parse(readFileSync("tests/fixtures/labels/fda-label-1.tokens.json", "utf8"));
    expect(a.tokens).toEqual(golden);
  }, 60_000);

  it("maps boxes back to original coordinates when the image is scaled down", async () => {
    // Enlarge the fixture 3x (1959×3450) so it exceeds MAX_SIDE and gets scaled.
    const w = img.width * 3, h = img.height * 3;
    const big = resample(img.data, img.width, img.height, 4, w, h, 4);
    const r = await engine.run(big, w, h);
    expect(r.timings.workHeight).toBe(2000);
    const cal = r.tokens.find((t) => t.text === "230");
    const ref = (JSON.parse(readFileSync("tests/fixtures/labels/fda-label-1.tokens.json", "utf8")) as Array<{ text: string; x: number; y: number }>).find((t) => t.text === "230")!;
    expect(cal).toBeDefined();
    // Same place on the label, three times the coordinates (within a few px of rounding).
    expect(Math.abs(cal!.x - ref.x * 3)).toBeLessThan(15);
    expect(Math.abs(cal!.y - ref.y * 3)).toBeLessThan(15);
  }, 120_000);
});

describe("pipeline geometry", () => {
  it("fitWithin never enlarges and caps the long side", () => {
    expect(fitWithin(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
  });

  it("snaps the detector input to multiples of 32", () => {
    expect(detInputSize(1500, 2000)).toEqual({ width: 1504, height: 2016 });
    expect(detInputSize(653, 1150)).toEqual({ width: 640, height: 1152 });
  });

  it("area-averages when shrinking: a 2x2 checker becomes flat grey", () => {
    const src = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
    expect([...resample(src, 2, 2, 3, 1, 1)]).toEqual([128, 128, 128]);
  });

  it("finds the minimum-area rectangle of a tilted bar, with w along the horizontal-ish side", () => {
    // A 40×6 bar rotated by atan(1/10) ≈ 5.7°.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 6; j++) pts.push([Math.round(i * 0.995 - j * 0.0995), Math.round(i * 0.0995 + j * 0.995)]);
    const r = minAreaRect(pts);
    expect(r.w).toBeGreaterThan(r.h * 4);
    expect(Math.abs(r.uy / r.ux)).toBeLessThan(0.2);
    expect(r.ux).toBeGreaterThan(0);
  });

  it("builds a convex hull that drops interior points", () => {
    const hull = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
    expect(hull).toHaveLength(4);
  });

  it("turns tall strips on their side before recognition", () => {
    const img = { data: new Uint8Array(30 * 30 * 3).fill(200), width: 30, height: 30 };
    const quad: Quad = [[10, 0], [15, 0], [15, 20], [10, 20]];
    const c = cropQuad(img, quad);
    expect(c.width).toBeGreaterThan(c.height);
  });

  it("sorts boxes top-to-bottom, and left-to-right within a line", () => {
    const q = (x: number, y: number): { quad: Quad; id: string } => ({ id: `${x},${y}`, quad: [[x, y], [x + 5, y], [x + 5, y + 5], [x, y + 5]] });
    const out = sortQuads([q(50, 103), q(0, 100), q(0, 140)]).map((b) => b.id);
    expect(out).toEqual(["0,100", "50,103", "0,140"]);
  });
});

describe("CTC decoding", () => {
  const dict = ["a", "b", "c"];
  // classes: 0 blank, 1 a, 2 b, 3 c, 4 space
  const steps = (...args: number[]) => {
    const p = new Float32Array(args.length * 5);
    args.forEach((c, t) => (p[t * 5 + c] = 0.9));
    return p;
  };

  it("collapses repeats, keeps a repeat separated by a blank, and maps the last class to a space", () => {
    const r = ctcDecode(steps(1, 1, 0, 1, 2, 4, 3, 3), 8, 5, dict);
    expect(r.text).toBe("aab c");
    expect(r.conf).toBeCloseTo(0.9, 5);
  });

  it("returns empty text with zero confidence for all-blank output", () => {
    expect(ctcDecode(steps(0, 0, 0), 3, 5, dict)).toEqual({ text: "", conf: 0 });
  });
});
