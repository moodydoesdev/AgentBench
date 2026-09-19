# Running AgentBench on a Linux VM

Point AgentBench at an SSH host and it installs itself there, the way VS
Code's Remote-SSH does. The VM's projects then appear in your sidebar, and
the panes and terminals you open in them run on the VM.

## The whole setup

**Settings → Remote hosts → type `user@host` → Connect.**

That is it. Behind that button:

1. SSH in and check the OS, architecture and what is already installed
2. Download the daemons to `~/.agentbench/` — no sudo, no systemd, no Rust
3. Start them bound to loopback
4. Open an SSH tunnel
5. Mint a pairing code on the host and redeem it over the same SSH session

You never see a pairing code, and nothing on the VM listens on a public
interface. The tunnel is the only way in, so there is no port to firewall.

Progress for each step shows in Settings; a failure prints the ssh error with
a sentence about what to do.

## What the host needs

- Linux on x86_64 or aarch64
- **Key or agent SSH auth.** AgentBench runs ssh with `BatchMode=yes`, so a
  host that would prompt for a password fails immediately rather than hanging
  on a prompt nobody can see. `ssh-copy-id user@host` first if needed.
- `curl`, which is how the daemons are fetched

Anything in `~/.ssh/config` works, including `Host` aliases, `ProxyJump` and
per-host keys — AgentBench shells out to your system `ssh` rather than
reimplementing it, so `Connect` to `myvm` behaves exactly like `ssh myvm`.

## Installing the agents

A VM with the daemons but no `claude` is reachable but useless. After
connecting, the host row in Settings lists any missing harnesses with an
**Install** button next to each. It runs the same install command the app
uses locally, in a login shell on the host, so nvm/asdf/mise node is found.

`claude` itself needs node on the host. If the install fails for that reason,
install node there however you normally would and press Install again.

## Where things land

```
~/.agentbench/
  bin/{agentbench-broker,agentbench-gateway}
  dist/                     the web assets the gateway serves
  version                   what is installed, so upgrades are detected
  run/{broker,gateway}.log  daemon output — the Logs button tails these
```

Nothing is written outside the home directory and nothing needs root. The
daemons are started detached, so they survive the SSH session closing and
keep your agents running when you close the laptop.

## Day to day

- Saved hosts reconnect on launch. A host that is off just fails quietly and
  can be reconnected from Settings.
- **Reinstall** forces the daemons to be replaced, e.g. after an app upgrade.
- **Logs** tails the daemon logs over SSH.
- **Forget** drops the tunnel, removes the saved token, and stops the daemons
  on the host.

## Known limits

- **Password-only SSH is not supported.** Use a key.
- **Linux only**, x86_64 or aarch64.
- **Memory-pressure hibernation is weaker on Linux** than on macOS: the macOS
  path asks the kernel, Linux falls back to an available/total ratio that
  reads "normal" until you are near OOM. Leave it off.
- **Dictation is macOS-only** and is not in the daemon builds.

## Doing it by hand

You should not need this — it is here for anyone packaging AgentBench for a
fleet, or debugging the automatic path.

```sh
# on the VM, from a checkout
cd src-tauri
cargo build --release --no-default-features \
  --bin agentbench-broker --bin agentbench-gateway
cd .. && npm ci && npm run build

mkdir -p ~/.agentbench/bin ~/.agentbench/run
cp src-tauri/target/release/agentbench-{broker,gateway} ~/.agentbench/bin/
cp -r dist ~/.agentbench/dist

~/.agentbench/bin/agentbench-broker  --listen 127.0.0.1:0 &
~/.agentbench/bin/agentbench-gateway --bind 127.0.0.1 --port 8473 &
~/.agentbench/bin/agentbench-gateway pair
```

Then `ssh -L 8473:localhost:8473 user@vm` from your laptop and pair against
`http://localhost:8473` under **Settings → Linked benches**. Systemd units for
a permanent, multi-user install are in `packaging/systemd/`.
