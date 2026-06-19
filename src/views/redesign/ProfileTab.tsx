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
  Zap,
  Smartphone,
  LogOut,
  AlertTriangle,
} from "lucide-react";
import { BRAND_GRADIENT } from "../../lib/catColor";

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
  variableBills: { name: string; icon: "electric" | "phone"; est: string; on: boolean }[];
}

interface ProfileTaps {
  onEdit?: () => void;
  onBank?: () => void;
  onCards?: () => void;
  onImport?: () => void;
  onHealth?: () => void;
  onSignOut?: () => void;
  onAdvanced?: () => void;
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

// The small pill toggle (38x22), cyan when on, knob slides right.
function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className="relative inline-block h-[22px] w-[38px] shrink-0 rounded-full transition"
      style={{ background: on ? "#34c5e8" : "#2a3441" }}
    >
      <span
        className="absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? "19px" : "3px" }}
      />
    </span>
  );
}

// A horizontal divider matching the in-group row border.
const ROW_BORDER = "#1d2530";

export function ProfileTab({
  vm,
  taps = {},
}: {
  vm: ProfileVM;
  taps?: ProfileTaps;
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
            Synced · this device is {vm.ownerName}
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
        {/* ── Connections ── */}
        <Group label="Connections">
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
              <div className="text-[14px] font-medium text-bone">Cards as debt</div>
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
              <div className="text-[14px] font-medium text-bone">Import a statement</div>
            </div>
            <ChevronRight size={18} style={{ color: "#6b7686" }} />
          </button>
        </Group>

        {/* ── Accounts ── */}
        <Group label="Accounts">
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
        <Group label="Preferences">
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
            <div className="min-w-0 flex-1 text-[14px] font-medium text-bone">Language</div>
            <Segmented
              options={[
                { key: "en", label: "EN" },
                { key: "zh", label: "中文" },
              ]}
              active={vm.lang}
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
            <div className="min-w-0 flex-1 text-[14px] font-medium text-bone">Default view</div>
            <Segmented
              options={[
                { key: "me", label: "Mine" },
                { key: "all", label: "Household" },
              ]}
              active={vm.lens}
            />
          </div>

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
            <div className="min-w-0 flex-1 text-[14px] font-medium text-bone">Health mode</div>
            <ChevronRight size={18} style={{ color: "#6b7686" }} />
          </button>
        </Group>

        {/* ── Variable bills ── */}
        <Group label="Variable Bills">
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
                <Toggle on={b.on} />
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
          <LogOut size={17} /> Sign out
        </button>

        {/* ── Advanced ── */}
        <button
          onClick={taps.onAdvanced}
          className="flex items-center gap-2.5 px-1 text-[12px] transition active:scale-[0.99]"
          style={{ color: "#6b7686" }}
        >
          <AlertTriangle size={15} />
          <span className="flex-1 text-left">Advanced · re-seed, clear all data</span>
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="h-2" />
    </div>
  );
}

// A small segmented pill control (display-only here — active key is highlighted).
function Segmented<T extends string>({
  options,
  active,
}: {
  options: { key: T; label: string }[];
  active: T;
}) {
  return (
    <span
      className="flex shrink-0 items-center rounded-full p-0.5"
      style={{ background: "#1d2530" }}
    >
      {options.map((o) => {
        const isOn = o.key === active;
        return (
          <span
            key={o.key}
            className="rounded-full px-2.5 py-1 text-[12px] font-medium transition"
            style={
              isOn
                ? { background: "#34c5e8", color: "#0b0f17" }
                : { color: "#8b97a6" }
            }
          >
            {o.label}
          </span>
        );
      })}
    </span>
  );
}

export const MOCK_PROFILE: ProfileVM = {
  ownerName: "Gino",
  ownerColor: "#ef8136",
  email: "ginocirino007@gmail.com",
  bankName: "Bank of America",
  bankSub: "Connected · 2 logins",
  cardsSub: "…4728 + …6813 linked · auto-syncs",
  accounts: [
    { name: "Adv Plus …4662", owner: "Gino", balance: 1306.67, dot: "#5b82b3" },
    { name: "SafeBalance …1211", owner: "Joint", balance: 15.48, dot: "#687180" },
    { name: "SafeBalance …0366", owner: "Xinyan", balance: 1000.0, dot: "#46d18a" },
  ],
  lang: "en",
  lens: "me",
  variableBills: [
    { name: "Electric (SRP)", icon: "electric", est: "~$89.92 · est. from last 3", on: true },
    { name: "Verizon", icon: "phone", est: "~$82.83 · est. from last 3", on: true },
  ],
};
