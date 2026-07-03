export const SETTINGS_KEY = "agentbench.settings";

// Built-in agent harnesses. `command` is a shell command line run through the
// user's login shell, so anything on their PATH works. Only Claude gets the
// hook/session integration (`claude: true`): status glow, resume, plan panes.
// Everything else is a plain terminal for now.
// `install` is run in the pane before first launch when the binary is
// missing, so the user watches it happen in the terminal they spawned.
export const BUILTIN_HARNESSES = [
  {
    id: "claude",
    name: "Claude",
    command: "claude --dangerously-skip-permissions",
    resume: "--resume {session_id}",
    claude: true,
    install: "npm install -g @anthropic-ai/claude-code",
  },
  {
    id: "opencode",
    name: "opencode",
    command: "opencode",
    install: "npm install -g opencode-ai@latest",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex --dangerously-bypass-approvals-and-sandbox",
    install: "npm install -g @openai/codex",
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini --yolo",
    install: "npm install -g @google/gemini-cli",
  },
  {
    id: "pi",
    name: "pi",
    command: "pi",
    install: "npm install -g @mariozechner/pi-coding-agent",
  },
  {
    id: "terminal",
    name: "Terminal",
    // plain shell pane, no agent — on unix $SHELL expands inside the login
    // shell the broker launches every harness through; on Windows the broker
    // treats bare "$SHELL" as a sentinel and spawns the configured shell
    // (Settings → Terminal → Shell, auto = pwsh) interactively. No `install`
    // since there is nothing to install.
    command: navigator.userAgent.includes("Windows") ? "$SHELL" : "$SHELL -l",
  },
];

// Binary to probe for on PATH — the first word of the command line.
export function harnessBin(h) {
  return h.command.trim().split(/\s+/)[0];
}

// Only plain binary names can be probed — $SHELL-style commands can't.
export const PROBEABLE = /^[A-Za-z0-9._/-]+$/;

// Built-ins + user-defined custom harnesses (Settings → Agents).
export function getHarnesses(settings) {
  const custom = (settings.customHarnesses ?? []).filter(
    (h) => h?.command?.trim() && h?.name?.trim(),
  );
  return [...BUILTIN_HARNESSES, ...custom];
}

// Resolve by id; falls back to the first harness (Claude) when the id is
// unknown (e.g. a deleted custom harness referenced by a saved pane).
export function getHarness(settings, id) {
  const all = getHarnesses(settings);
  return all.find((h) => h.id === id) ?? all[0];
}

export const DEFAULT_SETTINGS = {
  cols: 3,
  sound: true,
  volume: 0.8,
  osNotify: true,
  engine: "xterm",
  navMod: "off", // modifier for arrow-key pane navigation: off | ctrl | alt | meta
  wordMod: "ctrl", // modifier+←/→ sends ESC b / ESC f (word jump): off | ctrl | meta
  copyOnSelect: true, // highlighting text in a terminal copies it (xterm engine)
  shell: "", // shell panes/installs run through ("" = auto: $SHELL, pwsh on Windows)
  theme: "midnight",
  bgImage: "", // absolute path to a custom background image ("" = off)
  bgOverlay: 0.85, // opacity of UI surfaces over the background image (0–1)
  bgFrosted: true, // frosted-glass blur on surfaces when a bg image is set
  bgFrostBlur: 24, // frost blur radius in px
  bgHeadOpacity: 1, // pane-header opacity over the bg image (0–1, 1 = solid)
  commandMenuKey: "mod+shift+p", // opens the command menu; "mod" = ⌘ on macOS, Ctrl elsewhere
  planSkillSync: true, // keep ~/.claude/skills/agentbench-plan in sync on launch
  defaultHarness: "claude", // harness spawned by the New Agent button
  customHarnesses: [], // user-defined harnesses: {id, name, command}
};

export function loadSettings() {
  try {
    return {
      ...DEFAULT_SETTINGS,
      ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
