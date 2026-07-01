// Web Push sender (shared). Sends a payload to stored push_subscriptions using
// VAPID. Reused by the `notify` function, the Plaid webhook, and the cron jobs.
// VAPID keys come from function secrets (never the repo).

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ginocirino007@gmail.com";
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

// admin = a service-role supabase client. owner: undefined → all devices; a
// person → that person's devices + any "Joint" device.
// deno-lint-ignore no-explicit-any
export async function sendPush(admin: any, payload: PushPayload, owner?: string) {
  let q = admin.from("push_subscriptions").select("endpoint, p256dh, auth");
  if (owner && owner !== "Joint") q = q.in("owner", [owner, "Joint"]);
  const { data: subs } = await q;
  let sent = 0;
  let removed = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        // HIGH urgency = deliver now. Without it push services (Apple/APNs, FCM)
        // treat pushes as low priority and BATCH them until the device next wakes
        // — which is why they arrived in a lump when the app was opened. TTL keeps
        // the push queued for a day if the phone is briefly offline.
        { urgency: "high", TTL: 24 * 60 * 60 },
      );
      sent++;
      // deno-lint-ignore no-explicit-any
    } catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {
        // subscription expired/gone → prune it
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        removed++;
      } else {
        console.error("push send error", code, String(e?.message ?? e).slice(0, 200));
      }
    }
  }
  return { sent, removed, total: (subs ?? []).length };
}
