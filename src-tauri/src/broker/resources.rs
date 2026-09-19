//! Process-tree accounting and conservative, durable session hibernation.
//! Unknown activity is NOT idle. No frontend report can authorize a shutdown.
use super::{Core, HarnessSpec};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};

const QUIET_SECS: u64 = 60;
#[derive(Clone, Serialize, Deserialize)]
pub struct Launch {
    pub cwd: String,
    pub harness: Option<HarnessSpec>,
    pub shell: Option<String>,
    pub theme: Option<String>,
    pub chat: bool,
}
impl Launch {
    fn supported(&self) -> bool {
        cfg!(unix)
            && (self.chat
                || self.harness.as_ref().is_some_and(|h| {
                    h.id == "claude"
                        && h.claude
                        && h.resume.as_deref() == Some("--resume {session_id}")
                }))
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Policy {
    pub idle_enabled: bool,
    pub idle_minutes: u64,
    pub pressure_enabled: bool,
}
impl Policy {
    fn normalized(mut self) -> Self {
        self.idle_minutes = self.idle_minutes.clamp(5, 1440);
        self
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Sleeper {
    pub id: u32,
    pub session_id: String,
    pub launch: Launch,
    pub pinned: bool,
    pub slept_at: u64,
    #[serde(default)]
    pub resuming: bool,
    // Retained until every old process is gone; prevents duplicate sessions
    // if a kill failed, or the broker crashed halfway through hibernation.
    pub processes: Vec<(u32, u64)>,
}
pub struct Runtime {
    pid: u32,
    start: u64,
    launch: Launch,
    pinned: bool,
    active: bool,
    saw_input: bool,
    waiting: bool,
    tracking_ready: bool,
    drafts: HashSet<String>,
    idle_since: Option<Instant>,
    tools: HashSet<String>,
    background: HashSet<String>,
    subagents: HashSet<String>,
}
#[derive(Default)]
pub struct Manager {
    pub live: Mutex<HashMap<u32, Runtime>>,
    pub sleepers: Mutex<HashMap<u32, Sleeper>>,
    pub policy: Mutex<Policy>,
    pub snapshot: Mutex<Value>,
    // Serializes writes with checkpoint/stop/resume. Hooks still update the
    // activity state while the process tree is being frozen.
    pub operation: Mutex<()>,
    tails: Mutex<HashMap<u32, TranscriptTail>>,
}
#[derive(Default, Clone)]
struct TranscriptTail {
    sid: String,
    offset: u64,
    skip_partial: bool,
}

// Background shell completions are often queue/attachment records rather
// than hooks. Only inspect those machine lifecycle records, never tool text.
fn completed_ids(rec: &Value) -> Vec<String> {
    let text = if rec["type"] == "queue-operation" {
        rec["content"].as_str()
    } else if rec["type"] == "attachment"
        && rec["attachment"]["type"] == "queued_command"
        && rec["attachment"]["commandMode"] == "task-notification"
    {
        rec["attachment"]["prompt"].as_str()
    } else {
        None
    };
    let mut ids = Vec::new();
    for notice in text.unwrap_or("").split("<task-notification>").skip(1) {
        let Some((notice, _)) = notice.split_once("</task-notification>") else {
            continue;
        };
        let tag = |name: &str| {
            notice
                .split_once(&format!("<{name}>"))
                .and_then(|(_, s)| s.split_once(&format!("</{name}>")))
                .map(|(v, _)| v.trim().to_string())
        };
        if !matches!(
            tag("status").as_deref(),
            Some("completed" | "failed" | "killed")
        ) {
            continue;
        }
        for name in ["task-id", "tool-use-id"] {
            if let Some(id) = tag(name) {
                ids.push(id);
            }
        }
    }
    ids
}
fn reconcile_completions(core: &Core) {
    use std::io::{Read, Seek, SeekFrom};
    let sources: Vec<_> = core
        .resources
        .live
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, r)| !r.background.is_empty() || !r.subagents.is_empty())
        .map(|(id, r)| (*id, r.launch.cwd.clone()))
        .collect();
    for (id, cwd) in sources {
        let Some(sid) = session(core, id, &cwd) else {
            continue;
        };
        let mut tail = core
            .resources
            .tails
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap_or_default();
        if tail.sid != sid {
            tail = TranscriptTail {
                sid: sid.clone(),
                ..TranscriptTail::default()
            };
        }
        let Ok(mut file) = std::fs::File::open(super::transcript_path(core, &cwd, &sid)) else {
            continue;
        };
        if file
            .metadata()
            .map(|m| m.len() < tail.offset)
            .unwrap_or(false)
        {
            tail.offset = 0;
            tail.skip_partial = false;
        }
        if file.seek(SeekFrom::Start(tail.offset)).is_err() {
            continue;
        }
        const CAP: u64 = 2 * 1024 * 1024;
        let mut raw = Vec::new();
        if file.take(CAP).read_to_end(&mut raw).is_err() {
            continue;
        }
        let Some(end) = raw.iter().rposition(|b| *b == b'\n') else {
            // Bound work even for a huge tool-output line. Such a line is
            // not a task notification; discard its continuation on next pass.
            if raw.len() as u64 == CAP {
                tail.offset += CAP;
                tail.skip_partial = true;
                core.resources.tails.lock().unwrap().insert(id, tail);
            }
            continue;
        };
        let start = if tail.skip_partial {
            raw.iter().position(|b| *b == b'\n').unwrap() + 1
        } else {
            0
        };
        let mut completed = Vec::new();
        for line in raw[start..end + 1].split(|b| *b == b'\n') {
            if let Ok(rec) = serde_json::from_slice::<Value>(line) {
                completed.extend(completed_ids(&rec));
            }
        }
        tail.offset += end as u64 + 1;
        tail.skip_partial = false;
        core.resources.tails.lock().unwrap().insert(id, tail);
        if let Some(r) = core.resources.live.lock().unwrap().get_mut(&id) {
            for task in completed {
                r.background.remove(&task);
                r.subagents.remove(&task);
            }
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn refresh(sys: &mut System) {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cpu()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
}
fn read<T: for<'a> Deserialize<'a>>(path: PathBuf) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
fn atomic_write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
impl Manager {
    pub fn load(dir: &Path) -> Self {
        Self {
            sleepers: Mutex::new(read(dir.join("hibernated.json")).unwrap_or_default()),
            policy: Mutex::new(
                read::<Policy>(dir.join("resource-policy.json"))
                    .unwrap_or(Policy {
                        idle_minutes: 30,
                        ..Policy::default()
                    })
                    .normalized(),
            ),
            ..Self::default()
        }
    }
    pub fn next_id(&self) -> u32 {
        self.sleepers
            .lock()
            .unwrap()
            .keys()
            .max()
            .copied()
            .unwrap_or(0)
            + 1
    }
    fn save_sleepers(&self, core: &Core) -> Result<(), String> {
        atomic_write(
            &core.config_dir.join("hibernated.json"),
            &*self.sleepers.lock().unwrap(),
        )
    }
}
pub fn register(core: &Core, id: u32, pid: u32, launch: Launch) {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let start = sys
        .process(Pid::from_u32(pid))
        .map(|p| p.start_time())
        .unwrap_or(0);
    core.resources.live.lock().unwrap().insert(
        id,
        Runtime {
            pid,
            start,
            launch,
            pinned: false,
            active: true,
            saw_input: false,
            waiting: false,
            tracking_ready: false,
            drafts: HashSet::new(),
            idle_since: None,
            tools: HashSet::new(),
            background: HashSet::new(),
            subagents: HashSet::new(),
        },
    );
}
pub fn draft(core: &Core, id: u32, owner: &str, present: bool) -> Result<(), String> {
    let _op = core.resources.operation.lock().unwrap();
    let mut live = core.resources.live.lock().unwrap();
    let r = live.get_mut(&id).ok_or("Agent is not live")?;
    if present {
        r.drafts.insert(owner.to_string());
    } else {
        r.drafts.remove(owner);
    }
    Ok(())
}
pub fn exited(core: &Core, id: u32) {
    core.resources.tails.lock().unwrap().remove(&id);
    core.resources.live.lock().unwrap().remove(&id);
}
pub fn input(core: &Core, id: u32, data: &str) {
    // Terminal status replies are not user keystrokes.
    if data == "\x1b[I"
        || data == "\x1b[O"
        || data.starts_with("\x1b]")
        || data.is_empty()
        || (data.starts_with("\x1b[") && data.ends_with('R'))
        || ((data.starts_with("\x1b[?") || data.starts_with("\x1b[>")) && data.ends_with('c'))
    {
        return;
    }
    if let Some(r) = core.resources.live.lock().unwrap().get_mut(&id) {
        r.idle_since = None;
        r.saw_input = true;
    }
}
pub fn event(core: &Core, id: u32, kind: &str, v: &Value) {
    if v["agent_id"].is_string() && matches!(kind, "prompt" | "done") {
        return;
    }
    let mut live = core.resources.live.lock().unwrap();
    let Some(r) = live.get_mut(&id) else { return };
    let tool_id = v["tool_use_id"].as_str().unwrap_or("unknown").to_string();
    match kind {
        "resource-ready" => {
            r.tracking_ready = true;
            if !r.saw_input {
                r.active = false;
                r.idle_since = Some(Instant::now());
            }
        }
        "prompt" => {
            r.saw_input = true;
            r.active = true;
            r.waiting = false;
            r.idle_since = None;
        }
        "done" => {
            // stop_hook_active means another Stop hook asked Claude to keep
            // working. A later, clean stop must confirm eligibility.
            if v["stop_hook_active"].as_bool() == Some(true) {
                r.idle_since = None;
                return;
            }
            r.active = false;
            r.waiting = false;
            r.idle_since = Some(Instant::now());
        }
        "ask" => {
            r.waiting = true;
            r.idle_since = None;
        }
        "needs_input" => {
            if v["notification_type"] != "idle_prompt"
                && !v["message"]
                    .as_str()
                    .unwrap_or("")
                    .contains("waiting for your input")
            {
                r.waiting = true;
                r.idle_since = None;
            }
        }
        "resource-pre" => {
            r.saw_input = true;
            r.tools.insert(tool_id.clone());
            r.active = true;
            r.idle_since = None;
            if v["tool_input"]["run_in_background"] == true
                && !matches!(v["tool_name"].as_str(), Some("Task" | "Agent"))
            {
                r.background.insert(tool_id);
            }
        }
        "resource-post" | "resource-failure" => {
            r.tools.remove(&tool_id);
            if kind == "resource-failure" {
                r.background.remove(&tool_id);
            }
            if r.background.contains(&tool_id) {
                if let Some(task) = v["tool_response"]["backgroundTaskId"]
                    .as_str()
                    .or(v["tool_response"]["task_id"].as_str())
                {
                    r.background.remove(&tool_id);
                    r.background.insert(task.to_string());
                }
            }
            if v["tool_name"] == "TaskStop" {
                if let Some(task) = v["tool_input"]["task_id"].as_str() {
                    r.background.remove(task);
                }
            }
        }
        "resource-agent-start" => {
            r.subagents
                .insert(v["agent_id"].as_str().unwrap_or("unknown").into());
        }
        "resource-agent-stop" => {
            r.subagents
                .remove(v["agent_id"].as_str().unwrap_or("unknown"));
        }
        "resource-task-done" => {
            if let Some(task) = v["task_id"].as_str() {
                r.background.remove(task);
            }
        }
        _ => {}
    }
}
fn activity_reason(r: &Runtime) -> Option<&'static str> {
    if !r.launch.supported() {
        Some("Session restoration is not verified for this agent/platform")
    } else if !r.tracking_ready {
        Some("Waiting for resource-tracking hooks")
    } else if !r.drafts.is_empty() {
        Some("Composer focused, or an unsent message or attachment")
    } else if r.pinned {
        Some("Pinned — keep alive")
    } else if r.waiting {
        Some("Waiting for your input or approval")
    } else if r.active {
        Some("Agent is working, or idle has not been confirmed")
    } else if !r.tools.is_empty() {
        Some("A tool is running")
    } else if !r.background.is_empty() || !r.subagents.is_empty() {
        Some("Background work has not finished")
    } else if r
        .idle_since
        .is_none_or(|t| t.elapsed().as_secs() < QUIET_SECS)
    {
        Some("Waiting for 60 seconds of confirmed idle time")
    } else {
        None
    }
}
fn tree(sys: &System, root: u32) -> Vec<Pid> {
    let mut ids = HashSet::from([Pid::from_u32(root)]);
    loop {
        let next: Vec<_> = sys
            .processes()
            .iter()
            .filter(|(pid, p)| {
                !ids.contains(pid) && p.parent().is_some_and(|parent| ids.contains(&parent))
            })
            .map(|(pid, _)| *pid)
            .collect();
        if next.is_empty() {
            break;
        }
        ids.extend(next);
    }
    ids.into_iter()
        .filter(|p| sys.process(*p).is_some())
        .collect()
}
fn helper(p: &sysinfo::Process) -> bool {
    let cmd = p
        .cmd()
        .iter()
        .map(|s| s.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    // Conservative allowlist of long-lived integrations. Everything else
    // (dev servers, shells, compilers, browser jobs) prevents hibernation.
    cmd.contains("mcp") || cmd.contains("/tabularis") || cmd.contains("/rust-analyzer")
}
fn tree_reason(sys: &System, r: &Runtime) -> Option<String> {
    let Some(root) = sys.process(Pid::from_u32(r.pid)) else {
        return Some("Process is no longer running".into());
    };
    if r.start == 0 || root.start_time() != r.start {
        return Some("Process identity could not be verified".into());
    }
    for pid in tree(sys, r.pid) {
        if pid.as_u32() != r.pid {
            let p = sys.process(pid).unwrap();
            if !helper(p) {
                return Some(format!(
                    "Child process still running: {}",
                    p.name().to_string_lossy()
                ));
            }
        }
    }
    None
}
fn session(core: &Core, id: u32, cwd: &str) -> Option<String> {
    super::newest_session(core, id, cwd)
}
fn checkpoint_path(core: &Core, s: &Sleeper) -> PathBuf {
    super::transcript_path(core, &s.launch.cwd, &s.session_id)
}
pub fn transcript(core: &Core, id: u32) -> Option<Value> {
    let s = core.resources.sleepers.lock().unwrap().get(&id)?.clone();
    let text = std::fs::read_to_string(checkpoint_path(core, &s)).unwrap_or_default();
    Some(json!({"sid": s.session_id, "text": text, "hibernated":true}))
}
pub fn sleeping_panes(core: &Core) -> Vec<Value> {
    core.resources.sleepers.lock().unwrap().values().map(|s| json!({
        "id":s.id, "cwd":s.launch.cwd, "harness":s.launch.harness.as_ref().map(|h| h.id.as_str()).unwrap_or("claude-chat"),
        "team":s.launch.harness.as_ref().and_then(|h| h.team.as_ref()),
        "kind":if s.launch.chat {"chat"} else {"pty"}, "hibernated":true, "session":s.session_id,
        "pinned":s.pinned, "buffer":"", "lines":[], "ready":false
    })).collect()
}
pub fn snapshot(core: &Core) -> Value {
    let mut value = core.resources.snapshot.lock().unwrap().clone();
    if !value.is_object() {
        value = json!({"panes":[], "sampling":true});
    }
    value["policy"] = json!(*core.resources.policy.lock().unwrap());
    value
}
pub fn set_policy(core: &Core, policy: Policy) -> Result<(), String> {
    let _op = core.resources.operation.lock().unwrap();
    let policy = policy.normalized();
    atomic_write(&core.config_dir.join("resource-policy.json"), &policy)?;
    *core.resources.policy.lock().unwrap() = policy;
    Ok(())
}
pub fn pins(core: &Core) -> HashMap<u32, bool> {
    core.resources
        .live
        .lock()
        .unwrap()
        .iter()
        .map(|(id, r)| (*id, r.pinned))
        .collect()
}
pub fn pin(core: &Core, id: u32, pinned: bool) -> Result<(), String> {
    let _op = core.resources.operation.lock().unwrap();
    let live_pin = {
        let mut live = core.resources.live.lock().unwrap();
        if let Some(r) = live.get_mut(&id) {
            r.pinned = pinned;
            true
        } else {
            false
        }
    };
    if live_pin {
        super::persist_panes(core);
        return Ok(());
    }
    {
        let mut sleepers = core.resources.sleepers.lock().unwrap();
        let s = sleepers.get_mut(&id).ok_or("No such agent")?;
        s.pinned = pinned;
    }
    core.resources.save_sleepers(core)
}
pub fn forget(core: &Core, id: u32) -> Result<(), String> {
    let _op = core.resources.operation.lock().unwrap();
    let old = core.resources.sleepers.lock().unwrap().remove(&id);
    if let Err(e) = core.resources.save_sleepers(core) {
        if let Some(s) = old {
            core.resources.sleepers.lock().unwrap().insert(id, s);
        }
        return Err(e);
    }
    Ok(())
}
fn alive(sys: &System, pid: u32, start: u64) -> bool {
    sys.process(Pid::from_u32(pid))
        .is_some_and(|p| p.start_time() == start && p.status() != sysinfo::ProcessStatus::Zombie)
}
// RAII thaw: every pre-check / persistence failure resumes ALL frozen processes.
struct Frozen(Vec<(Pid, u64)>);
impl Drop for Frozen {
    fn drop(&mut self) {
        let mut sys = System::new();
        refresh(&mut sys);
        for (pid, start) in &self.0 {
            if alive(&sys, pid.as_u32(), *start) {
                let _ = sys.process(*pid).unwrap().kill_with(Signal::Continue);
            }
        }
    }
}
pub fn hibernate(core: &Arc<Core>, id: u32) -> Result<Value, String> {
    hibernate_for(core, id, false)
}
fn hibernate_for(core: &Arc<Core>, id: u32, automatic: bool) -> Result<Value, String> {
    let _op = core.resources.operation.lock().unwrap();
    let (pid, start, launch, pinned, sid) = {
        let live = core.resources.live.lock().unwrap();
        let r = live.get(&id).ok_or("No live agent")?;
        if let Some(reason) = activity_reason(r) {
            return Err(reason.into());
        }
        let sid = session(core, id, &r.launch.cwd).ok_or("No saved session to resume yet")?;
        (r.pid, r.start, r.launch.clone(), r.pinned, sid)
    };
    let mut sys = System::new();
    refresh(&mut sys);
    {
        let live = core.resources.live.lock().unwrap();
        let r = live.get(&id).ok_or("Agent exited")?;
        if let Some(reason) = tree_reason(&sys, r) {
            return Err(reason);
        }
    }
    if !alive(&sys, pid, start) {
        return Err("Agent exited".into());
    }
    if automatic {
        sys.refresh_memory();
        let policy = core.resources.policy.lock().unwrap().clone();
        let idle = core
            .resources
            .live
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|r| r.idle_since)
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0);
        let pressure_now = pressure(&sys);
        if !((policy.idle_enabled && idle >= policy.idle_minutes * 60)
            || (policy.pressure_enabled && matches!(pressure_now, "warning" | "critical")))
        {
            return Err("Automatic cleanup is no longer applicable".into());
        }
    }
    let mut frozen = Frozen(Vec::new());
    // Freeze root before children so it cannot launch new jobs during the
    // checkpoint. Re-scan until all descendants are frozen, or abort safely.
    for _ in 0..3 {
        let mut ids = tree(&sys, pid);
        ids.sort_by_key(|p| p.as_u32() != pid);
        for p in ids {
            let process = sys.process(p).ok_or("Process disappeared")?;
            if frozen.0.iter().any(|(f, _)| *f == p) {
                continue;
            }
            if p.as_u32() != pid && !helper(process) {
                return Err("New background process detected".into());
            }
            if process.kill_with(Signal::Stop) != Some(true) {
                return Err("Could not safely freeze the process tree".into());
            }
            frozen.0.push((p, process.start_time()));
        }
        refresh(&mut sys);
    }
    if tree(&sys, pid)
        .iter()
        .any(|p| !frozen.0.iter().any(|(f, _)| f == p))
    {
        return Err("Process tree is still changing".into());
    }
    {
        let live = core.resources.live.lock().unwrap();
        if let Some(reason) = activity_reason(live.get(&id).ok_or("Agent exited")?) {
            return Err(reason.into());
        }
    }
    if session(core, id, &launch.cwd).as_deref() != Some(&sid) {
        return Err("Session changed; try again after it is idle".into());
    }
    let sleeper = Sleeper {
        id,
        session_id: sid,
        launch,
        pinned,
        slept_at: now(),
        resuming: false,
        processes: frozen.0.iter().map(|(p, s)| (p.as_u32(), *s)).collect(),
    };
    core.resources
        .sleepers
        .lock()
        .unwrap()
        .insert(id, sleeper.clone());
    if let Err(e) = core.resources.save_sleepers(core) {
        core.resources.sleepers.lock().unwrap().remove(&id);
        return Err(e);
    }
    // Durable checkpoint exists. Kill the exact, frozen identities only;
    // descendants first, parent last. Never signal a reused PID.
    for (p, s) in frozen.0.iter().rev() {
        if alive(&sys, p.as_u32(), *s) {
            let _ = sys.process(*p).unwrap().kill_with(Signal::Kill);
        }
    }
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(100));
        refresh(&mut sys);
        if sleeper.processes.iter().all(|(p, s)| !alive(&sys, *p, *s)) {
            break;
        }
    }
    let remaining = sleeper.processes.iter().any(|(p, s)| alive(&sys, *p, *s));
    // Any surviving processes are thawed by Frozen; the checkpoint remains
    // recoverable and resume refuses to duplicate a still-live session.
    core.broadcast(&json!({"ev":"pane-hibernated", "id":id}));
    super::persist_panes(core);
    if remaining {
        return Err("Some processes could not be stopped. The checkpoint is saved; resume is blocked until they exit.".into());
    }
    Ok(json!({"id":id, "hibernated":true}))
}
pub fn resume(core: &Arc<Core>, id: u32) -> Result<Value, String> {
    let _op = core.resources.operation.lock().unwrap();
    let sleeper = core
        .resources
        .sleepers
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("No hibernated agent")?;
    if sleeper.resuming {
        return Err("A previous resume was interrupted. Close this checkpoint and use the session picker to recover the saved conversation.".into());
    }
    if !checkpoint_path(core, &sleeper).is_file() {
        return Err("Saved transcript is missing; the agent was not started".into());
    }
    let mut sys = System::new();
    refresh(&mut sys);
    if sleeper.processes.iter().any(|(p, s)| alive(&sys, *p, *s)) {
        return Err(
            "The original agent still has live processes; refusing to start a duplicate".into(),
        );
    }
    // Write-ahead marker makes a broker crash during spawn fail closed.
    core.resources
        .sleepers
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .resuming = true;
    if let Err(e) = core.resources.save_sleepers(core) {
        core.resources
            .sleepers
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .resuming = false;
        return Err(e);
    }
    let l = &sleeper.launch;
    let launched = if l.chat {
        super::create_chat_pane(
            core,
            l.cwd.clone(),
            Some(sleeper.session_id.clone()),
            l.shell.as_deref(),
        )
    } else {
        super::create_pane(
            core,
            l.cwd.clone(),
            100,
            30,
            Some(sleeper.session_id.clone()),
            l.theme.clone(),
            l.harness.clone(),
            l.shell.clone(),
        )
    };
    let new_id = match launched {
        Ok(id) => id,
        Err(e) => {
            core.resources
                .sleepers
                .lock()
                .unwrap()
                .get_mut(&id)
                .unwrap()
                .resuming = false;
            let _ = core.resources.save_sleepers(core);
            return Err(e);
        }
    };
    if let Some(r) = core.resources.live.lock().unwrap().get_mut(&new_id) {
        r.pinned = sleeper.pinned;
    }
    // Keep the durable entry until the replacement has successfully spawned.
    core.resources.sleepers.lock().unwrap().remove(&id);
    if let Err(e) = core.resources.save_sleepers(core) {
        // Prevent retrying the old checkpoint while the new process is live.
        let mut recovery = sleeper;
        recovery.resuming = true;
        if let Some(r) = core.resources.live.lock().unwrap().get(&new_id) {
            recovery.processes = vec![(r.pid, r.start)];
        }
        core.resources.sleepers.lock().unwrap().insert(id, recovery);
        let _ = core.resources.save_sleepers(core);
        core.broadcast(&json!({"ev":"resource-error","message":format!("Agent resumed, but checkpoint cleanup failed: {e}")}));
    }
    core.broadcast(&json!({"ev":"pane-resumed","old_id":id,"id":new_id}));
    Ok(json!({"old_id":id,"id":new_id}))
}
fn pressure(_sys: &System) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        // Kernel pressure includes compression and swap; free-RAM alone
        // would falsely alarm on a healthy machine using filesystem cache.
        if let Ok(out) = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "kern.memorystatus_vm_pressure_level"])
            .output()
        {
            return match String::from_utf8_lossy(&out.stdout).trim() {
                "1" => "normal",
                "2" => "warning",
                "4" => "critical",
                _ => "unknown",
            };
        }
        return "unknown";
    }
    #[cfg(not(target_os = "macos"))]
    {
        let ratio = _sys.available_memory() as f64 / _sys.total_memory().max(1) as f64;
        if ratio < 0.05 {
            "critical"
        } else if ratio < 0.1 {
            "warning"
        } else {
            "normal"
        }
    }
}
pub fn start(core: Arc<Core>) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let cpus = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1) as f32;
        let mut last_cleanup = Instant::now();
        loop {
            refresh(&mut sys);
            sys.refresh_memory();
            reconcile_completions(&core);
            let pressure = pressure(&sys);
            let policy = core.resources.policy.lock().unwrap().clone();
            let mut candidates = Vec::new();
            let mut rows = Vec::new();
            {
                let live = core.resources.live.lock().unwrap();
                for (id, r) in live.iter() {
                    let ids = tree(&sys, r.pid);
                    let resident: u64 = ids
                        .iter()
                        .filter_map(|p| sys.process(*p))
                        .map(|p| p.memory())
                        .sum();
                    let cpu: f32 = ids
                        .iter()
                        .filter_map(|p| sys.process(*p))
                        .map(|p| p.cpu_usage())
                        .sum::<f32>()
                        / cpus;
                    let idle = r.idle_since.map(|t| t.elapsed().as_secs()).unwrap_or(0);
                    let reason = activity_reason(r)
                        .map(String::from)
                        .or_else(|| tree_reason(&sys, r))
                        .or_else(|| {
                            if session(&core, *id, &r.launch.cwd).is_none() {
                                Some("No saved session to resume yet".into())
                            } else {
                                None
                            }
                        });
                    let eligible = reason.is_none();
                    if eligible {
                        candidates.push((*id, idle));
                    }
                    rows.push(json!({"id":id,"resident_bytes":resident,"cpu_percent":cpu,"processes":ids.len(),
                        "idle_seconds":idle,"pinned":r.pinned,"eligible":eligible,"reason":reason,"hibernated":false}));
                }
            }
            for s in core.resources.sleepers.lock().unwrap().values() {
                rows.retain(|r| r["id"] != s.id);
                let remaining: Vec<_> = s
                    .processes
                    .iter()
                    .filter(|(p, start)| alive(&sys, *p, *start))
                    .filter_map(|(p, _)| sys.process(Pid::from_u32(*p)))
                    .collect();
                let survivors = s.resuming || !remaining.is_empty();
                let resident: u64 = remaining.iter().map(|p| p.memory()).sum();
                let cpu: f32 = remaining.iter().map(|p| p.cpu_usage()).sum::<f32>() / cpus as f32;
                rows.push(json!({"id":s.id,"hibernated":true,"pinned":s.pinned,"resident_bytes":resident,"cpu_percent":cpu,
                    "processes":remaining.len(),"eligible":false,"can_resume":!survivors,"reason":if survivors {Some("Resume recovery needed or original processes still running")} else {None}}));
            }
            let snapshot = json!({"panes":rows,"pressure":pressure,"total_bytes":sys.total_memory(),
                "available_bytes":sys.available_memory(),"swap_used_bytes":sys.used_swap(),"sampled_at":now(),"cpu_cores":cpus,"policy":policy});
            *core.resources.snapshot.lock().unwrap() = snapshot.clone();
            core.broadcast(&json!({"ev":"resources", "state":snapshot}));
            // One oldest eligible agent per 30 seconds. Re-check ALL guards
            // in hibernate; a sample is never itself permission to kill.
            if last_cleanup.elapsed().as_secs() >= 30 {
                candidates.sort_by_key(|(_, idle)| std::cmp::Reverse(*idle));
                if let Some((id, _)) = candidates.into_iter().find(|(_, idle)| {
                    (policy.idle_enabled && *idle >= policy.idle_minutes * 60)
                        || (policy.pressure_enabled && matches!(pressure, "warning" | "critical"))
                }) {
                    last_cleanup = Instant::now();
                    if let Err(message) = hibernate_for(&core, id, true) {
                        core.broadcast(&json!({"ev":"resource-error","message":message}));
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(1);
    struct Fixture {
        core: Arc<Core>,
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentbench-resources-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let core = Arc::new(Core {
                resources: Manager::load(&dir),
                panes: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(100),
                hook_port: AtomicU32::new(0),
                sessions: Mutex::new(HashMap::new()),
                claimed: Mutex::new(HashSet::new()),
                colors: Mutex::new(HashMap::new()),
                last_done: Mutex::new(HashMap::new()),
                last_input: Mutex::new(HashMap::new()),
                saved: Mutex::new(Vec::new()),
                subscribers: Mutex::new(Vec::new()),
                watched: Mutex::new(HashMap::new()),
                chat_panes: Mutex::new(HashMap::new()),
                schedules: Mutex::new(Vec::new()),
                runs: Mutex::new(Vec::new()),
                ready: Mutex::new(HashSet::new()),
                config_dir: dir.clone(),
                home_dir: dir.clone(),
            });
            Self { core, dir }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn runtime() -> Runtime {
        Runtime {
            pid: 0,
            start: 0,
            launch: Launch {
                cwd: "/test".into(),
                harness: Some(HarnessSpec::claude_default()),
                shell: None,
                theme: None,
                chat: false,
            },
            pinned: false,
            active: false,
            saw_input: false,
            waiting: false,
            tracking_ready: true,
            drafts: HashSet::new(),
            idle_since: Some(Instant::now() - Duration::from_secs(3600)),
            tools: HashSet::new(),
            background: HashSet::new(),
            subagents: HashSet::new(),
        }
    }
    #[test]
    #[cfg(unix)]
    fn every_activity_guard_blocks_even_a_long_idle_session() {
        let mut r = runtime();
        assert!(activity_reason(&r).is_none());
        r.pinned = true;
        assert!(activity_reason(&r).is_some());
        r.pinned = false;
        r.active = true;
        assert!(activity_reason(&r).is_some());
        r.active = false;
        r.waiting = true;
        assert!(activity_reason(&r).is_some());
        r.waiting = false;
        r.tracking_ready = false;
        assert!(activity_reason(&r).is_some());
        r.tracking_ready = true;
        r.drafts.insert("window".into());
        assert!(activity_reason(&r).is_some());
        r.drafts.clear();
        r.tools.insert("tool".into());
        assert!(activity_reason(&r).is_some());
        r.tools.clear();
        r.background.insert("shell".into());
        assert!(activity_reason(&r).is_some());
        r.background.clear();
        r.subagents.insert("child".into());
        assert!(activity_reason(&r).is_some());
        r.subagents.clear();
        r.idle_since = Some(Instant::now());
        assert!(activity_reason(&r).is_some());
        r.idle_since = None;
        assert!(activity_reason(&r).is_some());
    }
    #[test]
    fn policy_is_opt_in_and_persists_without_touching_user_settings() {
        let f = Fixture::new();
        let p = f.core.resources.policy.lock().unwrap().clone();
        assert!(!p.idle_enabled && !p.pressure_enabled);
        assert_eq!(p.idle_minutes, 30);
        set_policy(
            &f.core,
            Policy {
                idle_enabled: true,
                idle_minutes: 0,
                pressure_enabled: false,
            },
        )
        .unwrap();
        let loaded = Manager::load(&f.dir);
        assert_eq!(loaded.policy.lock().unwrap().idle_minutes, 5);
        assert!(loaded.policy.lock().unwrap().idle_enabled);
    }
    #[test]
    fn background_work_and_multiple_composer_owners_are_not_cleared_by_stop() {
        let f = Fixture::new();
        f.core.resources.live.lock().unwrap().insert(1, runtime());
        draft(&f.core, 1, "one", true).unwrap();
        draft(&f.core, 1, "two", true).unwrap();
        draft(&f.core, 1, "one", false).unwrap();
        event(
            &f.core,
            1,
            "resource-pre",
            &json!({"tool_use_id":"b","tool_name":"Bash","tool_input":{"run_in_background":true}}),
        );
        event(
            &f.core,
            1,
            "resource-post",
            &json!({"tool_use_id":"b","tool_response":{"backgroundTaskId":"job"}}),
        );
        event(&f.core, 1, "done", &json!({}));
        let live = f.core.resources.live.lock().unwrap();
        let r = &live[&1];
        assert!(r.background.contains("job"));
        assert!(r.drafts.contains("two"));
        assert!(r.tools.is_empty());
        drop(live);
        event(&f.core, 1, "resource-task-done", &json!({"task_id":"job"}));
        assert!(f.core.resources.live.lock().unwrap()[&1]
            .background
            .is_empty());
    }
    #[test]
    fn terminal_queries_do_not_reset_idle_but_typing_does() {
        let f = Fixture::new();
        f.core.resources.live.lock().unwrap().insert(1, runtime());
        input(&f.core, 1, "\x1b[1;1R");
        assert!(f.core.resources.live.lock().unwrap()[&1]
            .idle_since
            .is_some());
        input(&f.core, 1, "hello");
        assert!(f.core.resources.live.lock().unwrap()[&1]
            .idle_since
            .is_none());
    }
    #[cfg(unix)]
    struct Child(std::process::Child);
    #[cfg(unix)]
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(unix)]
    fn sleeping_fixture(f: &Fixture) -> Child {
        let child = Child(
            std::process::Command::new("sleep")
                .arg("60")
                .spawn()
                .unwrap(),
        );
        let mut launch = runtime().launch;
        launch.cwd = f.dir.to_string_lossy().into_owned();
        register(&f.core, 1, child.0.id(), launch);
        let mut live = f.core.resources.live.lock().unwrap();
        let r = live.get_mut(&1).unwrap();
        r.tracking_ready = true;
        r.active = false;
        r.idle_since = Some(Instant::now() - Duration::from_secs(3600));
        drop(live);
        let path = super::super::transcript_path(&f.core, &f.dir.to_string_lossy(), "test-session");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path,"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"saved reply\"}]}}\n").unwrap();
        f.core
            .sessions
            .lock()
            .unwrap()
            .insert(1, vec!["test-session".into()]);
        child
    }
    #[test]
    #[cfg(unix)]
    fn hibernation_stops_only_its_process_and_keeps_a_durable_readable_session() {
        let f = Fixture::new();
        let mut child = sleeping_fixture(&f);
        let mut neighbor = Child(
            std::process::Command::new("sleep")
                .arg("60")
                .spawn()
                .unwrap(),
        );
        hibernate(&f.core, 1).unwrap();
        assert!(child.0.try_wait().unwrap().is_some());
        assert!(neighbor.0.try_wait().unwrap().is_none());
        let reloaded = Manager::load(&f.dir);
        assert_eq!(reloaded.next_id(), 2);
        assert_eq!(
            reloaded.sleepers.lock().unwrap()[&1].session_id,
            "test-session"
        );
        assert!(transcript(&f.core, 1).unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("saved reply"));
    }
    #[test]
    #[cfg(unix)]
    fn persistence_failure_thaws_the_agent_without_losing_it() {
        let f = Fixture::new();
        let mut child = sleeping_fixture(&f);
        std::fs::create_dir(f.dir.join("hibernated.json")).unwrap();
        assert!(hibernate(&f.core, 1).is_err());
        assert!(child.0.try_wait().unwrap().is_none());
        assert!(f.core.resources.sleepers.lock().unwrap().is_empty());
        let mut sys = System::new();
        refresh(&mut sys);
        assert_ne!(
            sys.process(Pid::from_u32(child.0.id())).unwrap().status(),
            sysinfo::ProcessStatus::Stop
        );
    }
    #[test]
    #[cfg(unix)]
    fn missing_transcript_or_reused_process_identity_prevents_shutdown() {
        let f = Fixture::new();
        let mut child = sleeping_fixture(&f);
        f.core
            .resources
            .live
            .lock()
            .unwrap()
            .get_mut(&1)
            .unwrap()
            .start += 100;
        assert!(hibernate(&f.core, 1).is_err());
        assert!(child.0.try_wait().unwrap().is_none());
        f.core.sessions.lock().unwrap().clear();
        assert!(hibernate(&f.core, 1).is_err());
    }
    #[test]
    fn only_machine_completion_records_can_retire_background_work() {
        let text="<task-notification><task-id>job</task-id><tool-use-id>tool</tool-use-id><status>completed</status></task-notification>";
        assert_eq!(
            completed_ids(&json!({"type":"queue-operation","content":text})),
            vec!["job", "tool"]
        );
        assert!(completed_ids(&json!({"type":"user","content":text})).is_empty());
        assert!(completed_ids(
            &json!({"type":"queue-operation","content":text.replace("completed","running")})
        )
        .is_empty());
    }
    #[test]
    #[cfg(unix)]
    fn resume_launches_the_same_session_and_consumes_the_checkpoint_once() {
        let f = Fixture::new();
        let _original = sleeping_fixture(&f);
        let script = f.dir.join("resume-test.sh");
        let args = f.dir.join("args");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec sleep 60\n",
                args.display()
            ),
        )
        .unwrap();
        f.core
            .resources
            .live
            .lock()
            .unwrap()
            .get_mut(&1)
            .unwrap()
            .launch
            .harness
            .as_mut()
            .unwrap()
            .command = format!("sh '{}'", script.display());
        hibernate(&f.core, 1).unwrap();
        let result = resume(&f.core, 1).unwrap();
        let id = result["id"].as_u64().unwrap() as u32;
        for _ in 0..50 {
            if args.is_file() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let passed = std::fs::read_to_string(&args).unwrap();
        // Always clean up the disposable process, including on assertion failure.
        super::super::kill_pane(&f.core, id);
        for _ in 0..50 {
            if !f.core.panes.lock().unwrap().contains_key(&id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(passed.contains("--resume\ntest-session"), "{passed}");
        assert!(resume(&f.core, 1).is_err());
        assert!(Manager::load(&f.dir).sleepers.lock().unwrap().is_empty());
    }
    #[test]
    #[cfg(unix)]
    fn automatic_cleanup_rechecks_current_opt_in() {
        let f = Fixture::new();
        let mut child = sleeping_fixture(&f);
        assert!(hibernate_for(&f.core, 1, true).is_err());
        assert!(child.0.try_wait().unwrap().is_none());
    }
}
