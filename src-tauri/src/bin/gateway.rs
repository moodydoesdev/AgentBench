//! agentbench-gateway: serves the mobile command-center PWA and bridges it to
//! the local broker.
//!
//! Two listeners, two trust levels. The loopback listener is the desktop app's
//! control channel (start pairing, list devices, revoke) and follows the same
//! model as the broker's hook server. The public listener is what the phone
//! talks to, and every route on it that carries data requires a device token —
//! agents here run permission-skipped, so an open port would be remote code
//! execution.

use agentbench_lib::gateway::{self, BrokerLink, Gateway, DEFAULT_PORT};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("AGENTBENCH_GATEWAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let broker = BrokerLink::new();
    broker.spawn_connect_loop();
    let gw = Gateway::new(broker);

    // Bind the public listener first: if the port is taken, another gateway is
    // already running and this process must not clobber its gateway.json.
    let public_listener = match tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
    {
        Ok(l) => l,
        Err(e) => {
            eprintln!("agentbench-gateway: cannot bind port {port}: {e}");
            std::process::exit(1);
        }
    };
    let local_listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind loopback control listener");
    let local_port = local_listener.local_addr().unwrap().port();

    // One gateway owns `gateway.json`, which is how the desktop finds the
    // control channel. A second instance on another port would bind happily
    // and then overwrite that file, leaving Settings talking to a process that
    // may not even exist — which looks exactly like "mobile access won't
    // start", because the app then tries to launch another one onto a port
    // that is already held.
    if let Some(existing) = live_gateway() {
        if std::env::var("AGENTBENCH_GATEWAY_ALLOW_SECOND").is_err() {
            eprintln!(
                "agentbench-gateway: another gateway is already running (pid {existing}); exiting"
            );
            std::process::exit(0);
        }
        eprintln!("agentbench-gateway: another gateway is live (pid {existing}); leaving gateway.json alone");
    } else {
        claim_advertisement(port, local_port, &gw.machine);
    }

    // Keep the claim honest. A crash, a kill, or a stray instance can leave
    // the file pointing somewhere dead; re-claiming it means the desktop can
    // always find the gateway that is actually serving.
    {
        let machine = gw.machine.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                let ours = std::fs::read_to_string(gateway::gateway_file())
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v["pid"].as_u64())
                    .map(|pid| pid as u32 == std::process::id())
                    .unwrap_or(false);
                if !ours && live_gateway().is_none() {
                    eprintln!("agentbench-gateway: re-claiming a stale gateway.json");
                    claim_advertisement(port, local_port, &machine);
                }
            }
        });
    }

    eprintln!("agentbench-gateway: public :{port}, control 127.0.0.1:{local_port}");

    // Anything unauthenticated lives here and nowhere else: the pairing
    // exchange plus the static shell, which carries no data of its own. A
    // phone must be able to load the app and pair before it has a token.
    let public = Router::new()
        .route("/api/pair", post(pair))
        .route("/api/ws", any(ws_bridge))
        .route("/api/health", get(health))
        .route("/api/push/key", get(push_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route("/api/push/test", post(push_test))
        .route("/api/push/prefs", post(push_prefs))
        .route("/api/answer", post(answer))
        .fallback_service(pwa_service())
        .layer(
            // Multi-bench: the shell is served by whichever machine you
            // installed from and talks to its siblings cross-origin. Safe
            // because auth is a bearer header the browser will not attach
            // automatically — there are no cookies to ride along.
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(gw.clone());

    let local = Router::new()
        .route("/local/ping", get(local_ping))
        .route("/local/status", get(local_status))
        .route("/local/code", post(local_code))
        .route("/local/code", axum::routing::delete(local_clear_code))
        .route("/local/devices", get(local_devices))
        .route("/local/revoke", post(local_revoke))
        .route("/local/quit", post(local_quit))
        .with_state(gw.clone());

    let public_srv = axum::serve(public_listener, public);
    let local_srv = axum::serve(local_listener, local);
    tokio::select! {
        _ = public_srv => {}
        _ = local_srv => {}
    }
}

fn claim_advertisement(port: u16, control_port: u16, machine: &str) {
    let _ = std::fs::create_dir_all(agentbench_lib::broker::config_dir());
    let _ = std::fs::write(
        gateway::gateway_file(),
        serde_json::to_string_pretty(&json!({
            "port": port,
            "controlPort": control_port,
            "pid": std::process::id(),
            "machine": machine,
        }))
        .unwrap(),
    );
}

/// The pid of a gateway that is already advertised and still answering, if any.
/// A stale `gateway.json` (killed process, or one left behind by a crash) is
/// treated as absent, so this never blocks a legitimate start.
///
/// Probes `/local/ping` rather than `/local/status`: status shells out to
/// `tailscale` and the network stack, which is far too slow to sit behind a
/// liveness check.
fn live_gateway() -> Option<u32> {
    use std::io::{Read, Write};
    let text = std::fs::read_to_string(gateway::gateway_file()).ok()?;
    let info: Value = serde_json::from_str(&text).ok()?;
    let pid = info["pid"].as_u64()? as u32;
    if pid == std::process::id() {
        return None;
    }
    let control = info["controlPort"].as_u64()? as u16;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], control));
    let mut stream =
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).ok()?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_millis(1500)))
        .ok()?;
    stream
        .write_all(b"GET /local/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut raw = String::new();
    // a timeout leaves whatever arrived in `raw`, which is enough to judge
    let _ = stream.read_to_string(&mut raw);
    raw.contains("200 OK").then_some(pid)
}

