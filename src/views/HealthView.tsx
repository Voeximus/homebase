import { useEffect, useState, type ReactNode } from "react";
import { ClipboardList, LogOut, UtensilsCrossed } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { ModeToggle, type AppMode } from "../components/ModeToggle";
import { MealBuilder } from "./MealBuilder";

// ── Two Bodies · One Engine ──────────────────────────────────────────────────
// The health instrument: same calibration loop as the finance side, run in two
// directions. Gino = surplus/build (warm), Xinyan = deficit/cut (teal). The
// signature is the calibration gauge — the weekly scale steers the next move.

type Person = "gino" | "xinyan";
const ACC: Record<Person, string> = { gino: "#ef8136", xinyan: "#2dd1c0" };
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

// ── gauge config (ported verbatim from the doc) ──
type GaugeCfg = {
  start: number;
  goal?: number;
  min: number;
  max: number;
  bandLo: number;
  bandHi: number;
  unit: string;
  signed: boolean;
  rate: (cur: number, wk: number) => number;
  verdict: (r: number) => [string, boolean];
};
const GAUGE: Record<Person, GaugeCfg> = {
  gino: {
    start: 143, min: -0.25, max: 1.0, bandLo: 0.25, bandHi: 0.5,
    unit: "lb / week", signed: true,
    rate: (cur, wk) => (cur - 143) / wk,
    verdict: (r) =>
      r < 0 ? ["Dropping — you're under maintenance. Add ~250 kcal.", false]
      : r < 0.05 ? ["Flat — add ~200 kcal/day to get moving.", false]
      : r < 0.25 ? ["A touch slow — nudge +150–200 kcal.", false]
      : r <= 0.5 ? ["On track. Hold everything.", true]
      : r <= 0.75 ? ["Upper edge — fine, just watch the mirror.", true]
      : ["Gaining too fast — trim ~150 kcal to keep it muscle.", false],
  },
  xinyan: {
    start: 149, goal: 118, min: 0, max: 2.0, bandLo: 0.5, bandHi: 1.0,
    unit: "lb / week loss", signed: false,
    rate: (cur, wk) => (149 - cur) / wk,
    verdict: (r) =>
      r < 0 ? ["Up this week — tighten portions, cut ~100 kcal.", false]
      : r < 0.25 ? ["Stalled — add steps first, then trim ~100 kcal.", false]
      : r < 0.5 ? ["A bit slow — add steps, hold calories a week.", false]
      : r <= 1.0 ? ["On track. Hold.", true]
      : r <= 1.25 ? ["Brisk but okay — keep protein high.", true]
      : ["Too fast — add ~150 kcal to protect muscle.", false],
  },
};

