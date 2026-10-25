//! agentbench-gateway: serves the mobile command-center PWA and bridges it to
//! the local broker.
//!
//! Two listeners, two trust levels. The loopback listener is the desktop app's
//! control channel (start pairing, list devices, revoke) and follows the same
//! model as the broker's hook server. The public listener is what the phone
//! talks to, and every route on it that carries data requires a device token —
//! agents here run permission-skipped, so an open port would be remote code
//! execution.

use agentbench_lib::gateway::{self, net, BrokerLink, Gateway, DEFAULT_PORT};
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

const USAGE: &str = "\
agentbench-gateway — serves the mobile PWA and bridges paired devices to the broker

USAGE:
    agentbench-gateway [--bind ADDR] [--port PORT] [--url URL]
    agentbench-gateway pair [--force] [--json]
    agentbench-gateway status
    agentbench-gateway build <command> ...

COMMANDS:
    pair      Mint a pairing code from the running gateway and print it.
              This is the headless equivalent of Settings -> Mobile access,
              for a VM with no desktop UI to press the button in.
              --json prints one machine-readable line.
    status    Print the running gateway's advertised port, pid and machine.
    build     Build, run and screenshot a project on a build host over SSH.
              Agents call this as `agentbench-build`; `build --help` for more.

OPTIONS:
    --bind ADDR  Address to listen on. Default 0.0.0.0. Pass 127.0.0.1 when
                 an SSH tunnel is the only way in.
                 Env: AGENTBENCH_GATEWAY_BIND
    --port PORT  Public listen port. Default 8473.
                 Env: AGENTBENCH_GATEWAY_PORT
    --url URL    Address to advertise in pairing payloads, when detection
                 guesses wrong (behind Tailscale Serve, a reverse proxy).
                 Env: AGENTBENCH_GATEWAY_URL
    -h, --help   Print this help
    -V, --version Print version

SECURITY:
    Plain HTTP, no TLS, and by default it listens on every interface. A device
    token is full code execution as you. Keep it on a tailnet, or bind
    127.0.0.1 and reach it through an SSH tunnel. Never port-forward it.
";

/// One-shot loopback request to the running gateway's control port. Kept on
/// raw TCP to match `live_gateway` — the control plane is unauthenticated and
/// loopback-only, and pulling in an HTTP client for two calls is not worth it.
fn control_request(method: &str, path: &str, body: Option<&str>) -> Option<Value> {
    use std::io::{Read, Write};
    let text = std::fs::read_to_string(gateway::gateway_file()).ok()?;
    let info: Value = serde_json::from_str(&text).ok()?;
    let control = info["controlPort"].as_u64()? as u16;
    let addr = SocketAddr::from(([127, 0, 0, 1], control));
    let mut stream =
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(600)).ok()?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok()?;
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut raw = String::new();
    let _ = stream.read_to_string(&mut raw);
    let (_, payload) = raw.split_once("\r\n\r\n")?;
    serde_json::from_str(payload.trim()).ok()
}

fn cmd_pair(force: bool, as_json: bool) -> ! {
    let body = format!("{{\"force\":{force}}}");
    match control_request("POST", "/local/code", Some(&body)) {
        Some(v) => {
            // --json is what the desktop's SSH remote-host flow reads: it runs
            // this over the SSH session and pairs itself, so nobody ever sees
            // a code. Print only the fields it needs, on one line.
            if as_json {
                println!(
                    "{}",
                    json!({ "code": v["code"], "url": v["url"], "expiresIn": v["expiresIn"] })
                );
                std::process::exit(0)
            }
            let code = v["code"].as_str().unwrap_or("?");
            let url = v["url"].as_str().unwrap_or("");
            println!("pairing code: {code}");
            if !url.is_empty() {
                println!("address:      {url}");
            }
            println!("expires in:   10 minutes (single use)");
            println!();
            println!("On the other bench: Settings -> Linked benches -> enter that address and code.");
            std::process::exit(0)
        }
        None => {
            eprintln!("agentbench-gateway: no running gateway to pair with (start it first)");
            std::process::exit(1)
        }
    }
}

