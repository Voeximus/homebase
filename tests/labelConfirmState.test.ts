import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// labelSave → lib/supabase builds a real client at import, which needs env the
// test runner doesn't have. Only `functions.invoke` is ever used.
const invoke = vi.fn();
vi.mock("../src/lib/supabase", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

import {
  acceptRepair,
  acknowledgeUnchecked,
  applyRepair,
  blockers,
  canSave,
  confirmServing,
  conflictFields,
  editServing,
  editValue,
  initConfirmState,
  keepRead,
  missingEssentials,
  overridesOf,
  pendingConflicts,
  pendingUnchecked,
  readServingGrams,
  recheck,
  repairsFor,
  rowFields,
  rowVerdict,
  setField,
  setName,
  setServing,
  toConfirmed,
  type ConfirmState,
} from "../src/lib/labelConfirmState";
import { toLabelFood } from "../src/lib/labelScan/food";
import type { CheckFailure, FieldKey, FieldVerdict, ParsedPanel, ReadValue, Repair, Verification } from "../src/lib/labelScan/types";
import { LabelConfirmSheet } from "../src/components/LabelConfirmSheet";
import { LabelScanFlow, labelFoodToFood, readLabel, type LabelReadDeps } from "../src/components/LabelScanFlow";
import { saveLabelFood } from "../src/lib/labelSave";

// The confirm screen holds three measured rules (src/lib/labelScan/types.ts):
// a repair is only a suggestion (rule 2), serving size is always confirmed by a
// person (rule 3), and a field with no second copy is never "checked" (rule 4).
// These tests hold the GATING to those rules. The verifier itself belongs to
// another module, so a small deterministic fake stands in for it here — the
// point is what the screen does with verdicts, not how verdicts are made.

const rv = (value: number, extra: Partial<ReadValue> = {}): ReadValue => ({ value, raw: String(value), ...extra });

/** The research's sketch: a snack bar whose "9 g" fat was read as "99 g". */
const misreadBar = (fat = 99): ParsedPanel => ({
  regime: "us",
  regimeEvidence: "Nutrition Facts",
  serving: rv(40),
  servingText: "1 bar (40g)",
  columns: [
    {
      basis: "serving",
      servingGrams: 40,
      fields: { kcal: rv(190), fat: rv(fat, { token: 7 }), sat: rv(3.5), sodium: rv(65), carb: rv(22), sugar: rv(9), prot: rv(6) },
      refPct: { fat: rv(12), sat: rv(18), sodium: rv(3), carb: rv(8) },
    },
  ],
  warnings: [],
});
const cleanBar = () => misreadBar(9);

const FAT_FIX: Repair = {
  target: { field: "fat", kind: "amount" },
  from: rv(99, { token: 7 }),
  to: 9,
  because: "The 12% printed beside it only fits 9 g.",
  fixes: ["ref", "energy"],
};

/**
 * A tiny stand-in verifier: fat's %DV against the US 78 g DRV, the mass check,
 * and total sugars permanently unchecked. Deterministic and pure, like the real one.
 */
function fakeVerify(panel: ParsedPanel, columnIndex = 0): Verification {
  const col = panel.columns[columnIndex];
  const fields: Partial<Record<FieldKey, FieldVerdict>> = {};
  const refPct: Partial<Record<FieldKey, FieldVerdict>> = {};
  const failures: CheckFailure[] = [];
  for (const k of Object.keys(col.fields) as FieldKey[]) fields[k] = k === "sugar" ? "unchecked" : "checked";
  for (const k of Object.keys(col.refPct) as FieldKey[]) refPct[k] = "checked";
  const fat = col.fields.fat?.value;
  const pct = col.refPct.fat?.value;
  if (fat != null && pct != null && Math.abs(Math.round((fat / 78) * 100) - pct) > 1) {
    fields.fat = "conflict";
    refPct.fat = "conflict";
    failures.push({ check: "ref", fields: ["fat"], message: `Fat says ${fat} g but ${pct}% means about ${Math.round((pct * 78) / 100)} g.` });
  }
  const serving = panel.serving?.value;
  const mass = (col.fields.prot?.value ?? 0) + (col.fields.carb?.value ?? 0) + (col.fields.fat?.value ?? 0);
  if (serving != null && col.basis === "serving" && mass > serving) {
    // Blame the largest of the three — the one a misread most likely inflated.
    const big = (["prot", "carb", "fat"] as const).reduce((a, b) => ((col.fields[b]?.value ?? 0) > (col.fields[a]?.value ?? 0) ? b : a));
    fields[big] = "conflict";
    failures.push({ check: "mass", fields: ["prot", "carb", "fat"], message: `${mass} g of macros can't fit in a ${serving} g serving.` });
  }
  return {
    consistent: failures.length === 0,
    column: col.basis,
    fields,
    refPct,
    failures,
    needsConfirm: ["serving", ...(Object.keys(fields) as FieldKey[]).filter((k) => fields[k] === "unchecked")],
  };
}

const fakeSuggest = (panel: ParsedPanel): Repair[] =>
  panel.columns[0].fields.fat?.value === 99 ? [FAT_FIX] : [];

const start = (panel: ParsedPanel, name = "Chocolate chip snack bars"): ConfirmState =>
  initConfirmState({ panel, verification: fakeVerify(panel), repairs: fakeSuggest(panel), name });

// ── the clean path and its tap count ──────────────────────────────────────────

describe("the clean path — confirm serving, acknowledge sugar, save", () => {
  it("never starts with the serving confirmed, even when it was read cleanly (rule 3)", () => {
    const s = start(cleanBar());
    expect(s.servingGrams).toBe(40);
    expect(s.servingConfirmed).toBe(false);
    expect(canSave(s)).toBe(false);
    expect(blockers(s).map((b) => b.kind)).toEqual(["serving", "unchecked"]);
  });

  it("total sugars asks to be looked at — it can never be checked (rule 4)", () => {
    const s = confirmServing(start(cleanBar()));
    expect(rowVerdict(s.verification, "sugar")).toBe("unchecked");
    expect(pendingUnchecked(s)).toEqual(["sugar"]);
    expect(canSave(s)).toBe(false);
  });

  it("is three taps: That's right → I checked these → Save", () => {
    const taps: Array<(s: ConfirmState) => ConfirmState> = [confirmServing, acknowledgeUnchecked];
    const s = taps.reduce((st, tap) => tap(st), start(cleanBar()));
    expect(canSave(s)).toBe(true); // …and the third tap is Save itself
    expect(taps.length + 1).toBe(3);
  });

  it("acknowledging is ONE tap for every unchecked field at once", () => {
    const panel = cleanBar();
    const v = fakeVerify(panel);
    v.fields.prot = "unchecked"; // protein went silent too
    let s = initConfirmState({ panel, verification: v, repairs: [], name: "Bar" });
    s = confirmServing(s);
    expect(pendingUnchecked(s)).toEqual(["sugar", "prot"]);
    s = acknowledgeUnchecked(s);
    expect(pendingUnchecked(s)).toEqual([]);
    expect(canSave(s)).toBe(true);
  });

  it("needs a name", () => {
    let s = acknowledgeUnchecked(confirmServing(start(cleanBar(), "")));
    expect(blockers(s).map((b) => b.kind)).toEqual(["name"]);
    s = setName(s, "   ");
    expect(canSave(s)).toBe(false);
    s = setName(s, "Snack bar");
    expect(canSave(s)).toBe(true);
  });

  it("a serving of 0 cannot be confirmed", () => {
    const panel = cleanBar();
    delete panel.serving;
    delete panel.columns[0].servingGrams;
    const s = start(panel);
    expect(s.servingGrams).toBe(0);
    expect(confirmServing(s)).toBe(s);
    expect(editServing(s, 0, fakeVerify).servingConfirmed).toBe(false);
  });
});

// ── a suggested repair ────────────────────────────────────────────────────────

describe("a suggested repair is never applied without a tap (rule 2)", () => {
  it("the misread stays on screen, flagged, with its suggestion beside it", () => {
    const s = start(misreadBar());
    expect(s.panel.columns[0].fields.fat?.value).toBe(99);
    expect(rowVerdict(s.verification, "fat")).toBe("conflict");
    expect(repairsFor(s, "fat")).toEqual([FAT_FIX]);
    const ready = acknowledgeUnchecked(confirmServing(s));
    expect(blockers(ready)).toEqual([{ kind: "conflict", fields: ["fat"] }]);
  });

  it("Use 9 g → a new panel, re-verified, and four taps in all", () => {
    const original = misreadBar();
    let s = start(original);
    s = confirmServing(s); // 1
    s = acceptRepair(s, FAT_FIX, fakeVerify, fakeSuggest); // 2
    s = acknowledgeUnchecked(s); // 3
    expect(canSave(s)).toBe(true); // 4 = Save
    expect(s.panel.columns[0].fields.fat).toEqual({ value: 9, raw: "9", token: 7 });
    expect(s.verification.consistent).toBe(true);
    expect(rowVerdict(s.verification, "fat")).toBe("checked");
    expect(s.decisions.fat).toBe("repaired");
    expect(s.repairs).toEqual([]); // re-asked on the new panel
    expect(original.columns[0].fields.fat?.value).toBe(99); // never mutated
  });

  it("Keep 99 g → decided, the conflict stays true, and the suggestion goes away", () => {
    let s = acknowledgeUnchecked(confirmServing(start(misreadBar())));
    s = keepRead(s, "fat");
    expect(s.decisions.fat).toBe("kept");
    expect(s.verification.consistent).toBe(false);
    expect(conflictFields(s.verification)).toEqual(["fat"]);
    expect(repairsFor(s, "fat")).toEqual([]);
    expect(canSave(s)).toBe(true);
  });

  it("typing over the value answers the suggestion too", () => {
    let s = confirmServing(start(misreadBar()));
    s = editValue(s, "fat", "amount", 9.5, fakeVerify);
    expect(s.decisions.fat).toBe("edited");
    expect(repairsFor(s, "fat")).toEqual([]);
    expect(s.verification.consistent).toBe(true);
  });

  it("a stale suggestion hides once its value has changed", () => {
    const s = start(misreadBar());
    // The percentage was edited instead — the amount still reads 99, so it shows…
    const pctEdited = { ...s, panel: setField(s.panel, "fat", "refPct", 127) };
    expect(repairsFor(pctEdited, "fat")).toEqual([FAT_FIX]);
    // …but once the amount itself is different, the suggestion no longer describes it.
    const amountChanged = { ...s, panel: setField(s.panel, "fat", "amount", 90) };
    expect(repairsFor(amountChanged, "fat")).toEqual([]);
  });

  it("a repair can target the percentage copy", () => {
    const panel = cleanBar();
    panel.columns[0].refPct.fat = rv(72, { token: 9 });
    const fix: Repair = { target: { field: "fat", kind: "refPct" }, from: rv(72, { token: 9 }), to: 12, because: "9 g only fits 12%.", fixes: ["ref"] };
    let s = start(panel);
    expect(rowVerdict(s.verification, "fat")).toBe("conflict");
    s = acceptRepair(s, fix, fakeVerify);
    expect(s.panel.columns[0].refPct.fat).toEqual({ value: 12, raw: "12", token: 9 });
    expect(s.panel.columns[0].fields.fat?.value).toBe(9);
    expect(s.verification.consistent).toBe(true);
  });
});

// ── the pure panel edits ──────────────────────────────────────────────────────

describe("panel edits never mutate", () => {
  it("applyRepair returns a new panel and keeps a 'less than'", () => {
    const panel = cleanBar();
    panel.columns[0].fields.sat = rv(1, { lessThan: true, token: 3 });
    const fix: Repair = { target: { field: "sat", kind: "amount" }, from: panel.columns[0].fields.sat!, to: 0.5, because: "", fixes: [] };
    const before = JSON.stringify(panel);
    const next = applyRepair(panel, fix);
    expect(JSON.stringify(panel)).toBe(before);
    expect(next).not.toBe(panel);
    expect(next.columns[0].fields.sat).toEqual({ value: 0.5, raw: "0.5", lessThan: true, token: 3 });
    expect(next.columns[0].fields.fat).toBe(panel.columns[0].fields.fat); // untouched fields are shared, not copied
  });

  it("setField drops 'less than' — a typed number is exact", () => {
    const panel = cleanBar();
    panel.columns[0].fields.prot = rv(1, { lessThan: true, token: 11 });
    const next = setField(panel, "prot", "amount", 0.8);
    expect(next.columns[0].fields.prot).toEqual({ value: 0.8, raw: "0.8", token: 11 });
    expect(panel.columns[0].fields.prot?.lessThan).toBe(true);
  });

  it("setField refuses a value no label prints", () => {
    expect(() => setField(cleanBar(), "fat", "amount", -1)).toThrow();
    expect(() => setField(cleanBar(), "fat", "amount", NaN)).toThrow();
    const s = start(cleanBar());
    expect(editValue(s, "fat", "amount", -3, fakeVerify)).toBe(s);
  });

  it("setServing writes the confirmed serving into the panel and its serving column", () => {
    const panel = cleanBar();
    const next = setServing(panel, 45);
    expect(next.serving?.value).toBe(45);
    expect(next.columns[0].servingGrams).toBe(45);
    expect(panel.serving?.value).toBe(40);
    expect(() => setServing(panel, 0)).toThrow();
  });

  it("an edit to a column that doesn't exist is an error, not a silent no-op", () => {
    expect(() => setField(cleanBar(), "fat", "amount", 1, 4)).toThrow(/column 4/);
  });
});

// ── the serving ───────────────────────────────────────────────────────────────

describe("editing the serving", () => {
  it("typing it confirms it, and the checks re-run against it", () => {
    let s = start(cleanBar()); // 37 g of macros in a 40 g serving — fits
    s = editServing(s, 30, fakeVerify); // …but not in 30 g
    expect(s.servingConfirmed).toBe(true);
    expect(s.servingGrams).toBe(30);
    expect(s.panel.serving?.value).toBe(30);
    expect(rowVerdict(s.verification, "carb")).toBe("conflict");
    expect(pendingConflicts(s)).toEqual(["carb"]);
  });

  it("the serving offered comes from the serving column, then the serving line", () => {
    const panel = cleanBar();
    expect(readServingGrams(panel)).toBe(40);
    delete panel.columns[0].servingGrams;
    panel.serving = rv(42);
    expect(readServingGrams(panel)).toBe(42);
    panel.columns[0].basis = "100g";
    panel.columns[0].servingGrams = 99; // a per-100 g column's own grams aren't a serving
    expect(readServingGrams(panel)).toBe(42);
  });
});

// ── re-verification ───────────────────────────────────────────────────────────

describe("re-verification keeps the screen honest", () => {
  it("an unchecked field appearing after the acknowledgement withdraws it", () => {
    let s = acknowledgeUnchecked(confirmServing(start(cleanBar())));
    expect(canSave(s)).toBe(true);
    const verifyWithSilentProtein = (p: ParsedPanel) => {
      const v = fakeVerify(p);
      v.fields.prot = "unchecked";
      return v;
    };
    s = editValue(s, "carb", "amount", 23, verifyWithSilentProtein);
    expect(s.uncheckedAcknowledged).toBe(false);
    expect(pendingUnchecked(s)).toEqual(["sugar", "prot"]);
  });

  it("the same unchecked set keeps the acknowledgement", () => {
    let s = acknowledgeUnchecked(confirmServing(start(cleanBar())));
    s = editValue(s, "carb", "amount", 23, fakeVerify);
    expect(s.uncheckedAcknowledged).toBe(true);
  });

  it("typing over an unchecked value counts as having looked at it", () => {
    let s = confirmServing(start(cleanBar()));
    s = editValue(s, "sugar", "amount", 8, fakeVerify);
    expect(s.verification.fields.sugar).toBe("unchecked"); // still unconfirmable…
    expect(pendingUnchecked(s)).toEqual([]); // …but a person just typed it
    expect(canSave(s)).toBe(true);
  });

  it("a new conflict created by an edit needs its own decision", () => {
    let s = acknowledgeUnchecked(confirmServing(start(cleanBar())));
    s = editValue(s, "fat", "amount", 12, fakeVerify); // 12 g no longer fits 12%
    expect(rowVerdict(s.verification, "fat")).toBe("conflict");
    expect(s.decisions.fat).toBe("edited"); // the person typed it — that is their decision
    expect(canSave(s)).toBe(true);
    s = editServing(s, 30, fakeVerify); // 6 + 22 + 12 g of macros won't fit in 30 g
    expect(pendingConflicts(s)).toEqual(["carb"]);
    expect(canSave(s)).toBe(false);
  });

  it("a verifier that throws blocks saving until a later check succeeds", () => {
    let s = acknowledgeUnchecked(confirmServing(start(cleanBar())));
    const boom = () => {
      throw new Error("verify: not implemented");
    };
    s = editValue(s, "carb", "amount", 23, boom);
    expect(s.panel.columns[0].fields.carb?.value).toBe(23);
    expect(blockers(s)).toEqual([{ kind: "recheck", message: "verify: not implemented" }]);
    s = editValue(s, "carb", "amount", 22, fakeVerify);
    expect(s.recheckError).toBeUndefined();
    expect(canSave(s)).toBe(true);
  });

  it("a suggester that throws keeps the old suggestions rather than failing the edit", () => {
    const s = start(misreadBar());
    const next = recheck(s, setField(s.panel, "sat", "amount", 4), fakeVerify, () => {
      throw new Error("suggestRepairs: not implemented");
    });
    expect(next.repairs).toEqual([FAT_FIX]);
    expect(next.recheckError).toBeUndefined();
  });
});

// ── what a row is, and what the save needs ────────────────────────────────────

describe("rows and essentials", () => {
  it("an inconsistent verdict that marks no field still blocks, on every field it names", () => {
    const v: Verification = {
      consistent: false,
      column: "serving",
      fields: { kcal: "checked", fat: "checked", carb: "checked", prot: "checked" },
      refPct: {},
      failures: [{ check: "energy", fields: ["kcal", "fat", "carb", "prot"], message: "Calories say 190 but the macros allow 210–250." }],
      needsConfirm: ["serving"],
    };
    expect(conflictFields(v)).toEqual(["kcal", "fat", "carb", "prot"]);
  });

  it("a missing essential gets a row to type into and blocks saving", () => {
    const panel = cleanBar();
    delete panel.columns[0].fields.prot;
    delete panel.columns[0].fields.kcal;
    let s = acknowledgeUnchecked(confirmServing(start(panel)));
    expect(missingEssentials(s.panel)).toEqual(["energy", "prot"]);
    expect(rowFields(s)).toContain("kcal");
    expect(rowFields(s)).toContain("prot");
    expect(blockers(s)).toEqual([{ kind: "essentials", fields: ["energy", "prot"] }]);
    s = editValue(s, "prot", "amount", 6, fakeVerify);
    s = editValue(s, "kcal", "amount", 190, fakeVerify);
    expect(canSave(s)).toBe(true);
  });

  it("kJ alone satisfies energy", () => {
    const panel = cleanBar();
    delete panel.columns[0].fields.kcal;
    panel.columns[0].fields.kj = rv(795);
    expect(missingEssentials(panel)).toEqual([]);
  });

  it("rows follow the printed order and include every field with a verdict", () => {
    const s = start(cleanBar());
    expect(rowFields(s)).toEqual(["kcal", "fat", "sat", "sodium", "carb", "sugar", "prot"]);
  });
});

// ── handing off to the save ───────────────────────────────────────────────────

describe("from a confirmed state to the saved food", () => {
  it("won't build a Confirmed record from a state that can't be saved", () => {
    expect(() => toConfirmed(start(cleanBar()), cleanBar())).toThrow();
  });

  it("the repaired snack bar saves as the research's worked example", () => {
    const original = misreadBar();
    let s = start(original);
    s = acknowledgeUnchecked(acceptRepair(confirmServing(s), FAT_FIX, fakeVerify, fakeSuggest));
    const confirmed = toConfirmed(s, original, { barcode: "0049000028911" });
    expect(confirmed).toEqual({
      servingGrams: 40,
      name: "Chocolate chip snack bars",
      barcode: "0049000028911",
      overrides: { fat: 9 },
      columnIndex: 0,
    });
    // The same food whether computed from the edited panel or the original read + overrides.
    const fromEdited = toLabelFood(s.panel, confirmed, "engine@1");
    const fromOriginal = toLabelFood(original, confirmed, "engine@1");
    expect(fromEdited).toEqual(fromOriginal);
    expect(fromEdited).toMatchObject({ kcal: 475, f: 22.5, c: 55, p: 15, serving: 40, source: "label", engine: "engine@1" });
  });

  it("overridesOf lists only amounts a person changed", () => {
    const original = misreadBar();
    const edited = setField(setField(original, "fat", "amount", 9), "fat", "refPct", 12);
    expect(overridesOf(original, edited)).toEqual({ fat: 9 });
    expect(overridesOf(original, original)).toEqual({});
  });

  it("maps to the app's Food with the canonical barcode and a neutral role", () => {
    const food = labelFoodToFood({ name: "Bar", kcal: 475, p: 15, c: 55, f: 22.5, serving: 40, barcode: "049000028911", source: "label" });
    expect(food).toEqual({ id: "label-0049000028911", name: "Bar", role: "other", kcal: 475, p: 15, c: 55, f: 22.5, serving: 40, barcode: "0049000028911" });
    const noCode = labelFoodToFood({ name: "Bar", kcal: 1, p: 0, c: 0, f: 0, source: "label" });
    expect(noCode.barcode).toBeUndefined();
    expect(noCode.id.startsWith("label-")).toBe(true);
  });
});

// ── the flow degrades instead of throwing ─────────────────────────────────────

describe("readLabel — every stage fails into a plain answer", () => {
  const blob = new Blob(["not really a photo"]);
  const page = { width: 1, height: 1, tokens: [], engine: "test@1" };

  it("with the real modules still stubbed, it reports the read stage — it doesn't throw", async () => {
    const r = await readLabel(blob);
    expect(r).toEqual({ ok: false, stage: "read", detail: "recognize: not implemented" });
  });

  it("no nutrition panel in the photo", async () => {
    const deps: LabelReadDeps = { recognize: async () => page, parseLabel: () => null, verify: fakeVerify, suggestRepairs: fakeSuggest };
    expect(await readLabel(blob, deps)).toEqual({ ok: false, stage: "no-panel" });
  });

  it("a parser or verifier that throws", async () => {
    const boom = () => {
      throw new Error("x");
    };
    expect(await readLabel(blob, { recognize: async () => page, parseLabel: boom, verify: fakeVerify, suggestRepairs: fakeSuggest })).toMatchObject({ ok: false, stage: "parse" });
    expect(await readLabel(blob, { recognize: async () => page, parseLabel: () => misreadBar(), verify: boom, suggestRepairs: fakeSuggest })).toMatchObject({ ok: false, stage: "check" });
  });

  it("a suggester that throws still reaches the confirm screen, without suggestions", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await readLabel(blob, {
      recognize: async () => page,
      parseLabel: () => misreadBar(),
      verify: fakeVerify,
      suggestRepairs: () => {
        throw new Error("suggestRepairs: not implemented");
      },
    });
    expect(r).toMatchObject({ ok: true, repairs: [], engine: "test@1" });
  });

  it("the happy path hands over panel, verdicts, suggestions and the engine", async () => {
    const suggest = vi.fn(fakeSuggest);
    const r = await readLabel(blob, { recognize: async () => page, parseLabel: () => misreadBar(), verify: fakeVerify, suggestRepairs: suggest });
    expect(r).toMatchObject({ ok: true, repairs: [FAT_FIX], engine: "test@1" });
    // A consistent label isn't asked for repairs at all.
    suggest.mockClear();
    await readLabel(blob, { recognize: async () => page, parseLabel: () => cleanBar(), verify: fakeVerify, suggestRepairs: suggest });
    expect(suggest).not.toHaveBeenCalled();
  });
});

