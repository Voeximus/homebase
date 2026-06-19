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
  const { data } = useStore();
  const { session, signOut } = useAuth();
  const [tab, setTab] = useState<TabKey>("home");
  const [, setSyncing] = useState(false);

  const vms = useMemo(
    () => buildFinanceVMs(data, owner, lens, { email: session?.user.email ?? "", lang: getLang() }),
    [data, owner, lens, session],
  );

  const refresh = async () => {
    setSyncing(true);
    await syncNow(true).catch(() => {});
    setSyncing(false);
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[440px] flex-col" style={{ background: "#0b0f17" }}>
      <TopBar mode={mode} onMode={onMode} lens={lens} onLens={onLens} />
      <div className="flex-1 overflow-y-auto">
        {tab === "home" ? (
          <HomeTab vm={vms.home} />
        ) : tab === "insights" ? (
          <InsightsTab vm={vms.insights} />
        ) : tab === "activity" ? (
          <ActivityTab vm={vms.activity} taps={{ onRefresh: refresh }} />
        ) : (
          <ProfileTab
            vm={vms.profile}
            taps={{ onHealth: () => onMode("health"), onSignOut: () => void signOut() }}
          />
        )}
      </div>
      <TabNav active={tab} onTab={setTab} />
    </div>
  );
}
