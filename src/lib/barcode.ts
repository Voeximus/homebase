import type { FoodRole } from "./nutrition";

export interface BarcodeResult {
  name: string;
  kcal: number;
  p: number;
  c: number;
  f: number;
  barcode: string;
  role: FoodRole;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Rough role guess from the product name so the form lands on something sane. */
function guessRole(name: string): FoodRole {
  const n = name.toLowerCase();
  if (/chicken|beef|pork|turkey|fish|salmon|tuna|shrimp|tofu|egg|protein|whey|jerky|yogurt|greek/.test(n))
    return "protein";
  if (/rice|noodle|pasta|bread|oat|cereal|potato|tortilla|bun|cracker|banana|fruit|sugar/.test(n))
    return "carb";
  if (/oil|butter|nut|almond|peanut|avocado|cheese|mayo/.test(n)) return "fat";
  if (/broccoli|spinach|lettuce|kale|pepper|carrot|veg|greens|cabbage|cucumber|tomato/.test(n))
    return "veg";
  return "other";
}

/**
 * Look a barcode (UPC/EAN) up against OpenFoodFacts — free, no key, CORS-open.
 * Returns per-100g macros, or null if the product isn't in their database.
 */
export async function lookupBarcode(code: string): Promise<BarcodeResult | null> {
  const clean = code.replace(/\D/g, "");
  if (!clean) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=product_name,brands,nutriments`;
  let data: {
    status?: number;
    product?: {
      product_name?: string;
      brands?: string;
      nutriments?: Record<string, number>;
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
  const n = prod.nutriments ?? {};
  const kcal =
    n["energy-kcal_100g"] ??
    (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : 0);
  const brand = prod.brands?.split(",")[0]?.trim();
  const pname = prod.product_name?.trim();
  let name = pname || brand || "Scanned product";
  if (brand && pname && !pname.toLowerCase().includes(brand.toLowerCase())) {
    name = `${brand} ${pname}`;
  }
  return {
    name,
    kcal: r1(kcal || 0),
    p: r1(n["proteins_100g"] ?? 0),
    c: r1(n["carbohydrates_100g"] ?? 0),
    f: r1(n["fat_100g"] ?? 0),
    barcode: clean,
    role: guessRole(name),
  };
}
