// OWNER: verifier agent. Placeholder — replace the body, keep the signature.
import type { ParsedPanel, Verification } from "./types";

/** Run every deterministic check on one column of a parsed panel. Pure: same panel in, same verdict out. */
export function verify(_panel: ParsedPanel, _columnIndex = 0): Verification {
  throw new Error("verify: not implemented");
}
