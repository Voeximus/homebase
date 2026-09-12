import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Copy, Images, Loader2, RotateCcw } from "lucide-react";
import { LabelScanner } from "../../components/LabelScanner";
import { LabelConfirmSheet } from "../../components/LabelConfirmSheet";
import { labelFoodToFood } from "../../lib/labelScanFlow";
import { parseLabel, suggestRepairs, verify, type OcrPage, type ParsedPanel, type Repair, type Verification } from "../../lib/labelScan";
import { OCR_ENGINE, ocrLoadInfo, preloadOcr, recognizeDetailed, type OcrLoadInfo, type RecognizeTimings } from "../../lib/labelScan/ocr";

// ?labellab — DEV-only harness for the label reader. No login, no store.
//
// Pick or drop label photos (or use the camera) → recognize() → parseLabel →
// verify → suggestRepairs, with the token boxes drawn over the image and every
// stage's output visible. "Copy JSON" produces one evaluation record,
// {engine, ms, tokens, parsed, verification, repairs}, so a set of real labels
// can be collected on the phones themselves and replayed later.
//
// "Run again" re-reads the same image and says whether the tokens came back
// byte-identical — rule 5 (determinism), checked on the device in front of you
// rather than assumed from a desktop.

type Stage<T> = { ok: true; value: T } | { ok: false; error: string };

interface Item {
  id: number;
  name: string;
  blob: Blob;
  url: string;
  busy: boolean;
  page?: OcrPage;
  timings?: RecognizeTimings;
  error?: string;
  parsed?: Stage<ParsedPanel | null>;
  verification?: Stage<Verification>;
  repairs?: Stage<Repair[]>;
  rerun?: "identical" | "different";
}

/** The committed public-domain fixtures. The dev server serves the repo root, so these load without copying into public/. */
const SAMPLES = [
  { name: "FDA label 1", path: "/tests/fixtures/labels/fda-label-1.png" },
  { name: "FDA label 1 · photo sim", path: "/tests/fixtures/labels/fda-label-1-photo-sim.jpg" },
  { name: "FDA dual column", path: "/tests/fixtures/labels/fda-dual-column.png" },
];

function stage<T>(fn: () => T): Stage<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /not implemented/i.test(msg) ? "not implemented in this branch" : msg };
  }
}

const tokensKey = (p: OcrPage) => JSON.stringify(p.tokens);

let nextId = 1;

