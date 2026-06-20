import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Minus,
  Plus,
  ScanLine,
  Search,
  Trash2,
  User,
  Users,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { BarcodeScanner } from "../components/BarcodeScanner";
import { lookupBarcode } from "../lib/barcode";
import { DAILY, type Food, type FoodRole } from "../lib/nutrition";
import {
  buildLibrary,
  contribution,
  dayTotals,
  mealTotals,
  rowId,
  searchFoods,
  todayStr,
  type DayLog,
  type LoggedItem,
  type Macros,
  type Meal,
  type Person,
} from "../lib/mealLog";
import { useStore } from "../store/FinanceStore";
import { useHealth } from "../store/HealthStore";
import { BRAND_GRADIENT } from "../lib/catColor";
import { CalibrationGauge } from "./CalibrationGauge";
import { t } from "../lib/i18n";

// The Daily Macro Summary pins to the top of the scroll (the Health header is
// non-sticky now) so it's the always-visible, most-important element.
const STICKY_TOP = "calc(env(safe-area-inset-top, 0px) + 6px)";

// ── palette ───────────────────────────────────────────────────────────────────
const PERSON_ACC: Record<Person, string> = { gino: "#ef8136", xinyan: "#2dd1c0" };
const PERSON_NAME: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };
const MACRO = { p: "#fb7185", c: "#38bdf8", f: "#f6c453" }; // protein / carb / fat
const TILE = { background: "#141a24", borderColor: "#232d3a" } as const;

const r0 = (n: number) => Math.round(n);
const other = (p: Person): Person => (p === "gino" ? "xinyan" : "gino");
// Meals are generic + dynamic — displayed by position so deletes renumber.
const mealName = (i: number) => `Meal ${i + 1}`;

const macroOf = (f: Food): Macros => ({ kcal: f.kcal, p: f.p, c: f.c, f: f.f });
const toItem = (f: Food, grams: number): LoggedItem => ({
  id: rowId(),
  foodId: f.id,
  name: f.name,
  role: f.role,
  grams,
  per100: macroOf(f),
});

