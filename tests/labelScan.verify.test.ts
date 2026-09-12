import { describe, it, expect } from "vitest";
import { verify, verifyColumn } from "../src/lib/labelScan/verify";
import { numberText, ocrConfusions, suggestRepairs } from "../src/lib/labelScan/repair";
import type { Basis, FieldKey, ParsedPanel, ReadValue, Regime } from "../src/lib/labelScan/types";

// Panels are built by hand (there is no parser yet) from real or regulation-shaped
// labels. Every constructed label below has its arithmetic worked in a comment, so a
// failing test can be checked against the regulation rather than against the code.

const rv = (raw: string | number, lessThan?: boolean): ReadValue => {
  const text = String(raw);
  return { value: Number(text), raw: text, ...(lessThan ? { lessThan } : {}) };
};

function panel(
  regime: Regime,
  fields: Partial<Record<FieldKey, string | number>>,
  refPct: Partial<Record<FieldKey, string | number>> = {},
  opts: { basis?: Basis; serving?: number } = {},
): ParsedPanel {
  const basis = opts.basis ?? (regime === "us" ? "serving" : "100g");
  const map = (o: Partial<Record<FieldKey, string | number>>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rv(v!)])) as Partial<Record<FieldKey, ReadValue>>;
  return {
    regime,
    regimeEvidence: "test",
    serving: opts.serving !== undefined ? rv(opts.serving) : undefined,
    columns: [{ basis, servingGrams: basis === "serving" ? opts.serving : undefined, fields: map(fields), refPct: map(refPct) }],
    warnings: [],
  };
}

// The chocolate chip snack bar from the report (a real USDA FoodData Central record).
const BAR_FIELDS = { kcal: 190, fat: 9, sat: 3.5, trans: 0, chol: 0, sodium: 65, carb: 22, fiber: 2, sugar: 9, added: 5, prot: 6 };
const BAR_PCT = { fat: 12, sat: 18, chol: 0, sodium: 3, carb: 8, fiber: 7, added: 10 };
const bar = (fields: Partial<Record<FieldKey, string | number>> = {}, pct: Partial<Record<FieldKey, string | number>> = {}) =>
  panel("us", { ...BAR_FIELDS, ...fields }, { ...BAR_PCT, ...pct }, { serving: 40 });

