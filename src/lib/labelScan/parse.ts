// OWNER: parser agent. Placeholder — replace the body, keep the signature.
import type { OcrPage, ParsedPanel } from "./types";

/** OCR tokens → a structured panel, or null when no nutrition panel is found. Never changes a digit (types.ts rule 1). */
export function parseLabel(_page: OcrPage): ParsedPanel | null {
  throw new Error("parseLabel: not implemented");
}
