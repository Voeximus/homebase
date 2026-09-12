// The three rulebooks as vocabulary: what each regulation's rows are called, the
// order the regulation prints them in, and the phrases that say which rulebook a
// label follows. The numeric side of the rulebooks (grids, reference values) is
// rules.ts; this file is only words.

import type { FieldKey, Regime } from "../types";
import type { Row } from "./rows";

/** What a row's label can mean. "energy" picks kJ or kcal by unit; "ofwhich" is a sub-row whose noun was lost. */
export type RowKey = FieldKey | "energy" | "ofwhich" | "ignore" | "servingSize" | "servingsPer";

export interface Synonym {
  key: RowKey;
  /** Lower-case letters only (Latin), or the exact characters (CJK). */
  form: string;
  /** A bare parent noun ("fat") that, when its field is already filled, means the next child row. */
  generic?: boolean;
}

const S = (key: RowKey, ...forms: string[]): Synonym[] => forms.map((form) => ({ key, form }));

// Rows that print numbers but are not fields the app reads. Listing them keeps
// "unrecognised row" warnings for rows that are genuinely unrecognised.
const LATIN_IGNORE = S(
  "ignore",
  "caloriesfromfat",
  "polyunsaturatedfat",
  "monounsaturatedfat",
  "polyunsaturates",
  "monounsaturates",
  "ofwhichpolyunsaturates",
  "ofwhichmonounsaturates",
  "polyols",
  "ofwhichpolyols",
  "starch",
  "ofwhichstarch",
  "sugaralcohol",
  "sugaralcohols",
  "solublefiber",
  "insolublefiber",
  "othercarbohydrate",
  // "Vitamin B12" lexes as "vitamin", "b", 12 — the bare forms cover every numbered vitamin.
  "vitamin",
  "vitaminb",
  "vitamina",
  "vitaminc",
  "vitamind",
  "vitamine",
  "vitamink",
  "calcium",
  "iron",
  "potassium",
  "thiamin",
  "riboflavin",
  "niacin",
  "folate",
  "biotin",
  "phosphorus",
  "iodine",
  "magnesium",
  "zinc",
  "selenium",
  "copper",
  "manganese",
  "choline",
);

const US_LATIN: Synonym[] = [
  ...S("kcal", "calories", "calorie"),
  ...S("fat", "totalfat"),
  { key: "fat", form: "fat", generic: true },
  ...S("sat", "saturatedfat", "satfat", "saturated"),
  ...S("trans", "transfat", "trans"),
  ...S("chol", "cholesterol", "cholest"),
  ...S("sodium", "sodium"),
  ...S("carb", "totalcarbohydrate", "totalcarbohydrates", "totalcarb", "totalcarbs", "carbohydrate", "carbohydrates"),
  ...S("fiber", "dietaryfiber", "dietaryfibre", "fiber", "fibre"),
  ...S("sugar", "totalsugars", "totalsugar", "sugars", "sugar"),
  ...S("added", "includesaddedsugars", "includesaddedsugar", "incladdedsugars", "addedsugars", "addedsugar"),
  ...S("prot", "protein"),
  ...S("servingSize", "servingsize"),
  ...S("servingsPer", "servingspercontainer", "servingpercontainer"),
  ...LATIN_IGNORE,
];

const EU_LATIN: Synonym[] = [
  ...S("energy", "energy", "energie", "energyvalue"),
  ...S("fat", "fat", "totalfat"),
  ...S("sat", "ofwhichsaturates", "saturates", "ofwhichsaturated", "saturatedfat", "ofwhichsaturatedfat"),
  ...S("carb", "carbohydrate", "carbohydrates", "carbs"),
  ...S("sugar", "ofwhichsugars", "ofwhichsugar", "sugars", "sugar"),
  ...S("fiber", "fibre", "fiber", "dietaryfibre"),
  ...S("prot", "protein"),
  ...S("salt", "salt"),
  ...S("sodium", "sodium"),
  ...S("ofwhich", "ofwhich"),
  ...LATIN_IGNORE,
];