fn cmd_status() -> ! {
    match control_request("GET", "/local/status", None) {
        Some(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            std::process::exit(0)
        }
        None => {
            eprintln!("agentbench-gateway: not running");
            std::process::exit(1)
        }
    }
}

fn main() {
    // `agentbench-gateway build …` is the build-host CLI agents call as
    // `agentbench-build`. It never starts the gateway, and it runs before any
    // async runtime exists so it is free to start its own.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("build") {
        std::process::exit(agentbench_lib::buildhost::cli::main(&argv[1..]));
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve());
}

async fn serve() {
    let mut port: u16 = std::env::var("AGENTBENCH_GATEWAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Default stays 0.0.0.0 so an existing install keeps working. The SSH
    // remote-host flow passes 127.0.0.1, because there the tunnel is the only
    // way in and a public listener would be pure exposure.
    let mut bind: std::net::IpAddr = std::env::var("AGENTBENCH_GATEWAY_BIND")
        .ok()
        .and_then(|b| b.parse().ok())
        .unwrap_or(std::net::IpAddr::from([0, 0, 0, 0]));

    let mut args = std::env::args().skip(1).peekable();
    let mut force = false;
    let mut as_json = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return;
            }
            "-V" | "--version" => {
                println!("agentbench-gateway {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--force" => force = true,
            "--json" => as_json = true,
            "pair" => {
                // flags may sit either side of the verb
                for rest in args.by_ref() {
                    match rest.as_str() {
                        "--force" => force = true,
                        "--json" => as_json = true,
                        _ => {}
                    }
                }
                cmd_pair(force, as_json)
            }
            "status" => cmd_status(),
            "--bind" => match args.next().and_then(|v| v.parse().ok()) {
                Some(b) => bind = b,
                None => {
                    eprintln!("--bind needs an IP address, e.g. 127.0.0.1");
                    std::process::exit(2);
                }
            },
            "--port" => match args.next().and_then(|v| v.parse().ok()) {
                Some(p) => port = p,
                None => {
                    eprintln!("--port needs a number");
                    std::process::exit(2);
                }
            },
            "--url" => match args.next() {
                Some(u) => std::env::set_var("AGENTBENCH_GATEWAY_URL", u),
                None => {
                    eprintln!("--url needs a value");
                    std::process::exit(2);
                }
            },
            other => {
                eprintln!("unknown argument: {other}\n\n{USAGE}");
                std::process::exit(2);
            }
        }
    }

    let broker = BrokerLink::new();
    broker.spawn_connect_loop();
    let gw = Gateway::new(broker);

    // Bind the public listener first: if the port is taken, another gateway is
    // already running and this process must not clobber its gateway.json.
    let public_listener = match tokio::net::TcpListener::bind(SocketAddr::from((bind, port))).await
    {
        Ok(l) => l,
        Err(e) => {
            eprintln!("agentbench-gateway: cannot bind {bind}:{port}: {e}");
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

    // Keep the Cloudflare tunnel up. The gateway outlives the desktop app, so
    // it is the right place to notice cloudflared died and relaunch it — a
    // no-op unless a tunnel was started and not explicitly stopped.
    tokio::spawn(async {
        let mut wait = 2u64; // first look soon after boot, then settle
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            wait = match tokio::task::spawn_blocking(agentbench_lib::tunnel::ensure_running).await {
                Ok(agentbench_lib::tunnel::Revive::Restarted) => {
                    eprintln!("agentbench-gateway: tunnel had died — restarted it");
                    15
                }
                // cloudflared missing or refusing to start: back off, don't spin
                Ok(agentbench_lib::tunnel::Revive::Failed(e)) => {
                    eprintln!("agentbench-gateway: tunnel restart failed: {e}");
                    (wait.max(15) * 2).min(300)
                }
                _ => 15,
            };
        }
    });

    // Relay: when enabled in Settings, keep a listening connection open so
    // benches on other networks can reach this gateway. Off by default.
    agentbench_lib::relay::host::start(port);

    eprintln!("agentbench-gateway: public :{port}, control 127.0.0.1:{local_port}");

    // Anything unauthenticated lives here and nowhere else: the pairing
    // exchange plus the static shell, which carries no data of its own. A
    // phone must be able to load the app and pair before it has a token.
    let public = Router::new()
        .route("/", get(root_shell))
        .route("/m", get(mobile_shell))
        .route("/usage", get(usage_shell))
        .route("/api/pair", post(pair))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/passkey/login/start", post(passkey_login_start))
        .route("/api/passkey/login/finish", post(passkey_login_finish))
        .route("/api/passkey/register/start", post(passkey_register_start))
        .route("/api/passkey/register/finish", post(passkey_register_finish))
        .route("/api/passkeys", get(passkey_list))
        .route("/api/passkeys/remove", post(passkey_remove))
        .route("/api/link-back", post(link_back))
        .route("/api/ws", any(ws_bridge))
        .route("/api/dictate", any(dictate_ws))
        .route("/api/dictate/status", get(dictate_status))
        .route("/api/health", get(health))
        .route("/api/push/key", get(push_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route("/api/push/test", post(push_test))
        .route("/api/push/prefs", post(push_prefs))
        .route("/api/answer", post(answer))
        .route("/api/usage", get(usage))
        .route("/api/file", get(download))
        .route("/api/build/exec", any(build_exec))
        .route(
            "/api/upload",
            post(upload).layer(axum::extract::DefaultBodyLimit::max(
                gateway::uploads::MAX_UPLOAD_BYTES,
            )),
        )
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
        .route(
            "/local/password",
            post(local_set_password).delete(local_clear_password),
        )
        .route("/local/webui", post(local_webui))
        .route("/local/devices", get(local_devices))
        .route(
            "/local/links",
            get(local_links).delete(local_forget_link),
        )
        .route("/local/revoke", post(local_revoke))
        .route("/local/passkeys", get(local_passkeys))
        .route("/local/passkeys/remove", post(local_remove_passkey))
        .route("/local/quit", post(local_quit))
        .route("/local/relay", get(local_relay).post(local_relay_set))
        .route("/local/relay/link", post(local_relay_link))
        .route("/local/relay/revoke", post(local_relay_revoke))
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

/// What `/` serves is a runtime decision, not a route decision: with the web
/// UI enabled it is the desktop bench (`index.html`), otherwise the phone
/// shell — same behavior as before the web UI existed. The shell itself stays
/// unauthenticated either way; it carries no data, and every API call it makes
/// needs a device token.
async fn root_shell(State(gw): State<Arc<Gateway>>) -> Response {
    serve_shell(if gw.tokens.web_ui() {
        "index.html"
    } else {
        "mobile.html"
    })
}

/// The phone shell, always — so a paired phone keeps a stable address to
/// install the PWA from even when `/` is the desktop bench.
async fn mobile_shell() -> Response {
    serve_shell("mobile.html")
}

/// The Claude usage page lives in the desktop bundle (WebGate renders it for
/// this path), whether or not `/` serves the full bench.
async fn usage_shell() -> Response {
    serve_shell("index.html")
}

fn serve_shell(name: &str) -> Response {
    match std::fs::read(pwa_dir().join(name)) {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                // the shell decides what the origin serves; never cache it
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "shell not built").into_response(),
    }
}

/// Exchange the login password (or a live pairing code) for a device token.
/// The password path is what the browser login screen uses; lockout and
/// rate-limiting live in the token store.
async fn login(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Response {
    let device = body["deviceName"].as_str().unwrap_or("Web").trim();
    let device = if device.is_empty() { "Web" } else { device };
    let minted = if let Some(pw) = body["password"].as_str() {
        gw.tokens.login(pw, device)
    } else if let Some(code) = body["code"].as_str() {
        gw.tokens
            .redeem(code, device, Some("web"))
            .ok_or_else(|| "bad or expired pairing code".to_string())
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "login needs a password or a pairing code" })),
        )
            .into_response();
    };
    match minted {
        Ok(token) => Json(json!({
            "token": token,
            "machine": gw.machine,
            "protocolVersion": gateway::PROTOCOL_VERSION,
        }))
        .into_response(),
        Err(e) => (StatusCode::FORBIDDEN, Json(json!({ "error": e }))).into_response(),
    }
}

