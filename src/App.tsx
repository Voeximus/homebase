import { useState } from "react";
import { FileUp, Loader2, LogOut, Plus, Settings } from "lucide-react";
import type { Tab } from "./types";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginScreen } from "./auth/LoginScreen";
import { FinanceProvider, useStore } from "./store/FinanceStore";
import { Button, Sheet } from "./components/ui";
import { AddTransactionSheet } from "./components/AddTransactionSheet";
import { ImportSheet } from "./components/ImportSheet";
import { ThreeMonthPlan } from "./views/ThreeMonthPlan";
import { Budget } from "./views/Budget";
import { Money } from "./views/Money";

const NAV: { tab: Tab; label: string }[] = [
  { tab: "plan", label: "Plan" },
  { tab: "budget", label: "Budget" },
  { tab: "money", label: "Money" },
];

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
      <Loader2 className="animate-spin text-violet-400" size={28} />
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
  const { loading } = useStore();
  const { signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("plan");
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="safe-top mx-auto min-h-screen max-w-[1440px] px-3 py-3 sm:px-5 sm:py-4">
      {/* Top nav */}
      <header className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.03] px-2.5 py-2 backdrop-blur">
        <div className="flex items-center gap-1 rounded-xl bg-black/20 p-1">
          {NAV.map((n) => (
            <button
              key={n.tab}
              onClick={() => setTab(n.tab)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === n.tab
                  ? "bg-white/10 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {n.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-violet-500"
          >
            <Plus size={15} /> <span className="hidden sm:inline">Add</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-full p-2 text-slate-400 transition hover:bg-white/5"
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
          <div className="hidden items-center gap-2 rounded-full bg-white/5 py-1 pl-1 pr-3 sm:flex">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-600 text-xs font-bold text-white">
              G
            </div>
            <span className="text-xs font-medium text-slate-200">Household</span>
          </div>
          <button
            onClick={() => signOut()}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/5"
          >
            <LogOut size={14} /> <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="mt-3">
        {loading ? (
          <div className="flex justify-center py-32">
            <Loader2 className="animate-spin text-violet-400" size={26} />
          </div>
        ) : (
          <>
            {tab === "plan" && <ThreeMonthPlan />}
            {tab === "budget" && <Budget />}
            {tab === "money" && <Money />}
          </>
        )}
      </main>

      <AddTransactionSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onImport={() => {
          setSettingsOpen(false);
          setImportOpen(true);
        }}
      />
    </div>
  );
}

function SettingsSheet({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: () => void;
}) {
  const { resetAll, seedHousehold } = useStore();
  const { session } = useAuth();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="space-y-3">
        <div className="rounded-xl bg-teal-50 p-3 text-sm">
          <p className="font-semibold text-teal-800">☁️ Cloud sync is on</p>
          <p className="mt-0.5 text-teal-700/80">
            Signed in as {session?.user.email}. Changes sync live to every
            device you're both signed in on.
          </p>
        </div>
        <Button variant="soft" className="w-full" onClick={onImport}>
          <FileUp size={16} /> Import bank statement (CSV)
        </Button>
        <Button
          className="w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setStatus(null);
            const r = await seedHousehold();
            setStatus(r.message);
            setBusy(false);
          }}
        >
          {busy ? "Setting up…" : "Set up my household"}
        </Button>
        {status && (
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
            {status}
          </p>
        )}
        <Button
          variant="danger"
          className="w-full"
          onClick={async () => {
            if (
              window.confirm(
                "Delete ALL accounts, recurring, transactions, debts and goals on this account? This can't be undone.",
              )
            ) {
              await resetAll();
              onClose();
            }
          }}
        >
          Clear all data
        </Button>
      </div>
    </Sheet>
  );
}
