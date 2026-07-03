export const SETTINGS_KEY = "agentbench.settings";

export const DEFAULT_SETTINGS = {
  cols: 3,
  sound: true,
  volume: 0.8,
  osNotify: true,
  engine: "xterm",
  navMod: "off", // modifier for arrow-key pane navigation: off | ctrl | alt | meta
  wordMod: "ctrl", // modifier+←/→ sends ESC b / ESC f (word jump): off | ctrl | meta
  theme: "midnight",
  bgImage: "", // absolute path to a custom background image ("" = off)
  bgOverlay: 0.85, // opacity of UI surfaces over the background image (0–1)
  bgFrosted: true, // frosted-glass blur on surfaces when a bg image is set
  bgFrostBlur: 24, // frost blur radius in px
  bgHeadOpacity: 1, // pane-header opacity over the bg image (0–1, 1 = solid)
  commandMenuKey: "mod+shift+p", // opens the command menu; "mod" = ⌘ on macOS, Ctrl elsewhere
  planSkillSync: true, // keep ~/.claude/skills/agentbench-plan in sync on launch
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
