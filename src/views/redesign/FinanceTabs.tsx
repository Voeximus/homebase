import { useMemo, useState } from "react";
import { Wallet, HeartPulse, User, Users } from "lucide-react";
import { useStore } from "../../store/FinanceStore";
import { useAuth } from "../../auth/AuthProvider";
import { useLang } from "../../components/LanguageProvider";
import { getLang, t } from "../../lib/i18n";
import { syncNow } from "../../lib/plaidClient";
import type { AppMode } from "../../components/ModeToggle";
import type { Owner } from "../../lib/owner";
import { ownAccounts, jointAccounts, type Lens } from "../../lib/lens";
import { TabNav, type TabKey } from "./TabNav";
import { HomeTab } from "./HomeTab";
import { InsightsTab } from "./InsightsTab";
import { ActivityTab } from "./ActivityTab";
import { ProfileTab } from "./ProfileTab";
import { buildFinanceVMs } from "./buildVMs";
import { selfAudit } from "../../lib/selfAudit";
import { LedgerSheet } from "../../components/LedgerSheet";
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
import { merchantKey } from "../../lib/categorize";
import { monthKeyOf } from "../../lib/format";

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
    <div
      className="flex items-center justify-between px-4 pb-2.5"
      style={{ background: "#0b0f17", paddingTop: "calc(env(safe-area-inset-top) + 10px)" }}
    >
      <span
        className="flex rounded-full p-0.5"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <Seg active={mode === "finance"} onClick={() => onMode("finance")}>
          <Wallet size={14} /> {t("Finance")}
        </Seg>
        <Seg active={mode === "health"} onClick={() => onMode("health")}>
          <HeartPulse size={14} /> {t("Health")}
        </Seg>
      </span>
      <span
        className="flex rounded-full p-0.5"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <Seg active={lens === "me"} onClick={() => onLens("me")}>
          <User size={14} /> {t("Mine")}
        </Seg>
        <Seg active={lens === "all"} onClick={() => onLens("all")}>
          <Users size={14} /> {t("All")}
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
  const store = useStore();
  const { data, payBill, markBillPaid, setRecurringVariable, acknowledgeAnomaly, settleReimbursable, unsettleReimbursable } = store;
  const { session, signOut } = useAuth();
  const { setLang } = useLang();
  // Persist the active tab so a language switch (which remounts the whole tree
  // via LanguageProvider's key bump) doesn't throw you back to Home.
  const [tab, setTabState] = useState<TabKey>(() => {
    try {
      const t = localStorage.getItem("hb-fin-tab");
      return t === "insights" || t === "activity" || t === "profile" ? t : "home";
    } catch {
      return "home";
    }
  });
  const setTab = (t: TabKey) => {
    try {
      localStorage.setItem("hb-fin-tab", t);
    } catch {
      /* ignore */
    }
    setTabState(t);
  };
  const [, setSyncing] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [envLine, setEnvLine] = useState<BudgetLine | null>(null);
  const [sprintOpen, setSprintOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [billsOpen, setBillsOpen] = useState(false);
  const [payBillEntry, setPayBillEntry] = useState<ScheduleEntry | null>(null);
  const [txnId, setTxnId] = useState<string | null>(null);
  const [ledgerView, setLedgerView] = useState<"all" | "unusual">("all");
  const [anomalyOpen, setAnomalyOpen] = useState(false);
  const [owedOpen, setOwedOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const anySheetOpen =
    ledgerOpen || addOpen || importOpen || !!envLine || sprintOpen || accountsOpen ||
    settingsOpen || billsOpen || !!payBillEntry || !!txnId || anomalyOpen || owedOpen || reviewOpen;

  // The attack ladder reads the shared payoff projection from buildVMs (vms.deploy).
  const vms = useMemo(
    () => buildFinanceVMs(data, owner, lens, { email: session?.user.email ?? "", lang: getLang() }),
    [data, owner, lens, session],
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

  // Lens-filtered ledger + a merchant-rule lookup, for the reused LedgerSheet.
  const personal = lens === "me";
  const ledgerTxns = useMemo(() => {
    const otherLabel = owner === "gino" ? "Xinyan" : "Gino";
    const otherIds = new Set(
      data.accounts.filter((a) => a.owner === otherLabel).map((a) => a.id),
    );
    return data.transactions
      .filter((tx) => !tx.appliesTo?.settled)
      // excluded set-asides drop from the all-time ledger too (match `visible`)
      .filter((tx) => !(tx.appliesTo?.kind === "setaside" && tx.appliesTo.reason === "excluded"))
      .filter((tx) => !personal || !tx.accountId || !otherIds.has(tx.accountId));
  }, [data.transactions, data.accounts, personal, owner]);
  const hasRule = useMemo(() => {
    const set = new Set(data.merchantRules.map((r) => r.pattern));
    return (d: string) => set.has(merchantKey(d));
  }, [data.merchantRules]);
  // The Cash account LIST follows the lens like the cash TOTAL does: own + joint
  // in "Mine", everyone in "Household". (The total in buildVMs was already
  // lens-aware; this brings the expandable list in line.)
  const lensAccounts = useMemo(
    () =>
      personal
        ? [...ownAccounts(data.accounts, owner), ...jointAccounts(data.accounts)]
        : data.accounts,
    [data.accounts, personal, owner],
  );
  const now = new Date();
  const monthKey = monthKeyOf(now);

  const refresh = async () => {
    setSyncing(true);
    await syncNow(true).catch(() => {});
    setSyncing(false);
  };
  const openCategory = (catId: string) =>
    setEnvLine(LEAN_VARIABLE.find((l) => l.cats.includes(catId)) ?? null);
  const openBillPay = (b: MonthCalBill) => {
    setBillsOpen(false);
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

  return (
    <div
      className="mx-auto flex h-[100dvh] max-w-[440px] flex-col overflow-hidden"
      style={{ background: "#0b0f17" }}
    >
      <TopBar mode={mode} onMode={onMode} lens={lens} onLens={onLens} />
      <div
        className="min-h-0 flex-1"
        style={{ overflowY: anySheetOpen ? "hidden" : "auto", overscrollBehaviorY: "contain" }}
      >
        {tab === "home" ? (
          <HomeTab
            vm={vms.home}
            taps={{
              onCash: () => setAccountsOpen(true),
              onDebt: () => setSprintOpen(true),
              onBudget: () => setTab("insights"),
              onBills: () => setBillsOpen(true),
              onRecent: () => {
                setLedgerView("all");
                setLedgerOpen(true);
              },
              onAnomaly: () => setAnomalyOpen(true),
              onOwed: () => setOwedOpen(true),
            }}
          />
        ) : tab === "insights" ? (
          <InsightsTab vm={vms.insights} taps={{ onCategory: openCategory }} />
        ) : tab === "activity" ? (
          <ActivityTab
            vm={vms.activity}
            reviewCount={suggestions.length}
            taps={{
              onRefresh: refresh,
              onRow: (id) => setTxnId(id),
              onAdd: () => setAddOpen(true),
              onReview: () => setReviewOpen(true),
            }}
          />
        ) : (
          <ProfileTab
            vm={vms.profile}
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
        )}
      </div>
      <TabNav active={tab} onTab={setTab} badges={{ activity: suggestions.length }} />

      <LedgerSheet
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        txns={
          ledgerView === "unusual"
            ? ledgerTxns.filter((t) => vms.home.anomalyIds.includes(t.id))
            : ledgerTxns
        }
        hasRule={hasRule}
      />
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
      <AccountsSheet open={accountsOpen} onClose={() => setAccountsOpen(false)} accounts={lensAccounts} />
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
        monthKey={monthKey}
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
    </div>
  );
}
