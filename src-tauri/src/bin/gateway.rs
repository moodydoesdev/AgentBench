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

    let _ = std::fs::create_dir_all(agentbench_lib::broker::config_dir());
    let _ = std::fs::write(
        gateway::gateway_file(),
        serde_json::to_string_pretty(&json!({
            "port": port,
            "controlPort": local_port,
            "pid": std::process::id(),
            "machine": gw.machine,
        }))
        .unwrap(),
    );

    eprintln!("agentbench-gateway: public :{port}, control 127.0.0.1:{local_port}");

    // Anything unauthenticated lives here and nowhere else: the pairing
    // exchange plus the static shell, which carries no data of its own. A
    // phone must be able to load the app and pair before it has a token.
    let public = Router::new()
        .route("/api/pair", post(pair))
        .route("/api/ws", any(ws_bridge))
        .route("/api/health", get(health))
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
            match gw.fs_read(fs, &req) {
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

async fn local_status(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    let code = gw.tokens.current_code();
    Json(json!({
        "machine": gw.machine,
        "brokerConnected": gw.broker.is_connected(),
        "protocolVersion": gateway::PROTOCOL_VERSION,
        "urls": candidate_urls(),
        "pairing": code.map(|(code, expires)| json!({ "code": code, "expiresAt": expires })),
        "devices": gw.tokens.list(),
    }))
}

async fn local_code(State(gw): State<Arc<Gateway>>, body: Option<Json<Value>>) -> Json<Value> {
    let code = gw.tokens.new_code();
    let url = body
        .as_ref()
        .and_then(|b| b["url"].as_str().map(String::from))
        .or_else(|| candidate_urls().first().and_then(|u| u.as_str().map(String::from)))
        .unwrap_or_default();
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

/// Reachable addresses for this machine, best first. Tailscale is the intended
/// transport, so its name leads when the CLI can tell us one.
fn candidate_urls() -> Vec<Value> {
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
    if let Some(name) = tailscale_dns_name() {
        // `tailscale serve` publishes on 443 under the machine's MagicDNS name
        out.push(json!({
            "url": format!("https://{name}"),
            "kind": "tailscale",
            "needsServe": true,
            "serveCommand": format!("tailscale serve --bg {port}"),
        }));
        out.push(json!({ "url": format!("http://{name}:{port}"), "kind": "tailscale-direct" }));
    }
    for ip in local_ips() {
        out.push(json!({ "url": format!("http://{ip}:{port}"), "kind": "lan" }));
    }
    out
}

fn tailscale_dns_name() -> Option<String> {
    let mut cmd = std::process::Command::new("tailscale");
    cmd.args(["status", "--json"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_string())
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
