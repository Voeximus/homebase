import { useState, type ReactNode } from "react";
import { Dumbbell, UtensilsCrossed } from "lucide-react";
import { LanguageProvider, LangToggle } from "../components/LanguageProvider";
import { HealthValueProvider } from "../store/HealthStore";
import { WorkoutSection } from "../views/WorkoutSection";
import { loadHealthTheme, type HealthTheme } from "../lib/healthTheme";
import { t } from "../lib/i18n";
import type { Person } from "../lib/workoutLog";
import { useFakeHealthStore } from "./fakeHealthStore";
import { buildWorkoutFixtures } from "./workoutFixtures";

// ?workoutlab — DEV-only harness for workout mode, and the ONLY place its UI is
// checked. It mounts the real WorkoutSection over an in-memory store filled
// with twelve weeks of example history, so every screen has real content under
// it and nothing a tap does can reach Supabase: HealthProvider is never mounted
// here, only HealthValueProvider with the fake. No login, and it renders with
// the network off (the exercise library is a local lazy import).
//
// The provider sits ABOVE LanguageProvider on purpose. LanguageProvider remounts
// its children to re-run every t(), and a fake store below it would be rebuilt
// from the fixtures on each language flip, throwing away whatever you had just
// logged — so checking a half-finished session in Chinese would be impossible.

const seed = () => buildWorkoutFixtures(new Date());

function FakeHealth({ children }: { children: ReactNode }) {
  const store = useFakeHealthStore(seed);
  return <HealthValueProvider value={store}>{children}</HealthValueProvider>;
}

export function WorkoutLab() {
  // Whose phone this is. The real app sets owner and person from the same pick,
  // so the switch sets both — and remounts the section, as a different phone would.
  const [person, setPerson] = useState<Person>("gino");
  const [theme, setTheme] = useState<HealthTheme>(loadHealthTheme);
  const [run, setRun] = useState(0); // bumping it rebuilds the store from the fixtures
  const btn = (on: boolean) =>
    `flex-1 rounded-lg py-2 text-sm font-semibold transition ${on ? "bg-bone text-bg" : "bg-tile text-taupe"}`;
  const tbtn = (on: boolean) =>
    `flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${on ? "bg-accent text-bg" : "bg-tile text-taupe"}`;

  return (
    <FakeHealth key={run}>
      <LanguageProvider>
        <div className={`htheme htheme-${theme} min-h-screen`}>
          {/* Same frame as HealthView: a 640px column, bottom padding that clears
              the fixed tab bar, and the tab bar itself — the rest dock sits just
              above it, so it has to be there to be checked. */}
          <main
            className="mx-auto max-w-[640px] px-4 pt-3"
            style={{ paddingBottom: "calc(88px + env(safe-area-inset-bottom))" }}
          >
            <div className="notranslate mb-3 flex flex-col gap-2" aria-label="Harness controls, not part of the app">
              <div className="flex gap-2">
                <button className={btn(person === "gino")} onClick={() => setPerson("gino")}>Gino's phone</button>
                <button className={btn(person === "xinyan")} onClick={() => setPerson("xinyan")}>Xinyan's phone</button>
              </div>
              <div className="flex items-center gap-2">
                {(["original", "instrument", "bold"] as const).map((th) => (
                  <button key={th} className={tbtn(theme === th)} onClick={() => setTheme(th)}>{th}</button>
                ))}
                <LangToggle />
              </div>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-taupe">
                  Example data · held in memory · nothing is saved
                </span>
                <button className={tbtn(false)} style={{ flex: "none", padding: "6px 12px" }} onClick={() => setRun((n) => n + 1)}>
                  Reset example data
                </button>
              </div>
            </div>
            <WorkoutSection key={person} owner={person} person={person} />
          </main>

          {/* inert copy of the shell's section bar */}
          <nav className="h-tabs" aria-label={t("Health sections")}>
            <button disabled>
              <UtensilsCrossed size={19} />
              {t("Meals")}
            </button>
            <button className="on" aria-current="page">
              <Dumbbell size={19} />
              {t("Workouts")}
            </button>
          </nav>
        </div>
      </LanguageProvider>
    </FakeHealth>
  );
}
