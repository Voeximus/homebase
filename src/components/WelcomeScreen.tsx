import { useState } from "react";
import { Activity, Wallet } from "lucide-react";
import { t } from "../lib/i18n";
import { LangToggle } from "./LanguageProvider";
import type { AppMode } from "./ModeToggle";
import {
  OWNER_COLOR,
  OWNER_NAME,
  saveOwner,
  type Owner,
} from "../lib/owner";

// ── The front door ───────────────────────────────────────────────────────────
// Opens on every cold launch. First-ever launch asks "who's phone is this?" and
// binds the device to one spouse. After that it greets that person by name and
// shows the throw-rail: throw a switch to open Finance or Health. The chosen
// emblem glides up toward the header as the app reveals beneath.

const ENTER_MS = 520;

export function WelcomeScreen({
  owner,
  onOwner,
  onEnter,
}: {
  owner: Owner | null;
  onOwner: (o: Owner) => void;
  onEnter: (m: AppMode) => void;
}) {
  const [pending, setPending] = useState<Owner | null>(null);
  const [thrown, setThrown] = useState<AppMode | null>(null);
  const entering = thrown !== null;

  function throwTo(m: AppMode) {
    if (entering) return;
    setThrown(m);
    window.setTimeout(() => onEnter(m), ENTER_MS);
  }

  // ── first launch: who's phone is this? ──
  if (!owner) {
    return (
      <div className="relative min-h-screen overflow-hidden">
        <div className="safe-top absolute inset-x-0 top-0 flex h-14 items-center justify-end px-4">
          <LangToggle />
        </div>
        <div className="mx-auto flex min-h-screen max-w-[420px] flex-col items-center justify-center px-8 text-center">
          <p className="eyebrow text-faint">▣ HOMEBASE</p>

          {!pending ? (
            <>
              <h1 className="mt-3 text-2xl font-semibold text-bone">
                {t("Whose phone is this?")}
              </h1>
              <p className="mt-2 text-sm text-taupe">
                {t("Pick yourself once — this phone will remember.")}
              </p>
              <div className="mt-8 w-full space-y-3">
                {(["gino", "xinyan"] as Owner[]).map((o) => (
                  <button
                    key={o}
                    onClick={() => setPending(o)}
                    className="flex w-full items-center justify-center gap-3 rounded-2xl border border-edge bg-tile py-4 text-lg font-semibold text-bone transition hover:border-accent/50 active:scale-[.98]"
                  >
                    <span
                      className="grid h-8 w-8 place-items-center rounded-full text-sm font-bold text-bg"
                      style={{ background: OWNER_COLOR[o] }}
                    >
                      {OWNER_NAME[o][0]}
                    </span>
                    {t(OWNER_NAME[o])}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <span
                className="mt-2 grid h-14 w-14 place-items-center rounded-full text-xl font-bold text-bg"
                style={{ background: OWNER_COLOR[pending] }}
              >
                {OWNER_NAME[pending][0]}
              </span>
              <h1 className="mt-4 text-2xl font-semibold text-bone">
                {t("You're {name}?", { name: t(OWNER_NAME[pending]) })}
              </h1>
              <p className="mt-2 text-sm text-taupe">
                {t(
                  "This phone will stay yours, {name}. You can change it later in Settings.",
                  { name: t(OWNER_NAME[pending]) },
                )}
              </p>
              <button
                onClick={() => {
                  saveOwner(pending);
                  onOwner(pending);
                  setPending(null);
                }}
                className="mt-8 w-full rounded-2xl bg-accent py-4 text-lg font-semibold text-bg transition active:scale-[.98]"
              >
                {t("Yes, that's me")}
              </button>
              <button
                onClick={() => setPending(null)}
                className="mt-3 text-sm text-taupe underline-offset-2 transition hover:text-bone hover:underline"
              >
                {t("Not me")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── returning: greeting + throw-rail ──
  const MODES: { m: AppMode; Icon: typeof Wallet; label: string }[] = [
    { m: "finance", Icon: Wallet, label: t("Finance") },
    { m: "health", Icon: Activity, label: t("Health") },
  ];

  return (
    <div
      className="relative min-h-screen overflow-hidden transition-opacity duration-500"
      style={{ opacity: entering ? 0 : 1 }}
    >
      <div className="safe-top absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-end px-4">
        <LangToggle />
      </div>

      <div className="mx-auto flex min-h-screen max-w-[640px] items-center gap-3 px-7">
        {/* greeting */}
        <div
          className="flex-1 transition duration-500"
          style={{
            opacity: entering ? 0 : 1,
            transform: entering ? "translateX(-12px)" : "none",
          }}
        >
          <p className="eyebrow text-faint">▣ HOMEBASE</p>
          <h1 className="mt-3 text-[27px] font-semibold leading-tight text-bone">
            {t("Welcome back,")}
            <br />
            <span className="text-accent">{t(OWNER_NAME[owner])}</span>
          </h1>
          <p className="mt-2 text-xs text-faint">{t("measure, don't infer")}</p>
          <p className="mt-4 text-xs text-taupe">{t("throw a switch to begin")} →</p>
        </div>

        {/* throw-rail */}
        <div className="relative h-[300px] w-[84px] shrink-0">
          <div
            className="absolute inset-0 rounded-full border border-edge bg-recessed transition-opacity duration-300"
            style={{ opacity: entering ? 0 : 1 }}
          />
          {MODES.map(({ m, Icon, label }, i) => {
            const chosen = thrown === m;
            const dimmed = entering && !chosen;
            return (
              <button
                key={m}
                onClick={() => throwTo(m)}
                aria-label={label}
                className="absolute left-1/2 grid h-14 w-14 place-items-center rounded-2xl border text-accent transition-all duration-500"
                style={{
                  top: chosen ? 8 : i === 0 ? 24 : 222,
                  borderColor: "rgba(52,197,232,.4)",
                  background: "rgba(52,197,232,.13)",
                  transform: `translateX(-50%) scale(${chosen ? 1.08 : 1})`,
                  opacity: dimmed ? 0 : 1,
                  boxShadow: chosen
                    ? "0 0 0 1px rgba(52,197,232,.6), 0 10px 30px rgba(52,197,232,.4)"
                    : "none",
                }}
              >
                <Icon size={26} />
              </button>
            );
          })}
          {MODES.map(({ m, label }, i) => (
            <span
              key={m}
              className="eyebrow absolute left-1/2 -translate-x-1/2 text-center text-faint transition-opacity duration-300"
              style={{ top: i === 0 ? 84 : 282, opacity: entering ? 0 : 1 }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