/** English on a bilingual Chinese label. Energy is kJ there by law, so "energy" resolves by unit like EU. */
const CN_LATIN: Synonym[] = [
  ...S("energy", "energy"),
  ...S("prot", "protein"),
  ...S("fat", "fat", "totalfat"),
  ...S("sat", "saturatedfat", "saturatedfattyacid", "saturatedfattyacids", "saturates"),
  ...S("trans", "transfat", "transfattyacid", "transfattyacids"),
  ...S("chol", "cholesterol"),
  ...S("carb", "carbohydrate", "carbohydrates"),
  ...S("sugar", "sugars", "sugar", "totalsugars"),
  ...S("fiber", "dietaryfiber", "dietaryfibre", "fiber", "fibre"),
  ...S("sodium", "sodium"),
  ...LATIN_IGNORE,
];

const CN_CJK: Synonym[] = [
  ...S("energy", "能量", "热量"),
  ...S("prot", "蛋白质"),
  ...S("fat", "脂肪", "总脂肪"),
  ...S("sat", "饱和脂肪", "饱和脂肪酸"),
  ...S("trans", "反式脂肪", "反式脂肪酸"),
  ...S("chol", "胆固醇"),
  ...S("carb", "碳水化合物"),
  ...S("sugar", "糖", "总糖"),
  ...S("fiber", "膳食纤维"),
  ...S("sodium", "钠"),
  ...S("ofwhich", "其中"),
  ...S("servingSize", "份量", "每份份量"),
  ...S(
    "ignore",
    "维生素",
    "钙",
    "铁",
    "锌",
    "钾",
    "磷",
    "镁",
    "碘",
    "硒",
    "单不饱和脂肪",
    "单不饱和脂肪酸",
    "多不饱和脂肪",
    "多不饱和脂肪酸",
    "乳糖",
    "淀粉",
    "糖醇",
  ),
];

export const LATIN: Record<Regime, Synonym[]> = { us: US_LATIN, eu: EU_LATIN, cn: CN_LATIN };
export const CJK: Record<Regime, Synonym[]> = { us: [], eu: [], cn: CN_CJK };

/**
 * Words that may sit beside a label without making it a different row: "Amount
 * per serving Calories", "Servings per container about 8", "of which".
 */
export const FILLER = new Set(["of", "which", "includes", "incl", "total", "amount", "per", "serving", "about", "daily", "value", "dv", "the", "a"]);

/** The order each regulation prints its rows in. kJ and kcal share the energy slot. */
export const ORDER: Record<Regime, FieldKey[]> = {
  us: ["kcal", "fat", "sat", "trans", "chol", "sodium", "carb", "fiber", "sugar", "added", "prot"],
  eu: ["kj", "kcal", "fat", "sat", "carb", "sugar", "fiber", "prot", "salt", "sodium"],
  cn: ["kj", "kcal", "prot", "fat", "sat", "trans", "chol", "carb", "sugar", "fiber", "sodium"],
};

/** Indented sub-rows under each parent, in printed order. */
export const CHILDREN: Record<Regime, Partial<Record<FieldKey, FieldKey[]>>> = {
  us: { fat: ["sat", "trans"], carb: ["fiber", "sugar"], sugar: ["added"] },
  eu: { fat: ["sat"], carb: ["sugar"] },
  cn: { fat: ["sat", "trans"], carb: ["sugar", "fiber"] },
};

// ── regime evidence ───────────────────────────────────────────────────────────

interface Evidence {
  /** Matched against the page flattened to lower case with whitespace removed. */
  find: string;
  weight: number;
  says: string;
}

/**
 * Weights are coarse on purpose. A title ("Nutrition Facts", "营养成分表") is
 * decisive by itself; a row noun is a hint that several regimes share, which is
 * why "calories" alone (a cereal box front says "140 CALORIES") cannot make a panel.
 */
