// ── recognize: pixels → OcrPage ──────────────────────────────────────────────
//
// The engine is PaddleOCR PP-OCRv6 tiny (Apache-2.0; English and Chinese in one
// 6.2 MB pair of models) running on onnxruntime-web's WASM backend inside a Web
// Worker. Why onnxruntime-web directly, and not the ppu-paddle-ocr package
// (MIT, v6.5.1) that wraps the same models:
//
//   * The package's model catalogue points at a third-party re-export of the
//     weights (snowfluke/ppu-paddle-ocr-models, converted to .ort), and its
//     default WASM path is the jsDelivr CDN. Rule 5 needs the official bytes,
//     pinned and hashed by us, served from our own origin.
//   * It depends on ppu-ocv, which pulls OpenCV.js and @napi-rs/canvas (native
//     binaries) into node_modules even though the browser build uses neither.
//   * Its browser box-finding is its own canvas heuristic with extra padding
//     constants. Ours follows the reference PaddleOCR steps with the thresholds
//     shipped in each model's inference.yml, in plain TypeScript that runs —
//     and is tested — identically in Node (ocr/pipeline.ts).
//   * What we take on in exchange is ~600 lines of pre/post-processing, and a
//     golden-file test that fails if any of it moves a single token.
//
// This module is deliberately tiny and free of heavy imports. The runtime, the
// pipeline and the models load only when preloadOcr()/recognize() is first
// called, so importing the labelScan barrel costs the main bundle nothing.
//
// Nothing touches the network once the models are loaded: recognize() is
// decoding, arithmetic and inference over bytes already in memory.

import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import type { OcrPage } from "./types";
import type { EngineResult } from "./ocr/engine";
import { OcrUnavailableError } from "./ocr/errors";
import { MODEL_DIR, MODEL_FILES, OCR_ENGINE as PINNED_ENGINE, type ModelFile } from "./ocr/manifest";
import type { FileUrls, FromWorker, ToWorker } from "./ocr/protocol";

/** The exact engine + weights identity stamped onto every OcrPage. */
export const OCR_ENGINE = PINNED_ENGINE;

/** Thrown when this device can't run the on-device reader; `reason` tells the UI what to offer instead. */
export { OcrUnavailableError };
export type { OcrFailure } from "./ocr/errors";

export interface RecognizeTimings {
  /** Waiting for the models to finish loading (0 when preloaded). */
  waitMs: number;
  /** File → pixels: image decode and EXIF orientation. */
  decodeMs: number;
  prepMs: number;
  detMs: number;
  recMs: number;
  boxes: number;
  workWidth: number;
  workHeight: number;
  runsOn: "worker" | "main";
}

export interface OcrLoadInfo {
  runsOn: "worker" | "main";
  loadMs: number;
  downloadBytes: number;
}

interface Client {
  info: OcrLoadInfo;
  run(pixels: Uint8ClampedArray, width: number, height: number, maxSide?: number): Promise<EngineResult>;
}

// A module that compiles `(func (result v128) i32.const 0 i8x16.splat i8x16.popcnt)`.
// onnxruntime-web ships only SIMD builds, so a browser without fixed-width SIMD
// (Safari before 16.4) can't run it at all; better to say so up front than to
// fail inside a WASM compile.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

function checkSupport(): void {
  if (typeof WebAssembly !== "object" || typeof WebAssembly.validate !== "function") {
    throw new OcrUnavailableError("unsupported", "This browser can't run WebAssembly, so it can't read labels on the device.");
  }
  if (!WebAssembly.validate(SIMD_PROBE)) {
    throw new OcrUnavailableError(
      "unsupported",
      "This browser is too old to read labels on the device (it needs WebAssembly SIMD: iOS 16.4+ or Chrome 91+).",
    );
  }
}

function fileUrls(): FileUrls {
  // BASE_URL is "/" in dev and "/homebase/" on GitHub Pages. The short hash in
  // the query string makes a changed weight file a different URL, so the
  // service worker's cache-first rule can never serve stale weights under a new
  // engine string.
  const base = new URL(import.meta.env.BASE_URL, location.href);
  const model = (name: ModelFile) =>
    new URL(`${MODEL_DIR}${MODEL_FILES[name].file}?v=${MODEL_FILES[name].sha256.slice(0, 12)}`, base).href;
  return { det: model("det"), rec: model("rec"), dict: model("dict"), wasm: new URL(wasmUrl, location.href).href };
}

