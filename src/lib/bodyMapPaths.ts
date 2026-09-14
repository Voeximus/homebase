// ── Body map drawing data: the front and back figures ──────────────────────────
// Ported from the hand-drawn figures in public/_workoutlab.html (the mockup Gino
// signed off on), so the app shows the same body he saw. Pure data — the SVG is
// assembled in components/workout/BodyMap.tsx.
//
// Coordinates: each figure lives in a 100 × 160 box (cropped to BODY_VIEWBOX).
// Every shape is drawn once on the figure's LEFT half and reflected across x = 50
// by BODY_MIRROR, so the two sides can never drift apart.
//
// A region may need several shapes (the back of the calf is two heads) and may
// appear on both figures (neck, side delts, obliques, adductors, calves). A region
// with `drawn: false` in muscleRegions.ts (hip flexors, which sit deep under the
// abs) has no shape on purpose — it is named in the text line only.

import type { RegionId } from "./muscleRegions";

export type BodyView = "front" | "back";

export const BODY_VIEWBOX = "9 0 82 160";
export const BODY_MIRROR = "matrix(-1 0 0 1 100 0)";
export const BODY_HEAD = { cx: 50, cy: 11, rx: 7, ry: 8.6 } as const;

// The silhouette's left half: shoulder, arm and hand, torso, leg and foot.
export const BODY_BASE =
  "M50,19 L45,19.5 Q45.5,24 44,25 Q38,27 32,27.5 Q23,27.5 21,33 Q19.5,40 20.3,46 Q19.8,52 19.5,58 Q17,68 15.8,82 Q12.5,85 12.8,90 Q13.5,95.5 17.5,95.5 Q21.5,95 22,89 Q22,85 21.8,82 Q24,72 27.5,62 Q28.8,59 29.5,56 Q31,50 32,45 Q33,55 34.5,60 Q36.5,67 36,74 Q32.5,79 32.2,90 Q32.5,104 36.5,118 Q35.5,124 36,130 Q35.5,140 37.5,151 Q35,155 36,157.5 L43.5,157.5 Q44.5,154 42.8,151 Q46.5,140 46.2,130 Q46.5,123 45.5,118 Q48.5,104 49.2,88 L50,84 Z";

