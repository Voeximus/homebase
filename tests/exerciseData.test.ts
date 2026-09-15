import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BUNDLED_EXERCISES, type Exercise } from "../src/lib/exerciseData";
import { isRegionId } from "../src/lib/muscleRegions";
import legacy from "../scripts/exercisedata/legacy.json";
import evidence from "../docs/research/workout-mode/evidence.json";
import { merge, readInputs, OUT } from "../scripts/exercisedata/merge.mjs";

// SPEC §4.5 norm(): two names that normalise alike are the same exercise for records.
const norm = (name: string) =>
  name.toLowerCase().trim()
    .replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/\bflye\b/g, "fly").replace(/\bskull crusher\b/g, "skullcrusher")
    .replace(/\btricep\b/g, "triceps")
    .replace(/(\S{2,}[^s])s$/, "$1");

const byName = new Map(BUNDLED_EXERCISES.map((e) => [e.name, e]));
const ex = (name: string): Exercise => {
  const e = byName.get(name);
  if (!e) throw new Error(`no exercise "${name}"`);
  return e;
};
const main = (name: string) => ex(name).primary ?? [];
const helps = (name: string) => ex(name).secondary ?? [];
const roles = (name: string) => [...main(name), ...helps(name)];

describe("library ids and names", () => {
  it("keeps all 186 legacy ids with unchanged names", () => {
    expect(legacy).toHaveLength(186);
    const byId = new Map(BUNDLED_EXERCISES.map((e) => [e.id, e]));
    for (const { id, name } of legacy) expect(byId.get(id)?.name, id).toBe(name);
  });

  it("has unique ids and adds the three Homebase exercises", () => {
    expect(new Set(BUNDLED_EXERCISES.map((e) => e.id)).size).toBe(BUNDLED_EXERCISES.length);
    expect(BUNDLED_EXERCISES).toHaveLength(189);
    expect(ex("Band row")).toMatchObject({ id: "ex-band-row", muscle: "back", equipment: "band", mode: "band" });
    expect(ex("Nordic hamstring curl")).toMatchObject({ id: "ex-nordic-hamstring-curl", muscle: "legs" });
    expect(ex("45° back extension")).toMatchObject({ id: "ex-45-back-extension", muscle: "legs" });
  });

  it("applies the two muscle fixes and folds Burpees into Burpee", () => {
    expect(ex("Romanian deadlift").muscle).toBe("legs");
    expect(ex("Face pull").muscle).toBe("shoulders");
    expect(ex("Burpees")).toMatchObject({ mergedInto: "ex-burpee", hidden: true });
  });

  it("gives old routine names an alias on the right exercise", () => {
    const aliasOf = (alias: string) => BUNDLED_EXERCISES.find((e) => e.aliases?.includes(alias))?.name;
    expect(aliasOf("Incline dumbbell press")).toBe("Incline dumbbell bench press");
    expect(aliasOf("Chest-supported row")).toBe("Chest-supported dumbbell row");
    expect(aliasOf("Flat dumbbell press")).toBe("Dumbbell bench press");
    expect(aliasOf("Dumbbell hammer curl")).toBe("Hammer curl");
    expect(aliasOf("Dumbbell split squat")).toBe("Bulgarian split squat");
    expect(aliasOf("Walk")).toBe("Walking");
  });

  it("has no two visible exercises (or aliases) sharing a normalised name", () => {
    const owner = new Map<string, string>();
    const clash: string[] = [];
    for (const e of BUNDLED_EXERCISES) {
      const labels = [...(e.hidden ? [] : [e.name]), ...(e.aliases ?? [])];
      for (const label of labels) {
        const prev = owner.get(norm(label));
        if (prev && prev !== e.id) clash.push(`${label} (${e.id}) vs ${prev}`);
        owner.set(norm(label), e.id);
      }
    }
    expect(clash).toEqual([]);
  });
});

describe("muscle regions and mode", () => {
  it("uses only valid region ids, each once per exercise", () => {
    for (const e of BUNDLED_EXERCISES) {
      const all = [...(e.primary ?? []), ...(e.secondary ?? [])];
      for (const r of all) expect(isRegionId(r), `${e.name}: ${r}`).toBe(true);
      expect(new Set(all).size, e.name).toBe(all.length);
    }
  });

  it("gives every non-cardio exercise a main region and every cardio exercise none", () => {
    for (const e of BUNDLED_EXERCISES) {
      expect(e.mode, e.name).toBeDefined();
      expect(e.mode === "cardio", e.name).toBe(e.type === "cardio");
      if (e.mode === "cardio") expect([...(e.primary ?? []), ...(e.secondary ?? [])], e.name).toEqual([]);
      else expect(e.primary?.length, e.name).toBeGreaterThan(0);
    }
  });

  it("marks band exercises as band mode", () => {
    for (const e of BUNDLED_EXERCISES) if (e.equipment === "band") expect(e.mode, e.name).toBe("band");
  });
});

