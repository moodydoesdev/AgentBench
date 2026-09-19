//! agentbench-broker: standalone daemon that owns the agent ptys so they
//! survive AgentBench app restarts. Protocol: newline-delimited JSON over
//! TCP on 127.0.0.1; every connection receives all events, requests are
//! answered in order on the same connection.
//!
//! Run headless (a Linux VM, under systemd) with `--listen`. The protocol has
//! no authentication of its own and `create` takes a command line, so reaching
//! this port is equivalent to a shell on the box: keep it on loopback and let
//! SSH or Tailscale be the boundary. See `--help`.

use agentbench_lib::broker::{self, Core};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc};

const USAGE: &str = "\
agentbench-broker — owns the agent ptys so they outlive the desktop app

USAGE:
    agentbench-broker [--listen ADDR]

OPTIONS:
    --listen ADDR    Address to bind. Default 127.0.0.1:0 (ephemeral port).
                     Accepts HOST:PORT or a bare PORT.
                     Env: AGENTBENCH_BROKER_LISTEN
    -h, --help       Print this help
    -V, --version    Print version

SECURITY:
    The protocol is unauthenticated and the `create` op runs a command line,
    so anything that can reach this port can run code as you. Bind loopback
    and reach it over `ssh -L` or a tailnet. Never expose it to the internet.
";

/// `--listen` accepts `HOST:PORT` or a bare `PORT`, so `--listen 8317` does
/// the obvious thing rather than failing a SocketAddr parse.
fn normalize_listen(raw: &str) -> String {
    let raw = raw.trim();
    if raw.parse::<u16>().is_ok() {
        format!("127.0.0.1:{raw}")
    } else {
        raw.to_string()
    }
}

fn main() {
    let mut listen = std::env::var("AGENTBENCH_BROKER_LISTEN")
        .ok()
        .map(|s| normalize_listen(&s))
        .unwrap_or_else(|| "127.0.0.1:0".to_string());

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return;
            }
            "-V" | "--version" => {
                println!("agentbench-broker {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--listen" => match args.next() {
                Some(v) => listen = normalize_listen(&v),
                None => {
                    eprintln!("--listen needs an address");
                    std::process::exit(2);
                }
            },
            other => {
                eprintln!("unknown argument: {other}\n\n{USAGE}");
                std::process::exit(2);
            }
        }
    }

    // Block the shutdown signals before anything spawns a thread, so every
    // thread inherits the mask and only our sigwait thread ever sees them.
    #[cfg(unix)]
    let sigset = block_shutdown_signals();

    let core = Core::new();
    let listener = match TcpListener::bind(&listen) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("agentbench-broker: cannot bind {listen}: {e}");
            std::process::exit(1);
        }
    };
    let addr = listener.local_addr().expect("broker local_addr");
    let port = addr.port();

    std::fs::write(
        broker::broker_file(),
        serde_json::to_string_pretty(&json!({
            "port": port,
            "pid": std::process::id(),
            // Feature flags for clients newer than this broker: the daemon
            // survives app updates, so the gateway checks what this broker
            // can actually do rather than assuming its own vintage.
            "caps": ["write-ack", "pane-ready", "schedules"],
        }))
        .unwrap(),
    )
    .expect("write broker.json");

    #[cfg(unix)]
    spawn_signal_thread(core.clone(), sigset);

    eprintln!("agentbench-broker listening on {addr}");
    if !addr.ip().is_loopback() {
        eprintln!(
            "agentbench-broker: WARNING {} is not loopback and this protocol has no auth — \
             anything that reaches it can run code as you. Prefer loopback + ssh/tailscale.",
            addr.ip()
        );
    }

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let core = core.clone();
        std::thread::spawn(move || handle_client(core, stream));
    }
}

/// Block SIGTERM/SIGINT process-wide and hand back the set to sigwait on.
#[cfg(unix)]
fn block_shutdown_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    }
}

/// systemd stops a unit with SIGTERM. Without this the broker dies where it
/// stands, leaving a stale broker.json that the next client has to time out
/// against. Doing the work on a sigwait thread (rather than in a handler)
/// means the shutdown path is ordinary Rust and can reuse the `shutdown` op.
#[cfg(unix)]
fn spawn_signal_thread(core: Arc<Core>, set: libc::sigset_t) {
    std::thread::spawn(move || {
        let mut sig: libc::c_int = 0;
        if unsafe { libc::sigwait(&set, &mut sig) } != 0 {
            return;
        }
        eprintln!("agentbench-broker: signal {sig}, shutting down");
        broker::handle_request(&core, &json!({ "op": "shutdown" }));
        std::process::exit(0);
    });
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
