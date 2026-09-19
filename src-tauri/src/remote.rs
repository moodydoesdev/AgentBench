//! Remote hosts over SSH, the way VS Code's Remote-SSH works: point the app at
//! `user@host`, and it puts the daemons there itself.
//!
//! Everything shells out to the system `ssh`. That is deliberate — it inherits
//! the user's keys, agent, `~/.ssh/config`, `Host` aliases, `ProxyJump` and
//! `Match` blocks for free. A Rust SSH client would reimplement all of it
//! badly, and the host the user already reaches with `ssh vm` must keep
//! working unchanged.
//!
//! What lands on the remote:
//!
//! ```text
//! ~/.agentbench/
//!   bin/{agentbench-broker,agentbench-gateway}
//!   dist/                     the PWA the gateway serves
//!   version                   what is installed, so we can skip or upgrade
//!   run/{broker,gateway}.log  stdio of the detached daemons
//! ```
//!
//! Nothing is installed system-wide, nothing needs sudo, and no systemd unit is
//! written. Both daemons bind loopback on the remote; the SSH tunnel is the
//! only way in, so there is no listening port to secure and no pairing code for
//! anyone to type — we read it back over the same SSH session.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// Where the daemon tarballs live. Matches the `daemons` job in release.yml.
const RELEASE_BASE: &str = "https://github.com/moodydoesdev/AgentBench/releases/download";

/// Give up on a hung SSH rather than wedging the UI forever. Installs are slow
/// (a download and an untar), so they get their own budget.
const EXEC_TIMEOUT: Duration = Duration::from_secs(45);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostProbe {
    /// `x86_64` or `aarch64` — picks the tarball.
    pub arch: String,
    pub os: String,
    pub has_curl: bool,
    /// Version already installed under ~/.agentbench, if any.
    pub installed: Option<String>,
    /// Whether a gateway is answering on the remote right now.
    pub running: bool,
    pub home: String,
    /// Which agent/tooling binaries the host already has on a login-shell
    /// PATH. A VM with the daemons but no `claude` runs nothing, so the UI
    /// needs to know before it claims the host is ready.
    pub bins: Vec<String>,
}

/// Binaries worth reporting: the harnesses the app can launch, plus what their
/// installers need. Kept to bare names — this list is interpolated into a
/// remote shell script.
const PROBE_BINS: &[&str] = &[
    "claude", "codex", "opencode", "gemini", "pi", "omp", "node", "npm", "git", "curl",
];

pub struct Tunnel {
    pub local_port: u16,
    pub child: Child,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `ssh` with the flags every call here wants.
///
/// `BatchMode=yes` is the important one: it makes a host that would prompt for
/// a password fail immediately instead of hanging on a prompt nobody can see.
/// Key or agent auth only, and the error says so.
fn ssh_base(host: &str) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        // One multiplexed connection for the whole session: probe, install,
        // start and pair reuse it instead of paying a handshake each time.
        .arg("-o")
        .arg("ControlMaster=auto")
        .arg("-o")
        .arg(format!("ControlPath={}", control_path()))
        .arg("-o")
        .arg("ControlPersist=120")
        .arg(host);
    cmd
}

fn control_path() -> String {
    // %C is a hash of (host, port, user), so one socket per target.
    let dir = std::env::temp_dir().join("agentbench-ssh");
    let _ = std::fs::create_dir_all(&dir);
    format!("{}/%C", dir.display())
}

/// Run a bash script on the remote and return its stdout.
///
/// The script goes in on stdin rather than as an argument so quoting is not a
/// problem: no shell on either side gets a chance to mangle it.
fn ssh_script(host: &str, script: &str, timeout: Duration) -> Result<String, String> {
    let mut child = ssh_base(host)
        .arg("bash -s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run ssh: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("no stdin on ssh")?
        .write_all(script.as_bytes())
        .map_err(|e| format!("cannot send script: {e}"))?;

    let out = wait_with_timeout(child, timeout)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Err(explain_ssh_failure(&stderr, &stdout))
}

/// Turn ssh's stderr into something a person can act on. The raw text is
/// included either way, but the common failures deserve a sentence.
fn explain_ssh_failure(stderr: &str, stdout: &str) -> String {
    let lower = stderr.to_lowercase();
    let hint = if lower.contains("permission denied") {
        "SSH refused the key. AgentBench only uses key or agent auth, never a \
         password prompt — add your key to the host (ssh-copy-id) or load it \
         into your agent, then try again."
    } else if lower.contains("could not resolve") || lower.contains("name or service not known") {
        "That hostname does not resolve. Check the spelling, or add a Host \
         entry to ~/.ssh/config."
    } else if lower.contains("connection refused") {
        "Nothing is listening on the SSH port. Check the host is up and \
         sshd is running."
    } else if lower.contains("connection timed out") || lower.contains("operation timed out") {
        "The host did not answer. Check it is reachable from here — a \
         firewall or VPN may be in the way."
    } else if lower.contains("host key verification failed") {
        "The host key changed. Remove the stale entry from ~/.ssh/known_hosts \
         if you trust the new one."
    } else {
        ""
    };
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if hint.is_empty() {
        format!("ssh failed: {detail}")
    } else {
        format!("{hint}\n\nssh said: {detail}")
    }
}

/// `Child::wait_with_output` has no timeout, and a wedged ssh would hang the
/// command forever. Poll instead and kill on expiry.
fn wait_with_timeout(
    mut child: Child,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "ssh timed out after {}s with no reply",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("ssh wait failed: {e}")),
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("ssh output failed: {e}"))
}

