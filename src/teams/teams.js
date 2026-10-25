// Agent teams: a named set of roles (Manager, Developer 1, …) saved per
// project in .agentbench/teams.json, meant to be committed. Pure helpers —
// the dialog edits, App reads/writes through list_teams / save_teams.
//
// File shape:
//   { version: 1, teams: [{ id, name, layout, defaultTarget,
//       agents: [{ role, harness, model?, instructions? }] }] }
// Roles double as the names the agents use for each other, so they must be
// unique within a team.

export const TEAMS_VERSION = 1;
export const LAYOUTS = ["focus", "split"];

const str = (v) => (typeof v === "string" ? v : "");

let seq = 0;
export const newTeamId = () =>
  `team-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function blankAgent(role = "", harness = "claude") {
  return { role, harness, model: "", instructions: "", manager: false };
}

export const managerOf = (team) => team?.agents?.find((a) => a.manager) ?? null;

// Preset instructions reference the project only generically — the agents
// read the codebase themselves at launch, so the text stays commit-friendly.
const MANAGER_INSTRUCTIONS = [
  "You are the team's manager. Read the project first and build a picture of its scope, then split the work into independent slices and hand one to each developer with clear boundaries and acceptance criteria.",
  "Review what comes back before treating it as done, and keep a running view of who owns what. You are the only agent who reports to the user; summarize progress for them instead of forwarding raw developer chatter.",
].join(" ");

const developerInstructions = (n) =>
  [
    `You are Developer ${n}. Work only on the slice the Manager assigns you, inside its boundaries — coordinate with the Manager before touching files another developer owns.`,
    "Report progress, blockers, and completion to the Manager, not to the user.",
  ].join(" ");

// Role library: preset instructions for common seats, addable from the team
// editor. Wording stays project-generic (commit-friendly), and roles that
// react to finished work route through the Manager — on an unmanaged team
// that reads as "whoever coordinates", which is still right.
export const ROLE_LIBRARY = [
  { role: "Manager", manager: true, instructions: MANAGER_INSTRUCTIONS },
  {
    role: "Developer",
    instructions:
      "You are a developer. Work only on the slice the Manager assigns you, inside its boundaries — coordinate with the Manager before touching files another developer owns. Report progress, blockers, and completion to the Manager, not to the user.",
  },
  {
    role: "Reviewer",
    instructions:
      "You review finished work. When the Manager or a developer reports a slice complete, read its diff for correctness, missed edge cases, and drift from the project's conventions, then send the Manager a short verdict: approve, or a concrete list of what must change. You never edit files yourself.",
  },
  {
    role: "Tester",
    instructions:
      "You own the tests. When a slice is reported complete, write or extend tests that prove its acceptance criteria, run the suite, and report failures with reproduction steps to the Manager. Stay inside test files — coordinate with the Manager before touching anything else.",
  },
  {
    role: "Architect",
    instructions:
      "You design before anyone builds. Read the codebase and produce a short plan — the slices, their boundaries, which files each touches, and the risky parts — then hand it to the Manager and answer the team's design questions. You don't implement slices yourself.",
  },
  {
    role: "Researcher",
    instructions:
      "You answer the team's questions. When a teammate asks where something lives or how a subsystem works, investigate read-only and reply with precise answers — paths, line numbers, exact behavior — so they don't spend their own context exploring.",
  },
  {
    role: "Docs Writer",
    instructions:
      "You keep the documentation true. When the Manager accepts a slice, update the README, docs, and changelog to match what actually shipped. Stay inside documentation files.",
  },
  {
    role: "Security Auditor",
    instructions:
      "You audit finished work for security: injection, secrets in code, unsafe input handling, risky dependencies. Report findings to the Manager ranked by severity, with the file and line for each. You never edit files yourself.",
  },
  {
    role: "Release Engineer",
    instructions:
      "You integrate and ship. When the Manager says the slices are in, run the full build and test suite, resolve integration conflicts, and report the result. Commits and version bumps go through you — nobody else commits.",
  },
  {
    role: "Scribe",
    instructions:
      "You are the team's memory. Keep a NOTES.md at the project root current — decisions made, who owns which files, open questions, and the state of each slice — updating it as teammates report. It is what survives when a teammate compacts their context.",
  },
];

// A fresh agent from a library entry, its role suffixed until unique within
// the team. A second Manager joins as a plain agent — one manager per team.
export function libraryAgent(entry, team) {
  const used = new Set((team?.agents ?? []).map((a) => str(a.role).trim().toLowerCase()));
  let role = entry.role;
  for (let n = 2; used.has(role.toLowerCase()); n++) role = `${entry.role} ${n}`;
  return {
    ...blankAgent(role),
    instructions: entry.instructions,
    manager: !!entry.manager && !managerOf(team),
  };
}

// "Manager + N developers" starter team with preset instructions.
export function presetTeam(devCount = 2, name = "") {
  const manager = { ...blankAgent("Manager"), manager: true, instructions: MANAGER_INSTRUCTIONS };
  const devs = Array.from({ length: Math.max(1, devCount) }, (_, i) => ({
    ...blankAgent(`Developer ${i + 1}`),
    instructions: developerInstructions(i + 1),
  }));
  return {
    ...blankTeam(name),
    defaultTarget: "Manager",
    agents: [manager, ...devs],
  };
}

export function blankTeam(name = "") {
  return {
    id: newTeamId(),
    name,
    layout: "focus",
    defaultTarget: "Manager",
    agents: [blankAgent("Manager"), blankAgent("Developer 1"), blankAgent("Developer 2")],
  };
}

function normalizeAgent(a) {
  return {
    role: str(a?.role).trim(),
    harness: str(a?.harness).trim() || "claude",
    model: str(a?.model).trim(),
    instructions: str(a?.instructions),
    manager: a?.manager === true,
  };
}

export function normalizeTeam(t) {
  const agents = Array.isArray(t?.agents) ? t.agents.map(normalizeAgent) : [];
  // a second manager (hand-edited file) demotes to plain agent
  let seenManager = false;
  for (const a of agents) {
    if (a.manager && seenManager) a.manager = false;
    seenManager ||= a.manager;
  }
  const roles = agents.map((a) => a.role);
  const manager = agents.find((a) => a.manager);
  return {
    id: str(t?.id) || newTeamId(),
    name: str(t?.name).trim(),
    layout: LAYOUTS.includes(t?.layout) ? t.layout : "focus",
    // a managed team always fronts its manager; otherwise a target that no
    // longer names a role falls back to the first agent
    defaultTarget: manager
      ? manager.role
      : roles.includes(t?.defaultTarget) ? t.defaultTarget : roles[0] ?? "",
    agents,
  };
}

// Tolerant of hand edits: unknown keys are dropped, missing ones defaulted.
export function normalizeTeams(raw) {
  const teams = Array.isArray(raw?.teams) ? raw.teams : [];
  return teams.map(normalizeTeam);
}

// On disk: empty model/instructions are omitted to keep the file readable.
export function serializeTeams(teams) {
  return {
    version: TEAMS_VERSION,
    teams: teams.map((t) => {
      const n = normalizeTeam(t);
      return {
        ...n,
        agents: n.agents.map(({ role, harness, model, instructions, manager }) => ({
          role,
          harness,
          ...(manager ? { manager: true } : {}),
          ...(model ? { model } : {}),
          ...(instructions.trim() ? { instructions } : {}),
        })),
      };
    }),
  };
}

// First problem with a team, or null when it can be saved.
export function validateTeam(team, others = []) {
  const name = str(team?.name).trim();
  if (!name) return "Give the team a name";
  if (others.some((o) => o.id !== team.id && str(o.name).trim().toLowerCase() === name.toLowerCase()))
    return `Another team is already called "${name}"`;
  const agents = team?.agents ?? [];
  if (!agents.length) return "Add at least one agent";
  const seen = new Set();
  for (const a of agents) {
    const role = str(a.role).trim();
    if (!role) return "Every agent needs a role name";
    const key = role.toLowerCase();
    if (seen.has(key)) return `Two agents are called "${role}"`;
    seen.add(key);
  }
  if (agents.filter((a) => a.manager).length > 1) return "Only one agent can be the manager";
  return null;
}

// Snapshot the project's open agent panes as a team. Run/terminal panes are
// not agents; the displayed title (or label) becomes the role.
export function teamFromPanes(panes, titles = {}, name = "") {
  const agents = [];
  const used = new Set();
  for (const p of panes) {
    const harness = p.kind === "chat" ? "claude" : p.harness?.id ?? (p.claude ? "claude" : null);
    if (p.kind === "run" || !harness || harness === "terminal" || harness.startsWith("run:")) continue;
    let role = str(titles[p.id]).trim() || str(p.label).trim() || `Agent ${agents.length + 1}`;
    const base = role;
    for (let n = 2; used.has(role.toLowerCase()); n++) role = `${base} ${n}`;
    used.add(role.toLowerCase());
    agents.push(blankAgent(role, harness));
  }
  const team = { ...blankTeam(name), agents };
  const manager = agents.find((a) => /manager|lead/i.test(a.role));
  team.defaultTarget = (manager ?? agents[0])?.role ?? "";
  return team;
}

// Cross-session message addresses are machine-wide, so a bare role like
// "Developer 1" collides when two projects run teams with the same roles and
// mail lands in the wrong project. Qualify with the project folder name.
export function sessionNameFor(role, projectName = "") {
  const p = str(projectName).trim();
  return p ? `${role} (${p})` : role;
}

// Launch-time identity for one agent, sent to the broker inside the harness
// spec (see TeamSeat in broker/mod.rs). The prompt tells the agent who it is
// and who its teammates are; messaging goes through Claude Code's own
// cross-session messages, addressed by the project-qualified session names.
/** The Claude Code task list a team's members share (~/.claude/tasks/<id>/).
 *  Keep in sync with the broker, which sets CLAUDE_CODE_TASK_LIST_ID. */
export function taskListId(teamId) {
  return `agentbench-${teamId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function seatFor(team, agent, harnessName = (id) => id, projectName = "") {
  const sessionName = sessionNameFor(agent.role, projectName);
  const manager = managerOf(team);
  const isManager = manager === agent;
  const others = team.agents.filter((a) => a !== agent);
  const roster = others
    .map((a) =>
      a.harness === "claude"
        ? `- ${sessionNameFor(a.role, projectName)}${a.manager ? " (your manager)" : ""}`
        : `- ${a.role} (${harnessName(a.harness)} — can't receive session messages)`)
    .join("\n");
  const lines = [
    `You are "${sessionName}", the ${agent.role} of team "${team.name}", working in this project alongside other agent sessions on this machine.`,
  ];
  if (roster) {
    lines.push(
      `Your teammates:\n${roster}`,
      "Reach teammates with Claude Code's cross-session messaging, addressing them by the exact names above. Other projects on this machine may run agents with similar names; only the sessions listed here are your team.",
    );
  }
  if (manager && !isManager) {
    lines.push(
      `This team is run by ${manager.role}: take direction from them and report progress, blockers, and results to them by session message, never to the user. The user only talks to the team through ${manager.role}.`,
    );
  } else if (isManager) {
    lines.push(
      "You are the manager: you alone report to the user, and the user's messages to the team arrive through you.",
      'When your context grows stale between phases you may compact or clear your own session by running: curl -sf -X POST -H "Content-Type: application/json" -d \'{"command":"/compact"}\' "http://127.0.0.1:$AGENTBENCH_HOOK_PORT/event/$AGENTBENCH_PANE_ID/command" (or "/clear"). It queues like typed input, so finish the turn you are on first. To clear or compact a teammate instead (e.g. one that asks for a fresh context), add their exact session name: -d \'{"command":"/clear","target":"<session name>"}\'. Only you can do this, and only for your own team.',
      'When you need the user to make a decision, file it once instead of asking in chat: curl -s -X POST -H "Content-Type: application/json" -d \'{"question":"…","options":["…","…"],"context":"why it matters / what it blocks"}\' "http://127.0.0.1:$AGENTBENCH_HOOK_PORT/event/$AGENTBENCH_PANE_ID/decision". It appears in the team\'s Decisions list (sidebar and phone) and notifies the user; options are optional and the user can always answer in their own words. Never repeat or chase an open decision in chat — keep going with whatever isn\'t blocked on it. The answer arrives in this session as a message starting "[Decision D<n>]"; act on it then. If you lose track (e.g. after /clear), POST to .../event/$AGENTBENCH_PANE_ID/decisions to list what is open and what was answered, and POST {"id":"D<n>"} to .../decision-withdraw when one no longer matters.',
    );
  } else {
    lines.push("The user also talks to you directly.");
  }
  // The broker points every member at one shared task list (taskListId),
  // and the team sidebar draws it — but only if the agents actually use it.
  lines.push(
    isManager
      ? `Run the team's work through the shared task list (TaskCreate / TaskUpdate / TaskList — every teammate sees the same list). Break each piece of work into tasks with a short activeForm ("Fixing the delay mode"), set owner to the teammate's exact session name, and keep blockedBy current. The user watches this list to see who is doing what and how far along the team is, so keep it truthful.`
      : `Track your work on the team's shared task list (TaskList / TaskUpdate / TaskCreate). When you start a task, set it in_progress with owner "${sessionName}"; mark it completed the moment it's done, before reporting. Work you take on that isn't on the list yet gets a task first, owned by you, with a short activeForm ("Running the FM tests"). The user watches this list to follow the team, so keep it current.`,
  );
  if (agent.instructions?.trim()) lines.push(`Your role:\n${agent.instructions.trim()}`);
  return {
    team_id: team.id,
    team: team.name,
    role: agent.role,
    session_name: sessionName,
    manager: isManager,
    // a managed team's non-manager agents stay out of the user's inbox and
    // notifications, and their panes don't take direct user input
    muted: !!manager && !isManager,
    model: agent.model?.trim() || null,
    prompt: lines.join("\n\n"),
  };
}

// Which of a team's roles already have a live pane in the project, so a
// second launch only fills the gaps.
export function missingSeats(team, panes) {
  const live = new Set(
    panes
      .filter((p) => p.team?.team_id === team.id)
      .map((p) => p.team.role.toLowerCase()),
  );
  return team.agents.filter((a) => !live.has(a.role.toLowerCase()));
}

// A developer seat on a managed team reports to its manager, not the user:
// its turns stay out of the inbox, notifications and project attention dots.
// `muted` is stamped at launch; seats saved before it existed (or launched
// from a hand-edited team) are caught by a live manager in the same team.
export function isMutedSeat(pane, panes = []) {
  const seat = pane?.team;
  if (!seat || seat.manager) return false;
  if (seat.muted) return true;
  return panes.some((p) => p.team?.manager && p.team.team_id === seat.team_id);
}

// The status a pane contributes to its project's attention dot: a muted
// seat's finished or waiting turn is the manager's business, so it reads
// as plain working until the manager surfaces something.
export function attentionStatus(pane, status, panes) {
  return (status === "done" || status === "input") && isMutedSeat(pane, panes) ? "working" : status;
}

// Display order for a team's seats: the manager first, then numbered roles
// by their number ("Developer 2" before "Developer. 10"), then everyone else
// by name. Takes panes (role on `.team`) or plain seats.
export function seatOrder(a, b) {
  const seat = (x) => x.team ?? x;
  const sa = seat(a), sb = seat(b);
  const boss = (s) => !!s.manager || /^(manager|lead)\b/i.test(s.role ?? "");
  if (boss(sa) !== boss(sb)) return boss(sa) ? -1 : 1;
  const num = (s) => {
    const m = /(\d+)\s*$/.exec(s.role ?? "") ?? /(\d+)/.exec(s.role ?? "");
    return m ? Number(m[1]) : Infinity;
  };
  const na = num(sa), nb = num(sb);
  if (na !== nb) return na - nb;
  return (sa.role ?? "").localeCompare(sb.role ?? "", undefined, { numeric: true });
}