/// Sign out: revoke the caller's own device token, so a forgotten machine
/// does not leave a live credential behind in the browser.
async fn logout(State(gw): State<Arc<Gateway>>, headers: header::HeaderMap) -> Response {
    let Some(token) = require_device(&gw, &headers) else {
        return unauthorized();
    };
    let id = agentbench_lib::gateway::tokens::token_id(&token);
    Json(json!({ "ok": gw.tokens.revoke(&id) })).into_response()
}

/// The browser origin a passkey ceremony runs under. Browsers always send
/// Origin on these POSTs; it becomes the relying-party id, and the signed
/// client data must name the same origin, so a forged header buys nothing.
fn request_origin(headers: &header::HeaderMap) -> String {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn bad_request(e: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response()
}

async fn passkey_login_start(State(gw): State<Arc<Gateway>>, headers: header::HeaderMap) -> Response {
    match gw.passkeys.login_start(&request_origin(&headers)) {
        Ok(opts) => Json(opts).into_response(),
        Err(e) => bad_request(e),
    }
}

/// A verified assertion mints a web device token, exactly as a password
/// login does.
async fn passkey_login_finish(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Response {
    match gw.passkeys.login_finish(&body) {
        Ok(_) => {
            let device = body["deviceName"].as_str().unwrap_or("Web");
            Json(json!({
                "token": gw.tokens.mint_web(device),
                "machine": gw.machine,
                "protocolVersion": gateway::PROTOCOL_VERSION,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::FORBIDDEN, Json(json!({ "error": e }))).into_response(),
    }
}

/// Adding a passkey needs a signed-in device: a passkey is a new way in, so
/// only someone already in may create one.
async fn passkey_register_start(State(gw): State<Arc<Gateway>>, headers: header::HeaderMap) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    match gw.passkeys.register_start(&request_origin(&headers), &gw.machine) {
        Ok(opts) => Json(opts).into_response(),
        Err(e) => bad_request(e),
    }
}

async fn passkey_register_finish(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    match gw.passkeys.register_finish(&body) {
        Ok(p) => Json(p).into_response(),
        Err(e) => bad_request(e),
    }
}

async fn passkey_list(State(gw): State<Arc<Gateway>>, headers: header::HeaderMap) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    Json(gw.passkeys.list()).into_response()
}

async fn passkey_remove(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    Json(json!({ "ok": gw.passkeys.remove(body["id"].as_str().unwrap_or_default()) })).into_response()
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
    // "bench" marks another AgentBench install, so the Devices list can badge
    // it. Purely cosmetic — the token is the same capability either way.
    let kind = body["kind"].as_str();
    match gw.tokens.redeem(code, name, kind) {
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

/// The second half of bench-to-bench pairing. A desktop that just paired with
/// this machine hands over a fresh pairing code for *its own* gateway; this
/// gateway redeems it and keeps the resulting token in `gateway-links.json`,
/// which is how this machine's desktop learns it can reach back. Bearer-authed:
/// only an already-paired device may ask this machine to pair outward.
///
/// The outbound POST goes to a caller-supplied URL, which is fine precisely
/// because the caller is authenticated — a paired device already runs code on
/// this machine through the broker ops; a URL fetch adds nothing.
async fn link_back(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    let url = body["url"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    let code = body["code"].as_str().unwrap_or_default().trim().to_string();
    if code.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "link-back needs a url and a code" })),
        )
            .into_response();
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                .into_response()
        }
    };
    let res = client
        .post(format!("{url}/api/pair"))
        .json(&json!({
            "code": code,
            "deviceName": format!("{} (bench)", gw.machine),
            "kind": "bench",
        }))
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("cannot reach {url}: {e}") })),
            )
                .into_response()
        }
    };
    let ok = res.status().is_success();
    let reply: Value = res.json().await.unwrap_or_default();
    if !ok {
        let why = reply["error"].as_str().unwrap_or("pairing refused");
        return (StatusCode::BAD_GATEWAY, Json(json!({ "error": why }))).into_response();
    }
    let Some(token) = reply["token"].as_str() else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "no token in pair response" })),
        )
            .into_response();
    };
    let machine = reply["machine"].as_str().unwrap_or("bench");
    gw.links.add(&url, token, machine);
    Json(json!({ "ok": true, "machine": machine })).into_response()
}

