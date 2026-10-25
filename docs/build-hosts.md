# Build hosts

A build host is another machine that builds, runs and screenshots your
projects. Agents use one through `agentbench-build`. Run commands can target
one too, and their output streams into a normal run pane.

It is only an SSH target. Unlike a [remote host](linux-vm.md), it runs no
AgentBench daemons, so it can be Linux, a Mac, or Windows with OpenSSH
Server.

## Setup

**Settings → Build hosts → type `user@host` → Add.** AgentBench checks the
machine over SSH. It then lists the capture kits that machine supports, each
with an **Install** button:

| Kit         | What it captures                     | Host                  |
| ----------- | ------------------------------------ | --------------------- |
| Web pages   | any URL, in headless Chromium/WebKit | Linux or macOS        |
| Linux apps  | Tauri, Electron, GTK, Qt windows     | Linux                 |
| Windows apps| any Win32, WebView2 or Electron app  | Windows               |
| Android     | an .apk, package or URL              | Linux (with KVM), Mac |
| iOS         | a simulator .app build, or a URL     | macOS with Xcode      |
| macOS apps  | an .app, inside a Tart VM            | Apple Silicon Mac     |

A Linux or macOS host needs key or agent SSH auth (no password prompt),
`curl`, `tar` and `bash`. Windows hosts are covered under
[Windows hosts](#windows-hosts). Use a dedicated user account: agents run builds there without asking
first, so give them an account with nothing else in it.

## Nothing shows on the host's screen

Every capture runs somewhere nobody is looking:

- **Web pages:** headless browsers.
- **Linux apps:** a private Xvfb display per capture, created and destroyed
  each time, with software rendering.
- **iOS:** a simulator in AgentBench's own device set. It boots with
  `simctl` and Simulator.app is never opened, so there is no window, and your
  own simulators are never touched.
- **Windows apps:** a desktop created for the capture and never switched to.
  Windows lays the app out there and PrintWindow draws it into a bitmap.
  Clicks and typing go to the window as messages, never through the real
  mouse and keyboard.
- **Android:** an emulator started with `-no-window`.
- **macOS apps:** a Tart VM run with `--no-graphics`. The app opens inside the
  VM, never on the host's desktop.

Simulators, emulators and VMs stay warm between captures, because a cold boot
takes a minute. `agentbench-build stop` shuts them down.

## Moving files

Files only travel over your SSH connection, the same one `ssh host` uses.
Your `~/.ssh/config`, keys, `ProxyJump` and so on all apply. A new host's key
is trusted on first connect and pinned after that.

**To the host.** Before every run or capture, the files that changed since
last time are sent as one compressed tar, and files you deleted are removed
there. What gets sent:

- Git decides: tracked files, plus untracked files that are not ignored.
  `node_modules`, `target` and the rest of `.gitignore` stay home. The host
  keeps its own copies of those between runs, so builds there are
  incremental.
- Secret-looking files are held back even when git would include them:
  `.env*`, `*.pem`, `*.key`, keystores, provisioning profiles, SSH keys,
  `.npmrc`, `.netrc`, `credentials.json`. List one under `include` if a build
  genuinely needs it.
- Anything under `exclude` is held back too.

**From the host.** After a successful `run`, the `artifacts` globs are copied
back into `.agentbench/artifacts/<host>/<time>/`. Screenshots land in
`.agentbench/shots/`. `agentbench-build pull <glob>` fetches anything else.
The archive from the host is treated as untrusted: it is saved to a temp file
and every entry is checked first. Absolute paths, `..`, symlinks, hard links
and device files are refused outright, so a compromised build host cannot
write outside that folder.

## The project file

`.agentbench/build.json`. Every key is optional:

```json
{
  "host": "build@10.0.0.20",
  "tools": ["node@22", "rust@stable"],
  "packages": ["libwebkit2gtk-4.1-dev", "build-essential"],
  "kits": ["web", "linux"],
  "artifacts": ["src-tauri/target/release/bundle/**"],
  "exclude": ["design/raw/**"],
  "include": [".env.production"],
  "env": { "NODE_ENV": "production" }
}
```

- `tools` are [mise](https://mise.jdx.dev) specs, installed on first use. The
  project's own `mise.toml` or `.tool-versions` works too.
- `packages` are system packages. They are installed only if the host allows
  passwordless sudo. Otherwise `agentbench-build provision` prints the one
  command a person must run there.

## Where things land on the host

```
~/.agentbench/builds/
  bin/          abkit.sh, shot.mjs, mise, tart
  kit/          Playwright
  toolchains/   mise installs, cargo/rustup, browsers, Android SDK + AVD,
                Tart VMs, the private simulator device set
  cache/        npm, gradle, mise and pip caches, shared by projects
  projects/<name>-<hash>/
    src/        the synced project, plus the host's own build outputs
    shots/      captures before they are copied back
```

Nothing is written outside that folder, except system packages and Xcode's
own simulator runtimes. To remove everything, delete `~/.agentbench/builds`.

## Windows hosts

Windows 10/11 or Server 2019+ with the built-in OpenSSH Server. In an
administrator PowerShell on that machine:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic; Start-Service sshd
```

Then add your Mac's public key:
- **Administrator account:** `C:\ProgramData\ssh\administrators_authorized_keys`
- **Standard account:** `%USERPROFILE%\.ssh\authorized_keys`

Check `ssh user@pc` works from the Mac without a password, then add
`user@pc` in Settings → Build hosts.

What is different on Windows:

- The kit is PowerShell (`abkit.ps1`), and every call is sent with
  `-EncodedCommand`. That works whether the SSH default shell is cmd.exe or
  PowerShell. Files still travel as tar streams, through the `tar.exe` built
  into Windows.
- `run` commands are cmd.exe syntax: `npm run build && dir`.
- `packages` in build.json are winget IDs
  (`Microsoft.VisualStudio.2022.BuildTools`). Installs that need elevation
  only work when the SSH account is an administrator.
- Capture kits: web, windows and android. The Android emulator needs the
  Windows Hypervisor Platform feature enabled.
- **Windows app capture is the least proven path.** Some apps,
  GPU-composited ones especially, may draw blank on a desktop that is never
  shown. If they do, a Hyper-V VM is the fallback, as Tart is on macOS.

## The CLI

`agentbench-build --help` lists every command. The ones agents use most:

```bash
agentbench-build run -- npm run build
agentbench-build shot --web http://localhost:5173 --serve 'npm run dev'
agentbench-build shot --linux ./target/release/app --wait 'My App'
agentbench-build shot --ios build/App.app --device 'iPhone 16'
agentbench-build pull 'dist/**'
```

The CLI is the `build` subcommand of the bundled `agentbench-gateway`. The
app writes a wrapper for it to
`~/.claude/skills/agentbench-build/agentbench-build`, next to the skill that
teaches agents to use it. To let agents run it without a permission prompt
every time, allow that path in your Claude Code permissions.

## Pinned versions

The provisioner installs pinned releases, so a host never pulls whatever
happens to be newest: mise `v2026.10.1` (SHA256-checked), Playwright
`1.63.0`, Tart `2.40.1` (SHA256-checked), Android command-line tools
`15641748`. They are defined at the top of `src-tauri/src/buildhost/abkit.sh`.

## Known limits

- **Test coverage varies by path.** Sync, run, artifacts and iOS capture are
  tested end to end. Web, Linux-app, Android and macOS-VM capture are written
  but not yet tested against a real host.
- **macOS app capture** relies on Tart's guest agent (`tart exec`), which the
  Cirrus Labs images include. The first clone is a download of about 25 GB.
- **Android on Linux** needs `/dev/kvm`. Without it the emulator is too slow
  to use, and `provision` says so.
- **Windows hosts** are tested on GitHub's Windows runners (see
  `.github/workflows/buildhost-windows-test.yml`), not yet against a real PC
  over SSH.
