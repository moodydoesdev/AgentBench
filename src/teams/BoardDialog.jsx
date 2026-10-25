// Per-project kanban over the shared task lists of the project's teams
// (Claude Code's TaskCreate/TaskUpdate, one list per team — see taskListId).
// Read-only: the agents move the cards. Lists live on disk, so finished work
// stays visible after a team is stopped or hibernated.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { X } from "@phosphor-icons/react";
import { taskListId } from "./teams";

const POLL_MS = 3000;

const COLUMNS = [
  { status: "pending", title: "To do" },
  { status: "in_progress", title: "In progress" },
  { status: "completed", title: "Done" },
];

const ownerName = (owner) => (owner ?? "").replace(/\s*\(.*\)\s*$/, "").trim();
const idNum = (t) => Number(t.id) || 0;

/**
 * teams: [{ id, name }] — saved teams plus any running ones not saved.
 * panes: this project's panes, so an owner chip can jump to its agent.
 */
export default function BoardDialog({ project, teams, panes, onFocusAgent, onClose }) {
  const [lists, setLists] = useState({}); // teamId → tasks
  const [filter, setFilter] = useState("all"); // "all" | teamId
  const [expanded, setExpanded] = useState(null); // `${teamId}:${taskId}`
  const boxRef = useRef(null);
  const key = teams.map((t) => t.id).join("|");

  useEffect(() => {
    boxRef.current?.focus();
    let dead = false;
    const poll = () =>
      Promise.all(
        teams.map((t) =>
          invoke("team_tasks", { list: taskListId(t.id) })
            .then((l) => [t.id, Array.isArray(l) ? l : []])
            .catch(() => [t.id, null]),
        ),
      ).then((rows) => {
        if (dead) return;
        setLists((prev) => {
          const next = { ...prev };
          for (const [id, l] of rows) if (l) next[id] = l;
          return next;
        });
      });
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      dead = true;
      clearInterval(timer);
    };
    // `key` covers the team ids the poll reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const multi = teams.length > 1;
  const shown = teams.filter((t) => filter === "all" || t.id === filter);
  const cards = shown.flatMap((t) =>
    (lists[t.id] ?? []).map((task) => ({ ...task, team: t })),
  );
  const openIds = new Set(
    cards.filter((c) => c.status !== "completed").map((c) => `${c.team.id}:${c.id}`),
  );
  const agentFor = (card) => {
    const owner = (card.owner ?? "").trim().toLowerCase();
    if (!owner) return null;
    return (
      panes.find((p) => {
        if (p.team?.team_id !== card.team.id) return false;
        const role = (p.team.role ?? "").toLowerCase();
        return (
          owner === (p.team.session_name ?? "").toLowerCase() ||
          owner === role ||
          (role && owner.startsWith(`${role} (`))
        );
      }) ?? null
    );
  };
  const total = cards.length;
  const done = cards.filter((c) => c.status === "completed").length;

  return (
    <div
      className="composer-backdrop"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="composer board-dialog"
        role="dialog"
        aria-label="Task board"
        tabIndex={-1}
        ref={boxRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="composer-head">
          <div>
            <div className="composer-title">Board · {project.name}</div>
            <div className="composer-sub">
              {total === 0
                ? "Tasks the project's teams plan on their shared list show up here."
                : `${done} of ${total} tasks done`}
            </div>
          </div>
          {multi && (
            <div className="board-filter" role="tablist">
              {[{ id: "all", name: "All teams" }, ...teams].map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={filter === t.id}
                  className={`board-chip${filter === t.id ? " on" : ""}`}
                  onClick={() => setFilter(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <button className="btn-icon" title="Close (Esc)" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </header>

        {teams.length === 0 ? (
          <div className="board-empty">
            No teams in this project yet. Create one from Teams… and its tasks
            land on this board.
          </div>
        ) : (
          <div className="board-cols">
            {COLUMNS.map((col) => {
              const rows = cards
                .filter((c) => c.status === col.status)
                // newest first in Done so fresh wins are on top
                .sort((a, b) => (col.status === "completed" ? idNum(b) - idNum(a) : idNum(a) - idNum(b)));
              return (
                <section key={col.status} className={`board-col task-${col.status}`}>
                  <div className="board-col-head">
                    <span>{col.title}</span>
                    <span className="board-col-count">{rows.length}</span>
                  </div>
                  <div className="board-col-body">
                    {rows.length === 0 && <div className="board-col-none">Nothing here</div>}
                    {rows.map((c) => {
                      const k = `${c.team.id}:${c.id}`;
                      const working = c.status === "in_progress";
                      const text =
                        working && c.activeForm?.trim() ? c.activeForm.trim() : c.subject;
                      const blocked =
                        c.status !== "completed" &&
                        (c.blockedBy ?? []).some((b) => openIds.has(`${c.team.id}:${b}`));
                      const owner = ownerName(c.owner);
                      const agent = agentFor(c);
                      return (
                        <div
                          key={k}
                          className={`board-card${blocked ? " blocked" : ""}${expanded === k ? " open" : ""}`}
                          onClick={() => c.description && setExpanded((e) => (e === k ? null : k))}
                          title={c.description ? "Click for details" : undefined}
                        >
                          <div className="board-card-text">{text}</div>
                          {expanded === k && c.description && (
                            <div className="board-card-desc">{c.description}</div>
                          )}
                          <div className="board-card-foot">
                            {owner &&
                              (agent ? (
                                <button
                                  className="board-owner link"
                                  title="Jump to this agent"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onFocusAgent(agent);
                                  }}
                                >
                                  {owner}
                                </button>
                              ) : (
                                <span className="board-owner">{owner}</span>
                              ))}
                            {multi && filter === "all" && (
                              <span className="board-team">{c.team.name}</span>
                            )}
                            {blocked && <span className="board-blocked">blocked</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
