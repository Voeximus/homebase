import { useEffect, useState } from "react";
import { Sparkles, Check } from "lucide-react";
import { CHANGELOG, APP_VERSION } from "../lib/changelog";
import { t } from "../lib/i18n";

const SEEN_KEY = "hb-seen-version";

// After an update lands, show the release's bullets ONCE. We compare the version
// baked into this bundle to the one the user last acknowledged: if they differ,
// show the card, then record the new version. A brand-new install (no seen
// version yet) is seeded silently — no changelog on first-ever open.
export function WhatsNew() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen && seen !== APP_VERSION) setShow(true);
    if (seen !== APP_VERSION) localStorage.setItem(SEEN_KEY, APP_VERSION);
  }, []);

  if (!show) return null;
  const rel = CHANGELOG[0];
  const dismiss = () => setShow(false);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.6)" }} onClick={dismiss}>
      <div
        className="w-full max-w-[400px] overflow-hidden rounded-[22px]"
        style={{ background: "#12100c", border: "1px solid #332b20", borderTop: "2px solid #a98304" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: "#2a2007", color: "#e5c273" }}>
            <Sparkles size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold text-bone">{t("What's new")}</div>
            <div className="text-[11.5px]" style={{ color: "#c6b9a6" }}>{rel.date}</div>
          </div>
        </div>

        <ul className="flex flex-col gap-2.5 px-5 py-4">
          {rel.notes.map((n, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "#e5c273" }} />
              <span className="text-[13px] leading-snug text-bone">{n}</span>
            </li>
          ))}
        </ul>

        <div className="px-5 pb-5">
          <button
            onClick={dismiss}
            className="flex w-full items-center justify-center gap-2 rounded-[14px] py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.98]"
            style={{ background: "linear-gradient(150deg,#a98304,#d47c2e)" }}
          >
            <Check size={16} /> {t("Got it")}
          </button>
        </div>
      </div>
    </div>
  );
}
