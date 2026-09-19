# Agent resource management

Open **Agent resources** from the CPU icon in the top bar or Settings → Workspace.

The broker samples live process trees every five seconds. Memory is resident RAM
(RSS), not virtual address space or macOS's compressed-memory footprint. Shared
pages can occur in more than one process's RSS. CPU is normalized across the
machine's logical CPUs. On macOS, pressure comes from the kernel pressure signal;
on other platforms, the panel uses available-memory thresholds.

## Hibernation and restoration

Hibernation is initially enabled for Claude terminal and headless chat sessions
on Unix platforms. Other harnesses still have CPU and memory metrics, but cannot
hibernate until their restore path is supported. A new broker and freshly
launched/restored agents are required to install the resource-tracking hooks.

A hibernated pane keeps a readable transcript and its pane layout. Resume starts
the stored harness in its original directory, with the saved session ID, shell,
and theme. A pin keeps an agent alive and survives broker restoration.

The broker refuses hibernation for:

- unverified sessions, unsupported harnesses, or missing resource hooks;
- active turns, tools, approval prompts, or unconfirmed background work;
- focused chat composers, unsent messages, and staged attachments;
- pinned agents and agents without 60 seconds of confirmed idle time;
- unrecognized child processes, or an unverified process identity.

Background completion notices in Claude's queue/attachment records reconcile
missed completion hooks. Arbitrary tool output is not treated as proof that a job
finished. The Background Tasks rail separates recently active entries from
unconfirmed ones; dismissing an unconfirmed entry never stops a process.

Before shutdown, the broker freezes the verified process tree, rechecks activity,
and atomically saves `hibernated.json` beside `broker.json`. Only then does it
terminate those exact process identities. A failed checkpoint thaws the tree.
Resume refuses to duplicate an original process that is still alive. A persisted
resume-in-progress marker makes a broker crash during launch fail closed rather
than silently starting the same session twice. Transcripts are never deleted.

Hibernation preserves the conversation, not arbitrary in-memory application or
MCP-server state. Long-lived MCP helpers and Rust language servers may be stopped
with their owning agent. Other child processes, including development servers and
compilers, prevent hibernation.

## Optional automation

Automatic idle cleanup and automatic pressure cleanup both default to **off**.
Idle cleanup defaults to 30 minutes when enabled. Pressure cleanup is an explicit
separate choice. The broker handles at most one oldest eligible agent every 30
seconds and rechecks policy and activity before each shutdown. A pressure banner
lets the user review agents without enabling automatic cleanup.

## Interface memory

Hidden xterm panes release their WebGL renderer. Hidden terminal output is
batched, flushing every second or at 64 KiB without dropping VT bytes. Chat views
continue consuming events while hidden without scheduling a render per update.
Offscreen chat blocks use browser content visibility. Terminal scrollback defaults
to 2,000 lines, configurable between 500 and 8,000 in Settings.

## Checks

- `node --test tests/*.test.mjs`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `npm run build`

Lifecycle tests use disposable `sleep` processes and temporary session files;
they never signal existing agents or write to the user's broker configuration.
