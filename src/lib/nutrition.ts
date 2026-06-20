// The nutrition engine for Health mode's meal builder. Pure + swappable: the
// portion solver takes selected foods + a per-person macro target and returns
// grams-per-food so each person lands on their numbers. Same ingredients, two
// portions. The macros are a starting guess — the weekly scale is the truth.

export type FoodRole = "protein" | "carb" | "veg" | "fat" | "other";

// A countable natural unit for foods you'd add "by the each" (3 eggs, 1 steak,
// 2 slices). grams = weight of ONE. Macros stay grams-based; this is the
// entry/display layer. Absent → the food is gram-only (ground beef, rice, oil).
export interface FoodUnit {
  name: string; // singular, lowercase: "egg", "slice", "steak", "scoop"
  grams: number;
}

export interface Food {
  id: string;
  name: string;
  role: FoodRole;
  // per 100 g, as eaten (cooked where it matters)
  kcal: number;
  p: number;
  c: number;
  f: number;
  serving?: number; // default grams for "fixed" foods (veg / other)
  unit?: FoodUnit; // natural countable unit (if any) — see FoodUnit
  note?: string;
  custom?: boolean;
  barcode?: string;
}

export interface MacroTarget {
  kcal: number;
  p: number;
  c: number;
  f: number;
}

// Daily targets from the plan (Two Bodies · One Engine).
export const DAILY: Record<"gino" | "xinyan", MacroTarget> = {
  gino: { kcal: 2800, p: 130, c: 410, f: 70 },
  xinyan: { kcal: 1550, p: 140, c: 145, f: 45 },
};

export function scaleTarget(t: MacroTarget, share: number): MacroTarget {
  return { kcal: t.kcal * share, p: t.p * share, c: t.c * share, f: t.f * share };
}

// ── seed library (per 100 g, as eaten; standard reference values, editable) ──
export const SEED_FOODS: Food[] = [
  // protein
  { id: "chicken-breast", name: "Chicken breast", role: "protein", kcal: 165, p: 31, c: 0, f: 3.6, note: "cooked" },
  { id: "ground-beef-9010", name: "Ground beef 90/10", role: "protein", kcal: 176, p: 26, c: 0, f: 8, note: "cooked" },
  { id: "pork-loin", name: "Pork loin", role: "protein", kcal: 195, p: 28, c: 0, f: 8, note: "cooked" },
  { id: "salmon", name: "Salmon", role: "protein", kcal: 206, p: 22, c: 0, f: 13, note: "cooked" },
  { id: "shrimp", name: "Shrimp", role: "protein", kcal: 99, p: 24, c: 0, f: 0.3, note: "cooked" },
  { id: "tofu-firm", name: "Firm tofu", role: "protein", kcal: 144, p: 16, c: 3, f: 8 },
  { id: "eggs", name: "Eggs", role: "protein", kcal: 143, p: 13, c: 1, f: 10, serving: 50, unit: { name: "egg", grams: 50 }, note: "1 large ≈ 50g" },
  { id: "whey", name: "Whey protein", role: "protein", kcal: 400, p: 80, c: 8, f: 6, serving: 30, unit: { name: "scoop", grams: 30 }, note: "powder · 1 scoop ≈ 30g" },
  // carb
  { id: "white-rice", name: "White rice", role: "carb", kcal: 130, p: 2.7, c: 28, f: 0.3, note: "cooked" },
  { id: "jasmine-rice", name: "Jasmine rice", role: "carb", kcal: 130, p: 2.7, c: 28, f: 0.3, note: "cooked" },
  { id: "rice-noodles", name: "Rice noodles", role: "carb", kcal: 110, p: 2, c: 25, f: 0.3, note: "cooked" },
  { id: "udon", name: "Udon noodles", role: "carb", kcal: 130, p: 4, c: 27, f: 0.5, note: "cooked" },
  { id: "potato", name: "Potato", role: "carb", kcal: 87, p: 1.9, c: 20, f: 0.1, serving: 170, unit: { name: "potato", grams: 170 }, note: "cooked · 1 medium" },
  { id: "oats", name: "Oats", role: "carb", kcal: 379, p: 13, c: 67, f: 7, note: "dry" },
  { id: "banana", name: "Banana", role: "carb", kcal: 89, p: 1.1, c: 23, f: 0.3, serving: 118, unit: { name: "banana", grams: 118 } },
  // veg (fixed portion, basically free volume)
  { id: "broccoli", name: "Broccoli", role: "veg", kcal: 35, p: 2.4, c: 7, f: 0.4, serving: 150, note: "cooked" },
  { id: "bok-choy", name: "Bok choy", role: "veg", kcal: 13, p: 1.5, c: 2.2, f: 0.2, serving: 150 },
  { id: "spinach", name: "Spinach", role: "veg", kcal: 23, p: 2.9, c: 3.6, f: 0.4, serving: 150 },
  { id: "stir-fry-veg", name: "Stir-fry veg mix", role: "veg", kcal: 40, p: 2, c: 8, f: 0.3, serving: 150 },
  { id: "bell-pepper", name: "Bell pepper", role: "veg", kcal: 31, p: 1, c: 6, f: 0.3, serving: 150 },
  // fat
  { id: "olive-oil", name: "Olive oil", role: "fat", kcal: 884, p: 0, c: 0, f: 100 },
  { id: "cooking-oil", name: "Cooking oil", role: "fat", kcal: 884, p: 0, c: 0, f: 100 },
  { id: "peanut-butter", name: "Peanut butter", role: "fat", kcal: 588, p: 25, c: 20, f: 50, serving: 32 },
  { id: "avocado", name: "Avocado", role: "fat", kcal: 160, p: 2, c: 9, f: 15, serving: 100 },
  // other (fixed add-ons)
  { id: "whole-milk", name: "Whole milk", role: "other", kcal: 61, p: 3.2, c: 4.8, f: 3.3, serving: 240, note: "1 cup ≈ 240g" },
];

