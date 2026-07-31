import React from "react";
import ReactDOM from "react-dom/client";
import MobileApp from "./MobileApp";
import "../styles.css";
import "./mobile.css";

// Keyboard-aware height. `interactive-widget=resizes-content` covers modern
// Chrome, but iOS Safari still overlays the keyboard and leaves 100dvh
// measuring the full screen — the black band under the composer. visualViewport
// reports what is actually visible, so the shell tracks it directly.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    // Only the keyboard's overlap matters; ignore pinch-zoom (scale != 1),
    // where a shrunken visual viewport is the user zooming in, not a keyboard.
    const overlap = vv.scale > 1.01 ? 0 : window.innerHeight - vv.height - vv.offsetTop;
    document.documentElement.style.setProperty(
      "--mob-keyboard",
      `${Math.max(0, Math.round(overlap))}px`,
    );
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
}
trackViewport();

// The service worker caches only the public shell — it contains no data, so a
// revoked device just finds every call returning 401 and lands back on pairing.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
