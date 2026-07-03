<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo-light.svg" alt="AgentBench" width="440">
  </picture>
</p>

<p align="center">
  <b>Run a whole bench of Claude Code agents, side by side.</b><br>
  A multi-agent workspace that turns one screen into a grid of live coding agents.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-8f4eea">
  <img alt="Built with Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-6a45e7">
  <img alt="React" src="https://img.shields.io/badge/UI-React%2019-4507a1">
</p>

---

AgentBench is a desktop app for people who run more than one Claude Code
session at a time. Instead of juggling terminal tabs, you get a grid of agent
panes per project — each one a full terminal running `claude` — with the app
keeping watch so you don't have to.

## Why

Agents spend most of their time working without you. The bottleneck is
noticing *when they need you*. AgentBench makes that moment impossible to
miss, and makes everything in between effortless.

## Features

- **Agent grid** — spawn as many agents as you need per project, arranged in a
  resizable, drag-to-reorder grid. One click to add another.
- **Knows when a turn ends** — panes glow green when an agent finishes and
  pulse amber when one is waiting on your input. No output-scraping guesswork;
  it's wired into Claude Code itself.
- **Pings you anywhere** — a soft chime plus a native OS notification when the
  app is in the background. Walk away, come back only when needed.
- **Projects sidebar** — group agents by repository and flip between projects
  instantly; every pane keeps running in the background.
- **Agents survive restarts** — close the app, reopen it, and your agents are
  still there with full scrollback. Even a reboot restores them via
  `claude --resume`.
- **Visual plans** — agents can publish rich, interactive plan documents
  (diagrams, file maps, annotated code) that open right next to their
  terminal. Review, comment, and send feedback without leaving the app.
- **Themes** — nine color schemes from Midnight to Solarized Light, applied
  across the whole app *and* inside every terminal.
- **Auto-updates** — signed updates delivered straight from GitHub Releases.
  The app checks on launch, installs in place, and restarting brings every
  agent back exactly where it was.

## Status at a glance

| Pane          | Meaning                          |
| ------------- | -------------------------------- |
| 🔵 pulsing dot | agent is working                 |
| 🟢 green glow  | turn finished — results ready    |
| 🟡 amber pulse | waiting on your permission/input |
| 🔴 red dot     | process exited                   |

Click into a pane and the glow clears — you're caught up.

## Getting started

Prereqs: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` on your PATH), Node 20+, Rust toolchain.

```bash
npm install
npm run tauri dev      # run the app
npm run tauri build    # package it (.app / .msi)
```

Add a project, hit **New Agent**, and start delegating.
