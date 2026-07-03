//! Broker core: owns the ptys, Claude hook sink, scrollback and persistence.
//! Runs inside the standalone `agentbench-broker` process so agents survive
//! app restarts; the Tauri backend is just a client.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

pub const IDENTIFIER: &str = "com.connor.agentbench";
const SCROLLBACK_CAP: usize = 512 * 1024;

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .expect("no config dir")
        .join(IDENTIFIER)
}

/// Where the running broker advertises itself: {"port": u16, "pid": u32}
pub fn broker_file() -> PathBuf {
    config_dir().join("broker.json")
}

pub struct Core {
    pub panes: Mutex<HashMap<u32, Pane>>,
    pub next_id: AtomicU32,
    pub hook_port: AtomicU32,
    /// Claude session ids per pane (newest first). History is kept because a
    /// brand-new id (from /clear or a resume fork) has no transcript on disk
    /// until the first message is submitted.
    pub sessions: Mutex<HashMap<u32, Vec<String>>>,
    pub colors: Mutex<HashMap<u32, String>>,
    /// Per-pane timestamps of the last Stop hook and the last real user
    /// keystroke. If no input followed the last "done", a needs_input event
    /// can only be the idle ping — not an actual prompt — so it's squelched.
    pub last_done: Mutex<HashMap<u32, Instant>>,
    pub last_input: Mutex<HashMap<u32, Instant>>,
    pub saved: Mutex<Vec<SavedPane>>,
    /// Connected clients; every event line is fanned out to all of them.
    pub subscribers: Mutex<Vec<mpsc::Sender<String>>>,
    pub config_dir: PathBuf,
    pub home_dir: PathBuf,
}

pub struct Pane {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cwd: String,
    harness: String,
    buffer: Arc<Mutex<Vec<u8>>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SavedPane {
    pub cwd: String,
    pub session_id: Option<String>,
    /// Harness id (claude/opencode/custom …); None in old files = claude.
    #[serde(default)]
    pub harness: Option<String>,
}

/// How to launch an agent in a pane. Sent by the frontend on `create`; built
/// from the presets + user-defined custom harnesses in Settings.
pub struct HarnessSpec {
    pub id: String,
    /// Shell command line, e.g. "claude --dangerously-skip-permissions".
    pub command: String,
    /// Resume-args template appended on restore, e.g. "--resume {session_id}".
    pub resume: Option<String>,
    /// Claude Code integration: hook settings file, session tracking, theme.
    pub claude: bool,
}

impl HarnessSpec {
    fn from_value(v: &Value) -> Option<HarnessSpec> {
        let command = v["command"].as_str()?.trim().to_string();
        if command.is_empty() {
            return None;
        }
        Some(HarnessSpec {
            id: v["id"].as_str().unwrap_or("custom").to_string(),
            command,
            resume: v["resume"].as_str().map(String::from),
            claude: v["claude"].as_bool().unwrap_or(false),
        })
    }

    /// Fallback when a client sends no harness (old frontends, restores).
    fn claude_default() -> HarnessSpec {
        HarnessSpec {
            id: "claude".into(),
            command: "claude --dangerously-skip-permissions".into(),
            resume: Some("--resume {session_id}".into()),
            claude: true,
        }
    }
}

impl Core {
    pub fn new() -> Arc<Core> {
        let config_dir = config_dir();
        let _ = std::fs::create_dir_all(&config_dir);
        let core = Arc::new(Core {
            panes: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            hook_port: AtomicU32::new(0),
            sessions: Mutex::new(HashMap::new()),
            colors: Mutex::new(HashMap::new()),
            last_done: Mutex::new(HashMap::new()),
            last_input: Mutex::new(HashMap::new()),
            saved: Mutex::new(load_saved(&config_dir)),
            subscribers: Mutex::new(Vec::new()),
            config_dir,
            home_dir: dirs::home_dir().expect("no home dir"),
        });
        let port = start_hook_server(core.clone());
        core.hook_port.store(port as u32, Ordering::SeqCst);
        start_color_watcher(core.clone());
        core
    }

