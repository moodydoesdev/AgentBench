# Running AgentBench on a Linux VM

Run the two daemons on a VM and drive the projects there from the AgentBench
app on your laptop, as a linked bench. No GUI is installed on the VM and no
webkit is pulled in.

## What runs where

```
VM (headless Linux)                     Your laptop
  agentbench-broker   owns the ptys       AgentBench.app
  agentbench-gateway  auth + bridge  <--  Settings -> Linked benches
        |                                        |
        +-- claude / codex in ptys               +-- the VM's projects and
                                                     panes in the sidebar
reached over: tailnet, or `ssh -L`
```

The broker has no authentication and its `create` op runs a command line, so
it stays on loopback. The gateway is the only thing that should be reachable,
and only over a tailnet or an SSH tunnel — it speaks plain HTTP, and a device
token is full code execution as the service user.

## Build

The daemons build without Tauri, so the VM needs no webkit2gtk and no
frontend build:

```sh
cargo build --release --no-default-features \
  --bin agentbench-broker --bin agentbench-gateway
```

Cross-compiling from a Mac is not set up; build on the VM, or on any Linux box
with a matching glibc.

## Install

```sh
# binaries
sudo install -m755 target/release/agentbench-broker  /usr/local/bin/
sudo install -m755 target/release/agentbench-gateway /usr/local/bin/

# the mobile PWA the gateway serves (from `npm run build` on any machine)
sudo mkdir -p /usr/local/share/agentbench
sudo cp -r dist /usr/local/share/agentbench/

# units — templates, instantiated per user
sudo cp packaging/systemd/agentbench-*@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

`curl` must be present. The broker delivers Claude Code hook events through
it, and without it every pane silently looks dead:

```sh
sudo apt-get install -y curl
```

## Start

Replace `youruser` with the account that owns the projects:

```sh
sudo systemctl enable --now agentbench-broker@youruser
sudo systemctl enable --now agentbench-gateway@youruser
systemctl status agentbench-broker@youruser
```

The units set `HOME`, `SHELL`, `PATH` and `HOSTNAME` explicitly. All four are
absent or wrong in a bare systemd environment, and each one breaks something:
no `HOME` panics the broker at startup, no `SHELL` used to mean no pane could
spawn, a thin `PATH` hides `claude`, and no `HOSTNAME` makes the VM advertise
itself as "workstation". Edit `PATH` if node lives somewhere unusual.

## Connect from your laptop

### Tailscale

```sh
# on the VM
tailscale up
tailscale serve --bg 8473      # optional: terminates TLS for you
```

Then on the VM, mint a pairing code:

```sh
agentbench-gateway pair
```

In the app: **Settings → Linked benches**, enter the address and code it
printed, press **Link both ways**. The VM's projects appear in the sidebar.

### SSH tunnel

```sh
# on your laptop
ssh -L 8473:localhost:8473 youruser@vm
```

Then `agentbench-gateway pair` on the VM, and link to `http://localhost:8473`
with that code.

## Checking it

```sh
agentbench-gateway status        # advertised port, pid, paired devices
journalctl -u agentbench-broker@youruser -f
```

`status` prints `"brokerConnected": true` once the gateway has found the
broker.

## Stopping

```sh
sudo systemctl stop agentbench-gateway@youruser agentbench-broker@youruser
```

The broker traps SIGTERM, kills its panes and removes `broker.json`, so
nothing is left holding a stale port.

## Known gaps

- **No TLS.** Use `tailscale serve` or an SSH tunnel. Do not port-forward 8473.
- **Memory-pressure hibernation is weaker on Linux.** The macOS path asks the
  kernel; Linux falls back to an available/total ratio, which reads "normal"
  until you are near OOM. Leave `pressure_enabled` off, or expect it to fire
  late.
- **Dictation is macOS-only** and is not compiled into these builds.
