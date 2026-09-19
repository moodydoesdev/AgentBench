// Per-project team editor: named sets of agent roles saved to
// <project>/.agentbench/teams.json. Edits stay local until Save, which
// rewrites the whole file. Start/Stop hand off to App, which owns panes.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Plus, Trash, UsersThree, CopySimple, Play, Stop } from "@phosphor-icons/react";
import {
  blankAgent,
  blankTeam,
  normalizeTeams,
  serializeTeams,
  teamFromPanes,
  validateTeam,
} from "./teams";

export default function TeamsDialog({
  project, // {path, name}
  panes, // this project's open panes
  titles, // pane id → displayed title
  harnesses, // [{id, name}]
  onClose,
  onSaved, // file written
  onLaunch, // (team) => start its missing agents
  onStop, // (team) => kill its running agents
}) {
  const [teams, setTeams] = useState(null); // null while loading
  const [selected, setSelected] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke("list_teams", { project: project.path })
      .then((raw) => {
        if (!alive) return;
        const list = normalizeTeams(raw);
        setTeams(list);
        setSelected(list[0]?.id ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        // don't offer a save that would overwrite a file we couldn't parse
        setLoadError(String(e));
        setTeams([]);
      });
    return () => { alive = false; };
  }, [project.path]);

  const team = teams?.find((t) => t.id === selected) ?? null;

  const change = (fn) => {
    setTeams((ts) => ts.map((t) => (t.id === selected ? fn(t) : t)));
    setDirty(true);
    setError(null);
  };
  const setField = (key) => (e) => change((t) => ({ ...t, [key]: e.target.value }));
  const setAgent = (i, key) => (e) =>
    change((t) => {
      const agents = t.agents.map((a, j) => (j === i ? { ...a, [key]: e.target.value } : a));
      // renaming the default target's role carries the target along
      const defaultTarget =
        key === "role" && t.defaultTarget === t.agents[i].role ? e.target.value : t.defaultTarget;
      return { ...t, agents, defaultTarget };
    });
  const removeAgent = (i) =>
    change((t) => {
      const agents = t.agents.filter((_, j) => j !== i);
      const defaultTarget = agents.some((a) => a.role === t.defaultTarget)
        ? t.defaultTarget
        : agents[0]?.role ?? "";
      return { ...t, agents, defaultTarget };
    });

  const addTeam = (t) => {
    setTeams((ts) => [...ts, t]);
    setSelected(t.id);
    setDirty(true);
    setError(null);
  };
  const deleteTeam = () => {
    const rest = teams.filter((t) => t.id !== selected);
    setTeams(rest);
    setSelected(rest[0]?.id ?? null);
    setDirty(true);
    setError(null);
  };

  const agentPanes = panes.filter((p) => p.kind !== "run");
  const snapshot = () => {
    const t = teamFromPanes(agentPanes, titles, "");
    if (!t.agents.length) {
      setError("No agent panes are open in this project");
      return;
    }
    let n = teams.length + 1;
    while (teams.some((o) => o.name === `Team ${n}`)) n++;
    addTeam({ ...t, name: `Team ${n}` });
  };

  // Launching uses the saved file's version of the team, so unsaved edits
  // are saved first.
  const save = async (launch = null) => {
    for (const t of teams) {
      const problem = validateTeam(t, teams);
      if (problem) {
        setSelected(t.id);
        setError(problem);
        return;
      }
    }
    setSaving(true);
    try {
      if (dirty) {
        await invoke("save_teams", { project: project.path, teams: serializeTeams(teams) });
        setDirty(false);
        onSaved?.();
      }
      onClose();
      if (launch) onLaunch?.(launch);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !loadError && dirty) save();
  };

  const knownHarness = (id) => harnesses.some((h) => h.id === id);
  const runningCount = (t) => panes.filter((p) => p.team?.team_id === t.id).length;

  return (
    <div className="composer-backdrop" onMouseDown={onClose} onKeyDown={onKeyDown}>
      <div
        className="composer teams"
        role="dialog"
        aria-label="Teams"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="composer-head">
          <div>
            <div className="composer-title">Teams — {project.name}</div>
            <div className="composer-sub">
              Saved to <code>.agentbench/teams.json</code> in the project, so you
              can commit it. Role names are what the agents call each other.
            </div>
          </div>
          <button className="btn-icon" title="Close (Esc)" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </header>

        {loadError && (
          <div className="teams-error">
            Couldn't read teams.json — fix or remove it first. {loadError}
          </div>
        )}

        {teams && !loadError && (
          <div className="teams-body">
            <aside className="teams-list">
              {teams.map((t) => (
                <button
                  key={t.id}
                  className={`teams-item${t.id === selected ? " on" : ""}`}
                  onClick={() => setSelected(t.id)}
                >
                  <span>{t.name || "Untitled team"}</span>
                  <small>
                    {t.agents.length} agents
                    {runningCount(t) > 0 && <span className="teams-running"> · {runningCount(t)} running</span>}
                  </small>
                </button>
              ))}
              {!teams.length && <p className="teams-empty">No teams yet.</p>}
              <button className="composer-btn" onClick={() => addTeam(blankTeam(""))}>
                <Plus size={11} weight="bold" /> New team
              </button>
              <button
                className="composer-btn"
                title="Make a team from the agent panes open in this project"
                disabled={!agentPanes.length}
                onClick={snapshot}
              >
                <CopySimple size={11} weight="bold" /> From open panes
              </button>
            </aside>

            {team ? (
              <section className="teams-editor">
                <div className="teams-fields">
                  <label className="composer-label">
                    Name
                    <input
                      className="composer-input"
                      placeholder="Hexa"
                      autoFocus={!team.name}
                      value={team.name}
                      onChange={setField("name")}
                    />
                  </label>
                  <label className="composer-label">
                    Layout
                    <select className="composer-input" value={team.layout} onChange={setField("layout")}>
                      <option value="focus">Focus — one agent, others as previews</option>
                      <option value="split">Split — all agents side by side</option>
                    </select>
                  </label>
                  <label className="composer-label">
                    Messages go to
                    <select
                      className="composer-input"
                      value={team.defaultTarget}
                      onChange={setField("defaultTarget")}
                    >
                      {team.agents.map((a, i) => (
                        <option key={i} value={a.role}>{a.role || `Agent ${i + 1}`}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="teams-agents">
                  {team.agents.map((a, i) => (
                    <div className="teams-agent" key={i}>
                      <div className="teams-agent-row">
                        <input
                          className="composer-input teams-role"
                          placeholder="Role, e.g. Developer 1"
                          value={a.role}
                          onChange={setAgent(i, "role")}
                        />
                        <select className="composer-input teams-harness" value={a.harness} onChange={setAgent(i, "harness")}>
                          {!knownHarness(a.harness) && <option value={a.harness}>{a.harness} (missing)</option>}
                          {harnesses.map((h) => (
                            <option key={h.id} value={h.id}>{h.name}</option>
                          ))}
                        </select>
                        <input
                          className="composer-input teams-model"
                          placeholder="model (default)"
                          value={a.model}
                          onChange={setAgent(i, "model")}
                          spellCheck={false}
                        />
                        <button className="btn-icon" title="Remove agent" onClick={() => removeAgent(i)}>
                          <Trash size={13} />
                        </button>
                      </div>
                      <textarea
                        className="composer-area teams-instructions"
                        rows={2}
                        placeholder={`Instructions for ${a.role || "this agent"} — what it owns, who it reports to`}
                        value={a.instructions}
                        onChange={setAgent(i, "instructions")}
                      />
                    </div>
                  ))}
                </div>

                <div className="teams-actions">
                  <button
                    className="composer-btn"
                    onClick={() => change((t) => ({ ...t, agents: [...t.agents, blankAgent("")] }))}
                  >
                    <Plus size={11} weight="bold" /> Add agent
                  </button>
                  <button className="composer-btn teams-delete" onClick={deleteTeam}>
                    <Trash size={11} /> Delete team
                  </button>
                  <span className="teams-run">
                    {runningCount(team) > 0 && (
                      <button
                        className="composer-btn"
                        title="Kill this team's running agents"
                        onClick={() => { onClose(); onStop?.(team); }}
                      >
                        <Stop size={11} weight="fill" /> Stop
                      </button>
                    )}
                    <button
                      className="composer-btn primary"
                      title={dirty ? "Save changes, then start the agents that aren't running" : "Start the agents that aren't running"}
                      disabled={saving}
                      onClick={() => save(team)}
                    >
                      <Play size={11} weight="fill" />
                      {runningCount(team) > 0 ? " Start missing" : dirty ? " Save & start" : " Start team"}
                    </button>
                  </span>
                </div>
              </section>
            ) : (
              <section className="teams-editor teams-placeholder">
                <UsersThree size={28} />
                <p>Create a team, or save the agents you have open as one.</p>
              </section>
            )}
          </div>
        )}

        <footer className="composer-foot">
          {error && <span className="teams-error-inline">{error}</span>}
          <button className="composer-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="composer-btn primary"
            title="⌘↩ also saves"
            disabled={!!loadError || !teams || !dirty || saving}
            onClick={() => save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
