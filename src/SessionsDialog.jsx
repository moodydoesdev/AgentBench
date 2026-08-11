// Previous-session browser: lists a project's Claude transcripts (newest
// first) so a past conversation can be resumed into a fresh pane. Pure UI —
// App owns the spawn (spawnAgent with a resume sid). Backends: list_sessions
// for the browse list, search_sessions for the ripgrep-style content search
// (case-insensitive substring over what was actually said, not raw JSON).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  ClockCounterClockwise,
  ArrowUUpLeft,
  MagnifyingGlass,
} from "@phosphor-icons/react";

// compact "3m ago" / "2h ago" / "5d ago" from an epoch-ms timestamp. Uses
// Date.now() (fine in the UI — this isn't a replayable workflow script).
function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

// Excerpt with the query hits emphasized (case-insensitive, plain substring —
// same match rule the backend used to find it).
function Highlight({ text, query }) {
  if (!text) return null;
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const out = [];
  let rest = text;
  let i = rest.toLowerCase().indexOf(q);
  let key = 0;
  while (i !== -1 && out.length < 40) {
    if (i > 0) out.push(rest.slice(0, i));
    out.push(<mark key={key++}>{rest.slice(i, i + q.length)}</mark>);
    rest = rest.slice(i + q.length);
    i = rest.toLowerCase().indexOf(q);
  }
  out.push(rest);
  return out;
}

export default function SessionsDialog({ project, onClose, onResume }) {
  const [sessions, setSessions] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const searchSeq = useRef(0);
  const listRef = useRef(null);

  // Browse list up front; each keystroke re-searches (debounced) and stale
  // responses are dropped by sequence number.
  useEffect(() => {
    const seq = ++searchSeq.current;
    const q = query.trim();
    const run = () =>
      invoke(q ? "search_sessions" : "list_sessions", {
        project: project.path,
        ...(q ? { query: q } : {}),
      })
        .then((s) => {
          if (searchSeq.current !== seq) return;
          setSessions(s);
          setSel(0);
        })
        .catch((e) => searchSeq.current === seq && setError(String(e)));
    if (!q) {
      run();
      return;
    }
    const t = setTimeout(run, 200);
    return () => clearTimeout(t);
  }, [project.path, query]);

  const move = (d) => {
    if (!sessions?.length) return;
    setSel((i) => {
      const next = Math.max(0, Math.min(sessions.length - 1, i + d));
      listRef.current
        ?.querySelector(`[data-idx="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return next;
    });
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    }
    if (e.key === "Enter" && sessions?.[sel]) onResume(sessions[sel].sid);
  };

  const searching = query.trim().length > 0;

  return (
    <div className="composer-backdrop" onMouseDown={onClose} onKeyDown={onKeyDown}>
      <div
        className="composer sessions"
        role="dialog"
        aria-label="Previous sessions"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="composer-head">
          <div>
            <div className="composer-title">
              <ClockCounterClockwise size={15} weight="bold" /> Resume a session —{" "}
              {project.name}
            </div>
            <div className="composer-sub">
              Past Claude conversations in this project. Opening one starts a new
              agent with <code>--resume</code>, picking up where it left off.
            </div>
          </div>
          <button className="btn-icon" title="Close (Esc)" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="sessions-search">
          <MagnifyingGlass size={13} />
          <input
            autoFocus
            placeholder="Search every session — any text that was said…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="btn-icon"
              title="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={11} weight="bold" />
            </button>
          )}
        </div>

        <div className="sessions-list" ref={listRef}>
          {error && <div className="sessions-empty">Couldn't read sessions: {error}</div>}
          {!error && sessions == null && (
            <div className="sessions-empty">Loading sessions…</div>
          )}
          {!error && sessions?.length === 0 && (
            <div className="sessions-empty">
              {searching
                ? `Nothing in any session matches “${query.trim()}”.`
                : "No previous Claude sessions in this project yet."}
            </div>
          )}
          {sessions?.map((s, i) => (
            <button
              key={s.sid}
              data-idx={i}
              className={`sessions-row rich${i === sel ? " sel" : ""}`}
              onClick={() => onResume(s.sid)}
              onMouseEnter={() => setSel(i)}
              title={`Resume ${s.sid}`}
            >
              <span className="sessions-main">
                <span className="sessions-title">
                  {s.title || s.preview || (
                    <span className="sessions-noprev">(no message text)</span>
                  )}
                </span>
                {searching ? (
                  <span className="sessions-excerpt">
                    <span className={`sessions-role ${s.role}`}>
                      {s.role === "assistant" ? "claude" : "you"}
                    </span>{" "}
                    <Highlight text={s.excerpt} query={query} />
                  </span>
                ) : (
                  (s.lastText || (s.title && s.preview)) && (
                    <span className="sessions-excerpt">
                      {s.lastText ? (
                        <>
                          <span className="sessions-role assistant">claude</span>{" "}
                          {s.lastText}
                        </>
                      ) : (
                        s.preview
                      )}
                    </span>
                  )
                )}
                <span className="sessions-meta">
                  {ago(s.mtime)} · {s.msgs} msg{s.msgs === 1 ? "" : "s"}
                  {searching &&
                    ` · ${s.matches} match${s.matches === 1 ? "" : "es"}`}
                </span>
              </span>
              <ArrowUUpLeft className="sessions-go" size={14} weight="bold" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
