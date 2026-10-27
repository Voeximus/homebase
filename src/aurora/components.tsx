// Aurora's shared pieces. Values come from aurora-design-handoff/reference-html
// (the HTML wins over the written spec); class names map to aurora.css.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { heroParts, money0, shortDate, type ForecastDay } from "./logic";
import type { IconStyle } from "./adapt";
import { getLang, t } from "../lib/i18n";

// ── background ────────────────────────────────────────────────────────────
type Glow = { left: number; top: number; size: number; rgb: string; a: number; stop: number };
const V = "124,104,255";
const T = "47,212,196";
const R = "255,122,182";
export const PRESETS: Record<"home" | "activity" | "goals" | "month", Glow[]> = {
  home: [
    { left: -150, top: -170, size: 460, rgb: V, a: 0.55, stop: 68 },
    { left: 160, top: -130, size: 400, rgb: T, a: 0.34, stop: 68 },
    { left: 110, top: 330, size: 440, rgb: R, a: 0.14, stop: 70 },
  ],
  activity: [
    { left: 130, top: -190, size: 460, rgb: V, a: 0.45, stop: 68 },
    { left: -200, top: 380, size: 440, rgb: T, a: 0.18, stop: 70 },
  ],
  goals: [
    { left: -170, top: -160, size: 460, rgb: T, a: 0.36, stop: 68 },
    { left: 170, top: -60, size: 400, rgb: V, a: 0.4, stop: 68 },
    { left: 120, top: 520, size: 420, rgb: R, a: 0.14, stop: 70 },
  ],
  month: [
    { left: -40, top: 90, size: 470, rgb: V, a: 0.42, stop: 66 },
    { left: 190, top: -150, size: 380, rgb: R, a: 0.22, stop: 68 },
    { left: -160, top: 520, size: 420, rgb: T, a: 0.18, stop: 70 },
  ],
};

