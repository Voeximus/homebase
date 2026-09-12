import { useState } from "react";
import { WelcomeScreen, type DoorVM } from "../../components/WelcomeScreen";
import { LanguageProvider } from "../../components/LanguageProvider";
import type { Owner } from "../../lib/owner";

// ?door — the intro screen, on fixed figures, with no session and no store.
// The front door is the one surface you cannot reach from a dev harness
// otherwise: it renders before the tabs exist and after auth, so working on it
// used to mean signing in and force-quitting between every change.
//
// The owner toggle flips between the FIRST-LAUNCH state (owner: null — "whose
// phone is this") and the RETURNING state, which are the two designs this file
// actually has.

const MOCK: DoorVM = {
  cash: 1194,
  processing: 723,
  leftToSpend: 412,
  cycleLabel: "Sep 4 – Sep 18",
  nextBillName: "Rent",
  nextBillDate: "Oct 1",
};

export function DoorLab() {
  const [owner, setOwner] = useState<Owner | null>("gino");
  return (
    <LanguageProvider>
      <div style={{ position: "fixed", inset: "auto auto 10px 10px", zIndex: 99, display: "flex", gap: 6 }}>
        {(["gino", "xinyan", null] as (Owner | null)[]).map((o) => (
          <button
            key={String(o)}
            onClick={() => setOwner(o)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 700,
              border: "1px solid var(--color-edge)",
              background: owner === o ? "var(--color-accent)" : "var(--color-tile)",
              color: owner === o ? "#101a33" : "var(--color-taupe)",
            }}
          >
            {o ?? "first launch"}
          </button>
        ))}
      </div>
      <WelcomeScreen
        owner={owner}
        onOwner={setOwner}
        onEnter={(m) => console.log("entered", m)}
        vmOverride={MOCK}
      />
    </LanguageProvider>
  );
}
