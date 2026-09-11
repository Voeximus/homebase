import type { FoodRole } from "./nutrition";
import { canonicalGtin, digitsOnly, gtinVariants } from "./gtin";
import { supabase } from "./supabase";

export interface BarcodeResult {
  name: string;
  kcal: number;
  p: number;
  c: number;
  f: number;
  barcode: string;
  role: FoodRole;
  serving?: number;
  /** Which catalog answered — shown so a surprising number is traceable. */
  source?: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Rough role guess from the product name so the form lands on something sane. */
function guessRole(name: string): FoodRole {
  const n = name.toLowerCase();
  if (/chicken|beef|pork|turkey|fish|salmon|tuna|shrimp|tofu|egg|protein|whey|jerky|yogurt|greek|bean|lentil|edamame/.test(n))
    return "protein";
  if (/rice|noodle|pasta|bread|oat|cereal|potato|tortilla|bun|cracker|banana|fruit|sugar|juice|soda|granola|bagel|candy|chocolate/.test(n))
    return "carb";
  if (/oil|butter|\bnut\b|nuts|almond|peanut|cashew|avocado|cheese|mayo|cream|tahini/.test(n)) return "fat";
  if (/broccoli|spinach|lettuce|kale|pepper|carrot|veg|greens|cabbage|cucumber|tomato|salad|mushroom|onion/.test(n))
    return "veg";
  return "other";
}

/**
 * Did the source actually STATE this nutrition, or is the record empty?
 *
 * A product with empty nutrition fields is not a hit: the old code defaulted
 * every missing macro to 0 and returned the row anyway, so a product whose name
 * Open Food Facts knows but whose nutrition nobody has entered came back as a
 * real food with 0 calories and went into a day's totals.
 *
 * But the test is PRESENCE, not magnitude. Writing it as "are the numbers above
 * zero" — which is what the first version said — makes Diet Coke, black coffee
 * and sparkling water indistinguishable from missing data. Their zeros are the
 * correct answer.
 */
const usable = (h: { present: boolean }) => h.present;

// ── the wide path: every source, through the server ──────────────────────────

/**
 * Ask the `food-lookup` edge function, which fans out across Open Food Facts,
 * USDA FoodData Central and the household's own cache — and which can hold an
 * API key and ignore CORS, neither of which a browser can do.
 */
async function viaService(code: string): Promise<BarcodeResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke("food-lookup", { body: { code } });
    if (error || !data?.hit) return null;
    const h = data.hit;
    // No second-guessing the server's verdict here: it already applied the
    // presence test, and re-testing for non-zero would throw away exactly the
    // zero-calorie products that test exists to keep.
    const macros = { kcal: r1(h.kcal ?? 0), p: r1(h.p ?? 0), c: r1(h.c ?? 0), f: r1(h.f ?? 0) };
    const name =
      h.brand && h.name && !h.name.toLowerCase().includes(String(h.brand).toLowerCase())
        ? `${h.brand} ${h.name}`
        : h.name;
    return {
      name,
      ...macros,
      serving: h.serving,
      barcode: h.barcode ?? canonicalGtin(code),
      role: guessRole(name),
      source: h.source,
    };
  } catch {
    return null;
  }
}

// ── the floor: Open Food Facts, straight from the phone ──────────────────────

function offMacros(n: Record<string, number>, servingG?: number) {
  const per100 = (base: string): number | undefined => {
    const direct = n[`${base}_100g`];
    if (Number.isFinite(direct)) return direct;
    const serv = n[`${base}_serving`];
    if (Number.isFinite(serv) && servingG && servingG > 0) return (serv / servingG) * 100;
    return undefined;
  };
  const rawP = per100("proteins");
  const rawC = per100("carbohydrates");
  const rawF = per100("fat");
  const p = rawP ?? 0;
  const c = rawC ?? 0;
  const f = rawF ?? 0;
  let kcal = per100("energy-kcal");
  const hadEnergy = kcal != null;
  if (kcal == null) {
    const kj = per100("energy"); // OFF stores `energy_100g` in kilojoules
    if (kj != null) kcal = kj / 4.184;
  }
  if (kcal == null && (rawP != null || rawC != null || rawF != null)) kcal = 4 * p + 4 * c + 9 * f;
  const present = hadEnergy || kcal != null || rawP != null || rawC != null || rawF != null;
  return { kcal: r1(kcal ?? 0), p: r1(p), c: r1(c), f: r1(f), present };
}

async function directOff(code: string): Promise<BarcodeResult | null> {
  const url =
    `https://world.openfoodfacts.org/api/v2/product/${code}.json` +
    `?fields=product_name,product_name_en,generic_name,brands,nutriments,serving_quantity`;
  let data: {
    status?: number;
    product?: {
      product_name?: string;
      product_name_en?: string;
      generic_name?: string;
      brands?: string;
      nutriments?: Record<string, number>;
      serving_quantity?: number | string;
    };
  };
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const prod = data.product;
  if (!prod || data.status === 0) return null;

  const servingG = Number(prod.serving_quantity);
  const { present, ...macros } = offMacros(
    prod.nutriments ?? {},
    Number.isFinite(servingG) ? servingG : undefined,
  );
  if (!usable({ present })) return null;

  const brand = prod.brands?.split(",")[0]?.trim();
  const pname = (prod.product_name_en || prod.product_name || prod.generic_name)?.trim();
  if (!pname && !brand) return null;
  let name = pname || brand || "Scanned product";
  if (brand && pname && !pname.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${pname}`;

  return {
    name,
    ...macros,
    serving: Number.isFinite(servingG) && servingG > 0 ? Math.round(servingG) : undefined,
    barcode: canonicalGtin(code),
    role: guessRole(name),
    source: "openfoodfacts",
  };
}

/**
 * Look a scanned barcode up and return per-100g macros, or null.
 *
 * Two paths, deliberately. The service path is the wide one — several catalogs
 * plus the household's own cache. The direct path is the FLOOR: it is close to
 * what the app did before, so a dead edge function, an expired session or a
 * flaky connection degrades to the old behaviour instead of to nothing.
 *
 * The direct path asks for the CANONICAL form first and only then walks the
 * other variants. Measured, that ordering is what matters: Open Food Facts
 * normalizes 12/13/14-digit codes itself, so the extra forms rescue nothing
 * there — but canonicalGtin expands a UPC-E, and a UPC-E is 8 digits that no
 * catalog keys on. The remaining variants cost a request only after a miss, and
 * OFF rate-limits, so they are tried last rather than first.
 */
export async function lookupBarcode(code: string): Promise<BarcodeResult | null> {
  const clean = digitsOnly(code);
  if (!clean) return null;

  const wide = await viaService(clean);
  if (wide) return wide;

  const canonical = canonicalGtin(clean);
  const first = await directOff(canonical);
  if (first) return first;
  for (const variant of gtinVariants(clean)) {
    if (variant === canonical) continue;
    const hit = await directOff(variant);
    if (hit) return hit;
  }
  return null;
}