/** The worker could not even start (module workers unsupported, script failed to load). Distinct from the engine failing inside it. */
class WorkerStartError extends Error {}

function startWorker(urls: FileUrls, onDead: () => void): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./ocr/worker.ts", import.meta.url), { type: "module", name: "label-reader" });
    } catch (e) {
      reject(new WorkerStartError(String(e)));
      return;
    }
    const pending = new Map<number, { resolve: (r: EngineResult) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let started = false;
    let dead = false;

    const die = (err: Error) => {
      dead = true;
      worker.terminate();
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      onDead(); // the next call starts a fresh worker
    };

    worker.onerror = (ev) => {
      ev.preventDefault?.();
      if (!started) {
        dead = true;
        worker.terminate();
        reject(new WorkerStartError(ev.message || "worker failed to start"));
      } else {
        die(new OcrUnavailableError("internal", ev.message || "The label reader stopped unexpectedly."));
      }
    };

    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.type === "ready") {
        started = true;
        client.info = { runsOn: "worker", loadMs: msg.loadMs, downloadBytes: msg.downloadBytes };
        resolve(client);
      } else if (msg.type === "result") {
        pending.get(msg.id)?.resolve(msg.result);
        pending.delete(msg.id);
      } else if (msg.type === "error") {
        const err = new OcrUnavailableError(msg.reason, msg.message);
        if (msg.id === undefined) {
          // The engine failed to load inside a working worker — memory, a bad
          // download, a hash mismatch. The main thread would fail the same way,
          // so this is final rather than a reason to fall back.
          started = true;
          worker.terminate();
          dead = true;
          reject(err);
        } else {
          pending.get(msg.id)?.reject(err);
          pending.delete(msg.id);
        }
      }
    };

    const client: Client = {
      info: { runsOn: "worker", loadMs: 0, downloadBytes: 0 },
      run(pixels, width, height, maxSide) {
        if (dead) return Promise.reject(new OcrUnavailableError("internal", "The label reader stopped."));
        const id = nextId++;
        return new Promise<EngineResult>((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          const msg: ToWorker = { type: "run", id, width, height, pixels: pixels.buffer as ArrayBuffer, maxSide };
          // Transferred, not copied: a 12 MP frame is 48 MB of RGBA.
          worker.postMessage(msg, [pixels.buffer as ArrayBuffer]);
        });
      },
    };

    const init: ToWorker = { type: "init", urls };
    worker.postMessage(init);
  });
}

async function startMainThread(urls: FileUrls): Promise<Client> {
  const t0 = performance.now();
  const [ort, { loadEngine }, { classifyError }] = await Promise.all([
    import("onnxruntime-web/wasm"),
    import("./ocr/load"),
    import("./ocr/engine"),
  ]);
  try {
    const { engine, downloadBytes } = await loadEngine(ort, urls);
    return {
      info: { runsOn: "main", loadMs: performance.now() - t0, downloadBytes },
      run: (pixels, width, height, maxSide) => engine.run(pixels, width, height, { maxSide }),
    };
  } catch (e) {
    throw classifyError(e);
  }
}

let current: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  if (!current) {
    const attempt: Promise<Client> = (async () => {
      checkSupport();
      const urls = fileUrls();
      try {
        return await startWorker(urls, () => {
          if (current === attempt) current = null;
        });
      } catch (e) {
        if (!(e instanceof WorkerStartError)) throw e;
        // A worker is only about keeping the camera smooth. If this browser
        // can't start one, reading on the main thread is slower to look at but
        // gives the same tokens.
        return startMainThread(urls);
      }
    })();
    current = attempt;
    // A failed load isn't cached: the next call (say, after the network comes
    // back) tries again from scratch.
    attempt.catch(() => {
      if (current === attempt) current = null;
    });
  }
  return current;
}