// Where a kept claim talks about an exercise, the labels must not contradict it.
describe("labels agree with the evidence register", () => {
  it("triceps exercises train all three heads", () => {
    for (const n of ["Triceps pushdown", "Rope triceps pushdown", "Cable overhead triceps extension", "Overhead triceps extension", "Skullcrusher"]) {
      expect(main(n), n).toEqual(expect.arrayContaining(["triceps_long", "triceps_short"]));
    }
  });

  it("leg extension: rectus femoris and the vasti are both main", () => {
    expect(main("Leg extension")).toEqual(expect.arrayContaining(["quads_rf", "quads_vasti"]));
    expect(roles("Leg extension")).not.toContain("glute_max"); // leg-press-glutes: no glute growth
  });

  it("squat and leg press: glutes, adductors and vasti main; no rectus femoris, hamstrings or side glutes", () => {
    for (const n of ["Barbell back squat", "Leg press"]) {
      expect(main(n), n).toEqual(expect.arrayContaining(["quads_vasti", "glute_max", "adductors"]));
      for (const r of ["quads_rf", "hamstrings", "glute_med"]) expect(roles(n), `${n} ${r}`).not.toContain(r);
    }
  });

  it("hip thrust and glute bridge: glute max main, no side glutes on the hip thrust", () => {
    expect(main("Barbell hip thrust")).toEqual(["glute_max"]);
    expect(roles("Barbell hip thrust")).not.toContain("glute_med");
    expect(main("Glute bridge")).toEqual(["glute_max"]);
    expect(helps("Glute bridge")).toEqual(["hamstrings"]);
  });

  it("calves: standing trains both calf muscles, seated trains the soleus and not the gastrocnemius", () => {
    expect(main("Standing calf raise")).toEqual(expect.arrayContaining(["gastrocnemius", "soleus"]));
    expect(main("Seated calf raise")).toEqual(["soleus"]);
    expect(roles("Seated calf raise")).not.toContain("gastrocnemius");
  });

  it("hinges and hamstring work", () => {
    for (const n of ["Romanian deadlift", "Dumbbell Romanian deadlift", "45° back extension"]) {
      expect(main(n), n).toEqual(expect.arrayContaining(["hamstrings", "glute_max"]));
    }
    expect(main("Conventional deadlift")).toEqual(expect.arrayContaining(["glute_max", "adductors", "hamstrings", "lower_back"]));
    expect(helps("Conventional deadlift")).toContain("quads_vasti");
    for (const n of ["Nordic hamstring curl", "Seated leg curl", "Lying leg curl"]) expect(main(n), n).toContain("hamstrings");
  });

  it("band row: lats, mid-back and rear delts main, both elbow flexors helping like every other row", () => {
    expect([...main("Band row")].sort()).toEqual(["delt_rear", "lats", "traps_mid"]);
    expect(helps("Band row")).toEqual(["biceps", "brachialis"]);
    expect(helps("One-arm dumbbell row")).toEqual(expect.arrayContaining(["biceps", "brachialis"]));
  });

  it("the same arm position gets the same label: spider curl lists both elbow flexors as main, like the preacher curl", () => {
    expect([...main("Spider curl")].sort()).toEqual([...main("Preacher curl")].sort());
  });

  it("the seated abductor machine: side glutes main, upper glute max helping (hips bent)", () => {
    expect(main("Hip abductor machine")).toEqual(["glute_med"]);
    expect(helps("Hip abductor machine")).toEqual(["glute_max"]);
  });

  it("plank: abs and obliques main", () => {
    expect([...main("Plank")].sort()).toEqual(["abs", "obliques"]);
  });

  it("incline and flat pressing: both chest regions main", () => {
    for (const n of ["Barbell bench press", "Incline barbell bench press", "Incline dumbbell bench press", "Machine chest press", "Push-up"]) {
      expect(main(n), n).toEqual(expect.arrayContaining(["chest_upper", "chest_lower"]));
    }
  });

  it("overhead press: front delts, side delts and triceps main; upper chest and upper traps helping", () => {
    // the dumbbell, machine, seated and kettlebell presses are pressed in front too (overhead-press-anatomy)
    for (const n of [
      "Barbell overhead press",
      "Seated barbell military press",
      "Dumbbell shoulder press",
      "Machine shoulder press",
      "Seated dumbbell shoulder press",
      "Kettlebell overhead press",
    ]) {
      expect(main(n), n).toEqual(expect.arrayContaining(["delt_front", "delt_side", "triceps_long", "triceps_short"]));
      expect(helps(n), n).toEqual(expect.arrayContaining(["chest_upper", "traps_upper"]));
    }
  });

  it("lunges, split squats and step-ups: vasti and glute max main, side glutes and adductors helping, no rectus femoris", () => {
    // lunge-emg ranks the vasti first and the rectus femoris below the glutes; glute max is a
    // prime hip extensor of the working leg, as in the squat (activation ranking is not growth)
    for (const n of ["Barbell lunge", "Dumbbell lunge", "Walking lunge", "Reverse lunge", "Step-up", "Bulgarian split squat", "Pistol squat"]) {
      expect(main(n), n).toEqual(["quads_vasti", "glute_max"]);
      expect(helps(n), n).toEqual(["glute_med", "adductors"]);
      expect(roles(n), n).not.toContain("quads_rf");
    }
  });

  it("pull-ups: lats main on every grip, biceps main only with the underhand grip", () => {
    for (const n of ["Pull-up", "Wide-grip pull-up", "Neutral-grip pull-up", "Chin-up"]) expect(main(n), n).toContain("lats");
    expect(main("Chin-up")).toContain("biceps");
    expect(main("Pull-up")).not.toContain("biceps");
  });

  it("side delts are main on both lateral raises", () => {
    expect(main("Dumbbell lateral raise")).toEqual(["delt_side"]);
    expect(main("Cable lateral raise")).toEqual(["delt_side"]);
  });
});

