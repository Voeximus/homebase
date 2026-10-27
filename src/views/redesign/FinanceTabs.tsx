import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store/FinanceStore";
import { useAuth } from "../../auth/AuthProvider";
import { useLang } from "../../components/LanguageProvider";
import { getLang, t } from "../../lib/i18n";
import { syncNow } from "../../lib/plaidClient";
import type { AppMode } from "../../components/ModeToggle";
import type { Owner } from "../../lib/owner";
import type { Lens } from "../../lib/lens";
import { ProfileTab } from "./ProfileTab";
import { buildFinanceVMs, visibleLedger } from "./buildVMs";
import "../../aurora/aurora.css";
import { FloatingTabBar, PushedScreen, type AuroraTab } from "../../aurora/components";
import { HomeScreen } from "../../aurora/HomeScreen";
import { ActivityScreen } from "../../aurora/ActivityScreen";
import { GoalsScreen } from "../../aurora/GoalsScreen";
import { InsightsScreen } from "../../aurora/InsightsScreen";
import { buildAuroraVMs } from "../../aurora/vms";
import { money2 } from "../../aurora/logic";
import { selfAudit } from "../../lib/selfAudit";
import { AddTransactionSheet } from "../../components/AddTransactionSheet";
import { ImportSheet } from "../../components/ImportSheet";
import {
  SprintSheet,
  AccountsSheet,
  SettingsSheet,
  PayBillSheet,
} from "../sheets";
import { CategorySheet, type EnvelopeVM } from "./CategorySheet";
import { BillsSheet } from "./BillsSheet";
import { TxnSheet } from "./TxnSheet";
import { OwedSheet } from "./OwedSheet";
import { AnomalySheet } from "./AnomalySheet";
import { ReviewSheet } from "./ReviewSheet";
import { applyFix, type ReviewWrites } from "./reviewApply";
import { reviewSuggestions, sortSuggestions } from "../../lib/reviewEngine";
import { dismissLocally, loadDismissed, mergeDismissed } from "../../lib/doctorDismissals";
import type { Suggestion } from "../../lib/reviewTypes";
import { monthCalendar, type ScheduleEntry, type MonthCalBill } from "../../lib/schedule";
import { LEAN_VARIABLE, type BudgetLine } from "../../lib/plan";
import { monthKeyOf } from "../../lib/format";

