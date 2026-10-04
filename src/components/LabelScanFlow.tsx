// Photograph a nutrition label → a food in the library.
//
//   capture   LabelScanner hands back a still of the panel
//   read      recognize → parseLabel → verify + suggestRepairs   ("Reading the label…")
//   confirm   LabelConfirmSheet — a person confirms serving, decides conflicts, saves
//   save      toLabelFood → the app's Food → onFood, and (with a barcode) a
//             fire-and-forget share to the household food cache
//
// Every stage can fail, and every failure is shown in plain words with a way
// forward: take the photo again, or add the food by hand. Nothing here throws at
// the person.
import { useEffect, useRef, useState } from "react";
import { Camera, Pencil, X } from "lucide-react";
import { t } from "../lib/i18n";
import { canonicalGtin } from "../lib/gtin";
import type { Food } from "../lib/nutrition";
import { preloadOcr } from "../lib/labelScan/ocr";
import { suggestRepairs } from "../lib/labelScan/repair";
import type { LabelFood } from "../lib/labelScan/types";
import { labelFoodToFood, readLabel, type LabelReadResult } from "../lib/labelScanFlow";
import { saveLabelFood } from "../lib/labelSave";
import { LabelScanner } from "./LabelScanner";
import { LabelConfirmSheet, type LabelSaveDetail } from "./LabelConfirmSheet";

export interface LabelScanFlowProps {
  open: boolean;
  onClose: () => void;
  /** The barcode that missed every catalog, when the scan started from one. */
  barcode?: string;
  initialName?: string;
  onFood: (food: Food) => void;
  /** "Add it by hand" — back to the custom food form. Falls back to onClose. */
  onAddByHand?: () => void;
}

// ── the flow ──────────────────────────────────────────────────────────────────

type Stage =
  | { kind: "capture" }
  | { kind: "reading" }
  | { kind: "confirm"; read: Extract<LabelReadResult, { ok: true }> }
  | { kind: "failed"; stage: Extract<LabelReadResult, { ok: false }>["stage"] };

export function LabelScanFlow(props: LabelScanFlowProps) {
  // Mounted only while open, so every open starts at the camera with no leftovers.
  if (!props.open) return null;
  return <FlowBody {...props} />;
}

function FlowBody({ onClose, barcode, initialName, onFood, onAddByHand }: LabelScanFlowProps) {
  const [stage, setStage] = useState<Stage>({ kind: "capture" });
  // Each read gets a ticket; a slow read that finishes after Retake or close is ignored.
  const ticket = useRef(0);

  useEffect(() => {
    // Warm the model while the person frames the shot. Failure here is silent —
    // recognize() will report it properly if it matters.
    preloadOcr().catch(() => {});
    return () => {
      ticket.current += 1;
    };
  }, []);

  const retake = () => {
    ticket.current += 1;
    setStage({ kind: "capture" });
  };

  const onCapture = async (image: Blob) => {
    const mine = ++ticket.current;
    setStage({ kind: "reading" });
    const r = await readLabel(image);
    if (mine !== ticket.current) return;
    if (r.ok) setStage({ kind: "confirm", read: r });
    else {
      if (r.detail) console.error(`label scan failed at ${r.stage}:`, r.detail);
      setStage({ kind: "failed", stage: r.stage });
    }
  };

  const onSave = (food: LabelFood, detail: LabelSaveDetail) => {
    onFood(labelFoodToFood(food));
    // Share with the other phone — only with a barcode to key it on, and only
    // when the label agrees with itself (the server re-checks regardless and
    // would refuse anything else). Never awaited: the food is already saved.
    if (food.barcode && detail.verification.consistent) {
      void saveLabelFood({
        barcode: food.barcode,
        panel: detail.panel,
        overrides: detail.overrides,
        servingGrams: food.serving ?? 0,
        name: food.name,
        ...(food.brand ? { brand: food.brand } : {}),
        ...(food.engine ? { engine: food.engine } : {}),
        columnIndex: detail.columnIndex,
      });
    }
  };

  const byHand = () => (onAddByHand ? onAddByHand() : onClose());

  if (stage.kind === "capture") {
    return <LabelScanner open onClose={onClose} onCapture={onCapture} />;
  }

  // Same sheet as FoodSearchSheet. The backdrop does not dismiss the confirm
  // step: a stray tap there would throw away a person's decisions.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,.55)" }}
      role="dialog"
      aria-modal="true"
      onClick={stage.kind === "confirm" ? undefined : onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
        style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)", borderRadius: "22px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {stage.kind === "confirm" ? (
          <LabelConfirmSheet
            panel={stage.read.panel}
            verification={stage.read.verification}
            repairs={stage.read.repairs}
            engine={stage.read.engine}
            barcode={barcode ? canonicalGtin(barcode) : undefined}
            initialName={initialName}
            suggest={suggestRepairs}
            onSave={onSave}
            onRetake={retake}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 p-4 pb-2">
              <div className="flex-1 text-[16px] font-bold text-bone">{t("Scan a nutrition label")}</div>
              <button onClick={onClose} aria-label={t("Close")} className="flex h-11 w-11 items-center justify-center" style={{ color: "var(--color-faint)" }}>
                <X size={20} />
              </button>
            </div>
            {stage.kind === "reading" ? (
              <p className="mx-4 mb-4 mt-2 rounded-lg px-3 py-3 text-[13px]" style={{ background: "var(--color-tile)", color: "var(--color-taupe)" }} aria-live="polite">
                … {t("Reading the label…")}
              </p>
            ) : (
              <>
                <p className="mx-4 mt-2 rounded-lg px-3 py-3 text-[13px] leading-snug" style={{ background: "var(--color-tile)", color: "var(--color-taupe)" }} role="alert">
                  {failureText(stage.stage)}
                </p>
                <div className="flex gap-2 p-4 pt-3">
                  <button onClick={retake} className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold transition active:scale-[0.98]" style={{ background: "var(--color-accent)", color: "var(--h-on-accent)", minHeight: 48 }}>
                    <Camera size={16} /> {t("Retake")}
                  </button>
                  <button onClick={byHand} className="flex flex-1 items-center justify-center gap-2 rounded-[14px] py-3 text-[14px] font-semibold" style={{ background: "var(--color-tile)", border: "1px solid var(--color-edge)", color: "var(--color-taupe)", minHeight: 48 }}>
                    <Pencil size={15} /> {t("Add it by hand")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function failureText(stage: Extract<LabelReadResult, { ok: false }>["stage"]): string {
  switch (stage) {
    case "no-panel":
      return t("Couldn't find a nutrition panel — fill the frame with just the panel and avoid glare.");
    case "read":
      return t("Couldn't read that photo. Try again with the label flat and well lit, or add it by hand.");
    case "parse":
      return t("Couldn't make sense of the text on that label. Try another photo, or add it by hand.");
    case "check":
      return t("Couldn't check the numbers on that label. Try another photo, or add it by hand.");
  }
}
