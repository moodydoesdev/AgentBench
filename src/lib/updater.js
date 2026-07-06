import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

// Checks GitHub releases (latest.json) for a newer signed build. If found,
// asks the user, downloads + installs in place, then offers a relaunch.
// Auto-check (launch) fails silently — an offline user should never see an
// updater error. Manual checks (Settings button) throw instead, so the UI
// can show what happened. Returns "none" | "later" | "installed".
export async function checkForUpdates({ manual = false } = {}) {
  try {
    const update = await check();
    if (!update) return "none";

    const wantsIt = await ask(
      `AgentBench ${update.version} is available.\n\n${update.body ?? ""}`.trim(),
      { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Later" },
    );
    if (!wantsIt) return "later";

    // Kill the broker before installing so the old binary isn't locked
    // (Windows) and the new one starts cleanly on relaunch.
    await invoke("shutdown_broker").catch(() => {});

    await update.downloadAndInstall();

    const restartNow = await ask(
      "Update installed. Restart now? Running agents will resume via claude --resume.",
      { title: "Restart to update", okLabel: "Restart", cancelLabel: "Later" },
    );
    if (restartNow) await relaunch();
    return "installed";
  } catch (e) {
    console.warn("update check failed:", e);
    if (manual) throw e;
    return "none";
  }
}