    pub fn broadcast(&self, v: &Value) {
        let line = v.to_string();
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|s| s.send(line.clone()).is_ok());
    }

    pub fn subscribe(&self) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel();
        self.subscribers.lock().unwrap().push(tx);
        rx
    }
}

fn load_saved(config_dir: &PathBuf) -> Vec<SavedPane> {
    std::fs::read_to_string(config_dir.join("panes.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Snapshot live panes (+ their newest resumable session id) so a future
/// broker can restore them with `claude --resume`.
fn persist_panes(core: &Core) {
    let panes = core.panes.lock().unwrap();
    let sessions = core.sessions.lock().unwrap();
    let entries: Vec<SavedPane> = panes
        .iter()
        .map(|(id, p)| SavedPane {
            cwd: p.cwd.clone(),
            session_id: sessions.get(id).and_then(|hist| {
                hist.iter()
                    .find(|sid| session_exists(core, &p.cwd, sid))
                    .cloned()
            }),
            harness: Some(p.harness.clone()),
        })
        .collect();
    let path = core.config_dir.join("panes.json");
    let _ = std::fs::write(path, serde_json::to_string_pretty(&entries).unwrap());
}

/// Claude Code's project-dir slug: cwd with every non-alphanumeric char
/// replaced by '-'.
fn cwd_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn transcript_path(core: &Core, cwd: &str, sid: &str) -> PathBuf {
    core.home_dir
        .join(".claude")
        .join("projects")
        .join(cwd_slug(cwd))
        .join(format!("{sid}.jsonl"))
}

/// A session is only resumable once Claude has written its transcript.
fn session_exists(core: &Core, cwd: &str, sid: &str) -> bool {
    transcript_path(core, cwd, sid).exists()
}

/// Hook settings passed to `claude --settings`. Port + pane id are baked
/// into the URL so no shell env expansion is needed (zsh and cmd.exe alike).
/// --data-binary @- forwards the hook's stdin JSON, which carries session_id.
/// `theme` (when set) makes Claude's output palette match the app's color
/// scheme — light app themes would otherwise get dark-mode colors on a
/// light terminal background.
fn write_hook_settings(
    core: &Core,
    pane_id: u32,
    port: u16,
    theme: Option<&str>,
) -> Result<PathBuf, String> {
    let dir = core.config_dir.join("hooks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let curl = |kind: &str| {
        format!(
            "curl -sf -m 3 -X POST -H \"Content-Type: application/json\" --data-binary @- http://127.0.0.1:{}/event/{}/{}",
            port, pane_id, kind
        )
    };
    let mut settings = json!({
        "hooks": {
            "SessionStart": [{ "hooks": [{ "type": "command", "command": curl("session"), "timeout": 10 }] }],
            "Stop": [{ "hooks": [{ "type": "command", "command": curl("done"), "timeout": 10 }] }],
            "Notification": [{ "hooks": [{ "type": "command", "command": curl("needs_input"), "timeout": 10 }] }]
        }
    });
    // accept only Claude's known theme names
    if let Some(t) = theme.filter(|t| {
        matches!(
            *t,
            "light" | "dark" | "light-daltonized" | "dark-daltonized" | "light-ansi" | "dark-ansi"
        )
    }) {
        settings["theme"] = json!(t);
    }
    let path = dir.join(format!("pane-{}.json", pane_id));
    std::fs::write(&path, serde_json::to_string_pretty(&settings).unwrap())
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Launch the harness through a login shell so it gets the user's real PATH
/// even when launched from Finder/Explorer. `settings_path` is Some only for
/// Claude — it carries the hook wiring via `--settings`.
fn harness_command(
    cwd: &str,
    spec: &HarnessSpec,
    settings_path: Option<&PathBuf>,
    resume: Option<&str>,
    pane_id: u32,
    hook_port: u16,
) -> CommandBuilder {
    let mut line = spec.command.clone();
    if let Some(path) = settings_path {
        #[cfg(unix)]
        line.push_str(&format!(" --settings '{}'", path.display()));
        #[cfg(windows)]
        line.push_str(&format!(" --settings \"{}\"", path.display()));
    }
    // session ids are uuids from our own hooks; keep shell-safe chars only
    if let (Some(tpl), Some(sid)) = (&spec.resume, resume) {
        if sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            line.push(' ');
            line.push_str(&tpl.replace("{session_id}", sid));
        }
    }
    let mut cmd;
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        cmd = CommandBuilder::new(shell);
        cmd.arg("-lc");
        cmd.arg(format!("exec {}", line));
    }
    #[cfg(windows)]
    {
        cmd = CommandBuilder::new("cmd.exe");
        cmd.arg("/C");
        cmd.arg(line);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // let agents (and their skills) reach the hook server, e.g. to publish
    // visual plans: POST /event/{pane_id}/plan
    cmd.env("AGENTBENCH_PANE_ID", pane_id.to_string());
    cmd.env("AGENTBENCH_HOOK_PORT", hook_port.to_string());
    cmd
}

pub fn create_pane(
    core: &Arc<Core>,
    cwd: String,
    cols: u16,
    rows: u16,
    resume: Option<String>,
    theme: Option<String>,
    harness: Option<HarnessSpec>,
) -> Result<u32, String> {
    let spec = harness.unwrap_or_else(HarnessSpec::claude_default);
    let id = core.next_id.fetch_add(1, Ordering::SeqCst);
    let port = core.hook_port.load(Ordering::SeqCst) as u16;
    // hook wiring is Claude-only; other harnesses get a plain terminal
    let settings_path = if spec.claude {
        Some(write_hook_settings(core, id, port, theme.as_deref())?)
    } else {
        None
    };
    // resume only sessions that actually exist on disk; otherwise start fresh
    let resume = resume.filter(|sid| spec.claude && session_exists(core, &cwd, sid));
    // seed the history with the resumed sid so persist_panes doesn't write
    // session_id: null in the window before the first hook event arrives
    if let Some(sid) = &resume {
        core.sessions.lock().unwrap().insert(id, vec![sid.clone()]);
    }

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut child = pair
        .slave
        .spawn_command(harness_command(
            &cwd,
            &spec,
            settings_path.as_ref(),
            resume.as_deref(),
            id,
            port,
        ))
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // pty output -> subscribers (base64 so split UTF-8 survives the trip)
    let out_core = core.clone();
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let out_buffer = buffer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    {
                        let mut b = out_buffer.lock().unwrap();
                        b.extend_from_slice(&buf[..n]);
                        if b.len() > SCROLLBACK_CAP {
                            let excess = b.len() - SCROLLBACK_CAP;
                            b.drain(..excess);
                        }
                    }
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    out_core.broadcast(&json!({ "ev": "pane-output", "id": id, "data": data }));
                }
            }
        }
    });

    // reap the child and tell subscribers when it exits
    let exit_core = core.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        exit_core.panes.lock().unwrap().remove(&id);
        exit_core.sessions.lock().unwrap().remove(&id);
        exit_core.colors.lock().unwrap().remove(&id);
        persist_panes(&exit_core);
        exit_core.broadcast(&json!({ "ev": "pane-exit", "id": id, "code": code }));
    });

    core.panes.lock().unwrap().insert(
        id,
        Pane {
            writer,
            master: pair.master,
            killer,
            cwd,
            harness: spec.id,
            buffer,
        },
    );
    persist_panes(core);
    Ok(id)
}