/// Where the built PWA lives.
///
/// The desktop webview gets its copy embedded in the app binary, but this
/// process serves the files over HTTP, so it needs them on disk — they ship as
/// a bundled resource. Where that lands differs per platform (beside the exe on
/// Windows and Linux, `Contents/Resources` inside a macOS app bundle), and in
/// dev it is just the repo's `dist/`, so all the candidates are tried in order.
fn pwa_dir() -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("AGENTBENCH_PWA_DIR") {
        return std::path::PathBuf::from(dir);
    }
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
            // macOS: gateway runs from Contents/MacOS, resources sit alongside
            candidates.push(dir.join("../Resources/dist"));
            // Linux AppImage/deb layout
            candidates.push(dir.join("../lib/AgentBench/dist"));
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist"));

    candidates
        .iter()
        .find(|p| p.join("mobile.html").is_file())
        .cloned()
        // Nothing found: fall back to the first guess so the error surfaces as
        // 404s from a running gateway rather than a silent misconfiguration.
        .unwrap_or_else(|| candidates.into_iter().next().unwrap_or_else(|| "dist".into()))
}

/// Serve the PWA shell.
///
/// `dist/` holds both bundles — the desktop webview's `index.html` and the
/// phone's `mobile.html`. Directory indexes are turned off deliberately: with
/// them on, `/` hands a phone the desktop app. Everything that is not a real
/// file falls through to `mobile.html`, which also makes client-side routes
/// deep-link correctly.
fn pwa_service() -> ServeDir<ServeFile> {
    let dir = pwa_dir();
    let shell = dir.join("mobile.html");
    ServeDir::new(dir)
        .append_index_html_on_directories(false)
        .fallback(ServeFile::new(shell))
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response()
}

/// Bearer token from the Authorization header.
fn header_token(headers: &header::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
}

async fn health(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    // Deliberately says nothing about panes or projects: this is the one
    // unauthenticated probe, used to tell "wrong URL" from "not paired".
    Json(json!({
        "ok": true,
        "machine": gw.machine,
        "protocolVersion": gateway::PROTOCOL_VERSION,
    }))
}

async fn pair(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Response {
    let code = body["code"].as_str().unwrap_or_default();
    let name = body["deviceName"].as_str().unwrap_or("Phone");
    match gw.tokens.redeem(code, name) {
        Some(token) => Json(json!({
            "token": token,
            "machine": gw.machine,
            "protocolVersion": gateway::PROTOCOL_VERSION,
        }))
        .into_response(),
        None => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "bad or expired pairing code" })),
        )
            .into_response(),
    }
}

