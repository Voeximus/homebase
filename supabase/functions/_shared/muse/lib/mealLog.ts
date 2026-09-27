// GENERATED — DO NOT EDIT. Source: src/lib/mealLog.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/mealLog.ts
// and re-run the generator.
// ── The meal-builder counting stack ──────────────────────────────────────────
// The Finance "budget burns down to firepower" engine, run for macros. A day has
// a macro TARGET (the budget). Each food you log into a meal is a SPEND. What is
// left = target − eaten (the firepower). Divided by the meals still ahead = your
// next meal's allowance (the "next move"). Pure + local-first; one contract the
// UI renders from, the same way buildVMs feeds the bento tabs.

import type { Food, FoodUnit } from "./nutrition.ts";
import { SEED_FOODS } from "./nutrition.ts";
import { todayISO } from "./format.ts";

export type Person = "gino" | "xinyan";

export interface Macros {
  kcal: number;
  p: number;
  c: number;
  f: number;
}
export const ZERO: Macros = { kcal: 0, p: 0, c: 0, f: 0 };

// A logged portion. We SNAPSHOT the food's identity + per-100g macros so the log
// stays correct even if that library food is later edited or deleted — the same
// reason the finance ledger stores the applied amount on its row.
export interface LoggedItem {
  id: string;
  foodId: string;
  name: string;
  role: Food["role"];
  grams: number; // canonical amount — macros always come from this
  per100: Macros;
  // entry/display layer: when added "by the each", the count + unit (grams stays
  // the source of truth = qty × unit.grams). Absent → entered by grams.
  qty?: number;
  unit?: FoodUnit;
}

// "3 eggs" → "eggs"; respects n for plural. Light English pluralizer.
export function pluralizeUnit(name: string, n: number): string {
  if (n === 1) return name;
  if (/(s|x|ch|sh)$/.test(name)) return name + "es";
  if (/o$/.test(name)) return name + "es"; // potato → potatoes, tomato → tomatoes
  if (/[^aeiou]y$/.test(name)) return name.slice(0, -1) + "ies";
  return name + "s";
}

/** How an item was entered, for display: "3 eggs" / "1.5 potatoes" / "200 g". */
export function amountLabel(item: { grams: number; qty?: number; unit?: FoodUnit }): string {
  if (item.qty != null && item.unit) {
    const q = String(Math.round(item.qty * 100) / 100);
    return `${q} ${pluralizeUnit(item.unit.name, item.qty)}`;
  }
  return `${Math.round(item.grams)} g`;
}

export interface Meal {
  id: string;
  name: string;
  items: LoggedItem[];
}

// A reusable meal the user saved (a "favorite") — a name + its logged items,
// re-addable to any day (solo) or to the shared dish (together). Household-shared.
export interface SavedMeal {
  id: string;
  name: string;
  items: LoggedItem[];
}

export interface DayLog {
  date: string; // YYYY-MM-DD (local)
  person: Person;
  meals: Meal[]; // created dynamically as you eat — no fixed slots
  // macro-plan adherence (the 8 PM nudge). A day with meals is "followed"
  // implicitly; these mark a day with NO logged meals.
  status?: "estimated" | "skipped";
  note?: string; // the rough "what did you eat" description for an estimated day
}

// ── building a logged portion ─────────────────────────────────────────────────
//
// THESE THREE FUNCTIONS USED TO BE INLINE IN src/views/MealBuilder.tsx, and they
// moved here so the Muse write door can use them. That is not a refactor for
// tidiness. The door's rule is that it does no arithmetic of its own — every
// number it writes or speaks comes from a function the screens use too, because a
// door with its own copy of a rule drifts from the screen and nobody notices in a
// chat. `grams = qty × unit.grams` and "per-100g from a portion's totals" were
// both rules that existed only inside a view file, so the door could not have had
// them without copying them.
//
// The id is passed IN rather than generated here. rowId() reads the clock, and the
// door is forbidden from reading one — it passes crypto.randomUUID(); the app
// passes rowId(), exactly as before.

/** How much of a food — either a gram weight, or a count of its natural unit. */
export interface Amount {
  grams: number;
  qty?: number;
  unit?: FoodUnit;
}

/** Grams is canonical. A counted amount resolves to qty × the weight of one. */
export function gramsOf(a: Amount): number {
  return a.qty != null && a.unit ? a.qty * a.unit.grams : a.grams;
}

/** A portion of a library food. The per-100g values are SNAPSHOTTED off the food,
 *  which is why the log stays correct after that library food is edited. */
export function itemFromFood(food: Food, a: Amount, id: string): LoggedItem {
  return {
    id,
    foodId: food.id,
    name: food.name,
    role: food.role,
    grams: gramsOf(a),
    per100: { kcal: food.kcal, p: food.p, c: food.c, f: food.f },
    qty: a.qty,
    unit: a.unit,
  };
}

/**
 * A portion of something that is not in the library: its weight, and what that
 * weight actually contained.
 *
 * Stored as per-100g because that is the only shape the log has, and because the
 * gram figure is the source of truth for every macro in it — the app's own copy
 * footer says so in those words (src/lib/mealText.ts). So the totals are divided
 * back to 100 g here, ONCE, in the same file as contribution() that multiplies
 * them out again, and the round trip is exact: contribution(itemFromTotals(x)) is
 * x's macros.
 *
 * `grams` must be above zero. A zero-gram portion would make every macro infinite,
 * and the caller has to decide what to do about that rather than be handed a NaN.
 */
