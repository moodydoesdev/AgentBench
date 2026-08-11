//! Site previews: proxy a dev server that hands the browser absolute URLs on
//! a hostname only the bench resolves.
//!
//! The port-mode preview (in-tree preview.rs) is a transparent TCP splice —
//! deliberately, since that keeps HMR websockets and streaming untouched. It
//! is exactly wrong for Laravel-style apps: `APP_URL=http://dashboard.mgx.test`
//! leaks into redirects, generated links, and the Vite dev-server stub, so the
//! remote browser ends up navigating to a name only the bench's DNS knows.
//!
//! A site preview is therefore HTTP-aware. Each request is forwarded upstream
//! through reqwest — to a loopback port (`php artisan serve`) or to a vhost
//! (Herd/Valet nginx, addressed by hostname with DNS pinned to loopback so
//! Host, SNI and the local-CA TLS handshake all come out right) — and every
//! absolute URL in Location/Refresh headers and text bodies is rewritten to
//! the address the client actually reached us by. The Vite dev server rides a
//! companion port-mode preview; its origin is part of the same rewrite map,
//! and the handshake here sets the companion's auth cookie too (cookies are
//! host-scoped, not port-scoped, which for once works in our favor).
//!
//! Websockets on this leg (Reverb behind the vhost, Soketi on a path) are
//! carried by handshake-then-splice: the Upgrade request goes upstream
//! through the same reqwest client — which does the loopback-pinned TLS and
//! Host legwork — its 101 is mirrored back, and from there bytes are copied
//! raw in both directions. Frames are opaque to the rewriter; only handshake
//! headers pass through it.

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use std::sync::Arc;

/// How the app is actually served on the bench.
pub enum Upstream {
    /// `php artisan serve` and friends: plain http on a loopback port.
    Port(u16),
    /// Herd/Valet nginx: routed by Host header, DNS pinned to loopback.
    /// `base` is the full upstream base URL, e.g. "https://dashboard.mgx.test".
    Vhost { host: String, base: String },
}

/// The companion Vite preview (a port-mode splice), whose origin must be
/// rewritten and whose cookie our handshake mints alongside our own.
pub struct Companion {
    pub origin: String,
    pub public_port: u16,
    pub secret: String,
}

pub struct SiteCtx {
    pub public_port: u16,
    pub secret: String,
    /// Origins rewritten to this proxy's own public address: the site origin
    /// in both schemes, plus the loopback spellings of a port upstream.
    pub own_origins: Vec<String>,
    pub companion: Option<Companion>,
    pub upstream: Upstream,
    pub client: reqwest::Client,
}

/// Build the reqwest client for one site. Redirects stay with the browser so
/// their Location headers pass through the rewriter; identity encoding keeps
/// bodies rewritable; the invalid-cert allowance is for Herd's local CA on a
/// loopback-pinned name, never for a real network hop.
pub fn client_for(upstream: &Upstream) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        // Upgrade only exists on HTTP/1.1 — without this, ALPN against a
        // TLS vhost can negotiate h2 and websocket handshakes go nowhere.
        // No total timeout either: a spliced websocket lives for hours.
        .http1_only();
    if let Upstream::Vhost { host, .. } = upstream {
        b = b
            .resolve(host, std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
            .danger_accept_invalid_certs(true);
    }
    b.build().map_err(|e| e.to_string())
}

pub async fn serve(listener: tokio::net::TcpListener, ctx: Arc<SiteCtx>) {
    let app = axum::Router::new()
        .fallback(handle)
        .with_state(ctx);
    let _ = axum::serve(listener, app).await;
}

