// The public face of label scanning. Nobody edits this file — each module behind
// it has exactly one owner (see the header of types.ts).
export * from "./types";
export * from "./rules";
export { verify } from "./verify";
export { suggestRepairs } from "./repair";
export { parseLabel } from "./parse";
export { OCR_ENGINE, preloadOcr, recognize } from "./ocr";
export { toLabelFood, type Confirmed } from "./food";
