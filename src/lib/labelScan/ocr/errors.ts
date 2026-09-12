// The one error the reader throws on purpose. Kept in its own import-free file
// so the page, the worker and the engine share ONE class (instanceof works)
// without the page importing any of the heavy modules.

/**
 *  unsupported  no WebAssembly, or no WASM SIMD (Safari before 16.4)
 *  memory       the device couldn't allocate the model, canvas or WASM heap
 *  download     the model files couldn't be fetched (offline on a first scan)
 *  integrity    a fetched file isn't the pinned weights
 *  internal     anything else — a bug, reported as-is
 */
export type OcrFailure = "unsupported" | "memory" | "download" | "integrity" | "internal";

export class OcrUnavailableError extends Error {
  readonly reason: OcrFailure;
  constructor(reason: OcrFailure, message: string) {
    super(message);
    this.name = "OcrUnavailableError";
    this.reason = reason;
  }
}
