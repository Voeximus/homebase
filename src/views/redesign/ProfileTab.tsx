import { useEffect, useState } from "react";
import {
  Pencil,
  Landmark,
  CreditCard,
  FileUp,
  CircleCheck,
  ChevronRight,
  ChevronDown,
  Languages,
  Users,
  HeartPulse,
  Bell,
  Zap,
  Smartphone,
  LogOut,
  AlertTriangle,
} from "lucide-react";
import { BRAND_GRADIENT } from "../../lib/catColor";
import { t } from "../../lib/i18n";
import {
  disablePush,
  enablePush,
  getPushStatus,
  syncPushSubscription,
  type PushStatus,
  type PushSyncResult,
} from "../../lib/push";
import type { AuditResult } from "../../lib/selfAudit";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface ProfileVM {
  ownerName: string;
  ownerColor: string;
  email: string;
  bankName: string;
  bankSub: string;
  cardsSub: string;
  accounts: { name: string; owner: string; balance: number; dot: string }[];
  lang: "en" | "zh";
  lens: "me" | "all";
  variableBills: { id: string; name: string; icon: "electric" | "phone"; est: string; on: boolean }[];
}

// ── Does this add up? ─────────────────────────────────────────────────────────
// The screen for src/lib/selfAudit.ts. It exists because a check nobody can read
// is worth nothing — and because the reverse is also true: a red banner over a
// rounding difference teaches you to ignore the next one. So this is silent when
// everything reconciles (one quiet line, no colour, no badge) and specific when it
// does not, naming the gap in dollars rather than saying "something is wrong".
//
// It never pushes a notification. It sits here until you look.
function AuditPanel({ result }: { result: AuditResult }) {
  const [open, setOpen] = useState(false);
  const failing = result.checks.filter((c) => c.status === "fail");

  return (
    <Group label={t("Does this add up?")}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition active:bg-white/5"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: result.clean ? "#16241c" : "#2a1618",
            color: result.clean ? "#46d18a" : "#e8746a",
          }}
        >
          {result.clean ? <CircleCheck size={17} /> : <AlertTriangle size={17} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold" style={{ color: "#e6edf3" }}>
            {result.clean
              ? t("Every number checks out")
              : t("{n} check{s} did not add up", {
                  n: failing.length,
                  s: failing.length > 1 ? "s" : "",
                })}
          </span>
          <span className="block text-[11.5px] leading-snug" style={{ color: result.clean ? "#8b97a6" : "#e8a09a" }}>
            {result.clean
              ? t("{n} of {n} internal checks passed — the app agrees with itself.", {
                  n: result.checks.length,
                })
              : failing[0].detail}
          </span>
        </span>
        {open ? (
          <ChevronDown size={16} style={{ color: "#8b97a6" }} />
        ) : (
          <ChevronRight size={16} style={{ color: "#8b97a6" }} />
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2.5 px-4 pb-4 pt-1">
          {result.checks.map((c) => (
            <div key={c.id} className="flex gap-2.5">
              <span
                className="mt-[3px] h-2 w-2 shrink-0 rounded-full"
                style={{ background: c.status === "ok" ? "#46d18a" : "#e8746a" }}
              />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium" style={{ color: "#c9d4de" }}>
                  {t(c.question)}
                </span>
                <span className="block text-[11.5px] leading-snug" style={{ color: "#8b97a6" }}>
                  {c.detail}
                </span>
              </span>
            </div>
          ))}
          <p className="mt-1 text-[11px] leading-relaxed" style={{ color: "#74838f" }}>
            {t(
              "Each of these compares one of your numbers against the same number worked out a second, separate way. They are exact — anything other than a perfect match is a real mistake, not a rounding difference, which is why there is no 'maybe' here.",
            )}
          </p>
        </div>
      )}
    </Group>
  );
}

interface ProfileTaps {
  onEdit?: () => void;
  onBank?: () => void;
  onCards?: () => void;
  onImport?: () => void;
  onHealth?: () => void;
  onSignOut?: () => void;
  onAdvanced?: () => void;
  onLang?: (l: "en" | "zh") => void;
  onLens?: (l: "me" | "all") => void;
  onToggleVariableBill?: (id: string, on: boolean) => void;
}

