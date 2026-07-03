import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";

// Checks GitHub releases (latest.json) for a newer signed build. If found,
// asks the user, downloads + installs in place, then offers a relaunch.
// Fails silently — an offline user should never see an updater error.
export async function checkForUpdates() {
  try {
    const update = await check();
    if (!update) return;

    const wantsIt = await ask(
      `AgentBench ${update.version} is available.\n\n${update.body ?? ""}`.trim(),
      { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Later" },
    );
    if (!wantsIt) return;

    await update.downloadAndInstall();

    const restartNow = await ask(
      "Update installed. Restart now? Running agents will resume via claude --resume.",
      { title: "Restart to update", okLabel: "Restart", cancelLabel: "Later" },
    );
    if (restartNow) await relaunch();
  } catch (e) {
    console.warn("update check failed:", e);
  }
}
