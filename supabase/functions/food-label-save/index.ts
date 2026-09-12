// food-label-save — share a nutrition label a person confirmed on one phone with
// the household food cache, so the next scan of that barcode on EITHER phone is
// an instant cache hit instead of another photo.
//
// WHY THIS IS A SERVER FUNCTION
//
// food_cache is readable by both phones and writable only by the service role,
// on purpose: "a client that could write here could poison a shared nutrition
// database for both people" (schema_v35_food_cache.sql). So the phone never
// writes it. It sends what the person confirmed, and this function decides.
//
// WHAT IT TRUSTS, AND WHAT IT DOESN'T
//
//   · It does NOT trust the phone's verdict. It re-runs the same deterministic
//     verifier on the submitted panel, with the person's overrides and confirmed
//     serving applied, and refuses (409, with the failures) unless the label
//     agrees with itself. A value the person chose to "keep" against the checks
//     stays in their own library but never reaches the shared cache.
//   · It DOES trust the person on the two things no check can see: the serving
//     size (types.ts rule 3) and the unchecked fields (rule 4). That is what the
//     confirm screen exists for.
//   · A catalog answer beats a camera read. A row that Open Food Facts or USDA
//     already answered (found = true, source != 'label') is never overwritten.
//     A negative row (found = false) or an older label row may be.
//
// AUTHORIZATION: household users only, via denyUnlessCaller — the same gate as
// food-lookup and notify. `verify_jwt = true` (the default; this function is
// deliberately absent from supabase/config.toml) is not enough on its own: it
// accepts the publishable key that ships in the public browser bundle. See
// _shared/callerAuth.ts.
//
// MIRRORS: ../_shared/labelScan/verify.ts and ../_shared/labelScan/food.ts are
// the Deno mirrors of src/lib/labelScan/{verify,food}.ts (with their types.ts and
// rules.ts). They are added at merge time, exactly like the existing
// _shared/categorize.ts and _shared/gtin.ts mirrors of src/lib. This file is
// written against their src signatures:
//   verify(panel: ParsedPanel, columnIndex = 0): Verification
//   toLabelFood(panel: ParsedPanel, confirmed: Confirmed, engine?: string): LabelFood
//
// Not deployed from here. Deploy with: supabase functions deploy food-label-save

import { createClient } from "jsr:@supabase/supabase-js@2";
import { denyUnlessCaller } from "../_shared/callerAuth.ts";
import { canonicalGtin, gtinVariants, isValidGtin } from "../_shared/gtin.ts";
import { verify } from "../_shared/labelScan/verify.ts";
import { toLabelFood } from "../_shared/labelScan/food.ts";
import type { FieldKey, ParsedPanel, ReadValue } from "../_shared/labelScan/types.ts";

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

const FIELD_KEYS: FieldKey[] = [
  "kcal", "kj", "fat", "sat", "trans", "chol", "sodium", "salt", "carb", "fiber", "sugar", "added", "prot",
];
const MAX_SERVING_G = 5000; // the app's own ceiling on a typed gram amount (MealBuilder MAX_GRAMS)

const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The shape checks a panel must pass before the verifier is even asked. */
function looksLikePanel(p: unknown): p is ParsedPanel {
  if (!p || typeof p !== "object") return false;
  const panel = p as ParsedPanel;
  if (!["us", "eu", "cn"].includes(panel.regime)) return false;
  if (!Array.isArray(panel.columns) || panel.columns.length === 0) return false;
  return panel.columns.every(
    (c) =>
      c && typeof c === "object" && ["serving", "100g", "100ml"].includes(c.basis) &&
      c.fields && typeof c.fields === "object" && c.refPct && typeof c.refPct === "object" &&
      Object.values(c.fields).every((v) => v && finiteNonNeg((v as ReadValue).value)) &&
      Object.values(c.refPct).every((v) => v && finiteNonNeg((v as ReadValue).value)),
  );
}

