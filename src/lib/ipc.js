/**
 * The one place that knows whether this bundle is running inside the Tauri
 * webview or in a plain browser served by the gateway.
 *
 * Desktop: every export delegates straight to the Tauri API — behavior is
 * byte-for-byte what importing @tauri-apps/* directly used to be.
 *
 * Web: `invoke`/`listen` ride the WebSocket transport that WebGate installs
 * after login (the same wsTransport the phone PWA uses), cross-window `emit`
 * becomes an in-page event bus (there is only one window), and the OS-shaped
 * helpers (open a URL, notify) map to their browser equivalents or degrade to
 * no-ops.
 *
 * Importing @tauri-apps/api in a browser is safe — its modules only touch
 * `__TAURI_INTERNALS__` when called — so the branch happens per call, not at
 * import time.
 */
import {
  invoke as tauriInvoke,
  convertFileSrc as tauriConvertFileSrc,
} from "@tauri-apps/api/core";
import { listen as tauriListen, emit as tauriEmit } from "@tauri-apps/api/event";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Installed by WebGate once login succeeds. Module-level on purpose: the shim
// has to serve files (autoTheme, ptyPaste) that live outside the React tree.
let webTransport = null;
export function setWebTransport(t) {
  webTransport = t;
}
export function getWebTransport() {
  return webTransport;
}

// In-page bus standing in for Tauri's cross-window events (settings-changed,
// benches-changed…) — in the browser the "settings window" is a modal in the
// same document, so local delivery is exactly right.
const bus = new Map(); // name -> Set<cb>
function busListen(name, cb) {
  if (!bus.has(name)) bus.set(name, new Set());
  bus.get(name).add(cb);
  return () => bus.get(name)?.delete(cb);
}
function busEmit(name, payload) {
  const set = bus.get(name);
  if (set) for (const cb of [...set]) cb({ payload });
}

export function invoke(cmd, args) {
  if (isTauri) return tauriInvoke(cmd, args);
  if (webTransport) return webTransport.invoke(cmd, args);
  return Promise.reject(new Error(`no backend for ${cmd}`));
}

/** Mirrors Tauri's listen(): resolves to an unsubscribe function. On the web
 * an event may come from the gateway socket or from the local bus, so both
 * are subscribed. */
export function listen(ev, cb) {
  if (isTauri) return tauriListen(ev, cb);
  const offBus = busListen(ev, cb);
  const offWs = webTransport ? webTransport.listen(ev, cb) : Promise.resolve(() => {});
  return Promise.resolve(offWs).then((off) => () => {
    offBus();
    off?.();
  });
}

export function emit(ev, payload) {
  if (isTauri) return tauriEmit(ev, payload);
  busEmit(ev, payload);
  return Promise.resolve();
}

export function convertFileSrc(path, protocol) {
  if (isTauri) return tauriConvertFileSrc(path, protocol);
  // No asset protocol in a browser; callers that need file bytes go through
  // read_image_data_url / read_file_base64 instead.
  return path;
}

/** plugin-opener equivalents. */
export async function openUrl(url) {
  if (isTauri) {
    const { openUrl: real } = await import("@tauri-apps/plugin-opener");
    return real(url);
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function openPath(path) {
  if (isTauri) {
    const { openPath: real } = await import("@tauri-apps/plugin-opener");
    return real(path);
  }
  // A browser tab cannot open Finder on the workstation; refuse quietly.
  throw new Error("not available in the browser");
}

export async function revealItemInDir(path) {
  if (isTauri) {
    const { revealItemInDir: real } = await import("@tauri-apps/plugin-opener");
    return real(path);
  }
  throw new Error("not available in the browser");
}

/** plugin-notification equivalents, mapped to the Notification API. */
export async function isPermissionGranted() {
  if (isTauri) {
    const { isPermissionGranted: real } = await import(
      "@tauri-apps/plugin-notification"
    );
    return real();
  }
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export async function requestPermission() {
  if (isTauri) {
    const { requestPermission: real } = await import(
      "@tauri-apps/plugin-notification"
    );
    return real();
  }
  if (typeof Notification === "undefined") return "denied";
  return Notification.requestPermission();
}

export async function sendNotification(opts) {
  if (isTauri) {
    const { sendNotification: real } = await import(
      "@tauri-apps/plugin-notification"
    );
    return real(opts);
  }
  try {
    const { title, body } = typeof opts === "string" ? { title: opts } : opts;
    new Notification(title, { body });
  } catch {
    // notifications are a nicety; never let them throw into app code
  }
}
