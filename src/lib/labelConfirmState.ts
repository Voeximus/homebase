// The confirm screen's rules, as pure functions.
//
// The screen between "the camera read a label" and "a food is saved" exists to
// hold three measured rules (see src/lib/labelScan/types.ts):
//
//   · A REPAIR IS A SUGGESTION. A unique repair was still wrong 4.0% of the
//     time, so nothing here ever applies one without being handed the person's
//     tap — `acceptRepair` is only ever called from a button.
//   · SERVING SIZE IS ALWAYS CONFIRMED BY A PERSON. A 10x serving misread was
//     caught 0 times in 96, so nothing can be saved until someone says so.
//   · A FIELD WITH NO SECOND COPY IS NEVER "checked". US total sugars is
//     "unchecked" forever; a person compares it to the label once.
//
// Everything is immutable: an accepted repair or a typed value produces a NEW
// panel, and the verifier re-runs on it, so the verdicts on screen are always
// the verdicts for the numbers that will be saved.
//
// Taps are budgeted. The research's pass bar is "no more than 3 taps per label".
// The clean path is: confirm serving → (name) → one "I checked these" for every
// unchecked field at once → Save.
import type {
  FieldKey,
  FieldVerdict,
  ParsedPanel,
  ReadValue,
  Repair,
  Verification,
} from "./labelScan/types";
import type { Confirmed } from "./labelScan/food";

/** What a person did about a field the label disagreed with itself on. */
export type Decision = "repaired" | "edited" | "kept";

export type VerifyFn = (panel: ParsedPanel, columnIndex?: number) => Verification;
export type SuggestFn = (panel: ParsedPanel, columnIndex?: number) => Repair[];

export interface ConfirmState {
  /** The panel as the person has edited it so far. The original read is never mutated. */
  panel: ParsedPanel;
  /** The verifier's verdict on `panel` — always re-run after a change. */
  verification: Verification;
  /** Suggestions for `panel`. Shown with their evidence; never applied without a tap. */
  repairs: Repair[];
  servingConfirmed: boolean;
  servingGrams: number;
  name: string;
  /** Per field: what the person decided. Set for conflicts, and for any value typed over. */
  decisions: Partial<Record<FieldKey, Decision>>;
  /** ONE tap covers every unchecked field: "I checked these against the label". */
  uncheckedAcknowledged: boolean;
  columnIndex: number;
  /** Set when re-running the verifier failed; saving is blocked until a later change succeeds. */
  recheckError?: string;
}

/** The order rows appear in — the order the regulations print them. */
export const FIELD_ORDER: FieldKey[] = [
  "kcal",
  "kj",
  "fat",
  "sat",
  "trans",
  "chol",
  "sodium",
  "carb",
  "fiber",
  "sugar",
  "added",
  "prot",
  "salt",
];

/** Fields the saved food cannot exist without. Energy is satisfied by kcal OR kJ. */
export const ESSENTIALS = ["energy", "fat", "carb", "prot"] as const;
export type Essential = (typeof ESSENTIALS)[number];

// ── construction ──────────────────────────────────────────────────────────────

/** The serving weight the label offers, as read — a starting point for the person, never a confirmation. */
export function readServingGrams(panel: ParsedPanel, columnIndex = 0): number {
  const col = panel.columns[columnIndex];
  if (col?.basis === "serving" && col.servingGrams && col.servingGrams > 0) return col.servingGrams;
  const v = panel.serving?.value;
  return v && Number.isFinite(v) && v > 0 ? v : 0;
}

export function initConfirmState(args: {
  panel: ParsedPanel;
  verification: Verification;
  repairs: Repair[];
  name?: string;
  columnIndex?: number;
}): ConfirmState {
  const columnIndex = args.columnIndex ?? 0;
  return {
    panel: args.panel,
    verification: args.verification,
    repairs: args.repairs,
    // Rule 3: never pre-confirmed, even when the read is clean.
    servingConfirmed: false,
    servingGrams: readServingGrams(args.panel, columnIndex),
    name: args.name ?? "",
    decisions: {},
    uncheckedAcknowledged: false,
    columnIndex,
  };
}

