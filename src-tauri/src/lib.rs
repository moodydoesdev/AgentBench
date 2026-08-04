pub mod broker;
pub mod dictation;
pub mod fsdata;
pub mod gateway;

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Client for the agentbench-broker daemon. The broker owns the ptys, so
/// agents survive app restarts; we just proxy commands and pump events.
pub struct BrokerClient {
    writer: Mutex<TcpStream>,
    pending: Arc<Mutex<VecDeque<mpsc::Sender<Value>>>>,
}

impl BrokerClient {
    fn connect(app: AppHandle) -> Result<Arc<BrokerClient>, String> {
        let stream = connect_or_spawn()?;
        stream.set_nodelay(true).ok();
        let reader = stream.try_clone().map_err(|e| e.to_string())?;
        let client = Arc::new(BrokerClient {
            writer: Mutex::new(stream),
            pending: Arc::new(Mutex::new(VecDeque::new())),
        });
        let pending = client.pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(ev) = v["ev"].as_str() {
                    let _ = app.emit(ev, v.clone());
                } else if let Some(tx) = pending.lock().unwrap().pop_front() {
                    let _ = tx.send(v);
                }
            }
            let _ = app.emit("broker-lost", json!({}));
        });
        Ok(client)
    }

    fn send(&self, v: Value) -> Result<(), String> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(v.to_string().as_bytes())
            .and_then(|_| w.write_all(b"\n"))
            .map_err(|e| e.to_string())
    }

    fn request(&self, v: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        // enqueue before sending so response order matches request order
        self.pending.lock().unwrap().push_back(tx);
        self.send(v)?;
        let resp = rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "broker timed out".to_string())?;
        if let Some(err) = resp["error"].as_str() {
            return Err(err.to_string());
        }
        Ok(resp["result"].clone())
    }
}

/// Connect to the advertised broker and verify it's really ours with a ping.
/// Any event lines that race in ahead of the pong are safely discarded —
/// the frontend re-fetches full scrollback via `list` right after connect.
fn try_connect() -> Option<TcpStream> {
    let info: Value =
        serde_json::from_str(&std::fs::read_to_string(broker::broker_file()).ok()?).ok()?;
    let port = info["port"].as_u64()? as u16;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    {
        let mut w = s.try_clone().ok()?;
        w.write_all(b"{\"op\":\"ping\"}\n").ok()?;
    }
    let mut reader = BufReader::new(s.try_clone().ok()?);
    for _ in 0..64 {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        let v: Value = serde_json::from_str(&line).ok()?;
        if v["ev"].is_string() {
            continue; // event chatter from live panes
        }
        if v["result"] == "pong" {
            s.set_read_timeout(None).ok()?;
            return Some(s);
        }
        return None;
    }
    None
}

