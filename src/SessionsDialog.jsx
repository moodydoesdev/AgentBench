// Previous-session browser: lists a project's Claude transcripts (newest
// first) so a past conversation can be resumed into a fresh pane. Pure UI —
// App owns the spawn (spawnAgent with a resume sid). Backend: list_sessions.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, ClockCounterClockwise, ArrowUUpLeft } from "@phosphor-icons/react";

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

export default function SessionsDialog({ project, onClose, onResume }) {
  const [sessions, setSessions] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    let dead = false;
    invoke("list_sessions", { project: project.path })
      .then((s) => !dead && setSessions(s))
      .catch((e) => !dead && setError(String(e)));
    return () => {
      dead = true;
    };
  }, [project.path]);

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
  };

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

        <div className="sessions-list">
          {error && <div className="sessions-empty">Couldn't read sessions: {error}</div>}
          {!error && sessions == null && (
            <div className="sessions-empty">Loading sessions…</div>
          )}
          {!error && sessions?.length === 0 && (
            <div className="sessions-empty">
              No previous Claude sessions in this project yet.
            </div>
          )}
          {sessions?.map((s) => (
            <button
              key={s.sid}
              className="sessions-row"
              onClick={() => onResume(s.sid)}
              title={`Resume ${s.sid}`}
            >
              <span className="sessions-preview">
                {s.preview || <span className="sessions-noprev">(no message text)</span>}
              </span>
              <span className="sessions-meta">
                {ago(s.mtime)} · {s.msgs} msg{s.msgs === 1 ? "" : "s"}
              </span>
              <ArrowUUpLeft className="sessions-go" size={14} weight="bold" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
