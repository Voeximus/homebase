// OWNER: verifier agent. Placeholder — replace the body, keep the signature.
import type { ParsedPanel, Repair } from "./types";

/**
 * Single-token repairs that make a conflicting panel consistent, drawn ONLY from
 * known OCR confusions. Suggestions — the caller must never apply one without a
 * person's tap (types.ts rule 2). Empty when the panel is already consistent or
 * no unique repair explains the conflict.
 */
export function suggestRepairs(_panel: ParsedPanel, _columnIndex = 0): Repair[] {
  throw new Error("suggestRepairs: not implemented");
}