async fn handle(State(ctx): State<Arc<SiteCtx>>, req: Request) -> Response {
    let path_q = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    // The handshake: same path and contract as the port-mode proxy, but it
    // mints the companion's cookie in the same response — the Vite splice
    // never sees a handshake of its own.
    if let Some(rest) = path_q.strip_prefix(super::preview::HANDSHAKE_PATH) {
        if rest.is_empty() || rest.starts_with('?') {
            if query_param(&path_q, "t").as_deref() == Some(ctx.secret.as_str()) {
                let mut resp = Response::builder()
                    .status(StatusCode::FOUND)
                    .header("Location", "/")
                    .header("Set-Cookie", auth_cookie(ctx.public_port, &ctx.secret));
                if let Some(c) = &ctx.companion {
                    resp = resp.header("Set-Cookie", auth_cookie(c.public_port, &c.secret));
                }
                return resp.body(Body::empty()).unwrap();
            }
            return refuse(StatusCode::FORBIDDEN, "Bad or expired preview link.");
        }
    }

    if cookie_value(req.headers(), &super::preview::cookie_name(ctx.public_port)).as_deref()
        != Some(ctx.secret.as_str())
    {
        return refuse(
            StatusCode::FORBIDDEN,
            "This is an AgentBench dev-server preview. Open it from the AgentBench app.",
        );
    }

    // Websocket upgrades don't go through the rewriter — handshake upstream,
    // mirror the 101, splice bytes.
    if req
        .headers()
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        return proxy_websocket(&ctx, req, &path_q).await;
    }

    // Whatever address the client reached us by is, by definition, routable
    // for that client — absolute URLs are rewritten onto it.
    let Some(public_host) = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .map(host_only)
    else {
        return refuse(StatusCode::BAD_REQUEST, "Missing Host header.");
    };
    let map = rewrite_map(&ctx, &public_host);

    let base = upstream_base(&ctx);
    let method =
        reqwest::Method::from_bytes(req.method().as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut upstream_req = ctx
        .client
        .request(method, format!("{base}{path_q}"))
        .header("accept-encoding", "identity");
    for (name, value) in req.headers() {
        // hop-by-hop and recomputed headers stay behind; reqwest derives
        // host and content-length itself
        if matches!(
            name.as_str(),
            "host" | "content-length" | "accept-encoding" | "connection" | "upgrade"
        ) {
            continue;
        }
        upstream_req = upstream_req.header(name.as_str(), value.as_bytes());
    }
    let body = match axum::body::to_bytes(req.into_body(), 256 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large."),
    };

    let upstream_resp = match upstream_req.body(body).send().await {
        Ok(r) => r,
        Err(e) => {
            return refuse(
                StatusCode::BAD_GATEWAY,
                &format!("The app server did not answer — has it stopped? ({e})"),
            )
        }
    };

    let status = upstream_resp.status();
    let mut headers = HeaderMap::new();
    let mut is_text = false;
    for (name, value) in upstream_resp.headers() {
        match name.as_str() {
            // hyper re-frames the body; a stale length or chunking marker
            // from upstream would corrupt the connection
            "connection" | "transfer-encoding" | "keep-alive" | "content-length" => continue,
            "content-type" => {
                is_text = value.to_str().map(text_type).unwrap_or(false);
                headers.append(name.clone(), value.clone());
            }
            "location" | "refresh" => {
                let rewritten = value
                    .to_str()
                    .map(|v| apply_map(v, &map))
                    .ok()
                    .and_then(|v| HeaderValue::from_str(&v).ok())
                    .unwrap_or_else(|| value.clone());
                headers.append(name.clone(), rewritten);
            }
            "set-cookie" => {
                // the app thinks it lives on its own hostname over https;
                // its cookies must stick to our plain-http preview address
                let rewritten = value
                    .to_str()
                    .map(strip_cookie_scope)
                    .ok()
                    .and_then(|v| HeaderValue::from_str(&v).ok())
                    .unwrap_or_else(|| value.clone());
                headers.append(name.clone(), rewritten);
            }
            _ => {
                headers.append(name.clone(), value.clone());
            }
        }
    }

    let body = if is_text {
        // buffered so the map can run over it; dev-server pages are small
        match upstream_resp.bytes().await {
            Ok(b) => Body::from(rewrite_body(b, &map)),
            Err(_) => return refuse(StatusCode::BAD_GATEWAY, "The app server hung up mid-response."),
        }
    } else {
        Body::from_stream(upstream_resp.bytes_stream())
    };

    let mut resp = Response::builder().status(status.as_u16());
    if let Some(h) = resp.headers_mut() {
        *h = headers;
    }
    resp.body(body)
        .unwrap_or_else(|_| refuse(StatusCode::BAD_GATEWAY, "Malformed upstream response."))
}

fn upstream_base(ctx: &SiteCtx) -> String {
    match &ctx.upstream {
        Upstream::Port(p) => format!("http://127.0.0.1:{p}"),
        Upstream::Vhost { base, .. } => base.clone(),
    }
}

