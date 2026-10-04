import { User, Users } from "lucide-react";
import { t } from "../lib/i18n";
import type { Lens } from "../lib/lens";

const ITEMS = [
  { l: "me" as const, label: "Mine", Icon: User },
  { l: "all" as const, label: "Household", Icon: Users },
];

/** Flips a mode between this person's own slice ("me") and the whole
 *  household picture ("all"). Active option shows icon + label; the other
 *  collapses to its icon to stay compact in the header. */
export function LensToggle({
  lens,
  onLens,
}: {
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-raised p-0.5">
      {ITEMS.map(({ l, label, Icon }) => {
        const on = lens === l;
        return (
          <button
            key={l}
            onClick={() => onLens(l)}
            aria-pressed={on}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition ${
              on ? "bg-bone text-bg" : "text-taupe hover:text-bone"
            }`}
          >
            <Icon size={13} />
            {on && <span>{t(label)}</span>}
          </button>
        );
      })}
    </div>
  );
}
