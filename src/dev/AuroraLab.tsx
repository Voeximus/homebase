// ?auroralab — the Aurora finance screens over an INVENTED household (no login, no
// store, nothing reaches Supabase). DEV-only: App.tsx lazy-loads it behind
// import.meta.env.DEV, so it and these made-up figures never ship.
//
// Every figure below is invented for the preview. None is the household's — this
// repository is public.

import { useMemo, useState } from "react";
import "../aurora/aurora.css";
import type { AppData, Debt, Recurring, Transaction } from "../types";
import { DEFAULT_CATEGORIES } from "../lib/seed";
import { buildFinanceVMs, visibleLedger } from "../views/redesign/buildVMs";
import { buildAuroraVMs } from "../aurora/vms";
import { AuroraBackground, FloatingTabBar, IconButton, type AuroraTab } from "../aurora/components";
import { ProfileTab } from "../views/redesign/ProfileTab";
import { HomeScreen } from "../aurora/HomeScreen";
import { ActivityScreen } from "../aurora/ActivityScreen";
import { GoalsScreen } from "../aurora/GoalsScreen";
import { InsightsScreen } from "../aurora/InsightsScreen";
import { addDays, localISO } from "../aurora/logic";

const today = localISO(new Date());
const sunday = addDays(today, -new Date(today + "T12:00:00").getDay());
const created = "2026-01-01T00:00:00Z";

function invented(): AppData {
  const accounts = [
    { id: "a1", name: "Everyday", owner: "Gino" as const, type: "checking", balance: 640.18, sortOrder: 0, createdAt: created },
    { id: "a2", name: "Household", owner: "Joint" as const, type: "checking", balance: 512.4, sortOrder: 1, createdAt: created },
    { id: "a3", name: "Second", owner: "Xinyan" as const, type: "checking", balance: 388.05, sortOrder: 2, createdAt: created },
    { id: "a4", name: "Card", owner: "Gino" as const, type: "credit card", balance: 1200, sortOrder: 3, createdAt: created },
  ];
  const debts: Debt[] = [
    { id: "d1", name: "Credit card (…1111)", balance: 1200, originalBalance: 3000, apr: 24, color: "#9B8CFF", createdAt: created },
    { id: "d2", name: "Store card (…2222)", balance: 300, originalBalance: 900, apr: 26, color: "#FF7AB6", createdAt: created },
    { id: "d3", name: "Dentist plan", balance: 420, originalBalance: 1000, apr: 0, color: "#3BE0CF", createdAt: created },
    { id: "d4", name: "Family loan", balance: 600, originalBalance: 1000, color: "#FFC46B", createdAt: created },
  ];
  const r = (x: Partial<Recurring> & Pick<Recurring, "id" | "name" | "amount" | "direction">): Recurring => ({
    cadence: "monthly",
    active: true,
    createdAt: created,
    accountId: "a2",
    ...x,
  });
  const recurring: Recurring[] = [
    r({ id: "r1", name: "Paycheck", amount: 3400, direction: "in", cadence: "semimonthly", dueDays: [15, 31], categoryId: "salary", accountId: "a1" }),
    r({ id: "r2", name: "Second paycheck", amount: 1500, direction: "in", cadence: "biweekly", anchorDate: "2026-01-02", categoryId: "salary", accountId: "a3" }),
    r({ id: "r3", name: "Rent", amount: 1300, direction: "out", dueDays: [1], categoryId: "housing" }),
    r({ id: "r4", name: "Phone", amount: 70, direction: "out", dueDays: [28], categoryId: "utilities" }),
    r({ id: "r5", name: "Electric", amount: 90, direction: "out", dueDays: [12], categoryId: "utilities" }),
    r({ id: "r6", name: "Car payment", amount: 210, direction: "out", dueDays: [6], categoryId: "car" }),
    r({ id: "r7", name: "Car insurance", amount: 150, direction: "out", dueDays: [30], categoryId: "car" }),
    r({ id: "r8", name: "Dentist plan", amount: 100, direction: "out", dueDays: [20], categoryId: "other", linkedDebtId: "d3" }),
    r({ id: "r9", name: "Family loan", amount: 200, direction: "out", dueDays: [1], categoryId: "other", linkedDebtId: "d4" }),
    r({ id: "r10", name: "Streaming", amount: 12, direction: "out", dueDays: [9], categoryId: "subscriptions", accountId: "a4" }),
  ];
  let n = 0;
  const tx = (daysAgo: number, amount: number, categoryId: string, description: string, extra: Partial<Transaction> = {}): Transaction => ({
    id: `t${++n}`,
    date: addDays(today, -daysAgo),
    amount,
    type: "expense",
    categoryId,
    description,
    accountId: "a2",
    createdAt: `${addDays(today, -daysAgo)}T12:00:${String(n % 60).padStart(2, "0")}Z`,
    ...extra,
  });
  const transactions: Transaction[] = [
    tx(0, 38.2, "groceries", "Corner Market", { pending: true }),
    tx(0, 6.5, "dining", "Bean & Leaf"),
    tx(1, 42.9, "transport", "Fuel stop"),
    tx(1, 24.0, "shopping", "Pharmacy"),
    tx(2, 64.12, "groceries", "Weekly shop"),
    tx(3, 18.4, "dining", "Noodle bar"),
    tx(4, 1450, "salary", "Payroll deposit", { type: "income", accountId: "a1" }),
    tx(5, 31.0, "pets", "Pet supply"),
    tx(6, 55.3, "groceries", "Weekly shop"),
    tx(7, 12.75, "dining", "Coffee"),
    tx(8, 22.0, "other", "Hardware store"),
    tx(9, 48.0, "transport", "Fuel stop"),
    tx(10, 71.6, "groceries", "Weekly shop"),
    tx(12, 15.0, "dining", "Tacos"),
  ];
  return {
    transactions,
    debts,
    goals: [],
    categories: DEFAULT_CATEGORIES,
    accounts,
    recurring,
    paidBills: [],
    merchantRules: [],
    foods: [],
    cycleBudgets: [],
    weekPlans: [{ id: "w1", weekStart: sunday, lines: { groceries: 150, gas: 50, dining: 40, household: 60, pets: 20, misc: 30 } }],
  };
}

