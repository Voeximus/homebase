// The confirm screen for a photographed nutrition label.
//
// Three states per number, and serving size always asks
// (docs/research/label-parity — "What you'd see"):
//
//   ✓ checked    another number on the label confirmed it; needs nothing
//   ! conflict   the label disagrees with itself here; a suggested fix shows its
//                evidence and WAITS FOR A TAP — about one confident repair in
//                twenty is wrong (types.ts rule 2)
//   ? unchecked  nothing printed can confirm it (total sugars, always); one tap
//                for all of them: "I checked these against the label"
//
// All the rules live in lib/labelConfirmState.ts as pure functions; this file is
// only the drawing. It is built from the same parts as FoodSearchSheet and
// PortionView in views/MealBuilder.tsx — the tile card, the dot-and-ink macro
// readout, the check-square toggle, the accent button — so the only new thing
// on screen is the logic.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Camera, Check, X } from "lucide-react";
import { t } from "../lib/i18n";
import { verify as realVerify } from "../lib/labelScan/verify";
import { toLabelFood } from "../lib/labelScan/food";
import type { FieldKey, FieldVerdict, LabelFood, ParsedPanel, ReadValue, Repair, Verification } from "../lib/labelScan/types";
import {
  acceptRepair,
  acknowledgeUnchecked,
  blockers,
  canSave,
  confirmServing,
  editServing,
  editValue,
  errorText,
  failureMessages,
  initConfirmState,
  keepRead,
  overridesOf,
  repairsFor,
  rowFields,
  rowVerdict,
  setName,
  toConfirmed,
  uncheckedFields,
  type Blocker,
  type ConfirmState,
  type Decision,
  type Essential,
  type SuggestFn,
  type VerifyFn,
} from "../lib/labelConfirmState";

/** What the flow needs besides the food, to share it with the other phone. */
export interface LabelSaveDetail {
  panel: ParsedPanel;
  overrides: Partial<Record<FieldKey, number>>;
  verification: Verification;
  columnIndex: number;
}

export interface LabelConfirmSheetProps {
  panel: ParsedPanel;
  verification: Verification;
  repairs: Repair[];
  engine?: string;
  barcode?: string;
  initialName?: string;
  columnIndex?: number;
  onSave: (food: LabelFood, detail: LabelSaveDetail) => void;
  onRetake: () => void;
  onClose: () => void;
  /** Injectable for tests and harnesses; defaults to the real verifier. */
  verify?: VerifyFn;
  /** When given, suggestions are re-asked for after every change. */
  suggest?: SuggestFn;
}

// Same tokens and shapes as MealBuilder's TILE / MACRO — read from CSS so the
// health theme reskins this sheet with everything else.
const TILE = { background: "var(--color-tile)", border: "1px solid var(--color-edge)" } as const;
const MACRO = { p: "var(--mc-p)", c: "var(--mc-c)", f: "var(--mc-f)" };
const BTN_PRIMARY = { background: "var(--color-accent)", color: "var(--h-on-accent)" } as const;
const BTN_SUGGEST = {
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)",
  color: "var(--color-accent)",
} as const;
const BTN_QUIET = { background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)" } as const;

const UNIT: Record<FieldKey, string> = {
  kcal: "kcal",
  kj: "kJ",
  fat: "g",
  sat: "g",
  trans: "g",
  chol: "mg",
  sodium: "mg",
  salt: "g",
  carb: "g",
  fiber: "g",
  sugar: "g",
  added: "g",
  prot: "g",
};

const fieldLabel = (k: FieldKey): string =>
  ({
    kcal: t("Calories"),
    kj: t("Energy"),
    fat: t("Total fat"),
    sat: t("Saturated fat"),
    trans: t("Trans fat"),
    chol: t("Cholesterol"),
    sodium: t("Sodium"),
    salt: t("Salt"),
    carb: t("Total carbs"),
    fiber: t("Fiber"),
    sugar: t("Total sugars"),
    added: t("Added sugars"),
    prot: t("Protein"),
  })[k];

const essentialLabel = (e: Essential): string => (e === "energy" ? t("Calories") : fieldLabel(e));

const trim1 = (n: number) => String(Math.round(n * 10) / 10);
const show = (v: ReadValue | undefined, unit: string) => (v ? `${v.lessThan ? "<" : ""}${trim1(v.value)} ${unit}` : "—");