// ── panel edits (pure, never mutate) ──────────────────────────────────────────

function withColumn(
  panel: ParsedPanel,
  columnIndex: number,
  edit: (col: ParsedPanel["columns"][number]) => ParsedPanel["columns"][number],
): ParsedPanel {
  const col = panel.columns[columnIndex];
  if (!col) throw new Error(`The label has no column ${columnIndex}.`);
  const columns = panel.columns.slice();
  columns[columnIndex] = edit(col);
  return { ...panel, columns };
}

/** The panel with one suggested repair applied. The digit changes; where it was read from does not. */
export function applyRepair(panel: ParsedPanel, repair: Repair, columnIndex = 0): ParsedPanel {
  const { field, kind } = repair.target;
  const next: ReadValue = { value: repair.to, raw: String(repair.to) };
  if (repair.from.lessThan) next.lessThan = true;
  if (repair.from.token != null) next.token = repair.from.token;
  return withColumn(panel, columnIndex, (col) =>
    kind === "amount"
      ? { ...col, fields: { ...col.fields, [field]: next } }
      : { ...col, refPct: { ...col.refPct, [field]: next } },
  );
}

/** The panel with a value a person typed over the read. Typed means exact: any "less than" is dropped. */
export function setField(
  panel: ParsedPanel,
  field: FieldKey,
  kind: "amount" | "refPct",
  value: number,
  columnIndex = 0,
): ParsedPanel {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Not a usable value for ${field}: ${value}`);
  return withColumn(panel, columnIndex, (col) => {
    const prev = kind === "amount" ? col.fields[field] : col.refPct[field];
    const next: ReadValue = { value, raw: String(value) };
    if (prev?.token != null) next.token = prev.token;
    return kind === "amount"
      ? { ...col, fields: { ...col.fields, [field]: next } }
      : { ...col, refPct: { ...col.refPct, [field]: next } };
  });
}

/** The panel with the serving a person confirmed, so the mass check tests the serving that will be saved. */
export function setServing(panel: ParsedPanel, grams: number, columnIndex = 0): ParsedPanel {
  if (!Number.isFinite(grams) || grams <= 0) throw new Error(`Not a usable serving: ${grams}`);
  const next: ParsedPanel = {
    ...panel,
    serving: { value: grams, raw: String(grams), ...(panel.serving?.token != null ? { token: panel.serving.token } : {}) },
  };
  const col = panel.columns[columnIndex];
  if (col?.basis === "serving" && col.servingGrams != null) {
    return withColumn(next, columnIndex, (c) => ({ ...c, servingGrams: grams }));
  }
  return next;
}

// ── reading the verdicts ──────────────────────────────────────────────────────

/** Fields whose amount OR percentage the label disagrees with itself about. */
export function conflictFields(v: Verification): FieldKey[] {
  const out = FIELD_ORDER.filter((k) => v.fields[k] === "conflict" || v.refPct[k] === "conflict");
  // Defensive: a verification that says "inconsistent" but marks no field would
  // otherwise let Save through with nothing to decide. Fall back to every field
  // the failing relations name.
  if (!out.length && !v.consistent) {
    const named = new Set(v.failures.flatMap((f) => f.fields));
    return FIELD_ORDER.filter((k) => named.has(k));
  }
  return out;
}

/** Fields nothing printed can confirm (rule 4). */
export function uncheckedFields(v: Verification): FieldKey[] {
  return FIELD_ORDER.filter((k) => v.fields[k] === "unchecked");
}

/** The verdict a row shows: a conflict on the percentage is a conflict on the row. */
export function rowVerdict(v: Verification, field: FieldKey): FieldVerdict | undefined {
  if (v.fields[field] === "conflict" || v.refPct[field] === "conflict") return "conflict";
  return v.fields[field];
}

/** The failure sentences that involve a field, for "! why". */
export function failureMessages(v: Verification, field: FieldKey): string[] {
  return v.failures.filter((f) => f.fields.includes(field)).map((f) => f.message);
}

/** Which of the fields the saved food needs are absent from the panel as edited. */
export function missingEssentials(panel: ParsedPanel, columnIndex = 0): Essential[] {
  const f = panel.columns[columnIndex]?.fields ?? {};
  const out: Essential[] = [];
  if (f.kcal == null && f.kj == null) out.push("energy");
  if (f.fat == null) out.push("fat");
  if (f.carb == null) out.push("carb");
  if (f.prot == null) out.push("prot");
  return out;
}

/** The fields that get a row: everything read, everything the verifier has a verdict on, and any essential still to type. */
export function rowFields(state: ConfirmState): FieldKey[] {
  const col = state.panel.columns[state.columnIndex];
  const show = new Set<FieldKey>();
  for (const k of FIELD_ORDER) {
    if (col?.fields[k] || col?.refPct[k] || state.verification.fields[k] || state.verification.refPct[k]) show.add(k);
  }
  for (const e of missingEssentials(state.panel, state.columnIndex)) show.add(e === "energy" ? "kcal" : e);
  return FIELD_ORDER.filter((k) => show.has(k));
}

/** Suggestions still worth showing for a field: its value is still the one the suggestion was made from, and the person hasn't answered it. */
export function repairsFor(state: ConfirmState, field: FieldKey): Repair[] {
  const d = state.decisions[field];
  if (d === "kept" || d === "edited") return [];
  const col = state.panel.columns[state.columnIndex];
  return state.repairs.filter((r) => {
    if (r.target.field !== field) return false;
    const current = r.target.kind === "amount" ? col?.fields[field] : col?.refPct[field];
    return !!current && current.value === r.from.value;
  });
}

// ── what still stands between the person and Save ─────────────────────────────

export type Blocker =
  | { kind: "serving" }
  | { kind: "name" }
  | { kind: "conflict"; fields: FieldKey[] }
  | { kind: "unchecked"; fields: FieldKey[] }
  | { kind: "essentials"; fields: Essential[] }
  | { kind: "recheck"; message: string };

export function pendingConflicts(state: ConfirmState): FieldKey[] {
  return conflictFields(state.verification).filter((k) => !state.decisions[k]);
}

/** Unchecked fields not yet looked at. Typing over a value IS looking at it, so an edited field needs no acknowledgement. */
export function pendingUnchecked(state: ConfirmState): FieldKey[] {
  if (state.uncheckedAcknowledged) return [];
  return uncheckedFields(state.verification).filter((k) => state.decisions[k] !== "edited");
}

export function blockers(state: ConfirmState): Blocker[] {
  const out: Blocker[] = [];
  if (!state.servingConfirmed || !(state.servingGrams > 0)) out.push({ kind: "serving" });
  if (!state.name.trim()) out.push({ kind: "name" });
  const conflicts = pendingConflicts(state);
  if (conflicts.length) out.push({ kind: "conflict", fields: conflicts });
  const unchecked = pendingUnchecked(state);
  if (unchecked.length) out.push({ kind: "unchecked", fields: unchecked });
  // Not a verdict — the arithmetic of a food needs these, and saving without
  // them would throw in toLabelFood. Better said here, before the tap.
  const missing = missingEssentials(state.panel, state.columnIndex);
  if (missing.length) out.push({ kind: "essentials", fields: missing });
  if (state.recheckError) out.push({ kind: "recheck", message: state.recheckError });
  return out;
}

/**
 * Save is allowed only when: the serving is confirmed and above 0, there is a
 * name, every conflict has a decision, every unchecked field has been looked at
 * (one tap for all of them), the food's essentials exist, and the verdicts on
 * screen are current.
 */
export function canSave(state: ConfirmState): boolean {
  return blockers(state).length === 0;
}

// ── transitions (each returns a NEW state) ────────────────────────────────────

/**
 * Re-run the verifier on a new panel. Suggestions are re-asked for when a
 * suggester is given; otherwise the old ones stay and `repairsFor` hides any
 * whose value has since changed. A new unchecked field the person has not yet
 * seen withdraws the earlier "I checked these".
 */
export function recheck(state: ConfirmState, panel: ParsedPanel, verify: VerifyFn, suggest?: SuggestFn): ConfirmState {
  let verification: Verification;
  try {
    verification = verify(panel, state.columnIndex);
  } catch (e) {
    return { ...state, panel, recheckError: errorText(e) };
  }
  let repairs = state.repairs;
  if (suggest) {
    try {
      repairs = verification.consistent ? [] : suggest(panel, state.columnIndex);
    } catch {
      // Suggestions are a convenience; the verdicts are what gate saving.
    }
  }
  const before = new Set(uncheckedFields(state.verification));
  const newlyUnchecked = uncheckedFields(verification).some((k) => !before.has(k));
  return {
    ...state,
    panel,
    verification,
    repairs,
    uncheckedAcknowledged: state.uncheckedAcknowledged && !newlyUnchecked,
    recheckError: undefined,
  };
}

/** "That's right" — the serving shown is the serving on the label. */
export function confirmServing(state: ConfirmState): ConfirmState {
  if (!(state.servingGrams > 0)) return state;
  return { ...state, servingConfirmed: true };
}

/** A person typed the serving. Typing it and pressing Use is confirming it. */
export function editServing(state: ConfirmState, grams: number, verify: VerifyFn, suggest?: SuggestFn): ConfirmState {
  if (!Number.isFinite(grams) || grams <= 0) return { ...state, servingGrams: 0, servingConfirmed: false };
  const next = recheck(state, setServing(state.panel, grams, state.columnIndex), verify, suggest);
  return { ...next, servingGrams: grams, servingConfirmed: true };
}

/** "Use {to}" — the only way a repair is ever applied. */
export function acceptRepair(state: ConfirmState, repair: Repair, verify: VerifyFn, suggest?: SuggestFn): ConfirmState {
  const next = recheck(state, applyRepair(state.panel, repair, state.columnIndex), verify, suggest);
  return { ...next, decisions: { ...next.decisions, [repair.target.field]: "repaired" } };
}

/** "Keep {from}" — the person says the read is what's printed. */
export function keepRead(state: ConfirmState, field: FieldKey): ConfirmState {
  return { ...state, decisions: { ...state.decisions, [field]: "kept" } };
}

/** A person typed over a value. */
export function editValue(
  state: ConfirmState,
  field: FieldKey,
  kind: "amount" | "refPct",
  value: number,
  verify: VerifyFn,
  suggest?: SuggestFn,
): ConfirmState {
  if (!Number.isFinite(value) || value < 0) return state;
  const next = recheck(state, setField(state.panel, field, kind, value, state.columnIndex), verify, suggest);
  return { ...next, decisions: { ...next.decisions, [field]: "edited" } };
}

/** "I checked these against the label" — one tap for every unchecked field. */
export function acknowledgeUnchecked(state: ConfirmState): ConfirmState {
  return { ...state, uncheckedAcknowledged: true };
}

export function setName(state: ConfirmState, name: string): ConfirmState {
  return { ...state, name };
}

// ── handing off to the save ───────────────────────────────────────────────────

/** Amounts the person changed from the original read — the trace of what a human decided. */
export function overridesOf(original: ParsedPanel, edited: ParsedPanel, columnIndex = 0): Partial<Record<FieldKey, number>> {
  const a = original.columns[columnIndex]?.fields ?? {};
  const b = edited.columns[columnIndex]?.fields ?? {};
  const out: Partial<Record<FieldKey, number>> = {};
  for (const k of FIELD_ORDER) {
    const v = b[k]?.value;
    if (v != null && v !== a[k]?.value) out[k] = v;
  }
  return out;
}

/** The Confirmed record toLabelFood takes, from a state that can be saved. */
export function toConfirmed(
  state: ConfirmState,
  original: ParsedPanel,
  extra: { barcode?: string; brand?: string } = {},
): Confirmed {
  if (!canSave(state)) throw new Error("This label isn't ready to save yet.");
  const overrides = overridesOf(original, state.panel, state.columnIndex);
  return {
    servingGrams: state.servingGrams,
    name: state.name.trim(),
    ...(extra.brand ? { brand: extra.brand } : {}),
    ...(extra.barcode ? { barcode: extra.barcode } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
    columnIndex: state.columnIndex,
  };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