/// Subscribing binds a phone's push subscription to this machine's VAPID key,
/// so these routes need the device token like any other data route.
fn require_device(gw: &Gateway, headers: &header::HeaderMap) -> Option<String> {
    let token = header_token(headers)?;
    gw.tokens.verify(&token).then(|| token)
}

async fn push_key(State(gw): State<Arc<Gateway>>, headers: header::HeaderMap) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    Json(json!({ "publicKey": gw.push.public_key() })).into_response()
}

async fn push_subscribe(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(token) = require_device(&gw, &headers) else {
        return unauthorized();
    };
    let device = agentbench_lib::gateway::tokens::token_id(&token);
    match gw.push.subscribe(body["subscription"].clone(), &device) {
        Ok(()) => {
            // hand back whatever prefs survived the resubscribe, so the app
            // can render them without keeping its own copy authoritative
            let endpoint = body["subscription"]["endpoint"].as_str().unwrap_or_default();
            Json(json!({ "ok": true, "prefs": gw.push.prefs_of(endpoint) })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// Store this device's delivery preferences (quiet hours, muted projects)
/// against its push subscription.
async fn push_prefs(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    let endpoint = body["endpoint"].as_str().unwrap_or_default();
    match gw.push.set_prefs(endpoint, body["prefs"].clone()) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// Answer a pending question from a notification action — the service worker
/// POSTs here with no window open. Same claim discipline as the in-app card,
/// so a second device (or the desktop) can't interleave keystrokes.
async fn answer(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(token) = require_device(&gw, &headers) else {
        return unauthorized();
    };
    let who = format!("push:{}", agentbench_lib::gateway::tokens::token_id(&token));
    let pane = body["paneId"].as_u64().unwrap_or(0) as u32;
    let pick = body["pick"].as_u64().unwrap_or(0) as usize;
    match gw.answer_ask(pane, body["toolId"].as_str(), pick, &who).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::CONFLICT, Json(json!({ "error": e }))).into_response(),
    }
}

async fn push_unsubscribe(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    gw.push
        .unsubscribe(body["endpoint"].as_str().unwrap_or_default());
    Json(json!({ "ok": true })).into_response()
}

/// Sends a notification immediately, so a phone can prove the whole path works
/// rather than waiting for an agent to happen to finish.
async fn push_test(State(gw): State<Arc<Gateway>>, headers: header::HeaderMap) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    let results = gw
        .push
        .notify(&json!({
            "title": format!("AgentBench · {}", gw.machine),
            "body": "Notifications are working.",
            "tag": "test",
            "machine": gw.machine,
            "kind": "test",
        }))
        .await;
    Json(json!({
        "ok": true,
        "subscriptions": gw.push.count(),
        "results": results,
    }))
    .into_response()
}

/// Browsers cannot set headers on a WebSocket handshake, so the token rides
/// the query string here (and only here). It is still the same device token,
/// checked the same way, over the same TLS.
async fn ws_bridge(
    ws: WebSocketUpgrade,
    State(gw): State<Arc<Gateway>>,
    Query(params): Query<HashMap<String, String>>,
    headers: header::HeaderMap,
) -> Response {
    let token = params
        .get("token")
        .cloned()
        .or_else(|| header_token(&headers));
    let Some(token) = token else {
        return unauthorized();
    };
    if !gw.tokens.verify(&token) {
        return unauthorized();
    }
    let who = agentbench_lib::gateway::tokens::token_id(&token);
    ws.on_upgrade(move |socket| serve_socket(socket, gw, who))
}

/// One phone connection: broker passthrough in, event fan-out back.
async fn serve_socket(socket: WebSocket, gw: Arc<Gateway>, who: String) {
    use futures_util::{SinkExt, StreamExt};
    let conn = gw.conn_seq.fetch_add(1, Ordering::SeqCst);
    let (mut sink, mut stream) = socket.split();

    // Single writer task: broker events and request replies share one channel
    // so their frames can never interleave.
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if sink.send(Message::Text(line.into())).await.is_err() {
                break;
            }
        }
    });

    // The reconnect contract: state first, then live events. A phone that
    // locked its screen mid-turn rebuilds from this instead of guessing.
    if let Ok(text) = serde_json::to_string(&gw.hello().await) {
        let _ = tx.send(text).await;
    }

    let mut events = gw.broker.subscribe();
    let ev_tx = tx.clone();
    let fanout = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    let Ok(text) = serde_json::to_string(&ev) else {
                        continue;
                    };
                    if ev_tx.send(text).await.is_err() {
                        break;
                    }
                }
                // A phone that fell far behind gets told to resync rather than
                // silently missing events it will never see again.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    let _ = ev_tx
                        .send(json!({ "ev": "resync", "missed": n }).to_string())
                        .await;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(req) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let id = req["id_"].clone();
        let who = format!("{who}:{conn}");
        let reply = if let Some(fs) = req["fs"].as_str() {
            match gw.fs_read(fs, &req).await {
                Ok(v) => json!({ "id_": id, "result": v }),
                Err(e) => json!({ "id_": id, "error": e }),
            }
        } else if req["op"].is_string() {
            match gw.broker_op(&req, &who).await {
                Ok(Some(v)) => json!({ "id_": id, "result": v }),
                // fire-and-forget ops still answer, so the phone's promise
                // settles instead of hanging on a reply the broker never sends
                Ok(None) => json!({ "id_": id, "result": null }),
                Err(e) => json!({ "id_": id, "error": e }),
            }
        } else {
            json!({ "id_": id, "error": "unknown request" })
        };
        // A client that never reads its own replies must not wedge the socket.
        if id.is_null() {
            continue;
        }
        if tx.send(reply.to_string()).await.is_err() {
            break;
        }
    }

    fanout.abort();
    drop(tx);
    let _ = writer.await;
}

