import { useEffect, useRef, useState } from "react";
import { CaretRight, UsersThree, X } from "@phosphor-icons/react";
import { taskListId } from "../teams/teams";

// Same cadence as the desktop team sidebar: the list is a few small files.
const POLL_MS = 4000;

const COLUMNS = [
  { status: "pending", title: "To do" },
  { status: "in_progress", title: "In progress" },
  { status: "completed", title: "Done" },
];

// Owners are whatever the agent wrote — usually its session name
// ("Developer 1 (Proj)"); drop the project suffix, the team header has it.
const ownerName = (owner) => (owner ?? "").replace(/\s*\(.*\)\s*$/, "").trim();

/** Poll a team's shared task list (Claude Code's TaskCreate/TaskUpdate). */
function useTeamTasks(transport, teamId, enabled = true) {
  const [tasks, setTasks] = useState([]);
  useEffect(() => {
    if (!enabled || !teamId || !transport) return;
    let dead = false;
    const poll = () =>
      transport
        .invoke("team_tasks", { list: taskListId(teamId) })
        .then((list) => !dead && setTasks(Array.isArray(list) ? list : []))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [transport, teamId, enabled]);
  return tasks;
}

/**
 * Under a team's header in the fleet list: progress through its shared task
 * list. Tap to open the full board. Hidden until the team has any tasks.
 */
export default function TeamTasks({ transport, teamId, enabled = true, onOpen }) {
  const tasks = useTeamTasks(transport, teamId, enabled);
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.filter((t) => t.status === "in_progress").length;
  return (
    <button className="mob-tasks-sum" onClick={onOpen}>
      <span className="mob-tasks-bar" aria-hidden="true">
        <span style={{ width: `${(done / tasks.length) * 100}%` }} />
      </span>
      <span className="mob-tasks-count">
        {done}/{tasks.length}
        {active > 0 ? ` · ${active} active` : ""}
      </span>
      <CaretRight size={11} weight="bold" />
    </button>
  );
}

function Card({ task, blocked, agent, onAgent }) {
  const [open, setOpen] = useState(false);
  const working = task.status === "in_progress";
  const text = working && task.activeForm?.trim() ? task.activeForm.trim() : task.subject;
  const owner = ownerName(task.owner);
  return (
    <div
      className={`mob-card-task${open ? " open" : ""}${blocked ? " blocked" : ""}`}
      onClick={() => task.description && setOpen((o) => !o)}
    >
      <div className="mob-card-task-text">{text}</div>
      {open && task.description && <div className="mob-card-task-desc">{task.description}</div>}
      {(owner || blocked) && (
        <div className="mob-card-task-foot">
          {owner &&
            (agent ? (
              <button
                className="mob-card-task-owner"
                onClick={(e) => {
                  e.stopPropagation();
                  onAgent(agent);
                }}
              >
                {owner}
              </button>
            ) : (
              <span className="mob-card-task-owner">{owner}</span>
            ))}
          {blocked && <span className="mob-card-task-blocked">blocked</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Full-screen kanban for one team's shared task list: To do / In progress /
 * Done, swipe between columns (or tap a tab). Read-only — the agents move the
 * cards; tap an owner to jump to their pane.
 */
export function TeamBoard({ transport, teamId, name, panes, onOpenPane, onClose }) {
  const tasks = useTeamTasks(transport, teamId);
  const scroller = useRef(null);
  const [col, setCol] = useState(1);
  const open = new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id));
  const agentFor = (task) => {
    const owner = (task.owner ?? "").trim().toLowerCase();
    if (!owner) return null;
    return (
      panes.find((p) => {
        const role = (p.team?.role ?? "").toLowerCase();
        return (
          owner === (p.team?.session_name ?? "").toLowerCase() ||
          owner === role ||
          (role && owner.startsWith(`${role} (`))
        );
      }) ?? null
    );
  };

  // land on the busiest-looking column: In progress, else the first with cards
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || tasks.length === 0 || !scroller.current) return;
    landed.current = true;
    const target = tasks.some((t) => t.status === "in_progress")
      ? 1
      : COLUMNS.findIndex((c) => tasks.some((t) => t.status === c.status));
    goTo(Math.max(0, target), false);
  }, [tasks]);

  const goTo = (i, smooth = true) => {
    const el = scroller.current;
    if (!el) return;
    setCol(i);
    el.scrollTo({ left: el.clientWidth * i, behavior: smooth ? "smooth" : "auto" });
  };
  const onScroll = () => {
    const el = scroller.current;
    if (el) setCol(Math.round(el.scrollLeft / el.clientWidth));
  };

  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <div className="mob mob-screen mob-board">
      <div className="mob-top">
        <UsersThree size={16} weight="bold" />
        <span className="mob-board-title">{name}</span>
        <span className="mob-board-progress">
          {done}/{tasks.length}
        </span>
        <span className="mob-spacer" />
        <button className="mob-icon" onClick={onClose} aria-label="Close board">
          <X size={18} />
        </button>
      </div>
      <div className="mob-board-tabs" role="tablist">
        {COLUMNS.map((c, i) => (
          <button
            key={c.status}
            role="tab"
            aria-selected={col === i}
            className={`mob-board-tab${col === i ? " on" : ""}`}
            onClick={() => goTo(i)}
          >
            {c.title}
            <span>{tasks.filter((t) => t.status === c.status).length}</span>
          </button>
        ))}
      </div>
      <div className="mob-board-cols" ref={scroller} onScroll={onScroll}>
        {COLUMNS.map((c) => {
          const rows = tasks.filter((t) => t.status === c.status);
          return (
            <section key={c.status} className={`mob-board-col task-${c.status}`}>
              {rows.length === 0 ? (
                <div className="mob-board-empty">Nothing here</div>
              ) : (
                rows.map((t) => (
                  <Card
                    key={t.id}
                    task={t}
                    blocked={
                      c.status !== "completed" &&
                      (t.blockedBy ?? []).some((id) => open.has(String(id)))
                    }
                    agent={agentFor(t)}
                    onAgent={onOpenPane}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
