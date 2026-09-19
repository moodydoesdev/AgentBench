import { useEffect, useState } from "react";
import { CaretDown, CircleNotch, Pulse, Robot, Terminal, X, CalendarCheck } from "@phosphor-icons/react";
import { clearFinished, clearUnconfirmed, useTasks } from "./taskRegistry";
import { LogoMark } from "../components/Logo";

// Background Tasks rail: the app-level view of everything long-running —
// sub-agents and background shells across every chat pane, plus scheduled
// runs. Mirrors the plans rail chrome (right-side aside, hideable).

function baseName(path) {
  return path ? path.split(/[\\/]/).filter(Boolean).pop() : "";
}

function elapsed(ts, now) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const KIND_ICON = {
  agent: Robot,
  shell: Terminal,
  schedule: CalendarCheck,
};

function TaskRow({ row, now, done, unconfirmed, paneLabel, onOpen }) {
  const Icon = KIND_ICON[row.kind] ?? Robot;
  const [expanded, setExpanded] = useState(false);
  const stale = !done && !!unconfirmed;
  return (
    <div className="task-entry">
    <button
      aria-expanded={expanded}
      className={`task-item${done ? " done" : ""}${row.failed ? " failed" : ""}`}
      title={row.detail || row.label}
      onClick={() => setExpanded((value) => !value)}
    >
      <Icon size={13} className="task-icon" />
      <span className="task-body">
        <span className="task-label">{row.label}</span>
        <span className="task-sub">
          {[paneLabel, baseName(row.projectPath)].filter(Boolean).join(" · ")}
        </span>
      </span>
      {done ? (
        <span className="task-time">
          {row.failed ? "failed" : elapsed(row.endedAt, now) + " ago"}
        </span>
      ) : (
        <>
          <span className="task-time">{elapsed(row.startedAt, now)}</span>
          {!stale && <CircleNotch size={11} className="task-spin" />}
        </>
      )}
    </button>
    {stale && <div className="task-quiet">No confirmed completion · not counted as active</div>}
    {expanded && (
      <div className="task-details">
        <strong>{row.label}</strong>
        {row.detail && <pre>{row.detail}</pre>}
        <span className="task-sub">{done ? (row.failed ? "Failed" : "Finished") : stale ? "Last update " + elapsed(row.updatedAt || row.startedAt, now) + " ago" : "In progress"}</span>
        <pre>{row.output || "No output received yet."}</pre>
        <button className="task-open" onClick={() => onOpen(row)}>Open conversation</button>
      </div>
    )}
    </div>
  );
}

export default function TaskRail({ panes, titles, onOpenTask, onClose }) {
  const { running, unconfirmed, finished } = useTasks();
  const [showUnconfirmed, setShowUnconfirmed] = useState(false);
  const [showFinished, setShowFinished] = useState(true);
  // elapsed labels tick while anything runs
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, [running.length]);

  const paneLabel = (row) => {
    const p = panes.find((x) => x.id === row.paneId);
    return p ? titles[p.id] || p.label : null;
  };

  return (
    <aside className="task-rail">
      <div className="plan-rail-head">
        <Pulse size={13} />
        <span className="plan-rail-head-label">Background tasks</span>
        <button className="btn-icon" title="Hide background tasks" onClick={onClose}>
          <X size={12} weight="bold" />
        </button>
      </div>
      <div className="task-rail-list">
        <div className="task-section">
          Recently active{running.length > 0 ? ` · ${running.length}` : ""}
        </div>
        {running.length === 0 && (
          <div className="task-empty">
            <LogoMark className="rail-empty-mark" aria-hidden="true" />
            No recent task activity. Sub-agents, background shells and scheduled runs
            show up here across every pane and project.
          </div>
        )}
        {running.map((row) => (
          <TaskRow
            key={row.key}
            row={row}
            now={now}
            paneLabel={paneLabel(row)}
            onOpen={onOpenTask}
          />
        ))}
        {unconfirmed.length > 0 && <>
          <div className="task-section task-section-toggle">
            <button className="task-open" onClick={() => setShowUnconfirmed((v) => !v)} aria-expanded={showUnconfirmed}>
              Unconfirmed · {unconfirmed.length} {showUnconfirmed ? "▴" : "▾"}
            </button>
            <button className="task-clear" title="Dismiss unconfirmed entries; does not stop any processes" onClick={clearUnconfirmed}>Dismiss</button>
          </div>
          {showUnconfirmed && <>
            <p className="task-quiet">These entries lack a completion notice. Their age does not mean a process is still running.</p>
            {unconfirmed.map((row) => <TaskRow key={row.key} row={row} now={now} unconfirmed paneLabel={paneLabel(row)} onOpen={onOpenTask}/>) }
          </>}
        </>}
        {finished.length > 0 && (
          <>
            <button
              className="task-section task-section-toggle"
              onClick={() => setShowFinished((s) => !s)}
            >
              Finished · {finished.length}
              <CaretDown
                size={9}
                weight="bold"
                className={showFinished ? "" : "flip"}
              />
              <span
                className="task-clear"
                role="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  clearFinished();
                }}
              >
                Clear
              </span>
            </button>
            {showFinished &&
              finished.map((row) => (
                <TaskRow
                  key={`f:${row.key}:${row.endedAt}`}
                  row={row}
                  now={now}
                  done
                  paneLabel={paneLabel(row)}
                  onOpen={onOpenTask}
                />
              ))}
          </>
        )}
      </div>
    </aside>
  );
}