export function FinanceTabs({
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
  const store = useStore();
  const { data, payBill, markBillPaid, setRecurringVariable, acknowledgeAnomaly, settleReimbursable, unsettleReimbursable } = store;
  const { session, signOut } = useAuth();
  const { setLang } = useLang();
  // Persist the active tab so a language switch (which remounts the whole tree
  // via LanguageProvider's key bump) doesn't throw you back to Home.
  type FinTab = Exclude<AuroraTab, "health">;
  const [tab, setTabState] = useState<FinTab>(() => {
    try {
      const t = localStorage.getItem("au-fin-tab");
      return t === "activity" || t === "goals" ? t : "home";
    } catch {
      return "home";
    }
  });
  const setTab = (t: AuroraTab) => {
    // Health is the fourth tab (decision 4, 2026-10-26): it switches mode, and the
    // Health screen's own Finance switch brings you back to the tab you left.
    if (t === "health") return onMode("health");
    try {
      localStorage.setItem("au-fin-tab", t);
    } catch {
      /* ignore */
    }
    setPushed(null);
    setTabState(t);
  };
  // A screen pushed over the tabs: Insights (from a week card) or Profile (from the
  // avatar). Kept for the session, because switching language remounts this whole
  // tree (LanguageProvider's key) — and the language switch lives ON Profile.
  type Pushed = "insights" | "profile" | null;
  const [pushed, setPushedState] = useState<Pushed>(() => {
    try {
      const p = sessionStorage.getItem("au-fin-pushed");
      return p === "insights" || p === "profile" ? p : null;
    } catch {
      return null;
    }
  });
  function setPushed(p: Pushed) {
    try {
      if (p) sessionStorage.setItem("au-fin-pushed", p);
      else sessionStorage.removeItem("au-fin-pushed");
    } catch {
      /* ignore */
    }
    setPushedState(p);
  }
  // A push or a pop replaces the whole screen, so focus would fall to <body>; land it
  // on the new screen's heading instead.
  const screenKey = pushed ?? tab;
  const lastScreen = useRef(screenKey);
  useEffect(() => {
    if (screenKey === lastScreen.current) return;
    lastScreen.current = screenKey;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".au [data-au-focus]")?.focus({ preventScroll: true }));
  }, [screenKey]);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [envLine, setEnvLine] = useState<BudgetLine | null>(null);
  const [sprintOpen, setSprintOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [billsOpen, setBillsOpen] = useState(false);
  const [payBillEntry, setPayBillEntry] = useState<ScheduleEntry | null>(null);
  // The month the bill being paid belongs to — last month's, for an overdue one.
  const [payMonth, setPayMonth] = useState<string | null>(null);
  const [txnId, setTxnId] = useState<string | null>(null);
  const [anomalyOpen, setAnomalyOpen] = useState(false);
  const [owedOpen, setOwedOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const anySheetOpen =
    addOpen || importOpen || !!envLine || sprintOpen || accountsOpen ||
    settingsOpen || billsOpen || !!payBillEntry || !!txnId || anomalyOpen || owedOpen || reviewOpen;

  // The attack ladder reads the shared payoff projection from buildVMs (vms.deploy).
  // Household-wide ("all"), always: every Aurora figure — the balance, the forecast,
  // the week, the debts — is the household's ("her money is my money"), and a list
  // filtered to one person under totals for two would not add up. Nothing else reads
  // the Mine/All setting, so Profile does not show its switch inside Aurora.
  const vms = useMemo(
    () => buildFinanceVMs(data, owner, "all", { email: session?.user.email ?? "", lang: getLang() }),
    [data, owner, session],
  );

  // The app checking its own arithmetic. Deliberately NOT lens-filtered: an
  // invariant either holds for the household or it does not, and hiding half the
  // data would make a real disagreement look like a clean bill of health.
  const audit = useMemo(() => selfAudit(data), [data]);

  // ── Worth a look ───────────────────────────────────────────────────────────
  // The OTHER kind of wrong. The audit above is the app disagreeing with itself:
  // certain, exactly zero in a healthy app, shown in Profile with no buttons. This
  // is the app noticing something about the money, where every number is
  // self-consistent and the model may be out of date: a guess with evidence, shown
  // in Activity with one tap to fix. They never share a screen and never share a
  // word — that one "did not add up", this one "worth a look".
  //
  // Not lens-filtered, for the same reason the audit is not: a bill either has a
  // charge or it does not, and hiding half the ledger would invent suggestions.
  const [localDismissed, setLocalDismissed] = useState<ReadonlySet<string>>(() => loadDismissed());
  // This phone's dismissals plus the household's. The household table is spec
  // piece 3, so it is read defensively — absent today, honoured the day it lands.
  const dismissed = useMemo(
    () =>
      mergeDismissed(
        localDismissed,
        (data as typeof data & { reviewDismissals?: { key?: unknown }[] }).reviewDismissals,
      ),
    [localDismissed, data],
  );
  const suggestions = useMemo(
    () => sortSuggestions(reviewSuggestions(data, new Date(), dismissed)),
    [data, dismissed],
  );

  // Which fixes can actually run. `unlinkFromBill` and `deleteTransaction` are in
  // the store today; the other five are spec piece 3. Reading them off the store
  // without asserting they exist means a fix appears the day its action lands, and
  // until then that card shows the evidence instead of a dead button — no edit
  // here either way. One cast, read-only, no writes.
  const reviewWrites: ReviewWrites = (() => {
    const s = store as typeof store & Partial<ReviewWrites>;
    return {
      unlinkFromBill: s.unlinkFromBill,
      deleteTransaction: s.deleteTransaction,
      setRecurringAmount: s.setRecurringAmount,
      setRecurringActive: s.setRecurringActive,
      setRecurringWindow: s.setRecurringWindow,
      addRecurringFromCharges: s.addRecurringFromCharges,
      linkTransactionToBill: s.linkTransactionToBill,
    };
  })();

  // One tap, one write, against the CURRENT data — every guard in applyFix depends
  // on that, because the bank feed may have moved since the card was drawn.
  const applySuggestion = async (s: Suggestion) => {
    if (!s.fix) return { ok: false as const, reason: t("This one is for you to decide.") };
    return applyFix(s.fix, data, reviewWrites);
  };
  const dismissSuggestion = (s: Suggestion) => {
    setLocalDismissed(dismissLocally(s.key));
    // And household-wide, once that store action exists (spec piece 3). The local
    // write above is what makes the tap instant and what makes it work offline.
    const ext = store as typeof store & {
      dismissSuggestion?: (key: string, kind: string) => Promise<void>;
    };
    void ext.dismissSuggestion?.(s.key, s.kind);
  };

  const now = new Date();
  const monthKey = monthKeyOf(now);

  const openBillPay = (b: MonthCalBill) => {
    setBillsOpen(false);
    setPayMonth(null);
    setPayBillEntry({
      day: b.day,
      label: b.name,
      amount: b.amount,
      direction: "out",
      recurringId: b.recurringId,
      variable: b.variable,
    });
  };
  const payRec = payBillEntry
    ? data.recurring.find((r) => r.id === payBillEntry.recurringId)
    : undefined;
  // Read, never recompute: the bar and this list must be the same calculation.
  const envVM: EnvelopeVM | null = envLine
    ? (vms.envelopes.find((e) => e.key === envLine.key) ?? null)
    : null;

  // Every number the Aurora screens show, built once from the same data and
  // view-models the sheets read (src/aurora/vms.ts).
  const visible = useMemo(() => visibleLedger(data, owner, "all"), [data, owner]);
  const au = useMemo(() => {
    const notices = [];
    // What the bank is holding but has not itemized yet (the old Cash tile's line).
    if (vms.home.processing > 0)
      notices.push({
        id: "processing",
        title: t("Waiting to post"),
        sub: t("The bank is still holding this"),
        amount: `~${money2(vms.home.processing)}`,
        onClick: () => setAccountsOpen(true),
      });
    if (vms.home.anomalyCount > 0)
      notices.push({
        id: "anomaly",
        title: t("Unusual purchases"),
        sub: t("{n} buys ran higher than usual", { n: vms.home.anomalyCount }),
        amount: String(vms.home.anomalyCount),
        tone: "rose" as const,
        onClick: () => setAnomalyOpen(true),
      });
    if (vms.home.owedToYou > 0)
      notices.push({
        id: "owed",
        title: t("Owed to you"),
        sub: t("{n} waiting to be paid back", { n: vms.home.owedList.length }),
        amount: money2(vms.home.owedToYou),
        tone: "teal" as const,
        onClick: () => setOwedOpen(true),
      });
    return buildAuroraVMs(data, vms, visible, new Date(), { reviewCount: suggestions.length, notices });
  }, [data, vms, visible, suggestions.length]);

  return (
    <>
    {/* The Aurora screens are scoped under .au; the sheets render beside it, so
        none of Aurora's type or colour reaches them until each gets its own pass. */}
    <div className={anySheetOpen ? "au au--locked" : "au"}>
      {pushed === "insights" ? (
        <InsightsScreen
          vm={au.insights}
          taps={{
            onBack: () => setPushed(null),
            onCategory: (key) => setEnvLine(LEAN_VARIABLE.find((l) => l.key === key) ?? null),
          }}
        />
      ) : pushed === "profile" ? (
        // Profile's rows were built on the body's 1.5 line height; they keep it.
        <PushedScreen
          scrollKey="profile"
          title={t("Profile")}
          onBack={() => setPushed(null)}
          style={{ lineHeight: 1.5, letterSpacing: "-0.006em" }}
        >
              <ProfileTab
                aurora
                vm={{ ...vms.profile, lens }}
                audit={audit}
                taps={{
                  onHealth: () => onMode("health"),
                  onSignOut: () => void signOut(),
                  onImport: () => setImportOpen(true),
                  onEdit: () => setSettingsOpen(true),
                  onBank: () => setSettingsOpen(true),
                  onCards: () => setSettingsOpen(true),
                  onAdvanced: () => setSettingsOpen(true),
                  onLang: (l) => setLang(l),
                  onLens,
                  onToggleVariableBill: (id, on) => void setRecurringVariable(id, on),
                }}
              />
        </PushedScreen>
      ) : tab === "home" ? (
        <HomeScreen
          vm={au.home}
          taps={{
            onProfile: () => setPushed("profile"),
            onBalance: () => setAccountsOpen(true),
            onBills: () => setBillsOpen(true),
            onBill: (b) => {
              setPayMonth(b.monthKey);
              setPayBillEntry({
                day: b.day,
                label: b.name,
                amount: b.amount,
                direction: "out",
                recurringId: b.recurringId,
                variable: b.variable,
              });
            },
            onWeek: () => setPushed("insights"),
          }}
        />
      ) : tab === "activity" ? (
        <ActivityScreen
          vm={au.activity}
          taps={{
            onWeek: () => setPushed("insights"),
            onRow: (id) => setTxnId(id),
            onReview: () => setReviewOpen(true),
            onAdd: () => setAddOpen(true),
            onRefresh: async () => {
              await syncNow(true).catch(() => {});
            },
          }}
        />
      ) : (
        <GoalsScreen vm={au.goals} taps={{ onPlan: () => setSprintOpen(true) }} />
      )}
      <FloatingTabBar
        active={tab}
        onTab={setTab}
        badges={{ activity: suggestions.length }}
      />
    </div>

      <AddTransactionSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      <CategorySheet
        vm={envVM}
        open={!!envLine}
        onClose={() => setEnvLine(null)}
        onTxn={(id) => {
          setEnvLine(null);
          setTxnId(id);
        }}
      />
      <SprintSheet
        open={sprintOpen}
        onClose={() => setSprintOpen(false)}
        ordered={vms.deploy.ordered}
        schedule={vms.deploy.schedule}
        totalDebt={vms.deploy.totalDebt}
      />
      {/* Opened from Home's balance, which is the household's — so is the list. */}
      <AccountsSheet open={accountsOpen} onClose={() => setAccountsOpen(false)} accounts={data.accounts} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} onImport={() => setImportOpen(true)} />
      <BillsSheet
        open={billsOpen}
        onClose={() => setBillsOpen(false)}
        onPay={openBillPay}
        getMonth={(y, m) => monthCalendar(data.recurring, data.transactions, new Date(), y, m, data.debts)}
        baseDate={new Date()}
      />
      <PayBillSheet
        entry={payBillEntry}
        monthKey={payMonth ?? monthKey}
        accounts={data.accounts}
        defaultAccountId={payRec?.accountId}
        variable={payRec?.variable ?? false}
        feedOwned={(() => {
          const d = payRec?.linkedDebtId
            ? data.debts.find((x) => x.id === payRec.linkedDebtId)
            : undefined;
          return !!d && (!!d.providerAccountId || !!d.trackPattern);
        })()}
        onClose={() => {
          setPayBillEntry(null);
          setPayMonth(null);
        }}
        onPay={payBill}
        onMarkPaid={markBillPaid}
        onSetVariable={setRecurringVariable}
      />
      <TxnSheet txnId={txnId} open={!!txnId} onClose={() => setTxnId(null)} />
      <OwedSheet
        open={owedOpen}
        onClose={() => setOwedOpen(false)}
        owed={vms.home.owedList}
        settled={vms.home.owedSettled}
        onSettle={(id, creditId) => void settleReimbursable(id, creditId)}
        onUnsettle={(id) => void unsettleReimbursable(id)}
      />
      <AnomalySheet
        open={anomalyOpen}
        onClose={() => setAnomalyOpen(false)}
        anomalies={vms.home.anomalies}
        onDismiss={(id) => void acknowledgeAnomaly(id)}
        onTxn={(id) => {
          setAnomalyOpen(false);
          setTxnId(id);
        }}
      />
      <ReviewSheet
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        suggestions={suggestions}
        writes={reviewWrites}
        taps={{
          onApply: applySuggestion,
          onDismiss: dismissSuggestion,
          onTxn: (id) => {
            setReviewOpen(false);
            setTxnId(id);
          },
          onBills: () => {
            setReviewOpen(false);
            setBillsOpen(true);
          },
        }}
      />
    </>
  );
}
