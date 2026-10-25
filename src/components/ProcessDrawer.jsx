import { useEffect, useRef, useState } from "react";
import { Stop, Terminal } from "@phosphor-icons/react";
import { formatBytes } from "../lib/resourceFormat";

function formatAge(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/**
 * What an agent is running right now — each Bash call, build, dev server —
 * with a Stop per command (Ctrl+C, then harder; see the broker's
 * stop_command) and its background tasks' live output. Data rides the
 * broker's `resources` broadcast, so it refreshes every few seconds.
 */
export default function ProcessDrawer({ commands = [], background = [], onStop, onFollow, onClose }) {
  const ref = useRef(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [stopping, setStopping] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.(".pane-running"))
        onClose();
    };
    const key = (e) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const stop = async (cmd) => {
    setStopping((s) => ({ ...s, [cmd.pid]: true }));
    setError(null);
    try {
      await onStop(cmd);
    } catch (err) {
      setStopping(({ [cmd.pid]: _, ...rest }) => rest);
      setError(String(err));
    }
  };

  // Background shells show up twice — as a process and as a task — so the
  // task list only carries real task ids (tool-use ids are transient).
  const tasks = background.filter((t) => !t.startsWith("toolu_"));

  return (
    <div className="proc-drawer" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <div className="proc-drawer-head">Running in this agent</div>
      {commands.length === 0 && tasks.length === 0 && (
        <div className="proc-drawer-empty">Nothing running right now.</div>
      )}
      {commands.map((c) => (
        <div key={`${c.pid}-${c.start}`} className={`proc-row${stopping[c.pid] ? " stopping" : ""}`}>
          <div className="proc-main">
            <code className="proc-cmd" title={c.command}>
              {c.command || "(unnamed process)"}
            </code>
            <span className="proc-meta">
              {formatAge(Math.max(0, now - c.start))} · {(c.cpu_percent ?? 0).toFixed(1)}% CPU ·{" "}
              {formatBytes(c.resident_bytes ?? 0)}
              {c.processes > 1 ? ` · ${c.processes} processes` : ""}
            </span>
          </div>
          <button
            className="proc-stop"
            disabled={!!stopping[c.pid]}
            title="Stop it: Ctrl+C, then terminate, then kill if it won't go"
            onClick={() => stop(c)}
          >
            <Stop size={11} weight="fill" />
            {stopping[c.pid] ? "Stopping…" : "Stop"}
          </button>
        </div>
      ))}
      {tasks.length > 0 && (
        <>
          <div className="proc-drawer-head sub">Background tasks</div>
          {tasks.map((t) => (
            <div key={t} className="proc-row">
              <div className="proc-main">
                <code className="proc-cmd">task {t}</code>
              </div>
              <button className="proc-follow" onClick={() => onFollow(t)}>
                <Terminal size={11} /> Follow output
              </button>
            </div>
          ))}
        </>
      )}
      {error && <div className="proc-drawer-error">{error}</div>}
    </div>
  );
}