// ---------------------------------------------------------------------------
// Loopback control surface — the desktop Settings window only.
// ---------------------------------------------------------------------------

/// Liveness only — no subprocesses, no network probing. Exists so "is a
/// gateway already running?" is answerable in a millisecond.
async fn local_ping(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    Json(json!({ "ok": true, "pid": std::process::id(), "machine": gw.machine }))
}

async fn local_status(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    let code = gw.tokens.current_code();
    Json(json!({
        "machine": gw.machine,
        "brokerConnected": gw.broker.is_connected(),
        "protocolVersion": gateway::PROTOCOL_VERSION,
        "urls": candidate_urls(),
        "pairing": code.map(|(code, expires)| json!({ "code": code, "expiresAt": expires })),
        "devices": gw.tokens.list(),
        "pushSubscriptions": gw.push.count(),
        "pushDevices": gw.push.list(),
    }))
}

async fn local_code(State(gw): State<Arc<Gateway>>, body: Option<Json<Value>>) -> Json<Value> {
    // Re-opening the panel returns the live code rather than minting a new
    // one, so a QR cannot be invalidated while the user is scanning it.
    // "Regenerate" passes force.
    let force = body
        .as_ref()
        .map(|b| b["force"].as_bool() == Some(true))
        .unwrap_or(false);
    let code = gw.tokens.new_code(force);
    // An empty or absent address falls back to the best detected one. Note the
    // candidates are objects, not strings — reading them as strings yielded a
    // QR pointing at nothing at all.
    let url = body
        .as_ref()
        .and_then(|b| b["url"].as_str())
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(String::from)
        .or_else(|| {
            candidate_urls()
                .first()
                .and_then(|u| u["url"].as_str().map(String::from))
        })
        .unwrap_or_default();
    let url = url.trim_end_matches('/').to_string();
    // The QR is a link into the PWA itself, so the phone's own camera opens the
    // app and pairs — no in-app scanner, no typing. The fragment carries the
    // handshake and never leaves the browser: fragments are not sent to
    // servers, logged, or included in Referer.
    use base64::Engine;
    let handshake = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(json!({ "u": url, "c": code, "m": gw.machine }).to_string());
    let payload = format!("{url}/#pair={handshake}");
    Json(json!({
        "code": code,
        "url": url,
        "payload": payload,
        "qr": qr_svg(&payload),
        "expiresIn": 600,
    }))
}

