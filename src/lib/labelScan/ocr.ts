// OWNER: reader agent. Placeholder — replace the bodies, keep the signatures.
import type { OcrPage } from "./types";

/** The exact engine + weights identity stamped onto every OcrPage. */
export const OCR_ENGINE = "unimplemented";

/** Fetch and warm the model ahead of the first scan, so the shutter feels instant. Safe to call repeatedly. */
export async function preloadOcr(): Promise<void> {
  throw new Error("preloadOcr: not implemented");
}

/** Recognise every run of text in an image. Deterministic for a given image and OCR_ENGINE. */
export async function recognize(_image: Blob | ImageBitmap | HTMLCanvasElement): Promise<OcrPage> {
  throw new Error("recognize: not implemented");
}
