//! Dev-server previews: make a loopback dev server reachable from a paired
//! phone, without asking every framework to bind 0.0.0.0.
//!
//! One preview = one public port forwarding to one 127.0.0.1 port. The proxy
//! authenticates the FIRST request of each TCP connection — a handshake URL
//! sets a per-preview secret cookie, and connections carrying that cookie are
//! spliced through raw (`copy_bidirectional`). Splicing keeps the proxy
//! protocol-transparent: Vite's HMR websocket, streaming responses and
//! keep-alive all pass untouched, and no HTTP library is involved. A dev
//! server serves the project's source, so unlike the gateway's static shell
//! these ports refuse strangers: anything without the cookie gets a 403 page.
//!
//! The Host header the dev server sees is the phone's `ip:port`. That is
//! deliberate — IP-literal hosts pass the default host checks of Vite,
//! webpack-dev-server and Rails, so no per-project allowedHosts config is
//! needed (a hostname would trip them, which is why preview URLs always use
//! an IP).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::tokens;

/// Public ports previews may claim. A fixed range (rather than ephemeral)
/// keeps URLs recognizable and gives anyone tightening a firewall something
/// concrete to allow.
const PORT_RANGE: std::ops::Range<u16> = 8600..8640;

/// The cookie-setting handshake path. Weird on purpose: no dev server routes
/// it, so it can be answered by the proxy without shadowing anything real.
/// Shared with site previews (rewrite.rs), which answer it the same way.
pub const HANDSHAKE_PATH: &str = "/__abpv";

/// A request head larger than this is nobody's dev server.
const MAX_HEAD: usize = 32 * 1024;

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(600);

/// What one preview is, beyond the shared port/secret/cwd plumbing.
enum Mode {
    /// Transparent TCP splice to a loopback port — the default.
    Splice { target: u16 },
    /// HTTP-aware rewriting proxy for a hostname-addressed app (rewrite.rs).
    Site {
        origin: String,
        /// loopback port upstream (artisan serve); None means vhost
        upstream_port: Option<u16>,
        /// the port liveness is probed on — the upstream port, or 443/80
        probe_port: u16,
        /// target port of the auto-started companion Vite splice
        companion_target: Option<u16>,
        companion_public: Option<u16>,
    },
}

/// How previews are keyed: a splice by its target port, a site by its origin.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Port(u16),
    Site(String),
}

struct Entry {
    public_port: u16,
    secret: String,
    cwd: String,
    task: tokio::task::JoinHandle<()>,
    mode: Mode,
}

/// Live previews. In-memory only: a gateway restart drops every proxy, which
/// is the fail-safe direction.
pub struct Previews {
    inner: Mutex<HashMap<Key, Entry>>,
}