pub fn write_pane(core: &Core, id: u32, data: &str) -> Result<(), String> {
    // Focus in/out reports (sent when the user merely clicks into the pane)
    // are not real input; don't let them re-arm the needs_input badge.
    if data != "\u{1b}[I" && data != "\u{1b}[O" {
        core.last_input.lock().unwrap().insert(id, Instant::now());
    }
    let mut panes = core.panes.lock().unwrap();
    let pane = panes.get_mut(&id).ok_or("no such pane")?;
    pane.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

pub fn resize_pane(core: &Core, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let panes = core.panes.lock().unwrap();
    let pane = panes.get(&id).ok_or("no such pane")?;
    pane.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub fn kill_pane(core: &Core, id: u32) {
    if let Some(pane) = core.panes.lock().unwrap().get_mut(&id) {
        let _ = pane.killer.kill();
    }
}

/// Live panes with scrollback so a (re)connecting client can reattach.
pub fn list_panes(core: &Core) -> Vec<Value> {
    let panes = core.panes.lock().unwrap();
    let colors = core.colors.lock().unwrap();
    let mut out: Vec<_> = panes
        .iter()
        .map(|(id, p)| {
            let buf = p.buffer.lock().unwrap();
            json!({
                "id": id,
                "cwd": p.cwd,
                "harness": p.harness,
                "color": colors.get(id),
                "buffer": base64::engine::general_purpose::STANDARD.encode(&buf[..]),
            })
        })
        .collect();
    out.sort_by_key(|v| v["id"].as_u64());
    out
}

/// Panes persisted by a previous broker run; consumed on first call so a
/// reloading client can't restore duplicates.
pub fn saved_panes(core: &Core) -> Vec<SavedPane> {
    std::mem::take(&mut *core.saved.lock().unwrap())
}

/// `/color` appends {"type":"agent-color","agentColor":"red"} lines to the
/// session transcript; poll each pane's transcript tail for the latest.
fn read_agent_color(core: &Core, cwd: &str, sid: &str) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(transcript_path(core, cwd, sid)).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(64 * 1024))).ok()?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let mut color = None;
    for line in text.lines() {
        if line.contains("\"agent-color\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(c) = v["agentColor"].as_str() {
                    color = Some(c.to_string());
                }
            }
        }
    }
    color
}

