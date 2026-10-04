import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Flashlight, FlashlightOff, Images, X } from "lucide-react";
import { t } from "../lib/i18n";
import { preloadOcr, OcrUnavailableError, type OcrFailure } from "../lib/labelScan/ocr";
import { grayscale, initialGate, sampleSize, stepGate, type GateState, type Readiness } from "../lib/labelScan/sharpness";

export interface LabelScannerProps {
  open: boolean;
  onClose: () => void;
  /** A sharp, well-framed still of the nutrition panel. */
  onCapture: (image: Blob) => void;
}

/**
 * Camera constraints. A nutrition panel carries the smallest print on the
 * package — US rules let the footnote go down to 6-point type and the nutrient
 * rows to 8-point — so resolution here is the difference between reading a
 * number and guessing it. 4K is asked for as the
 * IDEAL, not required: the browser picks the nearest mode the camera has
 * (1920×1080 on many Android phones, up to 4K on recent iPhones). More pixels
 * also let the phone be held further back, which matters on iPhones whose main
 * lens can't focus closer than ~15-20 cm.
 */
const CAMERA: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    // Non-standard but widely honoured, and ignored harmlessly where it isn't.
    ...({ focusMode: "continuous", advanced: [{ focusMode: "continuous" }] } as object),
  },
  audio: false,
};

/** ~6 samples a second: enough for a half-second "hold still" streak, cheap enough to leave the preview smooth. */
const SAMPLE_MS = 166;

/** JPEG quality for the captured still. 0.92 keeps stroke edges crisp for the reader at about a third of PNG's size. */
const JPEG_QUALITY = 0.92;

function failureText(reason: OcrFailure): string {
  switch (reason) {
    case "unsupported":
      return t("This phone's browser can't read labels on the device. It needs iOS 16.4 or newer, or a current Chrome.");
    case "memory":
      return t("Not enough free memory to read labels right now. Close other tabs and try again.");
    case "download":
      return t("Couldn't download the label reader. Check the connection and try again.");
    default:
      return t("The label reader didn't load.");
  }
}

/**
 * Full-screen camera for photographing a nutrition label.
 *
 * It exists to hand the reader ONE good still, because every check downstream
 * starts from what the reader got:
 *   1. a portrait guide the shape of a nutrition panel, so the panel fills the
 *      frame (a panel only a quarter of the frame's height misread 13 of its 29
 *      number lines in the measurement recorded in ocr/pipeline.ts);
 *   2. a sharpness + stillness gate that fires the shutter by itself only when
 *      the frame is focused and not moving;
 *   3. the manual shutter and a photo picker, always, for when the gate is wrong
 *      or the camera won't cooperate.
 *
 * It also starts loading the reader the moment it opens, so the models are warm
 * by the time the shutter fires.
 */
export function LabelScanner({ open, onClose, onCapture }: LabelScannerProps) {
  // Mounting the body only while open gives every opening fresh state — no
  // reset-on-open pass, and nothing left over from the last label.
  if (!open) return null;
  return <ScannerBody onClose={onClose} onCapture={onCapture} />;
}

