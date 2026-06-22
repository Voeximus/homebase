// Web Push (client). Subscribes the installed PWA to push and stores the
// subscription in Supabase so the notify edge function can reach this device.
//
// The VAPID PUBLIC key is safe to ship (it's the public half); the private key
// lives only in the notify function's secrets. iOS only delivers push to a PWA
// installed to the home screen (16.4+), so this no-ops gracefully elsewhere.

import { supabase } from "./supabase";

const VAPID_PUBLIC =
  "BMXIR0Yqx09oqrl65SYVSvJT0Xu3jUme7pvGAB2Rbdg9f46U1VKDxAlioqRe9mdcgPxe8bcTuuxQbV9yHUHhDSY";

function ownerOfDevice(): string {
  const o = localStorage.getItem("hb-owner");
  return o === "gino" ? "Gino" : o === "xinyan" ? "Xinyan" : "Joint";
}

export type PushStatus = "unsupported" | "default" | "denied" | "subscribed";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      return sub ? "subscribed" : "default";
    } catch {
      return "default";
    }
  }
  return "default";
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Request permission + subscribe + store the subscription. Returns the new status. */
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "default";

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as BufferSource,
    });
  }
  const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      owner: ownerOfDevice(),
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
    { onConflict: "endpoint" },
  );
  if (error) {
    console.error("push subscribe save", error);
    return "default";
  }
  return "subscribed";
}

/** Unsubscribe this device + drop its stored subscription. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
  } catch (e) {
    console.error("push unsubscribe", e);
  }
}