/// Last JSON object printed by a script, so `set -x` noise or a chatty profile
/// cannot break parsing. Remote shells print MOTDs and all sorts.
fn last_json(out: &str) -> Result<Value, String> {
    out.lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{') && l.ends_with('}'))
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .ok_or_else(|| format!("unexpected reply from the host:\n{}", out.trim()))
}

/// What is on the host already, and can we install there.
pub fn probe(host: &str) -> Result<HostProbe, String> {
    // A login shell for the binary sweep: nvm, asdf, mise and a plain
    // ~/.local/bin all live in the profile, and `claude` is usually in one of
    // them. Probing with the non-login default would report it missing and
    // send us off to reinstall something that is already there.
    let script = format!(
        r#"
set -u
root="$HOME/.agentbench"
ver=""
[ -f "$root/version" ] && ver="$(cat "$root/version" 2>/dev/null || true)"
running=false
if [ -x "$root/bin/agentbench-gateway" ]; then
  "$root/bin/agentbench-gateway" status >/dev/null 2>&1 && running=true
fi
curl_ok=false; command -v curl >/dev/null 2>&1 && curl_ok=true
found="$($SHELL -lc 'for b in {bins}; do command -v "$b" >/dev/null 2>&1 && printf "%s " "$b"; done' 2>/dev/null || true)"
printf '{{"arch":"%s","os":"%s","has_curl":%s,"installed":"%s","running":%s,"home":"%s","bins":"%s"}}\n' \
  "$(uname -m)" "$(uname -s)" "$curl_ok" "$ver" "$running" "$HOME" "$found"
"#,
        bins = PROBE_BINS.join(" ")
    );
    let out = ssh_script(host, &script, EXEC_TIMEOUT)?;
    let v = last_json(&out)?;
    let installed = v["installed"].as_str().unwrap_or("").trim().to_string();
    let os = v["os"].as_str().unwrap_or("").to_string();
    if os != "Linux" {
        return Err(format!(
            "{host} reports itself as {os}. Remote hosts are Linux only for now."
        ));
    }
    let arch = match v["arch"].as_str().unwrap_or("") {
        "x86_64" | "amd64" => "x86_64".to_string(),
        "aarch64" | "arm64" => "aarch64".to_string(),
        other => {
            return Err(format!(
                "no daemon build for {other}. Supported: x86_64, aarch64."
            ))
        }
    };
    Ok(HostProbe {
        arch,
        os,
        has_curl: v["has_curl"].as_bool().unwrap_or(false),
        installed: (!installed.is_empty()).then_some(installed),
        running: v["running"].as_bool().unwrap_or(false),
        home: v["home"].as_str().unwrap_or("").to_string(),
        bins: v["bins"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_string)
            .collect(),
    })
}

/// Run a harness installer on the remote — `npm install -g
/// @anthropic-ai/claude-code` and friends, the same strings the app already
/// uses locally, so there is one definition of how each agent is installed.
///
/// Runs in a login shell so nvm/asdf/mise node is on PATH, and so a freshly
/// installed binary lands somewhere the next login shell will find.
pub fn install_harness(host: &str, command: &str) -> Result<String, String> {
    // The command comes from the app's harness table, not from free text the
    // user typed, but it still ends up in a remote shell: refuse anything
    // carrying a newline so one entry cannot become two commands.
    if command.contains('\n') || command.contains('\r') {
        return Err("install command must be a single line".into());
    }
    let script = format!(
        r#"
set -eu
"$SHELL" -lc {cmd}
printf '{{"ok":true}}\n'
"#,
        cmd = shell_quote(command)
    );
    let out = ssh_script(host, &script, INSTALL_TIMEOUT)?;
    last_json(&out).map(|_| format!("installed via: {command}"))
}

