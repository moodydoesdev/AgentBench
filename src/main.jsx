import { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

// One bundle serves every window; ?window=settings selects the settings UI.
// Both views are lazy so each webview only fetches its own chunk — the
// settings window must not pay for xterm/wterm/cmdk in the app chunk.
const view = new URLSearchParams(window.location.search).get("window");

const App = lazy(() => import("./App"));
const SettingsWindow = lazy(() => import("./SettingsWindow"));

// dev-only smoke test for the plan renderer (runs outside Tauri)
const PlanTestHarness =
  import.meta.env.DEV && view === "plan-test"
    ? lazy(() => import("./plan/PlanTestHarness.jsx"))
    : null;

ReactDOM.createRoot(document.getElementById("root")).render(
  <Suspense fallback={null}>
    {PlanTestHarness ? (
      <PlanTestHarness />
    ) : view === "settings" ? (
      <SettingsWindow />
    ) : (
      <App />
    )}
  </Suspense>,
);
