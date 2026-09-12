// OWNER: confirm-and-save agent. Placeholder — replace the body, keep the signature.
import type { FieldKey, LabelFood, ParsedPanel } from "./types";

export interface Confirmed {
  /** The serving a PERSON confirmed (types.ts rule 3) — never the raw read. */
  servingGrams: number;
  name: string;
  brand?: string;
  barcode?: string;
  /** Values a person accepted or typed over the read, per field. */
  overrides?: Partial<Record<FieldKey, number>>;
  columnIndex?: number;
}

/** A confirmed panel → the per-100 g food the app stores. */
export function toLabelFood(_panel: ParsedPanel, _confirmed: Confirmed, _engine?: string): LabelFood {
  throw new Error("toLabelFood: not implemented");
}