fn start_color_watcher(core: Arc<Core>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let entries: Vec<(u32, String, Vec<String>)> = {
            let panes = core.panes.lock().unwrap();
            let sessions = core.sessions.lock().unwrap();
            panes
                .iter()
                .filter_map(|(id, p)| sessions.get(id).map(|h| (*id, p.cwd.clone(), h.clone())))
                .collect()
        };
        for (id, cwd, hist) in entries {
            let Some(sid) = hist.iter().find(|sid| session_exists(&core, &cwd, sid)) else {
                continue;
            };
            if let Some(color) = read_agent_color(&core, &cwd, sid) {
                let changed = {
                    let mut colors = core.colors.lock().unwrap();
                    let changed = colors.get(&id) != Some(&color);
                    colors.insert(id, color.clone());
                    changed
                };
                if changed {
                    core.broadcast(&json!({ "ev": "pane-color", "id": id, "color": color }));
                }
            }
        }
    });
}

/// Local sink for Claude Code hook events: POST /event/{pane_id}/{kind}
fn start_hook_server(core: Arc<Core>) -> u16 {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("bind hook server");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[cfg(unix)]
        tiny_http::ListenAddr::Unix(_) => unreachable!(),
    };
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let parts: Vec<&str> = url.trim_matches('/').split('/').collect();
            if parts.len() == 3 && parts[0] == "event" {
                if let (Ok(id), kind) = (parts[1].parse::<u32>(), parts[2]) {
                    // agent published (or updated) a visual plan: forward the
                    // file path to the frontend so it opens a plan pane
                    if kind == "plan" {
                        if let Ok(v) = serde_json::from_str::<Value>(&body) {
                            if let Some(path) = v["path"].as_str() {
                                core.broadcast(&json!({
                                    "ev": "plan-ready",
                                    "id": id,
                                    "path": path,
                                    "title": v["title"].as_str().unwrap_or("Plan"),
                                }));
                            }
                        }
                        let _ = req.respond(tiny_http::Response::empty(200));
                        continue;
                    }
                    // every hook payload carries session_id; keep a history so
                    // the pane stays resumable across broker restarts
                    if let Some(sid) = serde_json::from_str::<Value>(&body)
                        .ok()
                        .and_then(|v| v["session_id"].as_str().map(String::from))
                    {
                        {
                            let mut sessions = core.sessions.lock().unwrap();
                            let hist = sessions.entry(id).or_default();
                            hist.retain(|s| s != &sid);
                            hist.insert(0, sid);
                            hist.truncate(8);
                        }
                        persist_panes(&core);
                    }
                    // The Notification hook also fires an idle ping ("Claude is
                    // waiting for your input") after ~60s at the prompt; only
                    // real prompts (e.g. permission requests) should badge.
                    let idle = kind == "needs_input"
                        && serde_json::from_str::<Value>(&body)
                            .ok()
                            .and_then(|v| {
                                v["message"]
                                    .as_str()
                                    .map(|m| m.contains("waiting for your input"))
                            })
                            .unwrap_or(false);
                    if kind == "done" {
                        core.last_done.lock().unwrap().insert(id, Instant::now());
                    }
                    // Belt and braces for the idle ping: if the user hasn't
                    // typed since the turn ended, nothing new can be waiting
                    // on them — squelch regardless of the message text.
                    let stale = kind == "needs_input" && {
                        let done = core.last_done.lock().unwrap().get(&id).copied();
                        let input = core.last_input.lock().unwrap().get(&id).copied();
                        match (done, input) {
                            (Some(d), Some(i)) => i < d,
                            (Some(_), None) => true,
                            _ => false,
                        }
                    };
                    if !idle && !stale && (kind == "done" || kind == "needs_input") {
                        core.broadcast(&json!({ "ev": "agent-event", "id": id, "kind": kind }));
                    }
                }
            }
            let _ = req.respond(tiny_http::Response::empty(200));
        }
    });
    port
}

