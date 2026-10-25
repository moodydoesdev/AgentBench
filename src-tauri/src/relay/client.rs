//! The dialing side of the relay: the desktop, and the `agentbench-build`
//! CLI, reaching a bench they linked to.

use super::crypto::{self, Identity, LinkSecret};
use super::{connect_ws, LinkCode, Peer};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_tungstenite::tungstenite::Message;

/// An encrypted byte stream to the host's gateway port.
pub async fn dial(
    relay: &str,
    peer_id: &str,
    me: &Identity,
    link: Option<&LinkSecret>,
) -> Result<DuplexStream, String> {
    let mut ws = connect_ws(&format!("{relay}/v1/connect/{peer_id}"), None).await?;
    let session = crypto::initiate(&mut ws, me, peer_id, link).await?;
    Ok(crypto::secure_pipe(ws, session))
}

/// One HTTP/1.1 request over a fresh stream, `Connection: close`, returning
/// the status and the JSON body. Enough for pairing; everything richer goes
/// through a forwarded port or the exec socket.
async fn http_json(
    mut stream: DuplexStream,
    method: &str,
    path: &str,
    body: &Value,
) -> Result<(u16, Value), String> {
    let body = body.to_string();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: bench\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(20), stream.read_to_end(&mut raw))
        .await
        .map_err(|_| "the other bench did not answer".to_string())?
        .map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&raw);
    let (head, payload) = raw.split_once("\r\n\r\n").ok_or("malformed reply from the other bench")?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("malformed reply from the other bench")?;
    Ok((status, serde_json::from_str(payload.trim()).unwrap_or(Value::Null)))
}

/// Link to a host with the code it showed: get our key authorized with the
/// link secret, then redeem the pairing code for a gateway token, all over
/// the encrypted stream. Saves and returns the new peer.
pub async fn link(code: &str, device_name: &str) -> Result<Peer, String> {
    let code = LinkCode::decode(code)?;
    let relay = super::normalize_url(&code.r)?;
    let secret = code.secret()?;
    let me = super::identity()?;
    let stream = dial(&relay, &code.i, &me, Some(&secret)).await?;
    let (status, reply) = http_json(
        stream,
        "POST",
        "/api/pair",
        &json!({ "code": code.c, "deviceName": device_name, "kind": "bench" }),
    )
    .await?;
    if status != 200 {
        return Err(reply["error"]
            .as_str()
            .unwrap_or("the other bench refused the pairing code")
            .to_string());
    }
    let token = reply["token"].as_str().ok_or("no token in the pairing reply")?;
    let machine = reply["machine"].as_str().unwrap_or(&code.m).to_string();
    super::remember(Peer {
        name: String::new(),
        machine,
        relay,
        id: code.i,
        token: token.to_string(),
        linked_at: super::now_ms(),
    })
}

/// Listen on a loopback port and carry each connection to `peer`'s gateway
/// over its own encrypted relay stream. Returns the port; the task runs
/// until the returned handle is aborted.
pub async fn forward_local(peer: Peer) -> Result<(u16, tokio::task::JoinHandle<()>), String> {
    let me = Arc::new(super::identity()?);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let peer = Arc::new(peer);
    let task = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let (me, peer) = (me.clone(), peer.clone());
            tokio::spawn(async move {
                match dial(&peer.relay, &peer.id, &me, None).await {
                    Ok(mut pipe) => {
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut pipe).await;
                    }
                    Err(e) => eprintln!("relay: cannot reach {}: {e}", peer.machine),
                }
            });
        }
    });
    Ok((port, task))
}

/// Run `command` on `peer` through its default shell, like `ssh host
/// command`: this process's stdin feeds the command's, its stdout and
/// stderr come back on ours, and the return value is its exit code.
pub async fn exec(peer: &Peer, command: &str) -> Result<i32, String> {
    let me = super::identity()?;
    let pipe = dial(&peer.relay, &peer.id, &me, None).await?;
    let request = {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut r = "ws://bench/api/build/exec"
            .into_client_request()
            .map_err(|e| e.to_string())?;
        r.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            format!("bearer, {}", peer.token).parse().map_err(|_| "bad token")?,
        );
        r
    };
    let (ws, _) = tokio_tungstenite::client_async(request, pipe)
        .await
        .map_err(|e| match e.to_string() {
            s if s.contains("401") => format!("{} no longer accepts this bench's token — link it again", peer.machine),
            s if s.contains("403") => format!("{} refused: only linked benches may run build commands", peer.machine),
            s => s,
        })?;
    let (mut sink, mut stream) = ws.split();
    sink.send(Message::Text(json!({ "command": command }).to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    // stdin on a plain thread: a blocking read of a pipe or terminal has no
    // business on the async runtime.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Option<Vec<u8>>>(16);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin();
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.blocking_send(None);
                    return;
                }
                Ok(n) => {
                    if tx.blocking_send(Some(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
    });
    let mut stdin_open = true;
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    loop {
        tokio::select! {
            chunk = rx.recv(), if stdin_open => {
                let msg = match chunk {
                    Some(Some(bytes)) => Message::Binary(bytes.into()),
                    _ => {
                        stdin_open = false;
                        Message::Text(json!({ "eof": true }).to_string().into())
                    }
                };
                if sink.send(msg).await.is_err() {
                    return Err("the connection to the other bench dropped".into());
                }
            }
            msg = stream.next() => {
                use std::io::Write;
                match msg {
                    Some(Ok(Message::Binary(b))) if !b.is_empty() => {
                        let out: &mut dyn Write = if b[0] == 2 { &mut stderr } else { &mut stdout };
                        let _ = out.write_all(&b[1..]);
                        let _ = out.flush();
                    }
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                        if let Some(code) = v["exit"].as_i64() {
                            return Ok(code as i32);
                        }
                        if let Some(e) = v["error"].as_str() {
                            return Err(e.to_string());
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => return Err("the connection to the other bench dropped".into()),
                }
            }
        }
    }
}