export function AuroraBackground({ preset }: { preset: keyof typeof PRESETS }) {
  return (
    <div className="au-bg" aria-hidden="true">
      <div className="au-bg-inner">
        {PRESETS[preset].map((g, i) => (
          <div
            key={i}
            className="au-glow"
            style={{
              left: g.left,
              top: g.top,
              width: g.size,
              height: g.size,
              background: `radial-gradient(circle, rgba(${g.rgb},${g.a}) 0%, rgba(${g.rgb},0) ${g.stop}%)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ── header pieces ─────────────────────────────────────────────────────────
export function AvatarButton({ onClick }: { onClick?: () => void }) {
  return (
    <button className="au-avatar" aria-label={t("Profile and settings")} onClick={onClick}>
      <span>
        <Icon name="profile" size={18} stroke={1.6} />
      </span>
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  soft,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  soft?: boolean;
}) {
  return (
    <button className={soft ? "au-iconbtn au-iconbtn--soft" : "au-iconbtn"} aria-label={label} onClick={onClick}>
      <Icon name={icon} size={18} />
    </button>
  );
}

// ── numbers ───────────────────────────────────────────────────────────────
/** HeroAmount `split`: "$" in text-2, the whole part, the cents in text-faint.
 *  Steps 66 → 52 → 44 instead of wrapping when the whole part gets long. */
export function HeroAmount({ value }: { value: number }) {
  const p = heroParts(value);
  const len = p.sign.length + p.whole.length;
  const size = len > 9 ? " au-hero--44" : len > 7 ? " au-hero--52" : "";
  return (
    <span className={"au-hero" + size} role="img" aria-label={spokenMoney(value)}>
      {p.sign && <span aria-hidden="true">{p.sign}</span>}
      <span className="au-hero-affix au-hero-symbol" aria-hidden="true">
        {p.symbol}
      </span>
      <span aria-hidden="true">{p.whole}</span>
      <span className="au-hero-affix au-hero-cents" aria-hidden="true">
        {p.cents}
      </span>
    </span>
  );
}

/** "1,830 dollars and 42 cents" — how a screen reader should hear an amount. */
export function spokenMoney(n: number): string {
  const abs = Math.abs(Math.round(n * 100)) / 100;
  const dollars = Math.floor(abs);
  const cents = Math.round((abs - dollars) * 100);
  const lead = n < 0 ? `${t("minus")} ` : "";
  const d = dollars.toLocaleString("en-US");
  return (
    lead +
    (cents ? t("{dollars} dollars and {cents} cents", { dollars: d, cents }) : t("{dollars} dollars", { dollars: d }))
  );
}

export function StatusPill({ tone, text }: { tone: "calm" | "warning" | "stale"; text: string }) {
  return (
    <p className={tone === "warning" ? "au-pill au-pill--warning" : tone === "stale" ? "au-pill au-pill--stale" : "au-pill"}>
      <span className="au-pill-dot" aria-hidden="true" />
      {text}
    </p>
  );
}

// ── lists ─────────────────────────────────────────────────────────────────
export function Disc({ style, size = 36, glow }: { style: IconStyle; size?: 36 | 38; glow?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={size === 38 ? "au-disc au-disc--38" : "au-disc"}
      style={{ background: style.bg, color: style.fg, boxShadow: glow ? `0 0 18px ${style.glow}` : undefined }}
    >
      <Icon name={style.icon} size={size === 38 ? 17 : 16} />
    </span>
  );
}

export function ListRow({
  disc,
  title,
  sub,
  subTone,
  amount,
  amountTone,
  dim,
  tall,
  onClick,
  label,
}: {
  disc: IconStyle;
  title: string;
  sub?: string;
  subTone?: "amber" | "rose";
  amount: string;
  amountTone?: "teal" | "rose";
  dim?: boolean;
  tall?: boolean;
  onClick?: () => void;
  label?: string;
}) {
  return (
    <li>
      <button
        className={(tall ? "au-row au-row--56" : "au-row") + (onClick ? "" : " au-row--static")}
        onClick={onClick}
        aria-label={label}
        disabled={!onClick}
      >
        <Disc style={disc} size={tall ? 38 : 36} glow={tall} />
        <span className="au-row-mid">
          <span className="au-row-title">{title}</span>
          {sub && (
            <span
              className="au-row-sub"
              style={subTone ? { color: subTone === "amber" ? "var(--au-color-amber-text)" : "var(--au-color-rose-text)" } : undefined}
            >
              {sub}
            </span>
          )}
        </span>
        <span
          className="au-row-amt"
          style={{
            color: amountTone === "teal" ? "var(--au-color-teal-text)" : amountTone === "rose" ? "var(--au-color-rose-text)" : undefined,
            opacity: dim ? 0.7 : undefined,
          }}
        >
          {amount}
        </span>
      </button>
    </li>
  );
}

// ── floating tab bar ──────────────────────────────────────────────────────
export type AuroraTab = "home" | "activity" | "goals" | "health";
const TABS: { key: AuroraTab; icon: IconName; label: string }[] = [
  { key: "home", icon: "home", label: "Home" },
  { key: "activity", icon: "activity", label: "Activity" },
  { key: "goals", icon: "goals", label: "Goals" },
  // Decision 4 (2026-10-26): no card to control, so Health takes the Card slot.
  { key: "health", icon: "health", label: "Health" },
];

export function FloatingTabBar({
  active,
  onTab,
  badges = {},
}: {
  active: AuroraTab;
  onTab: (t: AuroraTab) => void;
  badges?: Partial<Record<AuroraTab, number>>;
}) {
  return (
    <nav className="au-nav" aria-label={t("Main")}>
      {TABS.map(({ key, icon, label }) => {
        const on = key === active;
        const badge = badges[key] ?? 0;
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            aria-current={on ? "page" : undefined}
            aria-label={badge > 0 ? `${t(label)}, ${badge}` : t(label)}
          >
            {on ? (
              <span className="au-nav-on">
                <Icon name={icon} size={22} />
              </span>
            ) : (
              <Icon name={icon} size={22} />
            )}
            {badge > 0 && !on && (
              <span className="au-nav-badge" aria-hidden="true">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ── forecast chart ────────────────────────────────────────────────────────
/** Monotone cubic (Fritsch–Carlson) through the points, so rent and payday cliffs
 *  never overshoot. Returns the SVG path data. */
export function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const tg: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) tg.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  tg.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      tg[i] = 0;
      tg[i + 1] = 0;
      continue;
    }
    const a = tg[i] / m[i];
    const b = tg[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      tg[i] = tau * a * m[i];
      tg[i + 1] = tau * b * m[i];
    }
  }
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += ` C${f(x0 + h)},${f(y0 + tg[i] * h)} ${f(x1 - h)},${f(y1 - tg[i + 1] * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const DRAWN_KEY = "au-forecast-drawn";

/** The Original home's forecast: 150 tall, full-bleed, today marker at the gutter,
 *  the largest bill annotated under its dip and each payday above its peak. */
export function ForecastChart({ days }: { days: ForecastDay[] }) {
  const id = useId().replace(/:/g, "");
  const [ref, W] = useWidth<HTMLElement>(390);
  // Draw the line left → right once per session (motion table), never again.
  const [draw] = useState(() => {
    try {
      if (sessionStorage.getItem(DRAWN_KEY)) return false;
      sessionStorage.setItem(DRAWN_KEY, "1");
      return true;
    } catch {
      return false;
    }
  });
  if (days.length < 2) return null;
  const H = 150;
  const inset = 24;
  const top = 24;
  const zero = 128;
  const vals = days.map((d) => d.balance);
  const hi = Math.max(...vals, 1) * 1.1;
  const lo = Math.min(0, ...vals);
  const xOf = (i: number) => inset + (i * (W - inset * 2)) / (days.length - 1);
  const yOf = (v: number) => Math.min(H - 2, zero - ((v - lo) / (hi - lo)) * (zero - top));
  const pts = days.map((d, i) => [xOf(i), yOf(d.balance)] as [number, number]);
  const line = monotonePath(pts);
  // Extend the line to both edges, as the reference does (it runs 0 → 390).
  const lineFull = `M0,${pts[0][1].toFixed(1)} L${line.slice(1)} L${W},${pts[pts.length - 1][1].toFixed(1)}`;
  const areaFull = `${lineFull} L${W},${H} L0,${H} Z`;

  // Largest bill in the window — labelled under its dip, on the bottom row.
  let bill: { i: number; name: string; amount: number } | null = null;
  days.forEach((d, i) => {
    for (const e of d.events) if (e.kind === "bill" && (!bill || e.amount < bill.amount)) bill = { i, name: e.name, amount: e.amount };
  });
  // Paydays — labelled above their peaks, skipping any label that would collide.
  const paydays: { i: number; amount: number }[] = [];
  days.forEach((d, i) => {
    const inc = d.events.filter((e) => e.kind === "income").reduce((s, e) => s + e.amount, 0);
    if (inc > 0 && i > 0) paydays.push({ i, amount: inc });
  });
  // A label never sits on the today marker (its halo is r11 at the gutter) and never
  // runs off either edge.
  const clampX = (x: number, half: number) => Math.min(W - half - 4, Math.max(inset + 15 + half, x));
  // Collisions are judged where a label is DRAWN, after the clamp has moved it.
  const shown: number[] = [];
  const payLabels = paydays.filter((p) => {
    const x = clampX(xOf(p.i), 46);
    if (shown.some((s) => Math.abs(s - x) < 104)) return false;
    shown.push(x);
    return true;
  });
  const b = bill as { i: number; name: string; amount: number } | null;

  // Axis: Today · the largest bill · the next payday · the window's end.
  const axis: { x: number; label: string; end?: boolean }[] = [{ x: inset, label: t("Today") }];
  const addAxis = (i: number | undefined) => {
    if (i == null) return;
    const x = xOf(i);
    if (axis.some((a) => Math.abs(a.x - x) < 44) || x > W - inset - 52) return;
    axis.push({ x, label: shortDate(days[i].date) });
  };
  const marks = [b?.i, paydays[0]?.i].filter((v): v is number => v != null).sort((p, q) => p - q);
  marks.forEach(addAxis);
  axis.push({ x: W - inset, label: shortDate(days[days.length - 1].date), end: true });

  const low = days.reduce((m, d) => (d.balance < m.balance ? d : m), days[0]);
  const on = (what: string, date: string) => t("{what} on {date}", { what, date: shortDate(date) });
  const aria =
    `${t("Balance forecast for the next month")}: ${money0(days[0].balance)} ${t("today")}` +
    (b ? `, ${on(`${b.name} ${money0(b.amount)}`, days[b.i].date)}` : "") +
    `, ${on(`${t("lowest")} ${money0(low.balance)}`, low.date)}` +
    (paydays[0] ? `, ${on(t("payday"), days[paydays[0].i].date)}` : "") +
    `, ${on(money0(days[days.length - 1].balance), days[days.length - 1].date)}.`;

  return (
    <figure className="au-chart" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria}>
        <defs>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: "#B7ACFF" }} />
            <stop offset="0.55" style={{ stopColor: "#7C68FF" }} />
            <stop offset="1" style={{ stopColor: "#3BE0CF" }} />
          </linearGradient>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "#7C68FF", stopOpacity: 0.3 }} />
            <stop offset="1" style={{ stopColor: "#7C68FF", stopOpacity: 0 }} />
          </linearGradient>
          <filter id={`${id}g`} x="-10%" y="-60%" width="120%" height="220%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>
        {lo < 0 && (
          // A forecast that goes negative draws its $0 line (docs/05, "Extreme values").
          <line x1={0} x2={W} y1={yOf(0)} y2={yOf(0)} stroke="#FFFFFF" strokeOpacity={0.14} />
        )}
        <path d={areaFull} fill={`url(#${id}f)`} />
        <path d={lineFull} fill="none" stroke={`url(#${id}s)`} strokeWidth="7" strokeLinecap="round" opacity="0.6" filter={`url(#${id}g)`} />
        <path
          d={lineFull}
          fill="none"
          stroke={`url(#${id}s)`}
          strokeWidth="2.5"
          strokeLinecap="round"
          pathLength={draw ? 1 : undefined}
          className={draw ? "au-draw" : undefined}
        />
        <line x1={inset} y1={pts[0][1]} x2={inset} y2={H} stroke="#FFFFFF" strokeOpacity="0.18" strokeDasharray="2 4" />
        <circle cx={inset} cy={pts[0][1]} r="11" fill="#B7ACFF" fillOpacity="0.22" />
        <circle cx={inset} cy={pts[0][1]} r="4.5" fill="#FFFFFF" />
        {payLabels.map((p) => (
          <g key={p.i}>
            <circle cx={xOf(p.i)} cy={pts[p.i][1]} r="3.5" fill="#3BE0CF" />
            <text
              x={clampX(xOf(p.i), 46)}
              y={Math.max(11, pts[p.i][1] - 14)}
              textAnchor="middle"
              fontFamily="Outfit, sans-serif"
              fontSize="11"
              fill="#B9BBC8"
            >
              {t("Payday")} +{money0(p.amount)}
            </text>
          </g>
        ))}
        {b && (
          <text x={clampX(xOf(b.i), 50)} y="144" textAnchor="middle" fontFamily="Outfit, sans-serif" fontSize="11" fill="#B9BBC8">
            {b.name} {money0(b.amount)}
          </text>
        )}
      </svg>
      <figcaption className="au-chart-axis" aria-hidden="true">
        {axis.map((a, i) =>
          a.end ? (
            <span key={i} className="au-axis-end" style={{ right: inset }}>
              {a.label}
            </span>
          ) : (
            <span key={i} style={{ left: a.x }}>
              {a.label}
            </span>
          ),
        )}
      </figcaption>
    </figure>
  );
}

// ── Activity mini bars ────────────────────────────────────────────────────
/** 140×72, seven 12-wide bars 20 apart. The household's week runs Sunday to
 *  Saturday (src/lib/weekPlan.ts), so the letters start at S. */
export function MiniBars({ byDay, todayIndex }: { byDay: number[]; todayIndex: number }) {
  const id = useId().replace(/:/g, "");
  const max = Math.max(...byDay, 0);
  const zh = getLang() === "zh";
  const letters = zh ? ["日", "一", "二", "三", "四", "五", "六"] : ["S", "M", "T", "W", "T", "F", "S"];
  const names = zh
    ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const said = byDay
    .map((v, i) => (v > 0 && i <= todayIndex ? `${i === todayIndex ? t("today") : names[i]} ${money0(v)}` : null))
    .filter(Boolean)
    .join(", ");
  return (
    <svg width="140" height="72" viewBox="0 0 140 72" role="img" aria-label={`${t("Spending by day this week")}: ${said || t("nothing yet")}.`}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "#3BE0CF" }} />
          <stop offset="1" style={{ stopColor: "#7C68FF" }} />
        </linearGradient>
      </defs>
      {byDay.map((v, i) => {
        const x = 4 + i * 20;
        const h = max > 0 ? (v / max) * 52 : 0;
        if (v <= 0 || i > todayIndex || h < 2)
          return <rect key={i} x={x} y="54" width="12" height="2" rx="1" fill="#FFFFFF" fillOpacity="0.18" />;
        const rx = Math.min(6, h / 2);
        return i === todayIndex ? (
          <rect key={i} x={x} y={56 - h} width="12" height={h} rx={rx} fill={`url(#${id}b)`} />
        ) : (
          <rect key={i} x={x} y={56 - h} width="12" height={h} rx={rx} fill="#7C68FF" fillOpacity="0.55" />
        );
      })}
      {letters.map((l, i) => (
        <text
          key={i}
          x={10 + i * 20}
          y="70"
          textAnchor="middle"
          fontFamily="Outfit, sans-serif"
          fontSize="10"
          fill={i === todayIndex ? "#F4F5FA" : "#8E91A3"}
        >
          {l}
        </text>
      ))}
    </svg>
  );
}

// ── Insights ring ─────────────────────────────────────────────────────────
const RING_R = 118;
const RING_C = 2 * Math.PI * RING_R; // 741.4

/** 280px ring: one arc per category, length ∝ spent / total plan, 6px gaps,
 *  12 o'clock clockwise. Past the plan, the overflow laps again at 50%. */
export function SpendingRing({
  cats,
  totalPlan,
  label,
  children,
}: {
  cats: { name: string; spent: number; colour: string }[];
  totalPlan: number;
  label: string;
  children: ReactNode;
}) {
  const totalSpent = cats.reduce((s, c) => s + c.spent, 0);
  const scale = totalPlan > 0 ? totalPlan : Math.max(totalSpent, 1);
  const arcs: { colour: string; len: number; start: number; dim: boolean }[] = [];
  let at = 0;
  for (const c of cats) {
    if (c.spent <= 0) continue;
    let len = (c.spent / scale) * RING_C;
    let start = at;
    at += len;
    // Split an arc that crosses 12 o'clock past the plan: the part beyond is lap two.
    while (len > 0 && start < RING_C * 2) {
      const lap = Math.floor(start / RING_C);
      const room = RING_C * (lap + 1) - start;
      const piece = Math.min(len, room);
      arcs.push({ colour: c.colour, len: piece, start: start - lap * RING_C, dim: lap > 0 });
      start += piece;
      len -= piece;
    }
  }
  return (
    <figure className="au-ring">
      <svg width="280" height="280" viewBox="0 0 280 280" role="img" aria-label={label} style={{ filter: "drop-shadow(0 0 22px rgba(124,104,255,0.35))" }}>
        <circle cx="140" cy="140" r={RING_R} fill="none" stroke="#FFFFFF" strokeOpacity="0.07" strokeWidth="16" />
        <g transform="rotate(-90 140 140)" fill="none" strokeWidth="16" strokeLinecap="round">
          {arcs.map((a, i) => (
            <circle
              key={i}
              cx="140"
              cy="140"
              r={RING_R}
              stroke={a.colour}
              strokeOpacity={a.dim ? 0.5 : 1}
              strokeDasharray={`${Math.max(0.01, a.len - 22).toFixed(1)} ${RING_C.toFixed(1)}`}
              strokeDashoffset={(-(a.start + 11)).toFixed(1)}
            />
          ))}
        </g>
      </svg>
      <div className="au-ring-centre">{children}</div>
    </figure>
  );
}

// ── Goal ring ─────────────────────────────────────────────────────────────
const GOAL_C = 2 * Math.PI * 25; // 157.1
export function GoalRing({ pct, colour, done }: { pct: number; colour: string; done?: boolean }) {
  const p = Math.max(0, Math.min(1, pct));
  const n = parseInt(colour.slice(1), 16);
  const glow = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.55)`;
  return (
    <span className="au-goal-ring">
      <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true" style={{ filter: `drop-shadow(0 0 8px ${glow})` }}>
        <circle cx="30" cy="30" r="25" fill="none" stroke="#FFFFFF" strokeOpacity="0.08" strokeWidth="5" />
        {p > 0 && (
          <circle
            cx="30"
            cy="30"
            r="25"
            fill="none"
            stroke={colour}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(p * GOAL_C).toFixed(1)} ${GOAL_C.toFixed(1)}`}
            transform="rotate(-90 30 30)"
          />
        )}
      </svg>
      <span className="au-goal-pct" style={done ? { color: "var(--au-color-teal)" } : undefined}>
        {done ? <Icon name="check" size={20} /> : `${Math.round(p * 100)}%`}
      </span>
    </span>
  );
}

