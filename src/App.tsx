import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { FinanceProvider, useStore } from "./store/FinanceStore";
import { OnePager } from "./views/OnePager";
import { HealthView } from "./views/HealthView";
import type { AppMode } from "./components/ModeToggle";
import { LanguageProvider } from "./components/LanguageProvider";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { getOwner, type Owner } from "./lib/owner";

export default function App() {
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
  useEffect(() => {
    localStorage.setItem("hb-mode", mode);
  }, [mode]);

  return (
    <LanguageProvider>
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
        <HealthView mode={mode} onMode={setMode} />
      ) : (
        <FinanceGate mode={mode} onMode={setMode} />
      )}
    </LanguageProvider>
  );
}

function FinanceGate({
  mode,
  onMode,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
}) {
  const { loading } = useStore();
  if (loading) return <FullScreenLoader />;
  return <OnePager mode={mode} onMode={onMode} />;
}