impl Previews {
    pub fn new() -> Previews {
        Previews {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Start (or return the existing) preview for `target`. Fails when nothing
    /// answers on the target port — a proxy to a dead server helps nobody.
    pub async fn start(&self, cwd: &str, target: u16) -> Result<Value, String> {
        if target == 0 {
            return Err("no port given".into());
        }
        if !probe(target).await {
            return Err(format!(
                "nothing is listening on 127.0.0.1:{target} — is the dev server running?"
            ));
        }
        let key = Key::Port(target);
        if let Some(info) = self.info_for(&key) {
            return Ok(info);
        }

        let (public_port, listener) = self.claim_port().await?;
        let secret = tokens::random_token();
        let task = tokio::spawn(serve(listener, target, public_port, secret.clone()));
        let entry = Entry {
            public_port,
            secret,
            cwd: cwd.to_string(),
            task,
            mode: Mode::Splice { target },
        };
        self.insert(key, entry)
    }

    /// Start (or return the existing) site preview: an HTTP-aware proxy that
    /// rewrites the origin's absolute URLs (see rewrite.rs). The upstream is a
    /// loopback port when given (php artisan serve), otherwise the vhost the
    /// origin names — 443 preferred, Herd secures sites by default.
    pub async fn start_site(
        &self,
        cwd: &str,
        origin: &str,
        upstream_hint: Option<u16>,
    ) -> Result<Value, String> {
        let origin = origin.trim().trim_end_matches('/').to_lowercase();
        let (scheme, host_port) = origin
            .split_once("://")
            .ok_or("site origin must be a full URL, e.g. http://app.test")?;
        let hostname = host_port.split(':').next().unwrap_or(host_port).to_string();
        // Only names that cannot be real internet hosts — the Herd/Valet TLDs.
        if !hostname.ends_with(".test") && !hostname.ends_with(".localhost") {
            return Err(format!("{hostname} is not a .test or .localhost site"));
        }
        let key = Key::Site(origin.clone());
        if let Some(info) = self.info_for(&key) {
            return Ok(info);
        }

        // Resolve the upstream before claiming anything.
        let (upstream, upstream_port, probe_port) = if let Some(p) = upstream_hint {
            if !probe(p).await {
                return Err(format!(
                    "nothing is listening on 127.0.0.1:{p} — is the app server running?"
                ));
            }
            (super::rewrite::Upstream::Port(p), Some(p), p)
        } else {
            let explicit: Option<u16> = host_port.split_once(':').and_then(|(_, p)| p.parse().ok());
            let vhost = |scheme: &'static str, port: u16| {
                let base = match explicit {
                    Some(p) => format!("{scheme}://{hostname}:{p}"),
                    None => format!("{scheme}://{hostname}"),
                };
                (
                    super::rewrite::Upstream::Vhost { host: hostname.clone(), base },
                    None,
                    port,
                )
            };
            if let Some(p) = explicit {
                if !probe(p).await {
                    return Err(format!("nothing is serving {origin} on this machine"));
                }
                vhost(if scheme == "https" { "https" } else { "http" }, p)
            } else if probe(443).await {
                vhost("https", 443)
            } else if probe(80).await {
                vhost("http", 80)
            } else {
                return Err(format!(
                    "nothing is serving {hostname} here — start the app server (or a vhost) first"
                ));
            }
        };

        // Companion Vite splice, so assets and HMR work: laravel-vite-plugin
        // writes its dev-server origin to public/hot while `npm run dev` runs.
        let mut companion = None;
        let mut companion_target = None;
        if let Some((vite_origin, vite_port)) = read_hot(cwd) {
            if probe(vite_port).await {
                let info = self.start(cwd, vite_port).await?;
                companion = Some(super::rewrite::Companion {
                    origin: vite_origin,
                    public_port: info["publicPort"].as_u64().unwrap_or(0) as u16,
                    secret: info["secret"].as_str().unwrap_or_default().to_string(),
                });
                companion_target = Some(vite_port);
            }
        }
        let companion_public = companion.as_ref().map(|c| c.public_port);

        // Both schemes of the site origin — APP_URL may say http while a
        // secured app emits https links — plus the loopback spellings a
        // port upstream echoes into the page.
        let mut own_origins = vec![
            format!("http://{host_port}"),
            format!("https://{host_port}"),
        ];
        if let Some(p) = upstream_port {
            own_origins.push(format!("http://127.0.0.1:{p}"));
            own_origins.push(format!("http://localhost:{p}"));
            own_origins.push(format!("http://[::1]:{p}"));
        }

        let (public_port, listener) = self.claim_port().await?;
        let secret = tokens::random_token();
        let client = super::rewrite::client_for(&upstream)?;
        let ctx = std::sync::Arc::new(super::rewrite::SiteCtx {
            public_port,
            secret: secret.clone(),
            own_origins,
            companion,
            upstream,
            client,
        });
        let task = tokio::spawn(super::rewrite::serve(listener, ctx));
        let entry = Entry {
            public_port,
            secret,
            cwd: cwd.to_string(),
            task,
            mode: Mode::Site {
                origin,
                upstream_port,
                probe_port,
                companion_target,
                companion_public,
            },
        };
        self.insert(key, entry)
    }

    /// The next free public port with its listener. Held entries are checked
    /// too, so a released OS port we still track is not double-claimed.
    async fn claim_port(&self) -> Result<(u16, TcpListener), String> {
        let held: Vec<u16> = self
            .inner
            .lock()
            .unwrap()
            .values()
            .map(|e| e.public_port)
            .collect();
        for port in PORT_RANGE {
            if held.contains(&port) {
                continue;
            }
            if let Ok(l) = TcpListener::bind(("0.0.0.0", port)).await {
                return Ok((port, l));
            }
        }
        Err("no free preview port (are 40 previews really running?)".into())
    }

    /// Insert unless a racing start won; either way, answer with the entry
    /// that ended up live. The loser's listener is dropped with its task.
    fn insert(&self, key: Key, entry: Entry) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(existing) = inner.get(&key) {
            entry.task.abort();
            return Ok(info_json(existing));
        }
        let info = info_json(&entry);
        inner.insert(key, entry);
        Ok(info)
    }

