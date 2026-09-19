/**
 * Reliable composer → pane delivery over a remote (WebSocket) transport.
 *
 * Two failure modes used to eat messages silently:
 *  - the pane's harness wasn't reading yet (pty spawned, Claude still
 *    booting), so the bytes were consumed by the launching shell or the TUI's
 *    terminal-mode setup and never seen again;
 *  - the write itself failed (socket mid-reconnect, pane already dead) and
 *    every layer swallowed the error while the composer had already cleared.
 *
 * Sends now wait for the broker's per-pane ready signal, run through a
 * per-pane FIFO (two queued messages must never reorder, or land inside each
 * other's paste-then-Enter window), retry failures that provably never left
 * this device, and reject otherwise — so the caller can keep the message
 * visible with a retry affordance instead of losing it.
 */

import { pasteChunks, IMAGE_SETTLE_MS, CHUNK_GAP_MS } from "./imageTokens";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// transport -> { unready: Set<paneId>, everReady: Set<paneId> }, fed by the
// gateway's hello/panes snapshots and the live pane-ready event. Panes a
// broker never reports a ready flag for are simply absent, which reads as
// ready (the pre-signal behavior), so nothing waits on a signal that will
// never come.
const trackers = new WeakMap();

function tracker(transport) {
  let t = trackers.get(transport);
  if (t) return t;
  t = {
    unready: new Set(),
    // pane-ready broadcasts exactly once per pane and pane ids are never
    // reused, so a snapshot built just before that event (broadcast_panes
    // races it) must not resurrect ready:false afterwards.
    everReady: new Set(),
  };
  const ready = (id) => {
    t.unready.delete(id);
    t.everReady.add(id);
  };
  // hello/panes carry the full pane list — reconcile, don't accumulate, so a
  // pane that exited while this device was asleep can't stay "unready" and
  // stall sends for the timeout on every message.
  const fold = (panes) => {
    if (!Array.isArray(panes)) return;
    const unready = new Set();
    for (const p of panes) {
      if (p.ready === false && !t.everReady.has(p.id)) unready.add(p.id);
      else if (p.ready !== false) t.everReady.add(p.id);
    }
    t.unready = unready;
  };
  fold(transport.state?.hello?.panes);
  transport.listen("hello", ({ payload }) => fold(payload.panes));
  transport.listen("panes", ({ payload }) => fold(payload.panes));
  transport.listen("pane-ready", ({ payload }) => ready(payload.id));
  // an exiting pane can never become ready; release any held send and let
  // the write itself fail with a real "no such pane"
  transport.listen("pane-exit", ({ payload }) => ready(payload.id));
  // Fail open when the picture may be wrong: a lagged event stream (resync)
  // can have dropped the once-only pane-ready, and a broker restart voids
  // every pane id we were tracking. Sending immediately is the old behavior;
  // stalling ready panes for 20s per message is strictly worse.
  transport.listen("resync", () => t.unready.clear());
  transport.listen("broker-lost", () => t.unready.clear());
  trackers.set(transport, t);
  return t;
}

/** Attach the readiness tracker the moment a transport exists. Sends create
 *  it lazily too, but by then the pane-ready / panes events that precede the
 *  first send would have been missed — and pane-ready never repeats. */
export function trackReadiness(transport) {
  tracker(transport);
}

/** Resolve once the pane's harness is reading input (or after a generous
 *  timeout — past it, sending anyway beats holding the message hostage; the
 *  broker's own boot-grace backstop marks panes ready well before this). */
async function waitForReady(transport, id, timeoutMs = 20000) {
  const t = tracker(transport);
  const deadline = Date.now() + timeoutMs;
  while (t.unready.has(id) && Date.now() < deadline) await sleep(250);
}

// Failures where the frame provably never left this device, so a resend
// cannot double-deliver. "disconnected" (socket died with the request in
// flight) and timeouts are deliberately NOT here: the write may have landed
// and a blind retry would duplicate it — those surface to the user instead.
const NEVER_SENT = /not connected|broker not connected/i;

/** Errors where the write may have landed anyway — the reply was lost, not
 *  necessarily the message. The retry affordance words itself accordingly. */
export const isAmbiguousSendError = (err) =>
  /disconnected|timed out/i.test(String(err?.message ?? err));

/** write_pane with the gateway's ack (the broker reports the write's real
 *  outcome) and retries for errors thrown before anything hit the wire. */
export async function writeAcked(transport, id, data, extra) {
  const delays = [400, 800, 1600, 3200];
  for (let i = 0; ; i++) {
    try {
      return await transport.invoke("write_pane", { id, data, ...extra });
    } catch (err) {
      if (i >= delays.length || !NEVER_SENT.test(String(err?.message ?? err))) {
        throw err;
      }
      await sleep(delays[i]);
    }
  }
}

// Per-pane FIFO: transport -> Map<paneId, tail promise>. Every send chains
// behind the previous one to the same pane, including the pty path's delayed
// Enters — otherwise message B's paste can land inside message A's
// paste-to-Enter window and the TUI submits "A B" as one prompt.
const queues = new WeakMap();

function enqueue(transport, paneId, task) {
  let byPane = queues.get(transport);
  if (!byPane) {
    byPane = new Map();
    queues.set(transport, byPane);
  }
  const prev = byPane.get(paneId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  byPane.set(paneId, run);
  return run;
}

/**
 * Composer text into a pane. Headless (kind "chat") panes take raw text —
 * early input queues in `claude -p`'s stdin. A pty pane needs the bracketed
 * paste plus delayed Enter the desktop uses (the TUI coalesces an Enter that
 * arrives in the same chunk as the paste into a newline instead of a submit)
 * — and must first wait for the harness to actually be reading.
 *
 * Returns a promise that rejects only when the message (probably) did not
 * arrive; the caller keeps the echo alive and offers a retry, worded by
 * isAmbiguousSendError.
 */
export function sendToPane(transport, pane, text) {
  if (pane.kind === "chat") {
    return enqueue(transport, pane.paneId, () =>
      writeAcked(transport, pane.paneId, text),
    );
  }
  return enqueue(transport, pane.paneId, async () => {
    await waitForReady(transport, pane.paneId);
    // one paste per image path (see imageTokens.js), in order
    const chunks = pasteChunks(text);
    for (const [i, c] of chunks.entries()) {
      await writeAcked(transport, pane.paneId, `\x1b[200~${c.text}\x1b[201~`);
      if (c.image) await sleep(IMAGE_SETTLE_MS);
      else if (i < chunks.length - 1) await sleep(CHUNK_GAP_MS);
    }
    // Two Enters for ConPTY chunking (see ptyPaste.js), inside the queue so
    // the next message can't interleave. Their failure is not message loss —
    // the text is in the input box and ChatView's submit guard re-Enters —
    // so plain best-effort writes, not the acked retry ladder.
    const submit = () =>
      transport.invoke("write_pane", { id: pane.paneId, data: "\r" }).catch(() => {});
    await sleep(450);
    submit();
    await sleep(850);
    submit();
  });
}
