import { invoke } from "@tauri-apps/api/core";
import { pasteChunks, IMAGE_SETTLE_MS, CHUNK_GAP_MS } from "./imageTokens";

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
// Guard against a rapid identical resend firing twice — the Windows
// double-Enter retry, a stray re-render, or a mashed key could otherwise
// submit the same command (notably /compact) more than once.
const lastSend = new Map(); // id -> { text, at }
const DEDUPE_MS = 2500;

export function pasteAndSubmit(id, text) {
  const prev = lastSend.get(id);
  const now = performance.now();
  if (prev && prev.text === text && now - prev.at < DEDUPE_MS) return;
  lastSend.set(id, { text, at: now });

  const submit = () => invoke("write_pane", { id, data: "\r" }).catch(() => {});
  const chunks = pasteChunks(text);
  (async () => {
    // one paste per image path (see imageTokens.js), in order
    for (const [i, c] of chunks.entries()) {
      await invoke("write_pane", { id, data: `\x1b[200~${c.text}\x1b[201~` }).catch(() => {});
      if (c.image) await sleep(IMAGE_SETTLE_MS);
      else if (i < chunks.length - 1) await sleep(CHUNK_GAP_MS);
    }
    if (IS_WINDOWS) {
      setTimeout(submit, 450);
      setTimeout(submit, 1300);
    } else {
      setTimeout(submit, 150);
    }
  })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
