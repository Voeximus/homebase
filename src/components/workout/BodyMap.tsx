import { useId, type CSSProperties } from "react";
import { t } from "../../lib/i18n";
import type { RegionId } from "../../lib/muscleRegions";
import {
  BODY_BASE,
  BODY_DECO,
  BODY_HEAD,
  BODY_MIRROR,
  BODY_PATHS,
  BODY_VIEWBOX,
  type BodyView,
} from "../../lib/bodyMapPaths";

// ── Body map: which muscles an exercise uses ───────────────────────────────────
// Front and back figures side by side. Main muscles are solid bone, helpers are a
// 45° bone stripe with a thin bone outline, everything else stays the quiet
// highlight tone on the silhouette. Colour alone never carries the difference —
// solid vs striped still reads in greyscale.
//
// The picture is decoration for the sighted: it is aria-hidden, and the caller
// renders the "Main: … · Helps: …" line that says the same thing in words.
// Regions the figure cannot show (drawn: false) have no shape in bodyMapPaths, so
// they simply never appear here.

type Fill = "main" | "help" | "none";

// CSS variables only resolve through `style`, not SVG presentation attributes.
function regionStyle(fill: Fill, hatch: string): CSSProperties {
  if (fill === "main") return { fill: "var(--color-bone)", stroke: "var(--color-tile)", strokeWidth: 0.55, strokeLinejoin: "round" };
  if (fill === "help") return { fill: `url(#${hatch})`, stroke: "var(--color-bone)", strokeWidth: 0.45, strokeLinejoin: "round" };
  return { fill: "var(--h-hl)", stroke: "var(--color-tile)", strokeWidth: 0.55, strokeLinejoin: "round" };
}

export function BodyMap({ primary, secondary }: { primary: RegionId[]; secondary: RegionId[] }) {
  // useId, because two maps on one page (a list, a transition) would otherwise
  // share pattern ids and the second would paint with the first's stripes. React's
  // id carries characters that are not safe inside url(#…), so keep only the safe ones.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hatch = `hbHatch${uid}`;
  const hatchLg = `hbHatchLg${uid}`;

  const main = new Set(primary);
  const help = new Set(secondary);
  // A region listed as both is shown as main — the stronger claim wins.
  const fillOf = (id: RegionId): Fill => (main.has(id) ? "main" : help.has(id) ? "help" : "none");

  return (
    <div aria-hidden="true">
      {/* Zero-size holder for the stripe patterns both figures and the legend use. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
        <defs>
          <pattern id={hatch} patternUnits="userSpaceOnUse" width="3.4" height="3.4" patternTransform="rotate(45)">
            <rect width="3.4" height="3.4" style={{ fill: "var(--h-hl)" }} />
            <rect width="1.43" height="3.4" style={{ fill: "var(--color-bone)" }} />
          </pattern>
          <pattern id={hatchLg} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
            <rect width="5" height="5" style={{ fill: "var(--h-hl)" }} />
            <rect width="2.1" height="5" style={{ fill: "var(--color-bone)" }} />
          </pattern>
        </defs>
      </svg>

      <div className="grid grid-cols-2 gap-1.5">
        <Figure view="front" caption={t("Front")} fillOf={fillOf} hatch={hatch} />
        <Figure view="back" caption={t("Back")} fillOf={fillOf} hatch={hatch} />
      </div>

      <div className="mt-2 flex flex-wrap justify-center gap-3.5 text-[11px] text-taupe">
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true" focusable="false">
            <rect width="16" height="12" rx="2" style={{ fill: "var(--color-bone)" }} />
          </svg>
          {t("Main")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true" focusable="false">
            <rect
              width="16"
              height="12"
              rx="2"
              style={{ fill: `url(#${hatchLg})`, stroke: "var(--color-bone)", strokeWidth: 1 }}
            />
          </svg>
          {t("Helps")}
        </span>
      </div>
    </div>
  );
}

function Figure({
  view,
  caption,
  fillOf,
  hatch,
}: {
  view: BodyView;
  caption: string;
  fillOf: (id: RegionId) => Fill;
  hatch: string;
}) {
  const regions = Object.entries(BODY_PATHS[view]) as [RegionId, readonly string[]][];
  const deco = BODY_DECO[view];
  return (
    <div className="text-center">
      <svg
        viewBox={BODY_VIEWBOX}
        className="mx-auto h-auto w-full max-w-[132px]"
        aria-hidden="true"
        focusable="false"
      >
        <ellipse {...BODY_HEAD} style={{ fill: "var(--color-edge)" }} />
        <path d={BODY_BASE} style={{ fill: "var(--color-edge)" }} />
        <path d={BODY_BASE} transform={BODY_MIRROR} style={{ fill: "var(--color-edge)" }} />
        {regions.map(([id, shapes]) => {
          const fill = fillOf(id);
          // Each shape is the left half; the mirrored copy draws the right.
          return (
            <g key={id} data-region={id} data-fill={fill} style={regionStyle(fill, hatch)}>
              {shapes.map((d, i) => (
                <path key={i} d={d} />
              ))}
              <g transform={BODY_MIRROR}>
                {shapes.map((d, i) => (
                  <path key={i} d={d} />
                ))}
              </g>
            </g>
          );
        })}
        {deco && (
          <>
            <path d={deco} style={{ fill: "none", stroke: "var(--color-tile)", strokeWidth: 0.5 }} />
            <path
              d={deco}
              transform={BODY_MIRROR}
              style={{ fill: "none", stroke: "var(--color-tile)", strokeWidth: 0.5 }}
            />
          </>
        )}
      </svg>
      <div className="mt-0.5 text-[10px] uppercase tracking-[.06em] text-faint">{caption}</div>
    </div>
  );
}
