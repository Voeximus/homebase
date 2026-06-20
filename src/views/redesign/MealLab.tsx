import { FinanceProvider } from "../../store/FinanceStore";
import { LanguageProvider } from "../../components/LanguageProvider";
import { MealBuilder } from "../MealBuilder";

// ?meallab — DEV-only harness to drive the bento Meal Builder without a login.
// The store loads empty (no session) and the bundled food table comes from the
// lazy import, so search / portion / together flows all exercise for real.
export function MealLab() {
  return (
    <LanguageProvider>
      <FinanceProvider>
        <div className="min-h-screen" style={{ background: "#0b0f17" }}>
          <div className="mx-auto max-w-[640px] px-4 py-5">
            <MealBuilder owner="gino" person="gino" />
          </div>
        </div>
      </FinanceProvider>
    </LanguageProvider>
  );
}