// Key order is paint order: a later region is drawn over an earlier one.
export const BODY_PATHS: Readonly<Record<BodyView, Partial<Record<RegionId, readonly string[]>>>> = {
  front: {
    neck: ["M45,20 Q46,23.5 44.6,26.2 L50,27 L50,20 Z"],
    traps_upper: ["M44.3,25.4 Q39.5,27 34,27.6 L34.8,28.9 Q41,29 45.6,27.2 Z"],
    delt_side: ["M33,27.9 Q25,27.2 22,31.8 Q20.6,36.5 21.6,42 L24.9,42 Q24.1,36.7 25.7,32.8 Q28.3,29.2 33.4,29.1 Z"],
    delt_front: ["M34.4,29.6 Q28.8,29.4 26.4,33.2 Q25.1,37.2 25.6,42 L30.6,41.4 Q30.9,35.9 35,32.3 Z"],
    chest_upper: ["M50,29.2 L50,36 Q42.5,37.6 34.2,35.6 Q34.1,32.3 36,30.3 Q43,29.6 50,29.2 Z"],
    chest_lower: ["M50,36.6 L50,46 Q44,48.6 37.4,46.2 Q33.6,43.6 33.8,36.6 Q42.4,38.6 50,36.6 Z"],
    serratus: ["M32.6,42.4 Q31.4,46.5 32.3,51.5 L35.2,50.6 Q34.6,47.6 36,46.8 Q34,45.6 32.6,42.4 Z"],
    biceps: ["M30.4,42.2 Q26.6,44.2 25.2,50 Q25.1,55.4 26.9,58.2 Q29.5,56.2 30.3,50.3 Q30.9,45.4 30.4,42.2 Z"],
    brachialis: [
      "M22,42.6 Q20.6,49.4 21.2,57 L23.9,57.6 Q23.3,50.2 24.5,43 Z",
      "M21.6,58.4 Q19.2,63.4 18.4,70 L20.9,70.8 Q22.4,64.3 24.4,59.2 Z",
    ],
    forearm_flex: ["M24.8,59.3 Q22.7,64.5 21.2,71.3 L18.3,70.6 Q17,76 16.4,81.6 L21.3,81.6 Q22.6,74 25.1,66.2 Q27,61.6 28.1,59.6 Q26.3,58.7 24.8,59.3 Z"],
    abs: ["M50,47.6 L50,74 Q46.6,75.2 44.3,72.4 L43.8,49.8 Q46.4,49 50,47.6 Z"],
    obliques: ["M43.1,49.9 L43.6,72.3 Q40.2,74.2 36.8,73.8 Q36.4,64 34.8,58 Q33.4,52.4 35.8,50 Q39.2,50.8 43.1,49.9 Z"],
    quads_vasti: [
      "M37.4,80.2 Q33.2,86 32.8,98 Q33.6,110 38.4,118 L40.1,117.2 Q37.9,100.4 38,83.2 Z",
      "M43.1,104 Q46.6,110 45.1,118 L42.9,117.6 Q43.4,110.2 43.1,104 Z",
    ],
    quads_rf: ["M41.5,82 Q43.1,96 42.6,116.4 L40.6,117 Q38.9,100 38.8,84 Z"],
    adductors: ["M48.6,84.4 Q46,84.4 43.1,86.2 Q43.6,95 43.3,102.6 Q45.6,98 49,90 Z"],
    tibialis: ["M38.8,126 Q37.6,136.5 39.4,150 L41.4,150 Q41.2,138 41.2,126 Z"],
    soleus: [
      "M37.2,132 Q36,141.5 38.2,150 L38.9,150 Q37.8,141.5 38.5,131 Z",
      "M44.9,138.5 Q45.2,145 43.6,150 L42.6,150 Q43.6,145 43.7,139.2 Z",
    ],
    gastrocnemius: ["M43.9,124.6 Q46.6,130.5 45.3,138 L43.3,138.8 Q43.5,131.5 42.2,125.4 Z"],
  },
  back: {
    neck: ["M45,20 Q45.7,22 45.3,23.2 L50,23.4 L50,20 Z"],
    traps_upper: ["M45.2,23.6 Q44.4,26 41,27 Q37.2,28 33.6,28.6 L37.4,31.1 Q44,30.6 50,31 L50,23.8 Z"],
    traps_mid: ["M50,31.4 Q44,31 37.9,31.8 Q39.8,36.2 44.3,40.2 L50,43 Z"],
    traps_lower: ["M50,43.5 L44.8,40.8 Q45.9,48 50,56 Z"],
    delt_side: ["M33,27.9 Q25,27.2 22,31.8 Q20.6,36.5 21.6,42 L25.4,42 Q24.5,36.4 26,32.9 Q28.5,29.2 33.4,29.1 Z"],
    delt_rear: ["M33.8,29.5 Q27.4,29.8 26.1,34 Q25.4,38 26.1,42.1 L30.9,41.2 Q31.4,35.4 36.6,31.7 Z"],
    lats: ["M44.1,40.9 Q45.8,47.4 47.6,54 Q42.8,59 37,63 Q33.5,53 32.2,42.2 Q33.5,35.3 37.2,32.4 Q39.8,37.2 44.1,40.9 Z"],
    lower_back: ["M50,56.8 L48.3,54.8 Q46.8,58.6 44.1,61.2 Q43.6,68 44.6,74.2 L50,75 Z"],
    obliques: ["M37.3,63.8 Q42.8,60.4 43.6,61.8 Q43.2,68 43.8,74.2 Q40,74.6 36.6,74.2 Q37,68 37.3,63.8 Z"],
    triceps_long: ["M31.2,42 Q27.2,44.2 26.7,50 Q26.9,55 28.4,58.4 Q30.4,53 31.4,46.6 Z"],
    triceps_short: ["M25.6,42.5 Q21.6,44.2 20.9,50 Q21,55 22,58 Q25.2,57.6 26.4,55 Q25.8,49 26.3,43.2 Z"],
    forearm_ext: ["M22,58.8 Q19.1,64 18,70 Q17,76 16.4,81.6 L21.3,81.6 Q22.8,74 25,66.2 Q27,61.6 28.2,59.4 Q25,58.2 22,58.8 Z"],
    glute_med: ["M44,75.2 Q39,74.8 36.1,75.2 Q33.6,78 33.6,83 Q38.6,79.2 44.6,79 Z"],
    glute_max: ["M50,76.8 L45,79.2 Q38.6,80 33.5,84.2 Q33.4,90 36.6,94 Q43,96.6 49.6,93.6 Z"],
    hamstrings: ["M36.3,95.2 Q33.4,103 34.1,112 Q36,117 38.6,119 L45,119 Q47,112 46.8,104 Q46.5,99 45.5,96.2 Q41,97.2 36.3,95.2 Z"],
    adductors: ["M49.5,94.6 Q47.4,96.4 46.3,97.2 Q47.4,103 47.8,108.4 Q49,101 49.5,94.6 Z"],
    gastrocnemius: [
      "M37.1,125 Q35.6,131 37.1,140 L41,140.8 L41.4,124.6 Z",
      "M41.9,124.6 L42.1,140.8 L45.3,139.4 Q46.6,131 45.3,124.6 Z",
    ],
    soleus: ["M37.3,141.2 Q37.1,146 38,150.8 L43.5,150.8 Q45.2,146 45.3,140.2 L42.1,141.8 L41,141.8 Z"],
  },
};

// Unfilled detail lines drawn on top of the regions: the ab rows on the front.
export const BODY_DECO: Readonly<Record<BodyView, string>> = {
  front: "M44.4,55.5 L50,55 M44.6,62.2 L50,62 M44.6,68.4 L50,68.4",
  back: "",
};

/** Every shape a region has, across both figures. Empty = not drawn anywhere. */
export function shapesFor(id: RegionId): string[] {
  return [...(BODY_PATHS.front[id] ?? []), ...(BODY_PATHS.back[id] ?? [])];
}
