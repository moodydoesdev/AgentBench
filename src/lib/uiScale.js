// UI density via webview zoom. The stylesheet is px-based throughout, so a
// single zoom factor scales the entire app — terminals included — without a
// rem/media-query rework.
import { getCurrentWebview } from "@tauri-apps/api/webview";

// settings.uiScale: 0 = auto (compact on small screens), else a fixed factor.
export const SCALE_STEPS = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];

export function resolveUiScale(uiScale) {
  if (uiScale) return uiScale;
  // MacBook-class panels report ~1470–1512 CSS px wide; wide/external
  // displays 1600+. Below the line the layout is cramped at 1:1.
  return window.screen.width < 1600 ? 0.85 : 1;
}

export function applyUiScale(uiScale) {
  try {
    getCurrentWebview()
      .setZoom(resolveUiScale(uiScale))
      .catch(() => {});
  } catch {
    // outside Tauri (plan test harness)
  }
}
