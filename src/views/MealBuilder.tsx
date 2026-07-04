import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronDown,
  Flame,
  Minus,
  Pencil,
  Plus,
  Scale,
  ScanLine,
  SlidersHorizontal,
  Search,
  Trash2,
  User,
  Users,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { BarcodeScanner } from "../components/BarcodeScanner";
import { lookupBarcode } from "../lib/barcode";
import { DAILY, unitFor, type Food, type FoodRole, type FoodUnit, type MacroTarget } from "../lib/nutrition";
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
  type SavedMeal,
} from "../lib/mealLog";
import { useStore } from "../store/FinanceStore";
import { useHealth } from "../store/HealthStore";
import { adherenceStats, weeklyAdherence, type DayStatus, type WeekBucket } from "../lib/adherence";
import { latestWeight, ratePerWeek } from "../lib/weightLog";
import { CalibrationGauge } from "./CalibrationGauge";
import { t } from "../lib/i18n";

// ── palette ───────────────────────────────────────────────────────────────────
const PERSON_ACC: Record<Person, string> = { gino: "#ef8136", xinyan: "#2dd1c0" };
const PERSON_NAME: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };
const MACRO = { p: "#fb7185", c: "#38bdf8", f: "#f6c453" }; // protein / carb / fat (dots + bars)
const MACRO_BRIGHT = { p: "#ff90a4", c: "#69c6ff", f: "#ffd66b" }; // higher-contrast for numbers on dark
// Card surface — reads the themed tokens so every `style={TILE}` card reskins
// with the Appearance chooser. (Was a hardcoded slate.)
const TILE = { background: "var(--color-tile)", borderColor: "var(--color-edge)" } as const;

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
        style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}
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
      style={on ? { background: "var(--color-accent)", color: "var(--h-on-accent)" } : { color: "var(--color-taupe)" }}
    >
      {icon}
      {children}
    </button>
  );
}