async fn local_clear_code(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    gw.tokens.clear_code();
    Json(json!({ "ok": true }))
}

async fn local_devices(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    Json(gw.tokens.list())
}

async fn local_revoke(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Json<Value> {
    let id = body["id"].as_str().unwrap_or_default();
    Json(json!({ "ok": gw.tokens.revoke(id) }))
}

async fn local_quit() -> Json<Value> {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = std::fs::remove_file(gateway::gateway_file());
        std::process::exit(0);
    });
    Json(json!({ "ok": true }))
}

/// Reachable addresses for this machine, best first — the first entry is what
/// the pairing QR encodes, so the ordering is the whole user experience.
///
/// Tailscale wins when present: it is the only option that works away from
/// home. Its plain IP leads over the MagicDNS name because that one works the
/// moment Tailscale is installed, whereas the HTTPS name needs `tailscale
/// serve` set up first; the name still appears so the trusted-certificate
/// upgrade (which is what unlocks installing the PWA) is one tap away.
/// Virtual adapters sort last: a VirtualBox or Docker address is reachable
/// from nothing at all, and left unranked it can easily come out on top.
fn candidate_urls() -> Vec<Value> {
    // Discovery runs `tailscale` twice and asks the OS for its addresses —
    // together a couple of seconds. The Settings panel polls status every few
    // seconds while it is open, so the answer is cached; addresses change on
    // the timescale of joining a network, not of a UI refresh.
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<Value>)>> =
        std::sync::Mutex::new(None);
    const TTL: std::time::Duration = std::time::Duration::from_secs(30);

    if let Some((at, cached)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < TTL {
            return cached.clone();
        }
    }
    let fresh = discover_urls();
    *CACHE.lock().unwrap() = Some((std::time::Instant::now(), fresh.clone()));
    fresh
}

fn discover_urls() -> Vec<Value> {
    let port = std::env::var("AGENTBENCH_GATEWAY_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let mut out: Vec<Value> = Vec::new();

    if let Ok(url) = std::env::var("AGENTBENCH_GATEWAY_URL") {
        if !url.trim().is_empty() {
            out.push(json!({ "url": url.trim(), "kind": "configured" }));
        }
    }

    let ts = tailscale_self();
    let ts_ips: Vec<String> = ts.as_ref().map(|t| t.ips.clone()).unwrap_or_default();
    let serving = ts.as_ref().map(|t| t.serving).unwrap_or(false);

    if let Some(ts) = &ts {
        let https = ts.name.as_ref().map(|name| {
            json!({
                "url": format!("https://{name}"),
                "kind": "tailscale",
                "needsServe": !serving,
                "serveCommand": format!("tailscale serve --bg {port}"),
            })
        });
        // Already served over HTTPS? Then that is simply the best address.
        if serving {
            out.extend(https.clone());
        }
        for ip in &ts.ips {
            if ip.contains(':') {
                continue; // IPv6 needs bracket syntax; the v4 address is enough
            }
            out.push(json!({ "url": format!("http://{ip}:{port}"), "kind": "tailscale" }));
        }
        if !serving {
            out.extend(https);
        }
    }

    let mut lan: Vec<(u8, String)> = Vec::new();
    for ip in local_ips() {
        if ts_ips.iter().any(|t| t == &ip) {
            continue; // already listed as a tailscale address
        }
        lan.push((address_rank(&ip), ip));
    }
    lan.sort_by_key(|(rank, _)| *rank);
    for (rank, ip) in lan {
        out.push(json!({
            "url": format!("http://{ip}:{port}"),
            "kind": if rank == 0 { "lan" } else { "virtual" },
        }));
    }
    out
}

/// 0 = a real LAN address, 1 = an adapter that only talks to this machine's
/// own virtual machines or containers.
fn address_rank(ip: &str) -> u8 {
    // VirtualBox host-only, and the Docker/Hyper-V 172.16/12 block
    if ip.starts_with("192.168.56.") {
        return 1;
    }
    if let Some(second) = ip.strip_prefix("172.").and_then(|r| r.split('.').next()) {
        if let Ok(n) = second.parse::<u8>() {
            if (16..=31).contains(&n) {
                return 1;
            }
        }
    }
    0
}

struct TailscaleSelf {
    name: Option<String>,
    ips: Vec<String>,
    serving: bool,
}

/// The Tailscale CLI is usually NOT on PATH on Windows, and a gateway started
/// before Tailscale was installed would not see an updated PATH anyway, so the
/// standard install locations are probed directly.
fn tailscale_bins() -> Vec<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec!["tailscale".into()];
    #[cfg(windows)]
    {
        candidates.push(r"C:\Program Files\Tailscale\tailscale.exe".into());
        candidates.push(r"C:\Program Files (x86)\Tailscale\tailscale.exe".into());
    }
    #[cfg(unix)]
    {
        candidates.push("/usr/bin/tailscale".into());
        candidates.push("/usr/local/bin/tailscale".into());
        candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale".into());
    }
    // The bare name stays first for PATH installs, but it cannot be *assumed*
    // to work: probing it is the only way to tell, so callers try each in turn.
    candidates
}