export const ROLE_LABEL: Record<FoodRole, string> = {
  protein: "Protein",
  carb: "Carbs",
  veg: "Vegetables",
  fat: "Fats",
  other: "Other",
};
export const ROLE_ORDER: FoodRole[] = ["protein", "carb", "veg", "fat", "other"];

export interface SolvedItem {
  food: Food;
  grams: number;
  kcal: number;
  p: number;
  c: number;
  f: number;
}
export interface MealSolution {
  items: SolvedItem[];
  total: MacroTarget;
  target: MacroTarget;
  notes: string[];
}

const servingOf = (f: Food) => f.serving ?? (f.role === "veg" ? 150 : 100);

/**
 * Fill a meal target with the selected foods. Order: fixed foods (veg/other) →
 * carbs → protein → fat, each filler scaled to the RESIDUAL target after the
 * earlier foods' contributions. Carbs & protein land ~exact, fat approximate,
 * calories fall out. Multiple foods in a role split that role's target evenly.
 */
export function solveMeal(foods: Food[], target: MacroTarget): MealSolution {
  const notes: string[] = [];
  const items: SolvedItem[] = [];
  let accP = 0,
    accC = 0,
    accF = 0;

  const place = (food: Food, grams: number) => {
    const g = Math.max(0, Math.round(grams));
    const k = g / 100;
    const it: SolvedItem = { food, grams: g, kcal: k * food.kcal, p: k * food.p, c: k * food.c, f: k * food.f };
    items.push(it);
    accP += it.p;
    accC += it.c;
    accF += it.f;
  };

  const fixed = foods.filter((f) => f.role === "veg" || f.role === "other");
  const carbF = foods.filter((f) => f.role === "carb");
  const protF = foods.filter((f) => f.role === "protein");
  const fatF = foods.filter((f) => f.role === "fat");

  for (const f of fixed) place(f, servingOf(f));

  if (carbF.length) {
    const need = Math.max(0, target.c - accC);
    const per = need / carbF.length;
    for (const f of carbF) place(f, f.c > 0 ? per / (f.c / 100) : 0);
  } else {
    notes.push("No carb source — carbs will fall under target.");
  }

  if (protF.length) {
    const need = Math.max(0, target.p - accP);
    const per = need / protF.length;
    for (const f of protF) place(f, f.p > 0 ? per / (f.p / 100) : 0);
  } else {
    notes.push("No protein source — add a meat, tofu, eggs, or a shake.");
  }

  if (fatF.length) {
    const need = target.f - accF;
    if (need <= 0.5) {
      for (const f of fatF) place(f, 0);
      notes.push("Fat target already met — added oil optional.");
    } else {
      const per = need / fatF.length;
      for (const f of fatF) place(f, f.f > 0 ? per / (f.f / 100) : 0);
    }
  }

  const total = items.reduce(
    (t, i) => ({ kcal: t.kcal + i.kcal, p: t.p + i.p, c: t.c + i.c, f: t.f + i.f }),
    { kcal: 0, p: 0, c: 0, f: 0 },
  );
  return { items, total, target, notes };
}

