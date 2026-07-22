import { invoke } from "@tauri-apps/api/core";

const IS_WINDOWS = navigator.userAgent.includes("Windows");

/**
 * Paste text into a Claude pane's pty and submit it.
 *
 * The Enter must arrive after the TUI has finished processing the bracketed
 * paste, or it's coalesced into the paste and becomes a newline inside the
 * input box instead of a submit. 150ms is enough on macOS; ConPTY chunking
 * makes Windows need longer, so it gets a bigger delay plus one retry Enter —
 * if the first Enter did submit, the retry hits an empty prompt (no-op); if
 * it was swallowed as a newline, the retry submits.
 */
export function pasteAndSubmit(id, text) {
  invoke("write_pane", { id, data: `\x1b[200~${text}\x1b[201~` }).catch(() => {});
  const submit = () => invoke("write_pane", { id, data: "\r" }).catch(() => {});
  if (IS_WINDOWS) {
    setTimeout(submit, 450);
    setTimeout(submit, 1300);
  } else {
    setTimeout(submit, 150);
  }
}