/// Single-quote for POSIX sh: wrap in quotes and turn each embedded quote
/// into '\''. Nothing inside can then be interpreted by the remote shell.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Download and unpack the daemons into ~/.agentbench. Idempotent: the same
/// version already present is left alone unless `force`.
pub fn install(host: &str, version: &str, arch: &str, force: bool) -> Result<String, String> {
    let name = format!("agentbench-daemons-{arch}-linux");
    let url = format!("{RELEASE_BASE}/v{version}/{name}.tar.gz");
    let script = format!(
        r#"
set -eu
root="$HOME/.agentbench"
want="{version}"
if [ "{force}" != "true" ] && [ -f "$root/version" ] && [ "$(cat "$root/version")" = "$want" ]; then
  printf '{{"ok":true,"skipped":true,"version":"%s"}}\n' "$want"; exit 0
fi
command -v curl >/dev/null 2>&1 || {{ echo "curl is not installed on this host" >&2; exit 1; }}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp/d.tar.gz" "{url}"
tar -xzf "$tmp/d.tar.gz" -C "$tmp"
src="$tmp/{name}"
[ -d "$src" ] || {{ echo "tarball did not contain {name}" >&2; exit 1; }}
mkdir -p "$root/bin" "$root/run"
# Replace rather than overwrite in place: a running daemon holds its inode,
# and writing over a busy binary fails with ETXTBSY.
for b in agentbench-broker agentbench-gateway; do
  rm -f "$root/bin/$b.old"
  [ -f "$root/bin/$b" ] && mv "$root/bin/$b" "$root/bin/$b.old"
  cp "$src/$b" "$root/bin/$b"
  chmod +x "$root/bin/$b"
done
rm -rf "$root/dist"
cp -r "$src/dist" "$root/dist"
printf '%s' "$want" > "$root/version"
printf '{{"ok":true,"skipped":false,"version":"%s"}}\n' "$want"
"#
    );
    let out = ssh_script(host, &script, INSTALL_TIMEOUT)?;
    let v = last_json(&out)?;
    Ok(if v["skipped"].as_bool().unwrap_or(false) {
        format!("already at {version}")
    } else {
        format!("installed {version}")
    })
}

/// Start both daemons detached on the remote, bound to loopback, and report
/// the gateway port. Safe to call when they are already up.
pub fn start(host: &str, gateway_port: u16) -> Result<u16, String> {
    let script = format!(
        r#"
set -eu
root="$HOME/.agentbench"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
# setsid + nohup so the daemons outlive this SSH session. They must survive
# the connection dropping, exactly like the desktop's detached helpers.
if ! "$root/bin/agentbench-gateway" status >/dev/null 2>&1; then
  setsid nohup "$root/bin/agentbench-broker" --listen 127.0.0.1:0 \
    >>"$root/run/broker.log" 2>&1 < /dev/null &
  sleep 1
  setsid nohup "$root/bin/agentbench-gateway" --bind 127.0.0.1 --port {gateway_port} \
    >>"$root/run/gateway.log" 2>&1 < /dev/null &
fi
for i in $(seq 1 40); do
  if "$root/bin/agentbench-gateway" status >/dev/null 2>&1; then
    printf '{{"ok":true,"port":%s}}\n' "{gateway_port}"; exit 0
  fi
  sleep 0.5
done
echo "the gateway did not come up; last log lines:" >&2
tail -n 20 "$root/run/gateway.log" >&2 || true
exit 1
"#
    );
    let out = ssh_script(host, &script, EXEC_TIMEOUT)?;
    let v = last_json(&out)?;
    v["port"]
        .as_u64()
        .map(|p| p as u16)
        .ok_or_else(|| "the host did not report a gateway port".to_string())
}

/// Mint a pairing code on the remote and read it back over SSH. This is what
/// removes the manual step: SSH has already authenticated us, so the code
/// never has to reach a human.
pub fn pair_code(host: &str) -> Result<String, String> {
    let out = ssh_script(
        host,
        r#"set -eu
"$HOME/.agentbench/bin/agentbench-gateway" pair --force --json"#,
        EXEC_TIMEOUT,
    )?;
    let v = last_json(&out)?;
    v["code"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "the host minted no pairing code".to_string())
}