// ── custom-food library (local-first; Supabase sync is a later upgrade) ──
const LS_KEY = "hb-foods-custom";

export function loadCustomFoods(): Food[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Food[]) : [];
  } catch {
    return [];
  }
}
export function saveCustomFoods(foods: Food[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(foods));
}
export function clearCustomFoods(): void {
  localStorage.removeItem(LS_KEY);
}
export function loadLibrary(): Food[] {
  return [...SEED_FOODS, ...loadCustomFoods()];
}

// ── natural-unit inference ────────────────────────────────────────────────────
// Most countable bundled foods already carry a `unit`. For the rest — a custom
// food, a scanned product, or a bundled entry that slipped through — guess the
// most natural countable unit from the NAME so the portion sheet can still offer
// "by the each". Conservative: skip anything that reads as a mass/liquid/dish,
// and a wrong guess is harmless (the user can flip to grams; macros are per-100g).
const UNIT_RULES: { rx: RegExp; unit: FoodUnit }[] = [
  { rx: /\bbagel/i, unit: { name: "bagel", grams: 95 } },
  { rx: /\bsteak\b/i, unit: { name: "steak", grams: 200 } },
  { rx: /\b(instant|ramen|cup noodle|packet|package)\b/i, unit: { name: "package", grams: 85 } },
  { rx: /\btortillas?\b/i, unit: { name: "tortilla", grams: 45 } },
  { rx: /\b(pancakes?|waffles?)\b/i, unit: { name: "piece", grams: 50 } },
  { rx: /\b(sausages?|hot ?dogs?|bratwursts?)\b/i, unit: { name: "link", grams: 75 } },
  { rx: /\bbananas?\b/i, unit: { name: "banana", grams: 118 } },
  { rx: /\bapples?\b/i, unit: { name: "apple", grams: 180 } },
  { rx: /\boranges?\b/i, unit: { name: "orange", grams: 140 } },
  { rx: /\bpotatoe?s?\b/i, unit: { name: "potato", grams: 170 } },
  { rx: /\btomatoe?s?\b/i, unit: { name: "tomato", grams: 120 } },
  { rx: /\beggs?\b/i, unit: { name: "egg", grams: 50 } },
  { rx: /\b(slice|toast)\b/i, unit: { name: "slice", grams: 28 } },
];
// names that look countable by keyword but are really a mass / liquid / dish
const NON_COUNTABLE =
  /soup|sauce|paste|powder|oil|juice|chips|fries|dried|flour|ground|minced|roll|drop|salad|fried|spread|butter|milk|smoothie|puree|mashed|noodle|gravy|dressing|batter|crumbs?/i;

/** The food's explicit unit, or a name-inferred one, or undefined (gram-only). */
export function unitFor(food: Food): FoodUnit | undefined {
  if (food.unit) return food.unit;
  const n = food.name;
  if (NON_COUNTABLE.test(n)) return undefined;
  for (const r of UNIT_RULES) if (r.rx.test(n)) return r.unit;
  return undefined;
}