/** A typed number, or null. Commas are accepted as decimal points (a Chinese/EU keyboard). */
const parseTyped = (s: string): number | null => {
  const n = parseFloat(s.replace(",", ".").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const VERDICT_MARK: Record<FieldVerdict, { glyph: string; color: string; label: () => string }> = {
  checked: { glyph: "✓", color: "var(--h-good)", label: () => t("Checked") },
  unchecked: { glyph: "?", color: "var(--color-gold)", label: () => t("Look at this one") },
  conflict: { glyph: "!", color: "var(--h-over)", label: () => t("The label disagrees with itself here") },
  missing: { glyph: "–", color: "var(--color-faint)", label: () => t("Not read") },
};

type Editing = { field: FieldKey; kind: "amount" | "refPct" } | "serving" | null;

export function LabelConfirmSheet(props: LabelConfirmSheetProps) {
  const { panel: original, barcode, engine, onRetake, onClose } = props;
  const verify = props.verify ?? realVerify;
  const suggest = props.suggest;

  const [s, setS] = useState<ConfirmState>(() =>
    initConfirmState({
      panel: original,
      verification: props.verification,
      repairs: props.repairs,
      name: props.initialName,
      columnIndex: props.columnIndex,
    }),
  );
  const [editing, setEditing] = useState<Editing>(() => (s.servingGrams > 0 ? null : "serving"));
  const [buf, setBuf] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const col = s.panel.columns[s.columnIndex];
  const rows = rowFields(s);
  const block = blockers(s);
  const ready = canSave(s);
  const unchecked = uncheckedFields(s.verification).filter((k) => s.decisions[k] !== "edited");

  // What will be saved, recomputed from exactly the numbers on screen.
  const preview = useMemo(() => {
    try {
      return toLabelFood(s.panel, { servingGrams: s.servingGrams, name: "", columnIndex: s.columnIndex });
    } catch {
      return null;
    }
  }, [s.panel, s.servingGrams, s.columnIndex]);

  const startEdit = (e: Exclude<Editing, null>) => {
    setEditing(e);
    if (e === "serving") setBuf(s.servingGrams > 0 ? trim1(s.servingGrams) : "");
    else {
      const v = e.kind === "amount" ? col?.fields[e.field] : col?.refPct[e.field];
      setBuf(v ? trim1(v.value) : "");
    }
  };
  const commitEdit = () => {
    const n = parseTyped(buf);
    if (editing === "serving") {
      if (n == null || n <= 0) return;
      setS((st) => editServing(st, n, verify, suggest));
    } else if (editing) {
      if (n == null) return;
      const { field, kind } = editing;
      setS((st) => editValue(st, field, kind, n, verify, suggest));
    }
    setEditing(null);
    setSaveError(null);
  };

  const save = () => {
    if (!ready) return;
    try {
      const confirmed = toConfirmed(s, original, { barcode });
      const food = toLabelFood(s.panel, confirmed, engine);
      props.onSave(food, {
        panel: s.panel,
        overrides: overridesOf(original, s.panel, s.columnIndex),
        verification: s.verification,
        columnIndex: s.columnIndex,
      });
    } catch (e) {
      setSaveError(errorText(e));
    }
  };

  const editor = (unit: string, label: string) => (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex flex-1 items-center gap-1.5 rounded-lg px-3" style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)" }}>
        <input
          autoFocus
          value={buf}
          onChange={(e) => setBuf(e.target.value.replace(/[^0-9.,]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(null);
          }}
          inputMode="decimal"
          aria-label={label}
          className="num w-full bg-transparent py-2.5 text-[15px] text-bone outline-none"
        />
        <span className="text-[12px] font-semibold" style={{ color: "var(--color-taupe)" }}>{unit}</span>
      </div>
      <button onClick={commitEdit} disabled={parseTyped(buf) == null} className="rounded-xl px-4 text-[13px] font-semibold" style={{ ...BTN_PRIMARY, minHeight: 44, opacity: parseTyped(buf) == null ? 0.45 : 1 }}>
        {t("Use")}
      </button>
      <button onClick={() => setEditing(null)} className="rounded-xl px-3 text-[13px] font-semibold" style={{ ...BTN_QUIET, minHeight: 44 }}>
        {t("Cancel")}
      </button>
    </div>
  );

  return (
    <div className="flex max-h-[88vh] flex-col">
      <div className="flex items-center gap-2 p-4 pb-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15.5px] font-bold text-bone">{t("Check what was read")}</div>
          <div className="text-[11px]" style={{ color: "var(--color-taupe)" }}>{t("Nothing is saved until you tap Save.")}</div>
        </div>
        <button onClick={onRetake} className="flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-semibold" style={{ ...BTN_QUIET, minHeight: 44 }}>
          <Camera size={15} /> {t("Retake")}
        </button>
        <button onClick={onClose} aria-label={t("Close")} className="flex h-11 w-11 shrink-0 items-center justify-center" style={{ color: "var(--color-faint)" }}>
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-2">
        {/* ── serving: always asks (rule 3) ── */}
        <div className="rounded-xl p-3.5" style={s.servingConfirmed ? TILE : { ...TILE, borderColor: "color-mix(in srgb, var(--color-accent) 45%, transparent)" }}>
          <div className="flex items-center justify-between gap-2">
            <span className="stat-key" style={{ color: "var(--color-bone)" }}>{t("Serving size")}</span>
            {s.servingConfirmed ? (
              <span className="stat-key flex items-center gap-1" style={{ color: "var(--h-good)" }}>
                <Check size={12} /> {t("Confirmed")}
              </span>
            ) : (
              <span className="stat-key" style={{ color: "var(--color-accent)" }}>{t("Confirm")}</span>
            )}
          </div>
          {s.panel.servingText && (
            <div className="mt-1 text-[12px]" style={{ color: "var(--color-taupe)" }}>
              {t("Printed: {text}", { text: s.panel.servingText })}
            </div>
          )}
          {editing === "serving" ? (
            <>
              {!(s.servingGrams > 0) && (
                <p className="mt-2 text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("No serving weight was read. Type the grams in one serving from the label.")}</p>
              )}
              {editor("g", t("Serving size"))}
            </>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <span className="flex items-baseline gap-1">
                <span className="stat text-[26px] text-bone">{s.servingGrams > 0 ? trim1(s.servingGrams) : "—"}</span>
                <span className="text-[11px] font-bold" style={{ color: "var(--color-taupe)" }}>g</span>
              </span>
              <div className="flex-1" />
              <button onClick={() => startEdit("serving")} className="rounded-xl px-3.5 text-[13px] font-semibold" style={{ ...BTN_QUIET, minHeight: 44 }}>
                {t("Edit")}
              </button>
              {!s.servingConfirmed && s.servingGrams > 0 && (
                <button onClick={() => setS(confirmServing)} className="flex items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold" style={{ ...BTN_PRIMARY, minHeight: 44 }}>
                  <Check size={15} /> {t("That's right")}
                </button>
              )}
            </div>
          )}
          <p className="mt-2 text-[11px]" style={{ color: "var(--color-taupe)" }}>{t("Nothing else on the label can check this one.")}</p>
        </div>

        {/* ── name ── */}
        <div>
          <label htmlFor="label-food-name" className="mb-1 block text-[11px] uppercase tracking-wider" style={{ color: "var(--color-taupe)" }}>{t("Name")}</label>
          <input
            id="label-food-name"
            className="w-full rounded-lg px-3 py-2.5 text-[14px] text-bone outline-none"
            style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", minHeight: 44 }}
            value={s.name}
            onChange={(e) => setS((st) => setName(st, e.target.value))}
            placeholder={t("e.g. Chocolate chip snack bars")}
          />
        </div>

        {/* ── the numbers ── */}
        <div className="overflow-hidden rounded-xl" style={TILE}>
          {rows.map((k, i) => {
            const amount = col?.fields[k];
            const pct = col?.refPct[k];
            const verdict = rowVerdict(s.verification, k);
            const mark = verdict ? VERDICT_MARK[verdict] : null;
            const fixes = repairsFor(s, k);
            const decision = s.decisions[k];
            const editKind = editing !== null && editing !== "serving" && editing.field === k ? editing.kind : null;
            const isEditing = editKind !== null;
            return (
              <div key={k} style={i ? { borderTop: "1px solid var(--color-edge)" } : undefined}>
                <div className="flex items-center gap-2 pl-3 pr-1.5" style={{ minHeight: 48 }}>
                  <span
                    role="img"
                    aria-label={mark?.label() ?? ""}
                    title={mark?.label()}
                    className="w-4 shrink-0 text-center text-[14px] font-bold"
                    style={{ color: mark?.color ?? "var(--color-faint)" }}
                  >
                    {mark?.glyph ?? "·"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-bone">{fieldLabel(k)}</span>
                  {pct && (
                    <button
                      onClick={() => startEdit({ field: k, kind: "refPct" })}
                      aria-label={t("Edit the percentage for {field}", { field: fieldLabel(k) })}
                      className="num rounded-lg px-2 text-[11.5px]"
                      style={{ color: "var(--color-taupe)", minHeight: 44 }}
                    >
                      {pct.lessThan ? "<" : ""}
                      {trim1(pct.value)}%
                    </button>
                  )}
                  <button
                    onClick={() => startEdit({ field: k, kind: "amount" })}
                    aria-label={t("Edit {field}", { field: fieldLabel(k) })}
                    className="num min-w-[64px] rounded-lg px-2 text-right text-[13.5px] font-semibold"
                    style={{ color: amount ? "var(--color-bone)" : "var(--color-faint)", minHeight: 44 }}
                  >
                    {show(amount, UNIT[k])}
                  </button>
                </div>

                {(verdict && verdict !== "checked") || decision || fixes.length || isEditing ? (
                  <div className="pb-3 pl-9 pr-3">
                    <RowNotes verdict={verdict} decision={decision} messages={failureMessages(s.verification, k)} hasFix={fixes.length > 0} />
                    {fixes.map((r, j) => (
                      <SuggestedFix
                        key={j}
                        repair={r}
                        unit={r.target.kind === "amount" ? UNIT[k] : "%"}
                        onUse={() => {
                          setS((st) => acceptRepair(st, r, verify, suggest));
                          setSaveError(null);
                        }}
                        onKeep={() => setS((st) => keepRead(st, k))}
                      />
                    ))}
                    {editKind && editor(editKind === "amount" ? UNIT[k] : "%", fieldLabel(k))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* ── one tap for every unchecked field (rule 4) ── */}
        {unchecked.length > 0 && (
          <button
            onClick={() => setS((st) => (st.uncheckedAcknowledged ? { ...st, uncheckedAcknowledged: false } : acknowledgeUnchecked(st)))}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px]"
            style={{ ...TILE, color: "var(--color-taupe)", minHeight: 48 }}
            aria-pressed={s.uncheckedAcknowledged}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: s.uncheckedAcknowledged ? "var(--color-accent)" : "transparent", border: s.uncheckedAcknowledged ? "none" : "1px solid var(--color-edge)" }}>
              {s.uncheckedAcknowledged && <Check size={12} style={{ color: "var(--h-on-accent)" }} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-bone">{t("I checked these against the label")}</span>
              <span className="block text-[11px]">{unchecked.map(fieldLabel).join(" · ")}</span>
            </span>
          </button>
        )}

        {/* ── what will be saved ── */}
        <div className="rounded-xl p-3.5" style={TILE}>
          <div className="stat-key" style={{ color: "var(--color-bone)" }}>{t("What will be saved")}</div>
          {preview ? (
            <div className="mt-2 space-y-1.5">
              <MacroLine label={t("per 100g")} kcal={preview.kcal} p={preview.p} c={preview.c} f={preview.f} />
              <MacroLine
                label={t("per serving ({g} g)", { g: trim1(s.servingGrams) })}
                kcal={(preview.kcal * s.servingGrams) / 100}
                p={(preview.p * s.servingGrams) / 100}
                c={(preview.c * s.servingGrams) / 100}
                f={(preview.f * s.servingGrams) / 100}
              />
            </div>
          ) : (
            <p className="mt-2 text-[12px]" style={{ color: "var(--color-taupe)" }}>{t("Fill in the serving and any missing numbers to see this.")}</p>
          )}
        </div>
      </div>

      <div className="p-4 pt-2">
        {(saveError || block.length > 0) && (
          <p className="mb-2 text-center text-[11.5px]" style={{ color: saveError ? "var(--h-over)" : "var(--color-taupe)" }}>
            {saveError ?? blockerText(block[0])}
          </p>
        )}
        <button
          onClick={save}
          disabled={!ready}
          className="flex w-full items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold transition active:scale-[0.98]"
          style={{ ...BTN_PRIMARY, opacity: ready ? 1 : 0.45, minHeight: 48 }}
        >
          <Check size={16} /> {t("Save & use")}
        </button>
      </div>
    </div>
  );
}

function blockerText(b: Blocker): string {
  switch (b.kind) {
    case "serving":
      return t("Confirm the serving size to save.");
    case "name":
      return t("Give it a name to save.");
    case "conflict":
      return t("Decide on the flagged numbers to save: {fields}", { fields: b.fields.map(fieldLabel).join(", ") });
    case "unchecked":
      return t("Tick “I checked these against the label” to save.");
    case "essentials":
      return t("Type in the missing numbers to save: {fields}", { fields: b.fields.map(essentialLabel).join(", ") });
    case "recheck":
      return t("Couldn't re-check the numbers. Try the edit again, or retake the photo.");
  }
}

function RowNotes({ verdict, decision, messages, hasFix }: { verdict?: FieldVerdict; decision?: Decision; messages: string[]; hasFix: boolean }) {
  const lines: ReactNode[] = [];
  if (verdict === "conflict" && !hasFix) messages.forEach((m, i) => lines.push(<span key={`m${i}`}>{m}</span>));
  if (verdict === "unchecked" && decision !== "edited") lines.push(<span key="u">{t("Check this against the label — nothing printed can confirm it.")}</span>);
  if (verdict === "missing") lines.push(<span key="x">{t("Not read — tap the value to type it from the label.")}</span>);
  if (decision === "kept") lines.push(<span key="k">{t("Kept as read.")}</span>);
  if (decision === "edited") lines.push(<span key="e">{t("Typed by you.")}</span>);
  if (decision === "repaired") lines.push(<span key="r">{t("Suggested fix used.")}</span>);
  if (!lines.length) return null;
  return (
    <div className="space-y-0.5 text-[11.5px] leading-snug" style={{ color: "var(--color-taupe)" }}>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function SuggestedFix({ repair, unit, onUse, onKeep }: { repair: Repair; unit: string; onUse: () => void; onKeep: () => void }) {
  const from = `${repair.from.lessThan ? "<" : ""}${trim1(repair.from.value)}${unit === "%" ? "%" : ` ${unit}`}`;
  const to = `${trim1(repair.to)}${unit === "%" ? "%" : ` ${unit}`}`;
  return (
    <div className="mt-1">
      <p className="text-[11.5px] leading-snug" style={{ color: "var(--color-taupe)" }}>
        {t("Read as {from}.", { from })} {repair.because}
      </p>
      <div className="mt-2 flex gap-2">
        <button onClick={onUse} className="flex-1 rounded-xl px-3 text-[13px] font-semibold" style={{ ...BTN_SUGGEST, minHeight: 44 }}>
          {t("Use {to}", { to })}
        </button>
        <button onClick={onKeep} className="flex-1 rounded-xl px-3 text-[13px] font-semibold" style={{ ...BTN_QUIET, minHeight: 44 }}>
          {t("Keep {from}", { from })}
        </button>
      </div>
    </div>
  );
}

// PortionView's header readout: kcal in ink, macros as dot + ink.
function MacroLine({ label, kcal, p, c, f }: { label: string; kcal: number; p: number; c: number; f: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="num text-[13px] font-bold text-bone">
        {Math.round(kcal)}
        <span className="ml-0.5 text-[10px] font-semibold" style={{ color: "var(--color-taupe)" }}>{t("kcal")}</span>
      </span>
      <span className="h-dot" style={{ "--mc": MACRO.p } as CSSProperties}>{trim1(p)}P</span>
      <span className="h-dot" style={{ "--mc": MACRO.c } as CSSProperties}>{trim1(c)}C</span>
      <span className="h-dot" style={{ "--mc": MACRO.f } as CSSProperties}>{trim1(f)}F</span>
      <span className="text-[10px]" style={{ color: "var(--color-taupe)" }}>{label}</span>
    </div>
  );
}
