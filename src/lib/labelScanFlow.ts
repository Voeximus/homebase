// The non-visual half of LabelScanFlow: the read pipeline and the LabelFood → Food
// mapping. Kept out of the component file so the component module exports only
// components (react-refresh needs that to hot-reload it), and so both halves are
// testable without a DOM.
import { canonicalGtin } from "./gtin";
import { guessRole } from "./barcode";
import { rowId } from "./mealLog";
import type { Food } from "./nutrition";
import { recognize } from "./labelScan/ocr";
import { parseLabel } from "./labelScan/parse";
import { verify } from "./labelScan/verify";
import { suggestRepairs } from "./labelScan/repair";
import type { LabelFood, OcrPage, ParsedPanel, Repair, Verification } from "./labelScan/types";

// ── the read, as a plain async function (tested without a DOM) ───────────────

export interface LabelReadDeps {
  recognize: (image: Blob) => Promise<OcrPage>;
  parseLabel: (page: OcrPage) => ParsedPanel | null;
  verify: (panel: ParsedPanel, columnIndex?: number) => Verification;
  suggestRepairs: (panel: ParsedPanel, columnIndex?: number) => Repair[];
}

export type LabelReadResult =
  | { ok: true; panel: ParsedPanel; verification: Verification; repairs: Repair[]; engine: string }
  /** read: OCR failed · parse: the parser failed · no-panel: no nutrition panel in the photo · check: the verifier failed */
  | { ok: false; stage: "read" | "parse" | "no-panel" | "check"; detail?: string };

const REAL_DEPS: LabelReadDeps = { recognize, parseLabel, verify, suggestRepairs };

const detailOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function readLabel(image: Blob, deps: LabelReadDeps = REAL_DEPS): Promise<LabelReadResult> {
  let page: OcrPage;
  try {
    page = await deps.recognize(image);
  } catch (e) {
    return { ok: false, stage: "read", detail: detailOf(e) };
  }
  let panel: ParsedPanel | null;
  try {
    panel = deps.parseLabel(page);
  } catch (e) {
    return { ok: false, stage: "parse", detail: detailOf(e) };
  }
  if (!panel || panel.columns.length === 0) return { ok: false, stage: "no-panel" };
  let verification: Verification;
  try {
    verification = deps.verify(panel, 0);
  } catch (e) {
    return { ok: false, stage: "check", detail: detailOf(e) };
  }
  // Suggestions are a convenience. If the suggester fails, the person still gets
  // every verdict and can type over a number — so this failure is not a dead end.
  let repairs: Repair[] = [];
  if (!verification.consistent) {
    try {
      repairs = deps.suggestRepairs(panel, 0);
    } catch (e) {
      console.warn("label scan: no suggestions —", detailOf(e));
    }
  }
  return { ok: true, panel, verification, repairs, engine: page.engine };
}

/** A confirmed LabelFood → the app's Food, with the same name-based role guess a barcode hit gets. */
export function labelFoodToFood(food: LabelFood): Food {
  const barcode = food.barcode ? canonicalGtin(food.barcode) : undefined;
  return {
    id: `label-${barcode ?? rowId()}`,
    name: food.name,
    role: guessRole(food.name),
    kcal: food.kcal,
    p: food.p,
    c: food.c,
    f: food.f,
    ...(food.serving && food.serving > 0 ? { serving: food.serving } : {}),
    ...(barcode ? { barcode } : {}),
  };
}
