//! The listening side of the relay, run by a bench's gateway.
//!
//! While enabled it holds one connection open to the relay. Each time a
//! linked bench asks for it, the relay says "open <stream>"; we dial that
//! stream, run the handshake, and splice the decrypted bytes into our own
//! gateway's HTTP port. The gateway then authenticates the request with its
//! bearer token as usual, so the relay adds a way in, not a way around.

use super::crypto::{self, Identity, LinkSecret, Pub};
use super::{connect_ws, now_ms, LinkCode};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

/// How long a link code works.
const LINK_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HostConfig {
    pub url: String,
    pub enabled: bool,
    /// Benches allowed to connect, by relay ECDH key (hex).
    pub authorized: Vec<Authorized>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Authorized {
    pub key: String,
    pub linked_at: u64,
}

struct Pending {
    secret: LinkSecret,
    expires: u64,
}

struct State {
    identity: Arc<Identity>,
    config: Mutex<HostConfig>,
    pending: Mutex<Vec<Pending>>,
    connected: Mutex<bool>,
    error: Mutex<Option<String>>,
    changed: Notify,
}

static STATE: OnceLock<Arc<State>> = OnceLock::new();

fn config_file() -> std::path::PathBuf {
    crate::broker::config_dir().join("relay.json")
}

fn state() -> Result<Arc<State>, String> {
    if let Some(s) = STATE.get() {
        return Ok(s.clone());
    }
    let identity = Arc::new(super::identity()?);
    let config = std::fs::read_to_string(config_file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let s = Arc::new(State {
        identity,
        config: Mutex::new(config),
        pending: Mutex::new(Vec::new()),
        connected: Mutex::new(false),
        error: Mutex::new(None),
        changed: Notify::new(),
    });
    Ok(STATE.get_or_init(|| s).clone())
}

fn save(cfg: &HostConfig) -> Result<(), String> {
    let _ = std::fs::create_dir_all(crate::broker::config_dir());
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_file(), text).map_err(|e| e.to_string())
}

fn hex(key: &Pub) -> String {
    data_encoding::HEXLOWER.encode(key)
}

/// For Settings: whether we are listening, under which id, and who may
/// connect.
pub fn status() -> Value {
    let Ok(s) = state() else {
        return json!({ "enabled": false, "error": "relay keys unavailable" });
    };
    let cfg = s.config.lock().unwrap().clone();
    json!({
        "enabled": cfg.enabled,
        "url": cfg.url,
        "id": s.identity.id(),
        "connected": *s.connected.lock().unwrap(),
        "error": *s.error.lock().unwrap(),
        "authorized": cfg.authorized.iter().map(|a| json!({
            "key": a.key,
            "fingerprint": &a.key[2..14],
            "linkedAt": a.linked_at,
        })).collect::<Vec<_>>(),
    })
}

/// Turn listening on or off, or move to another relay.
pub fn configure(url: Option<&str>, enabled: bool) -> Result<Value, String> {
    let s = state()?;
    {
        let mut cfg = s.config.lock().unwrap();
        if let Some(u) = url {
            cfg.url = super::normalize_url(u)?;
        }
        if enabled && cfg.url.is_empty() {
            return Err("set a relay address first".into());
        }
        cfg.enabled = enabled;
        save(&cfg)?;
    }
    if !enabled {
        *s.connected.lock().unwrap() = false;
        *s.error.lock().unwrap() = None;
    }
    // notify_one keeps a permit if the supervisor is between checks, so a
    // change is never missed.
    s.changed.notify_one();
    Ok(status())
}

/// A link code another bench can paste to link to this one. `pair_code` is a
/// fresh gateway pairing code for the same ten minutes.
pub fn mint_link(pair_code: &str, machine: &str) -> Result<String, String> {
    use base64::Engine;
    let s = state()?;
    let cfg = s.config.lock().unwrap().clone();
    if !cfg.enabled {
        return Err("turn the relay on first".into());
    }
    let secret = LinkSecret::generate();
    {
        let mut pending = s.pending.lock().unwrap();
        pending.retain(|p| p.expires > now_ms());
        pending.push(Pending { secret: secret.clone(), expires: now_ms() + LINK_TTL_MS });
    }
    Ok(LinkCode {
        r: cfg.url,
        i: s.identity.id(),
        k: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret.psk),
        c: pair_code.to_string(),
        m: machine.to_string(),
    }
    .encode())
}

/// Stop a linked bench from connecting through the relay.
pub fn revoke(key: &str) -> Result<Value, String> {
    let s = state()?;
    {
        let mut cfg = s.config.lock().unwrap();
        cfg.authorized.retain(|a| a.key != key);
        save(&cfg)?;
    }
    Ok(status())
}

/// Keep a listening connection open for as long as the relay is enabled.
/// Spawned once by the gateway; `gateway_port` is where accepted streams go.
pub fn start(gateway_port: u16) {
    let Ok(s) = state() else {
        eprintln!("relay: cannot load relay keys; relay disabled");
        return;
    };
    tokio::spawn(async move {
        let mut backoff = 2u64;
        loop {
            let cfg = s.config.lock().unwrap().clone();
            if !cfg.enabled {
                s.changed.notified().await;
                continue;
            }
            let outcome = tokio::select! {
                r = listen(&s, &cfg.url, gateway_port) => r,
                _ = s.changed.notified() => Ok(()),
            };
            *s.connected.lock().unwrap() = false;
            match outcome {
                Ok(()) => backoff = 2,
                Err(e) => {
                    eprintln!("relay: {e}");
                    *s.error.lock().unwrap() = Some(e);
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff)) => {}
                        _ = s.changed.notified() => {}
                    }
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    });
}

