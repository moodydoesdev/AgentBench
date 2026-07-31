//! agentbench-gateway: authenticated remote access to a running AgentBench.
//!
//! The broker is multi-subscriber by design, so this process connects as a
//! second client alongside the desktop app — same newline-delimited JSON, same
//! ops, no broker changes. What the gateway adds is everything the broker
//! deliberately lacks because it only ever listens on loopback: device
//! authentication, a phone-shaped event fan-out, and filesystem reads that
//! never touch the broker at all.

pub mod push;
pub mod tokens;

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, oneshot, Mutex};

use crate::fsdata;
use tokens::TokenStore;

/// Bumped when the wire contract changes in a way an older PWA shell cannot
/// render. Two machines update independently, so every `hello` carries this
/// and a mismatched shell degrades to a banner instead of misrendering.
pub const PROTOCOL_VERSION: u32 = 1;

/// Default listening port. `tailscale serve` fronts this with trusted HTTPS.
pub const DEFAULT_PORT: u16 = 8473;

/// Ops a paired phone may issue. The rule is that a device token never reaches
/// more of the broker than the app has screens for: spawning and killing are
/// here because the fleet can now start and close agents. `shutdown` stays out
/// — taking the broker down would kill every agent on the machine, and that
/// belongs to whoever is sitting at it.
const ALLOWED_OPS: &[&str] = &[
    "write",
    "watch",
    "unwatch",
    "interrupt",
    "resize",
    "list",
    "saved",
    "ping",
    "create",
    "create-chat",
    "kill",
];

/// Broker ops that produce a response line. The rest are fire-and-forget —
/// mirroring `handle_request`, which returns None for them. Waiting on a reply
/// that is never coming would stall the whole request queue.
const REQUEST_OPS: &[&str] = &[
    "create",
    "create-chat",
    "kill",
    "watch",
    "list",
    "saved",
    "ping",
    "shutdown",
];

/// Reads the phone can make that bypass the broker's op vocabulary: plain
/// filesystem lookups, plus a couple of helpers the broker has no op for.
const FS_READS: &[&str] = &[
    "list_sessions",
    "list_plans",
    "read_plan",
    "list_slash_commands",
    "list_projects",
    "pane_buffer",
    "save_image",
    "pane_titles",
];

pub fn gateway_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("gateway.json")
}

pub fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "workstation".to_string())
}

/// Live connection to the broker daemon. Reconnects on its own: the broker
/// outlives the desktop app and can be restarted under us, and a gateway that
/// died with it would take phone access down at exactly the wrong moment.
pub struct BrokerLink {
    writer: Mutex<Option<tokio::net::tcp::OwnedWriteHalf>>,
    /// Broker answers requests in order on the socket, so a FIFO of waiters is
    /// the whole correlation mechanism.
    pending: Mutex<VecDeque<oneshot::Sender<Value>>>,
    events: broadcast::Sender<Value>,
    connected: AtomicBool,
}

