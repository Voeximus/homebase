/* Web Push handlers, importScripts'd into the workbox-generated service worker.
   Kept as a plain public file (no bundler) so it can be imported by the SW. */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { body: event.data && event.data.text ? event.data.text() : "" };
  }
  const title = data.title || "Homebase";
  const options = {
    body: data.body || "",
    icon: data.icon || "/homebase/pwa-192x192.png",
    badge: data.badge || "/homebase/notification-badge.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/homebase/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // SECURITY: only ever open an in-scope (same-origin) URL, so a notification can
  // never deep-link the device to an external/attacker page.
  const raw = (event.notification.data && event.notification.data.url) || self.registration.scope;
  const url = typeof raw === "string" && raw.indexOf(self.registration.scope) === 0 ? raw : self.registration.scope;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          try {
            await c.navigate(url);
          } catch (_e) {
            /* navigate can throw cross-origin; focus is enough */
          }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
