// The reader's Web Worker. Model download, WASM compile and every inference run
// here, off the main thread, so the camera preview and the sharpness sampling
// keep their frame rate while a label is being read.

import * as ort from "onnxruntime-web/wasm";
import { classifyError, type Engine } from "./engine";
import { loadEngine } from "./load";
import type { FromWorker, ToWorker } from "./protocol";

// The DOM lib types `self` as Window; this file only ever runs as a dedicated worker.
const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

let engine: Promise<Engine> | null = null;

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    if (engine) return;
    const t0 = performance.now();
    const loading = loadEngine(ort, msg.urls);
    engine = loading.then((r) => r.engine);
    loading.then(
      ({ downloadBytes }) => scope.postMessage({ type: "ready", loadMs: performance.now() - t0, downloadBytes }),
      (err) => {
        const c = classifyError(err);
        engine = null;
        scope.postMessage({ type: "error", reason: c.reason, message: c.message });
      },
    );
    // The page learns of a failed load from the message above; don't also leave
    // an unhandled rejection in the worker's console.
    engine.catch(() => undefined);
    return;
  }
  if (msg.type === "run") {
    const ready = engine;
    if (!ready) {
      scope.postMessage({ type: "error", id: msg.id, reason: "internal", message: "The label reader isn't loaded." });
      return;
    }
    ready
      .then((eng) => eng.run(new Uint8ClampedArray(msg.pixels), msg.width, msg.height, { maxSide: msg.maxSide }))
      .then(
        (result) => scope.postMessage({ type: "result", id: msg.id, result }),
        (err) => {
          const c = classifyError(err);
          scope.postMessage({ type: "error", id: msg.id, reason: c.reason, message: c.message });
        },
      );
  }
};