export function HealthView({
  mode,
  onMode,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
}) {
  const { signOut } = useAuth();
  const [sub, setSub] = useState<"plan" | "kitchen">(
    () => (localStorage.getItem("hb-health-sub") as "plan" | "kitchen") || "plan",
  );
  const [person, setPerson] = useState<Person>(() =>
    (localStorage.getItem("hb-health-person") as Person) || "gino",
  );
  useEffect(() => {
    localStorage.setItem("hb-health-sub", sub);
  }, [sub]);
  useEffect(() => {
    localStorage.setItem("hb-health-person", person);
  }, [person]);
  const acc = ACC[person];

  return (
    <div className="min-h-screen">
      {/* sticky header + person toggle */}
      <div className="safe-top sticky top-0 z-40 border-b border-edge bg-bg/90 backdrop-blur">
        <div className="mx-auto max-w-[640px] px-4">
          <div className="flex h-14 items-center gap-2">
            <ModeToggle mode={mode} onMode={onMode} />
            <div className="min-w-0 flex-1 text-right">
              <span className="eyebrow text-faint">Two Bodies · One Engine</span>
            </div>
            <button
              onClick={() => signOut()}
              className="rounded-full p-2 text-taupe transition hover:bg-raised"
              aria-label="Logout"
            >
              <LogOut size={17} />
            </button>
          </div>
          {/* sub-nav: per-person plan vs the shared meal builder */}
          <div className="grid grid-cols-2 gap-2 pb-2.5">
            {[
              { k: "plan" as const, label: "Plan", Icon: ClipboardList },
              { k: "kitchen" as const, label: "Meal Builder", Icon: UtensilsCrossed },
            ].map(({ k, label, Icon }) => {
              const on = sub === k;
              return (
                <button
                  key={k}
                  onClick={() => setSub(k)}
                  className={`flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-semibold transition ${
                    on ? "bg-bone text-bg" : "bg-tile text-taupe hover:text-bone"
                  }`}
                >
                  <Icon size={15} /> {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[640px] px-4 pb-16 pt-4">
        {sub === "kitchen" ? (
          <MealBuilder />
        ) : (
          <>
            {/* person toggle */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              {(["gino", "xinyan"] as const).map((p) => {
                const on = person === p;
                const pa = ACC[p];
                return (
                  <button
                    key={p}
                    onClick={() => setPerson(p)}
                    className="flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition"
                    style={
                      on
                        ? { background: pa, color: "#0a0d12" }
                        : { background: "var(--color-raised)", color: "var(--color-taupe)" }
                    }
                  >
                    <span>{p === "gino" ? "▲" : "▼"}</span>
                    {p === "gino" ? "Gino" : "Xinyan"}
                    <span className="font-mono text-[10px] tracking-widest opacity-70">
                      {p === "gino" ? "BUILD" : "CUT"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div key={person} className="rise space-y-3">
              <div className="h-1 rounded-full" style={{ background: acc }} />
              {person === "gino" ? <GinoPlan acc={acc} /> : <XinyanPlan acc={acc} />}
            </div>
            <footer className="mt-7 border-t border-edge pt-5 font-mono text-[11px] leading-relaxed text-faint">
              <span className="text-taupe">One framework, two signs.</span> Both plans
              run the same loop: set a calorie seed → train → read the weekly-average
              scale → adjust ONE variable at a time. The formula is a guess; the scale
              is the measurement.
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

// ── shared building blocks ───────────────────────────────────────────────────
function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-tile p-4">{children}</section>
  );
}
function SecHead({ n, title, sub, acc }: { n: string; title: string; sub?: string; acc: string }) {
  return (
    <>
      <p className="eyebrow" style={{ color: acc }}>
        <span className="text-faint">{n}</span>&nbsp;&nbsp;{title}
      </p>
      {sub && <p className="mb-3 mt-1 font-mono text-[11px] text-faint">{sub}</p>}
      {!sub && <div className="mb-2" />}
    </>
  );
}
function Chips({ items }: { items: string[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {items.map((c, i) => (
        <span
          key={i}
          className="rounded-full border border-edge bg-raised px-2.5 py-1 font-mono text-[12px] text-taupe"
        >
          {c}
        </span>
      ))}
    </div>
  );
}
function Macros({
  acc,
  items,
  seed,
}: {
  acc: string;
  items: { v: string; u: string; k: string; lead?: boolean }[];
  seed: string[];
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 min-[480px]:grid-cols-4">
        {items.map((m, i) => (
          <div
            key={i}
            className="rounded-lg border p-3 text-center"
            style={
              m.lead
                ? { background: acc + "1f", borderColor: acc }
                : { background: "var(--color-raised)", borderColor: "var(--color-edge)" }
            }
          >
            <div
              className="num text-[22px] font-bold leading-none"
              style={{ color: m.lead ? acc : "var(--color-bone)" }}
            >
              {m.v}
            </div>
            <div className="font-mono text-[10px] text-faint">{m.u}</div>
            <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-taupe">
              {m.k}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11.5px] text-taupe">
        {seed.map((s, i) => (
          <span key={i}>{s}</span>
        ))}
      </div>
    </>
  );
}
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border border-edge bg-raised p-3.5">
      <p className="mb-1.5 text-[13px] font-semibold text-bone">{title}</p>
      <p className="text-[13px] leading-relaxed text-taupe">{children}</p>
    </div>
  );
}
function Pillars({
  acc,
  items,
  conf,
  src,
}: {
  acc: string;
  items: { t: string; d: string }[];
  conf: ReactNode;
  src: string;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
        {items.map((p, i) => (
          <div key={i} className="rounded-lg border border-edge bg-raised p-3">
            <p className="mb-0.5 text-[13px] font-semibold" style={{ color: acc }}>
              {p.t}
            </p>
            <p className="font-mono text-[11.5px] leading-relaxed text-taupe">{p.d}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-taupe">{conf}</p>
      <p className="mt-2 font-mono text-[10.5px] text-faint">sources: {src}</p>
    </>
  );
}

// ── the signature: calibration gauge ─────────────────────────────────────────
function CalibrationGauge({ person, acc }: { person: Person; acc: string }) {
  const cfg = GAUGE[person];
  const [w, setW] = useState(() => localStorage.getItem(`hb-h-${person}-w`) ?? "");
  const [k, setK] = useState(() => localStorage.getItem(`hb-h-${person}-k`) ?? "");
  useEffect(() => localStorage.setItem(`hb-h-${person}-w`, w), [w, person]);
  useEffect(() => localStorage.setItem(`hb-h-${person}-k`, k), [k, person]);

  const cur = parseFloat(w);
  const wk = parseFloat(k);
  const valid = !!cur && !!wk && wk > 0;
  const r = valid ? cfg.rate(cur, wk) : 0;
  const pctOf = (v: number) => clamp(((v - cfg.min) / (cfg.max - cfg.min)) * 100, 0, 100);
  const lo = pctOf(cfg.bandLo);
  const hi = pctOf(cfg.bandHi);
  const [verdictText, verdictOn] = valid
    ? cfg.verdict(r)
    : ["Enter your numbers to read the trend.", false];
  const shown = valid ? (cfg.signed && r >= 0 ? "+" : "") + r.toFixed(2) : "—";

  // progress to goal (xinyan)
  const toGo = cfg.goal && valid ? Math.max(0, cur - cfg.goal) : null;
  const donePct =
    cfg.goal && valid
      ? clamp(((cfg.start - cur) / (cfg.start - cfg.goal)) * 100, 0, 100)
      : 0;

  return (
    <section className="rounded-xl border border-edge bg-bg p-4">
      <p className="eyebrow" style={{ color: acc }}>
        Calibration check
      </p>
      <p className="mt-1 text-[17px] font-semibold text-bone">
        {person === "gino" ? "Are you gaining at the right rate?" : "Are you losing at the right rate?"}
      </p>
      <p className="mb-4 mt-0.5 font-mono text-[11.5px] text-faint">
        enter your 7-day average — the scale is the measurement
      </p>

      <div className="mb-5 grid grid-cols-2 gap-2.5">
        <label className="block">
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-faint">
            Current weight (lb)
          </span>
          <input
            type="number"
            inputMode="decimal"
            value={w}
            onChange={(e) => setW(e.target.value)}
            placeholder={String(cfg.start)}
            className="num mt-1.5 w-full rounded-lg border border-edge bg-raised px-3 py-2.5 text-[17px] font-semibold text-bone outline-none transition-colors focus:border-taupe"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-faint">
            Weeks on plan
          </span>
          <input
            type="number"
            inputMode="numeric"
            value={k}
            onChange={(e) => setK(e.target.value)}
            placeholder="3"
            className="num mt-1.5 w-full rounded-lg border border-edge bg-raised px-3 py-2.5 text-[17px] font-semibold text-bone outline-none transition-colors focus:border-taupe"
          />
        </label>
      </div>

      {/* the track */}
      <div className="relative my-2 h-[46px]">
        <div className="absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-raised" />
        <div
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
          style={{ left: `${lo}%`, width: `${hi - lo}%`, background: acc, opacity: 0.5 }}
        />
        <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2" style={{ left: `${lo}%`, background: acc }} />
        <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2" style={{ left: `${hi}%`, background: acc }} />
        {valid && (
          <div
            className="absolute top-1/2 h-7 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white"
            style={{
              left: `${pctOf(r)}%`,
              boxShadow: "0 0 0 4px rgba(0,0,0,.35)",
              transition: "left .5s cubic-bezier(.2,.7,.2,1)",
            }}
          />
        )}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-faint">
        <span>too slow</span>
        <span style={{ color: acc }}>target band</span>
        <span>too fast</span>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="num text-[34px] font-bold leading-none text-bone">{shown}</span>
        <span className="font-mono text-[13px] text-faint">{cfg.unit}</span>
      </div>
      <p
        className="mt-2 text-[14px] leading-snug"
        style={{ color: verdictOn ? "#fff" : "var(--color-taupe)" }}
      >
        {verdictText}
      </p>

      {cfg.goal != null && valid && (
        <div className="mt-3.5 border-t border-edge pt-3 font-mono text-[11.5px] text-faint">
          <span>
            Progress to {cfg.goal}:{" "}
            <b className="text-bone">
              {toGo! <= 0 ? "Goal reached 🎉" : `${toGo!.toFixed(1)} lb to go · ${Math.round(donePct)}% there`}
            </b>
          </span>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full"
              style={{ width: `${donePct}%`, background: acc, transition: "width .5s ease" }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// ── Gino — BUILD ─────────────────────────────────────────────────────────────
function GinoPlan({ acc }: { acc: string }) {
  return (
    <>
      <Card>
        <SecHead n="01" title="Snapshot" acc={acc} />
        <Chips items={["25M", "5'7\"", "143 lb · hardgainer", "novice lifter", "sleep-limited", "goal: strength + size"]} />
        <p className="text-[15px] leading-relaxed text-bone">
          You've been stuck on{" "}
          <b style={{ color: acc }}>fuel and protein, not effort</b>. Eat above
          maintenance, train each muscle 2×/week in small recoverable doses, and
          progress by measurement.
        </p>
      </Card>

      <Card>
        <SecHead n="02" title="Daily fuel" sub="surplus biased slow, to add muscle not fat" acc={acc} />
        <Macros
          acc={acc}
          items={[
            { v: "2,800", u: "kcal", k: "Calories", lead: true },
            { v: "130", u: "g", k: "Protein" },
            { v: "70", u: "g", k: "Fat" },
            { v: "410", u: "g", k: "Carbs" },
          ]}
          seed={["maintenance seed ~2,500", "target +0.25–0.5 lb/wk", "protein ~2.0 g/kg"]}
        />
        <Block title="The hardgainer lever">
          One shake/day — whey + whole milk + banana/PB ≈{" "}
          <b className="text-bone">500–700 liquid kcal</b> that won't fill you up.
          Bolt protein (chicken, tofu, beef, eggs) onto the rice/noodles you
          already eat.
        </Block>
      </Card>

      <CalibrationGauge person="gino" acc={acc} />

      <Card>
        <SecHead
          n="03"
          title="Training — 4-day Upper / Lower"
          sub="~30 min · each muscle 2×/wk · don't stack all 4 days · RIR = reps left in the tank"
          acc={acc}
        />
        {TRAINING.map((s, i) => (
          <Session key={i} s={s} acc={acc} open={i === 0} />
        ))}
        <Block title="Progression — the 5-week block">
          <b className="text-bone">Double progression:</b> hit the top of the rep
          range on all sets, then add the smallest load. Log every set.
        </Block>
        <table className="mt-2 w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Week", "Effort", "Do"].map((h) => (
                <th key={h} className="border-b border-edge px-1.5 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-faint">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MESO.map((row, i) => (
              <tr key={i} style={row.deload ? { background: acc + "1f" } : undefined}>
                <td className="border-b border-edge px-1.5 py-2 font-mono font-semibold" style={{ color: acc }}>
                  {row.wk}
                </td>
                <td className="border-b border-edge px-1.5 py-2 text-bone">{row.effort}</td>
                <td className="border-b border-edge px-1.5 py-2 text-taupe">{row.do}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <SecHead n="04" title="Around the lifting" acc={acc} />
        <ul className="space-y-0">
          <Line acc={acc} mark="▲" title="Sleep is the ceiling.">
            4–6 broken hours caps growth more than any program detail. Highest-leverage
            fix: full blackout, white noise, consolidate to one block.
          </Line>
          <Line acc={acc} mark="▲" title="Running: 2–3×/wk, easy Zone-2 only, non-leg days.">
            Keeps cardio without draining the surplus or leg recovery.
          </Line>
        </ul>
      </Card>

      <Card>
        <SecHead n="05" title="Why this works" acc={acc} />
        <Pillars
          acc={acc}
          items={[
            { t: "Volume drives growth", d: "graded dose-response; 10+ sets/muscle/wk > <5. you start low and earn more" },
            { t: "Protein ≥1.6 g/kg", d: "FFM gains plateau ~1.6 g/kg (Morton, 49 trials). you're at ~2.0" },
            { t: "2×/wk frequency", d: "≥1× when volume is equal; mostly a way to fit & recover volume" },
            { t: "Slow surplus", d: "moderate gain biases muscle over fat; the scale calibrates the rest" },
          ]}
          conf={
            <>
              <b className="text-bone">Confidence:</b> structure & progression ~90% ·
              protein ~90% · maintenance calories ~60% (formula ±15%, the scale
              corrects it) · 30-min fit is tight — use the 4-exercise fallback when
              pressed.
            </>
          }
          src="Schoenfeld 2017 · Pelland 2025 · Morton 2018 · Nedeltcheva 2010 (sleep)"
        />
      </Card>
    </>
  );
}

// ── Xinyan — CUT ─────────────────────────────────────────────────────────────
function XinyanPlan({ acc }: { acc: string }) {
  return (
    <>
      <Card>
        <SecHead n="01" title="Snapshot" acc={acc} />
        <Chips items={["24F", "5'3\"", "149 lb · BMI ~26", "busy · limited exercise", "goal: 118 lb (~31 to lose)"]} />
        <p className="text-[15px] leading-relaxed text-bone">
          Same engine as Gino's, <b style={{ color: acc }}>reversed</b>. A moderate
          deficit, protein-forward to keep muscle and curb hunger, steps for
          movement — calibrated off the weekly scale. 118 is a healthy weight she
          already held, so this is a return to baseline.
        </p>
      </Card>

      <div className="rounded-lg border p-3.5" style={{ borderColor: acc, background: acc + "16" }}>
        <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide" style={{ color: acc }}>
          ⚑ Before you start
        </p>
        <ol className="list-decimal space-y-1.5 pl-4 text-[13.5px] text-bone">
          <li>
            <b>Medical clear?</b> A deficit isn't safe in pregnancy/breastfeeding or
            with some conditions — check with a doctor if any apply.
          </li>
          <li>
            <b>This is yours to drive.</b> Adherence is the whole game; build it
            around how you actually eat.
          </li>
          <li>
            <b>Gentle, not strict</b> — if food has ever been a struggle, keep it
            flexible. The calorie floor is a hard line.
          </li>
        </ol>
      </div>

      <Card>
        <SecHead n="02" title="Daily fuel" sub="moderate deficit · protein-forward to protect muscle" acc={acc} />
        <Macros
          acc={acc}
          items={[
            { v: "1,550", u: "kcal", k: "Calories", lead: true },
            { v: "140", u: "g", k: "Protein" },
            { v: "45", u: "g", k: "Fat" },
            { v: "145", u: "g", k: "Carbs" },
          ]}
          seed={["maintenance seed ~1,850", "target −0.5–1 lb/wk", "floor 1,400 kcal"]}
        />
        <Block title="Eating, built around your food">
          Keep rice but <b className="text-bone">portion it</b>. Pile on vegetables
          (volume = fullness). Lean protein every meal — chicken, fish, tofu, eggs.
          Broth soups are a cheat code. Watch the hidden calories:{" "}
          <b className="text-bone">cooking oil</b>, sugary drinks, fried food.
        </Block>
      </Card>

      <CalibrationGauge person="xinyan" acc={acc} />

      <Card>
        <SecHead n="03" title="Movement — schedule-proof" acc={acc} />
        <ul className="space-y-0">
          <Line acc={acc} mark="▼" title="Step target: build toward ~8,000/day.">
            Woven into your day, no gym needed — this is your main "exercise."
          </Line>
          <Line acc={acc} mark="▼" title="Optional: 2 × 10-min home resistance/week">
            (bodyweight squats, incline push-ups, a band). Protects more muscle — as
            a novice you could even recomp.
          </Line>
        </ul>
      </Card>

      <Card>
        <SecHead n="04" title="The long game" acc={acc} />
        <Block title="~8–12 months · two phases">
          ~31 lb at a sustainable pace. Loss runs faster early, slower near the end —
          the slow pace is what keeps muscle on.{" "}
          <b className="text-bone">Getting to 118 is the cut; staying there is the win</b>{" "}
          — change what drove the gain (food environment), or it returns.
        </Block>
        <Block title="Diet breaks keep it sustainable">
          Every ~6–10 weeks, eat at <b className="text-bone">maintenance for 1–2 weeks</b>{" "}
          (no deficit). Protects adherence and blunts the metabolic slowdown that
          stalls the scale.
        </Block>
      </Card>

      <Card>
        <SecHead n="05" title="Why this works" acc={acc} />
        <Pillars
          acc={acc}
          items={[
            { t: "Energy balance rules", d: "metabolic-ward proven; even ultra-processed food drives ~500 extra kcal/day" },
            { t: "Protein protects muscle", d: "in a deficit the higher end (~2.2 g/kg) spares lean mass best" },
            { t: "Slow rate = lean kept", d: "0.5–1%/wk preserved (even gained) muscle vs fast loss (Garthe)" },
            { t: "Diet > exercise", d: "body compensates ~half of exercise burn; steps still help the sedentary" },
          ]}
          conf={
            <>
              <b className="text-bone">Confidence:</b> the framework (deficit +
              protein + steps) ~90% · maintenance calories ~55% (your real activity is
              the unknown — the scale corrects it). <b className="text-bone">Listen to
              your body:</b> persistent fatigue/dizziness means eat more, not push
              harder.
            </>
          }
          src="Hall (metabolic ward) · Morton 2018 · Garthe 2011 · Pontzer 2026 · Byrne 2018 (diet breaks)"
        />
      </Card>
    </>
  );
}

function Line({
  acc,
  mark,
  title,
  children,
}: {
  acc: string;
  mark: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-b border-edge py-3 last:border-0 text-[14px]">
      <span className="shrink-0 font-mono font-bold" style={{ color: acc }}>
        {mark}
      </span>
      <span>
        <b className="text-bone">{title}</b>{" "}
        <span className="text-taupe">{children}</span>
      </span>
    </li>
  );
}

// ── training data (Gino) ─────────────────────────────────────────────────────
type Ex = { name: string; note?: string; rx: string; anchor?: boolean };
type Sess = { title: string; meta: string; ex: Ex[] };
const TRAINING: Sess[] = [
  {
    title: "Upper A", meta: "push-bias · ~12 sets",
    ex: [
      { name: "Incline DB Press", note: "anchor · rest ~2 min", rx: "3 × 6–8", anchor: true },
      { name: "Chest-Supported DB Row", rx: "3 × 8–10" },
      { name: "Seated DB Shoulder Press", note: "neutral grip if shoulders cranky", rx: "2 × 8–10" },
      { name: "Cable Lateral Raise", note: "superset ↓", rx: "2 × 12–15" },
      { name: "Cable Triceps Pushdown", rx: "2 × 10–12" },
    ],
  },
  {
    title: "Lower A", meta: "quad-bias · ~12 sets",
    ex: [
      { name: "Leg Press", note: "anchor · controlled depth", rx: "4 × 6–10", anchor: true },
      { name: "DB Romanian Deadlift", note: "flat back, feel the hamstrings", rx: "3 × 8–10" },
      { name: "DB Split Squat", rx: "2 × 10–12" },
      { name: "Calf Raise", note: "full stretch at bottom", rx: "3 × 12–15" },
    ],
  },
  {
    title: "Upper B", meta: "pull-bias · ~13 sets",
    ex: [
      { name: "Pull-Up", note: "anchor · band-assist or negatives if <5", rx: "3 × 6–10", anchor: true },
      { name: "Flat DB Press", rx: "3 × 8–10" },
      { name: "One-Arm DB Row", rx: "3 × 10–12" },
      { name: "Cable Face Pull", note: "superset ↓ · shoulder health", rx: "2 × 12–15" },
      { name: "DB Hammer Curl", rx: "2 × 10–12" },
    ],
  },
  {
    title: "Lower B", meta: "posterior-bias · ~13 sets",
    ex: [
      { name: "Leg Press (feet high)", note: "anchor · glute/ham bias", rx: "3 × 10–15", anchor: true },
      { name: "DB Romanian Deadlift", note: "push the load here", rx: "3 × 8–10" },
      { name: "DB Walking Lunge", rx: "2 × 10–12" },
      { name: "Calf Raise", rx: "3 × 12–15" },
      { name: "Plank / Cable Crunch", note: "optional", rx: "2 sets" },
    ],
  },
];
const MESO: { wk: string; effort: string; do: string; deload?: boolean }[] = [
  { wk: "1", effort: "RIR ~3", do: "set working weights, log" },
  { wk: "2", effort: "RIR ~2–3", do: "push reps; +1 set if recovering" },
  { wk: "3", effort: "RIR ~2", do: "add reps/load" },
  { wk: "4", effort: "RIR ~1", do: "hardest week" },
  { wk: "5", effort: "Deload", do: "~½ volume, lighter — clear fatigue", deload: true },
];

function Session({ s, acc, open }: { s: Sess; acc: string; open?: boolean }) {
  return (
    <details className="mb-2.5 overflow-hidden rounded-lg border border-edge" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between bg-raised px-3.5 py-3 text-sm font-semibold text-bone [&::-webkit-details-marker]:hidden">
        {s.title}
        <span className="font-mono text-[11px] font-medium text-faint">{s.meta}</span>
      </summary>
      <div>
        {s.ex.map((e, i) => (
          <div key={i} className="flex items-start justify-between gap-3 border-t border-edge px-3.5 py-2.5">
            <div className="text-[14px]">
              <span className="font-medium text-bone">{e.name}</span>
              {e.note && (
                <span className="mt-0.5 block font-mono text-[11.5px] text-faint">{e.note}</span>
              )}
            </div>
            <span
              className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[12.5px] font-semibold"
              style={
                e.anchor
                  ? { background: acc, color: "#0a0d12" }
                  : { background: acc + "1f", color: acc }
              }
            >
              {e.rx}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
