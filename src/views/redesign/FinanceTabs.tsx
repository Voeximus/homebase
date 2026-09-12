import { useMemo, useState } from "react";
import { User, Users } from "lucide-react";
import { useStore } from "../../store/FinanceStore";
import { useAuth } from "../../auth/AuthProvider";
import { useLang } from "../../components/LanguageProvider";
import { getLang, t } from "../../lib/i18n";
import { syncNow } from "../../lib/plaidClient";
import type { AppMode } from "../../components/ModeToggle";
import type { Owner } from "../../lib/owner";
import { ownAccounts, jointAccounts, type Lens } from "../../lib/lens";
import { saveFloor } from "../../lib/floor";
import { TabNav, type TabKey, type NavKey } from "./TabNav";

const TAB_ORDER: TabKey[] = ["home", "insights", "activity", "profile"];
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
      style={active ? { background: "#38c6e8", color: "#04212b", fontWeight: 600 } : { color: "#8b96a5" }}
    >
      {children}
    </button>
  );
}

function TopBar({
  title,
  lens,
  onLens,
}: {
  title: string;
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  return (
    <div
      className="flex items-center justify-between px-4 pb-2.5"
      style={{ background: "#0b0e13", paddingTop: "calc(env(safe-area-inset-top) + 10px)" }}
    >
      {/* The Finance/Health switch used to live here, above the content, while
          the thing it is a sibling of — every other destination — lived in the
          bar at the bottom. Health moved into that bar. What is left on screen
          is the one control that changes what the numbers MEAN rather than
          where you are. */}
      <span className="text-[15px] font-bold tracking-[-0.02em]">{title}</span>
      <span
        className="flex rounded-full p-0.5"
        style={{ background: "#141a23", border: "1px solid #222b38" }}
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

const TITLES: Record<TabKey, string> = {
  home: "",
  insights: "Insights",
  activity: "Activity",
  profile: "Profile",
};

export function FinanceTabs({
  onMode,
  owner,
  lens,
  onLens,
}: {
  // `mode` is gone from here: this component only ever renders in finance mode,
  // and the switch that used to need it now lives in the tab bar.
  onMode: (m: AppMode) => void;
  owner: Owner;
  lens: Lens;
  onLens: (l: Lens) => void;
}) {
  const { data, payBill, markBillPaid, setRecurringVariable, acknowledgeAnomaly, settleReimbursable, unsettleReimbursable } = useStore();
  const { session, signOut } = useAuth();
  const { setLang } = useLang();
  // Persist the active tab so a language switch (which remounts the whole tree
  // via LanguageProvider's key bump) doesn't throw you back to Home.
  // The active tab AND which way it lies from the one before it, held together
  // in one piece of state. The direction was a ref first — it is only read
  // during the render the tab change already causes — but a ref read during
  // render is exactly the thing React tells you not to do, and the two values
  // change at the same instant anyway. One object, one update, one render.
  const [nav, setNav] = useState<{ tab: TabKey; dir: 1 | -1 }>(() => {
    try {
      const t = localStorage.getItem("hb-fin-tab");
      const tab = t === "insights" || t === "activity" || t === "profile" ? t : "home";
      return { tab, dir: 1 };
    } catch {
      return { tab: "home", dir: 1 };
    }
  });
  const tab = nav.tab;
  const dir = nav.dir;
  const setTab = (t: TabKey) => {
    try {
      localStorage.setItem("hb-fin-tab", t);
    } catch {
      /* ignore */
    }
    setNav((prev) => ({
      tab: t,
      dir: TAB_ORDER.indexOf(t) >= TAB_ORDER.indexOf(prev.tab) ? 1 : -1,
    }));
  };
  // Bumped when the floor changes, purely to re-run the view-model memo.
  const [floorV, setFloorV] = useState(0);
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

    const anySheetOpen =
    ledgerOpen || addOpen || importOpen || !!envLine || sprintOpen || accountsOpen ||
    settingsOpen || billsOpen || !!payBillEntry || !!txnId || anomalyOpen || owedOpen;

  // The attack ladder reads the shared payoff projection from buildVMs (vms.deploy).
  const vms = useMemo(
    () => buildFinanceVMs(data, owner, lens, { email: session?.user.email ?? "", lang: getLang() }),
    // `floorV` looks unnecessary to the linter and is not: the floor is read
    // from localStorage inside buildFinanceVMs, which no dependency can see, so
    // this counter is the only thing that tells the memo the input changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, owner, lens, session, floorV],
  );

  // The app checking its own arithmetic. Deliberately NOT lens-filtered: an
  // invariant either holds for the household or it does not, and hiding half the
  // data would make a real disagreement look like a clean bill of health.
  const audit = useMemo(() => selfAudit(data), [data]);

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
      style={{ background: "#0b0e13" }}
    >
      <TopBar title={TITLES[tab]} lens={lens} onLens={onLens} />
      <div
        className="min-h-0 flex-1"
        style={{ overflowY: anySheetOpen ? "hidden" : "auto", overscrollBehaviorY: "contain" }}
      >
        {/* ── Lateral motion ──────────────────────────────────────────────────
            Tabs are SIBLINGS, so the transition has to say "same level,
            different place" — a short travel in the direction you actually
            travelled, plus a fade. A cross-fade would say the screen changed
            without saying where you went; a full-width slide would say one
            screen contains the other.

            Only the arriving screen is animated. Animating the departing one
            too would mean holding both in the tree through the transition, and
            the cost of that here — two live view-models, two scroll positions,
            two sets of sheet state — buys a refinement nobody can name after
            240ms. The direction is what carries the meaning, and the entry
            alone carries the direction.

            `key` is the tab, so React remounts and the animation re-runs. */}
        <div key={tab} className={dir > 0 ? "tab-in-fwd" : "tab-in-back"}>
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
            taps={{
              onRefresh: refresh,
              onRow: (id) => setTxnId(id),
              onAdd: () => setAddOpen(true),
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
              // The floor lives in localStorage, which no React state watches —
              // so the version bump is what makes the new headline appear. Same
              // reason the language switch remounts the tree.
              onFloor: (n) => {
                saveFloor(n);
                setFloorV((v) => v + 1);
              },
              onLens,
              onToggleVariableBill: (id, on) => void setRecurringVariable(id, on),
            }}
          />
        )}
        </div>
      </div>
      <TabNav
        active={tab}
        onTab={(k: NavKey) => (k === "health" ? onMode("health") : setTab(k))}
      />

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
    </div>
  );
}
