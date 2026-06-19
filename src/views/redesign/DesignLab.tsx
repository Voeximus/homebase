import { useState } from "react";
import { Wallet, HeartPulse } from "lucide-react";
import { TabNav, type TabKey } from "./TabNav";
import { HomeTab } from "./HomeTab";
import { InsightsTab, MOCK_INSIGHTS } from "./InsightsTab";
import { ActivityTab, MOCK_ACTIVITY } from "./ActivityTab";
import { ProfileTab, MOCK_PROFILE } from "./ProfileTab";
import type { HomeVM } from "./vm";

// ── Mock data = Gino's real figures, so the look is verifiable without a login.
const HOME: HomeVM = {
  firepower: 1983,
  debtFreeBy: "Oct '26",
  nextAmount: 991,
  nextDate: "Jun 30",
  cash: 2322,
  cashAccounts: 3,
  debtLeft: 5837,
  debtProgressPct: 31,
  budgetSpent: 719,
  budgetTarget: 1250,
  donut: [
    { catId: "groceries", amount: 392 },
    { catId: "other", amount: 90 },
    { catId: "dining", amount: 84 },
    { catId: "transport", amount: 83 },
    { catId: "shopping", amount: 40 },
    { catId: "health", amount: 30 },
  ],
  anomalyCount: 3,
  streakDay: 4,
  streakTotal: 90,
  sinceMonday: 1136,
  recent: [
    { id: "1", merchant: "Sam's Club", catId: "groceries", sub: "Groceries · today", amount: 229.81 },
    { id: "2", merchant: "QuikTrip", catId: "transport", sub: "Gas · yesterday", amount: 9.07 },
    { id: "3", merchant: "Verizon", catId: "utilities", sub: "Bill · Jun 17", amount: 83 },
  ],
};

function TopBar() {
  return (
    <div
      className="flex items-center justify-between px-4 py-2.5"
      style={{ background: "#0b0f17" }}
    >
      <span
        className="flex items-center gap-2 rounded-full p-0.5 text-[12px]"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <span
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold"
          style={{ background: "#34c5e8", color: "#06303a" }}
        >
          <Wallet size={14} /> Finance
        </span>
        <span className="flex items-center gap-1.5 px-3 py-1.5" style={{ color: "#8b97a6" }}>
          <HeartPulse size={14} /> Health
        </span>
      </span>
      <span
        className="flex rounded-full p-0.5 text-[12px]"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <span
          className="rounded-full px-3 py-1.5 font-semibold"
          style={{ background: "#0b0f17", color: "#e6edf3" }}
        >
          Mine
        </span>
        <span className="px-3 py-1.5" style={{ color: "#8b97a6" }}>
          Household
        </span>
      </span>
    </div>
  );
}

export function DesignLab() {
  const [tab, setTab] = useState<TabKey>("home");
  return (
    <div
      className="mx-auto flex min-h-screen max-w-[440px] flex-col"
      style={{ background: "#0b0f17" }}
    >
      <TopBar />
      <div className="flex-1 overflow-y-auto">
        {tab === "home" ? (
          <HomeTab vm={HOME} />
        ) : tab === "insights" ? (
          <InsightsTab vm={MOCK_INSIGHTS} />
        ) : tab === "activity" ? (
          <ActivityTab vm={MOCK_ACTIVITY} />
        ) : (
          <ProfileTab vm={MOCK_PROFILE} />
        )}
      </div>
      <TabNav active={tab} onTab={setTab} />
    </div>
  );
}
