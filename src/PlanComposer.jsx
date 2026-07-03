// New-plan composer: a centered modal for writing a fully-scoped plan brief
// (title, scope, constraints, out-of-scope) and picking the agent that will
// author the plan. Pure UI — the App owns transport (write_pane/create_pane).
// Drafts persist per project on every keystroke; cleared on send, kept on Esc.
import { useEffect, useState } from "react";
import { X, PaperPlaneRight, Plus } from "@phosphor-icons/react";

const draftKey = (project) => `agentbench.planDraft.${project}`;
const EMPTY = { title: "", scope: "", constraints: "", outOfScope: "" };

export default function PlanComposer({
  project,
  agents, // [{id, label, status}]
  defaultAgentId,
  onClose,
  onSubmit, // ({title, scope, constraints, outOfScope, agentId | "new"})
}) {
  const [draft, setDraft] = useState(() => {
    try {
      return {
        ...EMPTY,
        ...(JSON.parse(localStorage.getItem(draftKey(project))) ?? {}),
      };
    } catch {
      return { ...EMPTY };
    }
  });
  const [agentId, setAgentId] = useState(() =>
    agents.length ? (defaultAgentId ?? agents[0].id) : "new",
  );

  useEffect(() => {
    localStorage.setItem(draftKey(project), JSON.stringify(draft));
  }, [draft, project]);

  const set = (k) => (e) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const canSend = draft.title.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    localStorage.removeItem(draftKey(project));
    onSubmit({ ...draft, agentId });
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose(); // draft already persisted
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <div className="composer-backdrop" onMouseDown={onClose} onKeyDown={onKeyDown}>
      <div
        className="composer"
        role="dialog"
        aria-label="New plan"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="composer-head">
          <div>
            <div className="composer-title">New plan</div>
            <div className="composer-sub">
              The agent explores the code, publishes a visual plan, and waits
              for your review.
            </div>
          </div>
          <button className="btn-icon" title="Close (Esc) — draft is kept" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </header>

        <label className="composer-label">Title</label>
        <input
          className="composer-input"
          autoFocus
          placeholder="Better auth session handling"
          value={draft.title}
          onChange={set("title")}
        />

        <label className="composer-label">Scope</label>
        <textarea
          className="composer-area grow"
          rows={8}
          placeholder={"What's in — goals, user-visible outcomes"}
          value={draft.scope}
          onChange={set("scope")}
        />

        <div className="composer-row">
          <div>
            <label className="composer-label">Constraints</label>
            <textarea
              className="composer-area"
              rows={4}
              placeholder="Hard requirements, tech to keep or avoid"
              value={draft.constraints}
              onChange={set("constraints")}
            />
          </div>
          <div>
            <label className="composer-label">Out of scope</label>
            <textarea
              className="composer-area"
              rows={4}
              placeholder="Explicitly deferred"
              value={draft.outOfScope}
              onChange={set("outOfScope")}
            />
          </div>
        </div>

        <label className="composer-label">Send to</label>
        <div className="composer-agents">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`composer-agent ${agentId === a.id ? "selected" : ""}`}
              onClick={() => setAgentId(a.id)}
            >
              <span className={`dot ${a.status}`} />
              {a.label}
            </button>
          ))}
          <button
            type="button"
            className={`composer-agent ${agentId === "new" ? "selected" : ""}`}
            onClick={() => setAgentId("new")}
          >
            <Plus size={11} weight="bold" /> New agent
          </button>
        </div>

        <footer className="composer-foot">
          <button className="composer-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="composer-btn primary"
            disabled={!canSend}
            title={canSend ? "⌘↩ also sends" : "Give it a title first"}
            onClick={submit}
          >
            <PaperPlaneRight size={12} weight="bold" /> Send to agent
          </button>
        </footer>
      </div>
    </div>
  );
}