/// Subscribing binds a phone's push subscription to this machine's VAPID key,
/// so these routes need the device token like any other data route.
fn require_device(gw: &Gateway, headers: &header::HeaderMap) -> Option<String> {
    let token = header_token(headers)?;
    gw.tokens.verify(&token).then(|| token)
}

/// Claude plan usage (what `/usage` shows in Claude Code) for this machine's
/// logged-in account.
async fn usage(headers: header::HeaderMap, State(gw): State<Arc<Gateway>>) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    match gateway::usage::claude_usage().await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response(),
    }
}

/// A file for an agent, sent from a browser: raw bytes in the body, the
/// original name in `?name=`. Answers with the temp path the composer then
/// hands Claude. Plain HTTP rather than a socket frame so large files skip
/// base64 and the WebSocket frame cap.
async fn upload(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    let name = q.get("name").cloned().unwrap_or_default();
    match tokio::task::spawn_blocking(move || gateway::uploads::save_upload(&name, &body)).await {
        Ok(Ok(path)) => Json(json!({ "path": path.to_string_lossy() })).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
            .into_response(),
    }
}

/// A workstation file an agent is handing over (a `[name](/abs/path)` link
/// in its reply), streamed to the browser as a download. A device token
/// already runs shells on this machine, so reading a file adds no reach.
async fn download(
    State(gw): State<Arc<Gateway>>,
    headers: header::HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    let raw = q.get("path").cloned().unwrap_or_default();
    let path = match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => std::path::PathBuf::from(&raw),
    };
    let fail = |code: StatusCode, e: String| (code, Json(json!({ "error": e }))).into_response();
    if !path.is_absolute() {
        return fail(StatusCode::BAD_REQUEST, "path must be absolute".into());
    }
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        Ok(_) => return fail(StatusCode::BAD_REQUEST, "not a file".into()),
        Err(e) => return fail(StatusCode::NOT_FOUND, e.to_string()),
    };
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => return fail(StatusCode::FORBIDDEN, e.to_string()),
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    // RFC 5987 form so non-ASCII names survive; the plain one is a fallback
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let stream = futures_util::stream::unfold(file, |mut f| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 256 * 1024];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(buf)), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, meta.len())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from_stream(stream))
        .unwrap_or_else(|e| fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
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
/// the `Sec-WebSocket-Protocol` list: the client offers `["bearer", <token>]`
/// and the server selects `bearer`. Unlike the older `?token=` query form
/// (still accepted for existing paired phones), a subprotocol entry never
/// lands in access logs — which matters once Cloudflare sits in front.
async fn ws_bridge(
    ws: WebSocketUpgrade,
    State(gw): State<Arc<Gateway>>,
    Query(params): Query<HashMap<String, String>>,
    headers: header::HeaderMap,
) -> Response {
    let Some(token) = socket_token(&gw, &params, &headers) else {
        return unauthorized();
    };
    let who = agentbench_lib::gateway::tokens::token_id(&token);
    // Selecting "bearer" answers a subprotocol offer; with a plain query-token
    // client nothing is offered, nothing is echoed, and this is a no-op.
    ws.protocols(["bearer"])
        .on_upgrade(move |socket| serve_socket(socket, gw, who))
}

/// The verified device token on a WebSocket handshake: the subprotocol offer
/// first, then the older `?token=` query, then an Authorization header.
fn socket_token(
    gw: &Gateway,
    params: &HashMap<String, String>,
    headers: &header::HeaderMap,
) -> Option<String> {
    let proto_token = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|list| {
            list.split(',')
                .map(str::trim)
                .find(|p| *p != "bearer" && !p.is_empty())
                .map(String::from)
        });
    let token = proto_token
        .or_else(|| params.get("token").cloned())
        .or_else(|| header_token(headers))?;
    gw.tokens.verify(&token).then_some(token)
}