    pub fn stop(&self, key: &Key) -> Value {
        let mut inner = self.inner.lock().unwrap();
        let removed = inner.remove(key);
        if let Some(entry) = &removed {
            entry.task.abort();
            // a site's companion Vite splice lives and dies with it
            if let Mode::Site { companion_target: Some(t), .. } = entry.mode {
                if let Some(c) = inner.remove(&Key::Port(t)) {
                    c.task.abort();
                }
            }
        }
        json!({ "ok": removed.is_some() })
    }

    /// Every live preview, with a fresh probe of each upstream so the sheet
    /// can say "the server behind this one is gone".
    pub async fn list(&self) -> Value {
        let snapshot: Vec<(u16, Value)> = self
            .inner
            .lock()
            .unwrap()
            .values()
            .map(|e| {
                let probe_port = match &e.mode {
                    Mode::Splice { target } => *target,
                    Mode::Site { probe_port, .. } => *probe_port,
                };
                (probe_port, info_json(e))
            })
            .collect();
        let mut out = Vec::with_capacity(snapshot.len());
        for (probe_port, mut info) in snapshot {
            info["live"] = json!(probe(probe_port).await);
            out.push(info);
        }
        json!({ "previews": out, "hosts": hosts_off_thread().await })
    }

    fn info_for(&self, key: &Key) -> Option<Value> {
        self.inner.lock().unwrap().get(key).map(info_json)
    }
}

fn info_json(e: &Entry) -> Value {
    let mut info = json!({
        "publicPort": e.public_port,
        "secret": e.secret,
        "cwd": e.cwd,
        "handshakePath": HANDSHAKE_PATH,
    });
    match &e.mode {
        Mode::Splice { target } => {
            info["kind"] = json!("port");
            info["targetPort"] = json!(target);
        }
        Mode::Site { origin, upstream_port, companion_public, companion_target, .. } => {
            info["kind"] = json!("site");
            info["origin"] = json!(origin);
            if let Some(p) = upstream_port {
                info["targetPort"] = json!(p);
            }
            if let Some(p) = companion_public {
                info["companionPort"] = json!(p);
            }
            if let Some(p) = companion_target {
                info["companionTarget"] = json!(p);
            }
        }
    }
    info
}

pub fn cookie_name(public_port: u16) -> String {
    format!("abpv_{public_port}")
}

/// Host discovery shells out to tailscale/powershell; keep that off the
/// async runtime's worker threads.
pub async fn hosts_off_thread() -> Value {
    tokio::task::spawn_blocking(|| json!(super::net::preview_hosts()))
        .await
        .unwrap_or_else(|_| json!([]))
}

/// Whether anything accepts on 127.0.0.1:port right now.
pub async fn probe(port: u16) -> bool {
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(("127.0.0.1", port))).await,
        Ok(Ok(_))
    )
}

async fn serve(listener: TcpListener, target: u16, public_port: u16, secret: String) {
    loop {
        let Ok((sock, _)) = listener.accept().await else {
            return;
        };
        let secret = secret.clone();
        tokio::spawn(async move {
            let _ = handle(sock, target, public_port, &secret).await;
        });
    }
}