function ScannerBody({ onClose, onCapture }: Omit<LabelScannerProps, "open">) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [status, setStatus] = useState<"starting" | "live" | "fallback">("starting");
  const [readiness, setReadiness] = useState<Readiness>("aim");
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [readerError, setReaderError] = useState<OcrFailure | null>(null);

  // Same reason as BarcodeScanner: the parent passes an inline arrow, and with it
  // in the effect's dependencies every parent render tore the camera down and
  // restarted it. The camera effect runs once per mount; the callback lives in a ref.
  const onCaptureRef = useRef(onCapture);
  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const busyRef = useRef(false);
  const autoFiredRef = useRef(false);

  const flash = useCallback(() => {
    setCaptured(true);
    try {
      navigator.vibrate?.(40);
    } catch {
      /* not supported */
    }
    window.setTimeout(() => setCaptured(false), 900);
  }, []);

  /** Full-resolution frame → JPEG. ImageCapture.takePhoto would be sharper but doesn't exist on iOS; the canvas path works on both phones. */
  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || busyRef.current || !video.videoWidth) return;
    busyRef.current = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
      canvas.width = 0;
      if (!blob) return;
      flash();
      onCaptureRef.current(blob);
    } finally {
      busyRef.current = false;
    }
  }, [flash]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let done = false;
    let gate: GateState = initialGate();

    // Warm the reader now so recognition is ready when the shutter fires. A
    // failure here doesn't block taking the photo; it is shown, and the caller's
    // recognize() will surface the same error.
    preloadOcr().catch((e) => {
      if (!done) setReaderError(e instanceof OcrUnavailableError ? e.reason : "internal");
    });

    const sampleCanvas = document.createElement("canvas");
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

    const finish = () => {
      done = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
      trackRef.current = null;
      sampleCanvas.width = 0;
    };

    /** The guide rectangle, in video pixels. The video is object-cover, so the screen→video map is one scale plus a centring offset. */
    const guideInVideo = (video: HTMLVideoElement) => {
      const frame = frameRef.current?.getBoundingClientRect();
      const guide = guideRef.current?.getBoundingClientRect();
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!frame || !guide || !vw || !vh) return null;
      const scale = Math.max(frame.width / vw, frame.height / vh);
      const offX = (frame.width - vw * scale) / 2;
      const offY = (frame.height - vh * scale) / 2;
      const x0 = Math.max(0, (guide.left - frame.left - offX) / scale);
      const y0 = Math.max(0, (guide.top - frame.top - offY) / scale);
      const x1 = Math.min(vw, (guide.right - frame.left - offX) / scale);
      const y1 = Math.min(vh, (guide.bottom - frame.top - offY) / scale);
      if (x1 - x0 < 8 || y1 - y0 < 8) return null;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };

    const tick = () => {
      if (done) return;
      const video = videoRef.current;
      const roi = video && video.readyState >= 2 ? guideInVideo(video) : null;
      if (video && roi && sampleCtx) {
        const size = sampleSize(roi.w, roi.h);
        if (sampleCanvas.width !== size.width || sampleCanvas.height !== size.height) {
          sampleCanvas.width = size.width;
          sampleCanvas.height = size.height;
          gate = initialGate(); // a new sample size makes the old frame incomparable
        }
        try {
          sampleCtx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, size.width, size.height);
          const px = sampleCtx.getImageData(0, 0, size.width, size.height).data;
          const step = stepGate(gate, grayscale(px, size.width, size.height), size.width, size.height);
          gate = step.state;
          setReadiness(step.reading.readiness);
          // Auto-capture once per opening. After that the person is in charge:
          // a second automatic shot of the same panel would only be a surprise.
          if (step.reading.fire && !autoFiredRef.current) {
            autoFiredRef.current = true;
            void capture();
          }
        } catch {
          /* a frame that can't be read (mid-resize, tab hidden) is skipped */
        }
      }
      timer = window.setTimeout(tick, SAMPLE_MS);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA);
        if (done) return stream.getTracks().forEach((tr) => tr.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        const track = stream.getVideoTracks()[0];
        trackRef.current = track ?? null;
        const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
        setHasTorch(!!caps?.torch);
        setStatus("live");
        timer = window.setTimeout(tick, SAMPLE_MS);
      } catch {
        if (!done) setStatus("fallback");
      }
    })();

    return finish;
  }, [capture]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is a real, widely-shipped constraint the DOM typings don't carry.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setHasTorch(false);
    }
  }, [torchOn]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear it so choosing the same photo again still fires a change.
    e.target.value = "";
    if (file) onCaptureRef.current(file);
  };

  const good = "var(--h-good, #199e70)";
  const hint =
    status === "starting"
      ? t("starting camera…")
      : captured
        ? t("Captured")
        : readiness === "ready"
          ? t("Ready")
          : readiness === "steady"
            ? t("Hold still…")
            : t("Point at the nutrition panel");

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col"
      style={{ background: "var(--color-bg)" }}
      role="dialog"
      aria-modal="true"
      aria-label={t("Scan a nutrition label")}
    >
      <div
        className="flex items-center justify-between px-4"
        style={{ paddingTop: "max(env(safe-area-inset-top), 8px)", borderBottom: "2px solid var(--color-accent)" }}
      >
        <h2 className="py-2 text-lg font-semibold text-bone">{t("Scan a nutrition label")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-taupe transition hover:bg-raised"
        >
          <X size={22} />
        </button>
      </div>

      {status !== "fallback" ? (
        <div ref={frameRef} className="relative flex-1 overflow-hidden bg-black">
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
            <p
              className="rounded-full px-3 py-1 text-center text-[13px] font-medium text-bone"
              style={{ background: "rgba(0,0,0,.55)" }}
            >
              {t("Fill the frame with just the nutrition panel")}
            </p>
            {/* Portrait guide, roughly a US panel's proportions (about 3:5).
                The shadow dims everything outside it, which says "only this
                part matters" without another line of text. */}
            <div
              ref={guideRef}
              className="rounded-xl border-2 motion-safe:transition-colors motion-safe:duration-200"
              style={{
                aspectRatio: "3 / 5",
                height: "min(56vh, calc((100vw - 48px) * 5 / 3))",
                borderColor: readiness === "ready" || captured ? good : "var(--color-accent)",
                boxShadow: "0 0 0 100vmax rgba(0,0,0,.42)",
              }}
            />
            <p
              aria-live="polite"
              className="rounded-full px-3 py-1 text-center font-mono text-[12px]"
              style={{
                background: "rgba(0,0,0,.55)",
                color: readiness === "ready" || captured ? good : "#fff",
              }}
            >
              {hint}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-[14px] text-taupe">{t("Camera unavailable — choose a photo of the nutrition panel instead.")}</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-bg"
          >
            <Images size={18} />
            {t("Choose a photo")}
          </button>
        </div>
      )}

      {readerError && (
        <p className="px-4 pt-2 text-center text-[12px]" style={{ color: "var(--color-taupe)" }}>
          {failureText(readerError)}
        </p>
      )}

      {/* In the fallback the picker is already the main button above; a disabled
          shutter and a second picker beside it would only be noise. */}
      {status !== "fallback" && (
        <div
          className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 pt-3"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}
        >
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label={t("Choose a photo")}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-raised text-bone transition hover:brightness-110"
            >
              <Images size={20} />
            </button>
          </div>
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void capture()}
              disabled={status !== "live"}
              aria-label={t("Take the photo")}
              className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full border-4 disabled:opacity-40 motion-safe:transition motion-safe:active:scale-95"
              style={{ borderColor: "var(--color-bone)" }}
            >
              <span className="block h-[54px] w-[54px] rounded-full" style={{ background: "var(--color-bone)" }} />
            </button>
          </div>
          <div className="flex justify-end">
            {hasTorch && (
              <button
                type="button"
                onClick={toggleTorch}
                aria-label={torchOn ? t("Turn the light off") : t("Turn the light on")}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-raised"
                style={{ color: torchOn ? "var(--color-accent)" : "var(--color-bone)" }}
              >
                {torchOn ? <Flashlight size={20} /> : <FlashlightOff size={20} />}
              </button>
            )}
          </div>
        </div>
      )}

      {/* No `capture` attribute, on purpose. With capture="environment" both iOS
          and Android jump straight into the camera and the photo library becomes
          unreachable; without it, both platforms offer "Take Photo" AND the
          library in their own picker — the native camera app's autofocus and
          full resolution stay one tap away, and a label photographed earlier
          can still be used. */}
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
    </div>
  );
}
