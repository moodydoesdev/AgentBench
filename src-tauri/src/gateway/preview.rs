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
const HANDSHAKE_PATH: &str = "/__abpv";

/// A request head larger than this is nobody's dev server.
const MAX_HEAD: usize = 32 * 1024;

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(600);

struct Entry {
    public_port: u16,
    secret: String,
    cwd: String,
    task: tokio::task::JoinHandle<()>,
}

/// Live previews, keyed by target (dev server) port. In-memory only: a
/// gateway restart drops every proxy, which is the fail-safe direction.
pub struct Previews {
    inner: Mutex<HashMap<u16, Entry>>,
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
        if let Some(info) = self.info_for(target) {
            return Ok(info);
        }

        let (public_port, listener) = {
            // ports other previews hold, so a released OS port that we still
            // track is not double-claimed
            let held: Vec<u16> = self
                .inner
                .lock()
                .unwrap()
                .values()
                .map(|e| e.public_port)
                .collect();
            let mut bound = None;
            for port in PORT_RANGE {
                if held.contains(&port) {
                    continue;
                }
                if let Ok(l) = TcpListener::bind(("0.0.0.0", port)).await {
                    bound = Some((port, l));
                    break;
                }
            }
            bound.ok_or("no free preview port (are 40 previews really running?)")?
        };

        let secret = tokens::random_token();
        let task = tokio::spawn(serve(listener, target, public_port, secret.clone()));
        let mut inner = self.inner.lock().unwrap();
        // Two phones tapping Start together: first insert wins, the loser's
        // listener is dropped with its task.
        if let Some(existing) = inner.get(&target) {
            task.abort();
            return Ok(info_json(target, existing));
        }
        let entry = Entry {
            public_port,
            secret,
            cwd: cwd.to_string(),
            task,
        };
        let info = info_json(target, &entry);
        inner.insert(target, entry);
        Ok(info)
    }

    pub fn stop(&self, target: u16) -> Value {
        let removed = self.inner.lock().unwrap().remove(&target);
        if let Some(entry) = &removed {
            entry.task.abort();
        }
        json!({ "ok": removed.is_some() })
    }

    /// Every live preview, with a fresh probe of each target so the sheet can
    /// say "the server behind this one is gone".
    pub async fn list(&self) -> Value {
        let snapshot: Vec<(u16, Value)> = self
            .inner
            .lock()
            .unwrap()
            .iter()
            .map(|(target, e)| (*target, info_json(*target, e)))
            .collect();
        let mut out = Vec::with_capacity(snapshot.len());
        for (target, mut info) in snapshot {
            info["live"] = json!(probe(target).await);
            out.push(info);
        }
        json!({ "previews": out, "hosts": hosts_off_thread().await })
    }

    fn info_for(&self, target: u16) -> Option<Value> {
        self.inner
            .lock()
            .unwrap()
            .get(&target)
            .map(|e| info_json(target, e))
    }
}

fn info_json(target: u16, e: &Entry) -> Value {
    json!({
        "targetPort": target,
        "publicPort": e.public_port,
        "secret": e.secret,
        "cwd": e.cwd,
        "handshakePath": HANDSHAKE_PATH,
    })
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

fn cookie_name(public_port: u16) -> String {
    format!("abpv_{public_port}")
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

        assert_eq!(previews.stop(dev_port), json!({ "ok": true }));
        assert_eq!(previews.stop(dev_port), json!({ "ok": false }));
        // a target that answers nothing must be refused up front
        assert!(previews.start("A:\\proj", 1).await.is_err());
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
