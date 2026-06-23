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

  if (!needRefresh) return null;
  return (
    <button
      onClick={() => updateServiceWorker(true)}
      className="fixed left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg transition active:scale-95"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 10px)",
        background: "linear-gradient(150deg,#10b981,#06b6d4)",
        boxShadow: "0 8px 24px -8px rgba(6,182,212,.55)",
      }}
    >
      <RefreshCw size={15} /> {t("Update available — tap to refresh")}
    </button>
  );
}