// ── entry point ────────────────────────────────────────────────────────────────
export function MealBuilder({ owner, person }: { owner: Person; person: Person }) {
  const { data } = useStore();
  const [mode, setMode] = useState<"solo" | "together">(
    () => (localStorage.getItem("hb-meal-mode") as "solo" | "together") || "solo",
  );
  useEffect(() => localStorage.setItem("hb-meal-mode", mode), [mode]);

  // The big offline table loads on demand so it never weighs down finance mode.
  const [bundled, setBundled] = useState<Food[]>([]);
  useEffect(() => {
    let on = true;
    import("../lib/foodData").then((m) => on && setBundled(m.BUNDLED_FOODS)).catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  const library = useMemo(() => buildLibrary(bundled, data.foods), [bundled, data.foods]);

  return (
    <div className="flex flex-col gap-3 pb-8">
      {/* mode switch — Solo / Together */}
      <div
        className="flex rounded-full p-1 text-[13px]"
        style={{ background: "#141a24", border: "1px solid #232d3a" }}
      >
        <ModePill on={mode === "solo"} onClick={() => setMode("solo")} icon={<User size={14} />}>
          {t("Just me")}
        </ModePill>
        <ModePill
          on={mode === "together"}
          onClick={() => setMode("together")}
          icon={<Users size={14} />}
        >
          {t("Together")}
        </ModePill>
      </div>

      {mode === "solo" ? (
        <SoloMode key={person} person={person} library={library} />
      ) : (
        <TogetherMode key={owner} owner={owner} library={library} />
      )}
    </div>
  );
}

function ModePill({
  on,
  onClick,
  icon,
  children,
}: {
  on: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 font-semibold transition"
      style={on ? { background: "#34c5e8", color: "#06303a" } : { color: "#8b97a6" }}
    >
      {icon}
      {children}
    </button>
  );
}

// ── SOLO — one person's daily burndown ──────────────────────────────────────────
function SoloMode({ person, library }: { person: Person; library: Food[] }) {
  const today = todayStr();
  const target = DAILY[person] as Macros;
  const { getDay, setDay } = useHealth();
  const log = getDay(person, today);
  const update = (fn: (l: DayLog) => DayLog) => setDay(fn(getDay(person, today)));

  // sheet state: adding a food to a meal, or editing an existing item
  const [addTo, setAddTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mealId: string; item: LoggedItem } | null>(null);

  const eaten = dayTotals(log);

  const addMeal = (): string => {
    const id = rowId();
    update((l) => ({ ...l, meals: [...l.meals, { id, name: mealName(l.meals.length), items: [] }] }));
    return id;
  };
  const startNewMeal = () => setAddTo(addMeal());
  const addItem = (mealId: string, food: Food, grams: number) =>
    update((l) => ({
      ...l,
      meals: l.meals.map((m) =>
        m.id === mealId ? { ...m, items: [...m.items, toItem(food, grams)] } : m,
      ),
    }));
  const updateItem = (mealId: string, itemId: string, grams: number) =>
    update((l) => ({
      ...l,
      meals: l.meals.map((m) =>
        m.id === mealId
          ? { ...m, items: m.items.map((it) => (it.id === itemId ? { ...it, grams } : it)) }
          : m,
      ),
    }));
  const removeItem = (mealId: string, itemId: string) =>
    update((l) => ({
      ...l,
      meals: l.meals.map((m) =>
        m.id === mealId ? { ...m, items: m.items.filter((it) => it.id !== itemId) } : m,
      ),
    }));
  const removeMeal = (mealId: string) =>
    update((l) => ({ ...l, meals: l.meals.filter((m) => m.id !== mealId) }));

  return (
    <div className="flex flex-col gap-3">
      {/* sticky, always-visible Daily Macro Summary */}
      <div className="sticky z-30" style={{ top: STICKY_TOP }}>
        <DaySummary name={PERSON_NAME[person]} target={target} eaten={eaten} />
      </div>

      {/* meals — created dynamically, no fixed slots */}
      {log.meals.length === 0 ? (
        <button
          onClick={startNewMeal}
          className="flex flex-col items-center gap-1.5 rounded-[18px] border border-dashed py-8 text-center transition active:scale-[0.99]"
          style={{ borderColor: "#2a3644", background: "#0f141c" }}
        >
          <UtensilsCrossed size={22} style={{ color: "#46d18a" }} />
          <span className="text-[14px] font-semibold text-bone">{t("Add your first meal")}</span>
          <span className="text-[12px]" style={{ color: "#7e8a98" }}>{t("Search a food or scan a barcode")}</span>
        </button>
      ) : (
        log.meals.map((meal, i) => (
          <MealCard
            key={meal.id}
            index={i}
            meal={meal}
            onAddFood={() => setAddTo(meal.id)}
            onEditItem={(item) => setEditing({ mealId: meal.id, item })}
            onRemoveMeal={() => removeMeal(meal.id)}
          />
        ))
      )}

      {log.meals.length > 0 && (
        <button
          onClick={startNewMeal}
          className="flex items-center justify-center gap-2 rounded-[16px] border py-3 text-[13px] font-semibold text-bone transition active:scale-[0.99]"
          style={{ borderColor: "#232d3a", background: "#0f141c" }}
        >
          <Plus size={16} /> {t("Add a meal")}
        </button>
      )}

      {/* calibration — does the macro budget still fit the weekly scale? */}
      <CalibrationGauge person={person} acc={PERSON_ACC[person]} />

      {/* add a food to a meal */}
      <FoodSearchSheet
        open={addTo !== null}
        onClose={() => setAddTo(null)}
        library={library}
        title={t("Add food")}
        onAdd={(food, grams) => {
          if (addTo) addItem(addTo, food, grams);
        }}
      />

      {/* edit / remove an existing item */}
      <FoodSearchSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        library={library}
        title={t("Edit portion")}
        initialFood={
          editing
            ? ({
                id: editing.item.foodId,
                name: editing.item.name,
                role: editing.item.role,
                ...editing.item.per100,
              } as Food)
            : undefined
        }
        initialGrams={editing?.item.grams}
        onAdd={(_food, grams) => {
          if (editing) updateItem(editing.mealId, editing.item.id, grams);
        }}
        onRemove={() => {
          if (editing) removeItem(editing.mealId, editing.item.id);
        }}
      />
    </div>
  );
}

// ── TOGETHER — build one shared meal, double breakdown for both ─────────────────
interface SharedItem {
  rid: string;
  food: Food;
  g: Record<Person, number>;
}

function TogetherMode({ owner, library }: { owner: Person; library: Food[] }) {
  const today = todayStr();
  const you = owner;
  const partner = other(owner);
  const order: Person[] = [you, partner];

  // both day logs come from the shared store (single source of truth), so the
  // shared meal lands on each person's REAL remaining and syncs to their phone.
  const { getDay, setDay } = useHealth();
  const logs: Record<Person, DayLog> = { gino: getDay("gino", today), xinyan: getDay("xinyan", today) };
  const [shared, setShared] = useState<SharedItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const targets: Record<Person, Macros> = { gino: DAILY.gino, xinyan: DAILY.xinyan };
  // each person's meal contribution from the in-progress shared meal
  const sharedTotals = (p: Person): Macros =>
    mealTotals({ id: "x", name: "x", items: shared.filter((s) => s.g[p] > 0).map((s) => toItem(s.food, s.g[p])) });

  const addShared = (food: Food, youG: number, partnerG: number) =>
    setShared((s) => [...s, { rid: rowId(), food, g: { [you]: youG, [partner]: partnerG } as Record<Person, number> }]);
  const setGrams = (rid: string, p: Person, grams: number) =>
    setShared((s) => s.map((it) => (it.rid === rid ? { ...it, g: { ...it.g, [p]: Math.max(0, grams) } } : it)));
  const removeShared = (rid: string) => setShared((s) => s.filter((it) => it.rid !== rid));

  const logForBoth = () => {
    if (!shared.length) return;
    for (const p of ["gino", "xinyan"] as Person[]) {
      const items = shared.filter((s) => s.g[p] > 0).map((s) => toItem(s.food, s.g[p]));
      if (!items.length) continue;
      const log = getDay(p, today);
      const meal: Meal = { id: rowId(), name: mealName(log.meals.length), items };
      setDay({ ...log, meals: [...log.meals, meal] });
    }
    setShared([]);
    setToast(t("Logged for both 🍽️"));
    setTimeout(() => setToast(null), 2200);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* sticky dual Daily Macro Summary — live preview of the shared meal on top */}
      <div className="sticky z-30 grid grid-cols-2 gap-3" style={{ top: STICKY_TOP }}>
        {order.map((p) => {
          const live = dayTotals(logs[p]);
          const sh = sharedTotals(p);
          const totalEaten = { kcal: live.kcal + sh.kcal, p: live.p + sh.p, c: live.c + sh.c, f: live.f + sh.f };
          return <PersonSummary key={p} person={p} you={p === you} target={targets[p]} eaten={totalEaten} />;
        })}
      </div>

      {/* the shared meal */}
      <section className="rounded-[18px] border p-4" style={TILE}>
        <div className="mb-1 flex items-center gap-2">
          <UtensilsCrossed size={15} style={{ color: "#34c5e8" }} />
          <p className="text-[13.5px] font-semibold text-bone">{t("Shared meal")}</p>
        </div>
        <p className="mb-3 text-[11.5px]" style={{ color: "#7e8a98" }}>
          {t("Add a food, then set how much each of you eats.")}
        </p>

        {shared.length === 0 ? (
          <p className="py-4 text-center text-[12.5px]" style={{ color: "#7e8a98" }}>
            {t("Nothing added yet.")}
          </p>
        ) : (
          <>
            {/* column heads */}
            <div className="flex items-center gap-2 border-b pb-2 text-[10px] uppercase tracking-wider" style={{ borderColor: "#1b232e" }}>
              <span className="flex-1" style={{ color: "#5f6a78" }}>{t("Food")}</span>
              <span className="w-[88px] text-center" style={{ color: PERSON_ACC[you] }}>{t("You")}</span>
              <span className="w-[88px] text-center" style={{ color: PERSON_ACC[partner] }}>{PERSON_NAME[partner]}</span>
              <span className="w-4" />
            </div>
            {shared.map((it) => (
              <div key={it.rid} className="flex items-center gap-2 border-b py-2.5" style={{ borderColor: "#1b232e" }}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-bone">{it.food.name}</p>
                  <p className="num text-[10px]" style={{ color: "#7e8a98" }}>
                    {it.food.kcal} {t("kcal")}/100g
                  </p>
                </div>
                <GramPill value={it.g[you]} onChange={(v) => setGrams(it.rid, you, v)} color={PERSON_ACC[you]} />
                <GramPill value={it.g[partner]} onChange={(v) => setGrams(it.rid, partner, v)} color={PERSON_ACC[partner]} />
                <button onClick={() => removeShared(it.rid)} className="w-4 shrink-0" style={{ color: "#6b7686" }}>
                  <X size={15} />
                </button>
              </div>
            ))}

            {/* the double breakdown */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {order.map((p) => (
                <BreakdownCard key={p} person={p} you={p === you} totals={sharedTotals(p)} target={targets[p]} eaten={dayTotals(logs[p])} />
              ))}
            </div>
          </>
        )}

        <button
          onClick={() => setSearchOpen(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
          style={{ background: "rgba(52,197,232,0.13)", color: "#34c5e8" }}
        >
          <Plus size={15} /> {t("Add food to the meal")}
        </button>

        {shared.length > 0 && (
          <button
            onClick={logForBoth}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
            style={{ background: BRAND_GRADIENT }}
          >
            <Check size={16} /> {t("Log this meal for both")}
          </button>
        )}
      </section>

      {toast && (
        <div className="pop rounded-[14px] px-4 py-3 text-center text-[13px] font-semibold text-white" style={{ background: "#13211a", border: "1px solid #1f3a2c", color: "#9fe3c0" }}>
          {toast}
        </div>
      )}

      <FoodSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        library={library}
        title={t("Add food to the meal")}
        dual
        youName={t("You")}
        youAcc={PERSON_ACC[you]}
        partnerName={PERSON_NAME[partner]}
        partnerAcc={PERSON_ACC[partner]}
        onAddDual={(food, youG, partnerG) => addShared(food, youG, partnerG)}
      />
    </div>
  );
}

// ── presentational pieces ────────────────────────────────────────────────────
// An animated progress ring (SVG). The arc eases to its new length on every
// change, so adding a food visibly fills it.
function Ring({
  pct,
  over,
  size,
  stroke,
  color = "#ffffff",
  track = "rgba(255,255,255,0.25)",
  overColor = "#ffd1d1",
  children,
}: {
  pct: number;
  over: boolean;
  size: number;
  stroke: number;
  color?: string;
  track?: string;
  overColor?: string;
  children: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const off = C * (1 - Math.max(0, Math.min(1, pct)));
  const half = size / 2;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={half} cy={half} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={half}
          cy={half}
          r={r}
          fill="none"
          stroke={over ? overColor : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={off}
          style={{ transition: "stroke-dashoffset .55s cubic-bezier(.3,.85,.3,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

// The always-visible Daily Macro Summary — calorie ring + the three macros, each
// burning down live. The number pops on every change (the delta feedback).
function DaySummary({ name, target, eaten }: { name: string; target: Macros; eaten: Macros }) {
  const remK = target.kcal - eaten.kcal;
  const over = remK < 0;
  const pct = target.kcal > 0 ? eaten.kcal / target.kcal : 0;
  const macros = [
    { k: "P", color: MACRO.p, e: eaten.p, tg: target.p },
    { k: "C", color: MACRO.c, e: eaten.c, tg: target.c },
    { k: "F", color: MACRO.f, e: eaten.f, tg: target.f },
  ];
  return (
    <div className="rounded-[22px] px-5 py-4 text-white shadow-lg" style={{ background: BRAND_GRADIENT }}>
      <div className="flex items-center justify-between text-[11.5px] opacity-90">
        <span>{t("{name}'s day", { name })}</span>
        <span>{t("today")}</span>
      </div>
      <div className="mt-2 flex items-center gap-4">
        <Ring pct={pct} over={over} size={88} stroke={9}>
          <span key={r0(remK)} className="pop num text-[23px] font-bold leading-none">{r0(Math.abs(remK))}</span>
          <span className="text-[9px] font-semibold uppercase tracking-wide opacity-90">{over ? t("over") : t("left")}</span>
        </Ring>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-baseline justify-between text-[10.5px] opacity-90">
            <span className="font-semibold uppercase tracking-wide">{t("kcal")}</span>
            <span className="num">{t("{eaten} of {target}", { eaten: r0(eaten.kcal), target: r0(target.kcal) })}</span>
          </div>
          {macros.map((m) => {
            const d = m.tg - m.e; // remaining; negative = over
            const mp = m.tg > 0 ? Math.min(100, (m.e / m.tg) * 100) : 0;
            return (
              <div key={m.k}>
                <div className="flex items-baseline justify-between text-[10.5px]">
                  <span className="font-bold" style={{ color: m.color }}>{m.k}</span>
                  <span key={r0(d)} className="num pop" style={{ color: d < 0 ? "#ffdada" : "rgba(255,255,255,0.95)" }}>{r0(d)}g</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.25)" }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${mp}%`, background: d < 0 ? "#ffd1d1" : "#ffffff", transition: "width .45s cubic-bezier(.3,.85,.3,1)" }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Compact per-person summary for Together mode — a small accent ring + macros,
// previewing the shared meal on top of that person's day. Updates live.
function PersonSummary({ person, you, target, eaten }: { person: Person; you: boolean; target: Macros; eaten: Macros }) {
  const acc = PERSON_ACC[person];
  const remK = target.kcal - eaten.kcal;
  const over = remK < 0;
  const pct = target.kcal > 0 ? eaten.kcal / target.kcal : 0;
  return (
    <div className="rounded-[18px] border p-3" style={{ background: acc + "12", borderColor: acc + "55" }}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: acc }}>
        <span>{person === "gino" ? "▲" : "▼"}</span>
        {you ? t("You") : PERSON_NAME[person]}
      </div>
      <div className="mt-2 flex items-center gap-2.5">
        <Ring pct={pct} over={over} size={58} stroke={6} color={acc} track="#222b38" overColor="#f0556e">
          <span key={r0(remK)} className="pop num text-[15px] font-bold leading-none text-bone">{r0(Math.abs(remK))}</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="text-[10px]" style={{ color: over ? "#f0556e" : "#7e8a98" }}>
            {over ? t("kcal over") : t("kcal left")}
          </div>
          <div className="num mt-1 text-[10.5px] leading-tight" style={{ color: "#9aa6b2" }}>
            {r0(target.p - eaten.p)}P · {r0(target.c - eaten.c)}C · {r0(target.f - eaten.f)}F
          </div>
        </div>
      </div>
    </div>
  );
}

function BreakdownCard({ person, you, totals, target, eaten }: { person: Person; you: boolean; totals: Macros; target: Macros; eaten: Macros }) {
  const acc = PERSON_ACC[person];
  const afterRem = target.kcal - eaten.kcal - totals.kcal;
  return (
    <div className="rounded-[14px] border p-2.5" style={{ background: acc + "12", borderColor: acc + "55" }}>
      <p className="mb-1.5 text-[11.5px] font-semibold" style={{ color: acc }}>
        {you ? t("Your plate") : t("{name}'s plate", { name: PERSON_NAME[person] })}
      </p>
      <div className="num text-[18px] font-bold leading-none text-bone">{r0(totals.kcal)} <span className="text-[10px] font-normal" style={{ color: "#7e8a98" }}>{t("kcal")}</span></div>
      <div className="num mt-1 text-[11px]" style={{ color: "#9aa6b2" }}>
        {r0(totals.p)}P · {r0(totals.c)}C · {r0(totals.f)}F
      </div>
      <div className="mt-1.5 border-t pt-1.5 text-[10px]" style={{ borderColor: acc + "33", color: afterRem < 0 ? "#f0556e" : "#7e8a98" }}>
        {afterRem < 0
          ? t("{n} over after this", { n: r0(-afterRem) })
          : t("{n} kcal left after", { n: r0(afterRem) })}
      </div>
    </div>
  );
}

function MealCard({ index, meal, onAddFood, onEditItem, onRemoveMeal }: { index: number; meal: Meal; onAddFood: () => void; onEditItem: (it: LoggedItem) => void; onRemoveMeal: () => void }) {
  const tot = mealTotals(meal);
  return (
    <section className="rounded-[18px] border p-4" style={TILE}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-[14px] font-semibold text-bone">{t("Meal {n}", { n: index + 1 })}</div>
          <div className="num text-[11px]" style={{ color: "#7e8a98" }}>
            {r0(tot.kcal)} {t("kcal")} · {r0(tot.p)}P {r0(tot.c)}C {r0(tot.f)}F
          </div>
        </div>
        <button onClick={onRemoveMeal} className="p-1" style={{ color: "#6b7686" }} aria-label="Remove meal">
          <Trash2 size={15} />
        </button>
      </div>

      {meal.items.length > 0 &&
        meal.items.map((it) => {
          const c = contribution(it);
          return (
            <button
              key={it.id}
              onClick={() => onEditItem(it)}
              className="flex w-full items-center gap-2 border-b py-2 text-left last:border-0"
              style={{ borderColor: "#1b232e" }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-bone">{it.name}</div>
                <div className="num text-[10.5px]" style={{ color: "#7e8a98" }}>
                  {it.grams}g · {r0(c.kcal)} {t("kcal")}
                </div>
              </div>
              <span className="num text-[11px]" style={{ color: "#9aa6b2" }}>
                {r0(c.p)}P {r0(c.c)}C {r0(c.f)}F
              </span>
            </button>
          );
        })}

      <button
        onClick={onAddFood}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2 text-[12.5px] font-semibold transition active:scale-[0.98]"
        style={{ background: "rgba(52,197,232,0.13)", color: "#34c5e8" }}
      >
        <Plus size={14} /> {t("Add food")}
      </button>
    </section>
  );
}

// ── small controls ─────────────────────────────────────────────────────────────
// a compact grams editor used in the shared-meal rows (tap number to type)
function GramPill({ value, onChange, color }: { value: number; onChange: (v: number) => void; color: string }) {
  return (
    <span className="flex w-[88px] shrink-0 items-center justify-center gap-1">
      <button onClick={() => onChange(Math.max(0, value - 10))} className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: "#222b38", color: "#cbd5e1" }}>
        <Minus size={12} />
      </button>
      <NumField
        value={value}
        onChange={onChange}
        className="num w-[34px] rounded-md bg-transparent text-center text-[13px] font-semibold outline-none"
        style={{ color }}
      />
      <button onClick={() => onChange(Math.min(MAX_GRAMS, value + 10))} className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: "#222b38", color: "#cbd5e1" }}>
        <Plus size={12} />
      </button>
    </span>
  );
}

// ── the search / scan / portion sheet ───────────────────────────────────────────
interface SearchSheetProps {
  open: boolean;
  onClose: () => void;
  library: Food[];
  title: string;
  // single-portion add (solo)
  onAdd?: (food: Food, grams: number) => void;
  // edit an existing item (solo)
  initialFood?: Food;
  initialGrams?: number;
  onRemove?: () => void;
  // dual-portion add (together)
  dual?: boolean;
  youName?: string;
  youAcc?: string;
  partnerName?: string;
  partnerAcc?: string;
  onAddDual?: (food: Food, youG: number, partnerG: number) => void;
}

const digits = (s: string) => s.replace(/\D/g, "");
const ROLE_TINT: Record<FoodRole, string> = {
  protein: "#fb7185",
  carb: "#38bdf8",
  veg: "#22c55e",
  fat: "#f6c453",
  other: "#a78bfa",
};

function FoodSearchSheet(props: SearchSheetProps) {
  const { open, onClose, library, title, initialFood, initialGrams, dual } = props;
  const { addFood, data } = useStore();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Food | null>(null);
  const [transient, setTransient] = useState(false); // picked food isn't in the library yet
  const [scanOpen, setScanOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  // edit mode jumps straight to the portion view
  useEffect(() => {
    if (open) {
      setPicked(initialFood ?? null);
      setTransient(false);
      setCustomOpen(false);
      setQ("");
      setStatus(null);
    }
  }, [open, initialFood]);

  const results = useMemo(() => searchFoods(q, library, 40), [q, library]);
  const qd = digits(q);

  async function lookup(code: string) {
    const clean = digits(code);
    if (clean.length < 6) return;
    const inLib = library.find((x) => x.barcode && digits(x.barcode) === clean);
    if (inLib) {
      setPicked(inLib);
      setTransient(false);
      return;
    }
    const known = data.foods.find((x) => x.barcode && digits(x.barcode) === clean);
    if (known) {
      setPicked(known);
      setTransient(false);
      return;
    }
    setBusy(true);
    setStatus(t("Looking up…"));
    const r = await lookupBarcode(clean);
    setBusy(false);
    if (!r) {
      setStatus(t("Not in the food database — try a name search."));
      return;
    }
    setStatus(null);
    setPicked({ id: `scan-${clean}`, name: r.name, role: r.role, kcal: r.kcal, p: r.p, c: r.c, f: r.f, barcode: clean });
    setTransient(true);
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(0,0,0,.55)" }} onClick={onClose}>
        <div
          className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
          style={{ background: "#0f141c", border: "1px solid #232d3a", borderTop: "2px solid #34c5e8", borderRadius: "22px" }}
          onClick={(e) => e.stopPropagation()}
        >
          {picked ? (
            <PortionView
              food={picked}
              transient={transient}
              dual={dual}
              initialGrams={initialGrams}
              youName={props.youName}
              youAcc={props.youAcc}
              partnerName={props.partnerName}
              partnerAcc={props.partnerAcc}
              editing={!!initialFood}
              onBack={() => (initialFood ? onClose() : setPicked(null))}
              onRemove={props.onRemove ? () => { props.onRemove!(); onClose(); } : undefined}
              onConfirmSingle={(grams, save) => {
                if (save && transient) addFood({ name: picked.name, role: picked.role, kcal: picked.kcal, p: picked.p, c: picked.c, f: picked.f, barcode: picked.barcode });
                props.onAdd?.(picked, grams);
                if (initialFood) onClose();
                else { setPicked(null); setStatus(t("Added {name}", { name: picked.name })); }
              }}
              onConfirmDual={(yg, pg, save) => {
                if (save && transient) addFood({ name: picked.name, role: picked.role, kcal: picked.kcal, p: picked.p, c: picked.c, f: picked.f, barcode: picked.barcode });
                props.onAddDual?.(picked, yg, pg);
                setPicked(null);
                setStatus(t("Added {name}", { name: picked.name }));
              }}
            />
          ) : customOpen ? (
            <CustomFoodForm
              initialName={q}
              onBack={() => setCustomOpen(false)}
              onCreated={(food) => {
                addFood({ name: food.name, role: food.role, kcal: food.kcal, p: food.p, c: food.c, f: food.f });
                setCustomOpen(false);
                setPicked(food);
                setTransient(false);
              }}
            />
          ) : (
            <>
              <div className="flex items-center gap-2 p-4 pb-2">
                <div className="flex-1 text-[16px] font-bold text-bone">{title}</div>
                <button onClick={onClose} style={{ color: "#6b7686" }}>
                  <X size={20} />
                </button>
              </div>

              <div className="flex gap-2 px-4">
                <div className="flex flex-1 items-center gap-2 rounded-xl px-3" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
                  <Search size={16} style={{ color: "#6b7686" }} />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("Search a food…")}
                    className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[#5f6a78]"
                  />
                  {q && (
                    <button onClick={() => setQ("")} style={{ color: "#6b7686" }}>
                      <X size={15} />
                    </button>
                  )}
                </div>
                <button
                  onClick={() => setScanOpen(true)}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold"
                  style={{ background: "#34c5e8", color: "#06303a" }}
                >
                  <ScanLine size={16} /> {t("Scan")}
                </button>
              </div>

              {status && (
                <p className="mx-4 mt-2 rounded-lg px-3 py-2 text-[12px]" style={{ background: "#141a24", color: "#9aa6b2" }}>
                  {busy ? "… " : ""}
                  {status}
                </p>
              )}

              <div className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
                {results.length > 0 ? (
                  results.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => { setPicked(f); setTransient(false); }}
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition active:bg-[#141a24]"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[11px] font-bold" style={{ background: ROLE_TINT[f.role] + "22", color: ROLE_TINT[f.role] }}>
                        {f.kcal}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] text-bone">{f.name}</div>
                        <div className="num text-[10.5px]" style={{ color: "#7e8a98" }}>
                          {f.p}P · {f.c}C · {f.f}F {t("per 100g")}
                          {f.note ? ` · ${f.note}` : ""}
                        </div>
                      </div>
                      <Plus size={16} style={{ color: "#46d18a" }} />
                    </button>
                  ))
                ) : qd.length >= 6 ? (
                  <button onClick={() => lookup(qd)} className="m-2 flex w-[calc(100%-16px)] items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-semibold" style={{ background: "#0e2230", border: "1px solid #1d5066", color: "#34c5e8" }}>
                    <Search size={15} /> {t("Look up barcode {code}", { code: qd })}
                  </button>
                ) : (
                  <p className="px-3 py-8 text-center text-[13px]" style={{ color: "#7e8a98" }}>
                    {q ? t("No match. Try fewer words, scan, or enter the barcode.") : t("Search by name, scan, or type a barcode number.")}
                  </p>
                )}
              </div>

              <button
                onClick={() => setCustomOpen(true)}
                className="flex items-center justify-center gap-1.5 border-t py-3 text-[12.5px] font-semibold"
                style={{ borderColor: "#1b232e", color: "#8b97a6" }}
              >
                <Plus size={14} /> {t("Add a custom food")}
              </button>
            </>
          )}
        </div>
      </div>

      <BarcodeScanner open={scanOpen} onClose={() => setScanOpen(false)} onResult={(code) => { setScanOpen(false); lookup(code); }} />
    </>
  );
}

// portion editor — single (solo) or dual (together)
function PortionView({
  food,
  transient,
  dual,
  initialGrams,
  youName,
  youAcc,
  partnerName,
  partnerAcc,
  editing,
  onBack,
  onRemove,
  onConfirmSingle,
  onConfirmDual,
}: {
  food: Food;
  transient: boolean;
  dual?: boolean;
  initialGrams?: number;
  youName?: string;
  youAcc?: string;
  partnerName?: string;
  partnerAcc?: string;
  editing?: boolean;
  onBack: () => void;
  onRemove?: () => void;
  onConfirmSingle: (grams: number, save: boolean) => void;
  onConfirmDual: (youG: number, partnerG: number, save: boolean) => void;
}) {
  const base = food.serving && food.serving > 0 ? food.serving : 100;
  const [grams, setGrams] = useState(initialGrams ?? base);
  const [youG, setYouG] = useState(base);
  const [partnerG, setPartnerG] = useState(base);
  const [save, setSave] = useState(true);

  const contribAt = (g: number): Macros => ({
    kcal: (food.kcal * g) / 100,
    p: (food.p * g) / 100,
    c: (food.c * g) / 100,
    f: (food.f * g) / 100,
  });

  const quick: [string, number][] = food.serving
    ? [["½", base * 0.5], ["1", base], ["2", base * 2]]
    : [["50", 50], ["100", 100], ["150", 150], ["200", 200]];

  return (
    <div className="flex max-h-[88vh] flex-col">
      <div className="flex items-center gap-2 p-4 pb-2">
        <button onClick={onBack} style={{ color: "#8b97a6" }}>
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15.5px] font-bold text-bone">{food.name}</div>
          <div className="num text-[11px]" style={{ color: "#7e8a98" }}>
            {food.kcal} {t("kcal")} · {food.p}P {food.c}C {food.f}F {t("per 100g")}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-2">
        {dual ? (
          <>
            <DualPad label={youName ?? t("You")} color={youAcc ?? "#ef8136"} grams={youG} setGrams={setYouG} food={food} />
            <DualPad label={partnerName ?? ""} color={partnerAcc ?? "#2dd1c0"} grams={partnerG} setGrams={setPartnerG} food={food} />
          </>
        ) : (
          <>
            <GramRow grams={grams} setGrams={setGrams} />
            <div className="mb-3 flex gap-2">
              {quick.map(([lbl, g]) => (
                <button key={lbl} onClick={() => setGrams(Math.round(g as number))} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#9aa6b2" }}>
                  {lbl}{food.serving ? "×" : "g"}
                </button>
              ))}
            </div>
            <div className="rounded-xl p-3" style={TILE}>
              <div className="text-[11px]" style={{ color: "#7e8a98" }}>{t("This portion")}</div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="num text-[24px] font-bold text-bone">{r0(contribAt(grams).kcal)}</span>
                <span className="text-[11px]" style={{ color: "#7e8a98" }}>{t("kcal")}</span>
                <span className="num ml-auto text-[12px]" style={{ color: "#9aa6b2" }}>
                  {r0(contribAt(grams).p)}P · {r0(contribAt(grams).c)}C · {r0(contribAt(grams).f)}F
                </span>
              </div>
            </div>
          </>
        )}

        {transient && (
          <button onClick={() => setSave((s) => !s)} className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px]" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#9aa6b2" }}>
            <span className="flex h-4 w-4 items-center justify-center rounded" style={{ background: save ? "#34c5e8" : "transparent", border: save ? "none" : "1px solid #3a4654" }}>
              {save && <Check size={12} style={{ color: "#06303a" }} />}
            </span>
            {t("Save to my library for next time")}
          </button>
        )}
      </div>

      <div className="flex gap-2 p-4 pt-2">
        {editing && onRemove && (
          <button onClick={onRemove} className="flex items-center justify-center rounded-[14px] px-4 py-3 text-[14px] font-semibold" style={{ background: "rgba(240,85,110,0.13)", color: "#f0556e" }}>
            <Trash2 size={16} />
          </button>
        )}
        <button
          onClick={() => (dual ? onConfirmDual(youG, partnerG, save) : onConfirmSingle(grams, save))}
          className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: BRAND_GRADIENT }}
        >
          <Check size={16} /> {editing ? t("Save portion") : t("Add to meal")}
        </button>
      </div>
    </div>
  );
}

// A grams/number input that holds a STRING buffer so the field can be empty
// while you retype, and clamps [0, max] so a fat-fingered paste can never poison
// the saved log. Stepper buttons drive `value`, which re-syncs the buffer.
const MAX_GRAMS = 5000;
function NumField({
  value,
  onChange,
  max = MAX_GRAMS,
  className,
  style,
}: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const [buf, setBuf] = useState(value ? String(value) : "");
  useEffect(() => {
    const cur = buf === "" ? 0 : parseInt(buf, 10);
    if (cur !== value) setBuf(value ? String(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      value={buf}
      inputMode="numeric"
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, "");
        const next = raw === "" ? "" : String(Math.min(max, parseInt(raw, 10)));
        setBuf(next);
        onChange(next === "" ? 0 : parseInt(next, 10));
      }}
      className={className}
      style={style}
    />
  );
}

function GramRow({ grams, setGrams }: { grams: number; setGrams: (n: number) => void }) {
  return (
    <div className="mb-3 mt-1 flex items-center justify-center gap-3">
      <button onClick={() => setGrams(Math.max(0, grams - 10))} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#cbd5e1" }}>
        <Minus size={18} />
      </button>
      <div className="flex items-baseline gap-1">
        <NumField
          value={grams}
          onChange={setGrams}
          className="num w-[88px] bg-transparent text-center text-[34px] font-bold text-bone outline-none"
        />
        <span className="text-[14px] font-semibold" style={{ color: "#7e8a98" }}>g</span>
      </div>
      <button onClick={() => setGrams(Math.min(MAX_GRAMS, grams + 10))} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#cbd5e1" }}>
        <Plus size={18} />
      </button>
    </div>
  );
}

function DualPad({ label, color, grams, setGrams, food }: { label: string; color: string; grams: number; setGrams: (n: number) => void; food: Food }) {
  const k = grams / 100;
  return (
    <div className="mb-2.5 rounded-xl p-3" style={{ background: color + "12", border: `1px solid ${color}55` }}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold" style={{ color }}>{label}</span>
        <span className="num text-[11px]" style={{ color: "#9aa6b2" }}>
          {r0(food.kcal * k)} {t("kcal")} · {r0(food.p * k)}P {r0(food.c * k)}C {r0(food.f * k)}F
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => setGrams(Math.max(0, grams - 10))} className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: "#1a2230", color: "#cbd5e1" }}>
          <Minus size={15} />
        </button>
        <NumField
          value={grams}
          onChange={setGrams}
          className="num flex-1 rounded-lg py-1.5 text-center text-[18px] font-bold text-bone outline-none"
          style={{ background: "#0f141c" }}
        />
        <span className="text-[12px]" style={{ color: "#7e8a98" }}>g</span>
        <button onClick={() => setGrams(Math.min(MAX_GRAMS, grams + 10))} className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: "#1a2230", color: "#cbd5e1" }}>
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

