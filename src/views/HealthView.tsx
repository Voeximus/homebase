import { useEffect, useState } from "react";
import { Dumbbell, LogOut, UtensilsCrossed } from "lucide-react";
import { t } from "../lib/i18n";
import { useAuth } from "../auth/AuthProvider";
import { ModeToggle, type AppMode } from "../components/ModeToggle";
import { LangToggle } from "../components/LanguageProvider";
import type { Lens } from "../lib/lens";
import type { Owner } from "../lib/owner";
import { MealBuilder } from "./MealBuilder";
import { WorkoutSection } from "./WorkoutSection";

// ── Health mode ──────────────────────────────────────────────────────────────
// Two tools, each self-contained: the Meal Builder (macro-first daily tracking)
// and Workouts (sessions / routines / PRs). The Mine/Household switch is GONE
// from the header — each section owns its own Just-me/Together switch instead,
// so the header stays light and the section is the context.

export function HealthView({
  mode,
  onMode,
  owner,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
  owner: Owner;
  // kept on the type so App's call stays valid; Health uses per-section switches.
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  const { signOut } = useAuth();
  const [sub, setSub] = useState<"plan" | "kitchen">(
    () => (localStorage.getItem("hb-health-sub") as "plan" | "kitchen") || "kitchen",
  );
  useEffect(() => localStorage.setItem("hb-health-sub", sub), [sub]);
  const who = owner;

  return (
    <div className="min-h-screen">
      {/* slim, non-sticky header — the macro summary inside each section pins instead */}
      <div className="safe-top border-b border-edge">
        <div className="mx-auto max-w-[640px] px-4">
          <div className="flex h-14 items-center gap-2">
            <ModeToggle mode={mode} onMode={onMode} />
            <div className="min-w-0 flex-1" />
            <LangToggle />
            <button
              onClick={() => signOut()}
              className="rounded-full p-2 text-taupe transition hover:bg-raised"
              aria-label="Logout"
            >
              <LogOut size={17} />
            </button>
          </div>
          {/* section nav */}
          <div className="grid grid-cols-2 gap-2 pb-2.5">
            {[
              { k: "kitchen" as const, label: t("Meal Builder"), Icon: UtensilsCrossed },
              { k: "plan" as const, label: t("Workouts"), Icon: Dumbbell },
            ].map(({ k, label, Icon }) => {
              const on = sub === k;
              return (
                <button
                  key={k}
                  onClick={() => setSub(k)}
                  className={`flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-semibold transition ${
                    on ? "bg-bone text-bg" : "bg-tile text-taupe hover:text-bone"
                  }`}
                >
                  <Icon size={15} /> {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[640px] px-4 pb-16 pt-3">
        {sub === "kitchen" ? (
          <MealBuilder owner={who} person={who} />
        ) : (
          <WorkoutSection owner={who} person={who} />
        )}
      </main>
    </div>
  );
}
