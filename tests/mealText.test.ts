import { describe, it, expect } from "vitest";
import { dayToText, daysToText, macroLine, mealToText } from "../src/lib/mealText";
import type { DayLog, LoggedItem, Meal } from "../src/lib/mealLog";

// The copy button exists so a day can leave the app and be understood somewhere
// else. That makes the OUTPUT the product — not the button — so it is worth
// testing the way any other output is: does it carry enough for the reader to
// redo the arithmetic, and does it stay honest when the day is unusual?

const item = (over: Partial<LoggedItem> & Pick<LoggedItem, "name" | "grams" | "per100">): LoggedItem => ({
  id: over.name,
  foodId: over.name,
  role: "other",
  ...over,
});

const eggs = item({
  name: "Egg, whole",
  grams: 150,
  qty: 3,
  unit: { name: "egg", grams: 50 },
  per100: { kcal: 143, p: 12.6, c: 0.7, f: 9.5 },
});
const oats = item({
  name: "Oats, dry",
  grams: 80,
  per100: { kcal: 379, p: 13.2, c: 67.7, f: 6.5 },
});

const breakfast: Meal = { id: "m1", name: "Breakfast", items: [eggs, oats] };
const target = { kcal: 2800, p: 130, c: 410, f: 70 };
const day: DayLog = { date: "2026-09-10", person: "gino", meals: [breakfast] };

describe("a copied meal carries enough to check the arithmetic", () => {
  const text = mealToText(breakfast, 0, "gino", "2026-09-10");

  it("names whose day it is and which day", () => {
    expect(text).toContain("Gino");
    // Written out, not "2026-09-10" — an ISO date invites a reader to guess at a
    // timezone, and a slashed one invites the DD/MM vs MM/DD coin flip.
    expect(text).toContain("Sep");
    expect(text).toContain("2026");
  });

  it("gives BOTH the amount as entered and the grams behind it", () => {
    // "3 eggs" is what he did; 150 g is what the macros were computed from. A
    // reader given only one of them cannot verify the other.
    expect(text).toContain("3 eggs (150 g)");
  });

  it("states each food's own macros, not just the meal total", () => {
    // 150 g of 143 kcal/100g = 214.5 → 215 after rounding for display.
    expect(text).toContain("215 kcal");
    // 80 g of 379 kcal/100g = 303.2 → 303.
    expect(text).toContain("303 kcal");
  });

  it("totals the meal", () => {
    // 214.5 + 303.2 = 517.7 → 518
    expect(text).toContain("Breakfast — 518 kcal");
  });

  it("says what the numbers are derived from", () => {
    // Without this a reader cannot tell whether 150 g was raw or cooked, or
    // whether the macros were per-serving or per-100g.
    expect(text).toContain("per-100g");
  });

  it("does not lose a food with no natural unit to a unit label", () => {
    expect(text).toContain("Oats, dry — 80 g —");
    expect(text).not.toContain("80 g (80 g)");
  });
});

describe("a copied day carries the question, not just the answer", () => {
  const text = dayToText(day, target);

  it("includes the target, so 'was that enough' is answerable", () => {
    expect(text).toContain("Target: 2800 kcal · 130P / 410C / 70F");
  });

  it("includes what is left", () => {
    // 2800 − 517.7 = 2282.3 → 2282
    expect(text).toContain("Left:");
    expect(text).toContain("2282 kcal");
  });

  it("says OVER in words rather than leaning on a minus sign", () => {
    const big: Meal = {
      id: "m2",
      name: "Everything",
      items: [item({ name: "Butter", grams: 500, per100: { kcal: 717, p: 0.9, c: 0.1, f: 81 } })],
    };
    const over = dayToText({ ...day, meals: [big] }, target);
    expect(over).toContain("OVER by:");
    expect(over).not.toContain("-785"); // a skimmed minus sign is a misread day
  });

  it("reports the calorie share of the target", () => {
    expect(text).toMatch(/18% of the calorie target/);
  });
});

describe("the unusual days stay honest", () => {
  it("an empty day says so instead of reading as a zero-calorie day", () => {
    const text = dayToText({ ...day, meals: [] }, target);
    expect(text).toContain("No meals logged.");
  });

  it("a skipped day is labelled, not silently empty", () => {
    const text = dayToText({ ...day, meals: [], status: "skipped" }, target);
    expect(text).toContain("skipped");
  });

  it("an estimated day carries its note, so the reader knows it was not weighed", () => {
    const text = dayToText(
      { ...day, meals: [], status: "estimated", note: "two burritos and a beer" },
      target,
    );
    expect(text).toContain("Estimated day");
    expect(text).toContain("two burritos and a beer");
  });
});

describe("a range of days", () => {
  it("summarises per day and averages, without the item detail", () => {
    const d2: DayLog = { ...day, date: "2026-09-11" };
    const text = daysToText([day, d2], target, "gino");
    expect(text).toContain("2 days");
    expect(text).toContain("Average: 518 kcal");
    // The point of the range view is the pattern; itemising a week is thousands
    // of words and nobody asks about Tuesday's oats.
    expect(text).not.toContain("Oats, dry");
  });

  it("says nothing-logged rather than inventing an average of zero", () => {
    expect(daysToText([{ ...day, meals: [] }], target, "xinyan")).toContain("nothing logged");
  });
});

describe("the macro line reads the same everywhere", () => {
  it("one spelling, learned once", () => {
    expect(macroLine({ kcal: 517.7, p: 29.4, c: 55.2, f: 19.5 })).toBe("518 kcal · 29P / 55C / 20F");
  });
});