/** Fetch and warm the model ahead of the first scan, so the shutter feels instant. Safe to call repeatedly; concurrent calls share one load. */
export async function preloadOcr(): Promise<void> {
  await getClient();
}

/** How the loaded reader is running, or null before it has loaded. For diagnostics. */
export async function ocrLoadInfo(): Promise<OcrLoadInfo | null> {
  if (!current) return null;
  try {
    return (await current).info;
  } catch {
    return null;
  }
}

/**
 * Beyond this many pixels a canvas may refuse to allocate at all (iOS caps a
 * canvas at 16.7 MP), so larger photos are scaled by the browser before our own
 * resampler takes over. Phone cameras save 12 MP by default, under the cap;
 * only 48–50 MP modes hit this path.
 */
const MAX_DECODE_PIXELS = 16_000_000;

interface Source {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decodeBlob(blob: Blob): Promise<Source> {
  try {
    // "from-image" applies the EXIF orientation, so a portrait phone photo
    // arrives upright and token coordinates match what a person sees.
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    // Some Safari versions reject createImageBitmap options or certain files.
    // An <img> element decodes anything the browser can show, and drawImage of
    // an <img> honours EXIF orientation in every current browser.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("That file couldn't be opened as an image.");
    }
  }
}

async function rasterize(image: Blob | ImageBitmap | HTMLCanvasElement): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  origWidth: number;
  origHeight: number;
}> {
  let src: Source;
  if (image instanceof Blob) src = await decodeBlob(image);
  else src = { source: image, width: image.width, height: image.height, close: () => undefined };
  try {
    const { width: ow, height: oh } = src;
    if (!ow || !oh) throw new Error("That image is empty.");
    let w = ow;
    let h = oh;
    if (ow * oh > MAX_DECODE_PIXELS) {
      const s = Math.sqrt(MAX_DECODE_PIXELS / (ow * oh));
      w = Math.floor(ow * s);
      h = Math.floor(oh * s);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new OcrUnavailableError("memory", "Couldn't allocate a canvas for this image.");
    // At 1:1 this is a straight copy — no resampling — so the pixels the reader
    // sees are exactly the decoder's.
    ctx.drawImage(src.source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0; // release the backing store now, not at GC
    return { data, width: w, height: h, origWidth: ow, origHeight: oh };
  } finally {
    src.close();
  }
}

/** recognize(), plus where the time went. The dev harness uses this; the app needs only recognize(). */
export async function recognizeDetailed(
  image: Blob | ImageBitmap | HTMLCanvasElement,
  opts: { maxSide?: number } = {},
): Promise<{ page: OcrPage; timings: RecognizeTimings }> {
  const t0 = performance.now();
  const client = await getClient();
  const t1 = performance.now();
  const px = await rasterize(image);
  const t2 = performance.now();
  const r = await client.run(px.data, px.width, px.height, opts.maxSide);
  // Only differs from 1 for photos over MAX_DECODE_PIXELS.
  const sx = px.origWidth / px.width;
  const sy = px.origHeight / px.height;
  const tokens =
    sx === 1 && sy === 1
      ? r.tokens
      : r.tokens.map((tk) => ({ ...tk, x: tk.x * sx, y: tk.y * sy, w: tk.w * sx, h: tk.h * sy }));
  const page: OcrPage = {
    width: px.origWidth,
    height: px.origHeight,
    tokens,
    engine: OCR_ENGINE,
    ms: Math.round(performance.now() - t0),
  };
  return {
    page,
    timings: {
      waitMs: t1 - t0,
      decodeMs: t2 - t1,
      prepMs: r.timings.prepMs,
      detMs: r.timings.detMs,
      recMs: r.timings.recMs,
      boxes: r.timings.boxes,
      workWidth: r.timings.workWidth,
      workHeight: r.timings.workHeight,
      runsOn: client.info.runsOn,
    },
  };
}

/** Recognise every run of text in an image. Deterministic for a given image and OCR_ENGINE. */
export async function recognize(image: Blob | ImageBitmap | HTMLCanvasElement): Promise<OcrPage> {
  return (await recognizeDetailed(image)).page;
}
