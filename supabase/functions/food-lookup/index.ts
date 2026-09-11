// food-lookup — turn a scanned barcode into per-100g macros, from every source
// we can reach.
//
// WHY THIS IS A SERVER FUNCTION AND NOT A FETCH IN THE APP
//
// The app used to call Open Food Facts directly and that was the whole database.
// OFF is excellent and free, but it is one catalog with one set of gaps — a US
// store brand, a regional snack, anything from a small label, and the app says
// "not in the food database" and the scan was wasted. Widening it needs three
// things a browser cannot do:
//
//   · USDA FoodData Central's ~2M branded US products needs an API key, and a
//     key in the browser bundle is a published key.
//   · Most nutrition APIs do not send CORS headers, so the browser is not
//     allowed to read the answer even when it arrives.
//   · A CACHE. A product looked up once should never cost a round trip again,
//     for either phone — and the cache has to live somewhere both phones see.
//
// So the fan-out lives here. The app keeps a direct-to-OFF fallback for when
// this function is unreachable, which makes this strictly additive: the worst
// case is the behaviour it had before.
//
// AUTHORIZATION: household users only, via denyUnlessCaller — the same gate as
// `notify`. `verify_jwt = true` alone is not enough; it accepts the publishable
// key that ships in the public browser bundle. See _shared/callerAuth.ts.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { denyUnlessCaller } from "../_shared/callerAuth.ts";
import { canonicalGtin, digitsOnly, gtinVariants } from "../_shared/gtin.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Open Food Facts asks every caller to identify itself, and throttles the ones
// that do not. Being a good citizen here is also self-interest: an anonymous
// scraper gets rate-limited mid-grocery-shop.
const UA = "Homebase/1.0 (household meal logger; https://voeximus.github.io/homebase/)";

// DEMO_KEY works and is rate-limited to ~30 requests/hour per IP, which is fine
// for a two-person household but will occasionally 429 in a long shop. A real
// key is free at https://fdc.nal.usda.gov/api-key-signup.html — set it as the
// USDA_FDC_KEY function secret and this line picks it up with no redeploy of
// anything else.
const FDC_KEY = Deno.env.get("USDA_FDC_KEY") ?? "DEMO_KEY";

