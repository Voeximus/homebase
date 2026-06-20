// ── The meal-builder counting stack ──────────────────────────────────────────
// The Finance "budget burns down to firepower" engine, run for macros. A day has
// a macro TARGET (the budget). Each food you log into a meal is a SPEND. What is
// left = target − eaten (the firepower). Divided by the meals still ahead = your
// next meal's allowance (the "next move"). Pure + local-first; one contract the
// UI renders from, the same way buildVMs feeds the bento tabs.

import type { Food, FoodUnit } from "./nutrition";
import { SEED_FOODS } from "./nutrition";

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

export interface DayLog {
  date: string; // YYYY-MM-DD (local)
  person: Person;
  meals: Meal[]; // created dynamically as you eat — no fixed slots
  // macro-plan adherence (the 8 PM nudge). A day with meals is "followed"
  // implicitly; these mark a day with NO logged meals.
  status?: "estimated" | "skipped";
  note?: string; // the rough "what did you eat" description for an estimated day
}

// ── macro math ───────────────────────────────────────────────────────────────
export function macrosOf(food: Pick<Food, "kcal" | "p" | "c" | "f">): Macros {
  return { kcal: food.kcal, p: food.p, c: food.c, f: food.f };
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
const dayKey = (person: Person, date: string) => `hb-meallog-${person}-${date}`;

/** Local calendar date (not UTC) so "today" rolls at the user's midnight. */
export function todayStr(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function loadDay(person: Person, date: string): DayLog {
  try {
    const raw = localStorage.getItem(dayKey(person, date));
    if (raw) {
      const parsed = JSON.parse(raw) as DayLog;
      // Defend against an older/partial shape.
      if (Array.isArray(parsed.meals)) {
        return { date, person, meals: parsed.meals };
      }
    }
  } catch {
    /* fall through to a fresh day */
  }
  return { date, person, meals: [] };
}

export function saveDay(log: DayLog): void {
  try {
    localStorage.setItem(dayKey(log.person, log.date), JSON.stringify(log));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
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