export function AuroraLab() {
  const data = useMemo(invented, []);
  const [tab, setTab] = useState<Exclude<AuroraTab, "health">>("home");
  const [pushed, setPushed] = useState<"insights" | "profile" | null>(null);
  const vms = useMemo(() => buildFinanceVMs(data, "gino", "all", { email: "lab@example.com", lang: "en" }), [data]);
  const au = useMemo(() => {
    return buildAuroraVMs(data, vms, visibleLedger(data, "gino", "all"), new Date(), {
      reviewCount: 2,
      notices: [{ id: "owed", title: "Owed to you", sub: "1 waiting to be paid back", amount: "$25.00", tone: "teal", onClick: () => {} }],
    });
  }, [data, vms]);
  const noop = () => {};
  return (
    <div className="au">
      {pushed === "profile" ? (
        <>
          <AuroraBackground preset="home" />
          <div className="au-scroll">
            <main className="au-main" style={{ paddingLeft: 0, paddingRight: 0 }}>
              <header className="au-header" style={{ padding: "0 var(--au-space-gutter)" }}>
                <span className="au-title-row">
                  <IconButton icon="chevron-left" label="Back" onClick={() => setPushed(null)} />
                  <h1 className="au-title">Profile</h1>
                </span>
              </header>
              <ProfileTab aurora vm={vms.profile} />
            </main>
          </div>
        </>
      ) : pushed === "insights" ? (
        <InsightsScreen vm={au.insights} taps={{ onBack: () => setPushed(null), onCategory: noop }} />
      ) : tab === "home" ? (
        <HomeScreen vm={au.home} taps={{ onProfile: () => setPushed("profile"), onBills: noop, onBill: noop, onWeek: () => setPushed("insights") }} />
      ) : tab === "activity" ? (
        <ActivityScreen vm={au.activity} taps={{ onWeek: () => setPushed("insights"), onRow: noop, onReview: noop, onAdd: noop, onRefresh: async () => {} }} />
      ) : (
        <GoalsScreen vm={au.goals} taps={{ onPlan: noop }} />
      )}
      <FloatingTabBar
        active={pushed === "insights" ? "activity" : pushed === "profile" ? "home" : tab}
        onTab={(t) => {
          if (t === "health") return;
          setPushed(null);
          setTab(t);
        }}
        badges={{ activity: 2 }}
      />
    </div>
  );
}
