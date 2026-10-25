import { Component, memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { listen as listenApp } from "@/lib/ipc";
import { useTransport } from "../lib/TransportContext";
import { CLAUDE_MODELS, CODEX_MODELS, pickerIdFor } from "../lib/models";
import { matchesHotkey, parseHotkey, formatHotkey } from "../lib/hotkey";
import { loadSettings } from "../settings";
import {
  ArrowUp,
  Bell,
  CaretUp,
  CircleNotch,
  Cpu,
  FileText,
  Paperclip,
  Microphone,
  Robot,
  SpeakerHigh,
  SpeakerSimpleSlash,
  Stop,
  Terminal,
  X,
} from "@phosphor-icons/react";
import { loadSpeechPrefs, onSpeaking, saveSpeechPrefs, speak } from "../lib/speech";
import { LogoMark } from "../components/Logo";
import useDictation from "./useDictation";
import {
  createChatStore,
  applyLines,
  applyLine,
  applyAsk,
  addLocalUser,
  addNotice,
  confirmPending,
  carryPending,
  markSendFailed,
  retrySend,
} from "./records";
import Markdown from "./Markdown";
import ToolCard, { TtyPromptCard } from "./ToolCard";
import { PeerBubble, SendMessageCard, isSendMessage } from "./PeerMessage";
import { isAmbiguousSendError } from "../lib/paneSend";
import { buildWire, imageToken } from "../lib/imageTokens";
import { removeChatPane, reportChatActivity } from "../tasks/taskRegistry";

// Older sessions can be thousands of messages; mount only the recent tail
// and let "Show earlier" page backwards. content-visibility handles paint,
// this handles mount + markdown-parse cost. The tail is deliberately small:
// a bench mounts many chats, and markdown + tool cards are the expensive
// half of a row.
const TAIL = 100;
const PAGE = 500;
// Holding a bare Space mid-text this long turns it into push-to-talk. Longer
// than the macOS key-repeat delay would be sluggish; shorter and a normal
// space typed slowly would start dictating.
const SOFT_HOLD_MS = 350;

// Claude Code built-ins worth surfacing in the composer's "/" autocomplete;
// custom commands + skills are merged in from list_slash_commands. `tui`
// marks commands that open a full-screen terminal dialog — the pane flips
// to Term view when one is sent (and they're hidden on headless panes,
// where there is no terminal to flip to).
const BUILTIN_COMMANDS = [
  ["clear", "Start a fresh session"],
  ["compact", "Compact the conversation to free context"],
  ["resume", "Resume a previous session", true],
  ["model", "Switch model", true],
  ["usage", "Show plan usage limits", true],
  ["review", "Review a pull request"],
  ["init", "Generate CLAUDE.md for this project"],
  ["memory", "Edit memory files", true],
  ["context", "Show context usage"],
  ["cost", "Show token usage and cost"],
  ["agents", "Manage subagents", true],
  ["mcp", "Manage MCP servers", true],
  ["permissions", "View or update permissions", true],
  ["hooks", "Manage hooks", true],
  ["config", "Open settings", true],
  ["todos", "Show the todo list"],
  ["add-dir", "Add a working directory"],
  ["export", "Export the conversation", true],
  ["statusline", "Configure the status line", true],
  ["doctor", "Diagnose installation issues", true],
  ["help", "Show help"],
  ["theme", "Change the color theme", true],
  ["output-style", "Set the output style", true],
  ["rewind", "Rewind the conversation or code", true],
  ["bashes", "List background shells", true],
  ["status", "Show version and connection status", true],
  ["login", "Sign in to Claude", true],
  ["logout", "Sign out", true],
  ["bug", "Report a bug to Anthropic", true],
  ["release-notes", "Show release notes"],
  ["pr-comments", "Show comments on the current PR"],
  ["security-review", "Security-review pending changes"],
  ["vim", "Toggle vim editing mode"],
  ["terminal-setup", "Configure terminal keybindings", true],
  ["install-github-app", "Set up Claude GitHub Actions", true],
  ["privacy-settings", "View privacy settings", true],
].map(([name, desc, tui]) => ({ name, desc, source: "built-in", tui: !!tui }));

const TUI_COMMANDS = new Set(
  BUILTIN_COMMANDS.filter((c) => c.tui).map((c) => c.name),
);

// TUI commands that run directly (no dialog) once given an argument, so the
// pane must NOT flip to Term for them: "/model opus", "/resume <sid>".
const ARG_DIRECT = new Set(["model", "resume"]);

// Commands the chat view re-implements itself, so they work in both modes
// (and even on headless panes where there is no terminal at all).
const CHAT_NATIVE = new Set(["model", "resume"]);

// Model lists live in lib/models.js — Claude's /model shortcuts and Codex's
// slugs (its /model also takes a slug directly, so both get a picker).

// Rows re-render only when their message's rev changes — messages mutate in
// place (tool results, draft tokens), so identity alone isn't enough.
const Row = memo(
  function Row({ msg, onRetry, onSendNow }) {
    if (msg.kind === "peer") return <PeerBubble peer={msg.peer} />;
    if (msg.kind === "tool")
      return isSendMessage(msg.tool) ? (
        <SendMessageCard tool={msg.tool} />
      ) : (
        <ToolCard tool={msg.tool} rev={msg.rev} />
      );
    if (msg.kind === "thinking") return <ThinkingRow msg={msg} />;
    if (msg.kind === "error") return <pre className="chat-error">{msg.text}</pre>;
    if (msg.kind === "notice")
      return (
        <div className="chat-notice">
          <span className="chat-notice-head">
            <Bell size={11} weight="fill" />
            {msg.notice.title}
            {msg.notice.head && (
              <span className="chat-notice-meta"> · {msg.notice.head}</span>
            )}
          </span>
          {msg.notice.body && (
            <span className="chat-notice-body">{msg.notice.body}</span>
          )}
        </div>
      );
    // Only commands the harness ran itself land here (anything sent from the
    // composer keeps its user bubble) — those aren't something the user
    // "said", so they stay a centered event row rather than a chat message.
    if (msg.kind === "command")
      return (
        <div className="chat-cmd-event">
          <Terminal size={11} weight="bold" />
          <code>{msg.text}</code>
        </div>
      );
    if (msg.role === "user")
      return (
        <div className={`chat-user${msg.local ? " pending" : ""}${msg.failed ? " failed" : ""}`}>
          {msg.images?.length > 0 && (
            <div className="chat-user-images">
              {msg.images.map((im, i) =>
                im.n != null ? (
                  <span key={i} className="chat-img-labelled" data-n={`#${im.n}`}>
                    <img className="chat-user-img" src={im.url} alt={imageToken(im.n)} />
                  </span>
                ) : (
                  <img key={i} className="chat-user-img" src={im.url} alt="" />
                ),
              )}
            </div>
          )}
          {msg.text}
          {msg.local && <span className="chat-user-spin" aria-label="sending" />}
          {msg.queued && !msg.failed && (
            <span className="chat-user-queued">
              queued · sends when the agent is free
              {onSendNow && (
                <button
                  className="chat-send-now"
                  title="Deliver into the running turn now (Ctrl+X Ctrl+S)"
                  onClick={() => onSendNow()}
                >
                  send now
                </button>
              )}
            </span>
          )}
          {msg.failed && (
            // "may not have sent": the reply was lost, not necessarily the
            // message — a resend could double-deliver, so don't overclaim
            <button className="chat-user-retry" onClick={() => onRetry?.(msg)}>
              {msg.ambiguous ? "may not have sent" : "didn't send"}
              {msg.sendError ? ` — ${msg.sendError}` : ""} · tap to resend
            </button>
          )}
        </div>
      );
    if (msg.kind === "draft") {
      // plain text while streaming — markdown-parsing a growing message on
      // every token is O(n²) and was the original perf sink
      return <div className="chat-assistant streaming">{msg.text}</div>;
    }
    return (
      <div className="chat-assistant">
        {msg.text.trim() && <Markdown text={msg.text} />}
        {msg.spoken && <Readout text={msg.spoken} speakKey={`${msg.key}:spoken`} />}
        {!msg.sidechain && msg.text.trim() && <ReadAloud text={msg.text} speakKey={`${msg.key}:all`} />}
      </div>
    );
  },
  // prev.rev is the render-time snapshot; msg.rev mutates in place, so the
  // prop pair is the only reliable change signal
  (prev, next) => prev.msg === next.msg && prev.rev === next.rev,
);

// Whether this machine has a voice, and whether `key` is what's playing.
function useSpeechState(key) {
  const { invoke } = useTransport();
  const [available, setAvailable] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let dead = false;
    loadSpeechPrefs(invoke).then((p) => !dead && setAvailable(!!p.available));
    const off = onSpeaking((k) => setPlaying(k === key));
    return () => {
      dead = true;
      off();
    };
  }, [invoke, key]);
  return { invoke, available, playing };
}

