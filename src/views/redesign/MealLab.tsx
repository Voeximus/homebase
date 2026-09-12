import { useEffect, useRef, useState } from "react";
import { AuthProvider } from "../../auth/AuthProvider";
import { FinanceProvider } from "../../store/FinanceStore";
import { HealthProvider, useHealth } from "../../store/HealthStore";
import { LanguageProvider } from "../../components/LanguageProvider";
import { MealBuilder } from "../MealBuilder";
import { WorkoutSection } from "../WorkoutSection";
import { HealthView } from "../HealthView";
import type { DayLog, LoggedItem, Macros } from "../../lib/mealLog";

// ?meallab — DEV-only harness to drive the Health sections without a login.
// The store loads empty (no session); bundled food/exercise tables come from
// their lazy imports, so search / portion / together / workout flows all run.
//
// "Seed a day" fills the store with a realistic day for both people. Designing
// a dense screen against an EMPTY one is how a layout ends up looking fine in
// the harness and falling apart the moment someone actually logs three meals —
// every spacing and truncation decision here needs real content under it.

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let n = 0;
const I = (
  name: string,
  grams: number,
  per100: Macros,
  qty?: number,
  unit?: { name: string; grams: number },
): LoggedItem => ({
  id: `seed-${n++}`,
  foodId: `seed-${name}`,
  name,
  role: "other",
  grams,
  per100,
  qty,
  unit,
});

function seedDay(person: "gino" | "xinyan", date: string): DayLog {
  const full: DayLog = {
    date,
    person,
    meals: [
      {
        id: `${date}-1`,
        name: "Breakfast",
        items: [
          I("Egg, whole", 150, { kcal: 143, p: 12.6, c: 0.7, f: 9.5 }, 3, { name: "egg", grams: 50 }),
          I("Oats, dry", 80, { kcal: 379, p: 13.2, c: 67.7, f: 6.5 }),
          I("Blueberries", 100, { kcal: 57, p: 0.7, c: 14.5, f: 0.3 }),
        ],
      },
      {
        id: `${date}-2`,
        name: "Lunch",
        items: [
          I("Chicken breast, cooked", 220, { kcal: 165, p: 31, c: 0, f: 3.6 }),
          I("White rice, cooked", 300, { kcal: 130, p: 2.7, c: 28, f: 0.3 }),
          I("Broccoli, cooked", 150, { kcal: 35, p: 2.4, c: 7.2, f: 0.4 }),
        ],
      },
      {
        id: `${date}-3`,
        name: "",
        items: [
          // A long brand name and a zero-calorie drink — the two cases that break
          // a layout: truncation, and a row where every number is 0.
          I("Pringles Original Potato Crisps Sour Cream & Onion", 28, { kcal: 536, p: 3.5, c: 57, f: 32 }),
          I("Diet Coke Soft Drink", 355, { kcal: 0, p: 0, c: 0, f: 0 }),
        ],
      },
    ],
  };
  if (person === "xinyan") return { ...full, meals: full.meals.slice(0, 2) };
  return full;
}

function Seeder({ onDone }: { onDone: () => void }) {
  const { setDay, setWeight, setMacroTarget } = useHealth();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const today = new Date();
    for (let k = 0; k < 6; k++) {
      const d = new Date(today);
      d.setDate(d.getDate() - k);
      setDay(seedDay("gino", iso(d)));
      if (k < 3) setDay(seedDay("xinyan", iso(d)));
    }
    // A weight trend, so the weight tile has a line rather than a placeholder.
    for (let k = 0; k < 10; k++) {
      const d = new Date(today);
      d.setDate(d.getDate() - k * 3);
      setWeight("gino", iso(d), 183.4 + k * 0.6);
      setWeight("xinyan", iso(d), 128.2 - k * 0.2);
    }
    setMacroTarget("gino", { kcal: 2800, p: 130, c: 410, f: 70 });
    setMacroTarget("xinyan", { kcal: 1550, p: 140, c: 145, f: 45 });
    onDone();
  }, [setDay, setWeight, setMacroTarget, onDone]);
  return null;
}

export function MealLab() {
  const [tab, setTab] = useState<"meal" | "workout" | "chrome">("meal");
  const [theme, setTheme] = useState<"original" | "instrument" | "bold">("original");
  const [seed, setSeed] = useState(false);
  const btn = (on: boolean) =>
    `flex-1 rounded-lg py-2 text-sm font-semibold transition ${on ? "bg-bone text-bg" : "bg-tile text-taupe"}`;
  const tbtn = (on: boolean) =>
    `flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${on ? "bg-accent text-bg" : "bg-tile text-taupe"}`;
  // The full shell renders STANDALONE — HealthView mounts its own HealthProvider,
  // and two of them in one tree fight over the same Realtime channel name
  // ("cannot add postgres_changes callbacks after subscribe()"), which takes the
  // whole page down. Worth knowing: it would do the same in the real app if
  // HealthView were ever mounted twice.
  if (tab === "chrome") {
    return (
      <LanguageProvider>
        <FinanceProvider>
          <AuthProvider>
            <div className="fixed inset-0 z-[60] overflow-auto">
              <HealthView onMode={() => setTab("meal")} owner="gino" lens="me" onLens={() => undefined} />
            </div>
          </AuthProvider>
        </FinanceProvider>
      </LanguageProvider>
    );
  }
  return (
    <LanguageProvider>
      <FinanceProvider>
        <HealthProvider>
          <div className={`htheme htheme-${theme} min-h-screen`}>
            <div className="mx-auto max-w-[640px] px-4 py-5">
              <div className="mb-2 flex gap-2">
                <button className={btn(tab === "meal")} onClick={() => setTab("meal")}>Meal Builder</button>
                <button className={btn(tab === "workout")} onClick={() => setTab("workout")}>Workouts</button>
                {/* the real HealthView, so the header / bottom tabs / settings
                    sheet can be checked as they actually ship */}
                {/* never "on" here — reaching this branch means tab is not "chrome" */}
                <button className={btn(false)} onClick={() => setTab("chrome")}>Full shell</button>
              </div>
              <div className="mb-2 flex gap-2">
                {(["original", "instrument", "bold"] as const).map((th) => (
                  <button key={th} className={tbtn(theme === th)} onClick={() => setTheme(th)}>{th}</button>
                ))}
              </div>
              <div className="mb-3">
                <button className={tbtn(seed)} onClick={() => setSeed(true)} style={{ width: "100%" }}>
                  {seed ? "seeded — 6 days, 2 people" : "seed a realistic day"}
                </button>
              </div>
              {seed && <Seeder onDone={() => undefined} />}
              {tab === "meal" && <MealBuilder owner="gino" person="gino" />}
              {tab === "workout" && <WorkoutSection owner="gino" person="gino" />}
            </div>
          </div>
        </HealthProvider>
      </FinanceProvider>
    </LanguageProvider>
  );
}
