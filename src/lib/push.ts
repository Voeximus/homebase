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

// Turning the toggle OFF unsubscribes the browser but can't revoke the OS
// permission, so "permission granted + no subscription" is ambiguous: it means
// either "the user switched this off" or "it broke". This flag records the
// intent, so the self-heal below can repair the second case without ever
// undoing the first.
const OFF_KEY = "hb-push-off";
const optedOut = () => localStorage.getItem(OFF_KEY) === "1";

// "save-failed" is NOT "off": the browser subscribed fine and only the row write
// failed. Collapsing it into "default" told the user "Off — tap to get alerts"
// after a tap that had already granted permission and subscribed, so the only
// feedback for a failed enable was a toggle springing back with no explanation.
export type PushStatus = "unsupported" | "default" | "denied" | "subscribed" | "save-failed";

/** What the SERVER says about this device's row, which is the half that decides
 *  whether a push is deliverable. Three-valued on purpose: "missing" means the
 *  server was reached and had no row for this endpoint, "unknown" means we never
 *  got to ask. Folding those together would let an offline phone with a perfectly
 *  good row be told it isn't registered. */
export type PushSyncResult = "confirmed" | "missing" | "unknown";

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
  // An explicit OFF outranks a surviving browser subscription. disablePush() sets
  // the flag BEFORE it unsubscribes, so a throw in between leaves the browser
  // subscribed while the row is already deleted — asking only the browser there
  // renders "On" for a device that is switched off and self-heal-blocked.
  if (optedOut()) return "default";
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

/** Does this browser subscription still speak the CURRENT VAPID key? A push
 *  subscription is bound to the applicationServerKey it was created with. Rotate
 *  the key pair and every existing subscription keeps looking perfectly healthy to
 *  the browser while the sender gets a 403 forever — and 403 is not 404/410, so the
 *  row is never pruned and never repaired. Comparing the bytes is the only way to
 *  see it from this side. */
function keyMatchesCurrentVapid(sub: PushSubscription): boolean {
  const raw = sub.options?.applicationServerKey;
  if (!raw) return true; // browser doesn't expose it — assume fine, don't churn
  const have = new Uint8Array(raw);
  const want = urlBase64ToUint8Array(VAPID_PUBLIC);
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
  return true;
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

  // Clear the opt-out HERE, at the tap — the flag records intent (see OFF_KEY),
  // and the intent is expressed by opting in, not by a network round-trip landing.
  // It used to be cleared only on the success path below, so an enable that got as
  // far as a live browser subscription but failed the upsert left hb-push-off="1"
  // set forever: syncPushSubscription() early-returned on every subsequent open and
  // the device could never self-heal. Clearing early is safe in the other direction
  // because only disablePush() ever sets the flag, and the sync never subscribes
  // while it is set.
  localStorage.removeItem(OFF_KEY);

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
    return "save-failed"; // subscribed in the browser, unreachable from the server
  }
  return "subscribed";
}

/** Re-assert this device's stored subscription. Safe to call on every open.
 *
 *  WHY THIS EXISTS. The browser's push subscription and the `push_subscriptions`
 *  row are two independent facts, and they drift apart silently:
 *    • the sender PRUNES the row on a 404/410 from the push service (correct — the
 *      endpoint really is dead), but nothing ever writes it back;
 *    • reinstalling the PWA mints a brand-new endpoint and abandons the old row;
 *    • the upsert in enablePush() can simply fail (offline, expired session).
 *  In every one of those cases the browser still reports a subscription, so
 *  getPushStatus() — which only ever asked the BROWSER — kept showing "On" while
 *  the row that makes a push deliverable was gone. That is exactly how this
 *  household ended up with a healthy notify function, a cron job succeeding every
 *  night, and ZERO registered devices, with no symptom anywhere in the UI.
 *
 *  The row is the deliverable half, so the app has to re-assert it rather than
 *  trust that it was written once. One idempotent upsert per open, keyed on the
 *  endpoint.
 *
 *  It also REPORTS what it found, because the upsert's own error can't tell an
 *  unreachable server from a server that says there is no row — and only the
 *  second of those is the failure worth alarming a user about. The early returns
 *  below are "unknown", never "missing": they never asked the server at all. */
export async function syncPushSubscription(): Promise<PushSyncResult> {
  if (!pushSupported() || Notification.permission !== "granted") return "unknown";
  if (optedOut()) return "unknown"; // switched off on purpose — leave it off
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // A subscription signed with a retired VAPID key can never be delivered to.
    // Trade it in for one the current key can reach — permission is already
    // granted, so this is silent.
    if (sub && !keyMatchesCurrentVapid(sub)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
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
    if (error) console.error("push resync", error);
    // Read the row back instead of trusting the write. This SELECT is the only
    // place anything on the client ever looks at push_subscriptions, and it is what
    // separates the two ways an upsert can fail: a server we couldn't reach answers
    // with an error here too ("unknown"), while a server we DID reach answering "no
    // row for this endpoint" is exactly the 44-night state ("missing"). Run it even
    // when the upsert errored — that's the case it exists to diagnose.
    const { data, error: readErr } = await supabase
      .from("push_subscriptions")
      .select("endpoint")
      .eq("endpoint", sub.endpoint)
      .maybeSingle();
    if (readErr) {
      console.error("push resync verify", readErr);
      return "unknown";
    }
    return data ? "confirmed" : "missing";
  } catch (e) {
    console.error("push resync", e);
    return "unknown";
  }
}

/** Unsubscribe this device + drop its stored subscription. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  localStorage.setItem(OFF_KEY, "1");
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
