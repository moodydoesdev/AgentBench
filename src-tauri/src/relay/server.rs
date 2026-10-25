//! `agentbench-relay`: the meeting point for benches on different networks.
//!
//! It holds one listening socket per host and, when a client asks for a host
//! by id, has that host open a matching socket and copies frames between the
//! two. It never sees plaintext: the benches run their own handshake through
//! it (crypto.rs), and a host must prove it owns an id before it may listen
//! under it, so nobody can hijack a host's traffic.
//!
//! ```text
//! GET /v1/listen        host: challenge → signed hello → {"open": sid}…
//! GET /v1/connect/<id>  client: spliced to the host's /v1/accept/<sid>
//! GET /v1/accept/<sid>  host: the other half of one client connection
//! GET /healthz          "ok", for a load balancer
//! ```
//!
//! Run it behind anything that terminates TLS (Caddy, Traefik, nginx) so
//! benches connect with wss://. It keeps no state on disk.

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// One frame is at most a 16 KiB plaintext chunk plus overhead; anything far
/// bigger is not a bench talking.
const MAX_FRAME: usize = 256 * 1024;
/// Concurrent streams one host may have open — a desktop opens a handful of
/// HTTP connections per linked bench.
const MAX_STREAMS_PER_HOST: usize = 128;
const MAX_HOSTS: usize = 10_000;
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Relay {
    /// host id → its listening socket's outbox, plus a counter so a stale
    /// listener cannot remove its replacement.
    hosts: Mutex<HashMap<String, (u64, mpsc::UnboundedSender<String>)>>,
    /// stream id → where to hand the host's socket when it arrives.
    waiting: Mutex<HashMap<String, (String, oneshot::Sender<WebSocket>)>>,
    /// host id → streams currently open or waiting.
    streams: Mutex<HashMap<String, usize>>,
    next: std::sync::atomic::AtomicU64,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    crate::gateway::tokens::fill_random(&mut b);
    data_encoding::HEXLOWER.encode(&b)
}

pub async fn run(bind: SocketAddr) -> Result<(), String> {
    let relay = Arc::new(Relay::default());
    let app = Router::new()
        .route("/", get(|| async { "AgentBench relay\n" }))
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/listen", get(listen))
        .route("/v1/connect/{id}", get(connect))
        .route("/v1/accept/{sid}", get(accept))
        .with_state(relay);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("cannot bind {bind}: {e}"))?;
    eprintln!("agentbench-relay: listening on {bind}");
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

fn close(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.to_string().into() }))
}

async fn listen(ws: WebSocketUpgrade, State(relay): State<Arc<Relay>>) -> Response {
    ws.max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| host_session(socket, relay))
        .into_response()
}

async fn host_session(mut socket: WebSocket, relay: Arc<Relay>) {
    let challenge = random_hex(32);
    if socket
        .send(Message::Text(json!({ "challenge": challenge }).to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let hello = match tokio::time::timeout(Duration::from_secs(15), socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(&t).unwrap_or(Value::Null),
        _ => return,
    };
    let hexf = |k: &str| data_encoding::HEXLOWER.decode(hello[k].as_str().unwrap_or("").as_bytes()).ok();
    let id = match (hexf("dh"), hexf("sigPub"), hexf("sig"), data_encoding::HEXLOWER.decode(challenge.as_bytes()).ok()) {
        (Some(dh), Some(sp), Some(sig), Some(ch)) => super::crypto::verify_listener(&dh, &sp, &ch, &sig),
        _ => None,
    };
    let Some(id) = id else {
        let _ = socket.send(Message::Text(json!({ "ok": false, "error": "bad signature" }).to_string().into())).await;
        let _ = socket.send(close(4001, "bad signature")).await;
        return;
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let generation = relay.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let admitted = {
        let mut hosts = relay.hosts.lock().unwrap();
        if hosts.len() >= MAX_HOSTS && !hosts.contains_key(&id) {
            false
        } else {
            // The newest listener wins: a host that reconnects after a
            // network blip replaces its stale half-open socket.
            hosts.insert(id.clone(), (generation, tx));
            true
        }
    };
    if !admitted {
        let _ = socket.send(close(4013, "relay full")).await;
        return;
    }
    let _ = socket
        .send(Message::Text(json!({ "ok": true, "id": id }).to_string().into()))
        .await;

    let mut ping = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(text) => if socket.send(Message::Text(text.into())).await.is_err() { break },
                None => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break },
        }
    }
    let mut hosts = relay.hosts.lock().unwrap();
    if hosts.get(&id).map(|(g, _)| *g) == Some(generation) {
        hosts.remove(&id);
    }
}

