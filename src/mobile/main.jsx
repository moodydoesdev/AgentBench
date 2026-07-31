import React from "react";
import ReactDOM from "react-dom/client";
import MobileApp from "./MobileApp";
import "../styles.css";
import "./mobile.css";

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