// The spoken readout Claude ended its turn with: the gist in one line, tap
// to hear it (again). New ones play by themselves — see ChatView's autoplay.
function Readout({ text, speakKey }) {
  const { invoke, available, playing } = useSpeechState(speakKey);
  return (
    <button
      type="button"
      className={`chat-readout${playing ? " playing" : ""}`}
      disabled={!available}
      title={available ? (playing ? "Stop" : "Play readout") : "Voice model not installed on this machine"}
      onClick={() => speak(invoke, text, { key: speakKey, raw: true }).catch(() => {})}
    >
      {playing ? <SpeakerSimpleSlash size={13} weight="fill" /> : <SpeakerHigh size={13} weight="fill" />}
      <span>{text}</span>
    </button>
  );
}

// Auto-read on/off, right in the composer so any device can flip it (the
// phone app has no Settings → Voice). One machine-wide switch: every screen
// showing the chat follows it. Hidden unless readouts are on.
function AutoReadToggle() {
  const { invoke } = useTransport();
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    let dead = false;
    const refresh = () => loadSpeechPrefs(invoke, true).then((p) => !dead && setPrefs(p));
    refresh();
    // flipped on another device: pick it up when this window comes back
    window.addEventListener("focus", refresh);
    return () => {
      dead = true;
      window.removeEventListener("focus", refresh);
    };
  }, [invoke]);
  if (!prefs?.readouts || !prefs.available) return null;
  const on = !!prefs.autoplay;
  return (
    <button
      type="button"
      className={`chat-model-btn chat-autoread${on ? " on" : ""}`}
      title={on ? "Readouts play automatically on every device — click to turn off" : "Readouts play only when tapped — click to auto-play"}
      aria-pressed={on}
      onMouseDown={(ev) => ev.preventDefault()} // keep the textarea focused
      onClick={() => {
        setPrefs((p) => ({ ...p, autoplay: !on }));
        saveSpeechPrefs(invoke, { autoplay: !on }).then(setPrefs).catch(() => {});
      }}
    >
      {on ? <SpeakerHigh size={12} weight="fill" /> : <SpeakerSimpleSlash size={12} />}
      Auto-read
    </button>
  );
}

// Read a whole message aloud (code, tables and links skipped server-side).
function ReadAloud({ text, speakKey }) {
  const { invoke, available, playing } = useSpeechState(speakKey);
  if (!available) return null;
  return (
    <button
      type="button"
      className={`chat-read-aloud${playing ? " playing" : ""}`}
      title={playing ? "Stop reading" : "Read aloud"}
      aria-label={playing ? "Stop reading" : "Read aloud"}
      onClick={() => speak(invoke, text, { key: speakKey }).catch(() => {})}
    >
      {playing ? <SpeakerSimpleSlash size={12} /> : <SpeakerHigh size={12} />}
      <span>{playing ? "Stop" : "Read aloud"}</span>
    </button>
  );
}

// A platform-specific render crash must show itself in the pane, not blank
// it (or take the whole app down) — debugging "completely blank" over chat
// screenshots is how the Windows launch went.
class ChatErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre className="chat-error">
          {`chat view crashed: ${this.state.error}\n${this.state.error?.stack?.split("\n").slice(0, 4).join("\n") ?? ""}`}
        </pre>
      );
    }
    return this.props.children;
  }
}

function ThinkingRow({ msg }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-thinking">
      <button onClick={() => setOpen((o) => !o)}>thought for a moment</button>
      {open && <div className="chat-thinking-text">{msg.text}</div>}
    </div>
  );
}

function SidechainGroup({ items }) {
  const [open, setOpen] = useState(false);
  // stream-mode sidechains carry the spawning Task's label ("Explore …");
  // name the fold so it's obvious whose work this was, not the main agent's
  const label = items.find((m) => m.agent)?.agent;
  return (
    <div className="chat-sidechain">
      <button className="chat-sidechain-head" onClick={() => setOpen((o) => !o)}>
        <Robot size={11} />
        {label ? `${label} · ` : ""}worked in background · {items.length} step
        {items.length === 1 ? "" : "s"}
      </button>
      {open && items.map((m) => <Row key={m.key} msg={m} rev={m.rev} />)}
    </div>
  );
}

// user/text stand alone; consecutive tool calls stack into one activity
// block; sidechain runs fold behind a single row — one per sub-agent, so
// two parallel agents' interleaved steps don't blend into one pile.
function groupMessages(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.sidechain) {
      // Merge into the most recent fold for this same agent, looking back
      // through any trailing sidechain folds: parallel agents interleave
      // freely, and strict adjacency would shred each into 1-step groups.
      let fold = null;
      for (let i = out.length - 1; i >= 0 && out[i].type === "sidechain"; i--) {
        if (out[i].agentId === m.agentId) {
          fold = out[i];
          break;
        }
      }
      if (fold) fold.items.push(m);
      else
        out.push({
          type: "sidechain",
          key: `g-${m.key}`,
          agentId: m.agentId,
          items: [m],
        });
    } else if (m.kind === "tool" && !isSendMessage(m.tool)) {
      if (last?.type === "tools") last.items.push(m);
      else out.push({ type: "tools", key: `t-${m.key}`, items: [m] });
    } else {
      out.push({ type: "msg", key: m.key, msg: m });
    }
  }
  return out;
}

// The agent process a background shell is running as: the broker lists each
// child by its unwrapped command line (capped at 400 chars), so match on that.
const squash = (t) => (t ?? "").replace(/\s+/g, " ").trim();
function processFor(act, commands) {
  const want = squash(act.detail);
  if (!want || !commands?.length) return null;
  return commands.find((c) => {
    const got = squash(c.command).replace(/…$/, "");
    return got && (got === want || want.startsWith(got) || got.includes(want));
  }) ?? null;
}

/**
 * Chat-rendered Claude session.
 *  mode "transcript": read-along beside a pty — backfill + tail via the
 *    broker's transcript watcher (watch_transcript / transcript-lines).
 *  mode "stream": headless pane — initialLines from reattach, live lines
 *    from stream-json events.
 * onSend(text) delivers composer input; the caller owns the write path.
 */
