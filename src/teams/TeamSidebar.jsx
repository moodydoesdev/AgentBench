import { useEffect, useState } from "react";
import * as ipc from "@/lib/ipc";
import Decisions from "./Decisions";

const { invoke } = ipc;

// How often the task list and each member's transcript tail are re-read.
// Both are small local file reads, so a few seconds is cheap.
const POLL_MS = 3000;

const STATUS_LABEL = {
  working: "working",
  done: "idle",
  input: "needs input",
  exited: "exited",
  hibernated: "hibernated",
};

// Task owners are whatever name the agent wrote — normally its exact session
// name ("Developer 1 (AntiDote)"), sometimes just the role.
const owns = (member, task) => {
  const owner = (task.owner ?? "").trim().toLowerCase();
  if (!owner) return false;
  const role = member.role.toLowerCase();
  return (
    owner === (member.sessionName ?? "").toLowerCase() ||
    owner === role ||
    owner.startsWith(`${role} (`)
  );
};

const label = (task) => task.activeForm?.trim() || task.subject;

function Bar({ done, total }) {
  return (
    <span className="team-rail-bar" aria-hidden="true">
      <span style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
    </span>
  );
}

/**
 * Side rail for a focus-layout team: the team's shared task list (Claude
 * Code's TaskCreate/TaskUpdate, one list per team — see taskListId) drawn as
 * overall progress plus, per member, the task it's on and how far through
 * its own tasks it is. A live one-liner from its transcript sits underneath.
 */
export default function TeamSidebar({ members, listId, teamId, currentId, onPick, visible }) {
  const [tasks, setTasks] = useState([]);
  const [briefs, setBriefs] = useState({});
  // finished tasks are folded away by default; this is the opt-in to see them
  const [showDone, setShowDone] = useState(false);
  const pollKey = `${listId}|${members.map((m) => `${m.id}:${m.sid}:${m.hibernated}`).join(",")}`;

  useEffect(() => {
    if (!visible) return;
    let dead = false;
    const poll = () => {
      if (listId)
        invoke("team_tasks", { list: listId })
          .then((list) => !dead && setTasks(list ?? []))
          .catch(() => {});
      Promise.all(
        members
          .filter((m) => m.sid && !m.hibernated)
          .map((m) =>
            invoke("session_brief", { project: m.projectPath, sid: m.sid })
              .then((b) => [m.id, b])
              .catch(() => [m.id, null]),
          ),
      ).then((rows) => {
        if (dead) return;
        setBriefs((prev) => {
          let next = prev;
          for (const [id, b] of rows)
            if (b && prev[id] !== b) next = { ...next, [id]: b };
          return next;
        });
      });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      dead = true;
      clearInterval(timer);
    };
    // pollKey covers every member field the poll reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey, visible]);

  const done = tasks.filter((t) => t.status === "completed").length;
  const claimed = new Set();
  const rows = members.map((m) => {
    const mine = tasks.filter((t) => owns(m, t));
    mine.forEach((t) => claimed.add(t.id));
    return { m, mine };
  });
  const upNext = tasks.filter((t) => t.status !== "completed" && !claimed.has(t.id));

  return (
    <aside className="team-rail" aria-label="Team members">
      <Decisions transport={ipc} teamId={teamId} enabled={visible} cls="team-decisions" />
      {tasks.length > 0 ? (
        <div className="team-rail-summary">
          <span className="team-rail-summary-text">
            <span>Team progress</span>
            <span>
              {done}/{tasks.length} tasks
            </span>
          </span>
          <Bar done={done} total={tasks.length} />
        </div>
      ) : (
        <div className="team-rail-empty">
          No shared tasks yet. Teams started with this version plan their work on
          one list; restart the team to switch it on.
        </div>
      )}

      {rows.map(({ m, mine }) => {
        const status = m.hibernated ? "hibernated" : m.status;
        const current = mine.find((t) => t.status === "in_progress");
        const mineDone = mine.filter((t) => t.status === "completed").length;
        const expanded = m.id === currentId && mine.length > 0;
        const brief = m.hibernated ? null : briefs[m.id];
        return (
          <button
            key={m.id}
            type="button"
            className={`team-rail-item${m.id === currentId ? " current" : ""} status-${status}`}
            onClick={(e) => {
              e.stopPropagation();
              if (m.id !== currentId) onPick?.(m.id);
            }}
          >
            <span className="team-rail-head">
              <span className={`dot ${status}`} />
              <span className="team-rail-role">{m.role}</span>
              <span className="team-rail-status">{STATUS_LABEL[status] ?? status}</span>
            </span>
            {current ? (
              <span className="team-rail-task" title={current.description || current.subject}>
                {label(current)}
              </span>
            ) : mine.length > 0 ? (
              <span className="team-rail-task idle">
                {mineDone === mine.length ? "All tasks done" : "Between tasks"}
              </span>
            ) : null}
            {mine.length > 0 && (
              <span className="team-rail-progress">
                <Bar done={mineDone} total={mine.length} />
                <span>
                  {mineDone}/{mine.length}
                </span>
              </span>
            )}
            {expanded && (
              <span className="team-rail-tasks">
                {mine
                  .filter((t) => showDone || t.status !== "completed")
                  .map((t) => (
                    <span key={t.id} className={`task-${t.status}`} title={t.description || t.subject}>
                      <span className="team-rail-check" aria-label={t.status} />
                      {t.subject}
                    </span>
                  ))}
                {mineDone > 0 && (
                  // a span, not a button: the whole card is already a button
                  <span
                    role="button"
                    tabIndex={0}
                    className="team-rail-done-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDone((v) => !v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      setShowDone((v) => !v);
                    }}
                  >
                    {showDone ? "Hide finished" : `Show ${mineDone} finished`}
                  </span>
                )}
              </span>
            )}
            {brief && status === "working" && (
              <span className="team-rail-brief" title={brief}>
                {brief}
              </span>
            )}
          </button>
        );
      })}

      {upNext.length > 0 && (
        <div className="team-rail-next">
          <div className="team-rail-next-head">Unassigned · {upNext.length}</div>
          <div className="team-rail-tasks">
            {upNext.slice(0, 5).map((t) => (
              <span key={t.id} className={`task-${t.status}`} title={t.description || t.subject}>
                <span className="team-rail-check" aria-label={t.status} />
                {t.subject}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
