//! The AgentBench relay: benches on different networks reach each other
//! through a server both of them dial out to, so neither needs an open port,
//! a tunnel or a VPN.
//!
//! ```text
//!   Mac (client) ──wss──▶ relay ◀──wss── PC (host, its gateway)
//!        └──────── end-to-end encrypted (crypto.rs) ────────┘
//! ```
//!
//! - `server` is the relay itself (`agentbench-relay`): it pairs a client
//!   socket with a socket from the host it asked for, and copies frames
//!   between them. It only ever sees ciphertext.
//! - `host` runs inside a bench's gateway. It keeps a listening connection
//!   open, accepts streams, and hands each decrypted stream to the gateway's
//!   own HTTP port, so everything that works on a linked bench works through
//!   the relay unchanged, bearer tokens included.
//! - `client` dials a host. The desktop forwards a local port through it, so
//!   a relayed bench looks like any other at `http://127.0.0.1:<port>`; the
//!   `agentbench-build` CLI dials it directly to run build commands.
//!
//! Linking: the host mints a link code holding the relay URL, its id, a
//! one-time 256-bit secret and an ordinary gateway pairing code. The client
//! uses the secret to get its key authorized, then redeems the pairing code
//! over the now-encrypted stream for a bearer token, exactly as a phone does.

pub mod client;
pub mod crypto;
pub mod host;
pub mod server;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;

/// Any byte stream we can run a WebSocket over: plain TCP, TLS, or an
/// encrypted relay pipe.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

pub type Ws = WebSocketStream<Box<dyn Io>>;

/// This machine's relay keys, shared by the gateway (as a host) and the
/// desktop and CLI (as a client).
pub fn identity() -> Result<crypto::Identity, String> {
    crypto::Identity::load_or_create(&crate::broker::config_dir().join("relay-identity.json"))
}

/// Normalise a relay address to its base `wss://host[:port]` form. A bare
/// host gets wss; ws:// is allowed for a relay on a trusted network.
pub fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://").unwrap_or(("wss", url));
    let scheme = match scheme {
        "wss" | "https" => "wss",
        "ws" | "http" => "ws",
        _ => return Err("a relay address looks like relay.example.com or wss://relay.example.com".into()),
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() || rest.contains(char::is_whitespace) || rest.contains(['?', '#']) {
        return Err("a relay address looks like relay.example.com".into());
    }
    Ok(format!("{scheme}://{rest}"))
}

/// Open a WebSocket to `url` (ws:// or wss://), verifying TLS against the
/// public web roots, with optional extra headers.
pub async fn connect_ws(url: &str, protocols: Option<&str>) -> Result<Ws, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = url.into_client_request().map_err(|e| format!("{url}: {e}"))?;
    if let Some(p) = protocols {
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", p.parse().map_err(|_| "bad protocol header")?);
    }
    let uri = request.uri().clone();
    let host = uri.host().ok_or("relay address has no host")?.to_string();
    let tls = uri.scheme_str() == Some("wss");
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| format!("timed out reaching {host}:{port}"))?
    .map_err(|e| format!("cannot reach {host}:{port}: {e}"))?;
    let _ = tcp.set_nodelay(true);
    let io: Box<dyn Io> = if tls {
        use tokio_rustls::rustls;
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|_| format!("bad relay host name {host}"))?;
        let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
            .map_err(|e| format!("TLS to {host} failed: {e}"))?;
        Box::new(stream)
    } else {
        Box::new(tcp)
    };
    let (ws, _) = tokio_tungstenite::client_async(request, io)
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    Ok(ws)
}

/// What a link code carries. Shown once on the host, pasted once on the
/// client, and useless after ten minutes or one use.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkCode {
    /// relay base URL
    pub r: String,
    /// host's relay id
    pub i: String,
    /// link secret, base64url
    pub k: String,
    /// gateway pairing code
    pub c: String,
    /// host's machine name, for display
    pub m: String,
}

const LINK_PREFIX: &str = "abr1.";

