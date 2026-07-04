import { useEffect, useState } from "react";
import { Dumbbell, LogOut, Palette, UtensilsCrossed, X } from "lucide-react";
import { t } from "../lib/i18n";
import { useAuth } from "../auth/AuthProvider";
import { ModeToggle, type AppMode } from "../components/ModeToggle";
import { LangToggle } from "../components/LanguageProvider";
import type { Lens } from "../lib/lens";
import type { Owner } from "../lib/owner";
import { HealthProvider } from "../store/HealthStore";
import { HEALTH_THEMES, loadHealthTheme, saveHealthTheme, type HealthTheme } from "../lib/healthTheme";
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
  const [theme, setTheme] = useState<HealthTheme>(loadHealthTheme);
  const [apprOpen, setApprOpen] = useState(false);
  const pickTheme = (tid: HealthTheme) => {
    setTheme(tid);
    saveHealthTheme(tid);
  };
  const who = owner;

  return (
    <HealthProvider>
    <div className={`htheme htheme-${theme} min-h-screen`}>
      {/* slim, non-sticky header — the macro summary inside each section pins instead */}
      <div className="safe-top border-b border-edge">
        <div className="mx-auto max-w-[640px] px-4">
          <div className="flex h-14 items-center gap-2 pb-1">
            <ModeToggle mode={mode} onMode={onMode} />
            <div className="min-w-0 flex-1" />
            {/* Meal Builder / Workouts — compact icon toggle */}
            <div className="hb-itog">
              <button onClick={() => setSub("kitchen")} className={sub === "kitchen" ? "on" : ""} aria-label={t("Meal Builder")}>
                <UtensilsCrossed size={16} />
              </button>
              <button onClick={() => setSub("plan")} className={sub === "plan" ? "on" : ""} aria-label={t("Workouts")}>
                <Dumbbell size={16} />
              </button>
            </div>
            <LangToggle />
            <button
              onClick={() => setApprOpen(true)}
              className="rounded-full p-2 text-taupe transition hover:bg-raised"
              aria-label="Appearance"
            >
              <Palette size={17} />
            </button>
            <button
              onClick={() => signOut()}
              className="rounded-full p-2 text-taupe transition hover:bg-raised"
              aria-label="Logout"
            >
              <LogOut size={17} />
            </button>
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
      <AppearanceSheet open={apprOpen} current={theme} onPick={pickTheme} onClose={() => setApprOpen(false)} />
    </div>
    </HealthProvider>
  );
}

// Settings → Appearance: pick the health look for THIS device. Rendered inside
// the themed root, so it restyles live as you tap. Each swatch shows its own
// theme's identity, independent of the one currently active.
function AppearanceSheet({
  open,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  current: HealthTheme;
  onPick: (t: HealthTheme) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-t-[22px] border p-5 sm:rounded-[22px]"
        style={{ background: "var(--color-tile)", borderColor: "var(--color-edge)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <Palette size={16} style={{ color: "var(--color-accent)" }} />
          <div className="flex-1 text-[15px] font-bold text-bone">{t("Appearance")}</div>
          <button onClick={onClose} className="text-taupe" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <p className="mb-3.5 text-[12px] text-taupe">{t("Pick how Health looks on this device.")}</p>
        <div className="grid grid-cols-3 gap-2.5">
          {HEALTH_THEMES.map((th) => {
            const on = th.id === current;
            return (
              <button
                key={th.id}
                onClick={() => onPick(th.id)}
                className="rounded-[14px] border p-2.5 text-center transition active:scale-[0.97]"
                style={{
                  borderColor: on ? "var(--color-accent)" : "var(--color-edge)",
                  background: "var(--color-raised)",
                }}
              >
                <span
                  className="mb-2 block h-9 rounded-[9px]"
                  style={{ background: th.swatch, border: th.id === "instrument" ? "1px solid #23424a" : "none" }}
                />
                <span className="block text-[12.5px] font-semibold text-bone">{t(th.label)}</span>
                <span className="mt-0.5 block text-[10px] text-taupe">{t(th.blurb)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
