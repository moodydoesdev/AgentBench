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
  set_chat_model: (a) => ({ op: "set-model", id: a.id, model: a.model }),
  resize_pane: (a) => ({ op: "resize", id: a.id, cols: a.cols, rows: a.rows }),
  list_panes: () => ({ op: "list" }),
  saved_panes: () => ({ op: "saved" }),
  // team decisions (manager files via the hook server; the user answers)
  decisions: () => ({ op: "decisions" }),
  decision_answer: (a) => ({ op: "decision-answer", id: a.id, answer: a.answer, note: a.note ?? null }),
  // scheduled prompts (broker-owned; phone gets full CRUD + run-now)
  schedules: () => ({ op: "schedules" }),
  schedule_save: (a) => ({ op: "schedule-save", schedule: a.schedule }),
  schedule_delete: (a) => ({ op: "schedule-delete", id: a.id }),
  schedule_run: (a) => ({ op: "schedule-run", id: a.id }),
  // resource panel + hibernation — the web UI is the full desktop bench
  resource_state: () => ({ op: "resources" }),
  // terminal-only dialogs (trust folder, computer-use access) shown in chat
  tty_prompt: (a) => ({ op: "tty-prompt", id: a.id }),
  answer_tty_prompt: (a) => ({ op: "answer-tty-prompt", id: a.id, sig: a.sig, index: a.index }),
  resource_policy: (a) => ({ op: "resource-policy", policy: a.policy }),
  resource_draft: (a) => ({ op: "resource-draft", id: a.id, owner: a.owner, present: a.present }),
  resource_pin: (a) => ({ op: "resource-pin", id: a.id, pinned: a.pinned }),
  stop_command: (a) => ({ op: "stop-command", id: a.id, pid: a.pid, start: a.start }),
  hibernate_pane: (a) => ({ op: "hibernate", id: a.id }),
  resume_hibernated: (a) => ({ op: "resume-hibernated", id: a.id }),
};

// Requests the gateway answers itself, without the broker's op vocabulary.
const FS_FOR = {
  list_sessions: (a) => ({ fs: "list_sessions", project: a.project }),
  // Ripgrep-style content search across a project's session transcripts.
  search_sessions: (a) => ({ fs: "search_sessions", project: a.project, query: a.query }),
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
  // Was allowlisted on the gateway but never mapped here, so every refresh
  // rejected with "not available on mobile" and titles froze at connect time.
  pane_titles: () => ({ fs: "pane_titles" }),
  // Working-tree changes for a project, so a run can be reviewed from the
  // phone before anyone says "ship it".
  git_changes: (a) => ({ fs: "git_changes", cwd: a.cwd }),
  // Token totals for one session transcript.
  session_stats: (a) => ({ fs: "session_stats", project: a.project, sid: a.sid }),
  // Dev-server previews: proxy a workstation-local port to this phone.
  preview_start: (a) => ({ fs: "preview_start", cwd: a.cwd, port: a.port }),
  preview_stop: (a) => ({ fs: "preview_stop", port: a.port }),
  preview_list: () => ({ fs: "preview_list" }),
  preview_detect: (a) => ({ fs: "preview_detect", cwd: a.cwd }),
  // desktop-UI-in-a-browser reads (mirror the Tauri commands' shapes)
  session_tail: (a) => ({ fs: "session_tail", project: a.project, sid: a.sid }),
  session_brief: (a) => ({ fs: "session_brief", project: a.project, sid: a.sid }),
  team_tasks: (a) => ({ fs: "team_tasks", list: a.list }),
  list_teams: (a) => ({ fs: "list_teams", project: a.project }),
  save_teams: (a) => ({ fs: "save_teams", project: a.project, teams: a.teams }),
  save_projects: (a) => ({ fs: "save_projects", projects: a.projects }),
  // Folder browser for adding a project from the phone.
  list_dirs: (a) => ({ fs: "list_dirs", path: a.path }),
  make_dir: (a) => ({ fs: "make_dir", parent: a.parent, name: a.name }),
  read_image_data_url: (a) => ({ fs: "read_image_data_url", path: a.path }),
  read_file_base64: (a) => ({ fs: "read_file_base64", path: a.path }),
  task_output_path: (a) => ({ fs: "task_output_path", project: a.project, sid: a.sid, task: a.task }),
  tail_output: (a) => ({ fs: "tail_output", path: a.path, offset: a.offset }),
  // Claude plan usage for the titlebar meter.
  claude_usage: () => ({ fs: "claude_usage" }),
  // local Kokoro text-to-speech on the workstation; answers a base64 WAV
  speak_text: (a) => ({ fs: "speak_text", text: a.text, voice: a.voice, speed: a.speed, raw: a.raw, engine: a.engine }),
  speech_voices: () => ({ fs: "speech_voices" }),
  speech_prefs: () => ({ fs: "speech_prefs" }),
  set_speech_prefs: (a) => ({ fs: "set_speech_prefs", prefs: a.prefs }),
};

