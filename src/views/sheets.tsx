// Shared finance sheets — the bottom-sheets the bento FinanceTabs reuses
// (cash/accounts, the snowball sprint, the "send/record" slip, the bill payer,
// and settings incl. bank/card connections). Extracted from the retired
// graphite OnePager; these are LIVE in the default UI.
import { useEffect, useState, type ReactNode } from "react";
import { Check, CreditCard, FileUp, Landmark } from "lucide-react";
import type { Account, Debt } from "../types";
import { useStore } from "../store/FinanceStore";
import { useAuth } from "../auth/AuthProvider";
import { formatMoney } from "../lib/format";
import { accountFlow, cashAccounts } from "../lib/recurring";
import { payoffSchedule } from "../lib/plan";
import { type ScheduleEntry } from "../lib/schedule";
import { t } from "../lib/i18n";
import { Button, inputClass, labelClass, ProgressBar, Sheet } from "../components/ui";
import { usePlaidLink } from "react-plaid-link";
import { createLinkToken, exchangePublicToken } from "../lib/plaidClient";

// ── small helpers ────────────────────────────────────────────────────────────
function shortDebt(name: string): string {
  const m = /…(\d{4})/.exec(name) || /(\d{4})/.exec(name);
  if (m) return "…" + m[1];
  return name.replace(/^Affirm — /, "").replace(/ \(China\)/, "");
}
function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Eyebrow({
  children,
  color = "text-taupe",
}: {
  children: ReactNode;
  color?: string;
}) {
  return <p className={`eyebrow ${color}`}>{children}</p>;
}

