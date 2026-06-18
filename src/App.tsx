import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { FinanceProvider, useStore } from "./store/FinanceStore";
import { OnePager } from "./views/OnePager";
import { HealthView } from "./views/HealthView";
import type { AppMode } from "./components/ModeToggle";
import { LanguageProvider } from "./components/LanguageProvider";

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
  useEffect(() => {
    localStorage.setItem("hb-mode", mode);
  }, [mode]);

  return (
    <LanguageProvider>
      {mode === "health" ? (
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
