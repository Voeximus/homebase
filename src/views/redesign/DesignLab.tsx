import { useState } from "react";
import { Wallet, HeartPulse } from "lucide-react";
import { TabNav, type TabKey } from "./TabNav";
import { HomeTab } from "./HomeTab";
import { InsightsTab, type InsightsVM } from "./InsightsTab";
import { ActivityTab, type ActivityVM } from "./ActivityTab";
import { ProfileTab, type ProfileVM } from "./ProfileTab";
import { BillsSheet } from "./BillsSheet";
import { CategorySheet, type EnvelopeVM } from "./CategorySheet";
import type { HomeVM, BillsVM } from "./vm";

// ── Mock view-models. These live ONLY in this dev-only harness (App.tsx lazy-
//    loads it behind import.meta.env.DEV), so they never ship to production —
//    keeping the real email / bank / account masks out of the public bundle. ──
const MOCK_INSIGHTS: InsightsVM = {
  budgetSpent: 719,
  budgetTarget: 1250,
  donut: [
    { catId: "groceries", amount: 392 },
    { catId: "transport", amount: 83 },
    { catId: "dining", amount: 84 },
    { catId: "shopping", amount: 40 },
    { catId: "health", amount: 30 },
    { catId: "other", amount: 90 },
  ],
  categories: [
    { catId: "groceries", label: "Groceries", spent: 392, target: 500 },
    { catId: "transport", label: "Gas + convenience", spent: 83, target: 250 },
    { catId: "dining", label: "Dining out", spent: 84, target: 150 },
    { catId: "shopping", label: "Household + hygiene", spent: 40, target: 90 },
    { catId: "health", label: "Health + grooming", spent: 30, target: 110 },
    { catId: "other", label: "Dog · car · subs", spent: 90, target: 150 },
  ],
  income: 5975,
  living: 2742,
  variable: 1250,
  atDebt: 1983,
  debtFreeBy: "Oct '26",
  monthsToGo: 4,
  interest: 248,
  ladder: [
    { rank: 1, name: "Affirm", amount: 289, target: true },
    { rank: 3, name: "Xinyan card …6813", amount: 591, live: true },
    { rank: 5, name: "Card …4728", amount: 4157, live: true, apr: 26.49 },
  ],
};

const MOCK_ACTIVITY: ActivityVM = {
  sinceMonday: 1136,
  needsReview: 4,
  monthLabel: "June 2026",
  counted: 719,
  rows: [
    { id: "r1", merchant: "Sam's Club", catId: "groceries", amount: 229.81, fate: "envelope", badgeLabel: "→ Groceries" },
    { id: "r2", merchant: "QuikTrip", catId: "transport", amount: 9.07, fate: "envelope", badgeLabel: "→ Gas" },
    { id: "r3", merchant: "Verizon", catId: "utilities", amount: 83.0, fate: "skip", badgeLabel: "Bill · not in budget" },
    { id: "r4", merchant: "SQ *JOHNNY'S", catId: "other", amount: 18.4, fate: "review", badgeLabel: "Needs review" },
    { id: "r5", merchant: "Payroll", catId: "salary", amount: 991.0, fate: "income", badgeLabel: "Income · not in budget" },
  ],
};

const MOCK_PROFILE: ProfileVM = {
  ownerName: "Demo",
  ownerColor: "#ef8136",
  email: "demo@example.com",
  bankName: "Bank of America",
  bankSub: "Connected · 2 logins",
  cardsSub: "…4728 + …6813 linked · auto-syncs",
  accounts: [
    { name: "Checking …4662", owner: "Gino", balance: 1306.67, dot: "#5b82b3" },
    { name: "SafeBalance …1211", owner: "Joint", balance: 15.48, dot: "#687180" },
    { name: "SafeBalance …0366", owner: "Xinyan", balance: 1000.0, dot: "#46d18a" },
  ],
  lang: "en",
  lens: "me",
  variableBills: [
    { id: "electric", name: "Electric (SRP)", icon: "electric", est: "~$89.92 · est. from last 3", on: true },
    { id: "verizon", name: "Verizon", icon: "phone", est: "~$82.83 · est. from last 3", on: true },
  ],
};

const ENV: EnvelopeVM = {
  label: "Groceries",
  catId: "groceries",
  spent: 492.02,
  target: 500,
  txns: [
    { id: "a", name: "Sam's Club", dateLabel: "Wed, Jun 17", amount: 229.81 },
    { id: "b", name: "99 Ranch Market", dateLabel: "Tue, Jun 16", amount: 85.9 },
    { id: "c", name: "Safeway", dateLabel: "Wed, Jun 17", amount: 34.27 },
    { id: "d", name: "Fantuan Delivery", dateLabel: "Mon, Jun 8", amount: 9.99 },
  ],
};

