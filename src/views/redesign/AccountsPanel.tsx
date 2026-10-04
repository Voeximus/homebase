import { useState } from "react";
import { Landmark } from "lucide-react";
import { useStore } from "../../store/FinanceStore";
import { formatMoney } from "../../lib/format";
import { accountFlow, cashAccounts, totalBalance, totalPendingHold } from "../../lib/recurring";
import { t } from "../../lib/i18n";
import { Button, inputClass } from "../../components/ui";
import { ConnectBank, CreditCardLinks } from "../sheets";
import { getTheme, saveTheme, THEME_LABEL, type ThemeChoice } from "../../lib/theme";
import { Card, Chip, Figure, Hero, ROW_SEP, SectionTitle, Wells } from "./kit";

const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const split = (n: number): [string, string] => {
  const s = formatMoney(n);
  const i = s.lastIndexOf(".");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i)];
};

// ── The Accounts screen ──────────────────────────────────────────────────────
//
// Three things live here, and only the first is what the tab is named after:
//
//   1. WHAT EACH ACCOUNT HOLDS, and the ability to correct it by hand. Carried
//      over unchanged, including the rule that matters: the editor closes ONLY on
//      a confirmed write. It used to close unconditionally, so a save that never
//      reached the database still looked like it worked, and every derived number
//      then ran off a balance the bank had never seen.
//   2. CONNECTING A BANK. This lived in a Settings sheet that no longer exists.
//      Plaid connections expire and come back needing re-authorisation; with no
//      link button anywhere, the feed would stop with no way to restart it, and
//      every number on all three screens comes off that feed.
//   3. THE THEME, because there is no settings screen to put it in and this is
//      the tab that already holds the things that are about the app.

const THEMES: ThemeChoice[] = ["system", "light", "dark"];

/** The reference's segmented pill: one well, the live segment filled with ink. */
function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getTheme());
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
  };
  return (
    <div
      className="flex gap-1.5 rounded-full p-1"
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
            className={`min-h-[34px] flex-1 rounded-full text-[13.5px] transition ${
              on ? "font-semibold" : "font-medium text-taupe"
            }`}
            style={on ? { background: "var(--color-hero)", color: "var(--color-heroink)" } : undefined}
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
  const [whole, cents] = split(available);

  // The three wells are the three accounts. The smallest is limed, because the
  // one that is about to be short is the only thing on this screen worth a colour.
  const smallest = accounts.reduce<string | null>(
    (lo, a) => (lo === null ? a.id : (accounts.find((x) => x.id === lo)?.balance ?? 0) <= a.balance ? lo : a.id),
    null,
  );

  return (
    <div className="pb-2">
      <header className="px-5 pt-1">
        <p className="text-[13px] text-taupe">{t("One household, three accounts")}</p>
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-bone">
          {t("Accounts")}
        </h1>
      </header>

      <div className="mt-3.5">
        <Hero>
          <span className="text-[13px]" style={{ opacity: 0.66 }}>
            {t("Available")}
          </span>
          <Figure whole={whole} cents={cents} />
          {processing > 0 && (
            // Said out loud because the bank has ALREADY taken it out of the
            // figure above. A reader who thinks it is still to come subtracts it
            // twice — the same double-count that put the joint account $100
            // further behind than it was.
            <p className="mt-1.5 text-[12.5px]" style={{ opacity: 0.62 }}>
              {t("{amount} still processing, already taken out", {
                amount: formatMoney(processing),
              })}
            </p>
          )}
          <Wells
            items={accounts.slice(0, 3).map((a) => ({
              k: a.owner,
              v: money0(a.balance),
              lime: a.id === smallest,
            }))}
          />
        </Hero>
      </div>

      <SectionTitle>{t("Cash")}</SectionTitle>
      <Card className="mt-[9px]">
        {accounts.map((a, i) => {
          const f = accountFlow(a.id, data.recurring);
          const editing = edit === a.id;
          const last = i === accounts.length - 1;
          return (
            <div key={a.id} style={last ? undefined : ROW_SEP}>
              <button
                onClick={() => {
                  setEdit(a.id);
                  setVal(a.balance.toFixed(2));
                  setFailed(false);
                }}
                className="flex w-full items-center gap-[11px] px-[14px] py-3 text-left"
              >
                <Chip name={a.owner} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] font-medium text-bone">
                    {a.owner} <span className="font-normal text-taupe">····{a.last4}</span>
                  </span>
                  <span className="mt-px text-[12.5px] text-taupe">
                    {t("{amount}/mo", { amount: formatMoney(f.net, { sign: true }) })}
                  </span>
                </span>
                <span className="text-[15px] font-semibold tabular-nums text-bone">
                  {formatMoney(a.balance)}
                </span>
              </button>

              {editing && (
                <div className="px-[14px] pb-3">
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
                    <p className="mt-2 rounded-lg bg-ember/10 px-3 py-2 text-[12.5px] text-ember">
                      {t("Couldn't save that balance — it's still only on this phone. Check your connection and tap Set again.")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>
      <p className="mt-2 px-5 text-[12.5px] text-taupe">
        {t("Set each account to the real balance from your bank — every event moves it from there.")}
      </p>

      <SectionTitle>{t("Appearance")}</SectionTitle>
      <Card className="mt-[9px]">
        <div className="p-2.5">
          <ThemePicker />
        </div>
      </Card>

      {/* The lime's one job on this ground: a fill with ink on it. */}
      <div className="mt-3 px-4">
        <ConnectBank
          render={(start, busy) => (
            <button
              onClick={start}
              disabled={busy}
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[16px] text-[15px] font-bold disabled:opacity-60"
              style={{ background: "var(--color-lime)", color: "#111111" }}
            >
              <Landmark size={17} /> {busy ? t("Connecting…") : t("Connect a bank")}
            </button>
          )}
        />
      </div>

      <div className="mt-3 px-4">
        <CreditCardLinks />
      </div>
    </div>
  );
}