export function LabelLab() {
  const [items, setItems] = useState<Item[]>([]);
  const [camera, setCamera] = useState(false);
  const [load, setLoad] = useState<{ state: "loading" | "ready" | "error"; info?: OcrLoadInfo; error?: string }>({ state: "loading" });
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Loading state lives in the promise callbacks, so the effect itself only
  // starts the load (the retry button sets "loading" from its click instead).
  const warm = useCallback(() => {
    preloadOcr()
      .then(ocrLoadInfo)
      .then(
        (info) => setLoad({ state: "ready", info: info ?? undefined }),
        (e) => setLoad({ state: "error", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
      );
  }, []);

  useEffect(() => {
    warm();
  }, [warm]);

  const patch = (id: number, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const read = useCallback(async (id: number, blob: Blob, previous?: OcrPage) => {
    patch(id, { busy: true, error: undefined });
    try {
      const { page, timings } = await recognizeDetailed(blob);
      const parsed = stage(() => parseLabel(page));
      const panel = parsed.ok ? parsed.value : null;
      const verification = panel ? stage(() => verify(panel)) : parsed.ok ? undefined : parsed;
      const repairs = panel ? stage(() => suggestRepairs(panel)) : parsed.ok ? undefined : parsed;
      patch(id, {
        busy: false,
        page,
        timings,
        parsed,
        verification: verification as Stage<Verification> | undefined,
        repairs: repairs as Stage<Repair[]> | undefined,
        rerun: previous ? (tokensKey(previous) === tokensKey(page) ? "identical" : "different") : undefined,
      });
    } catch (e) {
      patch(id, { busy: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
    void ocrLoadInfo().then((info) => info && setLoad((l) => ({ ...l, state: "ready", info })));
  }, []);

  const add = useCallback(
    (blob: Blob, name: string) => {
      const id = nextId++;
      setItems((xs) => [{ id, name, blob, url: URL.createObjectURL(blob), busy: true }, ...xs]);
      void read(id, blob);
    },
    [read],
  );

  const addFiles = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) if (f.type.startsWith("image/")) add(f, f.name);
  };

  const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition";

  return (
    <div
      className="min-h-screen"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto max-w-[760px] px-4 py-5">
        <h1 className="text-xl font-semibold text-bone">Label lab</h1>
        <p className="mt-1 font-mono text-[11px] text-faint">
          {OCR_ENGINE} ·{" "}
          {load.state === "loading" && "loading reader…"}
          {load.state === "ready" &&
            load.info &&
            `ready on ${load.info.runsOn} thread · ${(load.info.downloadBytes / 1e6).toFixed(2)} MB fetched · load ${Math.round(load.info.loadMs)} ms`}
          {load.state === "error" && <span style={{ color: "var(--color-ember)" }}>{load.error}</span>}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button className={`${btn} bg-accent text-bg`} onClick={() => setCamera(true)}>
            <Camera size={16} /> Open camera
          </button>
          <button className={`${btn} bg-raised text-bone`} onClick={() => fileRef.current?.click()}>
            <Images size={16} /> Choose photos
          </button>
          {load.state === "error" && (
            <button
              className={`${btn} bg-raised text-bone`}
              onClick={() => {
                setLoad({ state: "loading" });
                warm();
              }}
            >
              <RotateCcw size={16} /> Retry load
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s.path}
              className={`${btn} bg-tile text-taupe`}
              onClick={async () => {
                const res = await fetch(s.path);
                if (res.ok) add(await res.blob(), s.name);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div
          className="mt-3 rounded-xl border border-dashed p-4 text-center text-[12px] text-faint"
          style={{ borderColor: drag ? "var(--color-accent)" : "var(--color-edge)" }}
        >
          or drop label photos anywhere on this page
        </div>

        <div className="mt-5 space-y-6">
          {items.map((it) => (
            <ItemCard key={it.id} item={it} onRerun={() => it.page && void read(it.id, it.blob, it.page)} />
          ))}
        </div>
      </div>

      <LabelScanner
        open={camera}
        onClose={() => setCamera(false)}
        onCapture={(blob) => {
          setCamera(false);
          add(blob, `camera ${new Date().toLocaleTimeString()}`);
        }}
      />
    </div>
  );
}

function StageView<T>({ label, s }: { label: string; s?: Stage<T> }) {
  if (!s) return null;
  return (
    <details className="rounded-xl bg-raised p-3" open={!s.ok}>
      <summary className="cursor-pointer text-[12px] font-semibold text-taupe">
        {label} {s.ok ? "" : `— ${s.error}`}
      </summary>
      {s.ok && (
        <pre className="mt-2 max-h-72 overflow-auto font-mono text-[11px] text-bone">{JSON.stringify(s.value, null, 2)}</pre>
      )}
    </details>
  );
}

function ItemCard({ item, onRerun }: { item: Item; onRerun: () => void }) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  // The real confirm screen on this read — the same sheet the meal builder
  // opens — with saving replaced by showing the Food that would be added.
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<unknown>(null);
  const p = item.page;
  const tm = item.timings;
  const panel = item.parsed?.ok ? item.parsed.value : null;
  const checked = item.verification?.ok ? item.verification.value : null;

  const copy = async () => {
    if (!p) return;
    const val = <T,>(s?: Stage<T>) => (s ? (s.ok ? s.value : { error: s.error }) : null);
    const record = {
      engine: p.engine,
      ms: p.ms,
      width: p.width,
      height: p.height,
      tokens: p.tokens,
      parsed: val(item.parsed),
      verification: val(item.verification),
      repairs: val(item.repairs),
    };
    await navigator.clipboard.writeText(JSON.stringify(record, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="rounded-2xl border border-edge bg-tile p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-bone">{item.name}</div>
        <div className="flex gap-2">
          <button
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-raised px-3 text-[12px] font-semibold text-bone disabled:opacity-40"
            disabled={!p || item.busy}
            onClick={onRerun}
          >
            <RotateCcw size={14} /> Run again
          </button>
          <button
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent/15 px-3 text-[12px] font-semibold text-accent disabled:opacity-40"
            disabled={!p}
            onClick={() => void copy()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />} Copy JSON
          </button>
          <button
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12px] font-semibold text-bg disabled:opacity-40"
            disabled={!panel || !checked || item.busy}
            onClick={() => {
              setSaved(null);
              setConfirming(true);
            }}
          >
            Confirm screen
          </button>
        </div>
      </div>

      {saved !== null && (
        <pre className="mb-2 max-h-72 overflow-auto rounded-xl bg-raised p-3 font-mono text-[11px] text-bone">
          {"would add → " + JSON.stringify(saved, null, 2)}
        </pre>
      )}

      {confirming && panel && checked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(0,0,0,.55)" }} role="dialog" aria-modal="true">
          <div
            className="flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden"
            style={{ background: "var(--color-raised)", border: "1px solid var(--color-edge)", borderTop: "2px solid var(--color-accent)", borderRadius: "22px" }}
          >
            <LabelConfirmSheet
              panel={panel}
              verification={checked}
              repairs={item.repairs?.ok ? item.repairs.value : []}
              engine={p?.engine}
              suggest={suggestRepairs}
              onSave={(food) => {
                setSaved(labelFoodToFood(food));
                setConfirming(false);
              }}
              onRetake={() => setConfirming(false)}
              onClose={() => setConfirming(false)}
            />
          </div>
        </div>
      )}

      {item.error && (
        <p className="mb-2 font-mono text-[12px]" style={{ color: "var(--color-ember)" }}>
          {item.error}
        </p>
      )}
      {tm && p && (
        <p className="mb-2 font-mono text-[11px] text-faint">
          {p.width}×{p.height} → {tm.workWidth}×{tm.workHeight} · {p.ms} ms total (wait {Math.round(tm.waitMs)} · decode{" "}
          {Math.round(tm.decodeMs)} · prep {Math.round(tm.prepMs)} · det {Math.round(tm.detMs)} · rec {Math.round(tm.recMs)}) ·{" "}
          {tm.boxes} boxes → {p.tokens.length} tokens · {tm.runsOn} thread
          {item.rerun && (
            <span style={{ color: item.rerun === "identical" ? "var(--h-good, #199e70)" : "var(--color-ember)" }}>
              {" "}
              · re-run {item.rerun}
            </span>
          )}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
        <div className="relative self-start overflow-hidden rounded-xl bg-bg">
          <img src={item.url} alt={item.name} className="block w-full" />
          {p && (
            <svg
              viewBox={`0 0 ${p.width} ${p.height}`}
              className="absolute inset-0 h-full w-full"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {p.tokens.map((tk, i) => (
                <rect
                  key={i}
                  x={tk.x}
                  y={tk.y}
                  width={tk.w}
                  height={tk.h}
                  fill={hover === i ? "rgba(52,197,232,.25)" : "none"}
                  stroke={(tk.conf ?? 1) < 0.8 ? "#e3b341" : "#34c5e8"}
                  strokeWidth={Math.max(1.5, p.width / 400)}
                />
              ))}
            </svg>
          )}
          {item.busy && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,.35)" }}>
              <Loader2 className="motion-safe:animate-spin text-accent" size={28} />
            </div>
          )}
        </div>

        {p && (
          <div className="max-h-[520px] overflow-auto rounded-xl bg-raised">
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 bg-raised text-faint">
                <tr>
                  <th className="px-2 py-1 text-left">text</th>
                  <th className="px-2 py-1 text-right">conf</th>
                  <th className="px-2 py-1 text-right">x,y</th>
                  <th className="px-2 py-1 text-right">w×h</th>
                </tr>
              </thead>
              <tbody>
                {p.tokens.map((tk, i) => (
                  <tr
                    key={i}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    className={hover === i ? "bg-tile" : ""}
                  >
                    <td className="px-2 py-0.5 text-bone">{tk.text}</td>
                    <td className="px-2 py-0.5 text-right" style={{ color: (tk.conf ?? 1) < 0.8 ? "#e3b341" : "var(--color-taupe)" }}>
                      {tk.conf?.toFixed(3)}
                    </td>
                    <td className="px-2 py-0.5 text-right text-taupe">
                      {Math.round(tk.x)},{Math.round(tk.y)}
                    </td>
                    <td className="px-2 py-0.5 text-right text-taupe">
                      {Math.round(tk.w)}×{Math.round(tk.h)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <StageView label="parseLabel" s={item.parsed} />
        <StageView label="verify" s={item.verification} />
        <StageView label="suggestRepairs" s={item.repairs} />
      </div>
    </div>
  );
}