impl BrokerLink {
    pub fn new() -> Arc<BrokerLink> {
        let (events, _) = broadcast::channel(1024);
        Arc::new(BrokerLink {
            writer: Mutex::new(None),
            pending: Mutex::new(VecDeque::new()),
            events,
            connected: AtomicBool::new(false),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Read the broker's advertised port. The broker writes this file on
    /// startup; it is also how the desktop app finds it.
    fn broker_port() -> Option<u16> {
        let text = std::fs::read_to_string(crate::broker::broker_file()).ok()?;
        let info: Value = serde_json::from_str(&text).ok()?;
        info["port"].as_u64().map(|p| p as u16)
    }

    /// Connect, then keep reconnecting forever. Each successful connect
    /// announces itself so phones can re-issue their watches and refresh state
    /// they may have missed while the link was down.
    pub fn spawn_connect_loop(self: &Arc<Self>) {
        let link = self.clone();
        tokio::spawn(async move {
            loop {
                match link.connect_once().await {
                    Ok(reader) => {
                        link.connected.store(true, Ordering::SeqCst);
                        let _ = link.events.send(json!({ "ev": "broker-connected" }));
                        link.pump(reader).await;
                        link.connected.store(false, Ordering::SeqCst);
                        // fail every in-flight request rather than let callers
                        // wait out their timeouts against a dead socket
                        let mut pending = link.pending.lock().await;
                        while let Some(tx) = pending.pop_front() {
                            let _ = tx.send(json!({ "error": "broker disconnected" }));
                        }
                        drop(pending);
                        *link.writer.lock().await = None;
                        let _ = link.events.send(json!({ "ev": "broker-lost" }));
                    }
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        });
    }

    async fn connect_once(
        self: &Arc<Self>,
    ) -> Result<tokio::net::tcp::OwnedReadHalf, std::io::Error> {
        let port = Self::broker_port().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no broker.json — start AgentBench")
        })?;
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        stream.set_nodelay(true).ok();
        let (reader, writer) = stream.into_split();
        *self.writer.lock().await = Some(writer);
        Ok(reader)
    }

    /// Read broker lines: events fan out to phones, everything else answers
    /// the oldest waiting request.
    async fn pump(self: &Arc<Self>, reader: tokio::net::tcp::OwnedReadHalf) {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["ev"].is_string() {
                let _ = self.events.send(v);
            } else if let Some(tx) = self.pending.lock().await.pop_front() {
                let _ = tx.send(v);
            }
        }
    }

    async fn send_line(&self, v: &Value) -> Result<(), String> {
        let mut guard = self.writer.lock().await;
        let w = guard.as_mut().ok_or("broker not connected")?;
        let mut line = v.to_string();
        line.push('\n');
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    /// Fire-and-forget op (write/resize/unwatch/interrupt).
    pub async fn send(&self, v: Value) -> Result<(), String> {
        self.send_line(&v).await
    }

    /// Op that answers. The waiter is enqueued while the write lock is held so
    /// the FIFO can never disagree with the order bytes hit the socket — with
    /// several phones plus the gateway's own calls sharing one broker socket,
    /// that ordering is the only thing tying a reply to its request.
    pub async fn request(&self, v: Value) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.writer.lock().await;
            let w = guard.as_mut().ok_or("broker not connected")?;
            self.pending.lock().await.push_back(tx);
            let mut line = v.to_string();
            line.push('\n');
            w.write_all(line.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }
        let resp = tokio::time::timeout(std::time::Duration::from_secs(15), rx)
            .await
            .map_err(|_| "broker timed out".to_string())?
            .map_err(|_| "broker dropped the request".to_string())?;
        if let Some(err) = resp["error"].as_str() {
            return Err(err.to_string());
        }
        Ok(resp["result"].clone())
    }
}

/// Everything a reconnecting phone needs that it cannot rebuild from the event
/// stream: which panes exist, what state they are in, and which questions are
/// still waiting for an answer.
pub struct Snapshot {
    /// pane id -> "working" | "done" | "input" | "exited"
    statuses: std::sync::Mutex<HashMap<u32, String>>,
    /// pane id -> the live AskUserQuestion payload, until it is resolved
    asks: std::sync::Mutex<HashMap<u32, Value>>,
    /// Asks already being answered, so two clients cannot both drive one
    /// picker. Held with a timestamp: see `claim_ask`.
    claimed: std::sync::Mutex<HashMap<u32, (String, std::time::Instant)>>,
}

impl Snapshot {
    fn new() -> Snapshot {
        Snapshot {
            statuses: std::sync::Mutex::new(HashMap::new()),
            asks: std::sync::Mutex::new(HashMap::new()),
            claimed: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Fold one broker event into the durable view of the world.
    fn apply(&self, ev: &Value) {
        let Some(kind) = ev["ev"].as_str() else { return };
        let id = ev["id"].as_u64().map(|i| i as u32);
        match kind {
            "agent-event" => {
                if let Some(id) = id {
                    let status = if ev["kind"] == "done" { "done" } else { "input" };
                    self.statuses.lock().unwrap().insert(id, status.into());
                }
            }
            "pane-exit" => {
                if let Some(id) = id {
                    self.statuses.lock().unwrap().insert(id, "exited".into());
                    self.asks.lock().unwrap().remove(&id);
                    self.claimed.lock().unwrap().remove(&id);
                }
            }
            "ask" => {
                if let Some(id) = id {
                    self.asks.lock().unwrap().insert(id, ev.clone());
                    self.claimed.lock().unwrap().remove(&id);
                    self.statuses.lock().unwrap().insert(id, "input".into());
                }
            }
            "turn" => {
                if let Some(id) = id {
                    let active = ev["active"].as_bool().unwrap_or(false);
                    if active {
                        // the turn moved on, so any pending question has been
                        // answered — by this phone, another one, or the desktop
                        self.asks.lock().unwrap().remove(&id);
                        self.claimed.lock().unwrap().remove(&id);
                        self.statuses.lock().unwrap().insert(id, "working".into());
                    }
                }
            }
            _ => {}
        }
    }

    fn seed_pane(&self, id: u32) {
        self.statuses
            .lock()
            .unwrap()
            .entry(id)
            .or_insert_with(|| "working".to_string());
    }

    fn statuses_json(&self) -> Value {
        let statuses = self.statuses.lock().unwrap();
        json!(statuses
            .iter()
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect::<serde_json::Map<_, _>>())
    }

    fn asks_json(&self) -> Value {
        let asks = self.asks.lock().unwrap();
        json!(asks.values().cloned().collect::<Vec<_>>())
    }

    /// First answer wins — but only for as long as answering plausibly takes.
    ///
    /// A claim that outlived its attempt used to block the pane forever: if a
    /// submission failed halfway (a dropped connection, a rejected write), the
    /// retry was refused as "already being handled" and the question could
    /// never be answered from the phone again. The claim now expires, so a
    /// failed attempt costs one short wait rather than the whole question.
    fn claim_ask(&self, pane: u32, who: &str) -> bool {
        const CLAIM_TTL: std::time::Duration = std::time::Duration::from_secs(20);
        let mut claimed = self.claimed.lock().unwrap();
        if let Some((holder, at)) = claimed.get(&pane) {
            if holder != who && at.elapsed() < CLAIM_TTL {
                return false;
            }
        }
        claimed.insert(pane, (who.to_string(), std::time::Instant::now()));
        true
    }
}

pub struct Gateway {
    pub broker: Arc<BrokerLink>,
    pub tokens: TokenStore,
    pub snapshot: Snapshot,
    pub push: push::Push,
    pub machine: String,
    pub started_at: u64,
    pub conn_seq: AtomicU64,
}

impl Gateway {
    pub fn new(broker: Arc<BrokerLink>) -> Arc<Gateway> {
        let gw = Arc::new(Gateway {
            broker,
            tokens: TokenStore::load(),
            snapshot: Snapshot::new(),
            push: push::Push::load(),
            machine: machine_name(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            conn_seq: AtomicU64::new(1),
        });
        // keep the durable view current even with no phone connected, so the
        // first `hello` after a pairing is already accurate — and push the
        // events worth interrupting someone for, which is the whole reason to
        // carry the app on a phone rather than watch it
        let tracker = gw.clone();
        let mut rx = tracker.broker.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        tracker.snapshot.apply(&ev);
                        tracker.maybe_push(&ev).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        gw
    }

    /// Turn a broker event into a notification, when it is one a person would
    /// want to be told about away from the machine: an agent finished, or it
    /// is blocked waiting on them.
    async fn maybe_push(&self, ev: &Value) {
        if self.push.count() == 0 {
            return;
        }
        let kind = ev["ev"].as_str().unwrap_or_default();
        let id = ev["id"].as_u64().unwrap_or(0) as u32;
        let (title, body, tag) = match kind {
            "agent-event" => match ev["kind"].as_str() {
                Some("done") => ("Agent finished", "finished its turn", "done"),
                Some("needs_input") => ("Agent needs you", "is waiting for input", "input"),
                _ => return,
            },
            // a pending question is the most interruption-worthy thing there is
            "ask" => ("Question waiting", "asked you something", "ask"),
            _ => return,
        };

        // Name the pane by what it is working on; a bare number in a
        // notification is useless.
        let (project, session) = self.pane_context(id).await;
        let heading = match &session {
            Some(title) => title.clone(),
            None => project.clone().unwrap_or_else(|| format!("Agent {id}")),
        };
        let payload = json!({
            "title": format!("{title} · {}", self.machine),
            "body": match &project {
                Some(p) => format!("{heading} — {body} in {p}"),
                None => format!("{heading} {body}"),
            },
            // one notification per pane per kind, so a chatty agent replaces
            // its own notification instead of stacking a wall of them
            "tag": format!("{}-{}-{}", self.machine, id, tag),
            "machine": self.machine,
            "paneId": id,
            "kind": tag,
        });
        let _ = self.push.notify(&payload).await;
    }

    /// (project name, session title) for a pane, best effort.
    async fn pane_context(&self, id: u32) -> (Option<String>, Option<String>) {
        let Ok(list) = self.broker.request(json!({ "op": "list" })).await else {
            return (None, None);
        };
        let panes = list.as_array().cloned().unwrap_or_default();
        let solo = solo_projects(&panes);
        let Some(pane) = panes.iter().find(|p| p["id"].as_u64() == Some(id as u64)) else {
            return (None, None);
        };
        let cwd = pane["cwd"].as_str().unwrap_or_default().to_string();
        let projects = fsdata::read_projects();
        let name = projects
            .iter()
            .find(|p| p["path"].as_str() == Some(cwd.as_str()))
            .and_then(|p| p["name"].as_str().map(String::from))
            .or_else(|| {
                std::path::Path::new(&cwd)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            });
        (name, pane_title(pane, &solo))
    }

    /// The reconnect contract: everything a phone needs to render a correct
    /// fleet without having witnessed the events that produced it.
    ///
    /// Scrollback is deliberately excluded. The broker's `list` carries every
    /// pane's buffer — up to 512KB each — which is the right trade for a
    /// desktop reattaching over a loopback socket and completely wrong for a
    /// phone on cellular reconnecting every time the screen locks. The fleet
    /// only needs identity and status; a pane's backlog is fetched when one is
    /// actually opened (`pane_buffer`).
    pub async fn hello(&self) -> Value {
        let panes = self.broker.request(json!({ "op": "list" })).await;
        let panes = match panes {
            Ok(Value::Array(list)) => {
                let solo = solo_projects(&list);
                let mut out = Vec::with_capacity(list.len());
                for p in list {
                    if let Some(id) = p["id"].as_u64() {
                        self.snapshot.seed_pane(id as u32);
                    }
                    let title = pane_title(&p, &solo);
                    out.push(json!({
                        "id": p["id"],
                        "cwd": p["cwd"],
                        "harness": p["harness"],
                        "kind": p["kind"],
                        "color": p["color"],
                        // what the session is about, so the fleet can say more
                        // than "claude 17"
                        "title": title,
                    }));
                }
                Value::Array(out)
            }
            _ => Value::Array(vec![]),
        };
        json!({
            "ev": "hello",
            "machine": self.machine,
            "protocolVersion": PROTOCOL_VERSION,
            "brokerConnected": self.broker.is_connected(),
            "startedAt": self.started_at,
            "panes": panes,
            "statuses": self.snapshot.statuses_json(),
            "asks": self.snapshot.asks_json(),
            "projects": fsdata::read_projects(),
        })
    }

    /// One pane's scrollback, for a log view that has just been opened. Pty
    /// panes carry raw base64 bytes; headless chat panes carry stream-json
    /// lines. Tailed to the most recent slice so a long-running dev server
    /// does not push a phone into a multi-megabyte download.
    pub async fn pane_buffer(&self, id: u32, limit: usize) -> Result<Value, String> {
        let list = self.broker.request(json!({ "op": "list" })).await?;
        let pane = list
            .as_array()
            .and_then(|panes| panes.iter().find(|p| p["id"].as_u64() == Some(id as u64)))
            .ok_or("no such pane")?;
        let buffer = pane["buffer"].as_str().map(|b| {
            // base64 chars, not bytes — trimming to a char boundary keeps the
            // decode valid, and the tail is what a log wants anyway.
            let start = b.len().saturating_sub(limit / 3 * 4);
            let start = start - (start % 4);
            b[start..].to_string()
        });
        Ok(json!({
            "id": id,
            "cwd": pane["cwd"],
            "harness": pane["harness"],
            "kind": pane["kind"],
            "buffer": buffer,
            "lines": pane["lines"],
            "truncated": pane["buffer"].as_str().map(|b| b.len() > limit / 3 * 4),
        }))
    }

    /// Run one non-broker request on behalf of a phone.
    pub async fn fs_read(&self, name: &str, args: &Value) -> Result<Value, String> {
        if !FS_READS.contains(&name) {
            return Err(format!("fs read not allowed: {name}"));
        }
        let project = args["project"].as_str().unwrap_or_default();
        match name {
            "list_sessions" => Ok(json!(fsdata::list_sessions(project))),
            "list_plans" => Ok(fsdata::list_plans(project)),
            "list_slash_commands" => Ok(json!(fsdata::list_slash_commands(project))),
            "read_plan" => fsdata::read_plan(args["path"].as_str().unwrap_or_default()),
            "list_projects" => Ok(json!(fsdata::read_projects())),
            "pane_buffer" => {
                let id = args["id"].as_u64().unwrap_or(0) as u32;
                let limit = args["limit"].as_u64().unwrap_or(96 * 1024) as usize;
                self.pane_buffer(id, limit.min(512 * 1024)).await
            }
            "save_image" => save_image(args["dataUrl"].as_str().unwrap_or_default()),
            // Titles are refined while a session runs, so they are refreshable
            // rather than fixed at connect time.
            "pane_titles" => {
                let list = self.broker.request(json!({ "op": "list" })).await?;
                let panes = list.as_array().cloned().unwrap_or_default();
                let solo = solo_projects(&panes);
                let mut titles = serde_json::Map::new();
                for pane in &panes {
                    let Some(id) = pane["id"].as_u64() else { continue };
                    if let Some(title) = pane_title(pane, &solo) {
                        titles.insert(id.to_string(), json!(title));
                    }
                }
                Ok(Value::Object(titles))
            }
            _ => Err(format!("unknown fs read: {name}")),
        }
    }

    /// Forward one broker op, enforcing the phase allowlist. `answers` marks a
    /// write that resolves a pending question, so two clients cannot interleave
    /// keystrokes into the same terminal picker.
    pub async fn broker_op(&self, req: &Value, who: &str) -> Result<Option<Value>, String> {
        let op = req["op"].as_str().unwrap_or_default();
        if !ALLOWED_OPS.contains(&op) {
            return Err(format!("op not allowed from a phone: {op}"));
        }
        if req["answers"].as_bool() == Some(true) {
            let pane = req["id"].as_u64().unwrap_or(0) as u32;
            if !self.snapshot.claim_ask(pane, who) {
                return Err("already being handled".into());
            }
        }
        // strip gateway-only fields before the broker sees the request
        let mut fwd = req.clone();
        if let Some(obj) = fwd.as_object_mut() {
            obj.remove("answers");
            obj.remove("id_");
        }
        if REQUEST_OPS.contains(&op) {
            Ok(Some(self.broker.request(fwd).await?))
        } else {
            self.broker.send(fwd).await?;
            Ok(None)
        }
    }
}

/// Directories running exactly one pane. Only those can be named from the
/// newest transcript without risking attributing one agent's work to another.
fn solo_projects(panes: &[Value]) -> std::collections::HashSet<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for p in panes {
        if let Some(cwd) = p["cwd"].as_str() {
            *counts.entry(cwd.to_string()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n == 1)
        .map(|(cwd, _)| cwd)
        .collect()
}

/// What a session is about, for clients with no terminal title to read.
///
/// Prefers the session id the broker reports. An older broker does not send
/// one — it outlives app updates by design — so a lone pane in a directory
/// falls back to that directory's newest transcript.
fn pane_title(pane: &Value, solo: &std::collections::HashSet<String>) -> Option<String> {
    let cwd = pane["cwd"].as_str()?;
    if pane["kind"].as_str() == Some("run") {
        return None; // a run command is named by its command, not a session
    }
    let sid = pane["session"]
        .as_str()
        .map(String::from)
        .or_else(|| solo.contains(cwd).then(|| fsdata::newest_session_id(cwd))?)?;
    fsdata::session_title(cwd, &sid)
}

/// Write an image sent from a phone to a temp file and return its path, so the
/// composer can hand Claude the image the same way the desktop does — by path,
/// rather than trying to push bytes through a terminal.
///
/// Mirrors `save_pasted_image` in lib.rs, including the day-old prune, and
/// shares its directory so there is one place these land.
fn save_image(data_url: &str) -> Result<Value, String> {
    use base64::Engine;
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    const MAX_BYTES: usize = 12 * 1024 * 1024;

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
        "image/heic" | "image/heif" => "heic",
        _ => return Err(format!("unsupported image type: {mime}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("bad base64: {e}"))?;
    // A phone camera photo is large; cap it rather than let one request fill
    // the disk.
    if bytes.len() > MAX_BYTES {
        return Err("image too large (max 12 MB)".into());
    }

    let dir = std::env::temp_dir().join("agentbench-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
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

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("phone-{stamp}-{seq}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(json!(path.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_must_be_real_base64_data_urls() {
        assert!(save_image("https://example.com/cat.png").is_err());
        assert!(save_image("data:image/png,notbase64").is_err());
        assert!(save_image("data:application/zip;base64,AAAA").is_err());
    }

    #[test]
    fn shutdown_is_never_reachable_from_a_phone() {
        // Shutting the broker down kills every agent on the machine.
        assert!(!ALLOWED_OPS.contains(&"shutdown"));
        for op in ["write", "watch", "interrupt", "create", "create-chat", "kill"] {
            assert!(ALLOWED_OPS.contains(&op), "{op} should be reachable");
        }
    }

    #[test]
    fn unknown_ops_are_refused() {
        for op in ["", "eval", "exec", "read-file"] {
            assert!(!ALLOWED_OPS.contains(&op));
        }
    }

    #[test]
    fn one_answer_per_question() {
        let snap = Snapshot::new();
        snap.apply(&json!({ "ev": "ask", "id": 3, "questions": [] }));
        assert!(snap.claim_ask(3, "phone-a"));
        assert!(!snap.claim_ask(3, "phone-b"));
        // the turn resuming means it was answered; a later ask can be claimed
        snap.apply(&json!({ "ev": "turn", "id": 3, "active": true }));
        assert!(snap.claim_ask(3, "phone-b"));
    }

    #[test]
    fn statuses_track_the_event_stream() {
        let snap = Snapshot::new();
        snap.seed_pane(1);
        assert_eq!(snap.statuses.lock().unwrap().get(&1).unwrap(), "working");
        snap.apply(&json!({ "ev": "agent-event", "id": 1, "kind": "done" }));
        assert_eq!(snap.statuses.lock().unwrap().get(&1).unwrap(), "done");
        snap.apply(&json!({ "ev": "ask", "id": 1, "questions": [] }));
        assert_eq!(snap.statuses.lock().unwrap().get(&1).unwrap(), "input");
        assert_eq!(snap.asks_json().as_array().unwrap().len(), 1);
        snap.apply(&json!({ "ev": "pane-exit", "id": 1, "code": 0 }));
        assert_eq!(snap.statuses.lock().unwrap().get(&1).unwrap(), "exited");
        assert!(snap.asks_json().as_array().unwrap().is_empty());
    }
}