fn spawn_broker() -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut cmd;
    #[cfg(debug_assertions)]
    {
        // dev: let cargo build the broker if it's stale
        cmd = Command::new("cargo");
        cmd.args(["run", "--quiet", "--bin", "agentbench-broker"])
            .current_dir(env!("CARGO_MANIFEST_DIR"));
    }
    #[cfg(not(debug_assertions))]
    {
        let path = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("no exe dir")?
            .join(format!("agentbench-broker{}", std::env::consts::EXE_SUFFIX));
        cmd = Command::new(path);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // detach into its own process group so Ctrl+C on `tauri dev` (or the app
    // quitting) can't take the broker down with it
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn connect_or_spawn() -> Result<TcpStream, String> {
    if let Some(s) = try_connect() {
        return Ok(s);
    }
    let _ = std::fs::remove_file(broker::broker_file());
    spawn_broker()?;
    // in dev cargo may compile first; be patient
    for _ in 0..240 {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(s) = try_connect() {
            return Ok(s);
        }
    }
    Err("broker did not come up".into())
}

#[tauri::command]
fn create_pane(
    client: State<'_, Arc<BrokerClient>>,
    cwd: String,
    cols: u16,
    rows: u16,
    resume: Option<String>,
    theme: Option<String>,
    harness: Option<Value>,
    shell: Option<String>,
) -> Result<u32, String> {
    let v = client.request(json!({
        "op": "create", "cwd": cwd, "cols": cols, "rows": rows, "resume": resume,
        "theme": theme, "harness": harness, "shell": shell
    }))?;
    v.as_u64().map(|x| x as u32).ok_or("bad response".into())
}

#[tauri::command]
fn write_pane(client: State<'_, Arc<BrokerClient>>, id: u32, data: String) -> Result<(), String> {
    client.send(json!({ "op": "write", "id": id, "data": data }))
}

/// Headless Claude pane: stream-json over pipes instead of a pty.
#[tauri::command]
fn create_chat_pane(
    client: State<'_, Arc<BrokerClient>>,
    cwd: String,
    resume: Option<String>,
    shell: Option<String>,
) -> Result<u32, String> {
    let v = client.request(json!({
        "op": "create-chat", "cwd": cwd, "resume": resume, "shell": shell
    }))?;
    v.as_u64().map(|x| x as u32).ok_or("bad response".into())
}

/// Start tailing a pane's transcript for its chat view; returns
/// { sid, text } — the session id and the transcript so far.
#[tauri::command]
fn watch_transcript(client: State<'_, Arc<BrokerClient>>, id: u32) -> Result<Value, String> {
    client.request(json!({ "op": "watch", "id": id }))
}

#[tauri::command]
fn unwatch_transcript(client: State<'_, Arc<BrokerClient>>, id: u32) -> Result<(), String> {
    client.send(json!({ "op": "unwatch", "id": id }))
}

/// Stop the current turn (chat view's Stop button).
#[tauri::command]
fn interrupt_pane(
    client: State<'_, Arc<BrokerClient>>,
    id: u32,
    resubmit: Option<bool>,
) -> Result<(), String> {
    client.send(json!({
        "op": "interrupt", "id": id, "resubmit": resubmit.unwrap_or(false)
    }))
}

#[tauri::command]
fn resize_pane(
    client: State<'_, Arc<BrokerClient>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    client.send(json!({ "op": "resize", "id": id, "cols": cols, "rows": rows }))
}

#[tauri::command]
fn kill_pane(client: State<'_, Arc<BrokerClient>>, id: u32) -> Result<(), String> {
    client.request(json!({ "op": "kill", "id": id })).map(|_| ())
}

#[tauri::command]
fn list_panes(client: State<'_, Arc<BrokerClient>>) -> Result<Value, String> {
    client.request(json!({ "op": "list" }))
}

#[tauri::command]
fn saved_panes(client: State<'_, Arc<BrokerClient>>) -> Result<Value, String> {
    client.request(json!({ "op": "saved" }))
}

/// Ask the broker to kill all panes and exit. Called before an in-place
/// update so the old binary isn't locked (Windows) and the new broker
/// binary starts cleanly on relaunch.
#[tauri::command]
fn shutdown_broker(client: State<'_, Arc<BrokerClient>>) -> Result<(), String> {
    client.request(json!({ "op": "shutdown" })).map(|_| ())
}

/// Read a plan MDX file for the plan pane. Returns content + mtime (ms) so
/// the frontend can cheaply poll for changes.
#[tauri::command]
fn read_plan(path: String) -> Result<Value, String> {
    fsdata::read_plan(&path)
}

/// List a project's plan documents (.agentbench/plans/*/plan.mdx) for the
/// plans rail. Title comes from the first `# ` heading; newest first.
#[tauri::command]
fn list_plans(project: String) -> Result<Value, String> {
    Ok(fsdata::list_plans(&project))
}

/// Mirror the desktop's project registry to disk so the mobile gateway can
/// read it. localStorage stays the desktop's source of truth; this file is
/// desktop-owned and read-only everywhere else.
#[tauri::command]
fn save_projects(projects: Value) -> Result<(), String> {
    fsdata::write_projects(&projects)
}

/// Slash commands available to a Claude session in `project`, for the chat
/// composer's autocomplete: user + project custom commands (.claude/commands
/// /*.md) and skills (.claude/skills/*/SKILL.md). Built-ins live frontend-side.
#[tauri::command]
fn list_slash_commands(project: String) -> Vec<Value> {
    fsdata::list_slash_commands(&project)
}

/// Resumable Claude sessions for a project: scan its transcript dir
/// (~/.claude/projects/<slug>/*.jsonl) and return { sid, mtime, preview, msgs }
/// newest-first, so the UI can offer "resume a previous session". The slug is
/// Claude Code's own: every non-alphanumeric char in cwd replaced by '-'.
#[tauri::command]
fn list_sessions(project: String) -> Vec<Value> {
    fsdata::list_sessions(&project)
}

/// Raw file bytes as base64 — used by the auto-theme wallpaper sampler,
/// which needs canvas-safe pixel access (asset:// images can taint canvas).
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    std::fs::read(&path)
        .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
        .map_err(|e| e.to_string())
}

