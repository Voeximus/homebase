import { useCallback, useEffect, useRef, useState } from "react";
import { Flashlight, FlashlightOff } from "lucide-react";
import { Sheet, Button, inputClass } from "./ui";
import { t } from "../lib/i18n";
import { digitsOnly, isValidGtin } from "../lib/gtin";

// The retail 1D symbologies a food package actually carries. Restricting the
// decoder to these is the cheapest accuracy win available: a reader left on
// "any format" spends its budget testing QR, Data Matrix, PDF417 and Aztec
// finder patterns against every frame, and — worse — a partially-lit EAN-13 can
// satisfy a looser 1D format like Code 39 and decode to confident nonsense.
const RETAIL_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "itf", "code_128"] as const;

// How many times the SAME number has to come back before it is accepted.
//
// One decode is not evidence. A camera reading a curved can, a creased bag or a
// label behind plastic WILL occasionally produce a valid-looking wrong number,
// and a wrong number does not fail — it silently looks up a different food and
// logs it. Two agreeing reads from different frames make that vanishingly rare,
// and at ~15 decodes a second it costs no perceptible time.
const CONFIRMATIONS = 2;

interface ScannerControls {
  stop: () => void;
}

// The native detector, where the platform has one. On Android Chrome this is
// hardware-accelerated and decodes a small or angled barcode that the
// JS decoder gives up on; it is the single biggest quality difference between a
// scanner that "usually works" and one that just works. iOS Safari has no such
// API, which is what the zxing path below is for.
type NativeDetector = {
  detect: (src: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]>;
};
type DetectorCtor = new (opts: { formats: readonly string[] }) => NativeDetector;
const nativeDetectorCtor = (): DetectorCtor | null => {
  const w = window as unknown as { BarcodeDetector?: DetectorCtor };
  return typeof w.BarcodeDetector === "function" ? w.BarcodeDetector : null;
};

/** Camera constraints. Resolution and focus are not cosmetic here — a retail
 *  barcode's narrowest bar is ~0.33 mm, so a 640×480 frame at arm's length
 *  simply does not contain enough pixels to resolve it, and a camera locked to
 *  infinity focus never sharpens on something held 20 cm away. */
const CAMERA: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    // Non-standard but widely honoured, and ignored harmlessly where it isn't.
    ...({ focusMode: "continuous", advanced: [{ focusMode: "continuous" }] } as object),
  },
  audio: false,
};

