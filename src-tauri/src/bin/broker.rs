//! agentbench-broker: standalone daemon that owns the agent ptys so they
//! survive AgentBench app restarts. Protocol: newline-delimited JSON over
//! TCP on 127.0.0.1; every connection receives all events, requests are
//! answered in order on the same connection.

use agentbench_lib::broker::{self, Core};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc};

fn main() {
    let core = Core::new();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind broker");
    let port = listener.local_addr().unwrap().port();

    std::fs::write(
        broker::broker_file(),
        serde_json::to_string_pretty(&json!({
            "port": port,
            "pid": std::process::id(),
        }))
        .unwrap(),
    )
    .expect("write broker.json");

    eprintln!("agentbench-broker listening on 127.0.0.1:{port}");

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let core = core.clone();
        std::thread::spawn(move || handle_client(core, stream));
    }
}

fn handle_client(core: Arc<Core>, stream: TcpStream) {
    let reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    // single writer thread per connection; events and responses both flow
    // through the same channel so their bytes never interleave mid-line
    let (tx, rx) = mpsc::channel::<String>();
    {
        let mut out = stream;
        std::thread::spawn(move || {
            for line in rx {
                if out.write_all(line.as_bytes()).is_err() || out.write_all(b"\n").is_err() {
                    break;
                }
                let _ = out.flush();
            }
        });
    }

    // fan events out to this client
    let events = core.subscribe();
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in events {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.send(json!({ "error": format!("bad request: {e}") }).to_string());
                continue;
            }
        };
        if let Some(resp) = broker::handle_request(&core, &req) {
            let is_shutdown = resp["result"] == "bye";
            if tx.send(resp.to_string()).is_err() {
                break;
            }
            if is_shutdown {
                // Give the reply time to flush, then exit the process.
                // Other threads (listener, pty readers) hold the process
                // alive, so process::exit is the clean way out.
                std::thread::sleep(std::time::Duration::from_millis(100));
                std::process::exit(0);
            }
        }
    }
    // client gone; its subscriber entry is dropped on next broadcast
}
