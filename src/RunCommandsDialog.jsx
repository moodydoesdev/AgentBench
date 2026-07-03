// Per-project run commands editor: named command lines ("dev" → "bun run
// dev") that spawn run panes. Pure UI — App owns storage (project entry) and
// spawning. First row is the default the topbar Run button fires.
import { useState } from "react";
import { X, Plus, Trash } from "@phosphor-icons/react";

let nextId = 0;
const freshRow = () => ({ id: `new-${Date.now()}-${nextId++}`, name: "", command: "" });

export default function RunCommandsDialog({
  project, // {path, name, commands?}
  onClose,
  onSave, // (commands: [{id, name, command}]) => void
}) {
  const [rows, setRows] = useState(() =>
    project?.commands?.length ? project.commands.map((c) => ({ ...c })) : [freshRow()],
  );

  const set = (id, key) => (e) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: e.target.value } : r)));

  const removeRow = (id) =>
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs.map(() => freshRow())));

  // drop empty rows; a command without a name gets its command line as name
  const cleaned = rows
    .filter((r) => r.command.trim())
    .map((r) => ({ ...r, name: r.name.trim() || r.command.trim(), command: r.command.trim() }));

  const submit = () => onSave(cleaned);

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <div className="composer-backdrop" onMouseDown={onClose} onKeyDown={onKeyDown}>
      <div
        className="composer runcmd"
        role="dialog"
        aria-label="Run commands"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="composer-head">
          <div>
            <div className="composer-title">Run commands — {project?.name}</div>
            <div className="composer-sub">
              Run in the project folder through your login shell — anything on
              your PATH works. The first command is the default for the Run
              button.
            </div>
          </div>
          <button className="btn-icon" title="Close (Esc)" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="runcmd-labels">
          <label className="composer-label">Name</label>
          <label className="composer-label">Command</label>
        </div>
        <div className="runcmd-rows">
          {rows.map((r, i) => (
            <div className="runcmd-row" key={r.id}>
              <input
                className="composer-input runcmd-name"
                placeholder={i === 0 ? "dev" : "name"}
                autoFocus={i === 0}
                value={r.name}
                onChange={set(r.id, "name")}
              />
              <input
                className="composer-input runcmd-cmd"
                placeholder={i === 0 ? "bun run dev" : "command"}
                value={r.command}
                onChange={set(r.id, "command")}
                spellCheck={false}
              />
              <span
                className="runcmd-default"
                style={{ visibility: i === 0 ? "visible" : "hidden" }}
              >
                default
              </span>
              <button
                className="btn-icon"
                title="Remove command"
                onClick={() => removeRow(r.id)}
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>

        <button
          className="composer-btn runcmd-add"
          onClick={() => setRows((rs) => [...rs, freshRow()])}
        >
          <Plus size={11} weight="bold" /> Add command
        </button>

        <footer className="composer-foot">
          <button className="composer-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="composer-btn primary" title="⌘↩ also saves" onClick={submit}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
