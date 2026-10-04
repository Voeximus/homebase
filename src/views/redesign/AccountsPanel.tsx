import { useState } from "react";
import { useStore } from "../../store/FinanceStore";
import { formatMoney } from "../../lib/format";
import { accountFlow, cashAccounts, totalBalance, totalPendingHold } from "../../lib/recurring";
import { t } from "../../lib/i18n";
import { Button, inputClass } from "../../components/ui";
import { ConnectBank, CreditCardLinks } from "../sheets";
import { getTheme, saveTheme, THEME_LABEL, type ThemeChoice } from "../../lib/theme";

// ── The Accounts screen ──────────────────────────────────────────────────────
//
// Three things live here, and only the first is what the tab is named after:
//
//   1. WHAT EACH ACCOUNT HOLDS, and the ability to correct it by hand. The
//      editing logic is carried over unchanged, including the one rule that
//      matters: the editor closes ONLY on a confirmed write. It used to close
//      unconditionally, so a save that never reached the database (offline, RLS,
//      an expired token) still looked like it worked, and every derived number
//      then ran off a balance the bank had never seen.
//   2. CONNECTING A BANK. This lived in a Settings sheet that no longer exists.
//      Plaid connections expire and come back needing re-authorisation, and with
//      no link button anywhere the feed would stop with no way in the app to
//      start it again — every number on all three screens comes off that feed.
//   3. THE THEME. Light, dark, or follow the phone, by his decision on
//      2026-10-04. It is here rather than in a settings screen because there is
//      no settings screen, and this is the tab that already holds the things
//      that are about the app rather than about the money.

const THEMES: ThemeChoice[] = ["system", "light", "dark"];

/** Apple's own segmented control: one track, the live segment lifted out of it. */
function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getTheme());
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
  };
  return (
    <div
      className="flex gap-1 rounded-[10px] p-1"
      style={{ background: "var(--color-recessed)" }}
      role="group"
      aria-label={t("Appearance")}
    >
      {THEMES.map((k) => {
        const on = k === choice;
        return (
          <button
            key={k}
            onClick={() => pick(k)}
            aria-pressed={on}
            className={`min-h-[34px] flex-1 rounded-[7px] text-[14px] transition ${
              on ? "font-semibold text-bone" : "text-taupe"
            }`}
            style={on ? { background: "var(--color-tile)" } : undefined}
          >
            {t(THEME_LABEL[k])}
          </button>
        );
      })}
    </div>
  );
}

export function AccountsPanel() {
  const { data, setAccountBalance } = useStore();
  const [edit, setEdit] = useState<string | null>(null);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState(false);
  // Set when the write came back unconfirmed — the typed figure is still only on
  // this phone, so the editor has to stay open and say so.
  const [failed, setFailed] = useState(false);

  const accounts = cashAccounts(data.accounts);
  const available = totalBalance(data.accounts);
  const processing = totalPendingHold(data.accounts);

  return (
    <div className="pb-2">
      <header className="px-5 pt-1">
        <p className="text-[15px] text-taupe">{t("Across every account")}</p>
        <h1 className="mt-0.5 text-[34px] font-bold leading-tight tracking-[-0.022em] text-bone">
          {t("Accounts")}
        </h1>
      </header>

      <div className="mt-5 px-5">
        <p className="text-[15px] text-taupe">{t("Available")}</p>
        <p className="mt-0.5 text-[52px] font-light leading-[1.06] tracking-[-0.04em] tabular-nums text-bone">
          {formatMoney(available)}
        </p>
        {processing > 0 && (
          // Said out loud because the bank has ALREADY taken it out of the figure
          // above. A reader who thinks it is still to come subtracts it twice —
          // the same double-count that put the joint account $100 further behind
          // than it was.
          <p className="mt-1 text-[14px] text-faint">
            {t("{amount} still processing, already taken out", {
              amount: formatMoney(processing),
            })}
          </p>
        )}
      </div>

      <section className="mt-6">
        <h2 className="mb-2 pl-5 text-[13px] font-semibold text-taupe">{t("Cash")}</h2>
        <div className="overflow-hidden rounded-2xl bg-tile">
          {accounts.map((a, i) => {
            const f = accountFlow(a.id, data.recurring);
            const editing = edit === a.id;
            const last = i === accounts.length - 1;
            return (
              <div
                key={a.id}
                style={last ? undefined : { boxShadow: "inset 0 -1px 0 var(--color-edge)" }}
              >
                <button
                  onClick={() => {
                    setEdit(a.id);
                    setVal(a.balance.toFixed(2));
                    setFailed(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[16px] text-bone">
                      {a.owner} <span className="text-faint">····{a.last4}</span>
                    </span>
                    <span className="text-[13px] text-taupe">
                      {t("{amount}/mo", { amount: formatMoney(f.net, { sign: true }) })}
                    </span>
                  </span>
                  <span className="text-[16px] tabular-nums text-bone">
                    {formatMoney(a.balance)}
                  </span>
                </button>

                {editing && (
                  <div className="px-4 pb-3">
                    <div className="flex gap-2">
                      <input
                        className={inputClass}
                        type="number"
                        inputMode="decimal"
                        autoFocus
                        aria-label={t("Balance")}
                        value={val}
                        onChange={(e) => setVal(e.target.value)}
                      />
                      <Button
                        onClick={async () => {
                          setSaving(true);
                          setFailed(false);
                          const ok = await setAccountBalance(
                            a.id,
                            Math.round(parseFloat(val) * 100) / 100,
                          );
                          setSaving(false);
                          if (ok) setEdit(null);
                          else setFailed(true);
                        }}
                        disabled={saving || val === "" || isNaN(parseFloat(val))}
                      >
                        {saving ? t("Setting…") : t("Set")}
                      </Button>
                    </div>
                    {failed && (
                      <p className="mt-2 rounded-lg bg-ember/10 px-3 py-2 text-[13px] text-ember">
                        {t("Couldn't save that balance — it's still only on this phone. Check your connection and tap Set again.")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 px-5 text-[13px] text-faint">
          {t("Set each account to the real balance from your bank — every event moves it from there.")}
        </p>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 pl-5 text-[13px] font-semibold text-taupe">{t("Appearance")}</h2>
        <div className="mx-4 rounded-2xl bg-tile p-3">
          <ThemePicker />
        </div>
      </section>

      <section className="mt-6 space-y-3 px-4">
        <ConnectBank />
        <CreditCardLinks />
      </section>
    </div>
  );
}