/// One phone connection: authenticate the first request head, then get out of
/// the way.
async fn handle(
    mut sock: TcpStream,
    target: u16,
    public_port: u16,
    secret: &str,
) -> std::io::Result<()> {
    sock.set_nodelay(true).ok();

    // Read until the end of the first request's headers. Body bytes that
    // arrive in the same chunks are kept and forwarded verbatim.
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let head_len = loop {
        let mut chunk = [0u8; 4096];
        let n = match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            sock.read(&mut chunk),
        )
        .await
        {
            Ok(Ok(n)) => n,
            _ => return Ok(()), // slow loris or dead socket — just drop it
        };
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(len) = head_end(&buf) {
            break len;
        }
        if buf.len() > MAX_HEAD {
            return refuse(sock, "413 Content Too Large", "Request too large.").await;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_len]).into_owned();

    // The handshake: /__abpv?t=<secret> sets the cookie and bounces to /.
    // The cookie name carries the public port because cookies are host-scoped,
    // not port-scoped — two previews on one machine must not clobber each
    // other's auth.
    if let Some(path) = request_path(&head).filter(|p| p.starts_with(HANDSHAKE_PATH)) {
        if query_param(path, "t").as_deref() == Some(secret) {
            let cookie = format!(
                "{}={secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200",
                cookie_name(public_port)
            );
            let resp = format!(
                "HTTP/1.1 302 Found\r\nLocation: /\r\nSet-Cookie: {cookie}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            sock.write_all(resp.as_bytes()).await?;
            return Ok(());
        }
        return refuse(sock, "403 Forbidden", "Bad or expired preview link.").await;
    }

    if cookie_value(&head, &cookie_name(public_port)).as_deref() != Some(secret) {
        return refuse(
            sock,
            "403 Forbidden",
            "This is an AgentBench dev-server preview. Open it from the AgentBench app on a paired phone.",
        )
        .await;
    }

    let mut upstream = match TcpStream::connect(("127.0.0.1", target)).await {
        Ok(s) => s,
        Err(_) => {
            return refuse(
                sock,
                "502 Bad Gateway",
                &format!("Nothing is listening on port {target} any more — the dev server may have stopped."),
            )
            .await;
        }
    };
    upstream.set_nodelay(true).ok();
    upstream.write_all(&buf).await?;
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
    Ok(())
}

async fn refuse(mut sock: TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = format!(
        "<!doctype html><meta name=viewport content=\"width=device-width\"><title>AgentBench preview</title><body style=\"font-family:system-ui;padding:40px 24px;max-width:32em\"><h3>AgentBench</h3><p>{message}</p></body>"
    );
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes()).await
}

