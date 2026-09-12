// Messages between the page (ocr.ts) and the reader's Web Worker (worker.ts).
import type { EngineResult } from "./engine";
import type { OcrFailure } from "./errors";
import type { ModelFile } from "./manifest";

/** Absolute URLs — a worker resolves relative ones against its own script URL, not the page. */
export type FileUrls = Record<ModelFile | "wasm", string>;

export type ToWorker =
  | { type: "init"; urls: FileUrls }
  | { type: "run"; id: number; width: number; height: number; pixels: ArrayBuffer; maxSide?: number };

export type FromWorker =
  | { type: "ready"; loadMs: number; downloadBytes: number }
  | { type: "result"; id: number; result: EngineResult }
  | { type: "error"; id?: number; reason: OcrFailure; message: string };
