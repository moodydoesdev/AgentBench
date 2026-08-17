// Scheduled prompts: list / edit / run history. Pure UI over the broker's
// schedule ops — the daemon owns the data and fires the runs, so everything
// here re-renders from its `schedules` broadcast rather than local state.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Plus, Play, Trash, PauseCircle, PlayCircle, ArrowSquareOut } from "@phosphor-icons/react";
import {
  DAY_LABELS,
  cadenceLabel,
  fmtWhen,
  fmtNext,
  fmtDuration,
  freshSchedule,
} from "./lib/scheduleFormat";

const emptyForm = (projects) => freshSchedule(projects[0]?.path ?? "");

// The broker daemon survives app updates; a stale one answers every schedule
// op with a bare "unknown op" — translate that into the actual fix.
const friendly = (e) => {
  const s = String(e?.message ?? e);
  return /unknown op/i.test(s)
    ? "This broker predates schedules. Restart it (Settings → Workspace → Restart broker) and reopen this dialog."
    : s;
};

function ScheduleForm({ initial, projects, onCancel, onSaved }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setCad = (patch) => setForm((f) => ({ ...f, cadence: { ...f.cadence, ...patch } }));
  const kind = form.cadence.kind;

  const save = () => {
    setError(null);
    invoke("schedule_save", { schedule: form })
      .then(onSaved)
      .catch((e) => setError(friendly(e)));
  };

  return (
    <div className="sched-form">
      <div className="sched-form-row">
        <input
          className="composer-input"
          placeholder="Name — e.g. Acme email triage"
          autoFocus
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <select
          className="composer-input sched-select"
          value={form.cwd}
          onChange={(e) => set({ cwd: e.target.value })}
        >
          {!projects.some((p) => p.path === form.cwd) && form.cwd && (
            <option value={form.cwd}>{form.cwd}</option>
          )}
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name || p.path}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="composer-input sched-prompt"
        placeholder={
          "The exact message each run sends, e.g.\n" +
          "Read today's unread emails from client X (via the mail MCP). For each reported issue: reproduce it, fix it in this repo, and note the change. Then DRAFT (do not send) a status reply email summarizing findings and fixes."
        }
        rows={6}
        value={form.prompt}
        onChange={(e) => set({ prompt: e.target.value })}
      />
      <div className="sched-form-row">
        <select
          className="composer-input sched-select"
          value={kind}
          onChange={(e) => setCad({ kind: e.target.value })}
        >
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
          <option value="interval">Every N hours</option>
        </select>
        {kind === "interval" ? (
          <input
            className="composer-input sched-time"
            type="number"
            min="1"
            title="Hours between runs (first run starts right away)"
            value={Math.max(1, Math.round((form.cadence.everyMin ?? 60) / 60))}
            onChange={(e) => setCad({ everyMin: Math.max(1, Number(e.target.value) || 1) * 60 })}
          />
        ) : (
          <input
            className="composer-input sched-time"
            type="time"
            value={form.cadence.time ?? "08:00"}
            onChange={(e) => setCad({ time: e.target.value })}
          />
        )}
        {kind === "weekly" && (
          <div className="sched-days">
            {DAY_LABELS.map((label, i) => {
              const day = i + 1;
              const on = (form.cadence.days ?? []).includes(day);
              return (
                <button
                  key={day}
                  className={`sched-day${on ? " on" : ""}`}
                  onClick={() =>
                    setCad({
                      days: on
                        ? form.cadence.days.filter((d) => d !== day)
                        : [...(form.cadence.days ?? []), day].sort(),
                    })
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <label className="sched-check">
        <input
          type="checkbox"
          checked={form.closePrevious}
          onChange={(e) => set({ closePrevious: e.target.checked })}
        />
        Close the previous run's pane when a new run starts
      </label>
      {error && <div className="sched-error">{error}</div>}
      <div className="sched-form-actions">
        <button className="composer-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="composer-btn primary" onClick={save}>
          Save schedule
        </button>
      </div>
    </div>
  );
}

export default function SchedulesDialog({ projects, livePaneIds, onClose, onOpenRun }) {
  const [data, setData] = useState(null); // { schedules, runs }
  const [sel, setSel] = useState(null); // selected schedule id (runs list)
  const [editing, setEditing] = useState(null); // form model, or null
  const [error, setError] = useState(null);
  const boxRef = useRef(null);

  useEffect(() => {
    // list view has no focusable child, and the Escape handler lives on the
    // backdrop — without focus inside, Escape never fires
    boxRef.current?.focus();
    let dead = false;
    invoke("schedules")
      .then((d) => !dead && setData(d))
      .catch((e) => !dead && setError(friendly(e)));
    const un = listen("schedules", (e) => setData(e.payload));
    return () => {
      dead = true;
      un.then((f) => f());
    };
  }, []);

  // Open guard: a retired run resumes by session id, and the broker silently
  // starts a FRESH session when the transcript is gone — the user would reply
  // into a context-free conversation labeled as the run. Verify first.
  const openRun = async (run, schedule) => {
    if (livePaneIds?.includes(run.paneId)) {
      onOpenRun(run, schedule);
      return;
    }
    if (!run.sessionId) return;
    try {
      const sessions = await invoke("list_sessions", { project: schedule.cwd });
      if (!sessions?.some((s) => s.sid === run.sessionId)) {
        setError("This run's transcript is no longer on disk, so it can't be reopened.");
        return;
      }
    } catch {
      /* can't verify — fall through and try */
    }
    onOpenRun(run, schedule);
  };

  const schedules = data?.schedules ?? [];
  const runs = (data?.runs ?? []).slice().sort((a, b) => b.startedAt - a.startedAt);
  const selRuns = sel ? runs.filter((r) => r.scheduleId === sel) : [];
  const lastRunOf = (id) => runs.find((r) => r.scheduleId === id);

  const runNow = (id) =>
    invoke("schedule_run", { id }).catch((e) => setError(friendly(e)));
  const toggle = (s) =>
    invoke("schedule_save", { schedule: { ...s, enabled: !s.enabled } }).catch((e) =>
      setError(friendly(e)),
    );
  const remove = (id) =>
    invoke("schedule_delete", { id })
      .then(() => setEditing(null))
      .catch((e) => setError(friendly(e)));

  return (
    <div
      className="composer-backdrop"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") (editing ? setEditing(null) : onClose());
      }}
    >
      <div
        className="composer sched-dialog"
        role="dialog"
        aria-label="Schedules"
        tabIndex={-1}
        ref={boxRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="composer-head">
          <div>
            <div className="composer-title">Schedules</div>
            <div className="composer-sub">
              Saved prompts the broker runs on a timer — each run is a normal
              chat session you can open, review, and reply to.
            </div>
          </div>
          <button
            className="composer-btn primary sched-new"
            onClick={() => {
              setSel(null);
              setEditing(emptyForm(projects));
            }}
          >
            <Plus size={11} weight="bold" /> New schedule
          </button>
          <button className="btn-icon" title="Close (Esc)" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </header>

        {editing ? (
          <ScheduleForm
            initial={editing}
            projects={projects}
            onCancel={() => setEditing(null)}
            onSaved={() => setEditing(null)}
          />
        ) : (
          <div className="sched-body">
            {schedules.length === 0 && (
              <div className="sched-empty">
                No schedules yet. A schedule is a prompt that runs in a project
                on a cadence — "every morning, triage client email, fix the
                reported issues, draft a reply."
              </div>
            )}
            {schedules.map((s) => {
              const last = lastRunOf(s.id);
              return (
                <div key={s.id} className={`sched-row${sel === s.id ? " sel" : ""}`}>
                  <button className="sched-row-main" onClick={() => setSel(sel === s.id ? null : s.id)}>
                    <span className="sched-name">{s.name}</span>
                    <span className="sched-meta">
                      {projects.find((p) => p.path === s.cwd)?.name ?? s.cwd} ·{" "}
                      {cadenceLabel(s)} ·{" "}
                      {s.enabled ? `next ${fmtNext(s.nextAt)}` : "paused"}
                    </span>
                  </button>
                  {last && (
                    <span className={`sched-pill ${last.status}`}>
                      {last.status === "running" ? "running" : last.status === "done" ? "last run ok" : "last run failed"}
                    </span>
                  )}
                  <button
                    className="btn-icon"
                    title="Run now"
                    onClick={() => runNow(s.id)}
                  >
                    <Play size={13} weight="fill" />
                  </button>
                  <button
                    className="btn-icon"
                    title={s.enabled ? "Pause schedule" : "Resume schedule"}
                    onClick={() => toggle(s)}
                  >
                    {s.enabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                  </button>
                  <button
                    className="btn-icon"
                    title="Edit"
                    onClick={() => setEditing({ ...s })}
                  >
                    Edit
                  </button>
                  <button
                    className="btn-icon"
                    title="Delete schedule (runs' transcripts stay on disk)"
                    onClick={() => remove(s.id)}
                  >
                    <Trash size={13} />
                  </button>
                </div>
              );
            })}
            {sel && (
              <div className="sched-runs">
                {selRuns.length === 0 && <div className="sched-empty">No runs yet.</div>}
                {selRuns.map((r) => (
                  <div key={r.id} className="sched-run">
                    <span className={`sched-pill ${r.status}`}>{r.status}</span>
                    <span className="sched-run-when">
                      {fmtWhen(r.startedAt)} · {fmtDuration(r)}
                      {r.error ? ` · ${r.error}` : ""}
                    </span>
                    <span className="sched-spacer" />
                    {(livePaneIds?.includes(r.paneId) || r.sessionId) && (
                      <button
                        className="btn-icon"
                        title="Open this run's conversation"
                        onClick={() => openRun(r, schedules.find((s) => s.id === r.scheduleId))}
                      >
                        <ArrowSquareOut size={13} /> Open
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {error && <div className="sched-error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