describe("US — the snack-bar specimen", () => {
  it("is consistent, and every field but total sugars is checked", () => {
    const v = verify(bar());
    expect(v.failures).toEqual([]);
    expect(v.consistent).toBe(true);
    expect(v.column).toBe("serving");
    for (const k of ["kcal", "fat", "sat", "trans", "chol", "sodium", "carb", "fiber", "added", "prot"] as FieldKey[]) {
      expect(v.fields[k], k).toBe("checked");
    }
    // Rule 4: nothing printed restates total sugars.
    expect(v.fields.sugar).toBe("unchecked");
    for (const k of Object.keys(BAR_PCT) as FieldKey[]) expect(v.refPct[k], k).toBe("checked");
    // Rule 3: serving first, always.
    expect(v.needsConfirm).toEqual(["serving", "sugar"]);
  });

  it("'9g' read as 99: caught, and exactly one repair — back to 9 g, citing the 12%", () => {
    const read = bar({ fat: "99" });
    const v = verify(read);
    expect(v.consistent).toBe(false);
    expect(v.fields.fat).toBe("conflict");
    expect(v.needsConfirm[0]).toBe("serving");
    expect(v.needsConfirm).toContain("fat");

    const repairs = suggestRepairs(read);
    expect(repairs).toHaveLength(1);
    const [r] = repairs;
    expect(r.target).toEqual({ field: "fat", kind: "amount" });
    expect(r.from.raw).toBe("99");
    expect(r.to).toBe(9);
    expect(r.because).toBe("The 12% printed beside it only fits 9 g.");
    expect(r.fixes).toEqual(expect.arrayContaining(["ref", "energy", "mass"]));
    // And the repaired label really is consistent.
    expect(verify(bar()).consistent).toBe(true);
  });

  it("a total-sugars misread (9 → 8) passes every check — which is exactly why sugar is never 'checked'", () => {
    const v = verify(bar({ sugar: "8" }));
    expect(v.consistent).toBe(true);
    expect(v.fields.sugar).toBe("unchecked");
    expect(v.needsConfirm).toContain("sugar");
    expect(suggestRepairs(bar({ sugar: "8" }))).toEqual([]);
  });

  it("abstains when more than one repair fits: calories 190 read as 100 could be 180 or 190", () => {
    const read = bar({ kcal: "100" });
    expect(verify(read).fields.kcal).toBe("conflict");
    expect(suggestRepairs(read)).toEqual([]);
  });

  it("repairs a %DV the same way", () => {
    const read = bar({}, { sodium: "8" });
    const v = verify(read);
    expect(v.refPct.sodium).toBe("conflict");
    const [r] = suggestRepairs(read);
    expect(r.target).toEqual({ field: "sodium", kind: "refPct" });
    expect(r.to).toBe(3);
    expect(r.because).toBe("65 mg of sodium works out to 3%, not 8%.");
  });

  it("a missing mandatory line is 'missing', not a conflict", () => {
    const p = bar();
    delete p.columns[0].fields.added;
    delete p.columns[0].refPct.added;
    const v = verify(p);
    expect(v.consistent).toBe(true);
    expect(v.fields.added).toBe("missing");
    expect(v.needsConfirm).toEqual(["serving", "sugar", "added"]);
  });

  it("a partial read only earns 'checked' where the evidence actually ran", () => {
    // No calories line: the energy check cannot run, so calories-dependent confirmation is gone.
    const p = bar();
    delete p.columns[0].fields.kcal;
    const v = verify(p);
    expect(v.fields.kcal).toBe("missing");
    expect(v.fields.prot).toBe("unchecked");
    // Fat still has its %DV, and a field plus its %DV alone was measured under 15% silent.
    expect(v.fields.fat).toBe("checked");

    // A %DV column that was not read: amounts that lean on it fall back to unchecked.
    const noPct = panel("us", BAR_FIELDS, {}, { serving: 40 });
    const w = verify(noPct);
    expect(w.consistent).toBe(true);
    expect(w.fields.sodium).toBe("unchecked");
    expect(w.fields.chol).toBe("unchecked");
    expect(w.refPct.sodium).toBe("missing");
    expect(w.fields.kcal).toBe("checked");
    expect(w.fields.trans).toBe("checked");
  });

  it("'less than 1 g' means anywhere from 0 to 1 g — and that decides this label", () => {
    // 45 kcal (42.5–47.5) with carbs 12 g (11.5–12.5) and no fat. Protein "less than 1 g"
    // can be 0, so the macros reach down to 4·11.5 = 46 kcal: consistent. A plain "1 g"
    // means at least 0.5 g, so they start at 48 — above 47.5 plus the 1% margin.
    // The fiber line is left off on purpose: even a printed "0 g" fiber may be up to
    // 0.5 g, which the fiber allowance turns into 2 kcal of slack — the same 2 kcal this
    // test is about, so it would hide the difference.
    const make = (lessThan: boolean) => {
      const p = panel(
        "us",
        { kcal: 45, fat: 0, sat: 0, trans: 0, chol: 0, sodium: 0, carb: 12, sugar: 0, added: 0, prot: 1 },
        { fat: 0, sat: 0, chol: 0, sodium: 0, carb: 4, added: 0 },
        { serving: 15 },
      );
      p.columns[0].fields.prot = rv("1", lessThan);
      return p;
    };
    expect(verify(make(true)).consistent).toBe(true);
    expect(verify(make(false)).failures.map((f) => f.check)).toEqual(["energy"]);
  });

  it("serving size is always the first thing to confirm, even with no column at all", () => {
    const empty: ParsedPanel = { regime: "us", regimeEvidence: "test", columns: [], warnings: [] };
    const v = verify(empty);
    expect(v.needsConfirm[0]).toBe("serving");
    expect(v.fields.kcal).toBe("missing");
    expect(suggestRepairs(empty)).toEqual([]);
  });
});