export default memo(function ChatView({
  id,
  cwd,
  mode,
  agent = "Claude",
  // Pane identity for the composer chip: the agent's session name and its
  // /color dot. Without them the chip still shows the project folder.
  name,
  accentColor,
  visible = true,
  readOnly = false,
  initialLines,
  onSend,
  onStop,
  onNeedsTerm,
  // Open the app's session picker ("/resume" from the composer). Optional —
  // without it, bare /resume falls back to the terminal dialog.
  onResume,
  status,
  register,
  // The phone has no drag-and-drop and a much narrower composer, so it passes
  // a shorter prompt instead of the desktop's hint-laden one.
  placeholder,
  // Staging an image needs save_pasted_image to write it somewhere Claude can
  // read by path. Both transports have it — the desktop as a Tauri command,
  // the phone via the gateway's save_image — so a phone photo works too; the
  // picker there offers the camera natively.
  allowImages = mode === "transcript",
  // A phone has no Esc key, so hints that name one are worse than useless and
  // anything only reachable by keyboard needs a button of its own.
  touch = typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)")?.matches === true,
  // Questions already waiting when this view opened. The live `ask` ping only
  // reaches whoever was connected at the time, so a client that arrives later
  // — a phone that was asleep, or a chat opened after the fact — would never
  // learn the agent is blocked on an answer.
  pendingAsks,
  // Report background work (sub-agents/shells) into the app-level task
  // registry. Local desktop panes only — remote pane ids would collide with
  // local ones in the registry.
  trackTasks = false,
  // Background shells' controls (desktop panes): the agent's live processes
  // from the broker's resources push, plus stop/follow from the process
  // drawer. Without it the activity list can only jump to the card.
  shells,
}) {
  // Desktop: Tauri IPC. Phone: the WebSocket to the machine owning this pane.
  const { invoke, listen, kind: transportKind, upload } = useTransport();
  // Any other file type rides the transport's upload (a temp file on the
  // workstation) and reaches Claude as a path it can Read.
  const allowFiles = allowImages && typeof upload === "function";
  // A transcript backfill costs real bandwidth on a remote transport, and the
  // web bench mounts every pane of every project — fetching them all at boot
  // shipped tens of MB through the tunnel. Off-screen panes hold off until
  // their first moment on screen; that arms the watcher permanently (the live
  // tail keeps it current afterwards). Local IPC is free: armed from birth,
  // so the desktop behaves exactly as before.
  const [armed, setArmed] = useState(transportKind === "tauri" || visible);
  useEffect(() => {
    if (visible) setArmed(true);
  }, [visible]);
  // Rendering rows is the other expensive half: the bench mounts every pane
  // of every project, most never looked at. The store keeps ingesting (the
  // tasks rail and status heuristics need it), but no row tree is built
  // until the pane's first moment on screen — the ResizeObserver pin below
  // lands that first render at the bottom.
  const [shown, setShown] = useState(visible);
  useEffect(() => {
    if (visible) setShown(true);
  }, [visible]);
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createChatStore();
  const [, forceRender] = useReducer((n) => n + 1, 0);
  const [waiting, setWaiting] = useState(mode === "transcript");
  // Zero messages means "backfill not here yet" until the watcher answers —
  // over a phone's network that gap is long enough to flash the welcome
  // panel over a conversation that very much exists.
  const [loading, setLoading] = useState(mode === "transcript");
  const [watchError, setWatchError] = useState(null);
  const [tailCap, setTailCap] = useState(TAIL);
  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (visible && dirtyRef.current) { dirtyRef.current = false; forceRender(); }
  }, [visible]);
  const rafRef = useRef(0);
  const lastRevRef = useRef(0);
  // Authoritative turn state from the UserPromptSubmit/Stop hooks; null until
  // the first one lands (old broker, or settings written before those hooks
  // existed), which is when the record heuristic below stands in.
  const [turnActive, setTurnActive] = useState(null);
  const workingRef = useRef(false);
  // Set when the composer sends into an already-running turn: the TUI queues
  // that message, and interrupting restores it to the input buffer, so stop
  // has to follow through with an Enter to avoid swallowing it. Any other
  // stop must NOT send that Enter or it just resubmits and the agent
  // restarts — which is what made stop look like it did nothing.
  const queuedRef = useRef(false);

  // "/" autocomplete: query is the token after a leading slash, null = closed
  const [cmdQuery, setCmdQuery] = useState(null);
  const [cmdIndex, setCmdIndex] = useState(0);
  // Model switcher: the label reflects the last explicit choice; null =
  // whatever the session is already on.
  const [model, setModel] = useState(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // running sub-agents / background shells popup
  const [activityOpen, setActivityOpen] = useState(false);
  const [stoppingShells, setStoppingShells] = useState({});
  const stopShell = async (key, proc) => {
    setStoppingShells((s) => ({ ...s, [key]: true }));
    try {
      await shells.onStop(proc);
    } catch (err) {
      console.error("stop shell failed", err);
      setStoppingShells(({ [key]: _, ...rest }) => rest);
    }
  };
  // First-message insurance (transcript mode): the paste-then-Enter dance can
  // leave the text sitting in the TUI's input box (Enter coalesced into the
  // paste — worst while Claude is still booting). If neither the
  // UserPromptSubmit hook nor the transcript confirms the send, push another
  // Enter; at an already-submitted (empty) prompt it's a no-op.
  const submitGuardRef = useRef(null); // active timer, or null
  const turnConfirmedRef = useRef(false);
  // Pasted/dropped images staged in the composer: { key, url (data URL), name }.
  // They render inline (WYSIWYG), can be removed, and are written to temp files
  // on send so Claude gets them by path.
  const [images, setImages] = useState([]);
  // Non-image files staged alongside: { key, name, size, file }. Uploaded on
  // send; each path is appended to the message.
  const [files, setFiles] = useState([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const draftOwner = useRef(crypto.randomUUID());
  const lastDraft = useRef(null);
  const publishDraft = (focused = document.activeElement === inputRef.current) => {
    if (!trackTasks || readOnly) return;
    const present = focused || !!inputRef.current?.value.trim() || images.length > 0 || files.length > 0;
    if (lastDraft.current === present) return;
    lastDraft.current = present;
    invoke("resource_draft", { id, owner: draftOwner.current, present }).catch(() => {});
  };
  useEffect(() => { publishDraft(); }, [images, files]);
  useEffect(() => () => {
    if (trackTasks && !readOnly) invoke("resource_draft", { id, owner: draftOwner.current, present: false }).catch(() => {});
  }, [id, trackTasks, readOnly]);

  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const imgKeyRef = useRef(0);
  // Staging an image drops its "[Image #N]" token at the cursor, like Claude
  // Code's composer, so the message can say which image it means. Numbers
  // restart once the tray is empty.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const stageImage = (url, name) => {
    const n = imagesRef.current.reduce((max, im) => Math.max(max, im.n), 0) + 1;
    const next = [...imagesRef.current, { key: `img${imgKeyRef.current++}`, url, name, n }];
    imagesRef.current = next; // several files in one drop stage back-to-back
    setImages(next);
    const el = inputRef.current;
    if (!el) return;
    const tok = imageToken(n);
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = /^\s/.test(after) ? "" : " ";
    el.value = before + lead + tok + trail + after;
    const caret = (before + lead + tok + trail).length;
    el.setSelectionRange(caret, caret);
    el.style.height = "";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };
  const stageImageRef = useRef(stageImage);
  stageImageRef.current = stageImage;
  const fileInputRef = useRef(null);
  const commandsRef = useRef(null); // merged builtin + custom, fetched once

  // Dictation writes into the textarea, which is uncontrolled — the composer
  // reads el.value directly. Partials are revisions of the whole phrase, so
  // each one replaces the transcript rather than appending: keep whatever sat
  // either side of the caret when the mic opened and rewrite only the middle.
  const dictAroundRef = useRef({ before: "", after: "" });
  const [dictError, setDictError] = useState(null);
  const [dictStatus, setDictStatus] = useState(null);
  // While listening the textarea's text is hidden under a mirror that draws
  // the same text with a level meter at the insertion point, so the words
  // appear to stream out behind it. { head, tail } either side of the meter.
  const [dictView, setDictView] = useState(null);
  const dictMirrorRef = useRef(null);
  const meterRef = useRef(null);
  const levelsRef = useRef([0, 0, 0, 0, 0]);
  const dictCaretRef = useRef(0);
  const writeTranscript = (text) => {
    const el = inputRef.current;
    if (!el) return;
    const { before, after } = dictAroundRef.current;
    const lead = before && text && !/\s$/.test(before) ? " " : "";
    const trail = after && text && !/^\s/.test(after) ? " " : "";
    const head = before + lead + text;
    el.value = head + trail + after;
    el.setSelectionRange(head.length, head.length);
    dictCaretRef.current = head.length;
    setDictView({ head, tail: trail + after });
    // match the autosize + "/" menu the onInput handler would have done
    el.style.height = "";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
    syncCmdMenu(el.value);
  };
  // Bars scroll left like a tiny waveform: newest level enters on the right.
  const showLevel = (level) => {
    const bars = meterRef.current?.children;
    if (!bars) return;
    const levels = levelsRef.current;
    levels.shift();
    levels.push(level);
    meterRef.current.classList.add("metered");
    for (let i = 0; i < bars.length; i++)
      bars[i].style.transform = `scaleY(${0.18 + 0.82 * levels[i]})`;
  };
  const dictation = useDictation({
    onPartial: (text) => {
      setDictStatus(null);
      writeTranscript(text);
    },
    onFinal: (text) => {
      setDictStatus(null);
      writeTranscript(text);
      const el = inputRef.current;
      if (!el) return;
      // No trailing space: it would leave the box non-empty-looking, which
      // disarms the bare-Space shortcut below and turns every later Space
      // press into another stray space. The separator before the next phrase
      // is added when that phrase starts instead.
      el.focus();
      el.setSelectionRange(dictCaretRef.current, dictCaretRef.current);
    },
    onError: (message) => {
      setDictStatus(null);
      setDictError(message);
    },
    onLevel: showLevel,
    onStatus: setDictStatus,
  });
  // The mirror has to scroll with the textarea it covers.
  useLayoutEffect(() => {
    if (dictMirrorRef.current && inputRef.current)
      dictMirrorRef.current.scrollTop = inputRef.current.scrollTop;
  }, [dictView, dictation.listening]);
  // Whether the current phrase is push-to-talk (⌥Space) rather than a button
  // toggle. Only a held phrase is tied to keys that must be released, so only
  // it should be abandoned when the composer loses focus.
  const dictHoldRef = useRef(false);
  // Push-to-talk settings: the desktop stores them in localStorage and the
  // settings window broadcasts edits over the app-wide Tauri event, which the
  // pane's transport doesn't carry (a mobile pane's transport listens to the
  // remote machine, but these prefs belong to the device in hand).
  const [dictPrefs, setDictPrefs] = useState(() => {
    const s = loadSettings();
    return { key: s.dictationKey ?? "", delay: s.dictationHoldDelay ?? 250 };
  });
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const un = listenApp("settings-changed", (e) =>
      setDictPrefs({
        key: e.payload.dictationKey ?? "",
        delay: e.payload.dictationHoldDelay ?? 250,
      }),
    );
    return () => un.then((f) => f());
  }, []);
  // The mic only opens once the key has been held this long, so brushing
  // Space can't start a phrase; released inside the window, nothing happens.
  const dictTimerRef = useRef(null);
  // "Armed or talking": the window between keydown and the phrase ending.
  // dictHoldRef alone isn't it — that ref stays set after stop() until the
  // next start, and gating key handling on it would eat Space forever.
  const dictHoldActive = () =>
    dictHoldRef.current && (dictTimerRef.current != null || dictation.listening);
  // Where a bare Space typed mid-text landed, while it might still turn into
  // a hold. That Space is let through (it's usually just a space), and only
  // taken back out once it's been held long enough to mean "dictate here".
  const dictSoftRef = useRef(null);
  const beginHold = (softAt = null) => {
    if (dictTimerRef.current || dictation.listening) return;
    // A soft hold always waits: with no delay every space typed would dictate.
    const delay = softAt == null ? dictPrefs.delay : Math.max(dictPrefs.delay, SOFT_HOLD_MS);
    if (delay <= 0) return startDictation(true);
    dictHoldRef.current = true; // armed — repeats are swallowed from here on
    dictSoftRef.current = softAt;
    dictTimerRef.current = setTimeout(() => {
      dictTimerRef.current = null;
      const at = dictSoftRef.current;
      dictSoftRef.current = null;
      const el = inputRef.current;
      if (at != null && el && el.value[at] === " " && el.selectionStart === at + 1) {
        el.value = el.value.slice(0, at) + el.value.slice(at + 1);
        el.setSelectionRange(at, at);
      }
      startDictation(true);
    }, delay);
  };
  // A pane unmounting mid-delay must not open the mic afterwards.
  useEffect(() => () => clearTimeout(dictTimerRef.current), []);
  const endHold = (commit) => {
    if (dictTimerRef.current) {
      // released within the delay window: never listened, nothing to insert
      clearTimeout(dictTimerRef.current);
      dictTimerRef.current = null;
      dictHoldRef.current = false;
      dictSoftRef.current = null;
      return;
    }
    if (dictHoldRef.current && dictation.listening)
      commit ? dictation.stop() : dictation.cancel();
  };
  // Which released key ends a held phrase: either half of the built-in
  // chords (Space / ⌥Space), or any piece of the custom combo.
  const endsHold = (ev) => {
    if (ev.code === "Space" || ev.key === "Alt") return true;
    if (!dictPrefs.key) return false;
    const c = parseHotkey(dictPrefs.key);
    const k = ev.key.toLowerCase();
    return (
      k === c.key ||
      (c.ctrl && k === "control") ||
      (c.alt && k === "alt") ||
      (c.meta && k === "meta") ||
      (c.shift && k === "shift")
    );
  };
  const startDictation = (held) => {
    const el = inputRef.current;
    // The phrase lands at the caret (or replaces a selection), and
    // writeTranscript puts exactly one space either side of it. A box holding
    // only whitespace counts as empty, so a few stray Space presses can't
    // prefix the message with them.
    const typed = el?.value ?? "";
    if (!typed.trim()) {
      dictAroundRef.current = { before: "", after: "" };
    } else {
      const from = el.selectionStart ?? typed.length;
      const to = el.selectionEnd ?? from;
      dictAroundRef.current = {
        before: typed.slice(0, from).replace(/[ \t]+$/, ""),
        after: typed.slice(to).replace(/^[ \t]+/, ""),
      };
    }
    const { before, after } = dictAroundRef.current;
    const lead = before && !/\s$/.test(before) ? " " : "";
    dictCaretRef.current = (before + lead).length;
    setDictView({ head: before + lead, tail: after && !/^\s/.test(after) ? " " + after : after });
    levelsRef.current = [0, 0, 0, 0, 0];
    dictHoldRef.current = held;
    setDictError(null);
    setDictStatus(null);
    dictation.start();
  };
  const toggleDictation = () =>
    dictation.listening ? dictation.stop() : startDictation(false);

  const loadCommands = () => {
    if (commandsRef.current) return;
    if (agent === "Codex") { commandsRef.current = []; return; }
    commandsRef.current = BUILTIN_COMMANDS;
    invoke("list_slash_commands", { project: cwd ?? "" })
      .then((custom) => {
        const seen = new Set(custom.map((c) => c.name));
        commandsRef.current = [
          ...custom,
          ...BUILTIN_COMMANDS.filter((b) => !seen.has(b.name)),
        ];
      })
      .catch(() => {});
  };

  const cmdMatches =
    cmdQuery != null
      ? (commandsRef.current ?? (agent === "Codex" ? [] : BUILTIN_COMMANDS))
          .filter((c) => c.name.toLowerCase().startsWith(cmdQuery.toLowerCase()))
          // no terminal behind a headless pane — hide dialog-only commands,
          // except the ones the chat view re-implements itself
          .filter(
            (c) =>
              !(mode === "stream" && c.tui) ||
              (CHAT_NATIVE.has(c.name) && (c.name !== "resume" || onResume)),
          )
          .slice(0, 10)
      : [];

  // Hint column: where does this command actually run/render?
  const cmdHint = (c) => {
    if (c.name === "model") return "model picker";
    if (c.name === "resume" && onResume) return "session picker";
    return c.tui ? "opens in Term" : c.source;
  };

  const applyCommand = (cmd) => {
    const el = inputRef.current;
    if (!el) return;
    el.value = `/${cmd.name} `;
    setCmdQuery(null);
    el.focus();
  };

  const syncCmdMenu = (value) => {
    // menu only while typing the command token itself: "/que", not "/cmd arg"
    const m = /^\/([\w:-]*)$/.exec(value);
    if (m) {
      loadCommands();
      setCmdQuery(m[1]);
      setCmdIndex(0);
    } else if (cmdQuery != null) {
      setCmdQuery(null);
    }
  };

  // events arrive per token in stream mode — coalesce renders per frame
  const bump = () => {
    if (!visibleRef.current) {
      dirtyRef.current = true;
      if (trackTasks) reportChatActivity(id, cwd, storeRef.current.activity);
      return;
    }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      forceRender();
    });
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // pin to bottom, but only when content actually changed
  useEffect(() => {
    const store = storeRef.current;
    if (store.rev === lastRevRef.current) return;
    lastRevRef.current = store.rev;
    if (atBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  });

  // Opening the pane starts pinned, but content keeps growing after the
  // first paint (async shiki highlights, lazy row sizing) — re-snap to the
  // bottom on any size change while pinned, so "open chat" always lands at
  // the latest message.
  useEffect(() => {
    const list = listRef.current;
    const col = list?.firstElementChild;
    if (!list || !col) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) list.scrollTop = list.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!armed) return; // off-screen remote pane: no watch, no listeners yet
    const store = storeRef.current;
    let dead = false;
    const unlistens = [];

    // Turn boundaries, straight from the hooks — the transcript lands records
    // after the fact, so it can't tell "mid-turn" from "at rest".
    const onTurn = listen("turn", (e) => {
      if (e.payload.id !== id) return;
      setTurnActive(!!e.payload.active);
      if (e.payload.active) {
        // the prompt was consumed — stand down the retry-Enter guard and
        // stop any "sending" spinners still going
        turnConfirmedRef.current = true;
        clearSubmitGuard();
        if (confirmPending(storeRef.current)) bump();
      }
      // Turn over: whatever was queued has been consumed (or discarded), so
      // a later stop must not fire a stray Enter.
      if (!e.payload.active) queuedRef.current = false;
    });
    unlistens.push(onTurn);

    if (mode === "transcript") {
      const startWatch = (rewatch) =>
        invoke("watch_transcript", { id })
          .then((res) => {
            if (dead) return;
            setWaiting(!res?.sid);
            setLoading(false);
            setWatchError(null);
            if (res?.text) {
              // A re-watch replays the whole backfill; into a fresh store,
              // or every message would render twice. In-flight sends carry
              // over the same way transcript-reset's do.
              if (rewatch) {
                const prev = storeRef.current;
                storeRef.current = createChatStore();
                carryPending(prev, storeRef.current);
              }
              try {
                applyLines(storeRef.current, res.text.split("\n"));
              } catch (err) {
                setWatchError(`backfill parse failed: ${err}`);
              }
              bump();
            }
          })
          .catch((err) => {
            // an old broker answers "unknown op" — surface it, don't spin
            if (!dead) {
              setWatchError(String(err));
              setLoading(false);
            }
          });
      startWatch(false);
      unlistens.push(
        // A reconnected gateway socket says hello again — the watch it held
        // for this pane died with the old connection, so re-arm it or the
        // chat silently stops tailing. Desktop IPC never emits this.
        listen("hello", () => startWatch(true)),
        // storeRef.current, NOT a captured store: transcript-reset swaps the
        // store, and writing into the orphaned one left the pane blank until
        // a remount (the Windows "works after Ctrl+R" bug)
        listen("transcript-lines", (e) => {
          if (e.payload.id !== id) return;
          setWaiting(false);
          setLoading(false);
          if (applyLines(storeRef.current, e.payload.lines)) bump();
        }),
        listen("transcript-reset", (e) => {
          if (e.payload.id !== id) return;
          const prev = storeRef.current;
          storeRef.current = createChatStore();
          // The reset that follows a brand-new session's adoption used to
          // wipe the optimistic echo of the very message that created the
          // session — the sent text vanished from the UI with no trace.
          carryPending(prev, storeRef.current);
          bump();
        }),
        // PreToolUse(AskUserQuestion) fires the moment a question is posed —
        // the transcript won't carry it until the turn resumes past the
        // (answered) prompt, so render the pending card from this ping instead.
        listen("ask", (e) => {
          if (e.payload.id !== id) return;
          setWaiting(false);
          if (applyAsk(storeRef.current, e.payload.tool_id, e.payload.questions))
            bump();
        }),
      );
      return () => {
        dead = true;
        invoke("unwatch_transcript", { id }).catch(() => {});
        unlistens.forEach((u) => u.then((f) => f()));
      };
    }

    // stream mode
    if (initialLines?.length) {
      applyLines(store, initialLines);
      bump();
    }
    unlistens.push(
      listen("stream-json", (e) => {
        if (e.payload.id !== id) return;
        if (applyLine(storeRef.current, e.payload.line)) bump();
      }),
    );
    return () => {
      dead = true;
      unlistens.forEach((u) => u.then((f) => f()));
    };
    // the transport is part of the identity of "which stream is this": a
    // mobile pane re-subscribes when its gateway connection is replaced
  }, [id, mode, invoke, listen, armed]);

  useEffect(() => {
    register?.({
      focus: () => readOnly ? listRef.current?.focus() : inputRef.current?.focus(),
      // OS file drops arrive through Tauri's native drag-drop (the webview
      // never sees HTML5 file drops), so the pane pushes them in here.
      addImage: (img) => stageImageRef.current(img.url, img.name || "image"),
      // browser drops on the pane (no OS path): any File
      addFile: (file) => addAnyFileRef.current(file),
      insertText: (t) => {
        const el = inputRef.current;
        if (!el) return;
        el.value = (el.value.trim() ? el.value.replace(/\s+$/, "") + " " : "") + t;
        el.style.height = "";
        el.style.height = Math.min(el.scrollHeight, 160) + "px";
        el.focus();
      },
    });
    return () => register?.(null);
  }, [id]);

  // Spoken readouts play by themselves when they arrive live — never for
  // backfill (anything written before this view opened), never twice, and
  // only while this window is on screen. Per-device switch in Settings, so a
  // phone and the desk don't talk over each other.
  const openedAtRef = useRef(Date.now());
  const spokenRef = useRef(new Set());
  useEffect(() => {
    const msgs = storeRef.current.messages;
    let last = null;
    for (let i = msgs.length - 1; i >= 0 && !last; i--)
      if (msgs[i].spoken && !msgs[i].sidechain) last = msgs[i];
    if (!last || spokenRef.current.has(last.key)) return;
    spokenRef.current.add(last.key);
    if (last.at < openedAtRef.current - 3000) return;
    if (document.visibilityState !== "visible") return;
    loadSpeechPrefs(invoke).then((p) => {
      if (p.available && p.autoplay) speak(invoke, last.spoken, { key: `${last.key}:spoken`, raw: true }).catch(() => {});
    });
  });

  // Terminal-only dialogs (folder trust, computer-use access…) the broker
  // spotted on this pane's screen. Fetched once so a late-opened view sees a
  // dialog that is already up; the event keeps it current. Pty panes only.
  const [ttyPrompt, setTtyPrompt] = useState(null);
  useEffect(() => {
    if (mode !== "transcript" || !armed) return;
    let dead = false;
    invoke("tty_prompt", { id })
      .then((p) => { if (!dead) setTtyPrompt(p ?? null); })
      .catch(() => {}); // older broker: no op, no card
    const un = listen("tty-prompt", (e) => {
      if (e.payload.id === id) setTtyPrompt(e.payload.prompt ?? null);
    });
    return () => {
      dead = true;
      un.then((f) => f());
    };
  }, [id, mode, invoke, listen, armed]);

  // Render questions that were already waiting. applyAsk dedupes by question
  // signature, so this is a no-op once the live ping or the transcript has
  // delivered the same one.
  useEffect(() => {
    if (!pendingAsks?.length) return;
    let added = false;
    for (const ask of pendingAsks) {
      if (applyAsk(storeRef.current, ask.tool_id, ask.questions)) added = true;
    }
    if (added) {
      setWaiting(false);
      bump();
    }
  }, [pendingAsks]);

  // Deliver one wire message, keeping its echo honest. onSend may return a
  // promise (the phone's queued/acked send path); a rejection means the
  // message definitely did not arrive — flip the echo to a retry affordance
  // instead of letting it spin (or worse, look sent). The desktop's onSend
  // returns undefined, which resolves and changes nothing.
  const sendWire = (wire, echo) => {
    Promise.resolve()
      .then(() => onSend(wire))
      .catch((err) => {
        if (echo) {
          echo.sendError = String(err?.message ?? err);
          echo.ambiguous = isAmbiguousSendError(err);
          markSendFailed(storeRef.current, echo);
        }
        bump();
      });
    // The desktop's onSend can't reject (write_pane is fire-and-forget) and
    // the re-Enter guard gives up silently — without this, an echo nothing
    // ever confirmed just spins forever, indistinguishable from "sent". If
    // nothing has confirmed it after 10s, surface the doubt: the message may
    // have landed (so the wording stays "may not have sent"), but the user
    // must see that delivery is unproven and get the resend affordance.
    if (echo) {
      setTimeout(() => {
        if (!echo.local || echo.failed) return; // confirmed or already failed
        echo.ambiguous = true;
        echo.sendError ??= "no confirmation from the agent";
        markSendFailed(storeRef.current, echo);
        bump();
      }, 10000);
    }
  };
  // Stable identity so the memoized Row (which only re-renders on msg/rev)
  // never holds a stale closure.
  const retryFnRef = useRef(null);
  retryFnRef.current = (msg) => {
    if (readOnly) return;
    retrySend(storeRef.current, msg);
    if (workingRef.current) queuedRef.current = true;
    sendWire(msg.wire ?? msg.text, msg);
    bump();
  };
  const handleRetry = useRef((msg) => retryFnRef.current?.(msg)).current;

  // Claude Code parks a message typed mid-turn in its input queue; the
  // Ctrl+X Ctrl+S chord delivers the queue into the running turn instead of
  // waiting for it to end. Same stable-identity trick as retry so the
  // memoized Row never holds a stale closure.
  const sendNowFnRef = useRef(null);
  sendNowFnRef.current = () => {
    if (readOnly) return;
    invoke("write_pane", { id, data: "\x18\x13" }).catch(() => {});
  };
  const handleSendNow = useRef(() => sendNowFnRef.current?.()).current;

  const clearSubmitGuard = () => {
    if (submitGuardRef.current) {
      clearTimeout(submitGuardRef.current);
      submitGuardRef.current = null;
    }
  };

  // Re-send Enter until something confirms the message actually submitted:
  // the UserPromptSubmit hook (turnConfirmedRef), or the transcript recording
  // it (pending drained). Never armed for slash commands — a stray Enter
  // inside an open TUI dialog would pick whatever row is highlighted.
  const armSubmitGuard = () => {
    clearSubmitGuard();
    turnConfirmedRef.current = false;
    let tries = 0;
    const check = () => {
      submitGuardRef.current = null;
      if (turnConfirmedRef.current || storeRef.current.pending.length === 0) return;
      if (tries >= 2) return;
      tries += 1;
      invoke("write_pane", { id, data: "\r" }).catch(() => {});
      submitGuardRef.current = setTimeout(check, 2000);
    };
    submitGuardRef.current = setTimeout(check, 2000);
  };
  useEffect(() => clearSubmitGuard, [id]);

  // Codex sessions pick from Codex's slugs; Claude from /model's shortcuts.
  const modelList = agent === "Codex" ? CODEX_MODELS : CLAUDE_MODELS;

  // Apply a model choice. Pty panes: send "/model <name>" — with an argument
  // it applies directly, no dialog (Codex ≥ 0.153 takes a slug the same
  // way). Headless panes: the stream-json set_model control request, since
  // slash commands never reach a TUI.
  const selectModel = (m) => {
    setModelMenuOpen(false);
    setModel(m);
    const store = storeRef.current;
    if (mode === "stream") {
      invoke("set_chat_model", { id, model: m })
        .then(() => {
          addNotice(store, `Model switched to ${m}`, null);
          bump();
        })
        .catch((err) => {
          addNotice(store, "Model switch failed", String(err));
          bump();
        });
      return;
    }
    // pending echo first so the transcript's command chip confirms it
    const echo = addLocalUser(store, `/model ${m}`);
    echo.wire = `/model ${m}`;
    if (workingRef.current) queuedRef.current = true;
    sendWire(echo.wire, echo);
    atBottomRef.current = true;
    bump();
  };

  const submit = async () => {
    if (readOnly) return;
    const el = inputRef.current;
    // Sending ends any phrase in flight. Without this the recognizer's last
    // result lands after the box is cleared and types the sent message
    // straight back into it — and the image write below can await, widening
    // the window it lands in.
    dictation.cancel();
    dictAroundRef.current = { before: "", after: "" };
    const text = el?.value.trim() ?? "";
    const imgs = imagesRef.current;
    const staged = filesRef.current;
    if (!text && imgs.length === 0 && staged.length === 0) return;

    // Upload staged files first; a failure keeps the draft intact so nothing
    // typed is lost, and says why.
    let filePaths = [];
    if (staged.length && allowFiles) {
      if (uploadingRef.current) return; // a second Enter mid-upload
      uploadingRef.current = true;
      setUploading(true);
      try {
        filePaths = await Promise.all(staged.map((f) => upload(f.file)));
      } catch (err) {
        addNotice(storeRef.current, "Couldn't send the file", String(err?.message || err));
        bump();
        return;
      } finally {
        uploadingRef.current = false;
        setUploading(false);
      }
    }

    // Persist staged images to temp files up front — Claude ingests them by
    // path (deterministic), instead of us racing the OS clipboard. If a write
    // fails, fall through and at least send the text.
    let paths = [];
    if (imgs.length && allowImages) {
      try {
        paths = await Promise.all(
          imgs.map((im) => invoke("save_pasted_image", { dataUrl: im.url })),
        );
      } catch {
        paths = [];
      }
    }

    el.value = "";
    el.style.height = "";
    setCmdQuery(null);
    imagesRef.current = [];
    setImages([]);
    filesRef.current = [];
    setFiles([]);

    const parts = text.startsWith("/") ? text.slice(1).split(/\s+/) : null;
    const tok = parts?.[0] ?? null;
    const arg = parts && parts.length > 1 ? parts.slice(1).join(" ") : "";
    const store = storeRef.current;

    // Commands the chat handles natively, in either mode (skipped when
    // images are staged — then it's a message that happens to start with /).
    if (tok && imgs.length === 0 && staged.length === 0) {
      if (tok === "resume" && !arg && onResume) {
        onResume();
        return;
      }
      if (tok === "model") {
        if (!arg) {
          setModelMenuOpen(true);
          return;
        }
        selectModel(arg);
        return;
      }
      // No terminal behind a headless pane: a dialog command can't render
      // anywhere. Say so instead of confusing the harness with it. (/model is
      // exempt — handled above; bare /resume with a picker returned already.)
      if (mode === "stream" && TUI_COMMANDS.has(tok) && tok !== "model") {
        addNotice(
          store,
          `/${tok} needs a terminal`,
          tok === "resume"
            ? "A headless pane can't switch sessions mid-run. Use “Resume session…” from the New Agent menu to open one in a fresh pane."
            : "This headless pane has no terminal to show the dialog in. Use a regular Claude pane (Term view) for it.",
        );
        bump();
        return;
      }
    }

    // dialog commands (/usage, /memory, bare /resume without a picker…)
    // render in the terminal — flip to Term view so the dialog is visible.
    // With an argument, /model and /resume apply directly: no flip.
    const opensDialog =
      tok != null && (agent === "Codex" || (TUI_COMMANDS.has(tok) && !(arg && ARG_DIRECT.has(tok))));
    // Wire text: each [Image #N] token becomes its image's temp path (names
    // never contain spaces, so no quoting); untokened images lead. The pty
    // paste sends each path on its own so Claude attaches it in place.
    const imgWire = paths.length
      ? buildWire(text, imgs.map((im, i) => ({ n: im.n, path: paths[i] })))
      : text;
    // Uploaded files trail the message as plain paths (sanitized names, no
    // spaces), which Claude reads with its own tools.
    const wire = [imgWire, ...filePaths].filter(Boolean).join(" ");
    const shown = [text, ...filePaths].filter(Boolean).join(" ");
    let echo = null;
    if (!opensDialog) {
      echo = addLocalUser(store, shown, imgs.map((im) => ({ url: im.url, n: im.n })));
      echo.wire = wire; // what a retry must resend (paths included)
    }
    // Sending into a live turn means the TUI queues this message — remember
    // that, so a later stop knows to push it through rather than drop it.
    if (workingRef.current) queuedRef.current = true;
    if (agent === "Codex") store.turnActive = true;
    setTurnActive(true); // don't wait on the hook to offer a stop button
    sendWire(wire, echo);
    if (opensDialog && mode === "transcript") onNeedsTerm?.();
    // plain messages only — see armSubmitGuard on why commands are exempt
    if (agent !== "Codex" && mode === "transcript" && !tok && !workingRef.current) armSubmitGuard();
    atBottomRef.current = true;
    bump();
  };

  // One funnel for every stop affordance, so the queued-message flag is
  // consumed exactly once and a second stop can't fire a stray Enter.
  const stop = () => {
    const resubmit = agent !== "Codex" && queuedRef.current;
    queuedRef.current = false;
    onStop?.(resubmit);
  };

  // Stage an image File (from paste, drop, or the picker) as a data URL so it
  // renders immediately and can be written to a temp file on send.
  const addImageFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => stageImage(String(reader.result), file.name || "pasted image");
    reader.readAsDataURL(file);
  };

  // Any File: images stage as thumbnails, everything else as a file chip.
  const addAnyFile = (file) => {
    if (!file) return;
    if (file.type.startsWith("image/") && !/svg/.test(file.type)) return addImageFile(file);
    if (!allowFiles) return;
    const next = [...filesRef.current, { key: `file${imgKeyRef.current++}`, name: file.name || "file", size: file.size, file }];
    filesRef.current = next;
    setFiles(next);
  };
  const addAnyFileRef = useRef(addAnyFile);
  addAnyFileRef.current = addAnyFile;
  const removeFile = (key) => {
    const next = filesRef.current.filter((f) => f.key !== key);
    filesRef.current = next;
    setFiles(next);
  };

  // Dropping an image takes its token out of the text too.
  const removeImage = (key) => {
    const gone = imagesRef.current.find((i) => i.key === key);
    const next = imagesRef.current.filter((i) => i.key !== key);
    imagesRef.current = next;
    setImages(next);
    const el = inputRef.current;
    if (gone && el) el.value = el.value.replace(` ${imageToken(gone.n)}`, "").replace(imageToken(gone.n), "");
  };

  // Capture pasted images into the composer instead of the OS clipboard round
  // trip. If the clipboard also has text, let that paste normally; only
  // swallow the paste when it's image-only (nothing to type).
  const onPaste = (ev) => {
    if (!allowImages) return;
    const items = Array.from(ev.clipboardData?.items ?? []);
    const fileItems = items.filter((it) =>
      it.kind === "file" && (allowFiles || it.type.startsWith("image/")),
    );
    if (!fileItems.length) return;
    const hasText = items.some((it) => it.type === "text/plain");
    if (!hasText) ev.preventDefault();
    for (const it of fileItems) addAnyFile(it.getAsFile());
  };

  const onDrop = (ev) => {
    if (!allowImages) return;
    const dropped = Array.from(ev.dataTransfer?.files ?? []).filter(
      (f) => allowFiles || f.type.startsWith("image/"),
    );
    setDragOver(false);
    if (!dropped.length) return;
    ev.preventDefault();
    dropped.forEach(addAnyFile);
  };

  const store = storeRef.current;
  // Model to show on the picker: the last explicit choice, else whatever the
  // session reported it's actually on (init message / assistant replies).
  const activeModel = model ?? pickerIdFor(store.model, modelList);
  const hiddenCount = Math.max(0, store.messages.length - tailCap);
  const visibleMessages = hiddenCount ? store.messages.slice(hiddenCount) : store.messages;
  const groups = shown ? groupMessages(visibleMessages) : [];

  // Live background work: sub-agents and background shells still running.
  const activity = [...store.activity.values()].filter((a) => !a.done);
  const runningAgents = activity.filter((a) => a.kind === "agent");
  const runningShells = activity.filter((a) => a.kind === "shell");

  // Mirror this pane's activity into the app-level registry (Background
  // Tasks rail). Runs after every render; the registry diffs and only
  // notifies when something actually started or finished.
  useEffect(() => {
    if (trackTasks) reportChatActivity(id, cwd, store.activity);
  });
  useEffect(() => {
    if (!trackTasks) return;
    return () => removeChatPane(id);
  }, [id, trackTasks]);

  // Jump to (and flash) the tool card an activity chip points at; page the
  // tail cap out first if the card is behind "Show earlier".
  const revealMsg = (key) => {
    setActivityOpen(false);
    const go = (attempt) => {
      const el = listRef.current?.querySelector(`[data-msg-key="${key}"]`);
      if (el) {
        atBottomRef.current = false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("chat-flash");
        setTimeout(() => el.classList.remove("chat-flash"), 1600);
        return;
      }
      if (attempt === 0) {
        setTailCap(store.messages.length + PAGE);
        setTimeout(() => go(1), 80);
      }
    };
    go(0);
  };
  // Turn-activity comes from the message flow itself — the app-level pane
  // status idles at "working" between events, so it can't gate the stop
  // button. Active: streaming draft, an unfinished tool, or the user just
  // sent and nothing has come back yet.
  const last = store.messages[store.messages.length - 1];
  // Fallback only. In transcript mode there is no draft (drafts come from
  // stream-json events), so this reads false for long stretches of a live
  // turn — every gap between a finished record and the next one. That hid
  // the stop button and made Esc a no-op exactly when they were wanted.
  const looksWorking =
    !!store.draft ||
    (last &&
      (last.kind === "draft" ||
        (last.kind === "tool" && !last.tool.done) ||
        last.role === "user"));
  // The hooks bracket the turn exactly; trust them once they've reported.
  const working = !readOnly && ((agent === "Codex" ? store.turnActive : turnActive) ?? looksWorking);
  workingRef.current = working;

  // nothing to show yet: the list becomes a centered welcome panel instead
  const empty = groups.length === 0;
  const folder = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "";
  // "ravenclaw · AgentBench" — who gets this message, and in which project.
  // Sits in the placeholder AND in a chip that stays up while typing, since
  // wrong-pane sends happen exactly when the placeholder is gone.
  const who = `${name ?? agent}${folder ? ` · ${folder}` : ""}`;

  // Any click elsewhere closes the small composer popovers (their triggers
  // stopPropagation so the toggle doesn't immediately undo itself).
  useEffect(() => {
    if (!modelMenuOpen && !activityOpen) return;
    const close = () => {
      setModelMenuOpen(false);
      setActivityOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [modelMenuOpen, activityOpen]);

  return (
    // Esc also stops when focus has left the composer — clicking a question
    // card or "Show earlier" moves it, and the textarea's handler (which
    // stopPropagation()s, so this never double-fires) was the only binding.
    <div
      className="chat-view"
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && working) stop();
      }}
    >
      <div className="chat-list" ref={listRef} onScroll={onScroll} tabIndex={readOnly ? -1 : undefined}>
        <div className={`chat-col${empty ? " empty" : ""}`}>
          <ChatErrorBoundary>
          {watchError && (
            <pre className="chat-error">
              {/unknown op/i.test(watchError)
                ? `chat view couldn't reach the transcript watcher (${watchError}).\nThe broker probably predates this build — use Settings → Workspace →\nRestart broker (or the command menu's "Restart broker").`
                : /not connected|disconnected/i.test(watchError)
                  ? "Connection to the workstation dropped while opening this chat.\nIt reconnects and reloads by itself — if this sticks around, check that\nthe machine is awake and reachable."
                  : `chat view couldn't load this conversation (${watchError}).`}
            </pre>
          )}
          {empty && !watchError && loading && (
            <div className="chat-loading" role="status" aria-label="loading conversation" />
          )}
          {empty && !watchError && !loading && (
            <div className="chat-empty">
              <LogoMark className="chat-empty-mark" aria-hidden="true" />
              <h2>{waiting ? "Ready when you are" : "New conversation"}</h2>
              <p>
                Send a message to start a session
                {folder ? ` in ${folder}` : ""}. Replies stream in here — the
                terminal keeps running behind the Term toggle.
              </p>
              <div className="chat-empty-tips">
                <span>
                  <kbd>/</kbd> commands
                </span>
                <span>
                  <kbd>Enter</kbd> send
                </span>
                <span>
                  <kbd>Esc</kbd> stop
                </span>
                <span>{allowFiles ? "paste or drop files" : "paste or drop images"}</span>
              </div>
            </div>
          )}
          {shown && hiddenCount > 0 && (
            <button
              className="chat-earlier"
              onClick={() => {
                atBottomRef.current = false;
                setTailCap((c) => c + PAGE);
              }}
            >
              <CaretUp size={11} weight="bold" /> Show {Math.min(hiddenCount, PAGE)}{" "}
              earlier message{hiddenCount === 1 ? "" : "s"}
            </button>
          )}
          {groups.map((g) =>
            g.type === "sidechain" ? (
              <SidechainGroup key={g.key} items={g.items} />
            ) : g.type === "tools" ? (
              <div key={g.key} className="chat-tools">
                {g.items.map((m) => (
                  // anchor for the activity strip's "jump to card"
                  <div key={m.key} data-msg-key={m.key}>
                    <ToolCard
                      tool={m.tool}
                      rev={m.rev}
                      paneId={id}
                      canAnswer={!readOnly && mode === "transcript"}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <Row
                key={g.key}
                msg={g.msg}
                rev={g.msg.rev}
                onRetry={handleRetry}
                // the chord lands in a pty; headless stream input has no
                // queue-jump, and Codex has no such binding at all
                onSendNow={
                  mode === "transcript" && agent !== "Codex" && !readOnly
                    ? handleSendNow
                    : undefined
                }
              />
            ),
          )}
          {working && last?.kind !== "draft" && (
            <div className="chat-dots" aria-label="working">
              <span /><span /><span />
            </div>
          )}
          </ChatErrorBoundary>
        </div>
      </div>
      <div className="chat-composer" style={readOnly ? {display:"none"} : undefined}>
        {/* AskUserQuestion's picker is a menu too; its own card covers it */}
        {ttyPrompt && !store.messages.some((m) => m.tool?.name === "AskUserQuestion" && !m.tool.done) && (
          <TtyPromptCard prompt={ttyPrompt} paneId={id} />
        )}
        {activity.length > 0 && (
          <div className="chat-activity">
            <button
              className="chat-activity-head"
              onMouseDown={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                setActivityOpen((o) => !o);
              }}
            >
              <span className="chat-activity-pulse" />
              {[
                runningAgents.length > 0 &&
                  `${runningAgents.length} agent${runningAgents.length === 1 ? "" : "s"}`,
                runningShells.length > 0 &&
                  `${runningShells.length} shell${runningShells.length === 1 ? "" : "s"}`,
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              running
              <CaretUp size={9} weight="bold" className={activityOpen ? "flip" : ""} />
            </button>
            {activityOpen && (
              <div
                className="chat-activity-list"
                onMouseDown={(ev) => ev.stopPropagation()}
              >
                {activity.map((a, i) => {
                  const proc = a.kind === "shell" ? processFor(a, shells?.commands) : null;
                  const busy = stoppingShells[a.msgKey];
                  return (
                    <div
                      key={`${a.msgKey}-${i}`}
                      role="button"
                      tabIndex={0}
                      className="chat-activity-item"
                      title="Jump to its card in the conversation"
                      onClick={() => revealMsg(a.msgKey)}
                    >
                      {a.kind === "agent" ? (
                        <Robot size={12} />
                      ) : (
                        <Terminal size={12} />
                      )}
                      <span className="chat-activity-label">{a.label}</span>
                      {a.detail && a.detail !== a.label && (
                        <span className="chat-activity-detail">{a.detail}</span>
                      )}
                      {a.kind === "shell" && a.bgId && shells?.onFollow && (
                        <button
                          className="chat-activity-act"
                          title="Follow its live output in the dock"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setActivityOpen(false);
                            shells.onFollow(a.bgId, a.label);
                          }}
                        >
                          <FileText size={11} /> Output
                        </button>
                      )}
                      {proc && shells?.onStop && (
                        <button
                          className="chat-activity-act stop"
                          disabled={!!busy}
                          title="Stop it: Ctrl+C, then terminate, then kill if it won't go"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            stopShell(a.msgKey, proc);
                          }}
                        >
                          <Stop size={10} weight="fill" /> {busy ? "Stopping…" : "Stop"}
                        </button>
                      )}
                      <CircleNotch size={11} className="chat-activity-spin" />
                    </div>
                  );
                })}                ))}
              </div>
            )}
          </div>
        )}
        <div
          className={`chat-composer-card${dragOver ? " drag-over" : ""}`}
          onDrop={onDrop}
          onDragOver={(ev) => {
            if (!allowImages) return;
            if (Array.from(ev.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
              ev.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={(ev) => {
            if (!ev.currentTarget.contains(ev.relatedTarget)) setDragOver(false);
          }}
        >
          {(name || folder) && (
            <div className="chat-identity" title={cwd || undefined}>
              <span
                className="chat-identity-dot"
                style={accentColor ? { background: accentColor } : undefined}
              />
              <span className="chat-identity-name">{name ?? agent}</span>
              {folder && <span className="chat-identity-proj">{folder}</span>}
            </div>
          )}
          {cmdQuery != null && cmdMatches.length > 0 && (
            <div className="chat-cmd-menu">
              {cmdMatches.map((c, i) => (
                <button
                  key={`${c.source}-${c.name}`}
                  className={`chat-cmd-item${i === cmdIndex ? " sel" : ""}`}
                  onMouseEnter={() => setCmdIndex(i)}
                  // mousedown so the textarea never loses focus
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    applyCommand(c);
                  }}
                >
                  <span className="chat-cmd-name">/{c.name}</span>
                  {c.desc && <span className="chat-cmd-desc">{c.desc}</span>}
                  <span className="chat-cmd-src">{cmdHint(c)}</span>
                </button>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="chat-file-tray">
              {files.map((f) => (
                <div key={f.key} className="chat-file-chip" title={f.name}>
                  <FileText size={13} />
                  <span className="chat-file-name">{f.name}</span>
                  <span className="chat-file-size">{formatBytes(f.size)}</span>
                  <button
                    className="chat-file-remove"
                    title="Remove file"
                    aria-label={`Remove ${f.name}`}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      removeFile(f.key);
                    }}
                  >
                    <X size={10} weight="bold" />
                  </button>
                </div>
              ))}
              {uploading && <span className="chat-file-uploading">Uploading…</span>}
            </div>
          )}
          {images.length > 0 && (
            <div className="chat-img-tray">
              {images.map((im) => (
                <div key={im.key} className="chat-img-thumb" title={`${imageToken(im.n)} ${im.name}`} data-n={`#${im.n}`}>
                  <img src={im.url} alt={im.name} />
                  <button
                    className="chat-img-remove"
                    title="Remove image"
                    aria-label="Remove image"
                    // mousedown so the textarea keeps focus
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      removeImage(im.key);
                    }}
                  >
                    <X size={10} weight="bold" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            rows={1}
            className={dictation.listening && dictView ? "dictating" : undefined}
            onScroll={(ev) => {
              if (dictMirrorRef.current)
                dictMirrorRef.current.scrollTop = ev.currentTarget.scrollTop;
            }}
            placeholder={
              placeholder ??
              (mode === "transcript"
                ? `Message ${who}…  ( / for commands · paste or drop an image )`
                : `Message ${who}…  ( / for commands )`)
            }
            onPaste={onPaste}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              // Push-to-talk, matching Claude Code's own /voice binding: hold
              // Space on an empty box, since there is nothing to append a
              // space to yet. Once there's text, Space has to stay a space, so
              // ⌥Space is the escape hatch for dictating mid-sentence — plus
              // whatever combo Settings → Hotkeys → Push-to-talk records.
              //
              // Checked before everything else so a held key can't also open
              // the "/" menu or submit, and preventDefault'd because Space
              // would otherwise type (and ⌥Space a non-breaking space).
              // `repeat` fires while held — ignore it and let keyup be the
              // only thing that ends the phrase.
              if (dictation.available) {
                const held = dictHoldActive();
                const bare =
                  !ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
                // trim(), not === "": a box holding only whitespace still has
                // nothing to append a space to, and treating it as non-empty
                // is what makes repeated Space presses pile up instead of
                // starting a phrase. During a hold the empty-box test is
                // skipped — partials have already filled the box, and letting
                // the repeats fall through here is what used to sprinkle
                // spaces into the phrase as you spoke.
                const space =
                  ev.code === "Space" &&
                  (ev.altKey ||
                    (bare && (held || ev.currentTarget.value.trim() === "")));
                const combo =
                  dictPrefs.key && matchesHotkey(ev, dictPrefs.key);
                if (space || combo) {
                  ev.preventDefault();
                  if (!ev.repeat) beginHold();
                  return;
                }
                // Another key while a mid-text Space is still deciding means
                // it was just a space — fast typing rolls onto the next key
                // before Space comes up.
                if (dictSoftRef.current != null && !ev.repeat) endHold(false);
                // A bare Space mid-text types as normal, but holding it
                // dictates at the caret instead, like the empty-box case.
                const box = ev.currentTarget;
                if (
                  ev.code === "Space" &&
                  bare &&
                  !ev.repeat &&
                  !dictation.listening &&
                  box.selectionStart === box.selectionEnd
                ) {
                  beginHold(box.selectionStart);
                }
              }
              if (dictation.listening && ev.key === "Escape") {
                ev.preventDefault();
                dictation.cancel();
                return;
              }
              if (cmdQuery != null && cmdMatches.length > 0) {
                if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                  ev.preventDefault();
                  const d = ev.key === "ArrowDown" ? 1 : -1;
                  setCmdIndex(
                    (i) => (i + d + cmdMatches.length) % cmdMatches.length,
                  );
                  return;
                }
                if (ev.key === "Tab" || ev.key === "Enter") {
                  ev.preventDefault();
                  applyCommand(cmdMatches[cmdIndex]);
                  return;
                }
                if (ev.key === "Escape") {
                  ev.preventDefault();
                  setCmdQuery(null);
                  return;
                }
              }
              if (ev.key === "Enter" && !ev.shiftKey) {
                ev.preventDefault();
                submit();
              }
              // Esc interrupts, mirroring the terminal
              if (ev.key === "Escape" && working) stop();
            }}
            onKeyUp={(ev) => {
              // Releasing any piece of the chord ends a held phrase (or,
              // within the delay window, quietly disarms it) — letting go of
              // ⌥ first is common and shouldn't strand the mic.
              if (dictHoldActive() && endsHold(ev)) {
                ev.preventDefault();
                endHold(true);
              }
            }}
            onFocus={() => publishDraft(true)}
            onBlur={() => {
              publishDraft(false);
              // A held chord can't deliver its keyup once focus is gone, so
              // the mic would stay open forever; drop the phrase (or a still
              // pending hold timer). A tapped session is deliberate and
              // survives clicking away.
              if (dictHoldActive()) endHold(false);
            }}
            onInput={(ev) => {
              publishDraft();
              const el = ev.currentTarget;
              el.style.height = "";
              el.style.height = Math.min(el.scrollHeight, 160) + "px";
              syncCmdMenu(el.value);
            }}
          />
          {dictation.listening && dictView && (
            <div className="chat-dict-mirror" ref={dictMirrorRef} aria-hidden="true">
              {dictView.head}
              <span className="chat-dict-meter" ref={meterRef}>
                <i /><i /><i /><i /><i />
              </span>
              {dictView.tail}
            </div>
          )}
          </div>
          <div className="chat-composer-bar">
            <span
              className={`chat-composer-hint${dictError ? " chat-composer-hint-error" : ""}`}
            >
              {dictError
                ? dictError
                : dictation.listening && dictStatus
                  ? dictStatus
                : dictation.listening
                  ? touch
                    ? "listening — mic to insert, ✕ to discard"
                    : dictHoldRef.current
                      ? "listening — release to insert · esc to discard"
                      : "listening — esc to discard"
                  : working
                    ? touch
                      ? "working…" // the stop button is right there; naming it just wraps the bar
                      : "working — esc to stop"
                    : touch
                      ? "tap send"
                      : "enter to send"}
            </span>
            <AutoReadToggle />
            <div className="chat-model-wrap">
              {modelMenuOpen && (
                <div
                  className="chat-model-menu"
                  onMouseDown={(ev) => ev.stopPropagation()}
                >
                  {modelList.map((m) => (
                    <button
                      key={m.id}
                      className={`chat-model-item${(activeModel ?? "default") === m.id ? " sel" : ""}`}
                      // mousedown so the textarea never loses focus
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        selectModel(m.id);
                      }}
                    >
                      <span className="chat-model-name">{m.label}</span>
                      <span className="chat-model-desc">{m.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                className="chat-model-btn"
                title="Switch model (/model)"
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setModelMenuOpen((o) => !o);
                }}
              >
                <Cpu size={13} />
                {modelList.find((m) => m.id === activeModel)?.label ??
                  activeModel ??
                  "Model"}
                <CaretUp size={8} weight="bold" />
              </button>
            </div>
            {allowImages && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={allowFiles ? undefined : "image/*"}
                  multiple
                  hidden
                  onChange={(ev) => {
                    Array.from(ev.target.files ?? []).forEach(addAnyFile);
                    ev.target.value = "";
                  }}
                />
                <button
                  className="chat-attach-btn"
                  title={allowFiles ? "Attach files" : "Attach an image"}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={14} />
                </button>
              </>
            )}
            {dictation.listening && (
              // Discarding a phrase was Esc-only, which no phone can do.
              <button
                className="chat-mic-discard"
                title="Discard this phrase"
                aria-label="Discard dictation"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  dictation.cancel();
                }}
              >
                <X size={13} weight="bold" />
              </button>
            )}
            {dictation.available && (
              <button
                className={`chat-mic-btn${dictation.listening ? " chat-mic-live" : ""}`}
                title={
                  dictation.listening
                    ? "Stop dictating and insert (Esc discards)"
                    : `Dictate — click to toggle, or hold Space${
                        dictPrefs.key ? ` or ${formatHotkey(dictPrefs.key)}` : ""
                      }`
                }
                aria-pressed={dictation.listening}
                // mousedown so the textarea keeps focus, matching the attach
                // button — and so ⌥Space stays usable straight afterwards
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  toggleDictation();
                }}
              >
                <Microphone size={14} weight={dictation.listening ? "fill" : "regular"} />
              </button>
            )}
            {working && (
              <button
                className="chat-stop"
                title="Stop the current turn (Esc)"
                onClick={() => stop()}
              >
                <Stop size={12} weight="fill" />
              </button>
            )}
            <button className="chat-send" title="Send (Enter)" onClick={submit}>
              <ArrowUp size={14} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
