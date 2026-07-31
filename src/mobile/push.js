/**
 * Push notification subscription, per machine.
 *
 * Each gateway signs with its own VAPID key, so a phone holds one subscription
 * per paired machine and the browser binds each to that machine's key. The
 * gateway stores the subscription; nothing is shared between machines.
 */

/** The browser needs the key as raw bytes, not base64url. */
function decodeKey(base64url) {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function permissionState() {
  if (!pushSupported()) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

/**
 * Whether this device is actually subscribed to a machine.
 *
 * Permission alone does not mean subscribed — the browser can hold the
 * permission with no subscription at all, and a subscription can belong to a
 * different machine's key. Both have to line up.
 */
export async function isSubscribed(gateway) {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const { publicKey } = await api(gateway, "/api/push/key");
    const current = new Uint8Array(sub.options?.applicationServerKey ?? []);
    const wanted = decodeKey(publicKey);
    return current.length === wanted.length && current.every((b, i) => b === wanted[i]);
  } catch {
    return false;
  }
}

async function api(gateway, path, body) {
  const res = await fetch(`${gateway.url.replace(/\/+$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `${path} failed (${res.status})`);
  }
  return res.json();
}

/**
 * Subscribe this device for notifications from one machine. Safe to call
 * again: an existing subscription is reused, and the gateway replaces rather
 * than duplicates.
 */
export async function enablePush(gateway) {
  if (!pushSupported()) throw new Error("This browser cannot receive notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site in your browser settings."
        : "Notification permission was dismissed.",
    );
  }
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api(gateway, "/api/push/key");

  let sub = await reg.pushManager.getSubscription();
  // A subscription made against a different key (another machine, or a
  // regenerated one) cannot be reused — drop it and make a fresh one.
  if (sub) {
    const current = new Uint8Array(sub.options?.applicationServerKey ?? []);
    const wanted = decodeKey(publicKey);
    const same =
      current.length === wanted.length && current.every((b, i) => b === wanted[i]);
    if (!same) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    });
  }
  await api(gateway, "/api/push/subscribe", { subscription: sub.toJSON() });
  return sub.endpoint;
}

export async function disablePush(gateway) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api(gateway, "/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}

/** Ask the machine to send one now, so the path can be proven end to end. */
export async function testPush(gateway) {
  return api(gateway, "/api/push/test", {});
}