/** A screen pushed over the tabs (Profile): its own back button and title, its own
 *  kept scroll. A component of its own because a hook cannot sit inside the shell's
 *  ternary. */
export function PushedScreen({
  scrollKey,
  title,
  onBack,
  children,
  style,
}: {
  scrollKey: string;
  title: string;
  onBack: () => void;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  const scroll = useKeptScroll(scrollKey);
  return (
    <>
      <AuroraBackground preset="home" />
      <div className="au-scroll" ref={scroll}>
        <main className="au-main" style={{ paddingLeft: 0, paddingRight: 0, ...style }}>
          <header className="au-header" style={{ padding: "0 var(--au-space-gutter)" }}>
            <span className="au-title-row">
              <IconButton icon="chevron-left" label={t("Back")} onClick={onBack} />
              <h1 className="au-title" tabIndex={-1} data-au-focus="">
                {title}
              </h1>
            </span>
          </header>
          {children}
        </main>
      </div>
    </>
  );
}

/** Restores a tab's scroll when you come back to it (navigation: "each tab keeps
 *  its scroll position"). */
export function useKeptScroll(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const k = `au-scroll-${key}`;
    try {
      el.scrollTop = Number(sessionStorage.getItem(k) ?? 0);
    } catch {
      /* ignore */
    }
    const save = () => {
      try {
        sessionStorage.setItem(k, String(el.scrollTop));
      } catch {
        /* ignore */
      }
    };
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, [key]);
  return ref;
}