/// Hold a local port open onto the remote gateway for as long as the returned
/// Tunnel lives.
pub fn tunnel(host: &str, remote_port: u16) -> Result<Tunnel, String> {
    let local_port = free_local_port()?;
    let child = ssh_base(host)
        .arg("-N")
        .arg("-L")
        .arg(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot open the tunnel: {e}"))?;

    let mut t = Tunnel { local_port, child };
    // The forward is not usable the instant ssh starts. Poll the port rather
    // than sleeping a guessed amount.
    for _ in 0..60 {
        if let Ok(Some(status)) = t.child.try_wait() {
            return Err(format!("the tunnel exited immediately ({status})"));
        }
        if std::net::TcpStream::connect_timeout(
            &([127, 0, 0, 1], local_port).into(),
            Duration::from_millis(120),
        )
        .is_ok()
        {
            return Ok(t);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("the tunnel never started accepting connections".into())
}

fn free_local_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Stop the daemons on a remote host.
pub fn stop(host: &str) -> Result<(), String> {
    ssh_script(
        host,
        r#"set -u
root="$HOME/.agentbench"
[ -x "$root/bin/agentbench-gateway" ] && "$root/bin/agentbench-gateway" status >/dev/null 2>&1 && {
  pkill -f "$root/bin/agentbench-gateway" || true
  pkill -f "$root/bin/agentbench-broker" || true
}
printf '{"ok":true}\n'"#,
        EXEC_TIMEOUT,
    )
    .map(|_| ())
}

/// Tail the remote logs, for when the UI has to explain why a host failed.
pub fn logs(host: &str, lines: u32) -> Result<String, String> {
    ssh_script(
        host,
        &format!(
            r#"set -u
for f in broker gateway; do
  echo "== $f =="
  tail -n {lines} "$HOME/.agentbench/run/$f.log" 2>/dev/null || echo "(no log)"
done"#
        ),
        EXEC_TIMEOUT,
    )
}

/// Everything the desktop needs, as one JSON blob, for the Tauri layer.
pub fn describe(probe: &HostProbe) -> Value {
    json!({
        "arch": probe.arch,
        "os": probe.os,
        "hasCurl": probe.has_curl,
        "installed": probe.installed,
        "running": probe.running,
        "home": probe.home,
        "bins": probe.bins,
        "hasClaude": probe.bins.iter().any(|b| b == "claude"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_json_ignores_motd_and_profile_noise() {
        let out = "Welcome to Ubuntu 22.04\nLast login: Tue\n{\"arch\":\"x86_64\"}\n";
        assert_eq!(last_json(out).unwrap()["arch"], "x86_64");
    }

    #[test]
    fn last_json_takes_the_last_object() {
        let out = "{\"a\":1}\n{\"a\":2}\n";
        assert_eq!(last_json(out).unwrap()["a"], 2);
    }

    #[test]
    fn last_json_errors_with_the_output_when_there_is_none() {
        let err = last_json("bash: line 1: oops\n").unwrap_err();
        assert!(err.contains("oops"), "{err}");
    }

    #[test]
    fn permission_denied_explains_key_auth() {
        let msg = explain_ssh_failure("user@h: Permission denied (publickey).", "");
        assert!(msg.contains("key or agent auth"), "{msg}");
        assert!(msg.contains("Permission denied"), "{msg}");
    }

    #[test]
    fn unknown_failures_still_carry_the_detail() {
        let msg = explain_ssh_failure("something odd happened", "");
        assert!(msg.contains("something odd happened"), "{msg}");
    }

    #[test]
    fn stdout_is_used_when_stderr_is_empty() {
        let msg = explain_ssh_failure("", "it broke");
        assert!(msg.contains("it broke"), "{msg}");
    }

    #[test]
    fn shell_quote_neutralises_embedded_quotes() {
        assert_eq!(shell_quote("npm i -g x"), "'npm i -g x'");
        // The classic break-out: a quote, then a second command.
        let hostile = shell_quote("x'; rm -rf ~; echo '");
        assert_eq!(hostile, r"'x'\''; rm -rf ~; echo '\'''");
        // Whatever it contains, it is one single-quoted word to the shell.
        assert!(hostile.starts_with('\'') && hostile.ends_with('\''));
    }

    #[test]
    fn install_harness_refuses_multiline_commands() {
        let err = install_harness("nowhere", "npm i -g x\nrm -rf /").unwrap_err();
        assert!(err.contains("single line"), "{err}");
    }

    /// Drives the real `ssh` binary, so it depends on the machine it runs on.
    /// Ignored by default; run it with
    /// `cargo test --no-default-features -- --ignored probe_against`
    /// and point AGENTBENCH_TEST_SSH_HOST at a host to check a live install.
    #[test]
    #[ignore]
    fn probe_against_a_real_ssh() {
        let host = std::env::var("AGENTBENCH_TEST_SSH_HOST").unwrap_or_else(|_| "localhost".into());
        match probe(&host) {
            Ok(p) => {
                assert_eq!(p.os, "Linux");
                assert!(matches!(p.arch.as_str(), "x86_64" | "aarch64"));
            }
            // With no sshd on the other end this is the path under test: a
            // real ssh failure that came back as a sentence, not a hang.
            Err(e) => assert!(
                !e.is_empty() && !e.contains("timed out"),
                "probe should fail fast with an explanation, got: {e}"
            ),
        }
    }
}
