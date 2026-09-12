// OWNER: confirm-and-save agent.
//
// A confirmed panel → the per-100 g food the app stores.
//
// This is the LAST step, and it runs only on numbers a person has already
// looked at: the serving they confirmed (types.ts rule 3), and any value they
// accepted from a suggestion or typed over the read (rule 2). It does no
// checking of its own — verify() is the only judge of whether the label agrees
// with itself — it only does the arithmetic, and refuses loudly when the
// arithmetic has nothing to stand on.
//
// Mirrored for the food-label-save edge function at
// supabase/functions/_shared/labelScan/food.ts, so the server computes exactly
// the numbers the phone showed.
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

/** One decimal, the same rounding lib/barcode.ts applies to every catalog answer. */
const r1 = (n: number) => Math.round(n * 10) / 10;

/** kJ → kcal. The thermochemical calorie; the factor Open Food Facts and lib/barcode.ts use. */
const KJ_PER_KCAL = 4.184;

/** A confirmed panel → the per-100 g food the app stores. */
export function toLabelFood(panel: ParsedPanel, confirmed: Confirmed, engine?: string): LabelFood {
  const columnIndex = confirmed.columnIndex ?? 0;
  const column = panel.columns[columnIndex];
  if (!column) throw new Error(`toLabelFood: the label has no column ${columnIndex} to save from.`);

  const serving = confirmed.servingGrams;
  if (!Number.isFinite(serving) || serving <= 0) {
    throw new Error("toLabelFood: the serving size must be confirmed as a weight above 0 g before saving.");
  }

  // What the person settled on for a field: their value first, then the read.
  // A "<1 g" read is kept at its printed bound — this step invents no digits.
  const settled = (k: FieldKey): number | undefined => {
    const v = confirmed.overrides?.[k] ?? column.fields[k]?.value;
    if (v == null) return undefined;
    if (!Number.isFinite(v) || v < 0) throw new Error(`toLabelFood: ${k} is not a usable amount (${v}).`);
    return v;
  };

  const kcalRead = settled("kcal");
  const kjRead = settled("kj");
  const fat = settled("fat");
  const carb = settled("carb");
  const prot = settled("prot");

  const absent: string[] = [];
  if (kcalRead == null && kjRead == null) absent.push("energy (kcal or kJ)");
  if (fat == null) absent.push("fat");
  if (carb == null) absent.push("carbohydrate");
  if (prot == null) absent.push("protein");
  if (absent.length) {
    throw new Error(`toLabelFood: the label is missing ${absent.join(", ")} — type it in from the label before saving.`);
  }

  // Per serving → per 100 g uses the CONFIRMED serving. Per 100 g / 100 ml is
  // already the stored basis (ml is treated as g, as everywhere else in the app).
  const scale = column.basis === "serving" ? 100 / serving : 1;
  const kcal = kcalRead ?? kjRead! / KJ_PER_KCAL;

  const food: LabelFood = {
    name: confirmed.name.trim(),
    kcal: r1(kcal * scale),
    p: r1(prot! * scale),
    c: r1(carb! * scale),
    f: r1(fat! * scale),
    serving,
    source: "label",
  };
  if (confirmed.brand?.trim()) food.brand = confirmed.brand.trim();
  if (confirmed.barcode) food.barcode = confirmed.barcode;
  if (engine) food.engine = engine;
  return food;
}
