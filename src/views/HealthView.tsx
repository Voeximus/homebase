import { useEffect, useState } from "react";
import { Check, Dumbbell, Languages, LogOut, Palette, Settings, UtensilsCrossed, X } from "lucide-react";
import { t } from "../lib/i18n";
import { useAuth } from "../auth/AuthProvider";
import { ModeToggle, type AppMode } from "../components/ModeToggle";
import { useLang } from "../components/LanguageProvider";
import type { Lens } from "../lib/lens";
import type { Owner } from "../lib/owner";
import { HealthProvider } from "../store/HealthStore";
import { HEALTH_THEMES, loadHealthTheme, saveHealthTheme, type HealthTheme } from "../lib/healthTheme";
import { MealBuilder } from "./MealBuilder";
import { WorkoutSection } from "./WorkoutSection";

// ── Health mode ──────────────────────────────────────────────────────────────
// Two tools: the Meal Builder (macro-first daily tracking) and Workouts.
//
// NAVIGATION, rebuilt 2026-09-10. The two sections used to live in a 30px
// unlabelled icon toggle in the top-right of the header — a fork and a dumbbell —
// sitting in a row with three OTHER icon buttons of the same size and weight
// (language, appearance, sign out). So the most-used control in the mode looked
// exactly like "log out", said nothing about where you were, and sat at the top
// of a phone screen where a thumb does not reach. Worse, the Meal Builder then
// showed a SECOND unlabelled icon pair (a person, two people) directly beneath
// it, meaning something entirely different.
//
// Now: the sections are a labelled bottom bar, and everything that is not a
// section — language, appearance, sign out — is behind one Settings button. The
// header carries the one thing that must stay reachable from anywhere, which is
// the switch back to Finance.

const SECTIONS = [
  { id: "kitchen" as const, label: "Meals", Icon: UtensilsCrossed },
  { id: "plan" as const, label: "Workouts", Icon: Dumbbell },
];

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
  const [sub, setSub] = useState<"plan" | "kitchen">(
    () => (localStorage.getItem("hb-health-sub") as "plan" | "kitchen") || "kitchen",
  );
  useEffect(() => localStorage.setItem("hb-health-sub", sub), [sub]);
  const [theme, setTheme] = useState<HealthTheme>(loadHealthTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pickTheme = (tid: HealthTheme) => {
    setTheme(tid);
    saveHealthTheme(tid);
  };

  return (
    <HealthProvider>
      <div className={`htheme htheme-${theme} min-h-screen`}>
        <header className="safe-top" style={{ borderBottom: "1px solid var(--color-edge)" }}>
          <div className="mx-auto flex h-14 max-w-[640px] items-center gap-2 px-4">
            <ModeToggle mode={mode} onMode={onMode} />
            <div className="min-w-0 flex-1" />
            <button
              onClick={() => setSettingsOpen(true)}
              className="grid h-10 w-10 place-items-center rounded-full"
              style={{ color: "var(--color-taupe)" }}
              aria-label={t("Settings")}
            >
              <Settings size={18} />
            </button>
          </div>
        </header>

        {/* Bottom padding clears the fixed tab bar — 76px of bar plus the phone's
            own home-indicator inset, so the last row of content is never sitting
            underneath it. */}
        <main
          className="mx-auto max-w-[640px] px-4 pt-3"
          style={{ paddingBottom: "calc(88px + env(safe-area-inset-bottom))" }}
        >
          {sub === "kitchen" ? (
            <MealBuilder owner={owner} person={owner} />
          ) : (
            <WorkoutSection owner={owner} person={owner} />
          )}
        </main>

        <nav className="h-tabs" aria-label={t("Health sections")}>
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setSub(id)}
              className={sub === id ? "on" : ""}
              aria-current={sub === id ? "page" : undefined}
            >
              <Icon size={19} />
              {t(label)}
            </button>
          ))}
        </nav>

        <SettingsSheet
          open={settingsOpen}
          theme={theme}
          onPick={pickTheme}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </HealthProvider>
  );
}

/**
 * Everything that is not a section.
 *
 * These three were top-level icon buttons competing with the section switch for
 * the same strip of header. They are each used a handful of times a year; the
 * section switch is used every time the mode is opened. Rank follows use.
 */
function SettingsSheet({
  open,
  theme,
  onPick,
  onClose,
}: {
  open: boolean;
  theme: HealthTheme;
  onPick: (t: HealthTheme) => void;
  onClose: () => void;
}) {
  const { signOut } = useAuth();
  const { lang, setLang } = useLang();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: "rgba(0,0,0,.6)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] border p-4 pb-6 sm:rounded-[22px]"
        style={{
          background: "var(--color-tile)",
          borderColor: "var(--color-edge)",
          borderRadius: "22px 22px 0 0",
          paddingBottom: "calc(24px + env(safe-area-inset-bottom))",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <div className="flex-1 text-[15px] font-bold" style={{ color: "var(--color-bone)" }}>
            {t("Settings")}
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full" style={{ color: "var(--color-taupe)" }} aria-label={t("Close")}>
            <X size={18} />
          </button>
        </div>

        <div className="h-eyebrow" style={{ marginBottom: "var(--h-2)" }}>
          <Palette size={13} /> {t("Appearance")}
        </div>
        {/* The swatch shows the theme's ACCENT against its own ground, because
            that pairing is the actual difference between them now — the old chips
            showed a gradient that only one of the three ever used. */}
        <div className="grid grid-cols-3 gap-2">
          {HEALTH_THEMES.map((th) => {
            const on = th.id === theme;
            return (
              <button
                key={th.id}
                onClick={() => onPick(th.id)}
                className="rounded-[14px] border p-2.5 text-center transition active:scale-[0.98]"
                style={{
                  borderColor: on ? "var(--color-accent)" : "var(--color-edge)",
                  background: "var(--color-raised)",
                }}
                aria-pressed={on}
              >
                <span
                  className="mb-2 grid h-10 place-items-center rounded-[10px]"
                  style={{ background: th.ground, boxShadow: `inset 0 0 0 1px ${th.edge}` }}
                >
                  <span className="block h-4 w-4 rounded-full" style={{ background: th.swatch }} />
                </span>
                <span className="block text-[12px] font-semibold" style={{ color: "var(--color-bone)" }}>
                  {t(th.label)}
                </span>
                <span className="mt-0.5 block text-[10px]" style={{ color: "var(--color-taupe)" }}>
                  {t(th.blurb)}
                </span>
                {on && (
                  <span className="mt-1 inline-flex items-center gap-1 text-[10px]" style={{ color: "var(--color-accent)" }}>
                    <Check size={11} /> {t("On")}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="h-eyebrow" style={{ margin: "var(--h-4) 0 var(--h-2)" }}>
          <Languages size={13} /> {t("Language")}
        </div>
        <div className="h-seg" style={{ width: "100%" }}>
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")} style={{ flex: 1 }}>
            English
          </button>
          <button className={`notranslate ${lang === "zh" ? "on" : ""}`} onClick={() => setLang("zh")} style={{ flex: 1 }}>
            中文
          </button>
        </div>

        <button
          onClick={() => signOut()}
          className="h-btn quiet"
          style={{ marginTop: "var(--h-4)" }}
        >
          <LogOut size={15} /> {t("Sign out")}
        </button>
      </div>
    </div>
  );
}
