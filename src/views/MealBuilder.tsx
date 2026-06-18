import { useEffect, useMemo, useState } from "react";
import { Check, Plus, ScanLine, Trash2, UtensilsCrossed } from "lucide-react";
import { BarcodeScanner } from "../components/BarcodeScanner";
import { lookupBarcode } from "../lib/barcode";
import {
  DAILY,
  SEED_FOODS,
  ROLE_LABEL,
  ROLE_ORDER,
  scaleTarget,
  solveMeal,
  type Food,
  type FoodRole,
  type MealSolution,
} from "../lib/nutrition";
import { useStore } from "../store/FinanceStore";
import { Button, inputClass, labelClass, Sheet } from "../components/ui";

const ACC = { gino: "#ef8136", xinyan: "#2dd1c0" };
const round = (n: number) => Math.round(n);

const SHARES: { label: string; v: number }[] = [
  { label: "⅓ meal", v: 1 / 3 },
  { label: "½ day", v: 0.5 },
  { label: "Full day", v: 1 },
];

export function MealBuilder() {
  const { data } = useStore();
  const lib = useMemo(() => [...SEED_FOODS, ...data.foods], [data.foods]);
  const [selected, setSelected] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("hb-meal-sel") || "[]");
    } catch {
      return [];
    }
  });
  const [share, setShare] = useState<number>(
    () => parseFloat(localStorage.getItem("hb-meal-share") || "") || 1 / 3,
  );
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("hb-meal-sel", JSON.stringify(selected));
  }, [selected]);
  useEffect(() => {
    localStorage.setItem("hb-meal-share", String(share));
  }, [share]);

  const selFoods = useMemo(
    () => selected.map((id) => lib.find((f) => f.id === id)).filter(Boolean) as Food[],
    [selected, lib],
  );
  const gino = useMemo(() => solveMeal(selFoods, scaleTarget(DAILY.gino, share)), [selFoods, share]);
  const xin = useMemo(() => solveMeal(selFoods, scaleTarget(DAILY.xinyan, share)), [selFoods, share]);
  const gramsOf = (sol: MealSolution, id: string) =>
    sol.items.find((i) => i.food.id === id)?.grams ?? 0;

  const sortedSel = [...selFoods].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const byRole = (r: FoodRole) => lib.filter((f) => f.role === r);

  return (
    <div className="space-y-3">
      {/* meal size */}
      <section className="rounded-xl border border-edge bg-tile p-4">
        <p className="eyebrow text-taupe">How much of the day is this meal?</p>
        <div className="mt-2.5 grid grid-cols-3 gap-2">
          {SHARES.map((s) => {
            const on = Math.abs(s.v - share) < 0.001;
            return (
              <button
                key={s.label}
                onClick={() => setShare(s.v)}
                className={`rounded-lg py-2 text-sm font-semibold transition ${
                  on ? "bg-bone text-bg" : "bg-raised text-taupe hover:text-bone"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-mono text-[11px] text-faint">
          targets each plate at {Math.round(share * 100)}% of the daily plan
        </p>
      </section>

      {/* the plate / solution */}
      <section className="rounded-xl border border-edge bg-tile p-4">
        <div className="mb-1 flex items-center gap-2">
          <UtensilsCrossed size={15} className="text-taupe" />
          <p className="eyebrow text-taupe">Your plate · portions per person</p>
        </div>

        {selFoods.length === 0 ? (
          <p className="py-6 text-center text-sm text-faint">
            Pick a protein, a carb, and a veg below — I'll set each person's grams.
          </p>
        ) : (
          <>
            {/* column heads */}
            <div className="mt-3 flex items-center gap-2 border-b border-edge pb-2">
              <span className="flex-1 font-mono text-[10px] uppercase tracking-wider text-faint">
                Ingredient
              </span>
              <span className="w-16 text-right font-mono text-[10px] uppercase tracking-wider" style={{ color: ACC.gino }}>
                ▲ Gino
              </span>
              <span className="w-16 text-right font-mono text-[10px] uppercase tracking-wider" style={{ color: ACC.xinyan }}>
                ▼ Xinyan
              </span>
            </div>
            {sortedSel.map((f) => (
              <div key={f.id} className="flex items-center gap-2 border-b border-edge py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] text-bone">{f.name}</p>
                  <p className="font-mono text-[10px] text-faint">
                    {ROLE_LABEL[f.role]}
                    {f.note ? ` · ${f.note}` : ""}
                  </p>
                </div>
                <span className="num w-16 text-right text-[14px] font-semibold" style={{ color: ACC.gino }}>
                  {gramsOf(gino, f.id)}g
                </span>
                <span className="num w-16 text-right text-[14px] font-semibold" style={{ color: ACC.xinyan }}>
                  {gramsOf(xin, f.id)}g
                </span>
              </div>
            ))}

            {/* per-person totals */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <PersonTotals name="Gino" acc={ACC.gino} sol={gino} />
              <PersonTotals name="Xinyan" acc={ACC.xinyan} sol={xin} />
            </div>

            {gino.notes.length > 0 && (
              <div className="mt-2 space-y-1">
                {gino.notes.map((n, i) => (
                  <p key={i} className="font-mono text-[11px] text-gold">
                    ⚑ {n}
                  </p>
                ))}
              </div>
            )}
            <button
              onClick={() => setSelected([])}
              className="mt-3 w-full rounded-lg bg-raised py-2 text-[12px] font-medium text-taupe transition hover:text-bone"
            >
              Clear plate
            </button>
          </>
        )}
      </section>

      {/* library picker */}
      <section className="rounded-xl border border-edge bg-tile p-4">
        <div className="flex items-center justify-between">
          <p className="eyebrow text-taupe">Food library · tap to add</p>
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1 rounded-full bg-accent/15 px-2.5 py-1 text-[12px] font-semibold text-accent transition hover:bg-accent/25"
          >
            <Plus size={13} /> Add food
          </button>
        </div>
        <div className="mt-3 space-y-3.5">
          {ROLE_ORDER.map((role) => {
            const items = byRole(role);
            if (!items.length) return null;
            return (
              <div key={role}>
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-faint">
                  {ROLE_LABEL[role]}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((f) => {
                    const on = selected.includes(f.id);
                    return (
                      <button
                        key={f.id}
                        onClick={() => toggle(f.id)}
                        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12.5px] transition ${
                          on
                            ? "border-accent bg-accent/15 text-bone"
                            : "border-edge bg-raised text-taupe hover:text-bone"
                        }`}
                      >
                        {on && <Check size={12} className="text-accent" />}
                        {f.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 font-mono text-[10px] text-faint">
          macros are per 100g, as-eaten — a starting portion, not gospel. The scale
          calibrates from there.
        </p>
      </section>

      <AddFoodSheet open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function PersonTotals({ name, acc, sol }: { name: string; acc: string; sol: MealSolution }) {
  const macros: { k: string; v: number; t: number; u: string }[] = [
    { k: "kcal", v: sol.total.kcal, t: sol.target.kcal, u: "" },
    { k: "P", v: sol.total.p, t: sol.target.p, u: "g" },
    { k: "C", v: sol.total.c, t: sol.target.c, u: "g" },
    { k: "F", v: sol.total.f, t: sol.target.f, u: "g" },
  ];
  return (
    <div className="rounded-lg border p-2.5" style={{ borderColor: acc + "55", background: acc + "12" }}>
      <p className="mb-1.5 text-[12px] font-semibold" style={{ color: acc }}>
        {name}'s plate
      </p>
      <div className="grid grid-cols-4 gap-1 text-center">
        {macros.map((m) => {
          const off = Math.abs(m.v - m.t);
          const ok = m.t === 0 ? true : off / m.t < 0.12;
          return (
            <div key={m.k}>
              <p className="num text-[13px] font-semibold text-bone">
                {round(m.v)}
                <span className="text-[9px] font-normal text-faint">{m.u}</span>
              </p>
              <p className="font-mono text-[9px] text-faint">{m.k}</p>
              <p className="font-mono text-[8.5px]" style={{ color: ok ? acc : "#e3b341" }}>
                /{round(m.t)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ROLES: FoodRole[] = ["protein", "carb", "veg", "fat", "other"];

function AddFoodSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data, addFood, deleteFood } = useStore();
  const customs = data.foods;
  const [name, setName] = useState("");
  const [role, setRole] = useState<FoodRole>("protein");
  const [kcal, setKcal] = useState("");
  const [p, setP] = useState("");
  const [c, setC] = useState("");
  const [f, setF] = useState("");
  const [barcode, setBarcode] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const num = (s: string) => Math.max(0, parseFloat(s) || 0);
  const valid = name.trim() !== "" && kcal !== "";

  async function lookup(code: string) {
    const clean = code.replace(/\D/g, "");
    if (clean.length < 6) return;
    setBarcode(clean);
    const existing = data.foods.find((x) => x.barcode === clean);
    if (existing) {
      setStatus(`"${existing.name}" is already in your library.`);
      return;
    }
    setBusy(true);
    setStatus("Looking up…");
    const r = await lookupBarcode(clean);
    setBusy(false);
    if (!r) {
      setStatus("Not in the food database — enter the macros by hand.");
      return;
    }
    setName(r.name);
    setRole(r.role);
    setKcal(String(r.kcal));
    setP(String(r.p));
    setC(String(r.c));
    setF(String(r.f));
    setStatus(`Found "${r.name}" — check the macros and save.`);
  }

  function save() {
    if (!valid) return;
    addFood({
      name: name.trim(),
      role,
      kcal: num(kcal),
      p: num(p),
      c: num(c),
      f: num(f),
      barcode: barcode.replace(/\D/g, "") || undefined,
    });
    setName("");
    setKcal("");
    setP("");
    setC("");
    setF("");
    setBarcode("");
    setStatus(null);
  }

  function remove(id: string) {
    deleteFood(id);
  }

  return (
    <>
    <Sheet open={open} onClose={onClose} title="Add a food">
      <div className="space-y-4">
        {/* barcode → auto-fill from OpenFoodFacts */}
        <div>
          <label className={labelClass}>Scan or enter a barcode</label>
          <div className="flex gap-2">
            <button
              onClick={() => setScanOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2.5 text-sm font-semibold text-bg transition active:scale-[0.98]"
            >
              <ScanLine size={16} /> Scan
            </button>
            <input
              className={`${inputClass} num`}
              inputMode="numeric"
              placeholder="or type the number"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
            />
            <Button
              variant="ghost"
              disabled={busy || barcode.replace(/\D/g, "").length < 6}
              onClick={() => lookup(barcode)}
            >
              {busy ? "…" : "Look up"}
            </Button>
          </div>
          {status && (
            <p className="mt-2 rounded-lg bg-raised px-3 py-2 text-[12px] text-taupe">
              {status}
            </p>
          )}
        </div>

        <p className="text-sm text-taupe">
          …or enter the macros <b className="text-bone">per 100g</b> from the label.
        </p>
        <div>
          <label className={labelClass}>Name</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chicken thigh" />
        </div>
        <div>
          <label className={labelClass}>Role</label>
          <div className="grid grid-cols-5 gap-1.5">
            {ROLES.map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`rounded-lg py-2 text-[11px] font-semibold capitalize transition ${
                  role === r ? "bg-accent text-bg" : "bg-raised text-taupe"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { l: "kcal", v: kcal, set: setKcal },
            { l: "P (g)", v: p, set: setP },
            { l: "C (g)", v: c, set: setC },
            { l: "F (g)", v: f, set: setF },
          ].map((fld) => (
            <div key={fld.l}>
              <label className={labelClass}>{fld.l}</label>
              <input
                className={`${inputClass} num px-2 text-center`}
                type="number"
                inputMode="decimal"
                value={fld.v}
                onChange={(e) => fld.set(e.target.value)}
                placeholder="0"
              />
            </div>
          ))}
        </div>
        <Button className="w-full" disabled={!valid} onClick={save}>
          Save to library
        </Button>

        {customs.length > 0 && (
          <div className="border-t border-edge pt-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-faint">
              Your added foods
            </p>
            <div className="space-y-1.5">
              {customs.map((cf) => (
                <div key={cf.id} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-bone">{cf.name}</p>
                    <p className="num font-mono text-[10px] text-faint">
                      {round(cf.kcal)} kcal · {round(cf.p)}P · {round(cf.c)}C · {round(cf.f)}F
                    </p>
                  </div>
                  <button onClick={() => remove(cf.id)} className="text-faint transition hover:text-ember" aria-label="Remove">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
    <BarcodeScanner
      open={scanOpen}
      onClose={() => setScanOpen(false)}
      onResult={(code) => {
        setScanOpen(false);
        lookup(code);
      }}
    />
    </>
  );
}
