import { X } from "lucide-react";
import type { ReactNode } from "react";

// Shared dark-theme primitives so every screen matches the dashboard.

export const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-3 text-white placeholder:text-slate-500 outline-none transition focus:border-violet-500 focus:bg-white/10 focus:ring-2 focus:ring-violet-500/25";

export const labelClass = "mb-1.5 block text-sm font-medium text-slate-300";

export function Card({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur ${
        onClick ? "cursor-pointer transition active:scale-[0.99]" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "soft" | "ghost" | "danger";
  className?: string;
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100";
  const variants = {
    primary: "bg-violet-600 text-white shadow-sm hover:bg-violet-500",
    soft: "bg-violet-500/15 text-violet-300 hover:bg-violet-500/25",
    ghost: "bg-white/5 text-slate-200 hover:bg-white/10",
    danger: "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function ProgressBar({
  value,
  color = "#2dd4bf",
  track = "rgba(255,255,255,0.08)",
}: {
  value: number;
  color?: string;
  track?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2.5 w-full overflow-hidden rounded-full"
      style={{ backgroundColor: track }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      className="grid gap-1 rounded-xl bg-white/5 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            value === o.value
              ? "bg-white/15 text-white shadow-sm"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Bottom sheet on phones, centered modal on desktop. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="safe-bottom relative z-10 max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-white/10 bg-[#0d0f17] p-5 shadow-2xl sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-white/15 sm:hidden" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-white/10"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-slate-500">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-slate-200">{title}</h3>
      {children && (
        <div className="mt-1 text-sm text-slate-400">{children}</div>
      )}
    </div>
  );
}

export const SWATCHES = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#0ea5e9",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
];

export function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-8 w-8 rounded-full transition ${
            value === c ? "ring-2 ring-white ring-offset-2 ring-offset-[#0d0f17]" : ""
          }`}
          style={{ backgroundColor: c }}
          aria-label={`Color ${c}`}
        />
      ))}
    </div>
  );
}

export const GOAL_EMOJIS = [
  "🛟",
  "💰",
  "🏖️",
  "✈️",
  "💻",
  "🚗",
  "🏡",
  "💍",
  "🎓",
  "👶",
  "🎁",
  "🩺",
];

export function EmojiPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (e: string) => void;
}) {
  return (
    <div className="grid grid-cols-6 gap-2">
      {GOAL_EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onChange(e)}
          className={`flex h-11 items-center justify-center rounded-xl text-xl transition ${
            value === e ? "bg-violet-500/20 ring-2 ring-violet-500" : "bg-white/5"
          }`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
