//! Cloudflare tunnel lifecycle: run `cloudflared` in front of the gateway so
//! the web UI is reachable from anywhere, over Cloudflare's TLS, without a
//! port forward.
//!
//! The daemon philosophy matches the broker and gateway: cloudflared is
//! spawned detached and advertised in `tunnel.json`, so closing the desktop
//! app does not cut off a browser session mid-agent. Stop is explicit.
//!
//! Two modes:
//! - "quick": `cloudflared tunnel --url …` — no Cloudflare account state at
//!   all; the public URL is a random *.trycloudflare.com name parsed out of
//!   cloudflared's own log.
//! - "named": `cloudflared tunnel run <name>` — the user's own domain,
//!   configured once with `cloudflared login` + a DNS route; we only run it.
//!
//! Keep-alive: starting a tunnel records what was asked for in
//! `tunnel-keepalive.json`; the gateway daemon (which outlives the desktop
//! app) calls `ensure_running` on a timer and relaunches cloudflared if it
//! died. Only an explicit `stop` clears the record, so a crash, a sleep/wake
//! or a killed process comes back by itself while a deliberate stop sticks.
//!
//! cloudflared is never installed by the app — only found. Installing network
//! binaries is the user's call (`brew install cloudflared`).

use serde_json::{json, Value};

fn tunnel_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("tunnel.json")
}

fn log_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("tunnel.log")
}

fn prev_log_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("tunnel.prev.log")
}

fn desired_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("tunnel-keepalive.json")
}

fn lock_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("tunnel.lock")
}

