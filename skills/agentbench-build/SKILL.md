---
name: agentbench-build
description: >-
  Build, run and screenshot the project on an AgentBench build host — another
  machine reached over SSH. Use to compile on a faster box or a different OS,
  install toolchains for a build, or look at what a web page, Linux desktop
  app, iOS app, Android app or macOS app actually renders. Captures are
  headless and never show on the build machine's screen, so use it freely
  without asking.
---

# Build hosts

`agentbench-build` runs work on another machine and brings the results back.
The CLI sits next to this file:

```bash
B=~/.claude/skills/agentbench-build/agentbench-build
$B hosts            # the saved build hosts, and which capture kits are ready
$B where            # this project's root, its folder on the host, the host
```

If `hosts` lists none, tell the user to add one in **Settings → Build hosts**
(or run `$B add user@host` if they gave you a host). Don't guess hostnames.

## What happens on each call

- Changed files go to the host over SSH first, by default. Gitignored files
  (`node_modules`, `target`) and secrets (`.env`, keys, keystores) stay
  local. The host's own build outputs survive between runs, so builds there
  are incremental.
- Work runs in `~/.agentbench/builds/projects/<slug>/src` on the host,
  never anywhere else on it.
- Only one build per project runs at a time. A second one waits its turn.

## Build or run

```bash
$B run -- npm run build
$B run -- 'cargo build --release && ls -la target/release'
```

Output streams back and the exit code is the remote command's. Quote
commands that use `&&`, pipes or redirects. After a successful run, any
`artifacts` listed in `.agentbench/build.json` are copied back to
`.agentbench/artifacts/<host>/<time>/`, and the paths are printed. For
anything else, use `$B pull 'dist/**'`.

## Toolchains

Put what the build needs in `.agentbench/build.json` (create it if missing):

```json
{
  "tools": ["node@22", "rust@stable"],
  "packages": ["libwebkit2gtk-4.1-dev", "build-essential"],
  "kits": ["web", "linux"],
  "artifacts": ["src-tauri/target/release/bundle/**", "dist/**"]
}
```

- `tools` are mise specs (`node@22`, `python@3.12`, `go@1.23`,
  `java@temurin-21`, `bun@latest`, `rust@stable`). They are installed into
  the builds folder on first use and put on PATH for every run and capture.
  The project's own `mise.toml` or `.tool-versions` is honoured too.
- `packages` are system packages. They install only if the host allows
  passwordless sudo. Otherwise `provision` prints the one command the user
  must run there. Relay that command to the user; don't try to work around it.
- Run `$B provision` once after changing `tools`, `packages` or `kits`.

Other keys: `host` (preferred host), `env` (extra environment), `exclude`
(globs never sent), `include` (secret-looking files the build really needs,
e.g. `.env.production`).

## Screenshots

Every capture runs where nobody sees it: a headless browser, a private
virtual display, a simulator or emulator with no window, or a VM. Each call
prints a local PNG path. **Read that PNG** to see the result.

```bash
# web — a deployed URL, or a dev server started on the host first
$B shot --web https://staging.example.com/settings
$B shot --web http://localhost:5173/ --serve 'npm run dev' --wait 'text=Dashboard'
$B shot --web http://localhost:5173/login --serve 'npm run dev' \
   --do 'type:#email=a@b.co' --do 'click:button[type=submit]' --wait '.inbox' --full

# Linux desktop app (Tauri, Electron, GTK, Qt) on a virtual display
$B shot --linux ./src-tauri/target/release/myapp --wait 'My App' --size 1280x800

# iOS simulator (macOS host): a simulator .app build, or a URL in Safari
$B shot --ios build/Build/Products/Debug-iphonesimulator/App.app --device 'iPhone 16'
$B shot --ios http://localhost:3000 --serve 'npm run dev'

# Android emulator: an .apk, an installed package, or a URL
$B shot --android app/build/outputs/apk/debug/app-debug.apk

# macOS app inside a VM (Apple Silicon host)
$B shot --mac build/Release/MyApp.app
```

Options: `--size WxH`, `--full` (whole page), `--wait <selector or window
title>`, `--delay <ms>`, `--appearance dark|light`, `--device <name>`,
`--browser chromium|webkit`, `--name <label>`.

`--do` steps run in order before the capture:
- web: `click:SEL`, `type:SEL=TEXT`, `press:Enter`, `hover:SEL`, `wait:SEL`,
  `goto:/path`, `scroll:800`, `sleep:500`
- Linux: `click:X,Y`, `type:TEXT`, `key:ctrl+s`, `window:TITLE`, `sleep:MS`
- Android: `tap:X,Y`, `type:TEXT`, `key:KEYCODE_BACK`, `sleep:MS`

Web captures also print the HTTP status, console errors and uncaught
exceptions. Read them: a blank screenshot plus a TypeError explains itself.

The first capture of a kind is slow, because a simulator, emulator or VM has
to boot. They are then kept warm. Run `$B stop` when you are done with them.

## Iterate

1. Build or capture.
2. Read the PNG, the output, or both.
3. Fix the code locally.
4. Repeat. Each call re-syncs only what changed.

To show the user a screenshot or artifact, link its absolute path (see the
agentbench-files skill).

## Don't

- Don't `ssh` to build hosts yourself, or copy files there by hand. The CLI
  handles syncing, locking, and keeping secrets local.
- Don't put credentials in `env`. Ask the user how the build should get them.
- If a kit shows `missing` or `needs`, say so and pass on the exact command
  from `$B hosts` or `$B provision`. Don't improvise installs on the host.
