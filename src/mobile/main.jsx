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
//
// It also has to notice when the workstation has been updated. A phone keeps
// this app open for days, so without a check it goes on running whatever code
// it loaded first and every fix on the desktop looks like it did nothing. The
// app is told, and offers the reload rather than yanking the page out from
// under someone mid-message.
// isSecureContext, not a protocol check: it also covers localhost, which
// browsers treat as secure and which is how this gets tested.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const announce = (worker) => {
          worker?.addEventListener("statechange", () => {
            // `controller` means this is a replacement, not the first install
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent("agentbench:update-ready"));
            }
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent("agentbench:update-ready"));
        }
        announce(reg.installing);
        reg.addEventListener("updatefound", () => announce(reg.installing));
        const check = () => reg.update().catch(() => {});
        // on returning to the app, and hourly while it is open
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
        setInterval(check, 60 * 60 * 1000);
      })
      .catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
