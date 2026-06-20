import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Flame,
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
import { DAILY, unitFor, type Food, type FoodRole, type FoodUnit } from "../lib/nutrition";
import {
  amountLabel,
  buildLibrary,
  contribution,
  dayTotals,
  mealTotals,
  pluralizeUnit,
  rowId,
  searchFoods,
  todayStr,
  ZERO,
  type DayLog,
  type LoggedItem,
  type Macros,
  type Meal,
  type Person,
} from "../lib/mealLog";
import { useStore } from "../store/FinanceStore";
import { useHealth } from "../store/HealthStore";
import { adherenceStats, type DayStatus } from "../lib/adherence";
import { HEALTH, HEALTH_GRADIENT, HEALTH_HERO } from "../lib/catColor";
import { CalibrationGauge } from "./CalibrationGauge";
import { t } from "../lib/i18n";

// The Daily Macro Summary pins to the top of the scroll (the Health header is
// non-sticky now) so it's the always-visible, most-important element.
const STICKY_TOP = "calc(env(safe-area-inset-top, 0px) + 6px)";

// ── palette ───────────────────────────────────────────────────────────────────
const PERSON_ACC: Record<Person, string> = { gino: "#ef8136", xinyan: "#2dd1c0" };
const PERSON_NAME: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };
const MACRO = { p: "#fb7185", c: "#38bdf8", f: "#f6c453" }; // protein / carb / fat (dots + bars)
const MACRO_BRIGHT = { p: "#ff90a4", c: "#69c6ff", f: "#ffd66b" }; // higher-contrast for numbers on dark
const TILE = { background: "#141a24", borderColor: "#232d3a" } as const;

const r0 = (n: number) => Math.round(n);
const other = (p: Person): Person => (p === "gino" ? "xinyan" : "gino");
// Meals are generic + dynamic — displayed by position so deletes renumber.
const mealName = (i: number) => `Meal ${i + 1}`;

const macroOf = (f: Food): Macros => ({ kcal: f.kcal, p: f.p, c: f.c, f: f.f });

