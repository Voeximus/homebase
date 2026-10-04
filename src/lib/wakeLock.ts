// ── Keep the screen on during a workout ─────────────────────────────────────
// Screen Wake Lock (SPEC §7.1). The browser drops the lock whenever the page is
// hidden, the battery is low or power saver is on, so it is requested again
// every time the page becomes visible. Where the API doesn't exist (iPhone
// before iOS 18.4 in a home-screen app) this does nothing, silently.

import { useEffect } from "react";

/** Hold a screen wake lock while `active` is true; release it when false or on unmount. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || typeof document === "undefined") return;
    if (!("wakeLock" in navigator) || !navigator.wakeLock) return;

    let sentinel: WakeLockSentinel | null = null;
    let pending = false;
    let stopped = false;

    const request = async () => {
      if (stopped || pending || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      pending = true;
      try {
        const s = await navigator.wakeLock.request("screen");
        if (stopped) void s.release().catch(() => {});
        else sentinel = s;
      } catch {
        /* refused (hidden, low battery, power saver) — try again on the next visible */
      } finally {
        pending = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