// add a homemade / un-barcoded food by hand → saved to the library, then portioned
function CustomFoodForm({
  initialName,
  onBack,
  onCreated,
}: {
  initialName: string;
  onBack: () => void;
  onCreated: (food: Food) => void;
}) {
  const [name, setName] = useState(initialName);
  const [role, setRole] = useState<FoodRole>("protein");
  const [kcal, setKcal] = useState("");
  const [p, setP] = useState("");
  const [c, setC] = useState("");
  const [f, setF] = useState("");
  const [serving, setServing] = useState("");
  const n = (s: string) => Math.max(0, parseFloat(s) || 0);
  const valid = name.trim() !== "" && kcal !== "";
  const roles: FoodRole[] = ["protein", "carb", "veg", "fat", "other"];

  const inp = "w-full rounded-lg px-3 py-2.5 text-[14px] text-bone outline-none";
  const inpStyle = { background: "#0f141c", border: "1px solid #232d3a" } as const;

  return (
    <div className="flex max-h-[88vh] flex-col">
      <div className="flex items-center gap-2 p-4 pb-2">
        <button onClick={onBack} style={{ color: "#8b97a6" }}>
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 text-[15.5px] font-bold text-bone">{t("Add a custom food")}</div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-2">
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "#7e8a98" }}>{t("Name")}</label>
          <input className={inp} style={inpStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Mom's dumplings")} />
        </div>

        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "#7e8a98" }}>{t("Type")}</label>
          <div className="grid grid-cols-5 gap-1.5">
            {roles.map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className="rounded-lg py-2 text-[11px] font-semibold capitalize transition"
                style={role === r ? { background: ROLE_TINT[r], color: "#0a0d12" } : { background: "#141a24", color: "#8b97a6", border: "1px solid #232d3a" }}
              >
                {t(r)}
              </button>
            ))}
          </div>
        </div>

        <p className="text-[12px]" style={{ color: "#7e8a98" }}>{t("Macros per 100g (from the label or a recipe):")}</p>
        <div className="grid grid-cols-4 gap-2">
          {[
            { l: "kcal", v: kcal, set: setKcal },
            { l: "P", v: p, set: setP },
            { l: "C", v: c, set: setC },
            { l: "F", v: f, set: setF },
          ].map((fld) => (
            <div key={fld.l}>
              <label className="mb-1 block text-center text-[10px]" style={{ color: "#7e8a98" }}>{t(fld.l)}</label>
              <input className={`${inp} num px-2 text-center`} style={inpStyle} type="number" inputMode="decimal" value={fld.v} onChange={(e) => fld.set(e.target.value)} placeholder="0" />
            </div>
          ))}
        </div>

        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "#7e8a98" }}>{t("One serving (grams, optional)")}</label>
          <input className={`${inp} num`} style={inpStyle} type="number" inputMode="numeric" value={serving} onChange={(e) => setServing(e.target.value)} placeholder={t("e.g. 150")} />
        </div>
      </div>

      <div className="p-4 pt-2">
        <button
          onClick={() => {
            if (!valid) return;
            const sv = n(serving);
            onCreated({
              id: `custom-${rowId()}`,
              name: name.trim(),
              role,
              kcal: n(kcal),
              p: n(p),
              c: n(c),
              f: n(f),
              ...(sv > 0 ? { serving: Math.round(sv) } : {}),
              custom: true,
            });
          }}
          disabled={!valid}
          className="flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: BRAND_GRADIENT, opacity: valid ? 1 : 0.45 }}
        >
          <Check size={16} /> {t("Save & use")}
        </button>
      </div>
    </div>
  );
}
