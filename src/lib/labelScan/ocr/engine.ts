// ── The engine: ONNX sessions wrapped around the pure pipeline ───────────────
//
// Environment-neutral on purpose. The onnxruntime module and the file bytes are
// handed IN, so this exact code runs in the Web Worker (onnxruntime-web/wasm),
// on the main thread when a worker can't start, and in Node for the tests and
// the smoke script (onnxruntime-web's Node build, same WASM kernels).

import type * as OrtNS from "onnxruntime-web";
import type { OcrToken } from "../types";
import { OcrUnavailableError } from "./errors";
import { MODEL_FILES, type ModelFile } from "./manifest";
import { readImage, toWorkingImage, type Infer } from "./pipeline";

export type Ort = typeof OrtNS;

export interface EngineTimings {
  /** Pixels → working image (our own resampler). */
  prepMs: number;
  detMs: number;
  recMs: number;
  /** Text regions the detector proposed, before empty reads were dropped. */
  boxes: number;
  workWidth: number;
  workHeight: number;
}

export interface EngineResult {
  width: number;
  height: number;
  tokens: OcrToken[];
  timings: EngineTimings;
}

export interface Engine {
  /** `maxSide` overrides MAX_SIDE — for measuring the trade-off, not for the app. */
  run(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, opts?: { maxSide?: number }): Promise<EngineResult>;
}


/** Classify a thrown runtime error. A WASM heap that can't grow surfaces as a RangeError or an abort mentioning memory. */
export function classifyError(e: unknown): OcrUnavailableError {
  if (e instanceof OcrUnavailableError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof RangeError || /memory|allocat|OOM|out of bounds/i.test(msg)) {
    return new OcrUnavailableError("memory", `This device ran out of memory while reading the label (${msg}).`);
  }
  return new OcrUnavailableError("internal", msg);
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * SHA-256 of a buffer, or null where SubtleCrypto doesn't exist. It is missing
 * only on insecure origins — e.g. the dev server opened over plain http from a
 * phone on the LAN. Production is https, so there the check always runs.
 */
export async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  return toHex(await subtle.digest("SHA-256", buf));
}

/** Refuse bytes that aren't the pinned file. A silent weight swap would break rule 5 without any visible symptom. */
export async function verifyFile(name: ModelFile, buf: ArrayBuffer): Promise<void> {
  const got = await sha256Hex(buf);
  if (got !== null && got !== MODEL_FILES[name].sha256) {
    throw new OcrUnavailableError(
      "integrity",
      `${MODEL_FILES[name].file} does not match the pinned weights (sha256 ${got.slice(0, 12)}…, expected ${MODEL_FILES[name].sha256.slice(0, 12)}…).`,
    );
  }
}

export async function createEngine(
  ort: Ort,
  files: { det: ArrayBuffer; rec: ArrayBuffer; dict: ArrayBuffer },
): Promise<Engine> {
  await Promise.all([verifyFile("det", files.det), verifyFile("rec", files.rec), verifyFile("dict", files.dict)]);
  const dict = JSON.parse(new TextDecoder().decode(files.dict)) as string[];

  // One thread, WASM only, and that is a determinism decision rather than a
  // speed one. WebGPU kernels are driver- and GPU-dependent floating point, so
  // the same photo could read differently on the two phones; multi-threaded WASM
  // also needs cross-origin isolation, which GitHub Pages can't provide.
  ort.env.wasm.numThreads = 1;
  const options: OrtNS.InferenceSession.SessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  };
  let det: OrtNS.InferenceSession;
  let rec: OrtNS.InferenceSession;
  try {
    det = await ort.InferenceSession.create(new Uint8Array(files.det), options);
    rec = await ort.InferenceSession.create(new Uint8Array(files.rec), options);
  } catch (e) {
    throw classifyError(e);
  }

  const infer: Infer = async (model, input, dims) => {
    const session = model === "det" ? det : rec;
    const tensor = new ort.Tensor("float32", input, dims);
    try {
      const out = await session.run({ [session.inputNames[0]]: tensor });
      const t = out[session.outputNames[0]];
      return { data: t.data as Float32Array, dims: t.dims };
    } finally {
      tensor.dispose();
    }
  };

  // A session can't run two inferences at once; serialise whole images so two
  // quick shutter taps queue instead of throwing "session already started".
  let queue: Promise<unknown> = Promise.resolve();

  return {
    run(rgba, width, height, opts) {
      const job = queue.then(async (): Promise<EngineResult> => {
        try {
          const t0 = performance.now();
          const work = toWorkingImage(rgba, width, height, opts?.maxSide);
          const prepMs = performance.now() - t0;
          const { tokens, timings } = await readImage(work, infer, dict);
          // Back to ORIGINAL pixel coordinates: the working image is a uniform
          // scale of the original, so one factor per axis undoes it.
          const sx = width / work.width;
          const sy = height / work.height;
          const r1 = (v: number) => Math.round(v * 10) / 10;
          const out: OcrToken[] = tokens.map((tk) => {
            const xs = tk.quad.map((p) => p[0]);
            const ys = tk.quad.map((p) => p[1]);
            const x0 = Math.min(...xs), x1 = Math.max(...xs);
            const y0 = Math.min(...ys), y1 = Math.max(...ys);
            return {
              text: tk.text,
              x: r1(x0 * sx),
              y: r1(y0 * sy),
              w: r1((x1 - x0) * sx),
              h: r1((y1 - y0) * sy),
              conf: Math.round(tk.conf * 10000) / 10000,
            };
          });
          return {
            width,
            height,
            tokens: out,
            timings: { prepMs, detMs: timings.detMs, recMs: timings.recMs, boxes: timings.boxes, workWidth: work.width, workHeight: work.height },
          };
        } catch (e) {
          throw classifyError(e);
        }
      });
      queue = job.catch(() => undefined);
      return job;
    },
  };
}
