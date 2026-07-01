import { useRegisterSW } from "virtual:pwa-register/react";
import { RefreshCw } from "lucide-react";
import { t } from "../lib/i18n";

// A floating "Update available" pill. With registerType:'prompt' a new deploy no
// longer silently swaps the service worker — instead this appears, and one tap
// activates the new version + reloads. We also poll for a new version every
// 20 min and whenever the app regains focus, so it shows up on its own (no more
// closing/reopening to get the update).
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return;
      const check = () => {
        reg.update().catch(() => {});
      };
      // Check the moment the app opens — including a cold start (no visibility
      // transition fires on initial load) — so the Update pill shows on its own
      // instead of only after a manual pull-to-refresh. Then keep checking on
      // every foreground + a 20-min timer.
      check();
      window.addEventListener("pageshow", check); // covers back/forward + reopen
      setInterval(check, 20 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
    onNeedRefresh() {
      // When a new version is ready and the app ISN'T in front, drop a local
      // notification so you know to update (the in-app pill covers the foreground).
      try {
        if (
          document.visibilityState === "hidden" &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          navigator.serviceWorker.ready.then((reg) =>
            reg.showNotification(t("⬆️ Homebase update ready"), {
              body: t("A new version is ready — open Homebase and tap Update."),
              icon: "/homebase/pwa-192x192.png",
              badge: "/homebase/notification-badge.png",
              tag: "app-update",
            }),
          );
        }
      } catch {
        /* notifications optional */
      }
    },
  });

  const doUpdate = async () => {
    try {
      // reload the moment the new worker takes control (push-sw.js claims it)
      navigator.serviceWorker?.addEventListener("controllerchange", () => window.location.reload(), { once: true });
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
    } catch {
      /* fall through to the hook + hard fallback below */
    }
    updateServiceWorker(true).catch(() => {});
    // last resort: if the SW handshake didn't reload us, force it (the new worker
    // has activated by now, so this lands on the fresh version)
    window.setTimeout(() => window.location.reload(), 2500);
  };

  if (!needRefresh) return null;
  return (
    <button
      onClick={doUpdate}
      className="hb-update-pulse fixed left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-bold transition active:scale-95"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 10px)",
        // Distinct amber — deliberately OUTSIDE the app's blue/teal palette so an
        // update never blends into the finance chrome.
        background: "linear-gradient(150deg,#fbbf24,#f97316)",
        color: "#3a1d02",
        boxShadow: "0 10px 26px -6px rgba(249,115,22,.65)",
      }}
    >
      <RefreshCw size={15} /> {t("Update available — tap to refresh")}
    </button>
  );
}
