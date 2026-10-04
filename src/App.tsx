// Homebase, compressed to three screens.
//
// HIS INSTRUCTION, 2026-10-04: "compress the app down to literally Bills, Accounts
// budget … strip everything out except those things. For the App side. The database
// can stay intact but the app, what we see i want compressed into those things that
// are most important."
//
// So this file is now the shortest path from "signed in" to those three screens.
// What it used to carry and no longer does:
//
//   · HEALTH MODE — meals, workouts, weight, the label scanner. Every table still
//     exists and every health tool on both Muse doors still answers; what is gone
//     is the screens. `AppMode` and the finance/health switch went with it, since a
//     toggle between two modes is meaningless when there is one.
//   · THE OWNER LENS ("Mine" vs "Household"), on his own words: "You have to stop
//     thinking about us as separate."
//   · FIVE DEV LABS (?lab, ?meallab, ?workoutlab, ?labellab, ?doctorlab) and the
//     fixtures behind them. They were already DEV-only and never shipped, so this
//     costs the bundle nothing — it is the four screens they harnessed that are
//     gone, which left the harnesses pointed at nothing.
//
// WHY THE "who's using this phone" SCREEN SURVIVED, since nothing on the three
// screens is per-person any more: src/lib/push.ts reads `hb-owner` straight out of
// localStorage to address a notification, and a push sent with no owner fans out to
// every device in the household — which is how one heartbeat alarm buzzed all six
// phones at once. A fresh device with no owner would register for push as nobody.
// It is asked once and then never again.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { FinanceProvider, useStore } from "./store/FinanceStore";
import { LanguageProvider } from "./components/LanguageProvider";
import { getOwner, saveOwner, OWNER_NAME, OWNER_COLOR, type Owner } from "./lib/owner";
import { PlaidOAuthReturn } from "./components/PlaidOAuthReturn";
import { syncNow } from "./lib/plaidClient";
import { syncPushSubscription } from "./lib/push";
import { FinanceTabs } from "./views/redesign/FinanceTabs";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { t } from "./lib/i18n";

export default function App() {
  return (
    <>
      <UpdatePrompt />
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </>
  );
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="animate-spin text-accent" size={28} />
    </div>
  );
}

function AuthGate() {
  const { session, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!session) return <LoginScreen />;
  return (
    <FinanceProvider>
      <Shell />
    </FinanceProvider>
  );
}

/** Asked once per device and then never again — not a screen, a missing fact. */
function WhoAreYou({ onPick }: { onPick: (o: Owner) => void }) {
  return (
    <div
      className="mx-auto flex h-[100dvh] max-w-[440px] flex-col items-center justify-center gap-4 px-6"
      style={{ background: "#0b0f17" }}
    >
      <p className="text-[15px] text-taupe">{t("Who's using this phone?")}</p>
      {(["gino", "xinyan"] as Owner[]).map((o) => (
        <button
          key={o}
          onClick={() => onPick(o)}
          className="w-full rounded-2xl py-4 text-[17px] font-semibold transition active:scale-95"
          style={{ background: OWNER_COLOR[o] + "26", color: OWNER_COLOR[o], border: `1px solid ${OWNER_COLOR[o]}55` }}
        >
          {OWNER_NAME[o]}
        </button>
      ))}
    </div>
  );
}

function Shell() {
  const { loading } = useStore();
  const [owner, setOwner] = useState<Owner | null>(() => getOwner());

  // Sync the bank feed once on open, so the day's charges are already in.
  useEffect(() => {
    syncNow().catch(() => {});
  }, []);
  // Re-assert this phone's push registration on every open. The stored row is what
  // the sender actually delivers to, and it can vanish without the browser noticing
  // (see syncPushSubscription) — so it gets re-asserted rather than written once and
  // trusted.
  useEffect(() => {
    syncPushSubscription().catch(() => {});
  }, []);

  const pick = (o: Owner) => {
    saveOwner(o);
    setOwner(o);
  };

  return (
    <LanguageProvider>
      <PlaidOAuthReturn />
      {!owner ? (
        <WhoAreYou onPick={pick} />
      ) : loading ? (
        <FullScreenLoader />
      ) : (
        <FinanceTabs />
      )}
    </LanguageProvider>
  );
}
