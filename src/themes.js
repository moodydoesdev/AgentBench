// Predefined color schemes. Every theme defines the complete variable set —
// App.jsx writes them as inline custom properties on <html>, overriding the
// :root fallbacks in styles.css. Triples (r, g, b) are used with rgba() for
// glows and tints.
export const THEMES = {
  midnight: {
    name: "Midnight",
    vars: {
      "--bg": "#08080b",
      "--panel": "#0d0d12",
      "--panel-head": "#101018",
      "--border": "#1e1e28",
      "--text": "#d8d8e2",
      "--text-dim": "#6b6b7a",
      "--green": "74, 222, 128",
      "--amber": "251, 191, 36",
      "--red": "248, 113, 113",
      "--blue": "96, 165, 250",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#0d0d12",
      "--theme-term-fg": "#d8d8e2",
      "--theme-term-cursor": "#d8d8e2",
      "--theme-term-sel": "#2e2e3a",
    },
  },
  graphite: {
    name: "Graphite",
    vars: {
      "--bg": "#101113",
      "--panel": "#17181b",
      "--panel-head": "#1c1d21",
      "--border": "#292b31",
      "--text": "#d6d8dd",
      "--text-dim": "#7a7d86",
      "--green": "163, 230, 53",
      "--amber": "251, 191, 36",
      "--red": "248, 113, 113",
      "--blue": "125, 165, 220",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#17181b",
      "--theme-term-fg": "#d6d8dd",
      "--theme-term-cursor": "#d6d8dd",
      "--theme-term-sel": "#33363e",
    },
  },
  ocean: {
    name: "Ocean",
    vars: {
      "--bg": "#071019",
      "--panel": "#0b1622",
      "--panel-head": "#0e1b2a",
      "--border": "#16283a",
      "--text": "#cfe1ee",
      "--text-dim": "#5d7a92",
      "--green": "34, 211, 238",
      "--amber": "251, 191, 36",
      "--red": "251, 113, 133",
      "--blue": "125, 196, 255",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#0b1622",
      "--theme-term-fg": "#cfe1ee",
      "--theme-term-cursor": "#cfe1ee",
      "--theme-term-sel": "#1b344a",
    },
  },
  forest: {
    name: "Forest",
    vars: {
      "--bg": "#0a0f0a",
      "--panel": "#0e150e",
      "--panel-head": "#121a12",
      "--border": "#20301f",
      "--text": "#d3ddd3",
      "--text-dim": "#6c7d6c",
      "--green": "134, 239, 172",
      "--amber": "250, 204, 21",
      "--red": "248, 113, 113",
      "--blue": "110, 190, 160",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#0e150e",
      "--theme-term-fg": "#d3ddd3",
      "--theme-term-cursor": "#d3ddd3",
      "--theme-term-sel": "#24382a",
    },
  },
  dracula: {
    name: "Dracula",
    vars: {
      "--bg": "#1e1f29",
      "--panel": "#282a36",
      "--panel-head": "#2e303e",
      "--border": "#3b3d4d",
      "--text": "#f8f8f2",
      "--text-dim": "#6272a4",
      "--green": "80, 250, 123",
      "--amber": "241, 250, 140",
      "--red": "255, 85, 85",
      "--blue": "139, 233, 253",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#282a36",
      "--theme-term-fg": "#f8f8f2",
      "--theme-term-cursor": "#f8f8f2",
      "--theme-term-sel": "#44475a",
    },
  },
  "solarized-dark": {
    name: "Solarized Dark",
    vars: {
      "--bg": "#00212b",
      "--panel": "#002b36",
      "--panel-head": "#04313d",
      "--border": "#114452",
      "--text": "#93a1a1",
      "--text-dim": "#586e75",
      "--green": "133, 153, 0",
      "--amber": "181, 137, 0",
      "--red": "220, 50, 47",
      "--blue": "38, 139, 210",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#002b36",
      "--theme-term-fg": "#93a1a1",
      "--theme-term-cursor": "#93a1a1",
      "--theme-term-sel": "#073642",
    },
  },
  neon: {
    name: "Neon",
    vars: {
      "--bg": "#0d0616",
      "--panel": "#130a1f",
      "--panel-head": "#180d27",
      "--border": "#2b1a44",
      "--text": "#e2d9f3",
      "--text-dim": "#7d6b9e",
      "--green": "232, 121, 249",
      "--amber": "250, 204, 21",
      "--red": "251, 113, 133",
      "--blue": "167, 139, 250",
      "--hilite": "255, 255, 255",
      "--theme-term-bg": "#130a1f",
      "--theme-term-fg": "#e2d9f3",
      "--theme-term-cursor": "#e879f9",
      "--theme-term-sel": "#332052",
    },
  },
  // Light themes: Claude picks its output palette from its own theme config,
  // not the terminal bg, so panes spawned under a light theme pass
  // `"theme": "light"` via --settings (claudeTheme). Agents already running
  // when the app theme flips keep their old palette.
  "solarized-light": {
    name: "Solarized Light",
    claudeTheme: "light",
    vars: {
      "--bg": "#eee8d5",
      "--panel": "#fdf6e3",
      "--panel-head": "#f5efdc",
      "--border": "#d9d2bc",
      "--text": "#586e75",
      "--text-dim": "#93a1a1",
      "--green": "133, 153, 0",
      "--amber": "181, 137, 0",
      "--red": "220, 50, 47",
      "--blue": "38, 139, 210",
      "--hilite": "0, 0, 0",
      "--theme-term-bg": "#fdf6e3",
      "--theme-term-fg": "#586e75",
      "--theme-term-cursor": "#586e75",
      "--theme-term-sel": "#eee8d5",
    },
  },
  paper: {
    name: "Paper",
    claudeTheme: "light",
    vars: {
      "--bg": "#f1f1ef",
      "--panel": "#ffffff",
      "--panel-head": "#f7f7f5",
      "--border": "#e0e0dc",
      "--text": "#2a2a2e",
      "--text-dim": "#8a8a92",
      "--green": "22, 163, 74",
      "--amber": "217, 119, 6",
      "--red": "220, 38, 38",
      "--blue": "37, 99, 235",
      "--hilite": "0, 0, 0",
      "--theme-term-bg": "#ffffff",
      "--theme-term-fg": "#2a2a2e",
      "--theme-term-cursor": "#2a2a2e",
      "--theme-term-sel": "#e4e4e7",
    },
  },
};

export function getTheme(id) {
  return THEMES[id] ?? THEMES.midnight;
}

// xterm.js theme object derived from a theme's variables. With a custom
// background image the terminal bg goes fully transparent — the tinted
// .pane-term CSS layer (surface-alpha / frosted glass) shows through instead.
export function terminalThemeFromVars(v, transparent = false) {
  return {
    background: transparent ? "#00000000" : v["--theme-term-bg"],
    foreground: v["--theme-term-fg"],
    cursor: v["--theme-term-cursor"],
    cursorAccent: v["--theme-term-bg"],
    selectionBackground: v["--theme-term-sel"],
  };
}

// Effective vars for a settings object: the "auto" theme uses vars sampled
// from the wallpaper (persisted in settings.autoThemeVars by the settings
// window); anything else is a predefined theme.
export function themeVars(settings) {
  return settings.theme === "auto" && settings.autoThemeVars
    ? settings.autoThemeVars
    : getTheme(settings.theme).vars;
}
