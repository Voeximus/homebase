import { useState } from "react";
import { FinanceProvider } from "../../store/FinanceStore";
import { HealthProvider } from "../../store/HealthStore";
import { LanguageProvider } from "../../components/LanguageProvider";
import { MealBuilder } from "../MealBuilder";
import { WorkoutSection } from "../WorkoutSection";

// ?meallab — DEV-only harness to drive the Health sections without a login.
// The store loads empty (no session); bundled food/exercise tables come from
// their lazy imports, so search / portion / together / workout flows all run.
export function MealLab() {
  const [tab, setTab] = useState<"meal" | "workout">("meal");
  const [theme, setTheme] = useState<"original" | "instrument" | "bold">("original");
  const btn = (on: boolean) =>
    `flex-1 rounded-lg py-2 text-sm font-semibold transition ${on ? "bg-bone text-bg" : "bg-tile text-taupe"}`;
  const tbtn = (on: boolean) =>
    `flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${on ? "bg-accent text-bg" : "bg-tile text-taupe"}`;
  return (
    <LanguageProvider>
      <FinanceProvider>
        <HealthProvider>
        <div className={`htheme htheme-${theme} min-h-screen`}>
          <div className="mx-auto max-w-[640px] px-4 py-5">
            <div className="mb-2 flex gap-2">
              <button className={btn(tab === "meal")} onClick={() => setTab("meal")}>Meal Builder</button>
              <button className={btn(tab === "workout")} onClick={() => setTab("workout")}>Workouts</button>
            </div>
            <div className="mb-3 flex gap-2">
              {(["original", "instrument", "bold"] as const).map((th) => (
                <button key={th} className={tbtn(theme === th)} onClick={() => setTheme(th)}>{th}</button>
              ))}
            </div>
            {tab === "meal" ? (
              <MealBuilder owner="gino" person="gino" />
            ) : (
              <WorkoutSection owner="gino" person="gino" />
            )}
          </div>
        </div>
        </HealthProvider>
      </FinanceProvider>
    </LanguageProvider>
  );
}