fn tailscale_cmd(bin: &std::path::Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn tailscale_self() -> Option<TailscaleSelf> {
    let (bin, status) = tailscale_bins().into_iter().find_map(|bin| {
        let raw = tailscale_cmd(&bin, &["status", "--json"])?;
        let status: Value = serde_json::from_slice(&raw).ok()?;
        Some((bin, status))
    })?;
    if status["BackendState"].as_str() != Some("Running") {
        return None;
    }
    let name = status["Self"]["DNSName"]
        .as_str()
        .map(|n| n.trim_end_matches('.').to_string())
        .filter(|n| !n.is_empty());
    let ips = status["Self"]["TailscaleIPs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    // `serve status` is non-empty only once something is actually published,
    // which is what decides whether the HTTPS name is usable today.
    let serving = tailscale_cmd(&bin, &["serve", "status", "--json"])
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .map(|v| v.get("Web").is_some_and(|w| w.as_object().is_some_and(|o| !o.is_empty())))
        .unwrap_or(false);
    Some(TailscaleSelf { name, ips, serving })
}

/// Non-loopback IPv4 addresses, so the Settings window can offer a LAN URL
/// when Tailscale is not set up yet.
fn local_ips() -> Vec<String> {
    let mut cmd;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoLogo",
            "-Command",
            "(Get-NetIPAddress -AddressFamily IPv4).IPAddress",
        ]);
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        cmd = std::process::Command::new("sh");
        cmd.args(["-lc", "ifconfig 2>/dev/null | awk '/inet /{print $2}' || ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1"]);
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|ip| {
            !ip.is_empty()
                && !ip.starts_with("127.")
                && !ip.starts_with("169.254.")
                && ip.split('.').count() == 4
        })
        .take(4)
        .collect()
}

/// QR as a self-contained SVG string; the desktop drops it straight into the
/// Settings window, so no image encoder or npm dependency is involved.
fn qr_svg(text: &str) -> String {
    use qrcodegen::{QrCode, QrCodeEcc};
    let Ok(qr) = QrCode::encode_text(text, QrCodeEcc::Medium) else {
        return String::new();
    };
    let border = 2i32;
    let size = qr.size() + border * 2;
    let mut path = String::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{},{}h1v1h-1z", x + border, y + border));
            }
        }
    }
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges"><rect width="{size}" height="{size}" fill="#fff"/><path d="{path}" fill="#000"/></svg>"##
    )
}
