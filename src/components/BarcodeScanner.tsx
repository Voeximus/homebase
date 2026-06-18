import { useEffect, useRef, useState } from "react";
import { Sheet, Button, inputClass } from "./ui";
import { t } from "../lib/i18n";

// Lazy-loaded zxing controls type (kept loose to avoid importing the dep eagerly).
interface ScannerControls {
  stop: () => void;
}

/**
 * Camera barcode scanner. Uses @zxing/browser (lazy-loaded) against the back
 * camera, with a manual-entry fallback for when the camera is blocked or
 * unsupported (e.g. permission denied). Returns the decoded digits via onResult.
 */
export function BarcodeScanner({
  open,
  onClose,
  onResult,
}: {
  open: boolean;
  onClose: () => void;
  onResult: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "fallback">("starting");
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (!open) return;
    let controls: ScannerControls | null = null;
    let cancelled = false;
    setStatus("starting");
    setManual("");

    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const c = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } } },
          videoRef.current!,
          (result, _err, ctrl) => {
            if (result && !cancelled) {
              cancelled = true;
              ctrl?.stop();
              onResult(result.getText());
            }
          },
        );
        controls = c as unknown as ScannerControls;
        if (cancelled) controls.stop();
        else setStatus("scanning");
      } catch {
        if (!cancelled) setStatus("fallback");
      }
    })();

    return () => {
      cancelled = true;
      try {
        controls?.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [open, onResult]);

  return (
    <Sheet open={open} onClose={onClose} title={t("Scan a barcode")}>
      <div className="space-y-4">
        {status !== "fallback" && (
          <>
            <div className="relative overflow-hidden rounded-xl border border-edge bg-bg">
              <video
                ref={videoRef}
                className="aspect-[4/3] w-full object-cover"
                muted
                playsInline
              />
              {/* aiming guide */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-20 w-3/4 rounded-lg border-2 border-accent/70" />
              </div>
            </div>
            <p className="text-center font-mono text-[11px] text-faint">
              {status === "starting"
                ? t("starting camera…")
                : t("point the back camera at the barcode")}
            </p>
          </>
        )}

        <div className="rounded-xl bg-raised p-3">
          <p className="mb-2 text-[12px] text-taupe">
            {status === "fallback"
              ? t("Camera unavailable — type the number under the barcode instead.")
              : t("Camera not cooperating? Type the number under the barcode.")}
          </p>
          <div className="flex gap-2">
            <input
              className={`${inputClass} num`}
              inputMode="numeric"
              placeholder="0 12345 67890"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <Button
              disabled={manual.replace(/\D/g, "").length < 6}
              onClick={() => onResult(manual.replace(/\D/g, ""))}
            >
              {t("Use")}
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