/// Handle one client request line; returns a response for ops that expect one.
pub fn handle_request(core: &Arc<Core>, req: &Value) -> Option<Value> {
    match req["op"].as_str() {
        Some("create") => {
            let res = create_pane(
                core,
                req["cwd"].as_str().unwrap_or_default().to_string(),
                req["cols"].as_u64().unwrap_or(100) as u16,
                req["rows"].as_u64().unwrap_or(30) as u16,
                req["resume"].as_str().map(String::from),
                req["theme"].as_str().map(String::from),
                HarnessSpec::from_value(&req["harness"]),
            );
            Some(match res {
                Ok(id) => json!({ "result": id }),
                Err(e) => json!({ "error": e }),
            })
        }
        Some("write") => {
            let _ = write_pane(
                core,
                req["id"].as_u64().unwrap_or(0) as u32,
                req["data"].as_str().unwrap_or_default(),
            );
            None
        }
        Some("resize") => {
            let _ = resize_pane(
                core,
                req["id"].as_u64().unwrap_or(0) as u32,
                req["cols"].as_u64().unwrap_or(0) as u16,
                req["rows"].as_u64().unwrap_or(0) as u16,
            );
            None
        }
        Some("kill") => {
            kill_pane(core, req["id"].as_u64().unwrap_or(0) as u32);
            Some(json!({ "result": null }))
        }
        Some("list") => Some(json!({ "result": list_panes(core) })),
        Some("saved") => Some(json!({ "result": saved_panes(core) })),
        Some("ping") => Some(json!({ "result": "pong" })),
        _ => Some(json!({ "error": "unknown op" })),
    }
}