// ── SOLO — one person's daily burndown ──────────────────────────────────────────
function SoloMode({ person, library }: { person: Person; library: Food[] }) {
  const today = todayStr();
  const { getDay, setDay, mealDays, savedMeals, addSavedMeal, updateSavedMeal, deleteSavedMeal, macroTargets, setMacroTarget } = useHealth();
  const target = (macroTargets[person] ?? DAILY[person]) as Macros;
  // which day you're viewing/editing — default today; ◀ ▶ navigate, capped at today.
  const [viewDate, setViewDate] = useState(today);
  const shiftDate = (d: string, by: number) => {
    const dt = new Date(d + "T00:00:00");
    dt.setDate(dt.getDate() + by);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };
  const isToday = viewDate === today;
  const canNext = viewDate < today;
  const dateLabel = isToday
    ? t("Today")
    : viewDate === shiftDate(today, -1)
      ? t("Yesterday")
      : new Date(viewDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const log = getDay(person, viewDate);
  const update = (fn: (l: DayLog) => DayLog) => setDay(fn(getDay(person, viewDate)));

  // sheet state: adding a food to a meal, or editing an existing item
  const [addTo, setAddTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mealId: string; item: LoggedItem } | null>(null);
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [savingMeal, setSavingMeal] = useState<Meal | null>(null); // meal pending "save as favorite"
  const [preview, setPreview] = useState<SavedMeal | null>(null); // tap a saved meal → view/edit before adding
  const [editTargets, setEditTargets] = useState(false); // edit this person's daily macro targets
  // the meals collect into one collapsible "Today's Meals" container — its
  // open/closed state persists (localStorage) so switching modes and coming back
  // doesn't blow it open again.
  const [detailOpen, setDetailOpen] = useState<null | "week" | "weight">(null); // 2-up tile → full card

  // adherence + the gentle 8 PM nudge (in-app)
  const snoozeKey = `hb-nudge-snooze-${person}-${today}`;
  const [snoozed, setSnoozed] = useState(() => !!localStorage.getItem(snoozeKey));
  const afterEvening = new Date().getHours() >= 20;
  const showNudge = isToday && afterEvening && log.meals.length === 0 && !log.status && !snoozed;
  const stats = useMemo(() => adherenceStats(new Map(Object.entries(mealDays)), person, today, target), [mealDays, person, today, target]);
  const weeks = useMemo(() => weeklyAdherence(new Map(Object.entries(mealDays)), person, today, target), [mealDays, person, today, target]);
  const markSkipped = () => update((l) => ({ ...l, status: "skipped" }));
  const markEstimated = (note: string) => update((l) => ({ ...l, status: "estimated", note: note.trim() || undefined }));
  const snooze = () => { localStorage.setItem(snoozeKey, "1"); setSnoozed(true); };

  const eaten = dayTotals(log);

  const addMeal = (): string => {
    const id = rowId();
    update((l) => ({ ...l, meals: [...l.meals, { id, name: "", items: [] }] }));
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
  // re-add a saved meal as a fresh meal today (clone items with new ids)
  const addSavedToDay = (m: SavedMeal) =>
    update((l) => ({
      ...l,
      meals: [...l.meals, { id: rowId(), name: m.name, items: m.items.map((it) => ({ ...it, id: rowId() })) }],
    }));

  return (
    <div className="flex flex-col gap-3">
      {/* control row — Targets + day nav (mock .ctl; the Just me / Together
          toggle is the parent's ModePill just above) */}
      <div className="hb-ctl">
        <button className="hb-targets" onClick={() => setEditTargets(true)}>
          <SlidersHorizontal size={12} /> {t("Targets")}
        </button>
        <div className="flex-1" />
        <div className="hb-daynav">
          <button onClick={() => setViewDate((d) => shiftDate(d, -1))} aria-label="Previous day">‹</button>
          <button className="td" onClick={isToday ? undefined : () => setViewDate(today)} disabled={isToday}>{dateLabel}</button>
          <button onClick={() => canNext && setViewDate((d) => shiftDate(d, 1))} disabled={!canNext} aria-label="Next day">›</button>
        </div>
      </div>

      {/* hero */}
      <DaySummary target={target} eaten={eaten} meals={log.meals.length} />

      {/* the gentle 8 PM nudge */}
      {showNudge && <NudgeCard onYes={() => setEstimateOpen(true)} onNo={markSkipped} onLater={snooze} />}

      {/* bento — 2-up tiles + meals + saved (mock .bento) */}
      <div className="hb-bento">
        <WeekTile weeks={weeks} today={today} onOpen={() => setDetailOpen("week")} />
        <WeightTile person={person} onOpen={() => setDetailOpen("weight")} />

        {log.meals.length === 0 ? (
          <button onClick={startNewMeal} className="hb-tile full flex flex-col items-center gap-1.5 py-8 text-center" style={{ borderStyle: "dashed" }}>
            <UtensilsCrossed size={22} style={{ color: "var(--color-accent)" }} />
            <span className="text-[14px] font-semibold" style={{ color: "var(--color-bone)" }}>{t("Add your first meal")}</span>
            <span className="text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("Search a food or scan a barcode")}</span>
          </button>
        ) : (
          <div className="hb-panel full">
            <div className="hb-mealhead">
              <span className="ic"><UtensilsCrossed size={14} /></span>
              <div style={{ flex: 1 }}>
                <div className="t">{isToday ? t("Today's meals") : dateLabel}</div>
                <div className="s">{t(log.meals.length === 1 ? "{n} meal · {kcal} kcal" : "{n} meals · {kcal} kcal", { n: log.meals.length, kcal: r0(eaten.kcal) })}</div>
              </div>
            </div>
            {log.meals.map((meal, i) => (
              <MealCard
                key={meal.id}
                index={i}
                meal={meal}
                onAddFood={() => setAddTo(meal.id)}
                onEditItem={(item) => setEditing({ mealId: meal.id, item })}
                onRemoveMeal={() => removeMeal(meal.id)}
                onSave={() => setSavingMeal(meal)}
              />
            ))}
            <button className="hb-addbtn" onClick={startNewMeal}><Plus size={14} /> {t("Add meal")}</button>
          </div>
        )}

        {savedMeals.length > 0 && (
          <div className="hb-panel full">
            <div className="hb-saved">
              <Bookmark size={13} style={{ color: "var(--color-accent)" }} />
              <span className="t">{t("Saved meals")}</span>
              <span className="hb-tiny">{savedMeals.length}</span>
            </div>
            <div className="hb-chipsrow">
              {savedMeals.map((m) => (
                <span key={m.id} className="hb-sc inline-flex items-center gap-1.5">
                  <button onClick={() => setPreview(m)} className="min-w-0 truncate">{m.name}</button>
                  <button onClick={() => deleteSavedMeal(m.id)} aria-label="Delete saved meal" style={{ color: "var(--color-faint)" }}><X size={12} /></button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

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

      <SaveMealSheet
        open={savingMeal !== null}
        defaultName={savingMeal ? savingMeal.items.map((it) => it.name).join(", ").slice(0, 40) : ""}
        onClose={() => setSavingMeal(null)}
        onSave={(name, keepInDay) => {
          if (savingMeal) {
            addSavedMeal(name, savingMeal.items);
            if (!keepInDay) removeMeal(savingMeal.id); // save to library only — don't log it to today
          }
          setSavingMeal(null);
        }}
      />

      {/* tap a saved meal → view / edit it in place, or add it to today */}
      <SavedMealEditor
        meal={preview}
        library={library}
        onClose={() => setPreview(null)}
        onAddToday={(m) => addSavedToDay(m)}
        onUpdate={(id, name, items) => updateSavedMeal(id, name, items)}
      />

      {/* edit this person's daily macro targets */}
      <EditTargetsSheet
        open={editTargets}
        name={PERSON_NAME[person]}
        target={target}
        onClose={() => setEditTargets(false)}
        onSave={(tg) => { setMacroTarget(person, tg); setEditTargets(false); }}
      />

      {/* a 2-up tile tapped → its full card (trend / weigh-in) */}
      {detailOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center" style={{ background: "rgba(0,0,0,.55)" }} onClick={() => setDetailOpen(null)}>
          <div className="max-h-[88vh] w-full max-w-[440px] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {detailOpen === "week" ? (
              <AdherenceCard stats={stats} weeks={weeks} today={today} acc={PERSON_ACC[person]} activeDate={viewDate} />
            ) : (
              <CalibrationGauge person={person} acc={PERSON_ACC[person]} />
            )}
          </div>
        </div>
      )}
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
  share: number; // fraction (0..1) of THIS ingredient that goes to YOU (owner); the partner gets the rest
}

function TogetherMode({ owner, library }: { owner: Person; library: Food[] }) {
  const today = todayStr();
  const you = owner;
  const partner = other(owner);
  const order: Person[] = [you, partner];

  const { getDay, setDay, savedMeals, addSavedMeal, deleteSavedMeal, macroTargets } = useHealth();
  const logs: Record<Person, DayLog> = { gino: getDay("gino", today), xinyan: getDay("xinyan", today) };
  const [dish, setDish] = useState<DishItem[]>([]);
  // the split you last used, remembered so the next ingredient defaults to it
  // (most dishes split the same way) instead of a meaningless 50/50.
  const [lastShare, setLastShare] = useState(() => {
    const v = parseFloat(localStorage.getItem("hb-dish-share") || "0.5");
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
  });
  const bumpShare = (s: number) => { setLastShare(s); localStorage.setItem("hb-dish-share", String(s)); };
  const [searchOpen, setSearchOpen] = useState(false);
  const [editDish, setEditDish] = useState<DishItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [savingDish, setSavingDish] = useState(false);
  // editing an ALREADY-LOGGED meal from "Eaten today" (fix a portion you got wrong)
  const [editLogged, setEditLogged] = useState<{ person: Person; mealId: string; item: LoggedItem } | null>(null);

  const targets: Record<Person, Macros> = {
    gino: (macroTargets.gino ?? DAILY.gino) as Macros,
    xinyan: (macroTargets.xinyan ?? DAILY.xinyan) as Macros,
  };
  const dishItems = dish.map((d) => toItem(d.food, { grams: d.grams, qty: d.qty, unit: d.unit }));
  const dishMacros = mealTotals({ id: "x", name: "x", items: dishItems });
  const dishGrams = dish.reduce((s, d) => s + d.grams, 0);

  // each ingredient splits INDEPENDENTLY: `share` = fraction to YOU (owner), the
  // partner gets 1 − share. A person's meal is the sum of their share of every
  // ingredient — so "I ate most of the chicken, she had more rice" is expressible.
  const shareFor = (d: DishItem, p: Person) => (p === you ? d.share : 1 - d.share);
  const personMacros = (p: Person): Macros =>
    dish.reduce(
      (acc, d) => {
        const g = d.grams * shareFor(d, p);
        return { kcal: acc.kcal + (d.food.kcal * g) / 100, p: acc.p + (d.food.p * g) / 100, c: acc.c + (d.food.c * g) / 100, f: acc.f + (d.food.f * g) / 100 };
      },
      { ...ZERO },
    );
  const setShare = (rid: string, s: number) => {
    const share = Math.max(0, Math.min(1, s));
    setDish((d) => d.map((x) => (x.rid === rid ? { ...x, share } : x)));
    bumpShare(share);
  };

  const addDishItem = (food: Food, a: Amount) =>
    setDish((d) => [...d, { rid: rowId(), food, grams: a.grams, qty: a.qty, unit: a.unit, share: lastShare }]);
  const editDishItem = (rid: string, a: Amount) =>
    setDish((d) => d.map((x) => (x.rid === rid ? { ...x, grams: a.grams, qty: a.qty, unit: a.unit } : x)));
  const removeDish = (rid: string) => setDish((d) => d.filter((x) => x.rid !== rid));
  // drop a saved meal's items into the shared dish (reconstruct Food from each);
  // each lands at your last split, then you fine-tune per ingredient.
  const addSavedToDish = (m: SavedMeal) =>
    setDish((d) => [
      ...d,
      ...m.items.map((it) => ({ rid: rowId(), food: foodFromItem(it), grams: it.grams, qty: it.qty, unit: it.unit, share: lastShare })),
    ]);

  // edit / remove items on an already-logged day meal (from "Eaten today"), and
  // delete a whole logged meal — so a wrong split can be fixed after the fact.
  const updateLoggedItem = (person: Person, mealId: string, itemId: string, a: Amount) => {
    const log = getDay(person, today);
    setDay({
      ...log,
      meals: log.meals.map((m) =>
        m.id === mealId ? { ...m, items: m.items.map((it) => (it.id === itemId ? { ...it, grams: a.grams, qty: a.qty, unit: a.unit } : it)) } : m,
      ),
    });
  };
  const removeLoggedItem = (person: Person, mealId: string, itemId: string) => {
    const log = getDay(person, today);
    setDay({
      ...log,
      meals: log.meals
        .map((m) => (m.id === mealId ? { ...m, items: m.items.filter((it) => it.id !== itemId) } : m))
        .filter((m) => m.items.length > 0),
    });
  };
  const removeLoggedMeal = (person: Person, mealId: string) => {
    const log = getDay(person, today);
    setDay({ ...log, meals: log.meals.filter((m) => m.id !== mealId) });
  };

  const logForBoth = () => {
    if (!dish.length || dishGrams <= 0) return;
    for (const p of order) {
      // each person gets their SHARE of every ingredient (grams-scaled per item)
      const items = dish
        .map((d) => toItem(d.food, { grams: d.grams * shareFor(d, p) }))
        .filter((it) => it.grams > 0.01);
      if (!items.length) continue;
      const log = getDay(p, today);
      setDay({ ...log, meals: [...log.meals, { id: rowId(), name: mealName(log.meals.length), items }] });
    }
    setDish([]);
    setToast(t("Logged for both 🍽️"));
    setTimeout(() => setToast(null), 2200);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* dual summary — each bowl previewed against that person's day; scrolls
          with the page (no longer pinned to the top) */}
      <div className="grid grid-cols-2 gap-3">
        {order.map((p) => {
          const live = dayTotals(logs[p]);
          const bm = personMacros(p);
          const totalEaten = { kcal: live.kcal + bm.kcal, p: live.p + bm.p, c: live.c + bm.c, f: live.f + bm.f };
          return <PersonSummary key={p} person={p} you={p === you} target={targets[p]} eaten={totalEaten} />;
        })}
      </div>

      {/* accountability + fix-ups — what each of you has eaten today, editable */}
      <EatenTogether
        logs={logs}
        order={order}
        you={you}
        onEditItem={(person, mealId, item) => setEditLogged({ person, mealId, item })}
        onRemoveMeal={removeLoggedMeal}
      />

      {/* saved / favorite meals — tap to drop into the dish */}
      <SavedMealsBar meals={savedMeals} onPick={addSavedToDish} onDelete={deleteSavedMeal} />

      {/* the shared dish */}
      <section className="rounded-[18px] border p-4" style={TILE}>
        <div className="mb-1 flex items-center gap-2">
          <UtensilsCrossed size={15} style={{ color: "var(--color-accent)" }} />
          <p className="text-[13.5px] font-semibold text-bone">{t("Shared dish")}</p>
        </div>
        <p className="mb-3 text-[11.5px]" style={{ color: "var(--color-taupe)" }}>
          {t("Add what went in, then set how much of each ingredient is yours vs {name}'s.", { name: PERSON_NAME[partner] })}
        </p>

        {dish.length === 0 ? (
          <p className="py-4 text-center text-[12.5px]" style={{ color: "var(--color-taupe)" }}>{t("Nothing added yet.")}</p>
        ) : (
          <>
            {dish.map((d) => {
              const it = toItem(d.food, { grams: d.grams, qty: d.qty, unit: d.unit });
              const c = contribution(it);
              const pct = Math.round(d.share * 100);
              return (
                <div key={d.rid} className="border-b py-2.5 last:border-0" style={{ borderColor: "var(--color-edge)" }}>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setEditDish(d)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-[13px] text-bone">{d.food.name}</p>
                      <p className="num text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
                        {amountLabel(it)} · {r0(c.kcal)} {t("kcal")}
                      </p>
                    </button>
                    <span className="num text-[11px]" style={{ color: "var(--color-taupe)" }}>{r0(c.p)}P {r0(c.c)}C {r0(c.f)}F</span>
                    <button onClick={() => removeDish(d.rid)} className="w-4 shrink-0" style={{ color: "var(--color-faint)" }} aria-label="Remove ingredient">
                      <X size={15} />
                    </button>
                  </div>
                  {/* per-ingredient split: drag to set how much is yours vs the partner's */}
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="w-[54px] shrink-0 text-[10px] font-semibold" style={{ color: PERSON_ACC[you] }}>{t("You")} {pct}%</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={10}
                      value={pct}
                      onChange={(e) => setShare(d.rid, Number(e.target.value) / 100)}
                      className="h-1.5 flex-1 cursor-pointer"
                      style={{ accentColor: PERSON_ACC[you] }}
                      aria-label={`Your share of ${d.food.name}`}
                    />
                    <span className="w-[64px] shrink-0 text-right text-[10px] font-semibold" style={{ color: PERSON_ACC[partner] }}>{PERSON_NAME[partner]} {100 - pct}%</span>
                  </div>
                </div>
              );
            })}
            <div className="mt-2.5 flex items-baseline justify-between rounded-[12px] px-3 py-2" style={{ background: "var(--color-raised)" }}>
              <span className="stat-key" style={{ color: "var(--color-taupe)" }}>{t("Whole dish")}</span>
              <span className="num text-[12px] font-semibold text-bone">
                {r0(dishMacros.kcal)} {t("kcal")} · {r0(dishMacros.p)}P {r0(dishMacros.c)}C {r0(dishMacros.f)}F · {r0(dishGrams)}g
              </span>
            </div>
          </>
        )}

        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
            style={{ background: "rgba(52,197,232,0.13)", color: "var(--color-accent)" }}
          >
            <Plus size={15} /> {t("Add ingredient")}
          </button>
          {dish.length > 0 && (
            <>
              <button
                onClick={() => setSavingDish(true)}
                className="flex items-center justify-center gap-1.5 rounded-[14px] px-3.5 py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
                style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}
              >
                <Bookmark size={15} /> {t("Save")}
              </button>
              <button
                onClick={() => setDish([])}
                className="flex items-center justify-center rounded-[14px] px-3.5 py-2.5 text-[13px] font-semibold transition active:scale-[0.98]"
                style={{ background: "rgba(240,85,110,0.10)", color: "#f0556e" }}
                aria-label="Clear dish"
              >
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
      </section>

      {/* what each person's share adds up to — from the per-ingredient splits */}
      {dish.length > 0 && (
        <section className="rounded-[18px] border p-4" style={TILE}>
          <p className="mb-2.5 text-[13.5px] font-semibold text-bone">{t("Each of you gets")}</p>
          <div className="grid grid-cols-2 gap-3">
            {order.map((p) => {
              const acc = PERSON_ACC[p];
              const bm = personMacros(p);
              const afterRem = targets[p].kcal - dayTotals(logs[p]).kcal - bm.kcal;
              return (
                <div key={p} className="rounded-[14px] border p-3" style={{ background: acc + "12", borderColor: acc + "55" }}>
                  <p className="text-[12px] font-semibold" style={{ color: acc }}>{p === you ? t("You") : PERSON_NAME[p]}</p>
                  <div className="num mt-2 text-[16px] font-bold text-bone">{r0(bm.kcal)} <span className="text-[10px] font-normal" style={{ color: "var(--color-taupe)" }}>{t("kcal")}</span></div>
                  <div className="num text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{r0(bm.p)}P · {r0(bm.c)}C · {r0(bm.f)}F</div>
                  <div className="mt-1.5 border-t pt-1.5 stat-key" style={{ borderColor: acc + "33", color: afterRem < 0 ? "#f0556e" : "var(--color-taupe)" }}>
                    {afterRem < 0 ? t("{n} over after", { n: r0(-afterRem) }) : t("{n} kcal left after", { n: r0(afterRem) })}
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={logForBoth}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
            style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
          >
            <Check size={16} /> {t("Log both meals")}
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

      {/* edit a portion on an already-logged meal (from "Eaten today") */}
      <FoodSearchSheet
        open={editLogged !== null}
        onClose={() => setEditLogged(null)}
        library={library}
        title={t("Edit portion")}
        initialFood={
          editLogged
            ? ({ id: editLogged.item.foodId, name: editLogged.item.name, role: editLogged.item.role, ...editLogged.item.per100, unit: editLogged.item.unit } as Food)
            : undefined
        }
        initialAmount={editLogged ? { grams: editLogged.item.grams, qty: editLogged.item.qty, unit: editLogged.item.unit } : undefined}
        onAdd={(_food, amount) => { if (editLogged) updateLoggedItem(editLogged.person, editLogged.mealId, editLogged.item.id, amount); }}
        onRemove={() => { if (editLogged) removeLoggedItem(editLogged.person, editLogged.mealId, editLogged.item.id); }}
      />

      <SaveMealSheet
        open={savingDish}
        defaultName={dish.map((d) => d.food.name).join(", ").slice(0, 40)}
        onClose={() => setSavingDish(false)}
        onSave={(name) => { addSavedMeal(name, dishItems); setSavingDish(false); setToast(t("Saved ✓")); setTimeout(() => setToast(null), 1800); }}
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

// The hero — calories-left headline + a consume ring + the colored P/C/F counter,
// on the themed gradient (Appearance chooser). The big number and each macro pop
// on change (delta feedback). The counter is a SOLID dark module so the macro
// colors read on any theme's hero. Reads --h-* + --color-* tokens throughout.
// The hero — ported from the agreed mock (hb-hero): CALORIES LEFT headline + a
// consume ring + the solid-dark P/C/F counter. Day nav / Targets live in the
// control row above it (SoloMode), keeping the hero clean like the mock.
function DaySummary({ target, eaten, meals }: { target: Macros; eaten: Macros; meals: number }) {
  const remK = target.kcal - eaten.kcal;
  const over = remK < 0;
  const pct = target.kcal > 0 ? Math.min(1, eaten.kcal / target.kcal) : 0;
  const remStr = r0(Math.abs(remK)).toLocaleString("en-US");
  const C = 182.2; // ring circumference (r = 29)
  const macros = [
    { k: t("Protein"), e: eaten.p, tg: target.p, color: MACRO.p },
    { k: t("Carbs"), e: eaten.c, tg: target.c, color: MACRO.c },
    { k: t("Fat"), e: eaten.f, tg: target.f, color: MACRO.f },
  ];
  return (
    <div className="hb-hero">
      <div className="hb-glow" />
      <div className="hb-hrow">
        <div>
          <div className="hb-lbl">{over ? t("Calories over") : t("Calories left")}</div>
          <div key={remStr} className="hb-big bump">{remStr}</div>
          <div className="hb-sub">
            {t("{eaten} of {target} eaten", { eaten: r0(eaten.kcal).toLocaleString("en-US"), target: r0(target.kcal).toLocaleString("en-US") })}
            {meals > 0 ? ` · ${t(meals === 1 ? "{n} meal" : "{n} meals", { n: meals })}` : ""}
          </div>
        </div>
        <svg className="hb-ring" viewBox="0 0 68 68" aria-hidden="true">
          <circle cx="34" cy="34" r="29" fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="7" />
          <circle
            className="p"
            cx="34"
            cy="34"
            r="29"
            fill="none"
            stroke="#fff"
            strokeWidth="7"
            strokeLinecap="round"
            transform="rotate(-90 34 34)"
            strokeDasharray={C}
            strokeDashoffset={(C * (1 - pct)).toFixed(1)}
            style={{ transition: "stroke-dashoffset .6s cubic-bezier(.3,.9,.3,1)" }}
          />
          <text x="34" y="38" textAnchor="middle" fontSize="14" fontWeight="800" fill="currentColor">{r0(pct * 100)}%</text>
        </svg>
      </div>
      <div className="hb-counter">
        {macros.map((m) => {
          const mp = m.tg > 0 ? Math.min(100, (m.e / m.tg) * 100) : 0;
          return (
            <div key={m.k} className="hb-mc">
              <div className="hb-mch">
                <span className="hb-mcl" style={{ color: m.color }}>{m.k}</span>
                <span key={r0(m.e)} className="hb-mcv bump">{r0(m.e)}<i> /{r0(m.tg)}</i></span>
              </div>
              <div className="hb-bar"><i style={{ width: `${mp}%`, "--mc": m.color } as CSSProperties} /></div>
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
  const remStr = String(r0(Math.abs(remK)));
  const ringFont = remStr.length >= 4 ? 14 : remStr.length === 3 ? 16 : 18;
  return (
    <div className="rounded-[18px] border p-3" style={{ background: acc + "12", borderColor: acc + "55" }}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: acc }}>
        <span>{person === "gino" ? "▲" : "▼"}</span>
        {you ? t("You") : PERSON_NAME[person]}
      </div>
      <div className="mt-2 flex items-center gap-2.5">
        <Ring pct={pct} over={over} size={60} stroke={7} color={acc} track="#222b38" overColor="#f0556e">
          <span key={r0(remK)} className="bump stat text-bone" style={{ fontSize: ringFont, lineHeight: 1 }}>{remStr}</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="stat-key" style={{ color: over ? "#f0556e" : "var(--color-taupe)" }}>
            {over ? t("kcal over") : t("kcal left")}
          </div>
          <div className="num mt-1 text-[11px] font-semibold leading-tight">
            <span style={{ color: MACRO_BRIGHT.p }}>{r0(target.p - eaten.p)}P</span>
            <span style={{ color: "var(--color-faint)" }}> · </span>
            <span style={{ color: MACRO_BRIGHT.c }}>{r0(target.c - eaten.c)}C</span>
            <span style={{ color: "var(--color-faint)" }}> · </span>
            <span style={{ color: MACRO_BRIGHT.f }}>{r0(target.f - eaten.f)}F</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Together accountability: a read-only glance at what BOTH of you have logged
// today — each person's meals + their running totals — so you can check in on
// each other. Household data is already shared, so this just surfaces it.
function EatenTogether({
  logs,
  order,
  you,
  onEditItem,
  onRemoveMeal,
}: {
  logs: Record<Person, DayLog>;
  order: Person[];
  you: Person;
  onEditItem: (person: Person, mealId: string, item: LoggedItem) => void;
  onRemoveMeal: (person: Person, mealId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [openMeals, setOpenMeals] = useState<Set<string>>(new Set());
  const toggleMeal = (id: string) =>
    setOpenMeals((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <section className="overflow-hidden rounded-[16px] border" style={TILE}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left">
        <Users size={13} style={{ color: "var(--color-accent)" }} />
        <span className="stat-key flex-1" style={{ color: "var(--color-taupe)" }}>{t("Eaten today")}</span>
        <ChevronDown size={16} style={{ color: "var(--color-faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {order.map((p) => {
            const meals = logs[p].meals;
            const tot = dayTotals(logs[p]);
            const acc = PERSON_ACC[p];
            return (
              <div key={p}>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[12.5px] font-semibold" style={{ color: acc }}>{p === you ? t("You") : PERSON_NAME[p]}</span>
                  <span className="num text-[11px]" style={{ color: "var(--color-taupe)" }}>{r0(tot.kcal)} {t("kcal")} · {r0(tot.p)}P {r0(tot.c)}C {r0(tot.f)}F</span>
                </div>
                {meals.length === 0 ? (
                  <p className="text-[11.5px]" style={{ color: "var(--color-taupe)" }}>{t("Nothing logged yet.")}</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {meals.map((m, i) => {
                      const mt = mealTotals(m);
                      const label = m.items.map((it) => it.name).join(", ") || t("Meal {n}", { n: i + 1 });
                      const mo = openMeals.has(m.id);
                      return (
                        <div key={m.id} className="overflow-hidden rounded-lg" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }}>
                          <div className="flex items-center gap-2 px-2.5 py-1.5">
                            <button onClick={() => toggleMeal(m.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                              <ChevronDown size={13} style={{ color: "var(--color-faint)", transform: mo ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
                              <span className="min-w-0 flex-1 truncate text-[12px] text-bone">{label}</span>
                            </button>
                            <span className="num shrink-0 text-[11px]" style={{ color: "var(--color-taupe)" }}>{r0(mt.kcal)} {t("kcal")}</span>
                            <button onClick={() => onRemoveMeal(p, m.id)} className="shrink-0" style={{ color: "var(--color-faint)" }} aria-label="Delete meal">
                              <Trash2 size={13} />
                            </button>
                          </div>
                          {mo && (
                            <div className="border-t px-2.5 py-1" style={{ borderColor: "var(--color-edge)" }}>
                              {m.items.map((it) => {
                                const c = contribution(it);
                                return (
                                  <button key={it.id} onClick={() => onEditItem(p, m.id, it)} className="flex w-full items-center gap-2 py-1 text-left">
                                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-bone">{it.name}</span>
                                    <span className="num shrink-0 text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{amountLabel(it)} · {r0(c.kcal)} {t("kcal")}</span>
                                  </button>
                                );
                              })}
                              <p className="py-0.5 text-[10px]" style={{ color: "var(--color-faint)" }}>{t("Tap an ingredient to fix its amount.")}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
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
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("Nothing's logged yet — a quick check-in keeps your history honest.")}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={onYes} className="flex-1 rounded-[12px] py-2.5 text-[13.5px] font-semibold text-white transition active:scale-[0.98]" style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}>
          {t("Yes, I did")}
        </button>
        <button onClick={onNo} className="flex-1 rounded-[12px] py-2.5 text-[13.5px] font-semibold transition active:scale-[0.98]" style={{ background: "rgba(240,85,110,0.12)", color: "#f0556e" }}>
          {t("No, off-plan")}
        </button>
        <button onClick={onLater} className="px-2 text-[12px] font-medium" style={{ color: "var(--color-faint)" }}>
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
      <div className="w-full max-w-[420px] overflow-hidden" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid #46d18a", borderRadius: "22px", padding: "16px" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <div className="flex-1 text-[16px] font-bold text-bone">{t("Nice — roughly what did you eat?")}</div>
          <button onClick={onClose} style={{ color: "var(--color-faint)" }}><X size={20} /></button>
        </div>
        <p className="mt-1 text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("A quick note is enough. Today gets marked followed (estimated, ~on target).")}</p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
          rows={3}
          placeholder={t("e.g. chicken + rice + veg, a shake, a banana…")}
          className="mt-3 w-full resize-none rounded-xl px-3 py-2.5 text-[14px] text-bone outline-none placeholder:text-[var(--color-faint)]"
          style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}
        />
        <button
          onClick={() => onLog(note)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
        >
          <Check size={16} /> {t("Log as followed")}
        </button>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<DayStatus, string> = {
  logged: "#46d18a",
  partial: "#4f7ab0", // logged some, but not yet a meaningful day toward target
  estimated: "#e3b341",
  skipped: "#f0556e",
  none: "#222b38",
};
const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const weekPctColor = (pct: number | null): string =>
  pct == null ? "#39424f" : pct >= 80 ? "#46d18a" : pct >= 50 ? "#e3b341" : "#f0556e";
const BAR_H = 32; // px — the recent-weeks trend bar height

// ── the home 2-up: mock hb-tiles; tap opens the full card ─────────────────────
function WeekTile({ weeks, today, onOpen }: { weeks: WeekBucket[]; today: string; onOpen: () => void }) {
  const cur = weeks[weeks.length - 1];
  return (
    <button onClick={onOpen} className="hb-tile">
      <div className="hb-eye"><Flame size={13} /> {t("This week")}</div>
      <div className="hb-stat">{cur.followed}<span className="un"> / {t("{n} on plan", { n: cur.elapsed })}</span></div>
      <div className="hb-letrow dots">
        {cur.days.map((d) => (
          <span
            key={d.date}
            style={{
              background: d.future ? "var(--color-raised)" : STATUS_COLOR[d.status],
              border: d.future ? "1px dashed var(--color-edge)" : "none",
              boxShadow: d.date === today && !d.future ? "0 0 0 1.5px var(--color-accent)" : "none",
            }}
          />
        ))}
      </div>
      <div className="hb-letrow labels">{WEEKDAY_LETTERS.map((l, i) => <span key={i}>{l}</span>)}</div>
    </button>
  );
}

function WeightTile({ person, onOpen }: { person: Person; onOpen: () => void }) {
  const { weights } = useHealth();
  const mine = useMemo(
    () => weights.filter((w) => w.person === person).sort((a, b) => a.date.localeCompare(b.date)),
    [weights, person],
  );
  const cur = latestWeight(mine);
  const rate = ratePerWeek(mine);
  const valid = rate != null && mine.length >= 2;
  const rStr = valid ? (person === "gino" && rate >= 0 ? "+" : "") + rate.toFixed(1) : "";
  const pts = mine.slice(-14).map((w) => w.weight);
  const geo =
    pts.length >= 2
      ? (() => {
          const min = Math.min(...pts), max = Math.max(...pts), rng = max - min || 1, W = 130, H = 28, step = W / (pts.length - 1);
          const xy = pts.map((v, i) => [i * step, H - ((v - min) / rng) * H] as const);
          return { points: xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "), last: xy[xy.length - 1] };
        })()
      : null;
  return (
    <button onClick={onOpen} className="hb-tile">
      <div className="hb-eye"><Scale size={13} /> {t("Weight")}</div>
      <div className="hb-stat">{cur != null ? cur.toFixed(1) : "—"}<span className="un"> {t("lb")}</span></div>
      {geo ? (
        <svg width="100%" height="28" viewBox="0 0 130 28" preserveAspectRatio="none" style={{ marginTop: 8 }} aria-hidden="true">
          <polyline fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={geo.points} />
          <circle cx={geo.last[0].toFixed(1)} cy={geo.last[1].toFixed(1)} r="2.6" fill="var(--color-accent)" />
        </svg>
      ) : (
        <div style={{ height: 28, marginTop: 8 }} />
      )}
      <div className="hb-tiny" style={{ color: valid ? "#46d18a" : "var(--color-faint)" }}>
        {valid ? `${rStr} ${t("lb / wk")}` : t("Log to see trend")}
      </div>
    </button>
  );
}

function AdherenceCard({
  stats,
  weeks,
  today,
  acc,
  activeDate,
}: {
  stats: ReturnType<typeof adherenceStats>;
  weeks: WeekBucket[];
  today: string;
  acc: string;
  activeDate?: string;
}) {
  const cur = weeks[weeks.length - 1];
  const highlight = activeDate ?? today;
  const headlineColor = cur.followed === 0 ? "var(--color-bone)" : weekPctColor(cur.pct);
  const barH = (pct: number | null) => (pct == null ? 5 : Math.max(5, Math.round((pct / 100) * BAR_H)));
  return (
    <section className="rounded-[18px] border p-4" style={TILE}>
      {/* this week — the part that resets every Monday */}
      <div className="flex items-center justify-between">
        <p className="stat-key" style={{ color: acc }}>{t("This week")}</p>
        <div className="flex items-center gap-1.5">
          <Flame size={14} style={{ color: stats.streak > 0 ? "#fb923c" : "var(--color-faint)" }} />
          <span className="text-[12px] font-semibold" style={{ color: stats.streak > 0 ? "var(--color-bone)" : "var(--color-taupe)" }}>
            {stats.streak > 0 ? t("{n}-day streak", { n: stats.streak }) : t("no streak yet")}
          </span>
        </div>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="stat text-[24px]" style={{ color: headlineColor }}>{cur.followed}</span>
        <span className="text-[13px]" style={{ color: "var(--color-taupe)" }}>{t("of {n} days on plan", { n: cur.elapsed })}</span>
      </div>

      {/* the 7 days of this week, Mon→Sun */}
      <div className="mt-3 grid grid-cols-7 gap-1.5">
        {cur.days.map((d) => (
          <span
            key={d.date}
            className="h-6 w-full rounded-[5px]"
            style={{
              background: d.future ? "var(--color-raised)" : STATUS_COLOR[d.status],
              border: d.future ? "1px dashed var(--color-edge)" : "none",
              boxShadow: d.date === highlight && !d.future ? `0 0 0 1.5px ${acc}` : "none",
            }}
          />
        ))}
        {WEEKDAY_LETTERS.map((l, i) => (
          <span key={i} className="text-center text-[9.5px]" style={{ color: "var(--color-faint)" }}>{l}</span>
        ))}
      </div>

      {/* compact legend so the day colors decode */}
      <div className="mt-2.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[9.5px]" style={{ color: "var(--color-taupe)" }}>
        {([["logged", t("on plan")], ["partial", t("partial")], ["estimated", t("estimated")], ["skipped", t("off plan")]] as [DayStatus, string][]).map(([k, label]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: STATUS_COLOR[k] }} /> {label}
          </span>
        ))}
      </div>

      {/* the trend over time — one bar per week, this week ringed */}
      {weeks.length > 1 && (
        <>
          <p className="mt-3.5 text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-faint)" }}>{t("Recent weeks")}</p>
          <div className="mt-1.5 flex items-end gap-1.5" style={{ height: BAR_H }}>
            {weeks.map((wk) => (
              <div key={wk.startDate} className="flex flex-1 items-end" style={{ height: BAR_H }}>
                <div
                  className="w-full rounded-[3px]"
                  style={{
                    height: barH(wk.pct),
                    background: weekPctColor(wk.pct),
                    opacity: wk.pct == null ? 0.4 : 1,
                    boxShadow: wk.isCurrent ? `0 0 0 1.5px ${acc}` : "none",
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ── saved / favorite meals ──────────────────────────────────────────────────
// Reconstruct a Food shell from a logged item, so a saved meal can be re-added
// to the Together dish (which works in Food + grams).
const foodFromItem = (it: LoggedItem): Food => ({
  id: it.foodId,
  name: it.name,
  role: it.role,
  kcal: it.per100.kcal,
  p: it.per100.p,
  c: it.per100.c,
  f: it.per100.f,
  unit: it.unit,
});

// A collapsible drawer of saved-meal chips — tap the header to expand, a chip to
// open it, × to delete. Collapsed by default so the list never floods the screen;
// its open/closed state persists. Hidden entirely when empty.
function SavedMealsBar({ meals, onPick, onDelete }: { meals: SavedMeal[]; onPick: (m: SavedMeal) => void; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(() => localStorage.getItem("hb-saved-open") === "1");
  useEffect(() => localStorage.setItem("hb-saved-open", open ? "1" : "0"), [open]);
  if (!meals.length) return null;
  return (
    <section className="overflow-hidden rounded-[16px] border" style={TILE}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left">
        <Bookmark size={13} style={{ color: "var(--color-accent)" }} />
        <span className="stat-key flex-1" style={{ color: "var(--color-taupe)" }}>{t("Saved meals")}</span>
        <span className="num text-[11px]" style={{ color: "var(--color-taupe)" }}>{meals.length}</span>
        <ChevronDown size={16} style={{ color: "var(--color-faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </button>
      {open && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-3">
          {meals.map((m) => (
            <span key={m.id} className="flex items-center gap-1 rounded-full py-1 pl-3 pr-1" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }}>
              <button onClick={() => onPick(m)} className="flex items-center gap-1 text-[12.5px] font-medium text-bone">
                {m.name}
              </button>
              <button onClick={() => onDelete(m.id)} className="px-0.5" style={{ color: "var(--color-faint)" }} aria-label="Delete saved meal">
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// Name-this-meal prompt before saving a favorite. Also lets you SAVE without
// logging it to today (create a template you're not eating right now).
function SaveMealSheet({ open, defaultName, onClose, onSave }: { open: boolean; defaultName: string; onClose: () => void; onSave: (name: string, keepInDay: boolean) => void }) {
  const [name, setName] = useState(defaultName);
  const [keepInDay, setKeepInDay] = useState(true);
  useEffect(() => { if (open) { setName(defaultName); setKeepInDay(true); } }, [open, defaultName]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.6)" }} onClick={onClose}>
      <div className="w-full max-w-[360px] rounded-[20px] p-5" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Bookmark size={16} style={{ color: "var(--color-accent)" }} />
          <div className="flex-1 text-[15px] font-bold text-bone">{t("Save this meal")}</div>
          <button onClick={onClose} style={{ color: "var(--color-faint)" }}><X size={18} /></button>
        </div>
        <p className="mt-1 text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("Reuse it any time with one tap.")}</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("Meal name")}
          className="mt-3 w-full rounded-lg px-3 py-2.5 text-[14px] text-bone outline-none placeholder:text-[var(--color-faint)]"
          style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}
        />
        {/* keep in today's log, or save the template only (don't count it today) */}
        <button
          onClick={() => setKeepInDay((v) => !v)}
          className="mt-3 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left"
          style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}
        >
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
            style={{ background: keepInDay ? "var(--color-accent)" : "transparent", border: keepInDay ? "none" : "1.5px solid var(--color-edge)" }}
          >
            {keepInDay && <Check size={13} style={{ color: "var(--h-on-accent)" }} />}
          </span>
          <span className="flex-1 text-[12.5px] text-bone">{t("Also keep it in today's log")}</span>
        </button>
        <button
          onClick={() => name.trim() && onSave(name.trim(), keepInDay)}
          disabled={!name.trim()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[14px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: "var(--color-accent)", color: "var(--h-on-accent)", opacity: name.trim() ? 1 : 0.45 }}
        >
          <Check size={16} /> {keepInDay ? t("Save meal") : t("Save to meals only")}
        </button>
      </div>
    </div>
  );
}

// Preview a saved meal — its ingredients + macro total — before adding it to the
// day. Fixes the old "tap = silently added" behavior: now you view first, then
// choose to add (and can edit the copy once it's in your day).
// Tap a saved meal → view it, edit its name / ingredients in place (persisted
// back to the favorite), or add it to today. Editing here means you no longer
// have to log a meal, tweak it, and re-bookmark just to fix a saved favorite.
function SavedMealEditor({
  meal,
  library,
  onClose,
  onAddToday,
  onUpdate,
}: {
  meal: SavedMeal | null;
  library: Food[];
  onClose: () => void;
  onAddToday: (m: SavedMeal) => void;
  onUpdate: (id: string, name: string, items: LoggedItem[]) => void;
}) {
  const [name, setName] = useState("");
  const [items, setItems] = useState<LoggedItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);

  useEffect(() => {
    if (meal) {
      setName(meal.name);
      setItems(meal.items);
      setDirty(false);
      setAddOpen(false);
      setEditIdx(null);
    }
  }, [meal?.id]);

  if (!meal) return null;

  const tot = items.reduce(
    (a, it) => {
      const c = contribution(it);
      return { kcal: a.kcal + c.kcal, p: a.p + c.p, c: a.c + c.c, f: a.f + c.f };
    },
    { ...ZERO },
  );
  const editItem = editIdx != null ? items[editIdx] : null;

  const changePortion = (amount: Amount) =>
    setItems((xs) => { setDirty(true); return xs.map((it, i) => (i === editIdx ? { ...it, grams: amount.grams, qty: amount.qty, unit: amount.unit } : it)); });
  const removeIngredient = () =>
    setItems((xs) => { setDirty(true); return xs.filter((_, i) => i !== editIdx); });

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.6)" }} onClick={onClose}>
        <div className="max-h-[85vh] w-full max-w-[380px] overflow-y-auto rounded-[20px] p-5" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <Bookmark size={16} style={{ color: "var(--color-accent)" }} />
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true); }}
              placeholder={t("Meal name")}
              className="min-w-0 flex-1 bg-transparent text-[15px] font-bold text-bone outline-none placeholder:text-[var(--color-faint)]"
            />
            <button onClick={onClose} style={{ color: "var(--color-faint)" }}><X size={18} /></button>
          </div>
          <div className="num mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13px] font-bold text-bone">{r0(tot.kcal)}<span className="ml-0.5 text-[10px] font-medium" style={{ color: "var(--color-taupe)" }}> {t("kcal")}</span></span>
            <MacroChip label="P" value={r0(tot.p)} color="#fb7185" />
            <MacroChip label="C" value={r0(tot.c)} color="#38bdf8" />
            <MacroChip label="F" value={r0(tot.f)} color="#f6c453" />
          </div>

          <div className="mt-3 flex flex-col">
            {items.map((it, i) => {
              const c = contribution(it);
              return (
                <button
                  key={it.id}
                  onClick={() => setEditIdx(i)}
                  className="flex items-center gap-2 border-b py-2 text-left last:border-0"
                  style={{ borderColor: "var(--color-edge)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-bone">{it.name}</div>
                    <div className="num text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{amountLabel(it)} · {r0(c.kcal)} {t("kcal")}</div>
                  </div>
                  <span className="num text-[11px]" style={{ color: "var(--color-taupe)" }}>{r0(c.p)}P {r0(c.c)}C {r0(c.f)}F</span>
                  <Pencil size={13} style={{ color: "var(--color-faint)" }} />
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setAddOpen(true)}
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-[12px] py-2 text-[12.5px] font-semibold transition active:scale-[0.98]"
            style={{ background: "rgba(52,197,232,0.13)", color: "var(--color-accent)" }}
          >
            <Plus size={14} /> {t("Add food")}
          </button>

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => { onAddToday({ ...meal, name: name.trim() || meal.name, items }); onClose(); }}
              className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
              style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
            >
              <Plus size={16} /> {t("Add to today")}
            </button>
            <button
              onClick={() => { onUpdate(meal.id, name, items); setDirty(false); onClose(); }}
              disabled={!dirty}
              className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-2.5 text-[14px] font-semibold transition active:scale-[0.98]"
              style={{ background: dirty ? "rgba(70,209,138,0.14)" : "rgba(255,255,255,0.04)", color: dirty ? "#46d18a" : "var(--color-faint)" }}
            >
              <Check size={16} /> {t("Save changes")}
            </button>
          </div>
        </div>
      </div>

      {/* add a new ingredient to the favorite */}
      <FoodSearchSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        library={library}
        title={t("Add food")}
        onAdd={(food, amount) => { setItems((xs) => [...xs, toItem(food, amount)]); setDirty(true); }}
      />
      {/* edit / remove an ingredient of the favorite */}
      <FoodSearchSheet
        open={editItem !== null}
        onClose={() => setEditIdx(null)}
        library={library}
        title={t("Edit portion")}
        initialFood={editItem ? ({ id: editItem.foodId, name: editItem.name, role: editItem.role, ...editItem.per100, unit: editItem.unit } as Food) : undefined}
        initialAmount={editItem ? { grams: editItem.grams, qty: editItem.qty, unit: editItem.unit } : undefined}
        onAdd={(_food, amount) => changePortion(amount)}
        onRemove={removeIngredient}
      />
    </>
  );
}

// Edit one person's daily macro targets. Writes to the household macro_targets
// table (syncs across phones); calories are shown as the sum for reference.
function EditTargetsSheet({ open, name, target, onClose, onSave }: { open: boolean; name: string; target: MacroTarget; onClose: () => void; onSave: (t: MacroTarget) => void }) {
  const [p, setP] = useState(String(target.p));
  const [c, setC] = useState(String(target.c));
  const [f, setF] = useState(String(target.f));
  const [kcal, setKcal] = useState(String(target.kcal));
  useEffect(() => {
    if (open) { setP(String(target.p)); setC(String(target.c)); setF(String(target.f)); setKcal(String(target.kcal)); }
  }, [open, target]);
  if (!open) return null;
  const num = (s: string) => Math.max(0, Number(s) || 0);
  const field = (label: string, val: string, set: (v: string) => void, unit: string) => (
    <label className="flex flex-col gap-1">
      <span className="stat-key" style={{ color: "var(--color-taupe)" }}>{label}</span>
      <div className="flex items-center gap-1.5 rounded-lg px-3" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}>
        <input
          value={val}
          onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="numeric"
          className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none"
        />
        <span className="text-[11px]" style={{ color: "var(--color-faint)" }}>{unit}</span>
      </div>
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.6)" }} onClick={onClose}>
      <div className="w-full max-w-[360px] rounded-[20px] p-5" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Flame size={16} style={{ color: "var(--color-accent)" }} />
          <div className="flex-1 text-[15px] font-bold text-bone">{t("{name}'s daily targets", { name })}</div>
          <button onClick={onClose} style={{ color: "var(--color-faint)" }}><X size={18} /></button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {field(t("Calories"), kcal, setKcal, "kcal")}
          {field(t("Protein"), p, setP, "g")}
          {field(t("Carbs"), c, setC, "g")}
          {field(t("Fat"), f, setF, "g")}
        </div>
        <button
          onClick={() => onSave({ kcal: num(kcal), p: num(p), c: num(c), f: num(f) })}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-[14px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
        >
          <Check size={16} /> {t("Save targets")}
        </button>
      </div>
    </div>
  );
}

// A small tinted macro pill — protein rose, carb sky, fat gold — so the P/C/F
// breakdown reads at a glance instead of as one flat monotone line.
function MacroChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span
      className="num inline-flex items-baseline gap-0.5 rounded-md px-1.5 py-[1px] text-[11px]"
      style={{ background: `${color}1f`, color }}
    >
      <span className="font-semibold">{value}</span>
      <span className="text-[9px] font-medium opacity-75">{label}</span>
    </span>
  );
}

function MealCard({ index, meal, onAddFood, onEditItem, onRemoveMeal, onSave }: { index: number; meal: Meal; onAddFood: () => void; onEditItem: (it: LoggedItem) => void; onRemoveMeal: () => void; onSave?: () => void }) {
  const tot = mealTotals(meal);
  const [open, setOpen] = useState(false);
  const hasItems = meal.items.length > 0;
  return (
    <div className="hb-mrow">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left">
        <div className="flex items-center gap-1.5">
          <span className="hb-mname flex-1 truncate">{meal.name || t("Meal {n}", { n: index + 1 })}</span>
          <ChevronDown size={14} style={{ color: "var(--color-faint)", transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
        </div>
        <div className="hb-mmeta">
          {hasItems && <span className="hb-chip it">{t(meal.items.length === 1 ? "{n} item" : "{n} items", { n: meal.items.length })}</span>}
          <span className="hb-chip kc">{r0(tot.kcal)} {t("kcal")}</span>
          <span className="hb-chip" style={{ color: MACRO.p, background: "rgba(251,113,133,.14)" }}>{r0(tot.p)}P</span>
          <span className="hb-chip" style={{ color: MACRO.c, background: "rgba(56,189,248,.14)" }}>{r0(tot.c)}C</span>
          <span className="hb-chip" style={{ color: MACRO.f, background: "rgba(246,196,83,.14)" }}>{r0(tot.f)}F</span>
        </div>
      </button>
      {open && (
        <div className="mt-1.5">
          {meal.items.map((it) => {
            const c = contribution(it);
            return (
              <button
                key={it.id}
                onClick={() => onEditItem(it)}
                className="flex w-full items-center gap-2 border-t py-2 text-left"
                style={{ borderColor: "var(--color-edge)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px]" style={{ color: "var(--color-bone)" }}>{it.name}</div>
                  <div className="hb-num text-[10.5px]" style={{ color: "var(--color-taupe)" }}>{amountLabel(it)} · {r0(c.kcal)} {t("kcal")}</div>
                </div>
                <span className="hb-num text-[11px]" style={{ color: "var(--color-taupe)" }}>{r0(c.p)}P {r0(c.c)}C {r0(c.f)}F</span>
              </button>
            );
          })}
          <button onClick={onAddFood} className="hb-addbtn" style={{ marginTop: 8 }}>
            <Plus size={14} /> {t("Add food")}
          </button>
          <div className="mt-2 flex items-center gap-4 text-[11px]">
            {onSave && hasItems && (
              <button onClick={onSave} className="flex items-center gap-1" style={{ color: "var(--color-taupe)" }}><Bookmark size={13} /> {t("Save")}</button>
            )}
            <button onClick={onRemoveMeal} className="flex items-center gap-1" style={{ color: "var(--color-faint)" }}><Trash2 size={13} /> {t("Remove")}</button>
          </div>
        </div>
      )}
    </div>
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
          style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)", borderRadius: "22px" }}
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
                <button onClick={onClose} style={{ color: "var(--color-faint)" }}>
                  <X size={20} />
                </button>
              </div>

              <div className="flex gap-2 px-4">
                <div className="flex flex-1 items-center gap-2 rounded-xl px-3" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}>
                  <Search size={16} style={{ color: "var(--color-faint)" }} />
                  {/* No autoFocus — opening the sheet shows the options first; the
                      user taps the field to bring up the keyboard when ready. */}
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("Search a food…")}
                    className="w-full bg-transparent py-2.5 text-[14px] text-bone outline-none placeholder:text-[var(--color-faint)]"
                  />
                  {q && (
                    <button onClick={() => setQ("")} style={{ color: "var(--color-faint)" }}>
                      <X size={15} />
                    </button>
                  )}
                </div>
                <button
                  onClick={() => setScanOpen(true)}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold"
                  style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
                >
                  <ScanLine size={16} /> {t("Scan")}
                </button>
              </div>

              {status && (
                <p className="mx-4 mt-2 rounded-lg px-3 py-2 text-[12px]" style={{ background: "var(--color-tile)", color: "var(--color-taupe)" }}>
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
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition active:bg-[var(--color-tile)]"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[11px] font-bold" style={{ background: ROLE_TINT[f.role] + "22", color: ROLE_TINT[f.role] }}>
                        {f.kcal}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] text-bone">{f.name}</div>
                        <div className="num text-[10.5px]" style={{ color: "var(--color-taupe)" }}>
                          {f.p}P · {f.c}C · {f.f}F {t("per 100g")}
                          {f.note ? ` · ${f.note}` : ""}
                        </div>
                      </div>
                      <Plus size={16} style={{ color: "#46d18a" }} />
                    </button>
                  ))
                ) : qd.length >= 6 ? (
                  <button onClick={() => lookup(qd)} className="m-2 flex w-[calc(100%-16px)] items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-semibold" style={{ background: "color-mix(in srgb, var(--color-accent) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)", color: "var(--color-accent)" }}>
                    <Search size={15} /> {t("Look up barcode {code}", { code: qd })}
                  </button>
                ) : (
                  <p className="px-3 py-8 text-center text-[13px]" style={{ color: "var(--color-taupe)" }}>
                    {q ? t("No match. Try fewer words, scan, or enter the barcode.") : t("Search by name, scan, or type a barcode number.")}
                  </p>
                )}
              </div>

              <button
                onClick={() => setCustomOpen(true)}
                className="flex items-center justify-center gap-1.5 border-t py-3 text-[12.5px] font-semibold"
                style={{ borderColor: "var(--color-edge)", color: "var(--color-taupe)" }}
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
        <button onClick={onBack} style={{ color: "var(--color-taupe)" }}>
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15.5px] font-bold text-bone">{food.name}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="num text-[13px] font-bold text-bone">
              {food.kcal}
              <span className="ml-0.5 text-[10px] font-semibold" style={{ color: "var(--color-taupe)" }}>{t("kcal")}</span>
            </span>
            <span className="num text-[12px] font-bold" style={{ color: MACRO_BRIGHT.p }}>{food.p}P</span>
            <span className="num text-[12px] font-bold" style={{ color: MACRO_BRIGHT.c }}>{food.c}C</span>
            <span className="num text-[12px] font-bold" style={{ color: MACRO_BRIGHT.f }}>{food.f}F</span>
            <span className="text-[10px]" style={{ color: "var(--color-taupe)" }}>{t("per 100g")}</span>
          </div>
          {hasUnit && (
            <div className="num mt-0.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
              {t("1 {unit} ≈ {g} g", { unit: unitName, g: r0(gPerUnit) })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-2">
        {hasUnit && (
          <div className="mb-3 flex rounded-full p-1 text-[12.5px]" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)" }}>
            <button onClick={toUnit} className="flex-1 rounded-full py-1.5 font-semibold transition" style={mode === "unit" ? { background: "var(--color-accent)", color: "var(--h-on-accent)" } : { color: "var(--color-taupe)" }}>
              {t("By the {unit}", { unit: unitName })}
            </button>
            <button onClick={toGrams} className="flex-1 rounded-full py-1.5 font-semibold transition" style={mode === "grams" ? { background: "var(--color-accent)", color: "var(--h-on-accent)" } : { color: "var(--color-taupe)" }}>
              {t("Grams")}
            </button>
          </div>
        )}

        {mode === "unit" ? (
          <>
            <QtyRow qty={qty} setQty={setQty} unitName={pluralizeUnit(unitName, qty)} />
            <div className="mb-3 flex gap-2">
              {[1, 2, 3].map((n) => (
                <button key={n} onClick={() => setQty(n)} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}>
                  {n}
                </button>
              ))}
            </div>
            <p className="mb-2 text-center text-[11px]" style={{ color: "var(--color-taupe)" }}>{t("= {n} g", { n: r0(effGrams) })}</p>
          </>
        ) : (
          <>
            <GramRow grams={grams} setGrams={setGrams} />
            <div className="mb-3 flex gap-2">
              {gramQuick.map(([lbl, g]) => (
                <button key={lbl} onClick={() => setGrams(Math.round(g))} className="flex-1 rounded-lg py-1.5 text-[12px] font-semibold" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}>
                  {lbl}{food.serving ? "×" : "g"}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="rounded-xl p-3.5" style={TILE}>
          <div className="flex items-center justify-between">
            <span className="stat-key" style={{ color: "var(--color-bone)" }}>{t("This portion")}</span>
            <span className="flex items-baseline gap-1">
              <span className="stat text-[26px] text-bone">{r0(c.kcal)}</span>
              <span className="text-[11px] font-bold" style={{ color: "var(--color-taupe)" }}>{t("kcal")}</span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              { k: t("Protein"), v: c.p, color: MACRO_BRIGHT.p },
              { k: t("Carbs"), v: c.c, color: MACRO_BRIGHT.c },
              { k: t("Fat"), v: c.f, color: MACRO_BRIGHT.f },
            ].map((m) => (
              <div key={m.k} className="rounded-lg px-2 py-2 text-center" style={{ background: "var(--color-bg)", border: "1px solid var(--color-edge)" }}>
                <div className="flex items-baseline justify-center gap-0.5">
                  <span className="stat text-[19px]" style={{ color: m.color }}>{r0(m.v)}</span>
                  <span className="text-[10px] font-bold" style={{ color: m.color, opacity: 0.65 }}>g</span>
                </div>
                <div className="stat-key mt-0.5" style={{ color: "var(--color-taupe)" }}>{m.k}</div>
              </div>
            ))}
          </div>
        </div>

        {transient && (
          <button onClick={() => setSave((s) => !s)} className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px]" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" }}>
            <span className="flex h-4 w-4 items-center justify-center rounded" style={{ background: save ? "var(--color-accent)" : "transparent", border: save ? "none" : "1px solid var(--color-edge)" }}>
              {save && <Check size={12} style={{ color: "var(--h-on-accent)" }} />}
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
          style={{ background: "var(--color-accent)", color: "var(--h-on-accent)" }}
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
      <button onClick={() => step(-1)} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-bone)" }}>
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
        <span className="text-[13px] font-semibold" style={{ color: "var(--color-taupe)" }}>{unitName}</span>
      </div>
      <button onClick={() => step(1)} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-bone)" }}>
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
      <button onClick={() => setGrams(Math.max(0, grams - 10))} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-bone)" }}>
        <Minus size={18} />
      </button>
      <div className="flex items-baseline gap-1">
        <NumField
          value={grams}
          onChange={setGrams}
          className="num w-[88px] bg-transparent text-center text-[34px] font-bold text-bone outline-none"
        />
        <span className="text-[14px] font-semibold" style={{ color: "var(--color-taupe)" }}>g</span>
      </div>
      <button onClick={() => setGrams(Math.min(MAX_GRAMS, grams + 10))} className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-bone)" }}>
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
  const inpStyle = { background: "var(--color-raised)", border: "1px solid var(--color-edge)" } as const;

  return (
    <div className="flex max-h-[88vh] flex-col">
      <div className="flex items-center gap-2 p-4 pb-2">
        <button onClick={onBack} style={{ color: "var(--color-taupe)" }}>
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 text-[15.5px] font-bold text-bone">{t("Add a custom food")}</div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-2">
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Name")}</label>
          <input className={inp} style={inpStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Mom's dumplings")} />
        </div>

        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Type")}</label>
          <div className="grid grid-cols-5 gap-1.5">
            {roles.map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className="rounded-lg py-2 text-[11px] font-semibold capitalize transition"
                style={role === r ? { background: ROLE_TINT[r], color: "var(--color-bg)" } : { background: "var(--color-tile)", color: "var(--color-taupe)", border: "1px solid var(--color-edge)" }}
              >
                {t(r)}
              </button>
            ))}
          </div>
        </div>

        <p className="text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("Macros per 100g (from the label or a recipe):")}</p>
        <div className="grid grid-cols-4 gap-2">
          {[
            { l: "kcal", v: kcal, set: setKcal },
            { l: "P", v: p, set: setP },
            { l: "C", v: c, set: setC },
            { l: "F", v: f, set: setF },
          ].map((fld) => (
            <div key={fld.l}>
              <label className="mb-1 block text-center text-[10px]" style={{ color: "var(--color-taupe)" }}>{t(fld.l)}</label>
              <input className={`${inp} num px-2 text-center`} style={inpStyle} type="number" inputMode="decimal" value={fld.v} onChange={(e) => fld.set(e.target.value)} placeholder="0" />
            </div>
          ))}
        </div>

        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("One serving (grams, optional)")}</label>
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
          style={{ background: "var(--color-accent)", color: "var(--h-on-accent)", opacity: valid ? 1 : 0.45 }}
        >
          <Check size={16} /> {t("Save & use")}
        </button>
      </div>
    </div>
  );
}