// ── the drawing, rendered once without a browser ──────────────────────────────

describe("LabelConfirmSheet renders the three states", () => {
  const html = renderToStaticMarkup(
    createElement(LabelConfirmSheet, {
      panel: misreadBar(),
      verification: fakeVerify(misreadBar()),
      repairs: [FAT_FIX],
      initialName: "Chocolate chip snack bars",
      verify: fakeVerify,
      onSave: () => {},
      onRetake: () => {},
      onClose: () => {},
    }),
  );

  it("asks for the serving, shows the suggestion as buttons, and flags sugar", () => {
    expect(html).toContain("That&#x27;s right");
    expect(html).toContain("Printed: 1 bar (40g)");
    expect(html).toContain("Use 9 g");
    expect(html).toContain("Keep 99 g");
    expect(html).toContain("The 12% printed beside it only fits 9 g.");
    expect(html).toContain("Check this against the label — nothing printed can confirm it.");
    expect(html).toContain("I checked these against the label");
    expect(html).toContain("Retake");
  });

  it("shows the value as read — the suggestion is not pre-applied", () => {
    expect(html).toContain("99 g");
    expect(html).toMatch(/aria-label="Edit Total fat"[^>]*>99 g</);
  });

  it("starts with Save disabled", () => {
    expect(html).toMatch(/<button disabled=""[^>]*>.*Save &amp; use<\/button>/);
    expect(html).toContain("Confirm the serving size to save.");
  });

  it("the flow renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(LabelScanFlow, { open: false, onClose: () => {}, onFood: () => {} }))).toBe("");
  });
});

// ── sharing is a bonus: every failure is swallowed ────────────────────────────

describe("saveLabelFood never throws", () => {
  const req = { barcode: "0049000028911", panel: cleanBar(), overrides: {}, servingGrams: 40, name: "Bar" };
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("calls the food-label-save function with the confirmed panel", async () => {
    invoke.mockResolvedValue({ data: { saved: true }, error: null });
    expect(await saveLabelFood(req)).toBe("shared");
    expect(invoke).toHaveBeenCalledWith("food-label-save", { body: req });
  });

  it("a refusal, an HTTP error or a dead network all come back as a value", async () => {
    invoke.mockResolvedValue({ data: { saved: false, reason: "a catalog already answers for this barcode" }, error: null });
    expect(await saveLabelFood(req)).toBe("skipped");
    invoke.mockResolvedValue({ data: null, error: new Error("409") });
    expect(await saveLabelFood(req)).toBe("failed");
    invoke.mockRejectedValue(new Error("offline"));
    expect(await saveLabelFood(req)).toBe("failed");
  });
});
