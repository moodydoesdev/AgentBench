//! agentbench-relay — lets benches on different networks reach each other.
//! See `relay::server` for the protocol; it only ever forwards ciphertext.

const USAGE: &str = "\
agentbench-relay — meeting point for AgentBench benches on different networks

USAGE:
    agentbench-relay [--bind ADDR]

OPTIONS:
    --bind ADDR  Address to listen on. Default 0.0.0.0:8480, or 0.0.0.0:$PORT
                 when PORT is set. Put a TLS-terminating proxy (Caddy,
                 Traefik, nginx) in front so benches can use wss://.

The relay stores nothing and never sees plaintext: benches encrypt to each
other end to end, and a bench must prove it owns an id to listen under it.
";

#[tokio::main]
async fn main() {
    let mut bind: std::net::SocketAddr = format!(
        "0.0.0.0:{}",
        std::env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(8480)
    )
    .parse()
    .expect("default bind address");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return;
            }
            "-V" | "--version" => {
                println!("agentbench-relay {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--bind" => match args.next().and_then(|v| v.parse().ok()) {
                Some(b) => bind = b,
                None => {
                    eprintln!("--bind needs an address, e.g. 0.0.0.0:8480");
                    std::process::exit(2);
                }
            },
            other => {
                eprintln!("unknown argument: {other}\n\n{USAGE}");
                std::process::exit(2);
            }
        }
    }
    if let Err(e) = agentbench_lib::relay::server::run(bind).await {
        eprintln!("agentbench-relay: {e}");
        std::process::exit(1);
    }
}