// ── Mock data = Gino's real figures, so the look is verifiable without a login.
const HOME: HomeVM = {
  firepower: 1983,
  overspent: 0,
  debtFreeBy: "Oct '26",
  nextAmount: 991,
  nextDate: "Jun 30",
  cash: 2322,
  cashAccounts: 3,
  processing: 144.43,
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
  anomalyIds: [],
  streakDay: 4,
  streakTotal: 90,
  sinceMonday: 1136,
  recent: [
    { id: "1", merchant: "Sam's Club", catId: "groceries", sub: "Groceries · today", amount: 229.81 },
    { id: "2", merchant: "QuikTrip", catId: "transport", sub: "Gas · yesterday", amount: 9.07 },
    { id: "3", merchant: "Verizon", catId: "utilities", sub: "Bill · Jun 17", amount: 83 },
  ],
  bills: { left: 449, nextName: "Claude Pro", nextDate: "Jun 20" },
};

const BILLS: BillsVM = {
  leftThisMonth: 449.1,
  upcoming: [
    { id: "claude@20", name: "Claude Pro", catId: "subscriptions", amount: 21.62, day: 20, dateLabel: "Jun 20", relLabel: "tomorrow", variable: false },
    { id: "tmobile@29", name: "T-Mobile", catId: "utilities", amount: 27.48, day: 29, dateLabel: "Jun 29", relLabel: "in 10 days", variable: false },
    { id: "mom@30", name: "Mom", catId: "other", amount: 400, day: 30, dateLabel: "Jun 30", relLabel: "in 11 days", variable: false },
  ],
  paidCount: 9,
  paidTotal: 2099,
  monthLabel: "June 2026",
  todayNum: 19,
  daysInMonth: 30,
  firstWeekday: 1,
  calendar: [
    { day: 1, in: false, out: true }, { day: 4, in: false, out: true }, { day: 8, in: false, out: true },
    { day: 10, in: false, out: true }, { day: 13, in: false, out: true }, { day: 15, in: true, out: true },
    { day: 16, in: false, out: true }, { day: 17, in: false, out: true }, { day: 18, in: false, out: true },
    { day: 20, in: false, out: true }, { day: 29, in: true, out: true }, { day: 30, in: false, out: true },
  ],
  monthBills: [
    { id: "rent@1", name: "Rent", catId: "housing", amount: 1232.44, day: 1, dateLabel: "Jun 1", relLabel: "overdue", variable: false, paid: true },
    { id: "electric@13", name: "Electric (SRP)", catId: "utilities", amount: 85, day: 13, dateLabel: "Jun 13", relLabel: "overdue", variable: true, paid: true },
    { id: "verizon@17", name: "Verizon", catId: "utilities", amount: 83, day: 17, dateLabel: "Jun 17", relLabel: "overdue", variable: true, paid: true },
    { id: "claude@20", name: "Claude Pro", catId: "subscriptions", amount: 21.62, day: 20, dateLabel: "Jun 20", relLabel: "tomorrow", variable: false, paid: false },
    { id: "tmobile@29", name: "T-Mobile", catId: "utilities", amount: 27.48, day: 29, dateLabel: "Jun 29", relLabel: "in 10 days", variable: false, paid: false },
    { id: "mom@30", name: "Mom", catId: "other", amount: 400, day: 30, dateLabel: "Jun 30", relLabel: "in 11 days", variable: false, paid: false },
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
  const [billsOpen, setBillsOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  return (
    <div
      className="mx-auto flex min-h-screen max-w-[440px] flex-col"
      style={{ background: "#0b0f17" }}
    >
      <TopBar />
      <div className="flex-1 overflow-y-auto">
        {tab === "home" ? (
          <HomeTab vm={HOME} taps={{ onBills: () => setBillsOpen(true) }} />
        ) : tab === "insights" ? (
          <InsightsTab vm={MOCK_INSIGHTS} taps={{ onCategory: () => setEnvOpen(true) }} />
        ) : tab === "activity" ? (
          <ActivityTab vm={MOCK_ACTIVITY} />
        ) : (
          <ProfileTab vm={MOCK_PROFILE} />
        )}
      </div>
      <TabNav active={tab} onTab={setTab} />
      <BillsSheet vm={BILLS} open={billsOpen} onClose={() => setBillsOpen(false)} />
      <CategorySheet vm={ENV} open={envOpen} onClose={() => setEnvOpen(false)} />
    </div>
  );
}