describe("US — fiber: the allowance prevents a false alarm without vouching for anything", () => {
  // Constructed high-fiber cereal, 30 g serving: 60 kcal, fat 1 g (1%), sat 0 g, trans 0 g,
  // chol 0 mg, sodium 110 mg (5%), carbs 25 g (9%), fiber 14 g (50%), sugars 0 g, added 0 g,
  // protein 2 g. 4/4/9 on the rounding ranges gives at least 4·1.5 + 4·24.5 + 9·0.5 = 108.5
  // kcal, far above 60 — but a maker subtracting 14 g of insoluble fiber may print 60.
  const cereal = () =>
    panel(
      "us",
      { kcal: 60, fat: 1, sat: 0, trans: 0, chol: 0, sodium: 110, carb: 25, fiber: 14, sugar: 0, added: 0, prot: 2 },
      { fat: 1, sat: 0, chol: 0, sodium: 5, carb: 9, fiber: 50, added: 0 },
      { serving: 30 },
    );

  it("does not false-alarm", () => {
    const v = verify(cereal());
    expect(v.failures).toEqual([]);
    expect(v.consistent).toBe(true);
  });

  it("would have, without the allowance", () => {
    const v = verifyColumn(cereal(), 0, { fiberAllowance: false });
    expect(v.consistent).toBe(false);
    expect(v.failures.map((f) => f.check)).toEqual(["energy"]);
  });

  it("calories and protein, which only the energy check confirms, go to a person", () => {
    const v = verify(cereal());
    expect(v.fields.kcal).toBe("unchecked");
    expect(v.fields.prot).toBe("unchecked");
    // Their %DV still confirms these.
    expect(v.fields.carb).toBe("checked");
    expect(v.fields.fiber).toBe("checked");
    expect(v.fields.fat).toBe("checked");
    expect(v.needsConfirm).toEqual(["serving", "kcal", "sugar", "prot"]);
  });
});

describe("China — GB 28050: NRV% is exact", () => {
  // Constructed per-100 g label. Energy 17·9.3 + 37·25.0 + 17·58.3 = 2074.2 → 2074 kJ.
  // NRV%: 2074/8400 = 24.7 → 25; 9.3/60 = 15.5 → 16; 25.0/60 = 41.7 → 42;
  // 58.3/300 = 19.4 → 19; 480/2000 = 24. A 2011-style "1+4": no saturated fat, no sugar.
  const cn = (pct: Partial<Record<FieldKey, number | string>> = {}) =>
    panel("cn", { kj: 2074, prot: 9.3, fat: 25.0, carb: 58.3, sodium: 480 }, { kj: 25, prot: 16, fat: 42, carb: 19, sodium: 24, ...pct });

  it("an exactly consistent label is consistent, and a 2011 label's missing saturated fat and sugar are not flagged", () => {
    const v = verify(cn());
    expect(v.failures).toEqual([]);
    expect(v.consistent).toBe(true);
    expect(v.fields.sat).toBeUndefined();
    expect(v.fields.sugar).toBeUndefined();
    for (const k of ["kj", "prot", "fat", "carb", "sodium"] as FieldKey[]) expect(v.fields[k], k).toBe("checked");
    expect(v.needsConfirm).toEqual(["serving"]);
  });

  it("one percent off is a conflict — even where a US-style range would have allowed it", () => {
    // 9.3 g could be 9.25–9.35 g, i.e. 15.4–15.6%, so a range check would accept 15.
    // GB 28050 computes NRV% from the declared 9.3 g: 15.5 → 16, and only 16.
    const read = cn({ prot: "15" });
    const v = verify(read);
    expect(v.consistent).toBe(false);
    expect(v.failures.map((f) => f.check)).toEqual(["ref"]);
    expect(v.fields.prot).toBe("conflict");
    expect(v.refPct.prot).toBe("conflict");
    const [r] = suggestRepairs(read);
    expect(r.target).toEqual({ field: "prot", kind: "refPct" });
    expect(r.to).toBe(16);
    expect(r.because).toBe("9.3 g of protein works out to 16%, not 15%.");
  });

  it("a nonzero value at or under the '0' limit cannot be printed", () => {
    const v = verify(panel("cn", { kj: 2074, prot: 9.3, fat: 25.0, carb: 58.3, sodium: 480, sat: 0.1 }, { kj: 25, prot: 16, fat: 42, carb: 19, sodium: 24, sat: 1 }));
    expect(v.failures.map((f) => f.check)).toContain("grid");
    expect(v.fields.sat).toBe("conflict");
  });
});

