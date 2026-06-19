import { useMemo, useState } from "react";
import { Wallet, HeartPulse, User, Users } from "lucide-react";
import { useStore } from "../../store/FinanceStore";
import { useAuth } from "../../auth/AuthProvider";
import { getLang } from "../../lib/i18n";
import { syncNow } from "../../lib/plaidClient";
import type { AppMode } from "../../components/ModeToggle";
import type { Owner } from "../../lib/owner";
import type { Lens } from "../../lib/lens";
import { TabNav, type TabKey } from "./TabNav";
import { HomeTab } from "./HomeTab";
import { InsightsTab } from "./InsightsTab";
import { ActivityTab } from "./ActivityTab";
import { ProfileTab } from "./ProfileTab";
import { buildFinanceVMs } from "./buildVMs";
import { LedgerSheet } from "../../components/LedgerSheet";
import { AddTransactionSheet } from "../../components/AddTransactionSheet";
import { ImportSheet } from "../../components/ImportSheet";
import {
  EnvelopeSheet,
  SprintSheet,
  MarkSentSheet,
  AccountsSheet,
  SettingsSheet,
} from "../OnePager";
import {
  LEAN_VARIABLE,
  sumTargets,
  planMath,
  orderedDebts,
  payoffSchedule,
  PAY_DAYS,
  SAVINGS_SPLIT,
  type BudgetLine,
} from "../../lib/plan";
import { merchantKey } from "../../lib/categorize";

function Seg({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition"
      style={active ? { background: "#34c5e8", color: "#06303a", fontWeight: 600 } : { color: "#8b97a6" }}
    >
      {children}
    </button>
  );
}

function TopBar({
  mode,
  onMode,
  lens,
  onLens,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5" style={{ background: "#0b0f17" }}>
      <span
        className="flex rounded-full p-0.5"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <Seg active={mode === "finance"} onClick={() => onMode("finance")}>
          <Wallet size={14} /> Finance
        </Seg>
        <Seg active={mode === "health"} onClick={() => onMode("health")}>
          <HeartPulse size={14} /> Health
        </Seg>
      </span>
      <span
        className="flex rounded-full p-0.5"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <Seg active={lens === "me"} onClick={() => onLens("me")}>
          <User size={14} /> Mine
        </Seg>
        <Seg active={lens === "all"} onClick={() => onLens("all")}>
          <Users size={14} /> All
        </Seg>
      </span>
    </div>
  );
}

export function FinanceTabs({
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
  const { data, payDebtExtra } = useStore();
  const { session, signOut } = useAuth();
  const [tab, setTab] = useState<TabKey>("home");
  const [, setSyncing] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [envLine, setEnvLine] = useState<BudgetLine | null>(null);
  const [sprintOpen, setSprintOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [markSentOpen, setMarkSentOpen] = useState(false);

  // The snowball plan (for the attack ladder + the mark-sent slip).
  const debtPlan = useMemo(() => {
    const target = sumTargets(LEAN_VARIABLE);
    const math = planMath(data.recurring, data.debts, target);
    const ordered = orderedDebts(data.debts);
    const schedule = payoffSchedule(ordered, math.firepower, new Date(), PAY_DAYS, SAVINGS_SPLIT);
    return { ordered, schedule, next: schedule[0] ?? null, totalDebt: math.totalDebt };
  }, [data.recurring, data.debts]);

  const vms = useMemo(
    () => buildFinanceVMs(data, owner, lens, { email: session?.user.email ?? "", lang: getLang() }),
    [data, owner, lens, session],
  );

  // Lens-filtered ledger + a merchant-rule lookup, for the reused LedgerSheet.
  const personal = lens === "me";
  const ledgerTxns = useMemo(() => {
    const otherLabel = owner === "gino" ? "Xinyan" : "Gino";
    const otherIds = new Set(
      data.accounts.filter((a) => a.owner === otherLabel).map((a) => a.id),
    );
    return data.transactions
      .filter((tx) => !tx.appliesTo?.settled)
      .filter((tx) => !personal || !tx.accountId || !otherIds.has(tx.accountId));
  }, [data.transactions, data.accounts, personal, owner]);
  const hasRule = useMemo(() => {
    const set = new Set(data.merchantRules.map((r) => r.pattern));
    return (d: string) => set.has(merchantKey(d));
  }, [data.merchantRules]);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const refresh = async () => {
    setSyncing(true);
    await syncNow(true).catch(() => {});
    setSyncing(false);
  };
  const openCategory = (catId: string) =>
    setEnvLine(LEAN_VARIABLE.find((l) => l.cats.includes(catId)) ?? null);

  return (
    <div className="mx-auto flex min-h-screen max-w-[440px] flex-col" style={{ background: "#0b0f17" }}>
      <TopBar mode={mode} onMode={onMode} lens={lens} onLens={onLens} />
      <div className="flex-1 overflow-y-auto">
        {tab === "home" ? (
          <HomeTab
            vm={vms.home}
            taps={{
              onCash: () => setAccountsOpen(true),
              onDebt: () => setSprintOpen(true),
              onStreak: () => setSprintOpen(true),
              onBudget: () => setTab("insights"),
              onNext: () => setMarkSentOpen(true),
              onRecent: () => setLedgerOpen(true),
              onAnomaly: () => setLedgerOpen(true),
            }}
          />
        ) : tab === "insights" ? (
          <InsightsTab vm={vms.insights} taps={{ onCategory: openCategory }} />
        ) : tab === "activity" ? (
          <ActivityTab
            vm={vms.activity}
            taps={{
              onRefresh: refresh,
              onRow: () => setLedgerOpen(true),
              onAdd: () => setAddOpen(true),
            }}
          />
        ) : (
          <ProfileTab
            vm={vms.profile}
            taps={{
              onHealth: () => onMode("health"),
              onSignOut: () => void signOut(),
              onImport: () => setImportOpen(true),
              onEdit: () => setSettingsOpen(true),
              onBank: () => setSettingsOpen(true),
              onCards: () => setSettingsOpen(true),
              onAdvanced: () => setSettingsOpen(true),
            }}
          />
        )}
      </div>
      <TabNav active={tab} onTab={setTab} />

      <LedgerSheet open={ledgerOpen} onClose={() => setLedgerOpen(false)} txns={ledgerTxns} hasRule={hasRule} />
      <AddTransactionSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      <EnvelopeSheet line={envLine} onClose={() => setEnvLine(null)} monthKey={monthKey} />
      <SprintSheet
        open={sprintOpen}
        onClose={() => setSprintOpen(false)}
        ordered={debtPlan.ordered}
        schedule={debtPlan.schedule}
        totalDebt={debtPlan.totalDebt}
      />
      <MarkSentSheet
        open={markSentOpen}
        onClose={() => setMarkSentOpen(false)}
        next={debtPlan.next}
        accounts={data.accounts}
        onPay={payDebtExtra}
      />
      <AccountsSheet open={accountsOpen} onClose={() => setAccountsOpen(false)} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} onImport={() => setImportOpen(true)} />
    </div>
  );
}
