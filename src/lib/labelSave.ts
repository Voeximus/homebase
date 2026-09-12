// Share a label a person confirmed with the other phone.
//
// The household food cache (food_cache) is readable by both phones and writable
// ONLY by the service role — a client that could write there could poison a
// shared nutrition database for both people (schema_v35_food_cache.sql). So the
// phone does not write it. It hands the confirmed panel to the food-label-save
// edge function, which re-runs the verifier itself and refuses anything the label
// doesn't agree with — the phone's own verdict is never trusted.
//
// This is a BONUS, not the save. By the time this runs the food is already in
// the household's library, so every failure here is logged and swallowed: a dead
// function, an expired session or a refusal costs the next scan a photo, nothing
// more.
import { supabase } from "./supabase";
import type { FieldKey, ParsedPanel } from "./labelScan/types";

export interface LabelSaveRequest {
  /** As scanned; the server canonicalises it. */
  barcode: string;
  /** The panel as the person left it, suggestions they accepted included. */
  panel: ParsedPanel;
  /** Amounts the person changed from the original read. */
  overrides: Partial<Record<FieldKey, number>>;
  /** The serving the person confirmed (types.ts rule 3). */
  servingGrams: number;
  name: string;
  brand?: string;
  engine?: string;
  columnIndex?: number;
}

export type LabelSaveOutcome = "shared" | "refused" | "skipped" | "failed";

export async function saveLabelFood(req: LabelSaveRequest): Promise<LabelSaveOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke("food-label-save", { body: req });
    if (error) {
      // A 409 (the server's verifier disagreed) arrives here too, as a
      // FunctionsHttpError. Either way the local save stands.
      console.warn("food-label-save: not shared", error);
      return "failed";
    }
    if (data?.saved) return "shared";
    console.info("food-label-save: not shared —", data?.reason ?? "no reason given");
    return data?.reason ? "skipped" : "refused";
  } catch (e) {
    console.warn("food-label-save: not shared", e);
    return "failed";
  }
}