async fn connect(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(relay): State<Arc<Relay>>,
) -> Response {
    ws.max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| client_session(socket, id, relay))
        .into_response()
}

/// Releases a host's stream slot however the client session ends.
struct Slot {
    relay: Arc<Relay>,
    id: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut streams = self.relay.streams.lock().unwrap();
        if let Some(n) = streams.get_mut(&self.id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                streams.remove(&self.id);
            }
        }
    }
}

async fn client_session(mut client: WebSocket, id: String, relay: Arc<Relay>) {
    let outbox = relay.hosts.lock().unwrap().get(&id).map(|(_, tx)| tx.clone());
    let Some(outbox) = outbox else {
        let _ = client.send(close(4004, "that bench is not connected to this relay")).await;
        return;
    };
    let admitted = {
        let mut streams = relay.streams.lock().unwrap();
        let n = streams.entry(id.clone()).or_insert(0);
        if *n >= MAX_STREAMS_PER_HOST {
            false
        } else {
            *n += 1;
            true
        }
    };
    if !admitted {
        let _ = client.send(close(4029, "too many connections to that bench")).await;
        return;
    }
    let _slot = Slot { relay: relay.clone(), id: id.clone() };

    let sid = random_hex(16);
    let (tx, rx) = oneshot::channel();
    relay.waiting.lock().unwrap().insert(sid.clone(), (id.clone(), tx));
    if outbox.send(json!({ "open": sid }).to_string()).is_err() {
        relay.waiting.lock().unwrap().remove(&sid);
        let _ = client.send(close(4004, "that bench is not connected to this relay")).await;
        return;
    }
    let host = match tokio::time::timeout(ACCEPT_TIMEOUT, rx).await {
        Ok(Ok(h)) => h,
        _ => {
            relay.waiting.lock().unwrap().remove(&sid);
            let _ = client.send(close(4008, "that bench did not answer")).await;
            return;
        }
    };
    splice(client, host).await;
}

async fn accept(
    ws: WebSocketUpgrade,
    Path(sid): Path<String>,
    State(relay): State<Arc<Relay>>,
) -> Response {
    // The stream id was only ever sent down an authenticated listening
    // socket, so holding it is the host's credential for this half.
    let Some((_, tx)) = relay.waiting.lock().unwrap().remove(&sid) else {
        return (axum::http::StatusCode::NOT_FOUND, "no such stream").into_response();
    };
    ws.max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| async move {
            let _ = tx.send(socket);
        })
        .into_response()
}

/// Copy frames both ways until either side goes away. Binary frames are the
/// benches' ciphertext; pings are answered per side by axum itself; a close
/// is passed on with its reason, so a refusal reaches the other bench intact.
async fn splice(a: WebSocket, b: WebSocket) {
    let (mut a_tx, mut a_rx) = a.split();
    let (mut b_tx, mut b_rx) = b.split();
    let a_to_b = async {
        while let Some(Ok(msg)) = a_rx.next().await {
            match msg {
                Message::Binary(_) | Message::Text(_) => {
                    if b_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Message::Close(frame) => {
                    let _ = b_tx.send(Message::Close(frame)).await;
                    return;
                }
                _ => {}
            }
        }
        let _ = b_tx.send(Message::Close(None)).await;
    };
    let b_to_a = async {
        while let Some(Ok(msg)) = b_rx.next().await {
            match msg {
                Message::Binary(_) | Message::Text(_) => {
                    if a_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Message::Close(frame) => {
                    let _ = a_tx.send(Message::Close(frame)).await;
                    return;
                }
                _ => {}
            }
        }
        let _ = a_tx.send(Message::Close(None)).await;
    };
    tokio::select! {
        _ = a_to_b => {}
        _ = b_to_a => {}
    }
}
