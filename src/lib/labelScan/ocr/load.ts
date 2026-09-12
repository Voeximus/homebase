// Download the pinned files and build an engine. Shared by the worker and the
// main-thread fallback so both load in exactly the same way.

import { createEngine, type Engine, type Ort } from "./engine";
import { OcrUnavailableError } from "./errors";
import type { FileUrls } from "./protocol";

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new OcrUnavailableError("download", `Couldn't download the label reader (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!res.ok) throw new OcrUnavailableError("download", `Couldn't download the label reader (${res.status} for ${url}).`);
  return res.arrayBuffer();
}

export async function loadEngine(ort: Ort, urls: FileUrls): Promise<{ engine: Engine; downloadBytes: number }> {
  const [det, rec, dict, wasm] = await Promise.all([
    fetchBytes(urls.det),
    fetchBytes(urls.rec),
    fetchBytes(urls.dict),
    fetchBytes(urls.wasm),
  ]);
  // Handing ORT the bytes (instead of a path for it to fetch) means the runtime
  // arrives through the same fetch — and the same service-worker cache — as the
  // models, and ORT never has to guess its own URL inside a bundled worker.
  ort.env.wasm.wasmBinary = new Uint8Array(wasm);
  const engine = await createEngine(ort, { det, rec, dict });
  return { engine, downloadBytes: det.byteLength + rec.byteLength + dict.byteLength + wasm.byteLength };
}