// A grouped bento list: a mono eyebrow label above a divided card.
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-2 px-1 text-taupe">{label}</div>
      <div
        className="overflow-hidden rounded-[16px] border"
        style={{ background: "#141a24", borderColor: "#232d3a" }}
      >
        {children}
      </div>
    </div>
  );
}

// The small pill toggle (38x22), cyan when on, knob slides right. A button when
// given onToggle, so it actually flips the underlying preference.
function Toggle({ on, onToggle }: { on: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!onToggle}
      className="relative inline-block h-[22px] w-[38px] shrink-0 rounded-full transition"
      style={{ background: on ? "#34c5e8" : "#2a3441" }}
      aria-pressed={on}
    >
      <span
        className="absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? "19px" : "3px" }}
      />
    </button>
  );
}

// A horizontal divider matching the in-group row border.
const ROW_BORDER = "#1d2530";

// Phone push notifications — self-contained (reads/sets its own state via the
// push lib). Subscribing once covers transaction + health + bill alerts.
function PushRow() {
  const [status, setStatus] = useState<PushStatus>("default");
  // What the SERVER says about this device's row. getPushStatus() only ever asks
  // the browser, and the browser stays cheerfully "subscribed" long after the row
  // that makes a push deliverable is gone — which is how the 44-night outage hid
  // from the one screen built to show it.
  const [row, setRow] = useState<PushSyncResult>("unknown");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    // Repair first, then report. Someone opening this row is usually here BECAUSE
    // notifications stopped, so it's the one screen that must not just re-read a
    // stale "On" back to them. The .catch is not dead code: syncPushSubscription
    // reads localStorage before entering its own try block, and that can throw.
    syncPushSubscription()
      .catch(() => "unknown" as const)
      .then(async (r) => {
        const s = await getPushStatus();
        if (!alive) return; // Profile can be closed mid round-trip
        setRow(r);
        setStatus(s);
      });
    return () => {
      alive = false;
    };
  }, []);
  // Registered means BOTH halves agree. "missing" is only ever set when the server
  // was reached and had no row, so it's safe to contradict the browser here; an
  // offline phone reports "unknown" and keeps its "On".
  const registered = status === "subscribed" && row !== "missing";
  const locked = status === "unsupported" || status === "denied";
  // The two states where the browser is subscribed but the server isn't holding a
  // row. A retry is the only thing that can help, so tapping runs enablePush().
  const broken = status === "save-failed" || (status === "subscribed" && row === "missing");
  const toggle = async () => {
    if (busy || locked) return;
    setBusy(true);
    try {
      if (registered) {
        await disablePush();
        setStatus("default");
        setRow("unknown");
      } else {
        const s = await enablePush();
        setStatus(s);
        // enablePush only reports "subscribed" once its upsert came back clean, so
        // that path is confirmed; anything else leaves the row unverified.
        setRow(s === "subscribed" ? "confirmed" : "unknown");
      }
    } finally {
      setBusy(false);
    }
  };
  const sub =
    status === "unsupported"
      ? t("Add Homebase to your home screen to enable")
      : status === "denied"
        ? t("Blocked — allow notifications in your phone's settings")
        : status === "save-failed"
          ? t("Couldn't save — tap to retry")
          : status !== "subscribed"
            ? t("Off — tap to get alerts on this phone")
            : row === "missing"
              ? t("Not registered on the server — tap to fix")
              : row === "unknown"
                ? t("On · couldn't verify with the server")
                : t("On — transaction & health alerts on this phone");
  return (
    <div className="flex items-center gap-3 border-b p-4" style={{ borderColor: ROW_BORDER }}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: "#34c5e826", color: "#34c5e8" }}>
        <Bell size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-bone">{t("Notifications")}</div>
        {/* Orange, not grey: "not registered" is a fault to act on, not a preference
            that happens to be off. */}
        <div className="text-[11.5px]" style={{ color: broken ? "#f97316" : "#8b97a6" }}>{sub}</div>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || locked}
        className="relative inline-block h-[22px] w-[38px] shrink-0 rounded-full transition"
        style={{ background: registered ? "#34c5e8" : "#2a3441", opacity: locked ? 0.45 : 1 }}
        aria-pressed={registered}
      >
        <span className="absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all" style={{ left: registered ? "19px" : "3px" }} />
      </button>
    </div>
  );
}