/// What the user last asked for: `{mode, name, port}`. Present = keep it up.
fn read_desired() -> Option<Value> {
    let text = std::fs::read_to_string(desired_file()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Cross-process mutex around starting/stopping cloudflared. The desktop app
/// and the gateway watchdog can both want to spawn one; without this a
/// restart racing a revive would leave two tunnels on the same name.
struct Lock(std::path::PathBuf);

/// A lock older than this belonged to a process that died mid-start.
const LOCK_STALE: std::time::Duration = std::time::Duration::from_secs(90);

impl Lock {
    fn try_at(path: std::path::PathBuf) -> Option<Lock> {
        let _ = std::fs::create_dir_all(path.parent()?);
        for _ in 0..2 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Some(Lock(path)),
                Err(_) => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .map(|age| age > LOCK_STALE)
                        .unwrap_or(true);
                    if !stale {
                        return None;
                    }
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        None
    }

    fn try_acquire() -> Option<Lock> {
        Lock::try_at(lock_file())
    }

    fn acquire(wait: std::time::Duration) -> Option<Lock> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            if let Some(l) = Lock::try_acquire() {
                return Some(l);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Where cloudflared might be. GUI apps on macOS launch with a bare PATH that
/// misses Homebrew, so the well-known install locations are probed directly.
pub fn find_cloudflared() -> Option<String> {
    let candidates = [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
        "cloudflared",
    ];
    for c in candidates {
        if std::process::Command::new(c)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Some(c.to_string());
        }
    }
    None
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // If we spawned it, a dead cloudflared lingers as a zombie until reaped —
    // and a zombie still answers `kill -0`. Reap it (harmless ECHILD when it
    // isn't ours), then ask `ps`, which reports a zombie as state "Z".
    unsafe {
        libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG);
    }
    match std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(o) => {
            let stat = String::from_utf8_lossy(&o.stdout);
            let stat = stat.trim();
            !stat.is_empty() && !stat.starts_with('Z')
        }
        // no ps to ask: fall back to signal 0 through /bin/kill
        Err(_) => std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false),
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

fn read_state() -> Option<Value> {
    let text = std::fs::read_to_string(tunnel_file()).ok()?;
    serde_json::from_str(&text).ok()
}

/// The first https://….trycloudflare.com in the log, if cloudflared has
/// printed one yet.
fn parse_quick_url(log: &str) -> Option<String> {
    for (idx, _) in log.match_indices("https://") {
        let rest = &log[idx..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '|')
            .unwrap_or(rest.len());
        let url = &rest[..end];
        if url.ends_with(".trycloudflare.com") {
            return Some(url.to_string());
        }
    }
    None
}

/// Lines that explain a failure, for the Settings panel. cloudflared logs are
/// noisy; only the tail matters.
fn log_tail() -> Vec<String> {
    std::fs::read_to_string(log_file())
        .map(|t| t.lines().rev().take(8).map(String::from).collect::<Vec<_>>())
        .map(|mut v| {
            v.reverse();
            v
        })
        .unwrap_or_default()
}

pub fn status() -> Value {
    let binary = find_cloudflared();
    let state = read_state();
    let running = state
        .as_ref()
        .and_then(|s| s["pid"].as_u64())
        .map(|pid| pid_alive(pid as u32))
        .unwrap_or(false);
    let mut url = state.as_ref().and_then(|s| s["url"].as_str().map(String::from));
    // A quick tunnel that was still handshaking when `start` returned gets its
    // URL on a later status poll, straight from the log.
    if running && url.is_none() {
        if let Ok(log) = std::fs::read_to_string(log_file()) {
            if let Some(parsed) = parse_quick_url(&log) {
                url = Some(parsed.clone());
                if let Some(mut s) = state.clone() {
                    s["url"] = json!(parsed);
                    let _ = std::fs::write(
                        tunnel_file(),
                        serde_json::to_string_pretty(&s).unwrap_or_default(),
                    );
                }
            }
        }
    }
    json!({
        "installed": binary.is_some(),
        "binary": binary,
        "running": running,
        "mode": state.as_ref().and_then(|s| s["mode"].as_str().map(String::from)),
        "port": state.as_ref().and_then(|s| s["port"].as_u64()),
        "url": url,
        "startedAt": state.as_ref().and_then(|s| s["startedAt"].as_u64()),
        "log": if running { Value::Null } else { json!(log_tail()) },
    })
}

/// Start (or restart) the tunnel in front of the gateway port.
/// `mode` is "quick" (default) or "named"; named needs `name`.
///
/// The request is remembered, so the gateway watchdog brings the tunnel back
/// if it dies; only `stop` forgets it.
pub fn start(port: u16, mode: &str, name: Option<&str>) -> Result<Value, String> {
    let _lock = Lock::acquire(std::time::Duration::from_secs(30))
        .ok_or("another tunnel start is already in progress — try again in a moment")?;
    kill_running(); // one tunnel at a time; a stale one would hold the old URL
    spawn_tunnel(port, mode, name)?;
    let named = if mode == "named" { name.map(str::trim) } else { None };
    let _ = std::fs::write(
        desired_file(),
        serde_json::to_string_pretty(&json!({
            "mode": if mode == "named" { "named" } else { "quick" },
            "name": named,
            "port": port,
        }))
        .unwrap_or_default(),
    );
    Ok(status())
}

/// Spawn cloudflared and record it in `tunnel.json`. Caller holds the lock
/// and has already stopped any previous one.
fn spawn_tunnel(port: u16, mode: &str, name: Option<&str>) -> Result<(), String> {
    let binary = find_cloudflared()
        .ok_or("cloudflared is not installed — `brew install cloudflared`, then retry")?;

    let _ = std::fs::create_dir_all(crate::broker::config_dir());
    let log = log_file();
    let _ = std::fs::write(&log, ""); // fresh log so URL parsing can't see an old run

    let mut cmd = std::process::Command::new(&binary);
    cmd.arg("tunnel")
        .arg("--no-autoupdate")
        .arg("--logfile")
        .arg(&log);
    match mode {
        "named" => {
            let name = name
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .ok_or("a named tunnel needs its name")?;
            cmd.args(["run", name]);
        }
        _ => {
            cmd.args(["--url", &format!("http://127.0.0.1:{port}")]);
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // detached, like the broker and gateway
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    let child = cmd.spawn().map_err(|e| format!("cloudflared failed to start: {e}"))?;
    let pid = child.id();

    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Quick tunnels: wait briefly for the public URL so the panel can show it
    // on the spot. ~20s covers a cold edge handshake; a slow one just shows up
    // on the next status poll instead.
    let mut url: Option<String> = None;
    if mode != "named" {
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !pid_alive(pid) {
                return Err(format!(
                    "cloudflared exited:\n{}",
                    log_tail().join("\n")
                ));
            }
            if let Ok(text) = std::fs::read_to_string(&log) {
                if let Some(u) = parse_quick_url(&text) {
                    url = Some(u);
                    break;
                }
            }
        }
    }

    let state = json!({
        "pid": pid,
        "mode": if mode == "named" { "named" } else { "quick" },
        "port": port,
        "url": url,
        "startedAt": started_at,
    });
    std::fs::write(
        tunnel_file(),
        serde_json::to_string_pretty(&state).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

/// Stop the tunnel and forget it: the watchdog will not bring it back.
/// Idempotent.
pub fn stop() {
    // under the lock so a watchdog tick can't relaunch it mid-stop; if the
    // lock is wedged we still stop — the keep-alive record goes first
    let _lock = Lock::acquire(std::time::Duration::from_secs(5));
    let _ = std::fs::remove_file(desired_file());
    kill_running();
}

/// Kill whatever `tunnel.json` points at. Does not touch the keep-alive record.
fn kill_running() {
    if let Some(state) = read_state() {
        if let Some(pid) = state["pid"].as_u64() {
            if pid_alive(pid as u32) {
                kill_pid(pid as u32);
            }
        }
    }
    let _ = std::fs::remove_file(tunnel_file());
}

/// What one watchdog tick did.
#[derive(Debug, PartialEq)]
pub enum Revive {
    /// No tunnel was asked for (or it was stopped on purpose).
    Idle,
    /// Running as it should be.
    Alive,
    /// It had died; cloudflared was relaunched.
    Restarted,
    /// It had died and relaunching failed.
    Failed(String),
}

/// One watchdog tick: if a tunnel is wanted but its process is gone, start it
/// again with the same arguments. Cheap when all is well (one `ps`).
pub fn ensure_running() -> Revive {
    let alive = || {
        read_state()
            .and_then(|s| s["pid"].as_u64())
            .map(|pid| pid_alive(pid as u32))
            .unwrap_or(false)
    };
    if read_desired().is_none() {
        return Revive::Idle;
    }
    if alive() {
        return Revive::Alive;
    }
    // someone is mid-start (the app's Start button, or a stop in flight)
    let Some(_lock) = Lock::try_acquire() else {
        return Revive::Alive;
    };
    // re-check under the lock: a start may have just landed, or a stop
    let Some(want) = read_desired() else {
        return Revive::Idle;
    };
    if alive() {
        return Revive::Alive;
    }
    let mode = want["mode"].as_str().unwrap_or("quick");
    let name = want["name"].as_str();
    let port = want["port"].as_u64().unwrap_or(8473) as u16;
    // keep the dead run's log — spawn truncates tunnel.log, and why it died
    // is exactly what you'd want to read
    let _ = std::fs::rename(log_file(), prev_log_file());
    match spawn_tunnel(port, mode, name) {
        Ok(()) => Revive::Restarted,
        Err(e) => Revive::Failed(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive_until_dropped() {
        let path = std::env::temp_dir().join(format!("ab-tunnel-lock-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let first = Lock::try_at(path.clone()).expect("first acquire");
        assert!(Lock::try_at(path.clone()).is_none(), "second holder must be refused");
        drop(first);
        assert!(Lock::try_at(path.clone()).is_some(), "free again after drop");
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn liveness_sees_dead_and_reaped_processes() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        assert!(pid_alive(pid));
        child.kill().unwrap();
        // killed but not yet wait()ed: a zombie, which must read as dead
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!pid_alive(pid));
        let _ = child.wait();
    }

    #[test]
    fn quick_urls_are_parsed_out_of_noisy_logs() {
        let log = "2026-09-26 INF +----+\nINF |  https://tidy-otter-heron.trycloudflare.com  |\nINF +----+\n";
        assert_eq!(
            parse_quick_url(log).as_deref(),
            Some("https://tidy-otter-heron.trycloudflare.com")
        );
        // other https URLs in the log must not be mistaken for the tunnel
        assert_eq!(parse_quick_url("INF see https://developers.cloudflare.com/x for docs"), None);
    }
}
