//! Remote exec for build hosts: run one command through this machine's
//! default shell, the way sshd does, and stream it over a WebSocket.
//!
//! This is what lets a linked bench — reached directly or through the relay —
//! be an `agentbench-build` host with no SSH server: the client's helper
//! speaks this protocol in place of `ssh host command`, so the build-host
//! kit, tar streams and all, runs unchanged.
//!
//! ```text
//! client → {"command": "..."}     then stdin as binary frames, then {"eof": true}
//! server → [1, bytes…] stdout     [2, bytes…] stderr     {"exit": code}
//! ```
//!
//! The command starts in the home directory, like an SSH session. Closing the
//! socket kills it.

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

fn shell(command: &str) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.arg("-c").arg(command);
        c
    }
    #[cfg(windows)]
    {
        // Verbatim, as Windows OpenSSH hands a command to cmd.exe: Rust's
        // argument quoting is for programs that parse argv, which cmd does not.
        let mut c = tokio::process::Command::new("cmd.exe");
        c.raw_arg(format!("/d /c {command}"));
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
}

pub async fn serve(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let command = match stream.next().await {
        Some(Ok(Message::Text(t))) => serde_json::from_str::<Value>(&t)
            .ok()
            .and_then(|v| v["command"].as_str().map(String::from)),
        _ => None,
    };
    let Some(command) = command.filter(|c| !c.trim().is_empty()) else {
        let _ = sink
            .send(Message::Text(json!({ "error": "no command" }).to_string().into()))
            .await;
        return;
    };

    let mut cmd = shell(&command);
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    for k in crate::broker::CLAUDE_SESSION_ENV {
        cmd.env_remove(k);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = sink
                .send(Message::Text(json!({ "error": format!("cannot start a shell: {e}") }).to_string().into()))
                .await;
            return;
        }
    };

    // stdout and stderr each read on their own task into one ordered outbox.
    let (tx, mut outbox) = mpsc::channel::<Vec<u8>>(32);
    for (tag, pipe) in [
        (1u8, child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
        (2u8, child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
    ] {
        let Some(mut pipe) = pipe else { continue };
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match pipe.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut frame = Vec::with_capacity(n + 1);
                        frame.push(tag);
                        frame.extend_from_slice(&buf[..n]);
                        if tx.send(frame).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(tx);

    let mut stdin = child.stdin.take();
    let mut outputs_open = true;
    loop {
        tokio::select! {
            frame = outbox.recv(), if outputs_open => match frame {
                Some(f) => {
                    if sink.send(Message::Binary(f.into())).await.is_err() {
                        return; // client gone: kill_on_drop ends the command
                    }
                }
                None => outputs_open = false,
            },
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    if let Some(i) = stdin.as_mut() {
                        if i.write_all(&b).await.is_err() {
                            stdin = None;
                        }
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    if serde_json::from_str::<Value>(&t).ok().and_then(|v| v["eof"].as_bool()) == Some(true) {
                        stdin = None; // dropping the pipe is EOF for the command
                    }
                }
                Some(Ok(_)) => {}
                _ => return,
            },
            status = child.wait(), if !outputs_open => {
                let code = status.ok().and_then(|s| s.code()).unwrap_or(1);
                let _ = sink.send(Message::Text(json!({ "exit": code }).to_string().into())).await;
                let _ = sink.send(Message::Close(None)).await;
                return;
            }
        }
    }
}
