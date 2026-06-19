import { X } from "lucide-react";
import type { ReactNode } from "react";

// Shared dark-theme primitives so every screen matches the dashboard.

export const inputClass =
  "w-full rounded-xl border border-edge bg-raised px-3.5 py-3 text-bone placeholder:text-faint outline-none transition focus:border-accent focus:bg-raised focus:ring-2 focus:ring-accent/25";

export const labelClass = "mb-1.5 block text-sm font-medium text-taupe";

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
      className={`rounded-2xl border border-edge bg-tile ${
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
    primary: "bg-accent text-bg hover:brightness-110",
    soft: "bg-accent/15 text-accent hover:bg-accent/25",
    ghost: "bg-raised text-bone hover:brightness-110",
    danger: "bg-ember/15 text-ember hover:bg-ember/25",
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
  color = "#34c5e8",
  track = "rgba(255,255,255,0.07)",
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
      className="grid gap-1 rounded-xl bg-raised p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            value === o.value
              ? "bg-bg text-bone shadow-sm"
              : "text-taupe hover:text-bone"
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
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="scroll-soft relative z-10 max-h-[86vh] w-full max-w-[420px] overflow-y-auto rounded-[22px] p-5 shadow-2xl"
        style={{ background: "#0f141c", border: "1px solid #232d3a", borderTop: "2px solid #34c5e8" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-bone">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-taupe transition hover:bg-raised"
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
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-raised text-taupe">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-bone">{title}</h3>
      {children && (
        <div className="mt-1 text-sm text-taupe">{children}</div>
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
            value === e ? "bg-accent/20 ring-2 ring-accent" : "bg-raised"
          }`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
