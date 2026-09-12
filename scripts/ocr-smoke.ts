// OCR smoke run: the app's own reader, on a real image, from the command line.
//
//   npx vite-node scripts/ocr-smoke.ts [image.png|image.jpg ...] [--max-side=2000] [--json]
//
// It loads the SAME pinned model files from public/models with the SAME engine
// code the Web Worker runs (src/lib/labelScan/ocr/engine.ts), through
// onnxruntime-web's Node build — identical WASM kernels to the browser, so the
// token dump here is what a phone produces for the same decoded pixels. No
// onnxruntime-node (≈300 MB of native binaries) is needed for that.
//
// With no arguments it reads the committed FDA fixtures.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as ort from "onnxruntime-web";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { createEngine } from "../src/lib/labelScan/ocr/engine";
import { MODEL_DIR, MODEL_FILES, OCR_ENGINE } from "../src/lib/labelScan/ocr/manifest";

const args = process.argv.slice(2);
const json = args.includes("--json");
const maxSideArg = args.find((a) => a.startsWith("--max-side="));
const maxSide = maxSideArg ? Number(maxSideArg.split("=")[1]) : undefined;
const files = args.filter((a) => !a.startsWith("--"));
const images = files.length
  ? files
  : [
      "tests/fixtures/labels/fda-label-1.png",
      "tests/fixtures/labels/fda-label-1-photo-sim.jpg",
      "tests/fixtures/labels/fda-dual-column.png",
    ];

const buf = (p: string) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

export function decode(path: string): { data: Uint8Array; width: number; height: number } {
  const bytes = readFileSync(path);
  if (/\.png$/i.test(path)) {
    const png = PNG.sync.read(bytes);
    return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { data: img.data, width: img.width, height: img.height };
}

const t0 = performance.now();
const engine = await createEngine(ort, {
  det: buf(`public/${MODEL_DIR}${MODEL_FILES.det.file}`),
  rec: buf(`public/${MODEL_DIR}${MODEL_FILES.rec.file}`),
  dict: buf(`public/${MODEL_DIR}${MODEL_FILES.dict.file}`),
});
console.log(`engine ${OCR_ENGINE} · onnxruntime-web ${ort.env.versions.web} · load ${Math.round(performance.now() - t0)} ms`);

for (const path of images) {
  const img = decode(path);
  const t = performance.now();
  const r = await engine.run(img.data, img.width, img.height, { maxSide });
  const ms = performance.now() - t;
  const tm = r.timings;
  console.log(
    `\n== ${basename(path)}  ${img.width}×${img.height} → work ${tm.workWidth}×${tm.workHeight} · ${Math.round(ms)} ms ` +
      `(prep ${Math.round(tm.prepMs)} · det ${Math.round(tm.detMs)} · rec ${Math.round(tm.recMs)}) · ${tm.boxes} boxes → ${r.tokens.length} tokens`,
  );
  if (json) console.log(JSON.stringify(r.tokens));
  else
    for (const tk of r.tokens)
      console.log(
        `  ${String(tk.x).padStart(7)} ${String(tk.y).padStart(7)} ${String(tk.w).padStart(6)}×${String(tk.h).padEnd(6)} ${(tk.conf ?? 0).toFixed(3)}  ${tk.text}`,
      );
}
