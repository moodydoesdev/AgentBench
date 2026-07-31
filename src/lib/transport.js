/**
 * The seam that lets one set of chat components run in two places.
 *
 * On the desktop a component talks to the Rust backend through Tauri's
 * invoke/listen. On a phone it talks to a gateway over a WebSocket. Both look
 * identical from the component's side, so ChatView, ToolCard and the record
 * reducer need no knowledge of which one they are attached to — and a mobile
 * shell can hold several transports at once, one per paired machine.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

// Tauri command name -> broker op. The gateway speaks the broker's protocol,
// not our command names, so the mapping that lib.rs performs in Rust happens
// here for the WebSocket path.
const OP_FOR = {
  create_pane: (a) => ({
    op: "create",
    cwd: a.cwd,
    cols: a.cols ?? 100,
    rows: a.rows ?? 30,
    resume: a.resume ?? null,
    harness: a.harness ?? null,
    shell: a.shell ?? null,
  }),
  create_chat_pane: (a) => ({ op: "create-chat", cwd: a.cwd, resume: a.resume ?? null }),
  kill_pane: (a) => ({ op: "kill", id: a.id }),
  write_pane: (a) => ({ op: "write", id: a.id, data: a.data, answers: a.answers }),
  watch_transcript: (a) => ({ op: "watch", id: a.id }),
  unwatch_transcript: (a) => ({ op: "unwatch", id: a.id }),
  interrupt_pane: (a) => ({ op: "interrupt", id: a.id, resubmit: !!a.resubmit }),
  resize_pane: (a) => ({ op: "resize", id: a.id, cols: a.cols, rows: a.rows }),
  list_panes: () => ({ op: "list" }),
  saved_panes: () => ({ op: "saved" }),
};

// Requests the gateway answers itself, without the broker's op vocabulary.
const FS_FOR = {
  list_sessions: (a) => ({ fs: "list_sessions", project: a.project }),
  list_plans: (a) => ({ fs: "list_plans", project: a.project }),
  list_slash_commands: (a) => ({ fs: "list_slash_commands", project: a.project }),
  read_plan: (a) => ({ fs: "read_plan", path: a.path }),
  list_projects: () => ({ fs: "list_projects" }),
  // Scrollback for one pane, fetched when a log is opened rather than shipped
  // with every reconnect.
  pane_buffer: (a) => ({ fs: "pane_buffer", id: a.id, limit: a.limit }),
  // Same contract as the desktop command: an image goes to a temp file and
  // Claude is handed the path.
  save_pasted_image: (a) => ({ fs: "save_image", dataUrl: a.dataUrl }),
};

/** Desktop: straight through to the Tauri backend. */
export function tauriTransport() {
  return {
    kind: "tauri",
    invoke: (cmd, args) => tauriInvoke(cmd, args),
    listen: (ev, cb) => tauriListen(ev, cb),
    close: () => {},
  };
}

/**
 * Phone: one gateway, one socket. Reconnects on its own — a phone drops the
 * connection every time the screen locks, so reconnection is the normal case
 * rather than an error path. The `hello` frame that the gateway sends on every
 * connect carries the state needed to resume without gaps.
 */
export function wsTransport({ url, token, onStatus }) {
  const base = url.replace(/\/+$/, "");
  const wsUrl =
    base.replace(/^http/, "ws") + `/api/ws?token=${encodeURIComponent(token)}`;

  let socket = null;
  let closed = false;
  let seq = 1;
  let retry = 0;
  let retryTimer = 0;
  const pending = new Map(); // id_ -> { resolve, reject }
  const subs = new Map(); // event name -> Set<cb>
  const state = { connected: false, hello: null, error: null };

  const emit = (name, payload) => {
    const set = subs.get(name);
    if (set) for (const cb of set) cb({ payload });
  };

  const setStatus = (patch) => {
    Object.assign(state, patch);
    onStatus?.({ ...state });
  };

  const connect = () => {
    if (closed) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      setStatus({ connected: false, error: String(err) });
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      retry = 0;
      setStatus({ connected: true, error: null });
    };

    ws.onmessage = (msg) => {
      let frame;
      try {
        frame = JSON.parse(msg.data);
      } catch {
        return;
      }
      // Replies carry the id we chose; everything else is a broker event.
      if (frame.id_ != null) {
        const waiter = pending.get(frame.id_);
        if (!waiter) return;
        pending.delete(frame.id_);
        if (frame.error) waiter.reject(new Error(frame.error));
        else waiter.resolve(frame.result);
        return;
      }
      if (frame.ev === "hello") setStatus({ hello: frame });
      if (frame.ev) emit(frame.ev, frame);
    };

    ws.onclose = () => {
      // Fail everything in flight rather than let callers hang on a reply
      // that can no longer arrive.
      for (const [, waiter] of pending) waiter.reject(new Error("disconnected"));
      pending.clear();
      setStatus({ connected: false });
      scheduleRetry();
    };

    ws.onerror = () => {
      // onclose always follows; it owns the retry.
    };
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    // back off, but stay responsive when a phone wakes up: the common case is
    // "screen unlocked, network is back", not "server is down"
    const delay = Math.min(500 * 2 ** retry++, 15000);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      connect();
    }, delay);
  };

  const request = (frame) =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id_ = seq++;
      pending.set(id_, { resolve, reject });
      try {
        socket.send(JSON.stringify({ ...frame, id_ }));
      } catch (err) {
        pending.delete(id_);
        reject(err);
      }
    });

  connect();

  return {
    kind: "ws",
    url: base,
    get state() {
      return { ...state };
    },
    invoke: (cmd, args = {}) => {
      const toOp = OP_FOR[cmd];
      if (toOp) return request(toOp(args));
      const toFs = FS_FOR[cmd];
      if (toFs) return request(toFs(args));
      return Promise.reject(new Error(`not available on mobile: ${cmd}`));
    },
    // Mirrors Tauri's listen(): resolves to an unsubscribe function.
    listen: (ev, cb) => {
      if (!subs.has(ev)) subs.set(ev, new Set());
      subs.get(ev).add(cb);
      return Promise.resolve(() => subs.get(ev)?.delete(cb));
    },
    reconnectNow: () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = 0;
      }
      retry = 0;
      if (!socket || socket.readyState > WebSocket.OPEN) connect();
    },
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}

/** Pair a phone with a gateway, exchanging a one-time code for a token. */
export async function pairWithGateway(url, code, deviceName) {
  const res = await fetch(`${url.replace(/\/+$/, "")}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `pairing failed (${res.status})`);
  }
  return res.json();
}
