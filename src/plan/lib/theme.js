// App.jsx writes theme vars as inline custom properties on <html>. Watch that
// style attribute so shiki/mermaid blocks re-render when the theme changes.
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set();

const observer = new MutationObserver(() => {
  version++;
  for (const l of listeners) l();
});
observer.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["style"],
});

export function useThemeVersion() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

export function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// true when the app chrome is light (e.g. Paper / Solarized Light)
export function isLightTheme() {
  const hex = themeVar("--panel");
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum =
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 128;
}