export function ProfileTab({
  vm,
  taps = {},
  audit,
}: {
  vm: ProfileVM;
  taps?: ProfileTaps;
  /** Result of src/lib/selfAudit.ts. Optional so the tab still renders without it. */
  audit?: AuditResult;
}) {
  return (
    <div className="flex flex-col gap-0">
      {/* ── Identity hero ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="flex items-center gap-3.5 rounded-b-[24px] px-5 py-5 text-white"
      >
        <div
          className="flex h-[54px] w-[54px] shrink-0 items-center justify-center rounded-full text-[22px] font-bold"
          style={{ background: vm.ownerColor, border: "2px solid rgba(255,255,255,0.5)" }}
        >
          {vm.ownerName.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[20px] font-bold leading-tight">{vm.ownerName}</div>
          <div className="truncate text-[12px] opacity-90">{vm.email}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] opacity-90">
            <span className="h-2 w-2 rounded-full" style={{ background: "#46d18a" }} />
            {t("Synced · this device is {name}", { name: vm.ownerName })}
          </div>
        </div>
        <button
          onClick={taps.onEdit}
          className="shrink-0 rounded-full p-1.5 transition active:scale-90"
          aria-label="Edit profile"
        >
          <Pencil size={18} />
        </button>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {/* Highest first: if the app does not agree with itself, that outranks
            every setting below it. */}
        {audit && <AuditPanel result={audit} />}

        {/* ── Connections ── */}
        <Group label={t("Connections")}>
          <button
            onClick={taps.onBank}
            className="flex w-full items-center gap-3 border-b p-4 text-left transition active:scale-[0.99]"
            style={{ borderColor: ROW_BORDER }}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: "#34c5e826", color: "#34c5e8" }}
            >
              <Landmark size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-bone">{vm.bankName}</div>
              <div className="text-[12px]" style={{ color: "#46d18a" }}>
                {vm.bankSub}
              </div>
            </div>
            <CircleCheck size={18} style={{ color: "#46d18a" }} />
          </button>

          <button
            onClick={taps.onCards}
            className="flex w-full items-center gap-3 border-b p-4 text-left transition active:scale-[0.99]"
            style={{ borderColor: ROW_BORDER }}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: "#f0556e26", color: "#f0556e" }}
            >
              <CreditCard size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-bone">{t("Cards as debt")}</div>
              <div className="text-[12px]" style={{ color: "#8b97a6" }}>
                {vm.cardsSub}
              </div>
            </div>
            <ChevronRight size={18} style={{ color: "#6b7686" }} />
          </button>

          <button
            onClick={taps.onImport}
            className="flex w-full items-center gap-3 p-4 text-left transition active:scale-[0.99]"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: "#a78bfa26", color: "#a78bfa" }}
            >
              <FileUp size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-bone">{t("Import a statement")}</div>
            </div>
            <ChevronRight size={18} style={{ color: "#6b7686" }} />
          </button>
        </Group>

        {/* ── Accounts ── */}
        <Group label={t("Accounts")}>
          {vm.accounts.map((a, i) => (
            <div
              key={a.name + i}
              className="flex items-center gap-3 p-4"
              style={
                i < vm.accounts.length - 1
                  ? { borderBottom: `1px solid ${ROW_BORDER}` }
                  : undefined
              }
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.dot }} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-bone">{a.name}</div>
                <div className="text-[12px]" style={{ color: "#8b97a6" }}>
                  {a.owner}
                </div>
              </div>
              <span className="num text-[14px] font-semibold text-bone">{money2(a.balance)}</span>
            </div>
          ))}
        </Group>

        {/* ── Preferences ── */}
        <Group label={t("Preferences")}>
          <div
            className="flex items-center gap-3 border-b p-4"
            style={{ borderColor: ROW_BORDER }}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: "#22d3ee26", color: "#22d3ee" }}
            >
              <Languages size={17} />
            </span>
            <div className="min-w-0 flex-1 text-[14px] font-medium text-bone">{t("Language")}</div>
            <Segmented
              options={[
                { key: "en", label: "EN" },
                { key: "zh", label: "中文" },
              ]}
              active={vm.lang}
              onSelect={taps.onLang}
            />
          </div>

          <div
            className="flex items-center gap-3 border-b p-4"
            style={{ borderColor: ROW_BORDER }}
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: "#a78bfa26", color: "#a78bfa" }}
            >
              <Users size={17} />
            </span>
            <div className="min-w-0 flex-1 text-[14px] font-medium text-bone">{t("Default view")}</div>
            <Segmented
              options={[
                { key: "me", label: t("Mine") },
                { key: "all", label: t("Household") },
              ]}
              active={vm.lens}
              onSelect={taps.onLens}
            />
          </div>

          <PushRow />

          <button
            onClick={taps.onHealth}
            className="flex w-full items-center gap-3 p-4 text-left transition active:scale-[0.99]"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: "#fb718526", color: "#fb7185" }}
            >
              <HeartPulse size={17} />
            </span>
            <div className="min-w-0 flex-1 text-[14px] font-medium text-bone">{t("Health mode")}</div>
            <ChevronRight size={18} style={{ color: "#6b7686" }} />
          </button>
        </Group>

        {/* ── Variable bills ── */}
        <Group label={t("Variable Bills")}>
          {vm.variableBills.map((b, i) => {
            const Icon = b.icon === "electric" ? Zap : Smartphone;
            return (
              <div
                key={b.name}
                className="flex items-center gap-3 p-4"
                style={
                  i < vm.variableBills.length - 1
                    ? { borderBottom: `1px solid ${ROW_BORDER}` }
                    : undefined
                }
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
                  style={{ background: "#f9731626", color: "#f97316" }}
                >
                  <Icon size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium text-bone">{b.name}</div>
                  <div className="text-[12px]" style={{ color: "#8b97a6" }}>
                    {b.est}
                  </div>
                </div>
                <Toggle
                  on={b.on}
                  onToggle={
                    taps.onToggleVariableBill
                      ? () => taps.onToggleVariableBill!(b.id, !b.on)
                      : undefined
                  }
                />
              </div>
            );
          })}
        </Group>

        {/* ── Sign out ── */}
        <button
          onClick={taps.onSignOut}
          className="flex items-center justify-center gap-2 rounded-[16px] border p-4 text-[14px] font-medium transition active:scale-[0.99]"
          style={{ borderColor: "#232d3a", color: "#8b97a6" }}
        >
          <LogOut size={17} /> {t("Sign out")}
        </button>

        {/* ── Advanced ── */}
        <button
          onClick={taps.onAdvanced}
          className="flex items-center gap-2.5 px-1 text-[12px] transition active:scale-[0.99]"
          style={{ color: "#6b7686" }}
        >
          <AlertTriangle size={15} />
          <span className="flex-1 text-left">{t("Advanced · re-seed, clear all data")}</span>
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="h-2" />
    </div>
  );
}

// A small segmented pill control. Tappable when given onSelect, so it actually
// changes the preference (falls back to display-only highlight otherwise).
function Segmented<T extends string>({
  options,
  active,
  onSelect,
}: {
  options: { key: T; label: string }[];
  active: T;
  onSelect?: (key: T) => void;
}) {
  return (
    <span
      className="flex shrink-0 items-center rounded-full p-0.5"
      style={{ background: "#1d2530" }}
    >
      {options.map((o) => {
        const isOn = o.key === active;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onSelect?.(o.key)}
            disabled={!onSelect}
            className="rounded-full px-2.5 py-1 text-[12px] font-medium transition"
            style={
              isOn
                ? { background: "#34c5e8", color: "#0b0f17" }
                : { color: "#8b97a6" }
            }
          >
            {t(o.label)}
          </button>
        );
      })}
    </span>
  );
}