/** Desktop: straight through to the Tauri backend. */
export function tauriTransport() {
  return {
    kind: "tauri",
    invoke: (cmd, args) => tauriInvoke(cmd, args),
    listen: (ev, cb) => tauriListen(ev, cb),
    // A File with no OS path (picker, paste) → a temp path Claude can read.
    upload: async (file) =>
      tauriInvoke("save_upload", { name: file.name || "upload", dataBase64: await fileBase64(file) }),
    close: () => {},
  };
}

/**
 * Phone: one gateway, one socket. Reconnects on its own — a phone drops the
 * connection every time the screen locks, so reconnection is the normal case
 * rather than an error path. The `hello` frame that the gateway sends on every
 * connect carries the state needed to resume without gaps.
 */
export function wsTransport({ url, token, onStatus, tokenInProtocol = false }) {
  const base = url.replace(/\/+$/, "");
  // Web UI: the token rides the Sec-WebSocket-Protocol offer (["bearer",
  // token]) so it never appears in URLs that proxies like Cloudflare log.
  // Phones and linked benches keep the query form — they may be talking to an
  // older gateway that only reads ?token=.
  const wsUrl =
    base.replace(/^http/, "ws") +
    "/api/ws" +
    (tokenInProtocol ? "" : `?token=${encodeURIComponent(token)}`);

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
      ws = tokenInProtocol ? new WebSocket(wsUrl, ["bearer", token]) : new WebSocket(wsUrl);
    } catch (err) {
      setStatus({ connected: false, error: String(err) });
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      retry = 0;
      setStatus({ connected: true, error: null });
      // requests made while the socket was down were held, not failed —
      // a phone waking from sleep opens a chat before the socket is back
      for (const item of queue.splice(0)) {
        clearTimeout(item.timer);
        sendNow(item.frame, item.resolve, item.reject);
      }
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

  // Requests racing a (re)connect wait here for onopen rather than failing
  // outright; a bounded wait, so a machine that is genuinely down still
  // answers with an error rather than hanging its callers forever.
  const queue = []; // { frame, resolve, reject, timer }
  const QUEUE_MS = 12000;

  const sendNow = (frame, resolve, reject) => {
    const id_ = seq++;
    pending.set(id_, { resolve, reject });
    try {
      socket.send(JSON.stringify({ ...frame, id_ }));
    } catch (err) {
      pending.delete(id_);
      reject(err);
    }
  };

  const request = (frame) =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (closed) {
          reject(new Error("not connected"));
          return;
        }
        const item = { frame, resolve, reject };
        item.timer = setTimeout(() => {
          const i = queue.indexOf(item);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error("not connected"));
        }, QUEUE_MS);
        queue.push(item);
        return;
      }
      sendNow(frame, resolve, reject);
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
    // Any file → a temp path on the workstation, over plain HTTP so large
    // files skip base64 and the socket's frame cap.
    upload: async (file) => {
      const res = await fetch(`${base}/api/upload?name=${encodeURIComponent(file.name || "upload")}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.path) {
        throw new Error(body.error || (res.status === 413 ? "file too large (max 100 MB)" : `upload failed (HTTP ${res.status})`));
      }
      return body.path;
    },
    // A workstation file an agent handed over → a Blob to save locally.
    download: async (path) => {
      const res = await fetch(`${base}/api/file?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `download failed (HTTP ${res.status})`);
      }
      return res.blob();
    },
    // Server-side dictation (NVIDIA Parakeet on the workstation). `available`
    // is false on gateways without the model, or too old to know the route.
    dictation: {
      available: async () => {
        const res = await fetch(`${base}/api/dictate/status`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        if (!res?.ok) return false;
        return !!(await res.json().catch(() => ({}))).available;
      },
      // Always the subprotocol form: this route is newer than ?token=.
      open: () => new WebSocket(base.replace(/^http/, "ws") + "/api/dictate", ["bearer", token]),
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
      for (const item of queue.splice(0)) {
        clearTimeout(item.timer);
        item.reject(new Error("not connected"));
      }
      socket?.close();
    },
  };
}

/** Web login: exchange the gateway password (or a pairing code) for a device
 * token. Same shape as pairing — the token that comes back is a full device
 * credential, revocable from Settings. */
export async function loginToGateway(url, { password, code, deviceName }) {
  const res = await fetch(`${url.replace(/\/+$/, "")}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(password != null ? { password, deviceName } : { code, deviceName }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `login failed (${res.status})`);
  return body;
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

/** File → bare base64 (no data: prefix). */
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
