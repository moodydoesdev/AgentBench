import React from "react";
import ReactDOM from "react-dom/client";
import MobileApp from "./MobileApp";
import { applyTheme, loadThemeId } from "./theme";
import "../styles.css";
import "./mobile.css";

// Before the first paint, so a saved non-default theme never flashes the
// :root fallback palette.
applyTheme(loadThemeId());

// Keyboard-aware height. `interactive-widget=resizes-content` covers modern
// Chrome, but iOS Safari still overlays the keyboard and leaves 100dvh
// measuring the full screen — the black band under the composer. visualViewport
// reports what is actually visible, so the shell tracks it directly.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    // Ignore pinch-zoom (scale != 1), where a shrunken visual viewport is the
    // user zooming in, not a keyboard.
    if (vv.scale > 1.01) return;
    // The shell height comes straight from vv.height — the one number that is
    // "what's actually visible" on both Android (resizes-content) and iOS
    // (overlay keyboard). Deriving it as innerHeight - vv.height raced: with
    // resizes-content both values change on keyboard close but not in the same
    // event, and a stale difference stuck the shell at keyboard-up height.
    document.documentElement.style.setProperty(
      "--mob-vh",
      `${Math.round(vv.height)}px`,
    );
    // Overlap still drives the composer's safe-area padding: nonzero only on
    // overlay keyboards (iOS), ~0 on Android where the viewport itself shrinks.
    const overlap = window.innerHeight - vv.height - vv.offsetTop;
    document.documentElement.style.setProperty(
      "--mob-keyboard",
      `${Math.max(0, Math.round(overlap))}px`,
    );
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  // Layout-viewport resizes can land after the last visualViewport event;
  // recompute so the final state is always consistent.
  window.addEventListener("resize", apply);
  // Browsers can still scroll a clipped document (focus-scroll, scrollIntoView
  // bubbling to the viewport). The shell is anchored to the top of the
  // document, so any document scroll shows as a dead band — undo it.
  window.addEventListener("scroll", () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  });
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