const EVIDENCE: Record<Regime, Evidence[]> = {
  us: [
    { find: "nutritionfacts", weight: 10, says: "Nutrition Facts" },
    { find: "dailyvalue", weight: 5, says: "% Daily Value" },
    { find: "amountperserving", weight: 4, says: "Amount per serving" },
    { find: "servingsize", weight: 3, says: "Serving size" },
    { find: "servingspercontainer", weight: 3, says: "servings per container" },
    { find: "calories", weight: 2, says: "Calories" },
    { find: "totalfat", weight: 2, says: "Total Fat" },
    { find: "totalcarb", weight: 2, says: "Total Carbohydrate" },
    { find: "addedsugars", weight: 2, says: "Added Sugars" },
  ],
  eu: [
    { find: "nutritioninformation", weight: 5, says: "Nutrition information" },
    { find: "nutritiondeclaration", weight: 5, says: "Nutrition declaration" },
    { find: "typicalvalues", weight: 6, says: "Typical values" },
    { find: "per100g", weight: 5, says: "per 100 g" },
    { find: "per100ml", weight: 5, says: "per 100 ml" },
    { find: "ofwhichsaturates", weight: 5, says: "of which saturates" },
    { find: "saturates", weight: 2, says: "saturates" },
    { find: "ofwhichsugars", weight: 4, says: "of which sugars" },
    { find: "fibre", weight: 2, says: "Fibre" },
    { find: "salt", weight: 2, says: "Salt" },
    { find: "referenceintake", weight: 3, says: "Reference intake" },
    { find: "energy", weight: 1, says: "Energy" },
  ],
  cn: [
    { find: "营养成分表", weight: 10, says: "营养成分表" },
    { find: "营养成分", weight: 5, says: "营养成分" },
    { find: "营养素参考值", weight: 5, says: "营养素参考值" },
    { find: "项目", weight: 2, says: "项目" },
    { find: "每100克", weight: 4, says: "每100克" },
    { find: "每100g", weight: 4, says: "每100g" },
    { find: "每100毫升", weight: 4, says: "每100毫升" },
    { find: "每份", weight: 3, says: "每份" },
    { find: "nrv%", weight: 3, says: "NRV%" },
    { find: "千焦", weight: 3, says: "千焦" },
    { find: "能量", weight: 2, says: "能量" },
    { find: "蛋白质", weight: 2, says: "蛋白质" },
    { find: "碳水化合物", weight: 2, says: "碳水化合物" },
    { find: "脂肪", weight: 1, says: "脂肪" },
    { find: "钠", weight: 1, says: "钠" },
  ],
};

export interface RegimeGuess {
  regime: Regime;
  score: number;
  /** A title-grade phrase was found, so a panel is present even if its rows are unreadable. */
  titled: boolean;
  evidence: string;
}

export function detectRegime(rows: Row[]): RegimeGuess | null {
  const flat = rows
    .map((r) => r.norm)
    .join("")
    .toLowerCase()
    .replace(/\s+/g, "");
  const scored = (Object.keys(EVIDENCE) as Regime[]).map((regime) => {
    const hits: Evidence[] = [];
    for (const e of EVIDENCE[regime]) {
      // A shorter phrase inside a longer one already counted ("营养成分" in "营养成分表") adds nothing.
      if (flat.includes(e.find) && !hits.some((h) => h.find.includes(e.find))) hits.push(e);
    }
    let score = hits.reduce((a, h) => a + h.weight, 0);
    const says = hits.map((h) => `"${h.says}"`);
    // kJ beside kcal is the EU signature; China prints kJ alone.
    if (regime === "eu" && /\d(kj)/.test(flat) && /\d(kcal)/.test(flat)) {
      score += 4;
      says.push("kJ with kcal");
    }
    return { regime, score, titled: hits.some((h) => h.weight >= 5), says };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < 2) return null;
  const runnerUp = scored[1];
  const margin = runnerUp.score > 0 ? `; ${runnerUp.regime} scored ${runnerUp.score}` : "";
  return {
    regime: best.regime,
    score: best.score,
    titled: best.titled,
    evidence: `${best.says.join(", ")} (score ${best.score}${margin})`,
  };
}