/// Build-host exec: run one command here for a linked bench's
/// `agentbench-build`, streamed over the socket (see gateway::exec). Only
/// tokens paired as another bench may use it — not phones or browsers.
async fn build_exec(
    ws: WebSocketUpgrade,
    State(gw): State<Arc<Gateway>>,
    Query(params): Query<HashMap<String, String>>,
    headers: header::HeaderMap,
) -> Response {
    let Some(token) = socket_token(&gw, &params, &headers) else {
        return unauthorized();
    };
    if gw.tokens.kind_of(&token).as_deref() != Some("bench") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "only linked benches may run build commands" })),
        )
            .into_response();
    }
    ws.protocols(["bearer"]).on_upgrade(gateway::exec::serve)
}

/// Relay settings for this bench: status, and turning it on or off.
async fn local_relay() -> Json<Value> {
    Json(agentbench_lib::relay::host::status())
}

async fn local_relay_set(Json(body): Json<Value>) -> Response {
    let enabled = body["enabled"].as_bool().unwrap_or(false);
    match agentbench_lib::relay::host::configure(body["url"].as_str(), enabled) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// A link code another bench pastes to link here through the relay. It
/// carries a fresh pairing code, so it is good for one link within ten
/// minutes.
async fn local_relay_link(State(gw): State<Arc<Gateway>>) -> Response {
    let pair = gw.tokens.new_code(true);
    match agentbench_lib::relay::host::mint_link(&pair, &gw.machine) {
        Ok(code) => Json(json!({ "code": code })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

async fn local_relay_revoke(Json(body): Json<Value>) -> Response {
    match agentbench_lib::relay::host::revoke(body["key"].as_str().unwrap_or_default()) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// Whether the browser mic should stream to Parakeet here or fall back to the
/// phone's own recognizer.
async fn dictate_status(headers: header::HeaderMap, State(gw): State<Arc<Gateway>>) -> Response {
    if require_device(&gw, &headers).is_none() {
        return unauthorized();
    }
    Json(json!({ "available": gateway::dictate::available() })).into_response()
}

/// Browser dictation: 16 kHz mono PCM16 in as binary frames, `{type, text}`
/// JSON out. A `"stop"` text frame asks for the final transcript, which is
/// sent before the server closes.
async fn dictate_ws(
    ws: WebSocketUpgrade,
    State(gw): State<Arc<Gateway>>,
    Query(params): Query<HashMap<String, String>>,
    headers: header::HeaderMap,
) -> Response {
    if socket_token(&gw, &params, &headers).is_none() {
        return unauthorized();
    }
    if !gateway::dictate::available() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Parakeet is not installed on this machine" })),
        )
            .into_response();
    }
    ws.protocols(["bearer"]).on_upgrade(serve_dictation)
}

#[cfg(not(feature = "parakeet"))]
async fn serve_dictation(_socket: WebSocket) {}

#[cfg(feature = "parakeet")]
async fn serve_dictation(socket: WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    use gateway::dictate::{pcm16_to_f32, Event, Session};

    enum In {
        Audio(Vec<f32>),
        Stop,
    }
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = std::sync::mpsc::channel::<In>();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Event>();

    // Decoding blocks for tens of milliseconds at a time, so the session lives
    // on its own thread. Audio that queues up while it decodes is folded into
    // one push rather than decoded chunk by chunk.
    std::thread::spawn(move || {
        let mut session = match Session::new() {
            Ok(s) => s,
            Err(e) => {
                let _ = out_tx.send(Event::Error(e));
                return;
            }
        };
        while let Ok(first) = in_rx.recv() {
            let mut audio = Vec::new();
            let mut stop = false;
            for msg in std::iter::once(first).chain(in_rx.try_iter()) {
                match msg {
                    In::Audio(a) => audio.extend(a),
                    In::Stop => stop = true,
                }
            }
            if let Some(ev) = session.push(&audio) {
                let _ = out_tx.send(ev);
            }
            if stop {
                let _ = out_tx.send(session.finish());
                return;
            }
        }
        // Socket dropped without a stop: nothing left to send to.
    });

    let reader = async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Binary(b) => {
                    if in_tx.send(In::Audio(pcm16_to_f32(&b))).is_err() {
                        break;
                    }
                }
                Message::Text(t) if t.as_str() == "stop" => {
                    let _ = in_tx.send(In::Stop);
                    break;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        // Dropping `in_tx` ends the session thread if no stop came.
    };
    let writer = async move {
        while let Some(ev) = out_rx.recv().await {
            let (kind, text, done) = match ev {
                Event::Partial(t) => ("partial", t, false),
                Event::Final(t) => ("final", t, true),
                Event::Error(t) => ("error", t, true),
            };
            let frame = json!({ "type": kind, "text": text }).to_string();
            if sink.send(Message::Text(frame.into())).await.is_err() || done {
                break;
            }
        }
        let _ = sink.close().await;
    };
    // The reader stops at "stop", but the final transcript is still owed:
    // run both and let the writer decide when the socket is done.
    let (_, ()) = tokio::join!(reader, writer);
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

    // Revocation must bite now, not at the next reconnect: a revoked device
    // with a live socket would keep full broker access for as long as it kept
    // the tab open. Polling the device list every few seconds is crude but
    // races nothing and costs nothing.
    let mut revoked_check = tokio::time::interval(std::time::Duration::from_secs(5));
    revoked_check.reset(); // no immediate tick; the handshake just verified
    loop {
        let msg = tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(m)) => m,
                _ => break,
            },
            _ = revoked_check.tick() => {
                if gw.tokens.device_exists(&who) {
                    continue;
                }
                break;
            }
        };
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
    Json(json!({
        "ok": true,
        "pid": std::process::id(),
        "machine": gw.machine,
        // lets the desktop spot a gateway left running by a previous install
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn local_status(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    let code = gw.tokens.current_code();
    Json(json!({
        "machine": gw.machine,
        "brokerConnected": gw.broker.is_connected(),
        "protocolVersion": gateway::PROTOCOL_VERSION,
        "version": env!("CARGO_PKG_VERSION"),
        "urls": candidate_urls(),
        "pairing": code.map(|(code, expires)| json!({ "code": code, "expiresAt": expires })),
        "devices": gw.tokens.list(),
        "pushSubscriptions": gw.push.count(),
        "pushDevices": gw.push.list(),
        "hasPassword": gw.tokens.has_password(),
        "passkeys": gw.passkeys.list(),
        "webUi": gw.tokens.web_ui(),
    }))
}

async fn local_set_password(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Response {
    match gw.tokens.set_password(body["password"].as_str().unwrap_or_default()) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

async fn local_clear_password(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    gw.tokens.clear_password();
    Json(json!({ "ok": true }))
}

async fn local_webui(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Json<Value> {
    gw.tokens.set_web_ui(body["enabled"].as_bool() == Some(true));
    Json(json!({ "ok": true, "webUi": gw.tokens.web_ui() }))
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

/// Benches this machine can reach out to, tokens included — loopback only,
/// same trust level as the desktop app that reads it.
async fn local_links(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    Json(gw.links.list_json())
}

async fn local_forget_link(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": gw.links.forget(body["url"].as_str().unwrap_or_default()) }))
}

async fn local_revoke(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Json<Value> {
    let id = body["id"].as_str().unwrap_or_default();
    Json(json!({ "ok": gw.tokens.revoke(id) }))
}

async fn local_passkeys(State(gw): State<Arc<Gateway>>) -> Json<Value> {
    Json(gw.passkeys.list())
}

async fn local_remove_passkey(State(gw): State<Arc<Gateway>>, Json(body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": gw.passkeys.remove(body["id"].as_str().unwrap_or_default()) }))
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

    let ts = net::tailscale_self();
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
    for ip in net::local_ips() {
        if ts_ips.iter().any(|t| t == &ip) {
            continue; // already listed as a tailscale address
        }
        lan.push((net::address_rank(&ip), ip));
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
