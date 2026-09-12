import { useState } from "react";
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

  const [busy, setBusy] = useState(false);

  // The graceful path (tell the waiting worker to take over, reload when it does)
  // fails silently in two different ways: the worker never reaches `waiting`, or
  // it does and the reload is still answered from the old precache. Both look the
  // same from the outside — a flicker and no new version. So the button ALWAYS
  // ends in a hard reset: drop every cache, unregister the worker, reload. That
  // costs one re-download of the shell and cannot get stuck. Nothing durable
  // lives in the Cache API — data is Supabase + localStorage — so it's safe.
  const nuke = async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* private mode / no cache API — reload anyway */
    }
    try {
      const regs = await navigator.serviceWorker?.getRegistrations();
      await Promise.all((regs ?? []).map((r) => r.unregister()));
    } catch {
      /* ignore */
    }
    // cache-busting query so the navigation can't be answered from HTTP cache
    const u = new URL(window.location.href);
    u.searchParams.set("v", Date.now().toString(36));
    window.location.replace(u.toString());
  };

  const doUpdate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // reload the moment the new worker takes control (push-sw.js claims it)
      navigator.serviceWorker?.addEventListener("controllerchange", () => window.location.reload(), { once: true });
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
    } catch {
      /* fall through */
    }
    updateServiceWorker(true).catch(() => {});
    // If the handshake hasn't navigated us away by now, it isn't going to.
    window.setTimeout(() => void nuke(), 3000);
  };

  if (!needRefresh) return null;
  return (
    <button
      onClick={doUpdate}
      disabled={busy}
      aria-live="polite"
      className="hb-update-pulse fixed left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-bold transition active:scale-95"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 10px)",
        // Distinct amber — deliberately OUTSIDE the app's blue/teal palette so an
        // update never blends into the finance chrome.
        background: "linear-gradient(150deg,#fbbf24,#f97316)",
        color: "#3a1d02",
        boxShadow: "0 10px 26px -6px rgba(249,115,22,.65)",
        opacity: busy ? 0.75 : 1,
      }}
    >
      <RefreshCw size={15} className={busy ? "animate-spin" : undefined} />
      {busy ? t("Updating…") : t("Update available — tap to refresh")}
    </button>
  );
}