export function itemFromTotals(
  x: { name: string; role?: Food["role"]; grams: number; kcal: number; p: number; c: number; f: number },
  id: string,
): LoggedItem {
  const k = 100 / x.grams;
  return {
    id,
    // Not a library food, so there is no id to point at. Empty rather than a made-up
    // one: a foodId that resolves to nothing would look like a deleted food.
    foodId: "",
    name: x.name,
    role: x.role ?? "other",
    grams: x.grams,
    per100: { kcal: x.kcal * k, p: x.p * k, c: x.c * k, f: x.f * k },
  };
}

/**
 * The weight an UNWEIGHED portion is stored as. See itemFromServing.
 *
 * 100 is not a guess about the food; it is the only number that makes the round
 * trip exact, because per-100g values scaled by 100 g give back themselves.
 */
export const SERVING_GRAMS = 100;

/**
 * A portion nobody weighed — what it contained, logged as ONE SERVING.
 *
 * Every portion in the log needs a weight, because macros are per-100g values
 * scaled by grams. Somebody saying "a chicken breast, about 330 calories" knows the
 * macros and not the weight, so the portion is stored as one 100 g serving whose
 * per-100g values ARE its totals: contribution() gives back exactly the macros that
 * went in, and the amount reads "1 serving" rather than a gram figure nobody
 * measured. The macros are exact; the weight is explicitly a serving, not a claim.
 */
export function itemFromServing(
  x: { name: string; role?: Food["role"]; kcal: number; p: number; c: number; f: number },
  id: string,
): LoggedItem {
  return {
    ...itemFromTotals({ ...x, grams: SERVING_GRAMS }, id),
    qty: 1,
    unit: { name: "serving", grams: SERVING_GRAMS },
  };
}

/** What this portion actually contributes (per-100g snapshot scaled by grams). */
export function contribution(item: LoggedItem): Macros {
  const k = item.grams / 100;
  return {
    kcal: item.per100.kcal * k,
    p: item.per100.p * k,
    c: item.per100.c * k,
    f: item.per100.f * k,
  };
}

export function sumMacros(list: Macros[]): Macros {
  return list.reduce(
    (a, m) => ({ kcal: a.kcal + m.kcal, p: a.p + m.p, c: a.c + m.c, f: a.f + m.f }),
    { ...ZERO },
  );
}

export function mealTotals(meal: Meal): Macros {
  return sumMacros(meal.items.map(contribution));
}

/** Everything eaten today across every meal. */
export function dayTotals(log: DayLog): Macros {
  return sumMacros(log.meals.map(mealTotals));
}

/** Target − eaten. Can go negative (over budget) — the UI flags that. */
export function remaining(target: Macros, eaten: Macros): Macros {
  return {
    kcal: target.kcal - eaten.kcal,
    p: target.p - eaten.p,
    c: target.c - eaten.c,
    f: target.f - eaten.f,
  };
}

// ── persistence (local-first; Supabase sync is a later upgrade like foods) ─────

/** Local calendar date (not UTC) so "today" rolls at the user's midnight.
 *  Delegates to the one shared spelling — this used to be a separate
 *  getTimezoneOffset implementation, identical in result but a second place the
 *  conversion could drift. */
export function todayStr(): string {
  return todayISO();
}

// A simple, collision-resistant id without pulling in a uuid dep.
let _seq = 0;
export function rowId(): string {
  _seq += 1;
  return `${Date.now().toString(36)}-${_seq.toString(36)}`;
}

// ── the searchable library ─────────────────────────────────────────────────────
// The library the user searches = their custom foods (highest priority), then
// the curated SEED_FOODS, then the big bundled table. Deduped by name so the
// clean seed entries win over a clunkier bundled duplicate.
export function buildLibrary(bundled: Food[], custom: Food[]): Food[] {
  const out: Food[] = [];
  const seen = new Set<string>();
  const add = (f: Food) => {
    const key = f.name.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  custom.forEach(add);
  SEED_FOODS.forEach(add);
  bundled.forEach(add);
  return out;
}

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Rank a search query against the library. Every whitespace token must appear in
 * the name (AND match); exact / prefix / word-start beat a loose substring, and
 * shorter cleaner names edge ahead. A numeric query also matches barcodes.
 */
export function searchFoods(query: string, library: Food[], limit = 40): Food[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const qDigits = digits(q);
  const scored: { f: Food; s: number }[] = [];

  for (const f of library) {
    const n = f.name.toLowerCase();
    let s = -1;

    if (tokens.every((tk) => n.includes(tk))) {
      if (n === q) s = 100;
      else if (n.startsWith(q)) s = 85;
      else if (n.startsWith(tokens[0])) s = 70;
      else s = 55;
      s -= n.length * 0.03; // tie-break toward the tighter name
    } else if (qDigits.length >= 6 && f.barcode && digits(f.barcode).includes(qDigits)) {
      s = 90;
    }

    if (s >= 0) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.f);
}
