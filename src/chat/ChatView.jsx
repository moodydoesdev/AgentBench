import { Component, memo, useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, Bell, CaretUp, ImageSquare, Microphone, Robot, Stop, Terminal, X } from "@phosphor-icons/react";
import { LogoMark } from "../components/Logo";
import useDictation from "./useDictation";
import { createChatStore, applyLines, applyLine, applyAsk, addLocalUser } from "./records";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";

// Older sessions can be thousands of messages; mount only the recent tail
// and let "Show earlier" page backwards. content-visibility handles paint,
// this handles mount + markdown-parse cost.
const TAIL = 250;
const PAGE = 500;

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
].map(([name, desc, tui]) => ({ name, desc, source: "built-in", tui: !!tui }));

const TUI_COMMANDS = new Set(
  BUILTIN_COMMANDS.filter((c) => c.tui).map((c) => c.name),
);

// Rows re-render only when their message's rev changes — messages mutate in
// place (tool results, draft tokens), so identity alone isn't enough.
const Row = memo(
  function Row({ msg }) {
    if (msg.kind === "tool") return <ToolCard tool={msg.tool} rev={msg.rev} />;
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
        <div className={`chat-user${msg.local ? " pending" : ""}`}>
          {msg.images?.length > 0 && (
            <div className="chat-user-images">
              {msg.images.map((im, i) => (
                <img key={i} className="chat-user-img" src={im.url} alt="" />
              ))}
            </div>
          )}
          {msg.text}
          {msg.local && <span className="chat-user-spin" aria-label="sending" />}
        </div>
      );
    if (msg.kind === "draft") {
      // plain text while streaming — markdown-parsing a growing message on
      // every token is O(n²) and was the original perf sink
      return <div className="chat-assistant streaming">{msg.text}</div>;
    }
    return (
      <div className="chat-assistant">
        <Markdown text={msg.text} />
      </div>
    );
  },
  // prev.rev is the render-time snapshot; msg.rev mutates in place, so the
  // prop pair is the only reliable change signal
  (prev, next) => prev.msg === next.msg && prev.rev === next.rev,
);

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
  return (
    <div className="chat-sidechain">
      <button className="chat-sidechain-head" onClick={() => setOpen((o) => !o)}>
        <Robot size={11} />
        worked in background · {items.length} step{items.length === 1 ? "" : "s"}
      </button>
      {open && items.map((m) => <Row key={m.key} msg={m} rev={m.rev} />)}
    </div>
  );
}