/// Persist a pasted/dropped image (a `data:` URL) to a temp file and return
/// its absolute path, so the chat composer can hand Claude an image *by path*
/// — reliable, unlike racing the OS clipboard with a synthetic Ctrl+V. Files
/// land in a dedicated temp subdir that's pruned of day-old images each call.
#[tauri::command]
fn save_pasted_image(data_url: String) -> Result<String, String> {
    use base64::Engine;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    // data:[<mime>][;base64],<payload>
    let comma = data_url.find(',').ok_or("not a data URL")?;
    let header = &data_url[..comma];
    let payload = data_url[comma + 1..].trim();
    if !header.contains(";base64") {
        return Err("expected a base64 data URL".into());
    }
    let mime = header
        .strip_prefix("data:")
        .and_then(|h| h.split(';').next())
        .unwrap_or("image/png");
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("bad base64: {e}"))?;

    let dir = std::env::temp_dir().join("agentbench-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    prune_old_images(&dir);

    // unique name without a uuid dep: monotonic clock + a process-wide counter
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("paste-{stamp}-{seq}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Drop images older than a day so the temp dir doesn't grow without bound.
fn prune_old_images(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in rd.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age.as_secs() > 24 * 3600)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Which of `bins` exist on the user's PATH. Probed through a login shell so
/// the answer matches what a spawned pane would actually find. Returns the
/// subset that was found.
#[tauri::command]
fn check_binaries(bins: Vec<String>) -> Vec<String> {
    // plain binary names only — no shell metacharacters, no $VARS
    let safe: Vec<String> = bins
        .into_iter()
        .filter(|b| {
            !b.is_empty()
                && b.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
        })
        .collect();
    if safe.is_empty() {
        return Vec::new();
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let script = format!(
            "for b in {}; do command -v \"$b\" >/dev/null 2>&1 && printf '%s\\n' \"$b\"; done",
            safe.join(" ")
        );
        std::process::Command::new(shell)
            .arg("-lc")
            .arg(script)
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(windows)]
    {
        // one hidden `where` for all bins — one spawn per bin flashed a
        // console window each time and made startup crawl
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let Ok(out) = std::process::Command::new("where")
            .args(&safe)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            return Vec::new();
        };
        // `where` prints full paths for every hit (exit code only says
        // whether *all* were found); match hits back by file stem
        let stem = |s: &str| {
            std::path::Path::new(s)
                .file_stem()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        let found: std::collections::HashSet<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| stem(l.trim()))
            .collect();
        safe.into_iter().filter(|b| found.contains(&stem(b))).collect()
    }
}

/// Run a harness's install command (Settings → Agents). Login shell so npm/
/// brew/etc are on PATH. Async: npm installs take a while and must not block
/// the main thread. Returns combined output on failure so the error is
/// actionable.
#[tauri::command]
async fn install_harness(command: String, shell: Option<String>) -> Result<(), String> {
    let sh = broker::resolve_shell(shell.as_deref());
    let out;
    #[cfg(unix)]
    {
        out = std::process::Command::new(sh)
            .arg("-lc")
            .arg(&command)
            .output()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        out = std::process::Command::new(&sh)
            .args(broker::shell_command_args(&sh))
            .arg(&command)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
    }
    if out.status.success() {
        Ok(())
    } else {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        // last lines carry the actual npm/brew error
        let tail: Vec<&str> = text.lines().rev().take(6).collect();
        Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Mobile gateway control. The gateway is a peer daemon, not a child of this
// app: closing the desktop must not cut a phone off mid-session, so it is
// spawned detached exactly like the broker and keeps running until it is
// stopped explicitly.
// ---------------------------------------------------------------------------

/// Read the running gateway's advertised control port, if any.
fn gateway_control_port() -> Option<u16> {
    let text = std::fs::read_to_string(gateway::gateway_file()).ok()?;
    let info: Value = serde_json::from_str(&text).ok()?;
    info["controlPort"].as_u64().map(|p| p as u16)
}

/// One request to the gateway's loopback control surface. Short timeouts: the
/// Settings window calls this on every render of the Mobile access section.
fn gateway_control(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let port = gateway_control_port().ok_or("gateway not running")?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(700))
        .map_err(|_| "gateway not running".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = String::new();
    use std::io::Read;
    stream
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .ok_or("malformed gateway response")?;
    serde_json::from_str(body).map_err(|e| e.to_string())
}

#[tauri::command]
fn gateway_status() -> Value {
    match gateway_control("GET", "/local/status", None) {
        Ok(v) => {
            let mut v = v;
            v["running"] = json!(true);
            v["autoStart"] = json!(gateway_prefs()["autoStart"].as_bool().unwrap_or(false));
            v
        }
        Err(e) => json!({
            "running": false,
            "error": e,
            "autoStart": gateway_prefs()["autoStart"].as_bool().unwrap_or(false),
        }),
    }
}

/// Remembered mobile-access settings: whether the gateway should come back on
/// its own, and the address/port it was last started with.
fn gateway_prefs_file() -> std::path::PathBuf {
    broker::config_dir().join("gateway-prefs.json")
}

fn gateway_prefs() -> Value {
    std::fs::read_to_string(gateway_prefs_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_gateway_prefs(prefs: &Value) {
    let _ = std::fs::create_dir_all(broker::config_dir());
    if let Ok(text) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(gateway_prefs_file(), text);
    }
}

/// Launch the gateway detached, like the broker. Returns immediately; callers
/// decide whether to wait for it to answer.
fn spawn_gateway(port: Option<u16>, url: Option<String>) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut cmd;
    #[cfg(debug_assertions)]
    {
        cmd = Command::new("cargo");
        cmd.args(["run", "--quiet", "--bin", "agentbench-gateway"])
            .current_dir(env!("CARGO_MANIFEST_DIR"));
    }
    #[cfg(not(debug_assertions))]
    {
        let path = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("no exe dir")?
            .join(format!("agentbench-gateway{}", std::env::consts::EXE_SUFFIX));
        cmd = Command::new(path);
    }
    if let Some(port) = port {
        cmd.env("AGENTBENCH_GATEWAY_PORT", port.to_string());
    }
    if let Some(url) = url.filter(|u| !u.trim().is_empty()) {
        cmd.env("AGENTBENCH_GATEWAY_URL", url.trim());
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn gateway_start(port: Option<u16>, url: Option<String>) -> Result<Value, String> {
    if gateway_status()["running"] == json!(true) {
        return Ok(gateway_status());
    }
    spawn_gateway(port, url.clone())?;
    // dev builds compile first; poll rather than guess a fixed delay
    for _ in 0..240 {
        std::thread::sleep(Duration::from_millis(500));
        let status = gateway_status();
        if status["running"] == json!(true) {
            // Starting it is the opt-in: mobile access comes back with the app
            // from now on, so a phone can reach this machine without someone
            // opening Settings on the desktop first.
            write_gateway_prefs(&json!({
                "autoStart": true,
                "url": url,
                "port": port,
            }));
            return Ok(gateway_status());
        }
    }
    Err("gateway did not come up".into())
}

#[tauri::command]
fn gateway_stop() -> Result<(), String> {
    // An explicit stop means stop — including across restarts.
    let mut prefs = gateway_prefs();
    prefs["autoStart"] = json!(false);
    write_gateway_prefs(&prefs);
    gateway_control("POST", "/local/quit", None).map(|_| ())
}

/// Bring the gateway back at launch if mobile access was left on. Runs off the
/// main thread: the desktop must not wait on it, and a gateway that fails to
/// start is a Settings problem, not a reason to block the app.
///
/// A running gateway is also checked for staleness: the daemon outlives app
/// updates by design, so after an install it can keep serving last release's
/// wire surface — new fs reads answer "not allowed", new routes 404, and it
/// looks like the feature shipped broken. A version mismatch (or a gateway
/// too old to report one) gets quit and respawned from the current install;
/// phones and benches ride it out through their reconnect loops.
fn restore_gateway() {
    std::thread::spawn(|| {
        let prefs = gateway_prefs();
        let status = gateway_status();
        let running = status["running"] == json!(true);
        let stale = running && status["version"].as_str() != Some(env!("CARGO_PKG_VERSION"));
        if running && !stale {
            return; // survived the app restart, as it is designed to
        }
        if !running && prefs["autoStart"].as_bool() != Some(true) {
            return;
        }
        if stale {
            eprintln!(
                "mobile gateway is from another build ({}); restarting it",
                status["version"].as_str().unwrap_or("pre-0.1.19")
            );
            let _ = gateway_control("POST", "/local/quit", None);
            // /local/quit exits ~100ms after answering and removes its
            // advertisement; give it room before binding the port again
            std::thread::sleep(Duration::from_millis(500));
        }
        let port = prefs["port"].as_u64().map(|p| p as u16);
        let url = prefs["url"].as_str().map(String::from);
        if let Err(e) = spawn_gateway(port, url) {
            eprintln!("mobile gateway did not restart: {e}");
        }
    });
}

/// Mint a pairing code + QR for a phone. `url` is the address the phone should
/// use; the QR carries it alongside the one-time code.
#[tauri::command]
fn gateway_pair(url: Option<String>, force: Option<bool>) -> Result<Value, String> {
    gateway_control(
        "POST",
        "/local/code",
        Some(json!({ "url": url, "force": force.unwrap_or(false) })),
    )
}

#[tauri::command]
fn gateway_cancel_pair() -> Result<Value, String> {
    gateway_control("DELETE", "/local/code", None)
}

#[tauri::command]
fn gateway_revoke(id: String) -> Result<Value, String> {
    gateway_control("POST", "/local/revoke", Some(json!({ "id": id })))
}

/// Like `restore_gateway`, but synchronous and with the caller waiting: bring
/// the gateway up with whatever it was last configured with.
fn ensure_gateway_running() -> Result<(), String> {
    if gateway_status()["running"] == json!(true) {
        return Ok(());
    }
    let prefs = gateway_prefs();
    let port = prefs["port"].as_u64().map(|p| p as u16);
    let url = prefs["url"].as_str().map(String::from);
    gateway_start(port, url).map(|_| ())
}

/// Link this bench to another one — both directions in one action.
///
/// The user reads a pairing code off the other machine and enters it here.
/// Step one redeems it, exactly as a phone would, which gives this desktop a
/// token for the other machine. Step two runs the handshake the other way:
/// our own gateway mints a fresh code and hands it to the other machine over
/// the just-authenticated channel (`/api/link-back`), whose gateway redeems it
/// against us. Runs in Rust rather than the webview so no platform's
/// mixed-content or ATS rules can get between the two machines.
///
/// The reverse half failing (other machine on an older build, our gateway not
/// coming up) is reported but not fatal — a working one-way link beats
/// nothing, and the report says exactly what to do next.
#[tauri::command]
async fn link_bench(url: String, code: String) -> Result<Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("the address should start with http:// or https://".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post(format!("{base}/api/pair"))
        .json(&json!({
            "code": code.trim(),
            "deviceName": format!("{} (bench)", gateway::machine_name()),
            "kind": "bench",
        }))
        .send()
        .await
        .map_err(|e| format!("cannot reach {base}: {e}"))?;
    let ok = res.status().is_success();
    let reply: Value = res
        .json()
        .await
        .map_err(|_| "malformed pair response".to_string())?;
    if !ok {
        return Err(reply["error"]
            .as_str()
            .unwrap_or("pairing refused")
            .to_string());
    }
    let token = reply["token"]
        .as_str()
        .ok_or("no token in pair response")?
        .to_string();
    let machine = reply["machine"].as_str().unwrap_or("bench").to_string();

    let reverse = match pair_back(&client, &base, &token).await {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    };

    Ok(json!({
        "url": base,
        "token": token,
        "machine": machine,
        "kind": "bench",
        "reverse": reverse,
    }))
}

/// The reverse half of `link_bench`: mint a code on our own gateway and ask
/// the other machine to redeem it.
async fn pair_back(client: &reqwest::Client, base: &str, token: &str) -> Result<(), String> {
    // The control channel and the startup poll are blocking; keep them off the
    // async runtime.
    tauri::async_runtime::spawn_blocking(ensure_gateway_running)
        .await
        .map_err(|e| e.to_string())??;
    // force: the code is consumed by a machine, not scanned off a screen, so
    // it must be fresh — reusing a code someone is mid-scan with would burn it.
    let minted = tauri::async_runtime::spawn_blocking(|| {
        gateway_control("POST", "/local/code", Some(json!({ "force": true })))
    })
    .await
    .map_err(|e| e.to_string())??;
    let our_code = minted["code"].as_str().ok_or("gateway minted no code")?;
    let our_url = minted["url"].as_str().ok_or("no reachable address for this machine")?;
    let res = client
        .post(format!("{base}/api/link-back"))
        .bearer_auth(token)
        .json(&json!({ "url": our_url, "code": our_code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let reply: Value = res.json().await.unwrap_or_default();
    if ok {
        Ok(())
    } else {
        Err(reply["error"]
            .as_str()
            .unwrap_or("the other machine could not pair back — it may need updating")
            .to_string())
    }
}

/// Benches that linked *to* this machine (via link-back on our gateway). The
/// desktop merges these into its own machine list at launch and whenever the
/// Linked benches panel opens.
#[tauri::command]
fn gateway_links() -> Value {
    gateway_control("GET", "/local/links", None).unwrap_or_else(|_| json!([]))
}

#[tauri::command]
fn gateway_forget_link(url: String) -> Result<Value, String> {
    gateway_control("DELETE", "/local/links", Some(json!({ "url": url })))
}

/// A proxied dev-server preview in its own window. The URL is the preview
/// proxy's cookie handshake, so a plain webview pointed at it becomes a full
/// working view of the remote app, HMR included. One window per proxy port:
/// reopening navigates the existing window (the handshake mints a fresh
/// cookie) instead of stacking duplicates.
#[tauri::command]
async fn open_preview_window(app: AppHandle, url: String, title: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad preview url: {e}"))?;
    let label = format!(
        "preview-{}",
        &gateway::tokens::hash(&format!(
            "{}:{}",
            parsed.host_str().unwrap_or_default(),
            parsed.port().unwrap_or_default()
        ))[..12]
    );
    if let Some(win) = app.get_webview_window(&label) {
        win.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1100.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Install/refresh the bundled plan-authoring skill into ~/.claude/skills so
/// agents spawned in panes know how to publish visual plans.
#[tauri::command]
fn sync_plan_skill() -> Result<(), String> {
    let files: [(&str, &str); 2] = [
        (
            "SKILL.md",
            include_str!("../../skills/agentbench-plan/SKILL.md"),
        ),
        (
            "references/blocks.md",
            include_str!("../../skills/agentbench-plan/references/blocks.md"),
        ),
    ];
    let dir = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".claude")
        .join("skills")
        .join("agentbench-plan");
    for (rel, content) in files {
        let path = dir.join(rel);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(content) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Custom macOS menu without the Hide item so ⌘H is free for
            // vim-style pane navigation.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};
                let app_menu = SubmenuBuilder::new(app, "AgentBench")
                    .about(Some(AboutMetadata::default()))
                    .separator()
                    .services()
                    .separator()
                    .quit()
                    .build()?;
                let edit = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .fullscreen()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit, &window])
                    .build()?;
                app.set_menu(menu)?;
            }

            restore_gateway();

            let client = BrokerClient::connect(app.handle().clone())
                .map_err(|e| format!("broker: {e}"))?;
            app.manage(client);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_pane,
            write_pane,
            create_chat_pane,
            watch_transcript,
            unwatch_transcript,
            interrupt_pane,
            resize_pane,
            kill_pane,
            list_panes,
            saved_panes,
            read_plan,
            list_plans,
            save_projects,
            gateway_status,
            gateway_start,
            gateway_stop,
            gateway_pair,
            gateway_cancel_pair,
            gateway_revoke,
            link_bench,
            gateway_links,
            gateway_forget_link,
            open_preview_window,
            list_slash_commands,
            list_sessions,
            read_file_base64,
            save_pasted_image,
            sync_plan_skill,
            check_binaries,
            install_harness,
            shutdown_broker,
            dictation::dictation_available,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