/// Index just past the first blank line, if the headers are complete.
fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// The request-target out of "GET /path HTTP/1.1".
fn request_path(head: &str) -> Option<&str> {
    head.lines().next()?.split_whitespace().nth(1)
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// Value of one cookie out of the request head, if present.
fn cookie_value(head: &str, name: &str) -> Option<String> {
    for line in head.lines() {
        let Some((header, rest)) = line.split_once(':') else {
            continue;
        };
        if !header.eq_ignore_ascii_case("cookie") {
            continue;
        }
        for pair in rest.split(';') {
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Loopback dev-server ports mentioned in terminal output — what vite, next,
/// astro and friends print when they boot. Most recent mention first: the
/// server that just started is the one being previewed.
pub fn detect_ports(text: &str) -> Vec<u16> {
    const HOSTS: &[&str] = &["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:", "[::]:"];
    let mut found: Vec<u16> = Vec::new();
    for host in HOSTS {
        let mut rest = text;
        while let Some(at) = rest.find(host) {
            let after = &rest[at + host.len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            rest = &after[digits.len()..];
            if digits.is_empty() || digits.len() > 5 {
                continue;
            }
            if let Ok(port) = digits.parse::<u16>() {
                if port != 0 {
                    // last mention wins the ordering
                    found.retain(|p| *p != port);
                    found.push(port);
                }
            }
        }
    }
    found.reverse();
    found
}

/// `.test` / `.localhost` origins mentioned in terminal output — what Herd,
/// Valet and laravel-vite-plugin print (`APP_URL: http://dashboard.mgx.test`).
/// Most recent mention first, like `detect_ports`.
pub fn detect_site_origins(text: &str) -> Vec<String> {
    // matches carry their offset so http:// and https:// hits interleave in
    // true text order before "last mention wins" is applied
    let mut hits: Vec<(usize, String)> = Vec::new();
    for scheme in ["http://", "https://"] {
        let mut pos = 0;
        while let Some(at) = text[pos..].find(scheme) {
            let start = pos + at;
            let after = &text[start + scheme.len()..];
            let host: String = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
                .collect();
            pos = start + scheme.len() + host.len();
            let host = host.to_lowercase();
            if !host.ends_with(".test") && !host.ends_with(".localhost") {
                continue;
            }
            let port: String = text[pos..]
                .strip_prefix(':')
                .map(|r| r.chars().take_while(|c| c.is_ascii_digit()).collect())
                .unwrap_or_default();
            let origin = if port.is_empty() {
                format!("{scheme}{host}")
            } else {
                format!("{scheme}{host}:{port}")
            };
            hits.push((start, origin));
        }
    }
    hits.sort_by_key(|(at, _)| *at);
    let mut found: Vec<String> = Vec::new();
    for (_, origin) in hits {
        // last mention wins the ordering
        found.retain(|o| *o != origin);
        found.push(origin);
    }
    found.reverse();
    found
}

/// APP_URL from the project's .env, when it names a `.test`/`.localhost`
/// site — the strongest signal that this project is served by hostname.
pub fn read_env_app_url(cwd: &str) -> Option<String> {
    let text = std::fs::read_to_string(std::path::Path::new(cwd).join(".env")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        let Some(value) = line.strip_prefix("APP_URL=") else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'').trim_end_matches('/');
        let origin = value.to_lowercase();
        let host = origin.split_once("://")?.1;
        let hostname = host.split(':').next().unwrap_or(host);
        if hostname.ends_with(".test") || hostname.ends_with(".localhost") {
            return Some(origin);
        }
        return None;
    }
    None
}

/// The Vite dev-server origin from the project's `public/hot` file, which
/// laravel-vite-plugin writes while `npm run dev` runs and deletes on exit.
pub fn read_hot(cwd: &str) -> Option<(String, u16)> {
    let text = std::fs::read_to_string(std::path::Path::new(cwd).join("public").join("hot")).ok()?;
    let origin = text.trim().trim_end_matches('/').to_string();
    if !origin.starts_with("http://") && !origin.starts_with("https://") {
        return None;
    }
    let port: u16 = origin.rsplit_once(':')?.1.parse().ok()?;
    Some((origin, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_parsing() {
        let head = "GET /__abpv?t=abc123 HTTP/1.1\r\nHost: 100.1.2.3:8600\r\nCookie: theme=dark; abpv_8600=s3cret\r\n\r\n";
        assert_eq!(head_end(head.as_bytes()), Some(head.len()));
        assert_eq!(request_path(head), Some("/__abpv?t=abc123"));
        assert_eq!(query_param("/__abpv?t=abc123", "t").as_deref(), Some("abc123"));
        assert_eq!(query_param("/__abpv", "t"), None);
        assert_eq!(
            cookie_value(head, "abpv_8600").as_deref(),
            Some("s3cret"),
        );
        assert_eq!(cookie_value(head, "abpv_8601"), None);
        assert_eq!(head_end(b"GET / HTTP/1.1\r\nHost: x"), None);
    }

    #[test]
    fn ports_are_scraped_from_dev_server_banners() {
        let vite = "\n  VITE v7.0.4  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n";
        assert_eq!(detect_ports(vite), vec![5173]);

        let several = "listening on http://127.0.0.1:3000\nlater: http://localhost:5173/ then again http://localhost:3000/api";
        // 3000 was mentioned last, so it leads
        assert_eq!(detect_ports(several), vec![3000, 5173]);

        assert!(detect_ports("no urls here, just localhost: and 1.2.3.4").is_empty());
        assert!(detect_ports("port zero http://localhost:0/").is_empty());
    }

    /// The whole life of a preview against a real socket: refuse a stranger,
    /// hand the handshake a cookie, splice an authed connection through to
    /// the dev server, and free the slot on stop.
    #[tokio::test]
    async fn proxy_end_to_end() {
        // a "dev server" that answers one canned response per connection
        let dev = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dev_port = dev.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = dev.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
                        .await;
                });
            }
        });

        let previews = Previews::new();
        let info = previews.start("A:\\proj", dev_port).await.unwrap();
        let public = info["publicPort"].as_u64().unwrap() as u16;
        let secret = info["secret"].as_str().unwrap().to_string();
        // starting again is idempotent, not a second port
        let again = previews.start("A:\\proj", dev_port).await.unwrap();
        assert_eq!(again["publicPort"], info["publicPort"]);

        let talk = |req: String| async move {
            let mut s = TcpStream::connect(("127.0.0.1", public)).await.unwrap();
            s.write_all(req.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            let _ = s.read_to_end(&mut out).await;
            String::from_utf8_lossy(&out).into_owned()
        };

        // stranger: no cookie
        let resp = talk("GET / HTTP/1.1\r\nHost: x\r\n\r\n".into()).await;
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
        // handshake with the wrong token
        let resp = talk(format!("GET {HANDSHAKE_PATH}?t=nope HTTP/1.1\r\nHost: x\r\n\r\n")).await;
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
        // handshake with the right token mints the cookie
        let resp =
            talk(format!("GET {HANDSHAKE_PATH}?t={secret} HTTP/1.1\r\nHost: x\r\n\r\n")).await;
        assert!(resp.starts_with("HTTP/1.1 302"), "{resp}");
        assert!(resp.contains(&format!("abpv_{public}={secret}")), "{resp}");
        // the cookie reaches the dev server
        let resp = talk(format!(
            "GET / HTTP/1.1\r\nHost: x\r\nCookie: abpv_{public}={secret}\r\n\r\n"
        ))
        .await;
        assert!(resp.ends_with("hello"), "{resp}");

        assert_eq!(previews.stop(&Key::Port(dev_port)), json!({ "ok": true }));
        assert_eq!(previews.stop(&Key::Port(dev_port)), json!({ "ok": false }));
        // a target that answers nothing must be refused up front
        assert!(previews.start("A:\\proj", 1).await.is_err());
    }

    #[test]
    fn site_origins_are_scraped_from_banners() {
        // what laravel-vite-plugin prints under Herd
        let vite = "\n  APP_URL: http://dashboard.mgx.test\n  ➜  Local: http://[::1]:5173/\n";
        assert_eq!(detect_site_origins(vite), vec!["http://dashboard.mgx.test"]);
        // last mention leads; ports and https survive; case folds
        let several = "old https://Api.Test:8443/x then http://app.test/login";
        assert_eq!(
            detect_site_origins(several),
            vec!["http://app.test", "https://api.test:8443"]
        );
        // real internet hosts never qualify
        assert!(detect_site_origins("see https://example.com and http://localhost:3000").is_empty());
    }

    #[test]
    fn env_and_hot_files_are_read() {
        let dir = std::env::temp_dir().join(format!("abpv-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("public")).unwrap();
        let cwd = dir.to_str().unwrap();

        std::fs::write(
            dir.join(".env"),
            "APP_NAME=Demo\nAPP_URL=\"http://Dashboard.mgx.test/\"\nAPP_KEY=x\n",
        )
        .unwrap();
        assert_eq!(
            read_env_app_url(cwd).as_deref(),
            Some("http://dashboard.mgx.test")
        );
        // a real domain in APP_URL is not a site candidate
        std::fs::write(dir.join(".env"), "APP_URL=https://example.com\n").unwrap();
        assert_eq!(read_env_app_url(cwd), None);

        std::fs::write(dir.join("public").join("hot"), "http://[::1]:5173\n").unwrap();
        assert_eq!(read_hot(cwd), Some(("http://[::1]:5173".into(), 5173)));
        std::fs::write(dir.join("public").join("hot"), "not a url").unwrap();
        assert_eq!(read_hot(cwd), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A site preview against a fake vhost-less upstream: handshake mints the
    /// cookie, absolute URLs and cookie scope come back rewritten, and stop
    /// frees the slot.
    #[tokio::test]
    async fn site_preview_rewrites_end_to_end() {
        let app = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let app_port = app.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = app.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 8192];
                    let _ = sock.read(&mut buf).await;
                    let body = r#"<a href="http://dashboard.mgx.test/login">go</a>"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: laravel_session=abc; Path=/; Domain=dashboard.mgx.test; Secure\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });

        let previews = Previews::new();
        // .com origins are refused outright
        assert!(previews
            .start_site("A:\\proj", "http://evil.com", Some(app_port))
            .await
            .is_err());
        let info = previews
            .start_site("A:\\proj", "http://dashboard.mgx.test", Some(app_port))
            .await
            .unwrap();
        assert_eq!(info["kind"], json!("site"));
        let public = info["publicPort"].as_u64().unwrap() as u16;
        let secret = info["secret"].as_str().unwrap().to_string();
        // idempotent per origin
        let again = previews
            .start_site("A:\\proj", "http://dashboard.mgx.test/", None)
            .await
            .unwrap();
        assert_eq!(again["publicPort"], info["publicPort"]);

        let talk = |req: String| async move {
            let mut s = TcpStream::connect(("127.0.0.1", public)).await.unwrap();
            s.write_all(req.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            let _ = s.read_to_end(&mut out).await;
            String::from_utf8_lossy(&out).into_owned()
        };

        // stranger: refused before anything reaches the app
        let resp = talk("GET / HTTP/1.1\r\nHost: 100.1.2.3\r\nConnection: close\r\n\r\n".into()).await;
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
        // handshake mints this preview's cookie
        let resp = talk(format!(
            "GET {HANDSHAKE_PATH}?t={secret} HTTP/1.1\r\nHost: 100.1.2.3\r\nConnection: close\r\n\r\n"
        ))
        .await;
        assert!(resp.starts_with("HTTP/1.1 302"), "{resp}");
        assert!(resp.contains(&format!("abpv_{public}={secret}")), "{resp}");
        // authed request: body URL rewritten to the address we came in by,
        // cookie descoped
        let resp = talk(format!(
            "GET / HTTP/1.1\r\nHost: 100.1.2.3:{public}\r\nCookie: abpv_{public}={secret}\r\nConnection: close\r\n\r\n"
        ))
        .await;
        assert!(
            resp.contains(&format!("http://100.1.2.3:{public}/login")),
            "{resp}"
        );
        assert!(!resp.contains("dashboard.mgx.test"), "{resp}");
        assert!(!resp.to_lowercase().contains("domain="), "{resp}");

        let key = Key::Site("http://dashboard.mgx.test".into());
        assert_eq!(previews.stop(&key), json!({ "ok": true }));
        assert_eq!(previews.stop(&key), json!({ "ok": false }));
    }

    /// Websockets ride the site leg too: the Upgrade handshake is forwarded,
    /// the upstream's 101 mirrored back, and bytes flow both ways after it.
    #[tokio::test]
    async fn site_preview_carries_websockets() {
        // an "app" that accepts any websocket handshake, then echoes bytes
        let app = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let app_port = app.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = app.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while head_end(&buf).is_none() {
                        let Ok(n) = sock.read(&mut chunk).await else { return };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let _ = sock
                        .write_all(
                            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummyaccept\r\n\r\n",
                        )
                        .await;
                    loop {
                        let Ok(n) = sock.read(&mut chunk).await else { return };
                        if n == 0 {
                            return;
                        }
                        if sock.write_all(&chunk[..n]).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });

        let previews = Previews::new();
        let info = previews
            .start_site("A:\\proj", "http://ws.mgx.test", Some(app_port))
            .await
            .unwrap();
        let public = info["publicPort"].as_u64().unwrap() as u16;
        let secret = info["secret"].as_str().unwrap();

        let mut s = TcpStream::connect(("127.0.0.1", public)).await.unwrap();
        s.write_all(
            format!(
                "GET /app HTTP/1.1\r\nHost: 100.1.2.3:{public}\r\nCookie: abpv_{public}={secret}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();

        // read the mirrored 101 head
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_len = loop {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), s.read(&mut chunk))
                .await
                .expect("101 in time")
                .unwrap();
            assert!(n > 0, "socket closed before the 101");
            buf.extend_from_slice(&chunk[..n]);
            if let Some(len) = head_end(&buf) {
                break len;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_len]).into_owned();
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        assert!(head.to_lowercase().contains("sec-websocket-accept: dummyaccept"), "{head}");

        // bytes after the handshake splice through and echo back
        s.write_all(b"frame-ish payload").await.unwrap();
        let mut got = buf[head_len..].to_vec();
        while got.len() < b"frame-ish payload".len() {
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), s.read(&mut chunk))
                .await
                .expect("echo in time")
                .unwrap();
            assert!(n > 0, "socket closed before the echo");
            got.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(&got, b"frame-ish payload");

        previews.stop(&Key::Site("http://ws.mgx.test".into()));
    }

    #[test]
    fn strangers_get_nothing_without_the_cookie() {
        // the auth decision is the pure part: no cookie, wrong cookie name
        // (another preview's port), wrong value — all must fail
        let secret = "s3cret";
        let ok = "GET / HTTP/1.1\r\nCookie: abpv_8600=s3cret\r\n\r\n";
        let wrong_port = "GET / HTTP/1.1\r\nCookie: abpv_8601=s3cret\r\n\r\n";
        let wrong_value = "GET / HTTP/1.1\r\nCookie: abpv_8600=guess\r\n\r\n";
        let none = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let name = cookie_name(8600);
        assert_eq!(cookie_value(ok, &name).as_deref(), Some(secret));
        assert_ne!(cookie_value(wrong_port, &name).as_deref(), Some(secret));
        assert_ne!(cookie_value(wrong_value, &name).as_deref(), Some(secret));
        assert_ne!(cookie_value(none, &name).as_deref(), Some(secret));
    }
}
