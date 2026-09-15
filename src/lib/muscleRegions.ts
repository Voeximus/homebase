// ── Muscle regions: the shared contract for workout mode ─────────────────────
// The level where training science actually tells muscles apart (a separate
// joint action, or measured regional growth) — see
// docs/research/workout-mode/SPEC.md §4.4. The body map, the library's
// main/helper labels, and "hard sets per muscle" all speak in these ids.
//
// `group` maps back to the library's coarse Muscle so old filters keep working.
// `drawn: false` = a deep muscle the figure cannot show; it appears in text only.

import type { Muscle } from "./exerciseData";

export type RegionId =
  | "chest_upper" | "chest_lower" | "serratus"
  | "delt_front" | "delt_side" | "delt_rear"
  | "traps_upper" | "traps_mid" | "traps_lower" | "lats" | "lower_back" | "neck"
  | "biceps" | "brachialis" | "triceps_long" | "triceps_short" | "forearm_flex" | "forearm_ext"
  | "abs" | "obliques" | "hip_flexors"
  | "glute_max" | "glute_med" | "quads_rf" | "quads_vasti" | "hamstrings" | "adductors"
  | "gastrocnemius" | "soleus" | "tibialis";

export interface Region {
  id: RegionId;
  en: string;
  zh: string;
  group: Exclude<Muscle, "fullbody" | "cardio">;
  drawn: boolean;
}

export const REGIONS: readonly Region[] = [
  { id: "chest_upper", en: "Upper chest", zh: "上胸", group: "chest", drawn: true },
  { id: "chest_lower", en: "Mid/lower chest", zh: "中下胸", group: "chest", drawn: true },
  { id: "serratus", en: "Side of ribs (serratus)", zh: "前锯肌", group: "chest", drawn: true },
  { id: "delt_front", en: "Front delts", zh: "三角肌前束", group: "shoulders", drawn: true },
  { id: "delt_side", en: "Side delts", zh: "三角肌中束", group: "shoulders", drawn: true },
  { id: "delt_rear", en: "Rear delts", zh: "三角肌后束", group: "shoulders", drawn: true },
  { id: "traps_upper", en: "Upper traps", zh: "上斜方肌", group: "back", drawn: true },
  { id: "traps_mid", en: "Mid traps & rhomboids", zh: "中斜方肌与菱形肌", group: "back", drawn: true },
  { id: "traps_lower", en: "Lower traps", zh: "下斜方肌", group: "back", drawn: true },
  { id: "lats", en: "Lats", zh: "背阔肌", group: "back", drawn: true },
  { id: "lower_back", en: "Lower back", zh: "下背", group: "back", drawn: true },
  { id: "neck", en: "Neck", zh: "颈部肌群", group: "back", drawn: true },
  { id: "biceps", en: "Biceps", zh: "肱二头肌", group: "arms", drawn: true },
  { id: "brachialis", en: "Deep elbow flexors (brachialis)", zh: "肱肌与肱桡肌", group: "arms", drawn: true },
  { id: "triceps_long", en: "Triceps long head", zh: "肱三头肌长头", group: "arms", drawn: true },
  { id: "triceps_short", en: "Triceps outer & inner heads", zh: "肱三头肌外侧头与内侧头", group: "arms", drawn: true },
  { id: "forearm_flex", en: "Forearm flexors", zh: "前臂屈肌", group: "arms", drawn: true },
  { id: "forearm_ext", en: "Forearm extensors", zh: "前臂伸肌", group: "arms", drawn: true },
  { id: "abs", en: "Abs", zh: "腹直肌", group: "core", drawn: true },
  { id: "obliques", en: "Obliques", zh: "腹斜肌", group: "core", drawn: true },
  { id: "hip_flexors", en: "Hip flexors", zh: "屈髋肌", group: "core", drawn: false },
  { id: "glute_max", en: "Glute max", zh: "臀大肌", group: "legs", drawn: true },
  { id: "glute_med", en: "Glute med & min", zh: "臀中肌与臀小肌", group: "legs", drawn: true },
  { id: "quads_rf", en: "Hip-crossing quad (rectus femoris)", zh: "股直肌", group: "legs", drawn: true },
  { id: "quads_vasti", en: "Rest of quads", zh: "股四头肌其余部分", group: "legs", drawn: true },
  { id: "hamstrings", en: "Hamstrings", zh: "腘绳肌", group: "legs", drawn: true },
  { id: "adductors", en: "Adductors", zh: "大腿内收肌", group: "legs", drawn: true },
  { id: "gastrocnemius", en: "Upper calf (gastrocnemius)", zh: "腓肠肌", group: "legs", drawn: true },
  { id: "soleus", en: "Lower calf (soleus)", zh: "比目鱼肌", group: "legs", drawn: true },
  { id: "tibialis", en: "Shin", zh: "胫骨前肌", group: "legs", drawn: true },
];

export const REGION_BY_ID: Readonly<Record<RegionId, Region>> = Object.fromEntries(
  REGIONS.map((r) => [r.id, r]),
) as Record<RegionId, Region>;

export const isRegionId = (s: string): s is RegionId => s in REGION_BY_ID;
