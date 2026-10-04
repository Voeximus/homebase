import { HeartPulse, Wallet } from "lucide-react";
import { t } from "../lib/i18n";
import { HEALTH } from "../lib/catColor";

export type AppMode = "finance" | "health";

// Health uses the HeartPulse icon + rose brand (matching the Settings mode row),
// so flipping into Health visibly reads as the red health instrument.
const ITEMS = [
  { m: "finance" as const, label: "Finance", Icon: Wallet },
  { m: "health" as const, label: "Health", Icon: HeartPulse },
];

/** Top-level switch between the money instrument and the body instrument.
 *  Active mode shows icon + label; the other collapses to just its icon. */
export function ModeToggle({
  mode,
  onMode,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-raised p-0.5">
      {ITEMS.map(({ m, label, Icon }) => {
        const on = mode === m;
        const health = m === "health";
        return (
          <button
            key={m}
            onClick={() => onMode(m)}
            aria-pressed={on}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition ${
              on ? (health ? "text-white" : "bg-bone text-bg") : "text-taupe hover:text-bone"
            }`}
            style={on && health ? { background: HEALTH } : undefined}
          >
            <Icon size={14} />
            {on && <span>{t(label)}</span>}
          </button>
        );
      })}
    </div>
  );
}
