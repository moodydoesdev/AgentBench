pub mod broker;

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
) -> Result<u32, String> {
    let v = client.request(json!({
        "op": "create", "cwd": cwd, "cols": cols, "rows": rows, "resume": resume,
        "theme": theme, "harness": harness
    }))?;
    v.as_u64().map(|x| x as u32).ok_or("bad response".into())
}

#[tauri::command]
fn write_pane(client: State<'_, Arc<BrokerClient>>, id: u32, data: String) -> Result<(), String> {
    client.send(json!({ "op": "write", "id": id, "data": data }))
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

/// Read a plan MDX file for the plan pane. Returns content + mtime (ms) so
/// the frontend can cheaply poll for changes.
#[tauri::command]
fn read_plan(path: String) -> Result<Value, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(json!({ "content": content, "mtime": mtime }))
}

/// List a project's plan documents (.agentbench/plans/*/plan.mdx) for the
/// plans rail. Title comes from the first `# ` heading; newest first.
#[tauri::command]
fn list_plans(project: String) -> Result<Value, String> {
    let dir = std::path::Path::new(&project)
        .join(".agentbench")
        .join("plans");
    let mut out: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let plan = entry.path().join("plan.mdx");
            if !plan.is_file() {
                continue;
            }
            let mtime = std::fs::metadata(&plan)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let title = std::fs::read_to_string(&plan)
                .ok()
                .and_then(|c| {
                    c.lines()
                        .find(|l| l.starts_with("# "))
                        .map(|l| l[2..].trim().to_string())
                })
                .filter(|t| !t.is_empty());
            out.push(json!({
                "path": plan.to_string_lossy(),
                "slug": entry.file_name().to_string_lossy(),
                "title": title,
                "mtime": mtime,
            }));
        }
    }
    out.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
    Ok(json!(out))
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
        safe.into_iter()
            .filter(|b| {
                std::process::Command::new("where")
                    .arg(b)
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .collect()
    }
}

/// Run a harness's install command (Settings → Agents). Login shell so npm/
/// brew/etc are on PATH. Async: npm installs take a while and must not block
/// the main thread. Returns combined output on failure so the error is
/// actionable.
#[tauri::command]
async fn install_harness(command: String) -> Result<(), String> {
    let out;
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        out = std::process::Command::new(shell)
            .arg("-lc")
            .arg(&command)
            .output()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        out = std::process::Command::new("cmd.exe")
            .arg("/C")
            .arg(&command)
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

            let client = BrokerClient::connect(app.handle().clone())
                .map_err(|e| format!("broker: {e}"))?;
            app.manage(client);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_pane,
            write_pane,
            resize_pane,
            kill_pane,
            list_panes,
            saved_panes,
            read_plan,
            list_plans,
            read_file_base64,
            sync_plan_skill,
            check_binaries,
            install_harness
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