export interface FoodHit {
  name: string;
  brand?: string;
  kcal: number;
  p: number;
  c: number;
  f: number;
  serving?: number; // grams in one labelled serving, when the source states one
  barcode: string; // canonical (EAN-13) form
  source: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Is this a usable nutrition reading, or a product record with the nutrition
 * fields empty?
 *
 * This is the difference between "we don't have it" and a LIE. The old code
 * defaulted every missing macro to 0 and returned the row, so a product that OFF
 * knows the name of but not the nutrition of came back as a real food with 0
 * calories and went straight into a day's totals.
 *
 * But the test cannot be "are the numbers above zero", which is what the first
 * version of this said. A live probe caught it immediately: Diet Coke is 0 kcal,
 * 0 protein, 0 carbs, 0 fat — a true and complete reading — and the function
 * reported "not in any source" for it. Same for black coffee, sparkling water,
 * zero-calorie sweetener. The question is whether the fields were THERE, not
 * whether they were non-zero.
 */
function usable(h: { present: boolean }): boolean {
  return h.present;
}

// ── Open Food Facts ──────────────────────────────────────────────────────────

/**
 * Pull per-100g macros out of an OFF `nutriments` blob.
 *
 * OFF products are crowd-entered, so the same nutrient turns up under several
 * keys and sometimes only per-serving. Reading only `*_100g` — which is what the
 * app did — throws away every product entered off a US label, where the panel is
 * per serving and the 100g column is computed only when someone filled in the
 * serving size.
 */
function offMacros(n: Record<string, unknown>, servingG?: number) {
  const per100 = (base: string): number | undefined => {
    const direct = num(n[`${base}_100g`]);
    if (direct != null) return direct;
    // Fall back to the per-serving figure scaled by the serving weight.
    const serv = num(n[`${base}_serving`]);
    if (serv != null && servingG && servingG > 0) return (serv / servingG) * 100;
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
    // `energy_100g` is kilojoules by OFF convention.
    const kj = per100("energy");
    if (kj != null) kcal = kj / 4.184;
  }
  // Last resort: Atwater factors. A label that lists macros but no calorie count
  // is common on imported products, and 4/4/9 is what the calorie count on the
  // panel was computed from anyway.
  if (kcal == null && (rawP != null || rawC != null || rawF != null)) kcal = 4 * p + 4 * c + 9 * f;

  // `present` records whether the source actually STATED any of this, which is
  // not the same question as whether the numbers are non-zero. See usable().
  const present = hadEnergy || kcal != null || rawP != null || rawC != null || rawF != null;
  return { kcal: r1(kcal ?? 0), p: r1(p), c: r1(c), f: r1(f), present };
}

async function fromOpenFoodFacts(code: string): Promise<FoodHit | null> {
  const url =
    `https://world.openfoodfacts.org/api/v2/product/${code}.json` +
    `?fields=code,product_name,product_name_en,generic_name,brands,nutriments,serving_quantity,quantity`;
  let data: Record<string, any>;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const prod = data.product;
  if (!prod || data.status === 0) return null;

  const servingG = num(prod.serving_quantity);
  const { present, ...macros } = offMacros(prod.nutriments ?? {}, servingG);
  if (!usable({ present })) return null;

  const brand = String(prod.brands ?? "").split(",")[0]?.trim() || undefined;
  const pname = String(prod.product_name_en || prod.product_name || prod.generic_name || "").trim();
  if (!pname && !brand) return null;

  return {
    name: pname || brand!,
    brand,
    ...macros,
    serving: servingG && servingG > 0 ? Math.round(servingG) : undefined,
    barcode: canonicalGtin(code),
    source: "openfoodfacts",
  };
}

// ── USDA FoodData Central ────────────────────────────────────────────────────

// FDC identifies nutrients by number, not name — the names vary across the
// datasets it merges ("Energy" vs "Energy (Atwater General Factors)").
const FDC_ENERGY = "208";
const FDC_PROTEIN = "203";
const FDC_FAT = "204";
const FDC_CARB = "205";

/**
 * USDA's Branded Food Products database — roughly two million US retail items,
 * sourced from the manufacturers' own label submissions.
 *
 * This is the source that covers what Open Food Facts misses in an American
 * grocery store: store brands, regional products, and anything too new or too
 * small for a volunteer to have photographed.
 *
 * Searched rather than fetched by id, because FDC has no by-GTIN endpoint — and
 * then the returned `gtinUpc` is verified against the variants of the code that
 * was actually scanned, because a full-text search for a number WILL return
 * near-misses and a near-miss here is the wrong food logged as the right one.
 */
async function fromUsda(code: string, accept: Set<string>): Promise<FoodHit | null> {
  const url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${FDC_KEY}` +
    `&query=${encodeURIComponent(code)}&dataType=Branded&pageSize=5`;
  let data: Record<string, any>;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  for (const food of data.foods ?? []) {
    const gtin = digitsOnly(String(food.gtinUpc ?? ""));
    if (!gtin) continue;
    // Exact-match on the number, in any of its printed forms. Never fuzzy.
    if (!accept.has(gtin) && !gtinVariants(gtin).some((v) => accept.has(v))) continue;

    const by: Record<string, number> = {};
    for (const n of food.foodNutrients ?? []) {
      const id = String(n.nutrientNumber ?? n.number ?? "");
      const amount = num(n.value ?? n.amount);
      if (id && amount != null) by[id] = amount;
    }
    // Branded FDC amounts are per 100 g.
    const p = by[FDC_PROTEIN] ?? 0;
    const c = by[FDC_CARB] ?? 0;
    const f = by[FDC_FAT] ?? 0;
    const kcal = by[FDC_ENERGY] ?? 4 * p + 4 * c + 9 * f;
    // Presence, not magnitude — a zero-calorie product states zeros. See usable().
    const present =
      by[FDC_ENERGY] != null || by[FDC_PROTEIN] != null || by[FDC_CARB] != null || by[FDC_FAT] != null;
    const macros = { kcal: r1(kcal), p: r1(p), c: r1(c), f: r1(f) };
    if (!usable({ present })) continue;

    const brand = String(food.brandOwner ?? food.brandName ?? "").trim() || undefined;
    const name = String(food.description ?? "").trim();
    if (!name) continue;
    const servingG =
      String(food.servingSizeUnit ?? "").toLowerCase() === "g" ? num(food.servingSize) : undefined;

    return {
      name,
      brand,
      ...macros,
      serving: servingG && servingG > 0 ? Math.round(servingG) : undefined,
      barcode: canonicalGtin(code),
      source: "usda",
    };
  }
  return null;
}

// ── cache ────────────────────────────────────────────────────────────────────

// Negative results expire; positive ones do not. Open Food Facts gains products
// every day, so "not found" is a statement about today, not about the product —
// caching it forever would permanently lock in a gap that fixed itself.
const MISS_TTL_DAYS = 7;

async function readCache(variants: string[]): Promise<{ hit: FoodHit | null; known: boolean }> {
  const { data } = await admin
    .from("food_cache")
    .select("code, payload, found, checked_at")
    .in("code", variants)
    .order("found", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return { hit: null, known: false };
  if (row.found) return { hit: row.payload as FoodHit, known: true };
  const age = (Date.now() - new Date(row.checked_at).getTime()) / 86_400_000;
  return { hit: null, known: age < MISS_TTL_DAYS };
}

async function writeCache(code: string, hit: FoodHit | null) {
  await admin.from("food_cache").upsert(
    {
      code: canonicalGtin(code),
      payload: hit,
      found: !!hit,
      source: hit?.source ?? null,
      checked_at: new Date().toISOString(),
    },
    { onConflict: "code" },
  );
}

// ── handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const denied = await denyUnlessCaller(req, admin, CORS);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const raw = String(body?.code ?? "");
    const variants = gtinVariants(raw);
    if (!variants.length) return json({ error: "no code" }, 400);

    // Cheap first: a product either phone has already scanned.
    const cached = await readCache(variants);
    if (cached.hit) return json({ hit: { ...cached.hit, source: `${cached.hit.source} (cached)` } });
    if (cached.known) return json({ hit: null, reason: "not in any source" });

    const accept = new Set(variants);

    // ONE request to Open Food Facts, not one per printed form.
    //
    // The first version of this asked OFF for every variant. Probing it directly
    // shows that is pure waste: OFF normalizes the code server-side, so
    // 049000028911, 0049000028911 and 00049000028911 all return the same
    // product. Across a 61-product sample the extra requests rescued nothing —
    // and OFF rate-limits hard enough that the probe itself kept hitting 429s,
    // so four requests per scan would have made the scanner slower AND more
    // likely to fail mid-grocery-shop.
    //
    // canonicalGtin still does the one normalization OFF cannot do for us:
    // expanding a UPC-E, which arrives from the camera as 8 digits that no
    // catalog keys on.
    const offHit = await fromOpenFoodFacts(canonicalGtin(raw));
    if (offHit) {
      await writeCache(raw, offHit);
      return json({ hit: offHit });
    }

    // USDA's Branded database is the measured win: on that same neutral sample
    // of 61 real US shelf products, Open Food Facts had usable nutrition for 57
    // and USDA covered the remaining 4 — a yogurt loaf, yogurt peanuts, a
    // tortilla soup and tortilla strips. Exactly the small-label, store-brand
    // shape of product a volunteer catalog is thinnest on.
    //
    // FDC is searched by number rather than fetched by id (it has no by-GTIN
    // endpoint), and the result is then verified against the full variant set,
    // because a full-text search for a number WILL return near-misses and a
    // near-miss here is the wrong food logged as the right one.
    //
    // Searched AS PRINTED, not canonicalized. A live probe caught this: the four
    // products USDA was added to rescue all came back "not in any source",
    // because the query was the 13-digit canonical form while FDC indexes the
    // 12-digit number off the label. Unlike Open Food Facts, FDC does not
    // normalize — it is a text search, and "0819733000276" is a different string
    // from "819733000276". So ask for each distinct form until one answers.
    for (const code of variants) {
      const usdaHit = await fromUsda(code, accept);
      if (usdaHit) {
        await writeCache(raw, usdaHit);
        return json({ hit: usdaHit });
      }
    }

    await writeCache(raw, null);
    return json({ hit: null, reason: "not in any source" });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
