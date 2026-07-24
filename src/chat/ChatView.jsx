import { Component, memo, useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, Bell, CaretUp, ImageSquare, Info, Robot, Stop, Terminal, X } from "@phosphor-icons/react";
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
    // a slash command in the transcript is an event, not something the user
    // "said" — some (auto-compact) the harness runs on its own, so it's shown
    // as a centered command pill, never a right-aligned user bubble
    if (msg.kind === "command")
      return (
        <div className="chat-cmd-event">
          <Terminal size={11} weight="bold" />
          <code>/{msg.text}</code>
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
  const [diag, setDiag] = useState(null); // broker's view of sid/path/exists
  const [showDebug, setShowDebug] = useState(false);
  const [tailCap, setTailCap] = useState(TAIL);
  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef(null);
  const rafRef = useRef(0);
  const lastRevRef = useRef(0);

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

    if (mode === "transcript") {
      invoke("watch_transcript", { id })
        .then((res) => {
          if (dead) return;
          setWaiting(!res?.sid);
          setDiag(res);
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
    onSend(wire);
    if (opensDialog && mode === "transcript") onNeedsTerm?.();
    atBottomRef.current = true;
    bump();
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
  const working =
    !!store.draft ||
    (last &&
      (last.kind === "draft" ||
        (last.kind === "tool" && !last.tool.done) ||
        last.role === "user"));

  return (
    <div className="chat-view">
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        <div className="chat-col">
          <ChatErrorBoundary>
          {watchError && (
            <pre className="chat-error">
              {`chat view couldn't reach the transcript watcher (${watchError}).\nThe broker probably predates this build — use Settings → Workspace →\nRestart broker (or the command menu's "Restart broker").`}
            </pre>
          )}
          {waiting && !watchError && groups.length === 0 && (
            <div className="chat-waiting">
              waiting for session… (starts with the first message)
            </div>
          )}
          {/* empty list + a watch response = something's off; show the
              broker's view so a screenshot is enough to debug */}
          {groups.length === 0 && !watchError && diag && (
            <pre className="chat-diag">
              {[
                `sid: ${diag.sid ?? "none yet"}`,
                `sessions seen: ${diag.hist ?? 0}`,
                diag.path ? `transcript: ${diag.path}` : "transcript: (no session id from hooks yet)",
                diag.path ? `exists: ${diag.exists ? "yes" : "NO — path mismatch?"}` : null,
                `cwd: ${diag.cwd ?? ""}`,
              ]
                .filter(Boolean)
                .join("\n")}
            </pre>
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
        {showDebug && (
          <pre className="chat-diag chat-diag-panel">
            {[
              `mode: ${mode} · messages: ${store.messages.length} · groups: ${groups.length} · rev: ${store.rev}`,
              `record types: ${JSON.stringify(store.typeCounts)}`,
              `pending echoes: ${store.pending.length} · working: ${working ? "yes" : "no"}`,
              diag
                ? `sid: ${diag.sid ?? "none"} · hist: ${diag.hist} · exists: ${diag.exists}\npath: ${diag.path}\ncwd: ${diag.cwd}`
                : "no watch response yet",
              watchError ? `error: ${watchError}` : null,
            ]
              .filter(Boolean)
              .join("\n")}
          </pre>
        )}
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
              if (ev.key === "Escape" && working) onStop?.();
            }}
            onInput={(ev) => {
              const el = ev.currentTarget;
              el.style.height = "";
              el.style.height = Math.min(el.scrollHeight, 160) + "px";
              syncCmdMenu(el.value);
            }}
          />
          <div className="chat-composer-bar">
            <span className="chat-composer-hint">
              {working ? "working — esc to stop" : "enter to send"}
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
            <button
              className={`chat-debug-btn${showDebug ? " on" : ""}`}
              title="Chat pipeline debug info"
              onClick={() => setShowDebug((s) => !s)}
            >
              <Info size={13} />
            </button>
            {working && (
              <button
                className="chat-stop"
                title="Stop the current turn (Esc)"
                onClick={() => onStop?.()}
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