/** The panel with the person's overrides and confirmed serving written in — what gets verified is what gets saved. */
function applyConfirmed(
  panel: ParsedPanel,
  overrides: Partial<Record<FieldKey, number>>,
  servingGrams: number,
  columnIndex: number,
): ParsedPanel {
  const columns = panel.columns.map((col, i) => {
    if (i !== columnIndex) return col;
    const fields = { ...col.fields };
    for (const k of FIELD_KEYS) {
      const v = overrides[k];
      // Already in the panel (the phone sends the panel as edited): leave it,
      // so a "less than" the person kept is verified exactly as they saw it.
      if (v != null && fields[k]?.value !== v) fields[k] = { value: v, raw: String(v) };
    }
    return {
      ...col,
      fields,
      ...(col.basis === "serving" && col.servingGrams != null ? { servingGrams } : {}),
    };
  });
  return { ...panel, columns, serving: { value: servingGrams, raw: String(servingGrams) } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const denied = await denyUnlessCaller(req, admin, CORS);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "no body" }, 400);

    // ── the barcode: a real GTIN or nothing ──────────────────────────────────
    // The check digit is free protection against keying a label under someone
    // else's product — a mistyped number that happens to be another item.
    const raw = String(body.barcode ?? "");
    if (!isValidGtin(raw)) return json({ error: "not a valid barcode" }, 400);
    const code = canonicalGtin(raw);

    // ── the rest of the request ──────────────────────────────────────────────
    const panel = body.panel;
    if (!looksLikePanel(panel)) return json({ error: "not a nutrition panel" }, 400);
    const columnIndex = body.columnIndex == null ? 0 : Number(body.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= panel.columns.length) {
      return json({ error: "no such column" }, 400);
    }
    const servingGrams = Number(body.servingGrams);
    if (!Number.isFinite(servingGrams) || servingGrams <= 0 || servingGrams > MAX_SERVING_G) {
      return json({ error: "serving must be a confirmed weight in grams" }, 400);
    }
    const name = String(body.name ?? "").trim().slice(0, 200);
    if (!name) return json({ error: "no name" }, 400);
    const brand = body.brand ? String(body.brand).trim().slice(0, 200) || undefined : undefined;
    const engine = body.engine ? String(body.engine).slice(0, 200) : undefined;
    const overrides: Partial<Record<FieldKey, number>> = {};
    for (const [k, v] of Object.entries(body.overrides ?? {})) {
      if (!FIELD_KEYS.includes(k as FieldKey)) return json({ error: `unknown field ${k}` }, 400);
      if (!finiteNonNeg(v)) return json({ error: `bad value for ${k}` }, 400);
      overrides[k as FieldKey] = v;
    }

    // ── the verifier decides, not the phone ──────────────────────────────────
    const confirmedPanel = applyConfirmed(panel, overrides, servingGrams, columnIndex);
    const verification = verify(confirmedPanel, columnIndex);
    if (!verification.consistent) {
      return json({ error: "inconsistent", failures: verification.failures }, 409);
    }

    let food;
    try {
      food = toLabelFood(confirmedPanel, { servingGrams, name, brand, barcode: code, overrides, columnIndex }, engine);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, 422);
    }

    // Physics, not regulation: nothing edible holds more than pure fat's ~900
    // kcal per 100 g, or more than 100 g of macros in 100 g. A panel that passes
    // every label check but breaks these came from a serving the checks cannot
    // see (rule 3), and does not belong in a cache both phones trust.
    if (food.kcal > 950 || food.p + food.c + food.f > 105) {
      return json({ error: "implausible per-100 g values", food }, 422);
    }

    const payload = {
      name: food.name,
      ...(food.brand ? { brand: food.brand } : {}),
      kcal: food.kcal,
      p: food.p,
      c: food.c,
      f: food.f,
      ...(food.serving ? { serving: food.serving } : {}),
      barcode: code,
      source: "label",
      verified: true,
      ...(food.engine ? { engine: food.engine } : {}),
    };
    const row = { code, payload, found: true, source: "label", checked_at: new Date().toISOString() };

    // ── a catalog answer beats a camera read ─────────────────────────────────
    // food-lookup reads ANY printed form of the number, so look across all of
    // them — not just the canonical row this function writes.
    const { data: existing, error: readErr } = await admin
      .from("food_cache")
      .select("code, found, source")
      .in("code", gtinVariants(raw));
    if (readErr) return json({ error: readErr.message }, 500);
    if ((existing ?? []).some((r) => r.found && r.source !== "label")) {
      return json({ saved: false, reason: "a catalog already answers for this barcode" });
    }

    // Two statements, each one atomic, so a catalog row that lands between the
    // read above and this write is still never overwritten:
    //   1. replace the canonical row only if it is a miss or an earlier label;
    //   2. otherwise insert — and if a row appeared meanwhile, leave it alone.
    const { data: replaced, error: updErr } = await admin
      .from("food_cache")
      .update(row)
      .eq("code", code)
      .or("found.eq.false,source.eq.label")
      .select("code");
    if (updErr) return json({ error: updErr.message }, 500);
    if (replaced?.length) return json({ saved: true, code, food: payload });

    const { data: inserted, error: insErr } = await admin
      .from("food_cache")
      .upsert(row, { onConflict: "code", ignoreDuplicates: true })
      .select("code");
    if (insErr) return json({ error: insErr.message }, 500);
    if (inserted?.length) return json({ saved: true, code, food: payload });
    return json({ saved: false, reason: "a catalog already answers for this barcode" });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