/// Carry a websocket: forward the Upgrade handshake upstream, hand its 101
/// (Sec-WebSocket-Accept and all) back to the client, then copy bytes both
/// ways until either side hangs up. A non-101 answer relays as a normal
/// response so auth failures and 404s stay debuggable.
async fn proxy_websocket(ctx: &SiteCtx, mut req: Request, path_q: &str) -> Response {
    // claim the client side of the upgrade before the request is consumed
    let on_upgrade = hyper::upgrade::on(&mut req);
    let mut upstream_req = ctx.client.get(format!("{}{path_q}", upstream_base(ctx)));
    for (name, value) in req.headers() {
        // unlike the plain path, connection/upgrade must pass through — they
        // ARE the handshake; reqwest still derives host itself
        if matches!(name.as_str(), "host" | "content-length" | "accept-encoding") {
            continue;
        }
        upstream_req = upstream_req.header(name.as_str(), value.as_bytes());
    }
    let upstream_resp = match upstream_req.send().await {
        Ok(r) => r,
        Err(e) => {
            return refuse(
                StatusCode::BAD_GATEWAY,
                &format!("The app server did not answer the websocket handshake ({e})."),
            )
        }
    };

    let status = upstream_resp.status().as_u16();
    if status != StatusCode::SWITCHING_PROTOCOLS.as_u16() {
        let mut headers = HeaderMap::new();
        for (name, value) in upstream_resp.headers() {
            if matches!(
                name.as_str(),
                "connection" | "transfer-encoding" | "keep-alive" | "content-length"
            ) {
                continue;
            }
            headers.append(name.clone(), value.clone());
        }
        let body = upstream_resp.bytes().await.unwrap_or_default();
        let mut resp = Response::builder().status(status);
        if let Some(h) = resp.headers_mut() {
            *h = headers;
        }
        return resp
            .body(Body::from(body))
            .unwrap_or_else(|_| refuse(StatusCode::BAD_GATEWAY, "Malformed upstream response."));
    }

    let mut resp = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    if let Some(h) = resp.headers_mut() {
        for (name, value) in upstream_resp.headers() {
            h.append(name.clone(), value.clone());
        }
    }
    // The splice starts once hyper has written our 101 and released the
    // client socket; the upstream side is released by reqwest the same way.
    tokio::spawn(async move {
        let Ok(mut upstream) = upstream_resp.upgrade().await else {
            return;
        };
        let Ok(client) = on_upgrade.await else {
            return;
        };
        let mut client = hyper_util::rt::TokioIo::new(client);
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    });
    resp.body(Body::empty())
        .unwrap_or_else(|_| refuse(StatusCode::BAD_GATEWAY, "Malformed upstream response."))
}

fn auth_cookie(public_port: u16, secret: &str) -> String {
    format!(
        "{}={secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200",
        super::preview::cookie_name(public_port)
    )
}

