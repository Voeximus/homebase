// Three screens: Bills, Accounts, Budget.
//
// HIS INSTRUCTION, 2026-10-04: "compress the app down to literally Bills, Accounts
// budget … strip everything out except those things. For the App side. The database
// can stay intact but the app, what we see i want compressed into those things that
// are most important."
//
// WHAT CAME OUT. Four tabs (Home, Insights, Activity, Profile) and fourteen sheets
// behind them: the ledger, the transaction editor, the review queue, the importer,
// the debt sprint, the owed/reimbursable tracker, the anomaly list, settings, the
// whole Health mode (meals, workouts, label scanning) and five dev labs. Roughly
// 10,000 of 17,000 lines of UI.
//
// WHAT DID NOT COME OUT, and this is the part worth being precise about: none of the
// DATA and none of the CAPABILITY. Every table is untouched, and all 41 read tools
// and 56 write tools still answer — so "mark that bill paid", "what's in groceries",
// "log a weight" are all still available, through Muse rather than through a screen.
// This file deletes screens, not functions. It is reversible from git in one commit.
//
// THE ONE THING I KEPT THAT HE DID NOT NAME, deliberately, and it is not a fourth
// tab: ConnectBank. It lived inside SettingsSheet, which is gone. Plaid connections
// expire and come back needing re-authorisation — `needs_reauth` is a real state the
// doors report — and with no link button anywhere, the bank feed would eventually
// stop and there would be no way in the app to start it again. Every number in all
// three remaining screens comes off that feed. So it sits under Accounts, which is
// what it is about.
//
// THE LENS IS GONE TOO ("Mine" vs "Household"), on his own words: "You have to stop
// thinking about us as separate." Everything here is the household.
import { useMemo, useState } from "react";
import { useStore } from "../../store/FinanceStore";
import { t } from "../../lib/i18n";
import { TabNav, type TabKey } from "./TabNav";
import { InsightsTab } from "./InsightsTab";
import { buildFinanceVMs } from "./buildVMs";
import { AccountsSheet, PayBillSheet, ConnectBank, CreditCardLinks } from "../sheets";
import { CategorySheet, type EnvelopeVM } from "./CategorySheet";
import { BillsSheet } from "./BillsSheet";
import { monthCalendar, type ScheduleEntry, type MonthCalBill } from "../../lib/schedule";
import { LEAN_VARIABLE } from "../../lib/plan";
import { monthKeyOf } from "../../lib/format";

const TAB_KEYS: TabKey[] = ["bills", "accounts", "budget"];

export function FinanceTabs() {
  const { data, payBill, markBillPaid, setRecurringVariable } = useStore();
  // Persist the active tab so a language switch (which remounts the whole tree via
  // LanguageProvider's key bump) doesn't throw you back to the first one.
  const [tab, setTabState] = useState<TabKey>(() => {
    try {
      const stored = localStorage.getItem("hb-fin-tab");
      return (TAB_KEYS as string[]).includes(stored ?? "") ? (stored as TabKey) : "bills";
    } catch {
      return "bills";
    }
  });
  const setTab = (next: TabKey) => {
    try {
      localStorage.setItem("hb-fin-tab", next);
    } catch {
      /* a phone with storage blocked still gets a working app, just not a sticky tab */
    }
    setTabState(next);
  };

  const [envCatId, setEnvCatId] = useState<string | null>(null);
  const [payBillEntry, setPayBillEntry] = useState<ScheduleEntry | null>(null);

  // Household-wide, always. buildFinanceVMs lost its `lens`, `extra` AND `owner`
  // arguments with the screens that used them: owner only ever fed the "Mine" filter.
  const vms = useMemo(() => buildFinanceVMs(data), [data]);

  // Read, never recompute: the bar and the drill-in list must be the same calculation.
  const envLine = envCatId ? (LEAN_VARIABLE.find((l) => l.cats.includes(envCatId)) ?? null) : null;
  const envVM: EnvelopeVM | null = envLine
    ? (vms.envelopes.find((e) => e.key === envLine.key) ?? null)
    : null;

  const openBillPay = (b: MonthCalBill) =>
    setPayBillEntry({
      day: b.day,
      label: b.name,
      amount: b.amount,
      direction: "out",
      recurringId: b.recurringId,
      variable: b.variable,
    });
  const payRec = payBillEntry
    ? data.recurring.find((r) => r.id === payBillEntry.recurringId)
    : undefined;

  const sheetOpen = !!envLine || !!payBillEntry;

  return (
    <div
      className="mx-auto flex h-[100dvh] max-w-[440px] flex-col overflow-hidden"
      style={{ background: "#0b0f17" }}
    >
      <div
        className="min-h-0 flex-1 px-3 pt-4"
        style={{ overflowY: sheetOpen ? "hidden" : "auto", overscrollBehaviorY: "contain" }}
      >
        {tab === "bills" ? (
          <BillsSheet
            panel
            onPay={openBillPay}
            getMonth={(y, m) =>
              monthCalendar(data.recurring, data.transactions, new Date(), y, m, data.debts)
            }
          />
        ) : tab === "accounts" ? (
          <div className="space-y-4">
            <AccountsSheet panel />
            {/* Not a settings screen — the two things about accounts that have to be
                reachable, because nothing else in the app can do them. */}
            <div className="space-y-3 border-t pt-4" style={{ borderColor: "#1d2530" }}>
              <ConnectBank />
              <CreditCardLinks />
            </div>
          </div>
        ) : (
          <InsightsTab vm={vms.insights} taps={{ onCategory: setEnvCatId }} />
        )}
        <div className="h-6" />
      </div>

      <TabNav active={tab} onTab={setTab} />

      {/* The two sheets that are actions ON these three screens, not screens of
          their own: the category drill-in and paying a bill. */}
      <CategorySheet vm={envVM} open={!!envLine} onClose={() => setEnvCatId(null)} />
      <PayBillSheet
        entry={payBillEntry}
        monthKey={monthKeyOf(new Date())}
        accounts={data.accounts}
        defaultAccountId={payRec?.accountId}
        variable={payRec?.variable ?? false}
        feedOwned={(() => {
          const d = payRec?.linkedDebtId
            ? data.debts.find((x) => x.id === payRec.linkedDebtId)
            : undefined;
          return !!d && (!!d.providerAccountId || !!d.trackPattern);
        })()}
        onClose={() => setPayBillEntry(null)}
        onPay={payBill}
        onMarkPaid={markBillPaid}
        onSetVariable={setRecurringVariable}
      />
      <span className="sr-only">{t("Homebase")}</span>
    </div>
  );
}