async fn listen(s: &Arc<State>, url: &str, gateway_port: u16) -> Result<(), String> {
    // The id rides along so a relay that shards by host (the Cloudflare
    // Worker routes it to that host's Durable Object) can place us before
    // we have proven anything; the signature below is still what counts.
    let mut ws = connect_ws(&format!("{url}/v1/listen?id={}", s.identity.id()), None).await?;
    let challenge = match ws.next().await {
        Some(Ok(Message::Text(t))) => serde_json::from_str::<Value>(&t)
            .ok()
            .and_then(|v| v["challenge"].as_str().map(String::from))
            .ok_or("the relay sent no challenge")?,
        _ => return Err("the relay closed the connection".into()),
    };
    let challenge = data_encoding::HEXLOWER
        .decode(challenge.as_bytes())
        .map_err(|_| "bad relay challenge")?;
    let hello = json!({
        "dh": hex(&s.identity.dh_pub()),
        "sigPub": hex(&s.identity.sig_pub()),
        "sig": data_encoding::HEXLOWER.encode(&s.identity.sign_challenge(&challenge)),
    });
    ws.send(Message::Text(hello.to_string().into()))
        .await
        .map_err(|e| e.to_string())?;
    match ws.next().await {
        Some(Ok(Message::Text(t))) => {
            let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
            if v["ok"] != json!(true) {
                return Err(format!(
                    "the relay refused us: {}",
                    v["error"].as_str().unwrap_or("no reason given")
                ));
            }
        }
        _ => return Err("the relay closed the connection".into()),
    }
    *s.connected.lock().unwrap() = true;
    *s.error.lock().unwrap() = None;
    eprintln!("relay: listening at {url} as {}", s.identity.id());

    // A connection that died without a close (sleep, a network change, a
    // router forgetting it) still accepts our pings into the send buffer, so
    // liveness is judged by what comes back: no frame for 70s, start over.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(25));
    let mut heard = tokio::time::Instant::now();
    loop {
        tokio::select! {
            msg = ws.next() => {
                if let Some(Ok(_)) = msg {
                    heard = tokio::time::Instant::now();
                }
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                        if let Some(sid) = v["open"].as_str() {
                            let sid = sid.to_string();
                            if sid.len() <= 64 && sid.chars().all(|c| c.is_ascii_alphanumeric()) {
                                let (s, url) = (s.clone(), url.to_string());
                                tokio::spawn(async move {
                                    if let Err(e) = accept(&s, &url, &sid, gateway_port).await {
                                        eprintln!("relay: refused a connection: {e}");
                                    }
                                });
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return Err("the relay dropped the connection".into()),
                    Some(Err(e)) => return Err(e.to_string()),
                    _ => {}
                }
            },
            _ = keepalive.tick() => {
                if heard.elapsed() > std::time::Duration::from_secs(70) {
                    return Err("the relay stopped answering".into());
                }
                if ws.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return Err("the relay dropped the connection".into());
                }
            }
        }
    }
}

async fn accept(s: &Arc<State>, url: &str, sid: &str, gateway_port: u16) -> Result<(), String> {
    let mut ws = connect_ws(&format!("{url}/v1/accept/{sid}"), None).await?;
    let pending_secret = |id: &[u8; 8]| {
        s.pending
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.secret.id == *id && p.expires > now_ms())
            .map(|p| p.secret.psk)
    };
    let authorized = |key: &Pub| {
        let k = hex(key);
        s.config.lock().unwrap().authorized.iter().any(|a| a.key == k)
    };
    let (session, accepted) = match crypto::respond(&mut ws, &s.identity, pending_secret, authorized).await {
        Ok(ok) => ok,
        Err(e) => {
            // Tell the other bench why, so it can say "link again" rather
            // than "connection closed".
            use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};
            let frame = CloseFrame { code: CloseCode::Library(4003), reason: e.clone().into() };
            let _ = ws.send(Message::Close(Some(frame))).await;
            return Err(e);
        }
    };
    if let Some(link_id) = accepted.linked {
        // A link code works once: burn it, and remember the key it admitted.
        s.pending.lock().unwrap().retain(|p| p.secret.id != link_id);
        let mut cfg = s.config.lock().unwrap();
        let key = hex(&accepted.peer);
        if !cfg.authorized.iter().any(|a| a.key == key) {
            cfg.authorized.push(Authorized { key, linked_at: now_ms() });
            save(&cfg)?;
        }
    }
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", gateway_port))
        .await
        .map_err(|e| format!("cannot reach our own gateway: {e}"))?;
    let mut pipe = crypto::secure_pipe(ws, session);
    let _ = tokio::io::copy_bidirectional(&mut pipe, &mut tcp).await;
    Ok(())
}