// user/text stand alone; consecutive tool calls stack into one activity
// block; sidechain runs fold behind a single row.
function groupMessages(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.sidechain) {
      if (last?.type === "sidechain") last.items.push(m);
      else out.push({ type: "sidechain", key: `g-${m.key}`, items: [m] });
    } else if (m.kind === "tool") {
      if (last?.type === "tools") last.items.push(m);
      else out.push({ type: "tools", key: `t-${m.key}`, items: [m] });
    } else {
      out.push({ type: "msg", key: m.key, msg: m });
    }
  }
  return out;
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
  initialLines,
  onSend,
  onStop,
  onNeedsTerm,
  status,
  register,
}) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createChatStore();
  const [, forceRender] = useReducer((n) => n + 1, 0);
  const [waiting, setWaiting] = useState(mode === "transcript");
  const [watchError, setWatchError] = useState(null);
  const [tailCap, setTailCap] = useState(TAIL);
  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef(null);
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
  // Pasted/dropped images staged in the composer: { key, url (data URL), name }.
  // They render inline (WYSIWYG), can be removed, and are written to temp files
  // on send so Claude gets them by path.
  const [images, setImages] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const imgKeyRef = useRef(0);
  const fileInputRef = useRef(null);
  const commandsRef = useRef(null); // merged builtin + custom, fetched once

  // Dictation writes into the textarea, which is uncontrolled — the composer
  // reads el.value directly. Partials are revisions of the whole phrase, so
  // each one replaces the transcript rather than appending: keep whatever was
  // typed before the mic opened and rewrite only the tail after it.
  const dictBaseRef = useRef("");
  const [dictError, setDictError] = useState(null);
  const writeTranscript = (text) => {
    const el = inputRef.current;
    if (!el) return;
    el.value = dictBaseRef.current + text;
    // match the autosize + "/" menu the onInput handler would have done
    el.style.height = "";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
    syncCmdMenu(el.value);
  };
  const dictation = useDictation({
    onPartial: writeTranscript,
    onFinal: (text) => {
      writeTranscript(text);
      const el = inputRef.current;
      if (!el) return;
      // No trailing space: it would leave the box non-empty-looking, which
      // disarms the bare-Space shortcut below and turns every later Space
      // press into another stray space. The separator before the next phrase
      // is added when that phrase starts instead.
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
    onError: setDictError,
  });
  // Whether the current phrase is push-to-talk (⌥Space) rather than a button
  // toggle. Only a held phrase is tied to keys that must be released, so only
  // it should be abandoned when the composer loses focus.
  const dictHoldRef = useRef(false);
  const startDictation = (held) => {
    const el = inputRef.current;
    // Anything already typed is kept and the phrase lands after it, separated
    // by exactly one space however much trailing whitespace is sitting there.
    // A box holding only whitespace counts as empty, so a few stray Space
    // presses can't prefix the message with them.
    const typed = el?.value ?? "";
    dictBaseRef.current = typed.trim() ? typed.replace(/\s+$/, "") + " " : "";
    dictHoldRef.current = held;
    setDictError(null);
    dictation.start();
  };
  const toggleDictation = () =>
    dictation.listening ? dictation.stop() : startDictation(false);

  const loadCommands = () => {
    if (commandsRef.current) return;
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
      ? (commandsRef.current ?? BUILTIN_COMMANDS)
          .filter((c) => c.name.toLowerCase().startsWith(cmdQuery.toLowerCase()))
          // no terminal behind a headless pane — hide dialog-only commands
          .filter((c) => !(mode === "stream" && c.tui))
          .slice(0, 10)
      : [];

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
    const store = storeRef.current;
    let dead = false;
    const unlistens = [];

    // Turn boundaries, straight from the hooks — the transcript lands records
    // after the fact, so it can't tell "mid-turn" from "at rest".
    const onTurn = listen("turn", (e) => {
      if (e.payload.id !== id) return;
      setTurnActive(!!e.payload.active);
      // Turn over: whatever was queued has been consumed (or discarded), so
      // a later stop must not fire a stray Enter.
      if (!e.payload.active) queuedRef.current = false;
    });
    unlistens.push(onTurn);

    if (mode === "transcript") {
      invoke("watch_transcript", { id })
        .then((res) => {
          if (dead) return;
          setWaiting(!res?.sid);
          if (res?.text) {
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
          if (!dead) setWatchError(String(err));
        });
      unlistens.push(
        // storeRef.current, NOT a captured store: transcript-reset swaps the
        // store, and writing into the orphaned one left the pane blank until
        // a remount (the Windows "works after Ctrl+R" bug)
        listen("transcript-lines", (e) => {
          if (e.payload.id !== id) return;
          setWaiting(false);
          if (applyLines(storeRef.current, e.payload.lines)) bump();
        }),
        listen("transcript-reset", (e) => {
          if (e.payload.id !== id) return;
          storeRef.current = createChatStore();
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
  }, [id, mode]);

  useEffect(() => {
    register?.({ focus: () => inputRef.current?.focus() });
    return () => register?.(null);
  }, [id]);

  const submit = async () => {
    const el = inputRef.current;
    // Sending ends any phrase in flight. Without this the recognizer's last
    // result lands after the box is cleared and types the sent message
    // straight back into it — and the image write below can await, widening
    // the window it lands in.
    dictation.cancel();
    dictBaseRef.current = "";
    const text = el?.value.trim() ?? "";
    const imgs = images;
    if (!text && imgs.length === 0) return;

    // Persist staged images to temp files up front — Claude ingests them by
    // path (deterministic), instead of us racing the OS clipboard. If a write
    // fails, fall through and at least send the text.
    let paths = [];
    if (imgs.length && mode === "transcript") {
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
    setImages([]);
    // dialog commands (/resume, /usage, /model…) render in the terminal —
    // flip to Term view so the dialog is actually visible
    const tok = text.startsWith("/") ? text.slice(1).split(/\s+/)[0] : null;
    const opensDialog = tok != null && TUI_COMMANDS.has(tok);
    // Wire text: image paths first (temp names never contain spaces, so no
    // quoting needed), then the user's message. Claude Code loads images
    // referenced by path.
    const wire = paths.length
      ? [...paths, text].filter(Boolean).join(" ")
      : text;
    if (!opensDialog) {
      addLocalUser(storeRef.current, text, imgs.map((im) => ({ url: im.url })));
    }
    // Sending into a live turn means the TUI queues this message — remember
    // that, so a later stop knows to push it through rather than drop it.
    if (workingRef.current) queuedRef.current = true;
    setTurnActive(true); // don't wait on the hook to offer a stop button
    onSend(wire);
    if (opensDialog && mode === "transcript") onNeedsTerm?.();
    atBottomRef.current = true;
    bump();
  };

  // One funnel for every stop affordance, so the queued-message flag is
  // consumed exactly once and a second stop can't fire a stray Enter.
  const stop = () => {
    const resubmit = queuedRef.current;
    queuedRef.current = false;
    onStop?.(resubmit);
  };

  // Stage an image File (from paste, drop, or the picker) as a data URL so it
  // renders immediately and can be written to a temp file on send.
  const addImageFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () =>
      setImages((imgs) => [
        ...imgs,
        {
          key: `img${imgKeyRef.current++}`,
          url: String(reader.result),
          name: file.name || "pasted image",
        },
      ]);
    reader.readAsDataURL(file);
  };

  const removeImage = (key) =>
    setImages((imgs) => imgs.filter((i) => i.key !== key));

  // Capture pasted images into the composer instead of the OS clipboard round
  // trip. If the clipboard also has text, let that paste normally; only
  // swallow the paste when it's image-only (nothing to type).
  const onPaste = (ev) => {
    if (mode !== "transcript") return;
    const items = Array.from(ev.clipboardData?.items ?? []);
    const imageItems = items.filter((it) => it.type.startsWith("image/"));
    if (!imageItems.length) return;
    const hasText = items.some((it) => it.type === "text/plain");
    if (!hasText) ev.preventDefault();
    for (const it of imageItems) addImageFile(it.getAsFile());
  };

  const onDrop = (ev) => {
    if (mode !== "transcript") return;
    const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    setDragOver(false);
    if (!files.length) return;
    ev.preventDefault();
    files.forEach(addImageFile);
  };

  const store = storeRef.current;
  const hiddenCount = Math.max(0, store.messages.length - tailCap);
  const visible = hiddenCount ? store.messages.slice(hiddenCount) : store.messages;
  const groups = groupMessages(visible);
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
  const working = turnActive ?? looksWorking;
  workingRef.current = working;

  // nothing to show yet: the list becomes a centered welcome panel instead
  const empty = groups.length === 0;
  const folder = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "";

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
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        <div className={`chat-col${empty ? " empty" : ""}`}>
          <ChatErrorBoundary>
          {watchError && (
            <pre className="chat-error">
              {`chat view couldn't reach the transcript watcher (${watchError}).\nThe broker probably predates this build — use Settings → Workspace →\nRestart broker (or the command menu's "Restart broker").`}
            </pre>
          )}
          {empty && !watchError && (
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
                <span>paste or drop images</span>
              </div>
            </div>
          )}
          {hiddenCount > 0 && (
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
                  <ToolCard
                    key={m.key}
                    tool={m.tool}
                    rev={m.rev}
                    paneId={id}
                    canAnswer={mode === "transcript"}
                  />
                ))}
              </div>
            ) : (
              <Row key={g.key} msg={g.msg} rev={g.msg.rev} />
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
      <div className="chat-composer">
        <div
          className={`chat-composer-card${dragOver ? " drag-over" : ""}`}
          onDrop={onDrop}
          onDragOver={(ev) => {
            if (mode !== "transcript") return;
            if (Array.from(ev.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
              ev.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={(ev) => {
            if (!ev.currentTarget.contains(ev.relatedTarget)) setDragOver(false);
          }}
        >
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
                  <span className="chat-cmd-src">
                    {c.tui ? "opens in Term" : c.source}
                  </span>
                </button>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="chat-img-tray">
              {images.map((im) => (
                <div key={im.key} className="chat-img-thumb" title={im.name}>
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
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={
              mode === "transcript"
                ? "Message Claude…  ( / for commands · paste or drop an image )"
                : "Message Claude…  ( / for commands )"
            }
            onPaste={onPaste}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              // Push-to-talk, matching Claude Code's own /voice binding: hold
              // Space on an empty box, since there is nothing to append a
              // space to yet. Once there's text, Space has to stay a space, so
              // ⌥Space is the escape hatch for dictating mid-sentence.
              //
              // Checked before everything else so a held key can't also open
              // the "/" menu or submit, and preventDefault'd because Space
              // would otherwise type (and ⌥Space a non-breaking space).
              // `repeat` fires while held — ignore it and let keyup be the
              // only thing that ends the phrase.
              if (dictation.available && ev.code === "Space") {
                const bare =
                  !ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
                // trim(), not === "": a box holding only whitespace still has
                // nothing to append a space to, and treating it as non-empty
                // is what makes repeated Space presses pile up instead of
                // starting a phrase.
                if (ev.altKey || (bare && ev.currentTarget.value.trim() === "")) {
                  ev.preventDefault();
                  if (!ev.repeat) startDictation(true);
                  return;
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
              // Releasing either half of the chord ends a held phrase —
              // letting go of ⌥ first is common and shouldn't strand the mic.
              if (
                dictHoldRef.current &&
                dictation.listening &&
                (ev.code === "Space" || ev.key === "Alt")
              ) {
                ev.preventDefault();
                dictation.stop();
              }
            }}
            onBlur={() => {
              // A held chord can't deliver its keyup once focus is gone, so
              // the mic would stay open forever; drop the phrase. A tapped
              // session is deliberate and survives clicking away.
              if (dictHoldRef.current && dictation.listening) dictation.cancel();
            }}
            onInput={(ev) => {
              const el = ev.currentTarget;
              el.style.height = "";
              el.style.height = Math.min(el.scrollHeight, 160) + "px";
              syncCmdMenu(el.value);
            }}
          />
          <div className="chat-composer-bar">
            <span
              className={`chat-composer-hint${dictError ? " chat-composer-hint-error" : ""}`}
            >
              {dictError
                ? dictError
                : dictation.listening
                  ? "listening — esc to discard"
                  : working
                    ? "working — esc to stop"
                    : "enter to send"}
            </span>
            {mode === "transcript" && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(ev) => {
                    Array.from(ev.target.files ?? []).forEach(addImageFile);
                    ev.target.value = "";
                  }}
                />
                <button
                  className="chat-attach-btn"
                  title="Attach an image"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageSquare size={14} />
                </button>
              </>
            )}
            {dictation.available && (
              <button
                className={`chat-mic-btn${dictation.listening ? " chat-mic-live" : ""}`}
                title={
                  dictation.listening
                    ? "Stop dictating and insert (Esc discards)"
                    : "Dictate — click to toggle, or hold ⌥Space"
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
