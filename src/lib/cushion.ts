// The persisted cushion-strategy choice for the deploy-now plan. This is UI state
// ONLY — the deploy math always re-derives live from debts + cash, so the stored
// key is never load-bearing for money correctness. Mirrors the "hb-fin-*"
// localStorage convention used for the finance tab. (Cross-device Supabase sync is
// deferred — localStorage first, per the design's open decision.)
import type { CushionPreset } from "./plan";

const KEY = "hb-fin-cushion";
export const DEFAULT_CUSHION: CushionPreset = "balanced";
const VALID: readonly CushionPreset[] = ["safe", "balanced", "aggressive"];

export function loadCushion(): CushionPreset {
  try {
    const v = localStorage.getItem(KEY);
    return v && VALID.includes(v as CushionPreset) ? (v as CushionPreset) : DEFAULT_CUSHION;
  } catch {
    return DEFAULT_CUSHION;
  }
}

export function saveCushion(preset: CushionPreset): void {
  try {
    localStorage.setItem(KEY, preset);
  } catch {
    /* ignore */
  }
}