impl LinkCode {
    pub fn encode(&self) -> String {
        use base64::Engine;
        let json = serde_json::to_vec(self).expect("link code serializes");
        format!(
            "{LINK_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }

    pub fn decode(code: &str) -> Result<LinkCode, String> {
        use base64::Engine;
        let body = code
            .trim()
            .strip_prefix(LINK_PREFIX)
            .ok_or("that is not an AgentBench relay link code (they start with abr1.)")?;
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body.trim())
            .map_err(|_| "the link code is incomplete — copy all of it")?;
        let code: LinkCode =
            serde_json::from_slice(&json).map_err(|_| "the link code is damaged")?;
        normalize_url(&code.r)?;
        Ok(code)
    }

    pub fn secret(&self) -> Result<crypto::LinkSecret, String> {
        use base64::Engine;
        let psk: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&self.k)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or("the link code is damaged")?;
        Ok(crypto::LinkSecret::from_psk(psk))
    }
}

/// A bench this machine has linked to through a relay.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Peer {
    /// Short stable name used in `bench:<name>` build hosts.
    pub name: String,
    pub machine: String,
    pub relay: String,
    pub id: String,
    /// Bearer token for the host's gateway. This file is owner-only.
    pub token: String,
    pub linked_at: u64,
}

fn peers_file() -> PathBuf {
    crate::broker::config_dir().join("relay-peers.json")
}

pub fn peers() -> Vec<Peer> {
    std::fs::read_to_string(peers_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_peers(peers: &[Peer]) -> Result<(), String> {
    let path = peers_file();
    let _ = std::fs::create_dir_all(crate::broker::config_dir());
    let text = serde_json::to_string_pretty(peers).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn peer(name: &str) -> Option<Peer> {
    peers().into_iter().find(|p| p.name == name)
}

/// Save a newly linked peer, replacing any earlier link to the same host.
pub fn remember(mut peer: Peer) -> Result<Peer, String> {
    let mut all = peers();
    all.retain(|p| p.id != peer.id);
    let base = slug(&peer.machine);
    let mut name = base.clone();
    let mut n = 2;
    while all.iter().any(|p| p.name == name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    peer.name = name;
    all.push(peer.clone());
    save_peers(&all)?;
    Ok(peer)
}

pub fn forget(name: &str) -> Result<(), String> {
    let mut all = peers();
    all.retain(|p| p.name != name);
    save_peers(&all)
}

/// A machine name as a short identifier: `Connor's PC` → `connors-pc`.
pub fn slug(machine: &str) -> String {
    let mut out = String::new();
    for c in machine.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if (c == ' ' || c == '-' || c == '_' || c == '.') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').chars().take(32).collect::<String>();
    if out.is_empty() { "bench".into() } else { out }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_urls_normalise() {
        assert_eq!(normalize_url("relay.example.com").unwrap(), "wss://relay.example.com");
        assert_eq!(normalize_url("https://relay.example.com/").unwrap(), "wss://relay.example.com");
        assert_eq!(normalize_url("ws://10.0.0.5:8480").unwrap(), "ws://10.0.0.5:8480");
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("wss://").is_err());
    }

    #[test]
    fn link_codes_round_trip() {
        let secret = crypto::LinkSecret::generate();
        use base64::Engine;
        let code = LinkCode {
            r: "wss://relay.example.com".into(),
            i: "abc".into(),
            k: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret.psk),
            c: "1234-5678".into(),
            m: "Distraction".into(),
        };
        let text = code.encode();
        assert!(text.starts_with("abr1."));
        let back = LinkCode::decode(&format!("  {text}\n")).unwrap();
        assert_eq!(back, code);
        assert_eq!(back.secret().unwrap().id, secret.id);
        assert!(LinkCode::decode("abr1.%%%").is_err());
        assert!(LinkCode::decode("hello").is_err());
    }

    #[test]
    fn machine_names_become_slugs() {
        assert_eq!(slug("Connor's PC"), "connors-pc");
        assert_eq!(slug("Distraction"), "distraction");
        assert_eq!(slug("  --  "), "bench");
    }
}
