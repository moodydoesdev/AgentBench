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
  return { role, harness, model: "", instructions: "" };
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
  };
}

export function normalizeTeam(t) {
  const agents = Array.isArray(t?.agents) ? t.agents.map(normalizeAgent) : [];
  const roles = agents.map((a) => a.role);
  return {
    id: str(t?.id) || newTeamId(),
    name: str(t?.name).trim(),
    layout: LAYOUTS.includes(t?.layout) ? t.layout : "focus",
    // a target that no longer names a role falls back to the first agent
    defaultTarget: roles.includes(t?.defaultTarget) ? t.defaultTarget : roles[0] ?? "",
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
        agents: n.agents.map(({ role, harness, model, instructions }) => ({
          role,
          harness,
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

// Launch-time identity for one agent, sent to the broker inside the harness
// spec (see TeamSeat in broker/mod.rs). The prompt tells the agent who it is
// and who its teammates are; messaging goes through Claude Code's own
// cross-session messages, addressed by these role names.
export function seatFor(team, agent, harnessName = (id) => id) {
  const others = team.agents.filter((a) => a !== agent);
  const roster = others
    .map((a) => `- ${a.role}${a.harness === "claude" ? "" : ` (${harnessName(a.harness)} — can't receive session messages)`}`)
    .join("\n");
  const lines = [
    `You are "${agent.role}", one agent in the team "${team.name}", working in this project alongside other agent sessions on this machine.`,
  ];
  if (roster) {
    lines.push(
      `Your teammates:\n${roster}`,
      "Reach teammates with Claude Code's cross-session messaging, addressing them by the names above. The user also talks to you directly.",
    );
  }
  if (agent.instructions?.trim()) lines.push(`Your role:\n${agent.instructions.trim()}`);
  return {
    team_id: team.id,
    team: team.name,
    role: agent.role,
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
