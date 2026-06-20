import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { FinanceProvider, useStore } from "./store/FinanceStore";
import { HealthView } from "./views/HealthView";
import type { AppMode } from "./components/ModeToggle";
import { LanguageProvider } from "./components/LanguageProvider";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { getOwner, type Owner } from "./lib/owner";
import { getLens, saveLens, type Lens } from "./lib/lens";
import { PlaidOAuthReturn } from "./components/PlaidOAuthReturn";
import { syncNow } from "./lib/plaidClient";
import { FinanceTabs } from "./views/redesign/FinanceTabs";

// ?lab — the bento design lab (mock data, no login). DEV-ONLY: lazy + gated on
// import.meta.env.DEV so the harness AND its mock fixtures tree-shake entirely
// out of the production bundle (nothing real ships to GitHub Pages).
const DesignLab = import.meta.env.DEV
  ? lazy(() => import("./views/redesign/DesignLab").then((m) => ({ default: m.DesignLab })))
  : null;
const MealLab = import.meta.env.DEV
  ? lazy(() => import("./views/redesign/MealLab").then((m) => ({ default: m.MealLab })))
  : null;

export default function App() {
  if (
    import.meta.env.DEV &&
    DesignLab &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("lab")
  ) {
    return (
      <Suspense fallback={null}>
        <DesignLab />
      </Suspense>
    );
  }
  if (
    import.meta.env.DEV &&
    MealLab &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("meallab")
  ) {
    return (
      <Suspense fallback={null}>
        <MealLab />
      </Suspense>
    );
  }
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
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

function Shell() {
  const [mode, setMode] = useState<AppMode>(
    () => (localStorage.getItem("hb-mode") as AppMode) || "finance",
  );
  const [owner, setOwner] = useState<Owner | null>(() => getOwner());
  // Per cold launch: the welcome screen is the front door every time you open.
  const [entered, setEntered] = useState(false);
  // The owner lens: "me" = your own slice, "all" = the whole household.
  const [lens, setLens] = useState<Lens>(() => getLens());
  useEffect(() => {
    localStorage.setItem("hb-mode", mode);
  }, [mode]);
  // Sync the bank feed once on open, so the day's purchases are waiting to train.
  useEffect(() => {
    syncNow().catch(() => {});
  }, []);
  const onLens = (l: Lens) => {
    saveLens(l);
    setLens(l);
  };

  // owner is guaranteed set once `entered` (you can't throw the switch without
  // picking who you are on first launch).
  const who = owner as Owner;

  return (
    <LanguageProvider>
      <PlaidOAuthReturn />
      {!entered ? (
        <WelcomeScreen
          owner={owner}
          onOwner={setOwner}
          onEnter={(m) => {
            setMode(m);
            setEntered(true);
          }}
        />
      ) : mode === "health" ? (
        <HealthView
          mode={mode}
          onMode={setMode}
          owner={who}
          lens={lens}
          onLens={onLens}
        />
      ) : (
        <FinanceGate
          mode={mode}
          onMode={setMode}
          owner={who}
          lens={lens}
          onLens={onLens}
        />
      )}
    </LanguageProvider>
  );
}

function FinanceGate({
  mode,
  onMode,
  owner,
  lens,
  onLens,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
  owner: Owner;
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  const { loading } = useStore();
  if (loading) return <FullScreenLoader />;
  return (
    <FinanceTabs mode={mode} onMode={onMode} owner={owner} lens={lens} onLens={onLens} />
  );
}