fn refuse(status: StatusCode, message: &str) -> Response {
    let body = format!(
        "<!doctype html><meta name=viewport content=\"width=device-width\"><title>AgentBench preview</title><body style=\"font-family:system-ui;padding:40px 24px;max-width:32em\"><h3>AgentBench</h3><p>{message}</p></body>"
    );
    Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

/// Content types worth running the rewrite map over. Everything else streams
/// through untouched.
fn text_type(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim();
    ct.starts_with("text/")
        || matches!(
            ct,
            "application/json"
                | "application/javascript"
                | "application/xhtml+xml"
                | "application/xml"
        )
}

/// The host part of a Host header — port dropped, IPv6 brackets kept.
fn host_only(host: &str) -> String {
    if let Some(end) = host.strip_prefix('[').and_then(|_| host.find(']')) {
        return host[..=end].to_string();
    }
    host.split(':').next().unwrap_or(host).to_string()
}

/// Old-origin → preview-address pairs for one request.
fn rewrite_map(ctx: &SiteCtx, public_host: &str) -> Vec<(String, String)> {
    let mut map = Vec::new();
    let own = format!("http://{public_host}:{}", ctx.public_port);
    for origin in &ctx.own_origins {
        map.push((origin.clone(), own.clone()));
    }
    if let Some(c) = &ctx.companion {
        map.push((
            c.origin.clone(),
            format!("http://{public_host}:{}", c.public_port),
        ));
    }
    map
}

/// Replace `from` origins with `to`, skipping matches where the origin is a
/// prefix of a longer host or port token (`http://a.test` inside
/// `http://a.test.example.com` or `http://a.test:8443`).
fn replace_origin(text: &str, from: &str, to: &str) -> String {
    let from_has_port = from
        .split_once("://")
        .map(|(_, rest)| host_only(rest).len() < rest.len())
        .unwrap_or(false);
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(from) {
        let after = rest.as_bytes().get(at + from.len()).copied();
        let extends = match after {
            Some(b) => {
                b.is_ascii_alphanumeric()
                    || b == b'.'
                    || b == b'-'
                    || (b == b':' && !from_has_port)
            }
            None => false,
        };
        out.push_str(&rest[..at]);
        out.push_str(if extends { from } else { to });
        rest = &rest[at + from.len()..];
    }
    out.push_str(rest);
    out
}

/// Run the map over a string, in both plain and JSON-escaped-slash spellings —
/// PHP's json_encode escapes `/` by default, so Livewire and Inertia payloads
/// carry `http:\/\/dashboard.mgx.test`.
pub fn apply_map(text: &str, map: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (from, to) in map {
        out = replace_origin(&out, from, to);
        let (ef, et) = (from.replace('/', "\\/"), to.replace('/', "\\/"));
        if out.contains(&ef) {
            out = out.replace(&ef, &et);
        }
    }
    out
}

fn rewrite_body(bytes: Bytes, map: &[(String, String)]) -> Bytes {
    match std::str::from_utf8(&bytes) {
        Ok(text) => Bytes::from(apply_map(text, map)),
        // declared text but not UTF-8: pass through rather than mangle
        Err(_) => bytes,
    }
}

/// Drop the attributes that pin a cookie to the app's own origin: `Domain`
/// (the browser must scope it to the preview address) and `Secure` (the
/// preview leg is plain http).
fn strip_cookie_scope(cookie: &str) -> String {
    cookie
        .split(';')
        .map(str::trim)
        .filter(|part| {
            let key = part.split('=').next().unwrap_or("").trim();
            !key.eq_ignore_ascii_case("domain") && !key.eq_ignore_ascii_case("secure")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// Value of one cookie across however many Cookie headers the client sent.
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    for value in headers.get_all("cookie") {
        let Ok(text) = value.to_str() else { continue };
        for pair in text.split(';') {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> Vec<(String, String)> {
        vec![
            ("http://dashboard.mgx.test".into(), "http://100.1.2.3:8600".into()),
            ("https://dashboard.mgx.test".into(), "http://100.1.2.3:8600".into()),
            ("http://[::1]:5173".into(), "http://100.1.2.3:8601".into()),
        ]
    }

    #[test]
    fn origins_are_rewritten_in_html_and_json() {
        let html = r#"<a href="http://dashboard.mgx.test/login">in</a> <script src="http://[::1]:5173/@vite/client"></script>"#;
        let out = apply_map(html, &map());
        assert_eq!(
            out,
            r#"<a href="http://100.1.2.3:8600/login">in</a> <script src="http://100.1.2.3:8601/@vite/client"></script>"#
        );

        // PHP json_encode escapes slashes; Livewire/Inertia payloads look like this
        let json = r#"{"url":"https:\/\/dashboard.mgx.test\/dashboard"}"#;
        assert_eq!(
            apply_map(json, &map()),
            r#"{"url":"http:\/\/100.1.2.3:8600\/dashboard"}"#
        );
    }

    #[test]
    fn longer_hosts_and_other_ports_survive() {
        // a longer host that merely starts with the site origin
        let s = "see http://dashboard.mgx.testing.example.com/x";
        assert_eq!(apply_map(s, &map()), s);
        // same host, explicit different port — a different origin
        let s = "see http://dashboard.mgx.test:8443/x";
        assert_eq!(apply_map(s, &map()), s);
        // portful origin followed by a path is still rewritten
        assert_eq!(
            apply_map("http://[::1]:5173/build/app.js", &map()),
            "http://100.1.2.3:8601/build/app.js"
        );
        // origin at end of string
        assert_eq!(
            apply_map("go to http://dashboard.mgx.test", &map()),
            "go to http://100.1.2.3:8600"
        );
    }

    #[test]
    fn cookie_scope_is_stripped() {
        assert_eq!(
            strip_cookie_scope(
                "laravel_session=abc; Path=/; Domain=dashboard.mgx.test; Secure; HttpOnly; SameSite=Lax"
            ),
            "laravel_session=abc; Path=/; HttpOnly; SameSite=Lax"
        );
        // no scoping attributes: unchanged
        assert_eq!(
            strip_cookie_scope("XSRF-TOKEN=t; Path=/"),
            "XSRF-TOKEN=t; Path=/"
        );
    }

    #[test]
    fn hosts_and_types() {
        assert_eq!(host_only("100.1.2.3:8600"), "100.1.2.3");
        assert_eq!(host_only("[fd7a::2]:8600"), "[fd7a::2]");
        assert_eq!(host_only("dashboard.mgx.test"), "dashboard.mgx.test");
        assert!(text_type("text/html; charset=UTF-8"));
        assert!(text_type("application/json"));
        assert!(!text_type("image/png"));
        assert!(!text_type("application/octet-stream"));
    }
}