export function AccountsSheet({
  open,
  onClose,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  accounts?: Account[]; // lens-filtered list; falls back to the full household set
}) {
  const { data, setAccountBalance } = useStore();
  const [edit, setEdit] = useState<Account | null>(null);
  const [val, setVal] = useState("");
  return (
    <Sheet open={open} onClose={onClose} title={t("Cash & accounts")}>
      <div className="space-y-2">
        {cashAccounts(accounts ?? data.accounts).map((a) => {
          const f = accountFlow(a.id, data.recurring);
          const editing = edit?.id === a.id;
          return (
            <div key={a.id} className="rounded-xl bg-raised p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-bone">
                    {a.name}{" "}
                    <span className="text-faint">····{a.last4}</span>
                  </p>
                  <p className="text-[11px] text-faint">
                    {a.owner} · {t("{amount}/mo", { amount: formatMoney(f.net, { sign: true }) })}
                  </p>
                </div>
                {editing ? (
                  <span className="text-sm text-faint">{t("editing…")}</span>
                ) : (
                  <button
                    onClick={() => {
                      setEdit(a);
                      setVal(a.balance.toFixed(2));
                    }}
                    className="text-right"
                  >
                    <span className="font-semibold text-bone">
                      {formatMoney(a.balance)}
                    </span>
                    <span className="block text-[10px] text-accent">{t("tap to set")}</span>
                  </button>
                )}
              </div>
              {editing && (
                <div className="mt-3 flex gap-2">
                  <input
                    className={inputClass}
                    type="number"
                    inputMode="decimal"
                    autoFocus
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                  />
                  <Button
                    onClick={async () => {
                      await setAccountBalance(
                        a.id,
                        Math.round(parseFloat(val) * 100) / 100,
                      );
                      setEdit(null);
                    }}
                    disabled={val === "" || isNaN(parseFloat(val))}
                  >
                    {t("Set")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        <p className="px-1 text-[11px] text-faint">
          {t("Set each account to the real balance from your bank — every event moves it from there.")}
        </p>
      </div>
    </Sheet>
  );
}

export function SprintSheet({
  open,
  onClose,
  ordered,
  schedule,
  totalDebt,
}: {
  open: boolean;
  onClose: () => void;
  ordered: Debt[];
  schedule: ReturnType<typeof payoffSchedule>;
  totalDebt: number;
}) {
  const { payDebtExtra, data } = useStore();
  const [payFor, setPayFor] = useState<Debt | null>(null);
  const clearDateOf = (id: string) => {
    const ev = schedule.find((e) => e.payments.some((p) => p.debtId === id && p.clears));
    return ev ? ev.date : null;
  };
  return (
    <>
      <Sheet open={open} onClose={onClose} title={t("The attack ladder")}>
        <div className="space-y-2.5">
          <p className="text-xs text-taupe">{t("Snowball order · smallest first")}</p>
          {ordered.map((d, i) => {
            const done = d.balance <= 0.005;
            const isTarget = !done && ordered.slice(0, i).every((x) => x.balance <= 0.005);
            const cd = clearDateOf(d.id);
            const pct = d.originalBalance > 0 ? ((d.originalBalance - d.balance) / d.originalBalance) * 100 : 0;
            return (
              <div
                key={d.id}
                className={`rounded-xl border p-3 ${
                  isTarget ? "border-accent/50 bg-accent/10" : "border-edge bg-raised"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      done ? "bg-mint text-bg" : "bg-tile text-taupe"
                    }`}
                  >
                    {done ? <Check size={13} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-bone">{d.name}</span>
                      {d.apr != null && d.apr > 20 && (
                        <span className="rounded-full bg-ember/15 px-1.5 text-[10px] font-medium text-ember">
                          {d.apr}%
                        </span>
                      )}
                      {d.providerAccountId && (
                        <span className="flex items-center gap-0.5 rounded-full bg-accent/15 px-1.5 text-[10px] font-medium text-accent">
                          <CreditCard size={9} /> {t("live")}
                        </span>
                      )}
                    </div>
                    {cd && !done && (
                      <p className="text-[11px] text-faint">{t("clears ~{date}", { date: fmtDay(cd) })}</p>
                    )}
                  </div>
                  <span className={`text-sm font-bold ${done ? "text-mint" : "text-bone"}`}>
                    {done ? t("Cleared") : formatMoney(d.balance)}
                  </span>
                </div>
                {!done && (
                  <div className="mt-2">
                    {pct > 0 && <ProgressBar value={pct} color={d.color} />}
                    <button
                      onClick={() => setPayFor(d)}
                      className={`w-full rounded-lg bg-accent/15 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25 ${pct > 0 ? "mt-2" : ""}`}
                    >
                      {t("Make a payment")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
            <span className="text-sm text-taupe">{t("Total to clear")}</span>
            <span className="font-bold text-bone">{formatMoney(totalDebt)}</span>
          </div>
        </div>
      </Sheet>
      <PaymentSheet
        debt={payFor}
        accounts={data.accounts}
        onClose={() => setPayFor(null)}
        onPay={payDebtExtra}
      />
    </>
  );
}

function PaymentSheet({
  debt,
  accounts,
  onClose,
  onPay,
}: {
  debt: Debt | null;
  accounts: Account[];
  onClose: () => void;
  onPay: (id: string, amount: number, fromAccountId?: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const amt = parseFloat(amount);
  const valid = amt > 0 && !!accountId;
  useEffect(() => {
    if (debt) setAccountId((p) => p || accounts[0]?.id || "");
  }, [debt, accounts]);
  return (
    <Sheet
      open={!!debt}
      onClose={() => {
        setAmount("");
        onClose();
      }}
      title={debt ? t("Pay {name}", { name: debt.name }) : t("Payment")}
    >
      {debt && (
        <div className="space-y-4">
          <p className="text-sm text-taupe">
            {t("Balance:")} <span className="font-semibold text-bone">{formatMoney(debt.balance)}</span>
          </p>
          <div>
            <label className={labelClass}>{t("Payment amount")}</label>
            <input
              className={inputClass}
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          {accounts.length > 0 && (
            <div>
              <label className={labelClass}>{t("From account")}</label>
              <select
                className={inputClass}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} className="bg-tile">
                    {a.name} ····{a.last4}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button
            onClick={async () => {
              if (!debt || !valid) return;
              await onPay(debt.id, amt, accountId);
              setAmount("");
              onClose();
            }}
            disabled={!valid}
            className="w-full"
          >
            {t("Apply payment")}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

export function MarkSentSheet({
  open,
  onClose,
  next,
  accounts,
  onPay,
  autoTracked,
}: {
  open: boolean;
  onClose: () => void;
  next: ReturnType<typeof payoffSchedule>[number] | null;
  accounts: Account[];
  onPay: (id: string, amount: number, fromAccountId?: string) => Promise<void>;
  autoTracked?: boolean; // these debts update from the bank feed → reminder, not a manual record
}) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (open) {
      setAccountId((p) => p || accounts[0]?.id || "");
      setDone(false);
    }
  }, [open, accounts]);
  if (!next) return null;
  // When every debt in the slice auto-updates from the bank feed, this is a
  // SEND REMINDER, not a manual recording — sending the money in your bank is
  // all that's needed; the feed drops each balance and the plan on its own.
  if (autoTracked) {
    return (
      <Sheet open={open} onClose={onClose} title={t("Send this payment")}>
        <div className="space-y-4">
          <p className="text-sm text-taupe">
            {t("Send {amount} at your debt. Once it posts, your balance and the payoff plan update automatically — nothing to mark here.", { amount: formatMoney(next.payments.reduce((s, p) => s + p.amount, 0)) })}
          </p>
          <div className="space-y-1.5">
            {next.payments.map((p, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-raised px-3 py-2 text-sm">
                <span className="text-bone">{shortDebt(p.name)}</span>
                <span className="font-semibold text-bone">{formatMoney(p.amount)}</span>
              </div>
            ))}
          </div>
          {next.toSavings > 0 && (
            <p className="rounded-lg bg-mint/10 px-3 py-2 text-[11px] text-mint">
              {t("Plus {amount} to {target} — move that yourself in your bank.", {
                amount: formatMoney(next.toSavings),
                target: next.savingsKind === "emergency" ? t("your emergency fund") : t("investing"),
              })}
            </p>
          )}
          <Button className="w-full" onClick={onClose}>
            {t("Got it")}
          </Button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet open={open} onClose={onClose} title={t("Record this payment")}>
      {done ? (
        <div className="flex flex-col items-center py-6 text-center">
          <span className="pop flex h-16 w-16 items-center justify-center rounded-full bg-mint text-bg">
            <Check size={32} />
          </span>
          <p className="mt-4 text-lg font-semibold text-bone">{t("Sent!")}</p>
          <p className="mt-1 text-sm text-taupe">
            {t("Cash, debt and the sprint all moved.")}
          </p>
          <Button className="mt-5 w-full" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-taupe">
            {t("Recording {amount} across these debts. This moves the cash and drops each balance.", { amount: formatMoney(next.payments.reduce((s, p) => s + p.amount, 0)) })}
          </p>
          <div className="space-y-1.5">
            {next.payments.map((p, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-raised px-3 py-2 text-sm">
                <span className="text-bone">{shortDebt(p.name)}</span>
                <span className="font-semibold text-bone">{formatMoney(p.amount)}</span>
              </div>
            ))}
          </div>
          {next.toSavings > 0 && (
            <p className="rounded-lg bg-mint/10 px-3 py-2 text-[11px] text-mint">
              {t("Plus {amount} to {target} — move that yourself in your bank.", {
                amount: formatMoney(next.toSavings),
                target: next.savingsKind === "emergency" ? t("your emergency fund") : t("investing"),
              })}
            </p>
          )}
          <div>
            <label className={labelClass}>{t("From account")}</label>
            <select
              className={inputClass}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id} className="bg-tile">
                  {a.name} ····{a.last4}
                </option>
              ))}
            </select>
          </div>
          <Button
            className="w-full"
            disabled={!accountId || busy}
            onClick={async () => {
              setBusy(true);
              for (const p of next.payments) {
                await onPay(p.debtId, p.amount, accountId);
              }
              setBusy(false);
              setDone(true);
            }}
          >
            {busy ? t("Recording…") : t("Confirm — record payment")}
          </Button>
          <p className="text-[11px] text-faint">
            {t("Only do this once you've actually sent it. Deleting the entries later fully reverses everything.")}
          </p>
        </div>
      )}
    </Sheet>
  );
}

export function PayBillSheet({
  entry,
  monthKey,
  accounts,
  defaultAccountId,
  variable,
  feedOwned,
  onClose,
  onPay,
  onMarkPaid,
  onSetVariable,
}: {
  entry: ScheduleEntry | null;
  monthKey: string;
  accounts: Account[];
  defaultAccountId?: string;
  variable: boolean;
  feedOwned?: boolean; // a card-payment bill on a bank-linked debt → the feed moves the money; never call onPay (it no-ops)
  onClose: () => void;
  onPay: (
    recurringId: string,
    monthKey: string,
    amount: number,
    day?: number,
    fromAccountId?: string,
  ) => Promise<void>;
  onMarkPaid: (
    recurringId: string,
    monthKey: string,
    amount: number,
    day?: number,
  ) => Promise<void>;
  onSetVariable: (id: string, variable: boolean) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  // Local mirror of the variable flag so the toggle feels instant.
  const [isVar, setIsVar] = useState(variable);
  // The amount to actually pay/record. For a variable bill it's editable
  // (prefilled with the rolling-average estimate); for a fixed bill it's locked.
  const [amountStr, setAmountStr] = useState("");
  useEffect(() => {
    if (entry) {
      setAccountId(defaultAccountId || accounts[0]?.id || "");
      setIsVar(variable);
      setAmountStr(entry.amount.toFixed(2));
    }
  }, [entry, defaultAccountId, accounts, variable]);

  const amount = isVar ? parseFloat(amountStr) || 0 : entry?.amount ?? 0;
  const amountValid = amount > 0;

  return (
    <Sheet open={!!entry} onClose={onClose} title={entry ? t("Pay {name}", { name: entry.label }) : t("Pay bill")}>
      {entry && (
        <div className="space-y-4">
          {/* Amount — editable when the bill varies month to month */}
          {isVar ? (
            <div>
              <label className={labelClass}>{t("Amount this month")}</label>
              <div className="flex items-center rounded-xl bg-raised px-4 py-3">
                <span className="text-lg font-bold text-taupe">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  className="num w-full bg-transparent pl-1 text-lg font-bold text-bone outline-none"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                />
              </div>
              <p className="mt-1 text-[11px] text-faint">
                {t("Estimated ~{amount} from recent bills — enter the real amount.", {
                  amount: formatMoney(entry.amount),
                })}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-xl bg-raised px-4 py-3">
              <span className="text-sm text-taupe">{t("Amount")}</span>
              <span className="text-lg font-bold text-bone">{formatMoney(entry.amount)}</span>
            </div>
          )}

          {/* Does this bill vary? — flips it into rolling-average projection */}
          {entry.recurringId && (
            <button
              type="button"
              onClick={async () => {
                const next = !isVar;
                setIsVar(next);
                if (next) setAmountStr(entry.amount.toFixed(2));
                if (entry.recurringId) await onSetVariable(entry.recurringId, next);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-raised px-4 py-3 text-left"
            >
              <span className="min-w-0">
                <span className="block text-sm text-bone">
                  {t("Amount varies month to month")}
                </span>
                <span className="block text-[11px] text-faint">
                  {t("Project it from the average of recent payments.")}
                </span>
              </span>
              <span
                className={`relative h-6 w-10 shrink-0 rounded-full transition ${isVar ? "bg-accent" : "bg-edge"}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-bone transition-all ${isVar ? "left-[18px]" : "left-0.5"}`}
                />
              </span>
            </button>
          )}

          {feedOwned ? (
            <>
              <p className="rounded-lg bg-mint/10 px-3 py-2 text-[11px] text-mint">
                {t("The bank records this payment automatically once it posts — your balance and the plan update on their own. This just flips the calendar.")}
              </p>
              <Button
                className="w-full"
                disabled={busy || !amountValid}
                onClick={async () => {
                  if (!entry.recurringId || !amountValid) return;
                  setBusy(true);
                  await onMarkPaid(entry.recurringId, monthKey, amount, entry.day);
                  setBusy(false);
                  onClose();
                }}
              >
                {busy ? t("Working…") : t("Mark it paid")}
              </Button>
            </>
          ) : (
            <>
              <div>
                <label className={labelClass}>{t("From account")}</label>
                <select
                  className={inputClass}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} className="bg-tile">
                      {a.name} ····{a.last4}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                className="w-full"
                disabled={!accountId || !amountValid || busy}
                onClick={async () => {
                  if (!entry.recurringId || !accountId || !amountValid) return;
                  setBusy(true);
                  await onPay(entry.recurringId, monthKey, amount, entry.day, accountId);
                  setBusy(false);
                  onClose();
                }}
              >
                {busy ? t("Working…") : t("Pay now — move the cash")}
              </Button>
              <button
                onClick={async () => {
                  if (!entry.recurringId || !amountValid) return;
                  setBusy(true);
                  await onMarkPaid(entry.recurringId, monthKey, amount, entry.day);
                  setBusy(false);
                  onClose();
                }}
                disabled={busy || !amountValid}
                className="w-full rounded-xl bg-raised py-3 text-sm font-semibold text-bone transition hover:brightness-110 disabled:opacity-40"
              >
                {t("Already paid — just mark it")}
              </button>
              <p className="text-[11px] text-faint">
                {t("\"Pay now\" moves the cash (and drops the card for a card minimum). \"Already paid\" just marks it — for a bill already in your balance.")}
              </p>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function ConnectBank() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSuccess = async (public_token: string, metadata: any) => {
    setBusy(true);
    setStatus(t("Linking your accounts…"));
    const { data, error } = await exchangePublicToken(public_token, metadata?.institution?.name);
    setBusy(false);
    setLinkToken(null);
    if (error) { setStatus("⚠️ " + error.message); return; }
    setStatus(t("Linked {n} accounts — transactions are syncing.", { n: data?.accounts ?? 0 }));
  };

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const start = async () => {
    setBusy(true);
    setStatus(null);
    const { token, error } = await createLinkToken();
    setBusy(false);
    if (error || !token) { setStatus("⚠️ " + (error ?? "no link token")); return; }
    setLinkToken(token);
  };

  return (
    <div className="space-y-2">
      <Button variant="soft" className="w-full" disabled={busy} onClick={start}>
        <Landmark size={16} /> {busy ? t("Connecting…") : t("Connect a bank")}
      </Button>
      {status && <p className="rounded-lg bg-raised px-3 py-2 text-sm text-taupe">{status}</p>}
    </div>
  );
}

// Connected credit cards, each shown as a debt you can track. Linking a card to
// a debt means the bank feed keeps that debt's balance current automatically.
function CreditCardLinks() {
  const { data, linkDebtToCard, unlinkDebtCard, createDebtFromCard } = useStore();
  const cards = data.accounts.filter(
    (a) => /credit/i.test(a.type) && a.providerAccountId,
  );
  if (cards.length === 0) return null;
  return (
    <div className="rounded-xl border border-edge bg-tile p-3">
      <div className="flex items-center gap-1.5">
        <CreditCard size={14} className="text-taupe" />
        <Eyebrow>{t("Cards as debt")}</Eyebrow>
      </div>
      <div className="mt-2.5 space-y-2">
        {cards.map((c) => (
          <CreditCardRow
            key={c.id}
            card={c}
            linkedDebt={data.debts.find(
              (d) => d.providerAccountId === c.providerAccountId,
            )}
            unlinkedDebts={data.debts.filter((d) => !d.providerAccountId)}
            onLink={linkDebtToCard}
            onUnlink={unlinkDebtCard}
            onCreate={createDebtFromCard}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-faint">
        {t("A linked card updates its debt automatically on every bank sync.")}
      </p>
    </div>
  );
}

function CreditCardRow({
  card,
  linkedDebt,
  unlinkedDebts,
  onLink,
  onUnlink,
  onCreate,
}: {
  card: Account;
  linkedDebt?: Debt;
  unlinkedDebts: Debt[];
  onLink: (debtId: string, accountId: string) => Promise<void>;
  onUnlink: (debtId: string) => Promise<void>;
  onCreate: (accountId: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState("__new__");
  const [busy, setBusy] = useState(false);
  const label = `${card.name}${card.last4 ? ` ····${card.last4}` : ""}`;
  return (
    <div className="rounded-lg bg-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-bone">{label}</span>
        <span className="num shrink-0 text-sm font-semibold text-ember">
          {formatMoney(Math.max(0, card.balance))}
        </span>
      </div>
      {linkedDebt ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 text-[12px] text-mint">
            <Check size={12} className="shrink-0" />
            <span className="truncate">
              {t("Tracked as {name} · auto-syncs", { name: linkedDebt.name })}
            </span>
          </span>
          <button
            onClick={async () => {
              setBusy(true);
              await onUnlink(linkedDebt.id);
              setBusy(false);
            }}
            disabled={busy}
            className="shrink-0 text-[12px] text-faint underline-offset-2 hover:underline disabled:opacity-40"
          >
            {t("Unlink")}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <select
            className={`${inputClass} flex-1`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="__new__" className="bg-tile">
              {t("Track as a new debt")}
            </option>
            {unlinkedDebts.map((d) => (
              <option key={d.id} value={d.id} className="bg-tile">
                {t("Link to {name}", { name: d.name })}
              </option>
            ))}
          </select>
          <button
            onClick={async () => {
              setBusy(true);
              if (choice === "__new__") await onCreate(card.id);
              else await onLink(choice, card.id);
              setBusy(false);
            }}
            disabled={busy}
            className="shrink-0 rounded-lg bg-accent/15 px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-40"
          >
            {busy ? t("…") : t("Track")}
          </button>
        </div>
      )}
    </div>
  );
}

// Settings sheet — bank/card connections, import, household setup, reset.
// Reused by the bento FinanceTabs (Profile → settings).
export function SettingsSheet({
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
    <Sheet open={open} onClose={onClose} title={t("Settings")}>
      <div className="space-y-3">
        <div className="rounded-xl bg-mint/10 p-3 text-sm">
          <p className="font-semibold text-mint">☁️ {t("Cloud sync is on")}</p>
          <p className="mt-0.5 text-mint/70">
            {t("Signed in as {email}. Changes sync live to every device you're both signed in on.", { email: session?.user.email ?? "" })}
          </p>
        </div>
        <ConnectBank />
        <CreditCardLinks />
        <Button variant="soft" className="w-full" onClick={onImport}>
          <FileUp size={16} /> {t("Import bank statement")}
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
          {busy ? t("Setting up…") : t("Set up my household")}
        </Button>
        {status && (
          <p className="rounded-lg bg-raised px-3 py-2 text-sm text-taupe">{status}</p>
        )}
        <Button
          variant="danger"
          className="w-full"
          onClick={async () => {
            if (
              window.confirm(
                t("Delete ALL accounts, recurring, transactions, debts and goals? This can't be undone."),
              )
            ) {
              await resetAll();
              onClose();
            }
          }}
        >
          {t("Clear all data")}
        </Button>
      </div>
    </Sheet>
  );
}