describe("EU — Regulation 1169/2011", () => {
  // Constructed per-100 g biscuit. kcal = 4·6.3 + 4·60 + 9·22 + 2·2.1 = 467.4 → 467;
  // kJ = 17·6.3 + 17·60 + 37·22 + 8·2.1 = 1957.9 → 1958. %RI: 1958/8400 → 23, 467/2000 → 23,
  // 22/70 → 31, 9.8/20 → 49, 60/260 → 23, 32/90 → 36, 6.3/50 → 13, 0.45/6 → 8. No RI for fibre.
  const FIELDS = { kj: 1958, kcal: 467, fat: 22, sat: 9.8, carb: 60, sugar: 32, fiber: 2.1, prot: 6.3, salt: 0.45 };
  const PCT = { kj: 23, kcal: 23, fat: 31, sat: 49, carb: 23, sugar: 36, prot: 13, salt: 8 };

  it("a consistent label: sugars are checked here because the optional %RI restates them; fibre is not", () => {
    const v = verify(panel("eu", FIELDS, PCT));
    expect(v.failures).toEqual([]);
    expect(v.consistent).toBe(true);
    for (const k of ["kj", "kcal", "fat", "sat", "carb", "sugar", "prot", "salt"] as FieldKey[]) expect(v.fields[k], k).toBe("checked");
    expect(v.fields.fiber).toBe("unchecked");
    expect(v.needsConfirm).toEqual(["serving", "fiber"]);
  });

  it("without %RI, kJ and kcal still check each other — and nothing else is checked", () => {
    const v = verify(panel("eu", FIELDS));
    expect(v.consistent).toBe(true);
    expect(v.fields.kj).toBe("checked");
    expect(v.fields.kcal).toBe("checked");
    expect(v.fields.fat).toBe("unchecked");
    expect(v.fields.sugar).toBe("unchecked");
    expect(v.refPct).toEqual({});
  });

  it("kcal '467' read as 407 is caught by kJ↔kcal and repaired from the kJ", () => {
    const read = panel("eu", { ...FIELDS, kcal: "407" });
    const v = verify(read);
    expect(v.fields.kcal).toBe("conflict");
    expect(v.failures.map((f) => f.check)).toEqual(expect.arrayContaining(["units", "energy"]));
    const [r] = suggestRepairs(read);
    expect(r.target).toEqual({ field: "kcal", kind: "amount" });
    expect(r.to).toBe(467);
    expect(r.because).toBe("The 1958 kJ printed beside it only fits 467 kcal.");
  });

  it("salt and sodium are two copies: 180 mg sodium is 0.45 g salt, 280 mg is not", () => {
    expect(verify(panel("eu", { ...FIELDS, sodium: 180 })).fields.salt).toBe("checked");
    const v = verify(panel("eu", { ...FIELDS, sodium: 280 }));
    expect(v.consistent).toBe(false);
    expect(v.failures.find((f) => f.check === "units")!.fields).toEqual(["salt", "sodium"]);
  });

  it("does not treat fibre as part of carbohydrate (Annex I defines them apart)", () => {
    const v = verify(panel("eu", { ...FIELDS, carb: 1.5, sugar: 1.0, fiber: 40, kcal: 391, kj: 1638 }));
    expect(v.failures.filter((f) => f.check === "parts")).toEqual([]);
  });
});

describe("ocrConfusions — the OCR channel run backwards", () => {
  it("the unit g read as a trailing 9: '89' may have been '8'", () => {
    expect(ocrConfusions("89")).toContain("8");
  });

  it("a dropped decimal point: '25' may have been '2.5'", () => {
    expect(ocrConfusions("25")).toContain("2.5");
    expect(ocrConfusions("05")).toContain("0.5");
  });

  it("a clipped leading or trailing digit: '50' may have been '150' or '500'", () => {
    expect(ocrConfusions("50")).toEqual(expect.arrayContaining(["150", "500"]));
  });

  it("digit confusions, inverted: 5 is misread as 8, so '8' may have been '5' — but not the reverse", () => {
    expect(ocrConfusions("99")).toEqual(expect.arrayContaining(["9", "89", "90", "98"]));
    expect(ocrConfusions("8")).toEqual(expect.arrayContaining(["0", "3", "5", "6", "9"]));
    expect(ocrConfusions("5")).not.toContain("8");
    expect(ocrConfusions("5")).toContain("6");
  });

  it("returns only well-formed, distinct numbers that differ from the read", () => {
    for (const raw of ["0", "5", "12", "99", "2.5", "0.45", "140", "1958", "<1", "1,200"]) {
      const out = ocrConfusions(raw);
      expect(new Set(out).size, raw).toBe(out.length);
      for (const c of out) {
        expect(c, raw).not.toBe("");
        expect(c.split(".").length, c).toBeLessThanOrEqual(2);
        expect(c, c).toMatch(/^(0|[1-9]\d*)(\.\d+)?$/);
        expect(Number(c), c).not.toBe(Number(numberText(raw)));
      }
    }
  });

  it("reads the number out of a raw token", () => {
    expect(numberText("<2,5 g")).toBe("2.5");
    expect(numberText("1,200")).toBe("1200");
    expect(numberText("12%")).toBe("12");
    expect(ocrConfusions("kcal")).toEqual([]);
  });
});
