// Phone-local theme choice. Same palettes as the desktop (themes.js), but its
// own storage key: the phone pairs with many machines, so it cannot inherit
// any one workstation's settings object.
import { getTheme } from "../themes";

const STORE_KEY = "agentbench.mobile.theme";

export function loadThemeId() {
  return localStorage.getItem(STORE_KEY) ?? "midnight";
}

export function saveThemeId(id) {
  localStorage.setItem(STORE_KEY, id);
}

// Inline custom properties on <html> override the :root fallbacks in
// styles.css — the same mechanism the desktop's App.jsx uses, including the
// shadcn tokens the shared chat markup reads.
export function applyTheme(id) {
  const vars = getTheme(id).vars;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.setProperty("--background", vars["--panel"]);
  root.style.setProperty("--popover", vars["--panel-head"]);
  root.style.setProperty("--popover-foreground", vars["--text"]);
  root.style.setProperty("--accent", vars["--border"]);
  root.style.setProperty("--accent-foreground", vars["--text"]);
  root.style.setProperty("--muted-foreground", vars["--text-dim"]);
  root.style.setProperty("--foreground", vars["--text"]);
  root.style.setProperty("--shadcn-border", `rgba(${vars["--hilite"]}, 0.1)`);
  // The OS chrome (Android status bar, the installed app's title area) follows
  // theme-color, so a light theme doesn't sit under a black bar.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", vars["--bg"]);
}