describe("evidence showOn names", () => {
  it("every kept showOn exercise that is not ifPresent is in the library by name or alias", () => {
    const labels = new Set(BUNDLED_EXERCISES.flatMap((e) => [e.name, ...(e.aliases ?? [])]));
    const missing: string[] = [];
    for (const c of evidence.kept) {
      for (const s of (c.showOn ?? []) as { exercise?: string; ifPresent?: boolean }[]) {
        if (s.exercise && !s.ifPresent && !labels.has(s.exercise)) missing.push(`${c.id}: ${s.exercise}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("merge.mjs", () => {
  it("is up to date and deterministic", () => {
    const a = merge();
    expect(a.errors).toEqual([]);
    expect(a.source).toBe(merge().source);
    expect(readFileSync(OUT, "utf8").replace(/\r\n/g, "\n")).toBe(a.source);
    expect(a.source).toContain(`hand-edit. ${BUNDLED_EXERCISES.length} exercises.`);
  });

  it("fails when a legacy exercise disappears from raw data", () => {
    const inputs = readInputs();
    const arms = inputs.rawFiles["arms.json"].filter((o: { name: string }) => o.name !== "Hammer curl");
    const { errors } = merge({ ...inputs, rawFiles: { ...inputs.rawFiles, "arms.json": arms } });
    expect(errors.some((e: string) => e.includes("ex-hammer-curl") && e.includes("disappeared"))).toBe(true);
  });

  it("fails when a legacy exercise is renamed", () => {
    const inputs = readInputs();
    const legacyRenamed = inputs.legacy.map((e: { id: string; name: string }) => (e.id === "ex-plank" ? { ...e, name: "Planks" } : e));
    const { errors } = merge({ ...inputs, legacy: legacyRenamed });
    expect(errors.some((e: string) => e.includes("ex-plank"))).toBe(true);
  });

  it("fails on a missing label, an unknown region, or a cardio exercise with regions", () => {
    const inputs = readInputs();
    const regions = { ...inputs.regions };
    delete regions["ex-plank"];
    regions["ex-crunch"] = { ...regions["ex-crunch"], primary: ["six_pack"] };
    regions["ex-walking"] = { ...regions["ex-walking"], primary: ["quads_vasti"] };
    const { errors } = merge({ ...inputs, regions });
    expect(errors.some((e: string) => e.includes("missing ex-plank"))).toBe(true);
    expect(errors.some((e: string) => e.includes("six_pack"))).toBe(true);
    expect(errors.some((e: string) => e.includes("ex-walking is cardio"))).toBe(true);
  });

  it("fails when an alias collides with another exercise's name", () => {
    const inputs = readInputs();
    const overrides = { ...inputs.overrides, aliases: { ...inputs.overrides.aliases, "ex-plank": ["Side planks"] } };
    const { errors } = merge({ ...inputs, overrides });
    expect(errors.some((e: string) => e.includes("Side planks"))).toBe(true);
  });
});