/**
 * Camera barcode scanner for food packaging.
 *
 * Three things make it reliable rather than merely present:
 *   1. the platform's own detector when there is one, zxing when there isn't;
 *   2. only retail 1D formats, so the decoder is not hunting QR codes;
 *   3. a number is not accepted until two frames agree AND its GS1 check digit
 *      passes — a misread is caught before it becomes a logged meal.
 *
 * Manual entry stays, for a torn label or a denied camera permission.
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
  const [engine, setEngine] = useState<"native" | "zxing" | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);

  // The parent passes an inline arrow for onResult, so its identity changes on
  // every parent render. With it in the effect's dependency list the whole
  // camera was torn down and restarted mid-scan, repeatedly — which reads as "it
  // keeps not working" and is why a scan sometimes needed several tries. Hold it
  // in a ref so the effect depends only on `open`.
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  /** Accept a decode only once it has been seen CONFIRMATIONS times and its own
   *  check digit agrees with its contents. Returns true when it fires. */
  const votes = useRef(new Map<string, number>());
  const accept = useCallback((raw: string): boolean => {
    const code = digitsOnly(raw);
    // ITF-14 and Code 128 turn up on outer cases and shipping labels with
    // lengths no retail GTIN has; anything that is not a GTIN length is noise.
    if (![8, 12, 13, 14].includes(code.length)) return false;
    // GS1 builds a mod-10 checksum into every GTIN exactly so a misread can be
    // rejected for free. A code that fails it is not a code.
    if (!isValidGtin(code)) return false;
    const n = (votes.current.get(code) ?? 0) + 1;
    votes.current.set(code, n);
    setSeen(code);
    if (n < CONFIRMATIONS) return false;
    // Confirmed. A short buzz is the confirmation you can feel without looking
    // up from the shelf.
    try {
      navigator.vibrate?.(60);
    } catch {
      /* not supported */
    }
    onResultRef.current(code);
    return true;
  }, []);

  useEffect(() => {
    if (!open) return;
    let controls: ScannerControls | null = null;
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    votes.current.clear();
    setStatus("starting");
    setManual("");
    setSeen(null);
    setTorchOn(false);
    setHasTorch(false);

    const finish = () => {
      done = true;
      cancelAnimationFrame(raf);
      try {
        controls?.stop();
      } catch {
        /* already stopped */
      }
      stream?.getTracks().forEach((tr) => tr.stop());
    };

    (async () => {
      const Native = nativeDetectorCtor();
      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA);
        if (done) return stream.getTracks().forEach((tr) => tr.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();

        const track = stream.getVideoTracks()[0];
        trackRef.current = track ?? null;
        // Torch is a real capability of the platform's camera, not a filter. In a
        // grocery aisle the shelf shades the package and the phone's own body
        // shades it further; without light the decoder is being asked to read
        // bars it cannot see.
        const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
        setHasTorch(!!caps?.torch);

        if (Native) {
          setEngine("native");
          const detector = new Native({ formats: RETAIL_FORMATS });
          setStatus("scanning");
          const tick = async () => {
            if (done) return;
            try {
              const hits = await detector.detect(video);
              for (const h of hits) if (accept(h.rawValue)) return finish();
            } catch {
              /* a dropped frame is normal — keep going */
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
          return;
        }

        // No native detector (iOS Safari): decode in JS, but tell zxing which
        // formats to try so it is not testing 2D finder patterns every frame.
        setEngine("zxing");
        const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.ITF,
          BarcodeFormat.CODE_128,
        ]);
        // TRY_HARDER trades CPU for reads on blurry or rotated frames. On a phone
        // pointed at a shelf, that trade is the right way round.
        hints.set(DecodeHintType.TRY_HARDER, true);
        const reader = new BrowserMultiFormatReader(hints);
        const c = await reader.decodeFromVideoElement(video, (result) => {
          if (!done && result && accept(result.getText())) finish();
        });
        controls = c as unknown as ScannerControls;
        if (done) controls.stop();
        else setStatus("scanning");
      } catch {
        if (!done) setStatus("fallback");
      }
    })();

    return finish;
  }, [open, accept]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is a real, widely-shipped constraint that the DOM typings have
      // never carried, so it has to be cast past them.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setHasTorch(false);
    }
  }, [torchOn]);

  const typed = digitsOnly(manual);
  // The same check digit gate as the camera path. Typing the number off a label
  // is where a transposed digit is MOST likely, and a transposed digit is
  // exactly what a mod-10 checksum exists to catch.
  const typedOk = isValidGtin(typed);

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
              {/* aiming guide — a wide, short window, because that is the shape of
                  a retail barcode and it tells you how to hold the phone */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className="h-20 w-3/4 rounded-lg border-2"
                  style={{ borderColor: seen ? "var(--color-good, #46d18a)" : "var(--color-accent)" }}
                />
              </div>
              {hasTorch && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  aria-label={torchOn ? t("Turn the light off") : t("Turn the light on")}
                  className="absolute right-2 top-2 rounded-full p-2"
                  style={{ background: "rgba(0,0,0,.55)", color: torchOn ? "var(--color-accent)" : "#fff" }}
                >
                  {torchOn ? <Flashlight size={16} /> : <FlashlightOff size={16} />}
                </button>
              )}
            </div>
            <p className="text-center font-mono text-[11px] text-faint">
              {status === "starting"
                ? t("starting camera…")
                : seen
                  ? t("reading {code}…", { code: seen })
                  : t("point the back camera at the barcode")}
            </p>
            {engine === "zxing" && status === "scanning" && (
              <p className="text-center text-[10px] text-faint">
                {t("Hold steady — this phone decodes in software. Fill the box with the barcode.")}
              </p>
            )}
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
            <Button disabled={!typedOk} onClick={() => onResult(typed)}>
              {t("Use")}
            </Button>
          </div>
          {typed.length >= 8 && !typedOk && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--color-taupe)" }}>
              {t("That number doesn't check out — one digit is probably off. Every barcode's last digit is a checksum of the rest.")}
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}