// How much of a food — either a gram weight, or a count of its natural unit
// (grams stays canonical = qty × unit.grams).
export interface Amount {
  grams: number;
  qty?: number;
  unit?: FoodUnit;
}
const toItem = (f: Food, a: Amount): LoggedItem => ({
  id: rowId(),
  foodId: f.id,
  name: f.name,
  role: f.role,
  grams: a.grams,
  per100: macroOf(f),
  qty: a.qty,
  unit: a.unit,
});
// scale an existing item (for shared-meal bowl portioning) by a fraction
const scaleItem = (it: LoggedItem, frac: number): LoggedItem => ({
  ...it,
  id: rowId(),
  grams: it.grams * frac,
  qty: it.qty != null ? it.qty * frac : undefined,
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
  const { getDay, setDay, mealDays } = useHealth();
  const log = getDay(person, today);
  const update = (fn: (l: DayLog) => DayLog) => setDay(fn(getDay(person, today)));

  // sheet state: adding a food to a meal, or editing an existing item
  const [addTo, setAddTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mealId: string; item: LoggedItem } | null>(null);
  const [estimateOpen, setEstimateOpen] = useState(false);
  // the meals collect into one collapsible "Today's Meals" container
  const [mealsOpen, setMealsOpen] = useState(true);

  // adherence + the gentle 8 PM nudge (in-app)
  const snoozeKey = `hb-nudge-snooze-${person}-${today}`;
  const [snoozed, setSnoozed] = useState(() => !!localStorage.getItem(snoozeKey));
  const afterEvening = new Date().getHours() >= 20;
  const showNudge = afterEvening && log.meals.length === 0 && !log.status && !snoozed;
  const stats = useMemo(() => adherenceStats(new Map(Object.entries(mealDays)), person, today), [mealDays, person, today]);
  const markSkipped = () => update((l) => ({ ...l, status: "skipped" }));
  const markEstimated = (note: string) => update((l) => ({ ...l, status: "estimated", note: note.trim() || undefined }));
  const snooze = () => { localStorage.setItem(snoozeKey, "1"); setSnoozed(true); };

  const eaten = dayTotals(log);

  const addMeal = (): string => {
    const id = rowId();
    update((l) => ({ ...l, meals: [...l.meals, { id, name: mealName(l.meals.length), items: [] }] }));
    return id;
  };
  const startNewMeal = () => setAddTo(addMeal());
  const addItem = (mealId: string, food: Food, amount: Amount) =>
    update((l) => ({
      ...l,
      meals: l.meals.map((m) =>
        m.id === mealId ? { ...m, items: [...m.items, toItem(food, amount)] } : m,
      ),
    }));
  const updateItem = (mealId: string, itemId: string, amount: Amount) =>
    update((l) => ({
      ...l,
      meals: l.meals.map((m) =>
        m.id === mealId
          ? { ...m, items: m.items.map((it) => (it.id === itemId ? { ...it, grams: amount.grams, qty: amount.qty, unit: amount.unit } : it)) }
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

      {/* the gentle 8 PM nudge */}
      {showNudge && <NudgeCard onYes={() => setEstimateOpen(true)} onNo={markSkipped} onLater={snooze} />}

      {/* meals — collected into one labeled, collapsible container so the main
          screen stays clean no matter how many get added */}
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
        <section className="overflow-hidden rounded-[16px] border" style={TILE}>
          {/* slim bar — stays small when collapsed */}
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg" style={{ background: HEALTH + "1f", color: HEALTH }}>
              <UtensilsCrossed size={13} />
            </span>
            <button onClick={() => setMealsOpen((o) => !o)} className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
              <span className="text-[13px] font-semibold text-bone">{t("Today's Meals")}</span>
              <span className="num text-[11px]" style={{ color: "#7e8a98" }}>
                {t(log.meals.length === 1 ? "{n} meal · {kcal} kcal" : "{n} meals · {kcal} kcal", {
                  n: log.meals.length,
                  kcal: r0(eaten.kcal),
                })}
              </span>
            </button>
            <button
              onClick={startNewMeal}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition active:scale-90"
              style={{ background: "rgba(52,197,232,0.14)", color: "#34c5e8" }}
              aria-label="Add a meal"
            >
              <Plus size={16} />
            </button>
            <button onClick={() => setMealsOpen((o) => !o)} className="shrink-0 p-1" aria-label="Toggle meals">
              <ChevronDown size={17} style={{ color: "#6b7686", transform: mealsOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
            </button>
          </div>

          {mealsOpen && (
            <div className="flex flex-col gap-2.5 px-3 pb-3">
              {log.meals.map((meal, i) => (
                <MealCard
                  key={meal.id}
                  index={i}
                  meal={meal}
                  onAddFood={() => setAddTo(meal.id)}
                  onEditItem={(item) => setEditing({ mealId: meal.id, item })}
                  onRemoveMeal={() => removeMeal(meal.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* adherence — streak + compliance over time */}
      <AdherenceCard stats={stats} acc={PERSON_ACC[person]} />

      {/* calibration — does the macro budget still fit the weekly scale? */}
      <CalibrationGauge person={person} acc={PERSON_ACC[person]} />

      {/* add a food to a meal */}
      <FoodSearchSheet
        open={addTo !== null}
        onClose={() => setAddTo(null)}
        library={library}
        title={t("Add food")}
        onAdd={(food, amount) => {
          if (addTo) addItem(addTo, food, amount);
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
                unit: editing.item.unit,
              } as Food)
            : undefined
        }
        initialAmount={editing ? { grams: editing.item.grams, qty: editing.item.qty, unit: editing.item.unit } : undefined}
        onAdd={(_food, amount) => {
          if (editing) updateItem(editing.mealId, editing.item.id, amount);
        }}
        onRemove={() => {
          if (editing) removeItem(editing.mealId, editing.item.id);
        }}
      />

      <EstimateSheet
        open={estimateOpen}
        onClose={() => setEstimateOpen(false)}
        onLog={(note) => { markEstimated(note); setEstimateOpen(false); }}
      />
    </div>
  );
}

// ── TOGETHER — build ONE shared dish, then split it into bowls per person ───────
interface DishItem {
  rid: string;
  food: Food;
  grams: number;
  qty?: number;
  unit?: FoodUnit;
}

function TogetherMode({ owner, library }: { owner: Person; library: Food[] }) {
  const today = todayStr();
  const you = owner;
  const partner = other(owner);
  const order: Person[] = [you, partner];

  const { getDay, setDay } = useHealth();
  const logs: Record<Person, DayLog> = { gino: getDay("gino", today), xinyan: getDay("xinyan", today) };
  const [dish, setDish] = useState<DishItem[]>([]);
  const [bowls, setBowls] = useState<Record<Person, number> | null>(null); // null = even split
  const [searchOpen, setSearchOpen] = useState(false);
  const [editDish, setEditDish] = useState<DishItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const targets: Record<Person, Macros> = { gino: DAILY.gino, xinyan: DAILY.xinyan };
  const dishItems = dish.map((d) => toItem(d.food, { grams: d.grams, qty: d.qty, unit: d.unit }));
  const dishMacros = mealTotals({ id: "x", name: "x", items: dishItems });
  const dishGrams = dish.reduce((s, d) => s + d.grams, 0);

  const effBowl = (p: Person) => (bowls ? bowls[p] ?? 0 : dishGrams / 2);
  const bowlMacros = (p: Person): Macros => {
    if (dishGrams <= 0) return { ...ZERO };
    const f = effBowl(p) / dishGrams;
    return { kcal: dishMacros.kcal * f, p: dishMacros.p * f, c: dishMacros.c * f, f: dishMacros.f * f };
  };
  const setBowl = (p: Person, v: number) =>
    setBowls((b) => {
      const cur = b ?? { gino: dishGrams / 2, xinyan: dishGrams / 2 };
      return { ...cur, [p]: Math.max(0, v) };
    });

  const addDishItem = (food: Food, a: Amount) =>
    setDish((d) => [...d, { rid: rowId(), food, grams: a.grams, qty: a.qty, unit: a.unit }]);
  const editDishItem = (rid: string, a: Amount) =>
    setDish((d) => d.map((x) => (x.rid === rid ? { ...x, grams: a.grams, qty: a.qty, unit: a.unit } : x)));
  const removeDish = (rid: string) => setDish((d) => d.filter((x) => x.rid !== rid));

  const logForBoth = () => {
    if (!dish.length || dishGrams <= 0) return;
    for (const p of ["gino", "xinyan"] as Person[]) {
      const f = effBowl(p) / dishGrams;
      if (f <= 0) continue;
      const items = dishItems.map((it) => scaleItem(it, f)).filter((it) => it.grams > 0.01);
      if (!items.length) continue;
      const log = getDay(p, today);
      setDay({ ...log, meals: [...log.meals, { id: rowId(), name: mealName(log.meals.length), items }] });
    }
    setDish([]);
    setBowls(null);
    setToast(t("Logged for both 🍽️"));
    setTimeout(() => setToast(null), 2200);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* sticky dual summary — each bowl previewed against that person's day */}
      <div className="sticky z-30 grid grid-cols-2 gap-3" style={{ top: STICKY_TOP }}>
        {order.map((p) => {
          const live = dayTotals(logs[p]);
          const bm = bowlMacros(p);
          const totalEaten = { kcal: live.kcal + bm.kcal, p: live.p + bm.p, c: live.c + bm.c, f: live.f + bm.f };
          return <PersonSummary key={p} person={p} you={p === you} target={targets[p]} eaten={totalEaten} />;
        })}
      </div>

      {/* the shared dish */}
      <section className="rounded-[18px] border p-4" style={TILE}>
        <div className="mb-1 flex items-center gap-2">
          <UtensilsCrossed size={15} style={{ color: "#34c5e8" }} />
          <p className="text-[13.5px] font-semibold text-bone">{t("Shared dish")}</p>
        </div>
        <p className="mb-3 text-[11.5px]" style={{ color: "#97a3b2" }}>
          {t("Add what went into the whole dish, then split it into bowls below.")}
        </p>

        {dish.length === 0 ? (
          <p className="py-4 text-center text-[12.5px]" style={{ color: "#7e8a98" }}>{t("Nothing added yet.")}</p>
        ) : (
          <>
            {dish.map((d) => {
              const it = toItem(d.food, { grams: d.grams, qty: d.qty, unit: d.unit });
              const c = contribution(it);
              return (
                <button
                  key={d.rid}
                  onClick={() => setEditDish(d)}
                  className="flex w-full items-center gap-2 border-b py-2.5 text-left last:border-0"
                  style={{ borderColor: "#1b232e" }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-bone">{d.food.name}</p>
                    <p className="num text-[10.5px]" style={{ color: "#7e8a98" }}>
                      {amountLabel(it)} · {r0(c.kcal)} {t("kcal")}
                    </p>
                  </div>
                  <span className="num text-[11px]" style={{ color: "#9aa6b2" }}>{r0(c.p)}P {r0(c.c)}C {r0(c.f)}F</span>
                  <button onClick={(e) => { e.stopPropagation(); removeDish(d.rid); }} className="w-4 shrink-0" style={{ color: "#6b7686" }}>
                    <X size={15} />
                  </button>
                </button>
              );
            })}
            <div className="mt-2.5 flex items-baseline justify-between rounded-[12px] px-3 py-2" style={{ background: "#0f141c" }}>
              <span className="stat-key" style={{ color: "#97a3b2" }}>{t("Whole dish")}</span>
              <span className="num text-[12px] font-semibold text-bone">
                {r0(dishMacros.kcal)} {t("kcal")} · {r0(dishMacros.p)}P {r0(dishMacros.c)}C {r0(dishMacros.f)}F · {r0(dishGrams)}g
              </span>
            </div>
          </>
        )}

        <button
          onClick={() => setSearchOpen(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
          style={{ background: "rgba(52,197,232,0.13)", color: "#34c5e8" }}
        >
          <Plus size={15} /> {t("Add ingredient")}
        </button>
      </section>

      {/* split into bowls */}
      {dish.length > 0 && (
        <section className="rounded-[18px] border p-4" style={TILE}>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[13.5px] font-semibold text-bone">{t("Split into bowls")}</p>
            <button onClick={() => setBowls(null)} className="text-[11.5px] font-semibold" style={{ color: "#34c5e8" }}>
              {t("Even split")}
            </button>
          </div>
          <p className="mb-3 text-[11.5px]" style={{ color: "#97a3b2" }}>
            {t("Roughly how much is in each bowl? Macros follow the portion.")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {order.map((p) => {
              const acc = PERSON_ACC[p];
              const bowl = effBowl(p);
              const bm = bowlMacros(p);
              const afterRem = targets[p].kcal - dayTotals(logs[p]).kcal - bm.kcal;
              const pct = dishGrams > 0 ? Math.round((bowl / dishGrams) * 100) : 0;
              return (
                <div key={p} className="rounded-[14px] border p-3" style={{ background: acc + "12", borderColor: acc + "55" }}>
                  <p className="text-[12px] font-semibold" style={{ color: acc }}>{p === you ? t("Your bowl") : t("{name}'s bowl", { name: PERSON_NAME[p] })}</p>
                  <div className="mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: "#0f141c", border: "1px solid #232d3a" }}>
                    <NumField value={Math.round(bowl)} onChange={(v) => setBowl(p, v)} className="num w-full bg-transparent text-[17px] font-bold text-bone outline-none" />
                    <span className="text-[11px]" style={{ color: "#7c8696" }}>g · {pct}%</span>
                  </div>
                  <div className="num mt-2 text-[14px] font-bold text-bone">{r0(bm.kcal)} <span className="text-[10px] font-normal" style={{ color: "#7c8696" }}>{t("kcal")}</span></div>
                  <div className="num text-[10.5px]" style={{ color: "#9aa6b2" }}>{r0(bm.p)}P · {r0(bm.c)}C · {r0(bm.f)}F</div>
                  <div className="mt-1.5 border-t pt-1.5 stat-key" style={{ borderColor: acc + "33", color: afterRem < 0 ? "#f0556e" : "#7c8696" }}>
                    {afterRem < 0 ? t("{n} over after", { n: r0(-afterRem) }) : t("{n} kcal left after", { n: r0(afterRem) })}
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={logForBoth}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
            style={{ background: HEALTH_GRADIENT }}
          >
            <Check size={16} /> {t("Log both bowls")}
          </button>
        </section>
      )}

      {toast && (
        <div className="pop rounded-[14px] px-4 py-3 text-center text-[13px] font-semibold" style={{ background: "#13211a", border: "1px solid #1f3a2c", color: "#9fe3c0" }}>
          {toast}
        </div>
      )}

      <FoodSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        library={library}
        title={t("Add ingredient")}
        onAdd={(food, amount) => addDishItem(food, amount)}
      />
      <FoodSearchSheet
        open={editDish !== null}
        onClose={() => setEditDish(null)}
        library={library}
        title={t("Edit ingredient")}
        initialFood={editDish ? ({ ...editDish.food } as Food) : undefined}
        initialAmount={editDish ? { grams: editDish.grams, qty: editDish.qty, unit: editDish.unit } : undefined}
        onAdd={(_food, amount) => { if (editDish) editDishItem(editDish.rid, amount); }}
        onRemove={() => { if (editDish) removeDish(editDish.rid); }}
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
    { k: t("Protein"), e: eaten.p, tg: target.p, color: MACRO.p, bright: MACRO_BRIGHT.p },
    { k: t("Carbs"), e: eaten.c, tg: target.c, color: MACRO.c, bright: MACRO_BRIGHT.c },
    { k: t("Fat"), e: eaten.f, tg: target.f, color: MACRO.f, bright: MACRO_BRIGHT.f },
  ];
  return (
    <div
      className="rounded-[26px] px-5 pb-4 pt-4 text-white"
      style={{
        background: HEALTH_HERO,
        border: "1px solid #232d3a",
        borderTop: `2px solid ${HEALTH}`,
        boxShadow: "0 12px 32px -14px rgba(2,12,24,.65)",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="stat-key" style={{ opacity: 0.92 }}>{t("{name}'s day", { name })}</span>
        <span className="stat-key" style={{ opacity: 0.78 }}>{t("today")}</span>
      </div>

      <div className="mt-2.5 flex items-center gap-4">
        <Ring pct={pct} over={over} size={96} stroke={10}>
          <span key={r0(remK)} className="bump stat text-[30px]">{r0(Math.abs(remK))}</span>
          <span className="stat-key mt-1" style={{ opacity: 0.9 }}>{over ? t("over") : t("left")}</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="stat-key" style={{ opacity: 0.82 }}>{t("calories")}</div>
          <div className="mt-1 num text-[17px] font-bold">
            {r0(eaten.kcal)}
            <span className="text-[13px] font-medium" style={{ opacity: 0.7 }}> / {r0(target.kcal)}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.22)" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, pct * 100)}%`, background: over ? "#ffd1d1" : "#ffffff", transition: "width .45s cubic-bezier(.3,.85,.3,1)" }}
            />
          </div>
        </div>
      </div>

      {/* dark inset so the macro colors pop — the high-contrast counters */}
      <div className="mt-3.5 grid grid-cols-3 gap-2 rounded-[18px] p-2.5" style={{ background: "rgba(3,10,20,0.30)" }}>
        {macros.map((m) => {
          const d = m.tg - m.e; // remaining; negative = over
          const mp = m.tg > 0 ? Math.min(100, (m.e / m.tg) * 100) : 0;
          const dOver = d < 0;
          return (
            <div key={m.k} className="px-1">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                <span className="stat-key" style={{ color: m.bright }}>{m.k}</span>
              </div>
              <div key={r0(d)} className="bump mt-1.5 flex items-baseline gap-[3px]">
                <span className="stat text-[20px]" style={{ color: dOver ? "#ff9aa6" : m.bright }}>{r0(Math.abs(d))}</span>
                <span className="text-[11px] font-semibold" style={{ color: dOver ? "#ff9aa6" : m.bright, opacity: 0.55 }}>g</span>
              </div>
              <div className="stat-key mt-1" style={{ opacity: 0.5 }}>{dOver ? t("over") : t("left")}</div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.13)" }}>
                <div className="h-full rounded-full" style={{ width: `${mp}%`, background: dOver ? "#ff6b7e" : m.color, transition: "width .45s cubic-bezier(.3,.85,.3,1)" }} />
              </div>
            </div>
          );
        })}
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
        <Ring pct={pct} over={over} size={60} stroke={7} color={acc} track="#222b38" overColor="#f0556e">
          <span key={r0(remK)} className="bump stat text-[16px] text-bone">{r0(Math.abs(remK))}</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="stat-key" style={{ color: over ? "#f0556e" : "#97a3b2" }}>
            {over ? t("kcal over") : t("kcal left")}
          </div>
          <div className="num mt-1 text-[11px] font-semibold leading-tight">
            <span style={{ color: MACRO_BRIGHT.p }}>{r0(target.p - eaten.p)}P</span>
            <span style={{ color: "#6b7686" }}> · </span>
            <span style={{ color: MACRO_BRIGHT.c }}>{r0(target.c - eaten.c)}C</span>
            <span style={{ color: "#6b7686" }}> · </span>
            <span style={{ color: MACRO_BRIGHT.f }}>{r0(target.f - eaten.f)}F</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── adherence: the gentle 8 PM nudge, the estimate sheet, the history card ──────
function NudgeCard({ onYes, onNo, onLater }: { onYes: () => void; onNo: () => void; onLater: () => void }) {
  return (
    <div className="rounded-[18px] border p-4" style={{ background: "#161a2e", borderColor: "#2a2f55" }}>
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ background: "#2a2416", color: "#f6c453" }}>
          <Flame size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-bone">{t("Did you follow the meal plan today?")}</p>
          <p className="mt-0.5 text-[12px]" style={{ color: "#97a3b2" }}>{t("Nothing's logged yet — a quick check-in keeps your history honest.")}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={onYes} className="flex-1 rounded-[12px] py-2.5 text-[13.5px] font-semibold text-white transition active:scale-[0.98]" style={{ background: HEALTH_GRADIENT }}>
          {t("Yes, I did")}
        </button>
        <button onClick={onNo} className="flex-1 rounded-[12px] py-2.5 text-[13.5px] font-semibold transition active:scale-[0.98]" style={{ background: "rgba(240,85,110,0.12)", color: "#f0556e" }}>
          {t("No, off-plan")}
        </button>
        <button onClick={onLater} className="px-2 text-[12px] font-medium" style={{ color: "#6b7686" }}>
          {t("Later")}
        </button>
      </div>
    </div>
  );
}

function EstimateSheet({ open, onClose, onLog }: { open: boolean; onClose: () => void; onLog: (note: string) => void }) {
  const [note, setNote] = useState("");
  useEffect(() => { if (open) setNote(""); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(0,0,0,.55)" }} onClick={onClose}>
      <div className="w-full max-w-[420px] overflow-hidden" style={{ background: "#0f141c", border: "1px solid #232d3a", borderTop: "2px solid #46d18a", borderRadius: "22px", padding: "16px" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <div className="flex-1 text-[16px] font-bold text-bone">{t("Nice — roughly what did you eat?")}</div>
          <button onClick={onClose} style={{ color: "#6b7686" }}><X size={20} /></button>
        </div>
        <p className="mt-1 text-[12px]" style={{ color: "#97a3b2" }}>{t("A quick note is enough. Today gets marked followed (estimated, ~on target).")}</p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
          rows={3}
          placeholder={t("e.g. chicken + rice + veg, a shake, a banana…")}
          className="mt-3 w-full resize-none rounded-xl px-3 py-2.5 text-[14px] text-bone outline-none placeholder:text-[#5f6a78]"
          style={{ background: "#141a24", border: "1px solid #232d3a" }}
        />
        <button
          onClick={() => onLog(note)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: HEALTH_GRADIENT }}
        >
          <Check size={16} /> {t("Log as followed")}
        </button>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<DayStatus, string> = {
  logged: "#46d18a",
  estimated: "#e3b341",
  skipped: "#f0556e",
  none: "#222b38",
};
function AdherenceCard({ stats, acc }: { stats: ReturnType<typeof adherenceStats>; acc: string }) {
  const pct = stats.compliancePct;
  const pctColor = pct == null ? "#7c8696" : pct >= 80 ? "#46d18a" : pct >= 50 ? "#e3b341" : "#f0556e";
  return (
    <section className="rounded-[18px] border p-4" style={TILE}>
      <div className="flex items-center justify-between">
        <p className="stat-key" style={{ color: acc }}>{t("Plan adherence")}</p>
        <div className="text-right">
          <span className="stat text-[20px]" style={{ color: pctColor }}>{pct == null ? "—" : `${pct}%`}</span>
          <span className="ml-1 stat-key" style={{ color: "#7c8696" }}>{t("on plan")}</span>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Flame size={15} style={{ color: stats.streak > 0 ? "#fb923c" : "#5f6a78" }} />
        <span className="text-[13px] font-semibold text-bone">
          {stats.streak > 0 ? t("{n}-day streak", { n: stats.streak }) : t("Log a day to start a streak")}
        </span>
      </div>
      <div className="mt-3 flex gap-1">
        {stats.recent.map((d, i) => (
          <span
            key={d.date}
            className="h-5 flex-1 rounded-[3px]"
            style={{ background: STATUS_COLOR[d.status], boxShadow: i === stats.recent.length - 1 ? `0 0 0 1.5px ${acc}` : "none" }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]" style={{ color: "#7c8696" }}>
        {([["logged", t("on plan")], ["estimated", t("estimated")], ["skipped", t("off plan")]] as [DayStatus, string][]).map(([k, label]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: STATUS_COLOR[k] }} /> {label}
          </span>
        ))}
      </div>
    </section>
  );
}

function MealCard({ index, meal, onAddFood, onEditItem, onRemoveMeal }: { index: number; meal: Meal; onAddFood: () => void; onEditItem: (it: LoggedItem) => void; onRemoveMeal: () => void }) {
  const tot = mealTotals(meal);
  return (
    <section className="rounded-[14px] border p-3.5" style={{ background: "#0f141c", borderColor: "#1f2937" }}>
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
                  {amountLabel(it)} · {r0(c.kcal)} {t("kcal")}
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

// ── the search / scan / portion sheet ───────────────────────────────────────────
interface SearchSheetProps {
  open: boolean;
  onClose: () => void;
  library: Food[];
  title: string;
  onAdd?: (food: Food, amount: Amount) => void;
  // edit an existing item / dish ingredient
  initialFood?: Food;
  initialAmount?: Amount;
  onRemove?: () => void;
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
  const { open, onClose, library, title, initialFood, initialAmount } = props;
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
              initialAmount={initialAmount}
              editing={!!initialFood}
              onBack={() => (initialFood ? onClose() : setPicked(null))}
              onRemove={props.onRemove ? () => { props.onRemove!(); onClose(); } : undefined}
              onConfirm={(amount, save) => {
                if (save && transient) addFood({ name: picked.name, role: picked.role, kcal: picked.kcal, p: picked.p, c: picked.c, f: picked.f, barcode: picked.barcode, unit: picked.unit });
                props.onAdd?.(picked, amount);
                if (initialFood) onClose();
                else { setPicked(null); setStatus(t("Added {name}", { name: picked.name })); }
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

// portion editor — pick the amount by NATURAL UNIT (3 eggs) or by GRAMS. Grams
// stays canonical; macros update live from whichever you use.
function PortionView({
  food,
  transient,
  initialAmount,
  editing,
  onBack,
  onRemove,
  onConfirm,
}: {
  food: Food;
  transient: boolean;
  initialAmount?: Amount;
  editing?: boolean;
  onBack: () => void;
  onRemove?: () => void;
  onConfirm: (amount: Amount, save: boolean) => void;
}) {
  // explicit unit, or one inferred from the food's name (eggs, bagels, steaks…)
  const unit = unitFor(food);
  const hasUnit = !!unit;
  const gPerUnit = unit?.grams ?? (food.serving && food.serving > 0 ? food.serving : 100);
  const base = food.serving && food.serving > 0 ? food.serving : 100;
  const startMode: "unit" | "grams" = initialAmount
    ? initialAmount.qty != null && initialAmount.unit
      ? "unit"
      : "grams"
    : hasUnit
      ? "unit"
      : "grams";
  const [mode, setMode] = useState<"unit" | "grams">(hasUnit ? startMode : "grams");
  const [grams, setGrams] = useState(initialAmount?.grams ?? base);
  const [qty, setQty] = useState(initialAmount?.qty ?? 1);
  const [save, setSave] = useState(true);

  const effGrams = mode === "unit" ? qty * gPerUnit : grams;
  const c: Macros = {
    kcal: (food.kcal * effGrams) / 100,
    p: (food.p * effGrams) / 100,
    c: (food.c * effGrams) / 100,
    f: (food.f * effGrams) / 100,
  };
  const amount = (): Amount =>
    mode === "unit" ? { grams: qty * gPerUnit, qty, unit } : { grams };

  const toUnit = () => {
    setQty(Math.max(0, Math.round((grams / gPerUnit) * 100) / 100) || 1);
    setMode("unit");
  };
  const toGrams = () => {
    setGrams(Math.round(qty * gPerUnit));
    setMode("grams");
  };
  const unitName = unit?.name ?? "unit";
  const gramQuick: [string, number][] = food.serving
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
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="num text-[13px] font-bold text-bone">
              {food.kcal}
              <span className="ml-0.5 text-[10px] font-semibold" style={{ color: "#8b97a6" }}>{t("kcal")}</span>
            </span>
            <span className="num text-[12px] font-bold" style={{ color: MACRO_BRIGHT.p }}>{food.p}P</span>
            <span className="num text-[12px] font-bold" style={{ color: MACRO_BRIGHT.c }}>{food.c}C</span>
            <span className="num text-[12px] font-bold" style={{ color: MACRO_BRIGHT.f }}>{food.f}F</span>
            <span className="text-[10px]" style={{ color: "#7e8a98" }}>{t("per 100g")}</span>
          </div>
          {hasUnit && (
            <div className="num mt-0.5 text-[11px]" style={{ color: "#9aa6b2" }}>
              {t("1 {unit} ≈ {g} g", { unit: unitName, g: r0(gPerUnit) })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-2">
        {hasUnit && (
          <div className="mb-3 flex rounded-full p-1 text-[12.5px]" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
            <button onClick={toUnit} className="flex-1 rounded-full py-1.5 font-semibold transition" style={mode === "unit" ? { background: "#34c5e8", color: "#06303a" } : { color: "#8b97a6" }}>
              {t("By the {unit}", { unit: unitName })}
            </button>
            <button onClick={toGrams} className="flex-1 rounded-full py-1.5 font-semibold transition" style={mode === "grams" ? { background: "#34c5e8", color: "#06303a" } : { color: "#8b97a6" }}>
              {t("Grams")}
            </button>
          </div>
        )}

        {mode === "unit" ? (
          <>
            <QtyRow qty={qty} setQty={setQty} unitName={pluralizeUnit(unitName, qty)} />
            <div className="mb-3 flex gap-2">
              {[1, 2, 3].map((n) => (
                <button key={n} onClick={() => setQty(n)} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#9aa6b2" }}>
                  {n}
                </button>
              ))}
            </div>
            <p className="mb-2 text-center text-[11px]" style={{ color: "#7c8696" }}>{t("= {n} g", { n: r0(effGrams) })}</p>
          </>
        ) : (
          <>
            <GramRow grams={grams} setGrams={setGrams} />
            <div className="mb-3 flex gap-2">
              {gramQuick.map(([lbl, g]) => (
                <button key={lbl} onClick={() => setGrams(Math.round(g))} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#9aa6b2" }}>
                  {lbl}{food.serving ? "×" : "g"}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="rounded-xl p-3.5" style={TILE}>
          <div className="flex items-center justify-between">
            <span className="stat-key" style={{ color: "#b7c0cc" }}>{t("This portion")}</span>
            <span className="flex items-baseline gap-1">
              <span className="stat text-[26px] text-bone">{r0(c.kcal)}</span>
              <span className="text-[11px] font-bold" style={{ color: "#97a3b2" }}>{t("kcal")}</span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              { k: t("Protein"), v: c.p, color: MACRO_BRIGHT.p },
              { k: t("Carbs"), v: c.c, color: MACRO_BRIGHT.c },
              { k: t("Fat"), v: c.f, color: MACRO_BRIGHT.f },
            ].map((m) => (
              <div key={m.k} className="rounded-lg px-2 py-2 text-center" style={{ background: "#0b0f17", border: "1px solid #1b232e" }}>
                <div className="flex items-baseline justify-center gap-0.5">
                  <span className="stat text-[19px]" style={{ color: m.color }}>{r0(m.v)}</span>
                  <span className="text-[10px] font-bold" style={{ color: m.color, opacity: 0.65 }}>g</span>
                </div>
                <div className="stat-key mt-0.5" style={{ color: "#8b97a6" }}>{m.k}</div>
              </div>
            ))}
          </div>
        </div>

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
          onClick={() => onConfirm(amount(), save)}
          className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: HEALTH_GRADIENT }}
        >
          <Check size={16} /> {editing ? t("Save portion") : t("Add to meal")}
        </button>
      </div>
    </div>
  );
}

// decimal qty stepper (1, 1.5, 2 …) for unit-based entry
function QtyRow({ qty, setQty, unitName }: { qty: number; setQty: (n: number) => void; unitName: string }) {
  const [buf, setBuf] = useState(String(qty));
  useEffect(() => {
    if (parseFloat(buf || "0") !== qty) setBuf(String(Math.round(qty * 100) / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty]);
  const step = (d: number) => setQty(Math.max(0, Math.min(99, Math.round((qty + d) * 100) / 100)));
  return (
    <div className="mb-3 mt-1 flex items-center justify-center gap-3">
      <button onClick={() => step(-1)} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#cbd5e1" }}>
        <Minus size={18} />
      </button>
      <div className="flex items-baseline gap-1.5">
        <input
          value={buf}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9.]/g, "");
            setBuf(raw);
            const n = parseFloat(raw);
            setQty(Number.isFinite(n) ? Math.min(99, n) : 0);
          }}
          inputMode="decimal"
          className="stat w-[72px] bg-transparent text-center text-[32px] text-bone outline-none"
        />
        <span className="text-[13px] font-semibold" style={{ color: "#7c8696" }}>{unitName}</span>
      </div>
      <button onClick={() => step(1)} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "#141a24", border: "1px solid #232d3a", color: "#cbd5e1" }}>
        <Plus size={18} />
      </button>
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
          style={{ background: HEALTH_GRADIENT, opacity: valid ? 1 : 0.45 }}
        >
          <Check size={16} /> {t("Save & use")}
        </button>
      </div>
    </div>
  );
}
