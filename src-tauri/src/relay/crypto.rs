//! End-to-end encryption between two benches talking through a relay.
//!
//! The relay forwards WebSocket frames between two benches and must learn
//! nothing from them. So before any traffic flows, the two benches run a
//! three-message handshake over the relayed socket:
//!
//! ```text
//! initiator → responder   "ABR1" | mode | eI | sI | link_id
//! responder → initiator   eR | sR | LR | tagR
//! initiator → responder   tagI
//! ```
//!
//! `e*` are fresh P-256 keys made for this connection, `s*` the benches'
//! long-term ECDH keys, `LR` the responder's signing key (it proves to the
//! relay who may listen under an id). Both sides derive keys from three
//! Diffie-Hellman results — ee for forward secrecy, es and se so each side
//! proves it holds its long-term key — plus, on first contact, the 256-bit
//! secret carried in the link code:
//!
//! ```text
//! th   = SHA-256("agentbench-relay-v1" | msg1 | eR | sR | LR)
//! keys = HKDF-SHA256(salt = th, ikm = ee | es | se | psk) → i→r, r→i, confirm
//! tagR = HMAC(confirm, "responder" | th)    tagI = HMAC(confirm, "initiator" | th)
//! ```
//!
//! The initiator knows whom it wants: a relay id is a hash of the
//! responder's two public keys, so a relay cannot swap in a key of its own.
//! The responder admits an initiator only if its key was authorized at
//! linking, or, on first contact, if it proves the link secret; that
//! secret is high-entropy, so a relay watching the handshake cannot guess it
//! offline. Afterwards every frame is AES-256-GCM with a per-direction
//! counter nonce, so a dropped, replayed or reordered frame fails to decrypt
//! and the connection closes.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const PROLOGUE: &[u8] = b"agentbench-relay-v1";
const MAGIC: &[u8; 4] = b"ABR1";
/// Largest plaintext in one encrypted frame.
const CHUNK: usize = 16 * 1024;
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub type Pub = [u8; 33];

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    crate::gateway::tokens::fill_random(&mut b);
    b
}

fn new_secret() -> SecretKey {
    loop {
        // A random 32-byte string is a valid scalar with overwhelming
        // probability; the loop only guards the astronomically rare miss.
        if let Ok(k) = SecretKey::from_slice(&random_bytes::<32>()) {
            return k;
        }
    }
}

fn compressed(k: &PublicKey) -> Pub {
    let mut out = [0u8; 33];
    out.copy_from_slice(k.to_encoded_point(true).as_bytes());
    out
}

fn dh(secret: &SecretKey, peer: &Pub) -> Result<[u8; 32], String> {
    let peer = PublicKey::from_sec1_bytes(peer).map_err(|_| "bad public key".to_string())?;
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let mut out = [0u8; 32];
    out.copy_from_slice(shared.raw_secret_bytes());
    Ok(out)
}

/// The id a bench listens under: a hash of its ECDH and signing keys, so
/// whoever knows the id can check they reached the right keys.
pub fn id_of(dh_pub: &Pub, sig_pub: &Pub) -> String {
    let mut h = Sha256::new();
    h.update(b"agentbench-relay-id");
    h.update(dh_pub);
    h.update(sig_pub);
    data_encoding::BASE32_NOPAD.encode(&h.finalize()[..16]).to_lowercase()
}

/// A bench's long-term keys.
pub struct Identity {
    dh: SecretKey,
    sig: SigningKey,
}

impl Identity {
    pub fn generate() -> Identity {
        Identity { dh: new_secret(), sig: SigningKey::from(new_secret()) }
    }

    /// Load the keys at `path`, creating them on first use. The file holds
    /// private keys, so it is owner-only on Unix.
    pub fn load_or_create(path: &Path) -> Result<Identity, String> {
        if let Ok(text) = std::fs::read_to_string(path) {
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let hex = |k: &str| data_encoding::HEXLOWER.decode(v[k].as_str().unwrap_or("").as_bytes()).ok();
            let dh = hex("dh").and_then(|b| SecretKey::from_slice(&b).ok());
            let sig = hex("sig").and_then(|b| SigningKey::from_slice(&b).ok());
            if let (Some(dh), Some(sig)) = (dh, sig) {
                return Ok(Identity { dh, sig });
            }
            return Err(format!("{} is damaged; delete it to make new relay keys", path.display()));
        }
        let id = Identity::generate();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = json!({
            "dh": data_encoding::HEXLOWER.encode(&id.dh.to_bytes()),
            "sig": data_encoding::HEXLOWER.encode(&id.sig.to_bytes()),
        })
        .to_string();
        std::fs::write(path, text).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(id)
    }

    pub fn dh_pub(&self) -> Pub {
        compressed(&self.dh.public_key())
    }

    pub fn sig_pub(&self) -> Pub {
        let mut out = [0u8; 33];
        out.copy_from_slice(VerifyingKey::from(&self.sig).to_encoded_point(true).as_bytes());
        out
    }

    pub fn id(&self) -> String {
        id_of(&self.dh_pub(), &self.sig_pub())
    }

    /// Prove to a relay that we own this id: sign its challenge.
    pub fn sign_challenge(&self, challenge: &[u8]) -> Vec<u8> {
        let sig: Signature = self.sig.sign(&listen_message(challenge));
        sig.to_bytes().to_vec()
    }
}

fn listen_message(challenge: &[u8]) -> Vec<u8> {
    [b"agentbench-relay-listen-v1".as_slice(), challenge].concat()
}

/// The relay's side of `sign_challenge`: the id these keys listen under, if
/// the signature is good.
pub fn verify_listener(dh_pub: &[u8], sig_pub: &[u8], challenge: &[u8], sig: &[u8]) -> Option<String> {
    let dh_pub: Pub = dh_pub.try_into().ok()?;
    let sig_pub: Pub = sig_pub.try_into().ok()?;
    PublicKey::from_sec1_bytes(&dh_pub).ok()?;
    let key = VerifyingKey::from_sec1_bytes(&sig_pub).ok()?;
    let sig = Signature::from_slice(sig).ok()?;
    key.verify(&listen_message(challenge), &sig).ok()?;
    Some(id_of(&dh_pub, &sig_pub))
}

/// A one-time secret that lets a new bench link, and the short id the
/// initiator names it by (a hash, so it reveals nothing about the secret).
#[derive(Clone)]
pub struct LinkSecret {
    pub id: [u8; 8],
    pub psk: [u8; 32],
}

impl LinkSecret {
    pub fn generate() -> LinkSecret {
        LinkSecret::from_psk(random_bytes::<32>())
    }

    pub fn from_psk(psk: [u8; 32]) -> LinkSecret {
        let mut id = [0u8; 8];
        id.copy_from_slice(&Sha256::digest([b"agentbench-link-id".as_slice(), &psk].concat())[..8]);
        LinkSecret { id, psk }
    }
}

/// Keys for one connection.
pub struct Session {
    send: Aes256Gcm,
    recv: Aes256Gcm,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Session { .. }")
    }
}

/// What the responder learned about the bench that connected.
pub struct Accepted {
    pub peer: Pub,
    /// Set when the peer got in with a link secret rather than an authorized
    /// key — the caller should now authorize `peer` and burn the secret.
    pub linked: Option<[u8; 8]>,
}

struct Derived {
    i2r: [u8; 32],
    r2i: [u8; 32],
    confirm: [u8; 32],
}

fn derive(th: &[u8; 32], ee: &[u8; 32], es: &[u8; 32], se: &[u8; 32], psk: &[u8; 32]) -> Derived {
    let ikm = [ee.as_slice(), es, se, psk].concat();
    let hk = Hkdf::<Sha256>::new(Some(th), &ikm);
    let mut okm = [0u8; 96];
    hk.expand(b"abr-keys", &mut okm).expect("96 bytes is a valid HKDF-SHA256 length");
    let mut d = Derived { i2r: [0; 32], r2i: [0; 32], confirm: [0; 32] };
    d.i2r.copy_from_slice(&okm[..32]);
    d.r2i.copy_from_slice(&okm[32..64]);
    d.confirm.copy_from_slice(&okm[64..]);
    d
}

fn tag(confirm: &[u8; 32], label: &[u8], th: &[u8; 32]) -> Hmac<Sha256> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(confirm).expect("HMAC takes any key length");
    m.update(label);
    m.update(th);
    m
}

fn transcript(msg1: &[u8], er: &Pub, sr: &Pub, lr: &Pub) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(PROLOGUE);
    h.update(msg1);
    h.update(er);
    h.update(sr);
    h.update(lr);
    h.finalize().into()
}

async fn recv_binary<S>(ws: &mut WebSocketStream<S>) -> Result<Vec<u8>, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let msg = tokio::time::timeout(HANDSHAKE_TIMEOUT, ws.next())
            .await
            .map_err(|_| "the other bench did not answer".to_string())?
            .ok_or("the relay closed the connection")?
            .map_err(|e| e.to_string())?;
        match msg {
            Message::Binary(b) => return Ok(b.to_vec()),
            Message::Close(f) => {
                return Err(f
                    .map(|f| f.reason.to_string())
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| "the relay closed the connection".into()))
            }
            // pings and the relay's text notices are not part of the handshake
            _ => continue,
        }
    }
}

fn take<const N: usize>(b: &[u8], at: usize) -> Result<[u8; N], String> {
    b.get(at..at + N)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| "malformed handshake".to_string())
}

/// Open a session to the bench whose relay id is `peer_id`. `link` is the
/// secret from a link code, on first contact only.
pub async fn initiate<S>(
    ws: &mut WebSocketStream<S>,
    me: &Identity,
    peer_id: &str,
    link: Option<&LinkSecret>,
) -> Result<Session, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let e = new_secret();
    let e_pub = compressed(&e.public_key());
    let mut msg1 = Vec::with_capacity(79);
    msg1.extend_from_slice(MAGIC);
    msg1.push(if link.is_some() { 1 } else { 0 });
    msg1.extend_from_slice(&e_pub);
    msg1.extend_from_slice(&me.dh_pub());
    msg1.extend_from_slice(&link.map(|l| l.id).unwrap_or([0; 8]));
    ws.send(Message::Binary(msg1.clone().into())).await.map_err(|e| e.to_string())?;

    let msg2 = recv_binary(ws).await?;
    if msg2.len() != 33 * 3 + 32 {
        return Err("malformed handshake".into());
    }
    let er: Pub = take(&msg2, 0)?;
    let sr: Pub = take(&msg2, 33)?;
    let lr: Pub = take(&msg2, 66)?;
    if id_of(&sr, &lr) != peer_id {
        return Err("the bench that answered is not the one in the link code — the relay may be misbehaving".into());
    }
    let th = transcript(&msg1, &er, &sr, &lr);
    let d = derive(
        &th,
        &dh(&e, &er)?,
        &dh(&e, &sr)?,
        &dh(&me.dh, &er)?,
        &link.map(|l| l.psk).unwrap_or([0; 32]),
    );
    tag(&d.confirm, b"responder", &th)
        .verify_slice(&msg2[99..])
        .map_err(|_| "the other bench failed to prove its identity".to_string())?;
    let tag_i = tag(&d.confirm, b"initiator", &th).finalize().into_bytes();
    ws.send(Message::Binary(tag_i.to_vec().into())).await.map_err(|e| e.to_string())?;
    Ok(Session {
        send: Aes256Gcm::new_from_slice(&d.i2r).expect("32-byte key"),
        recv: Aes256Gcm::new_from_slice(&d.r2i).expect("32-byte key"),
    })
}

/// Answer a session request. `link_secret` finds the secret for a link id;
/// `authorized` says whether an already-linked key may connect.
pub async fn respond<S>(
    ws: &mut WebSocketStream<S>,
    me: &Identity,
    link_secret: impl Fn(&[u8; 8]) -> Option<[u8; 32]>,
    authorized: impl Fn(&Pub) -> bool,
) -> Result<(Session, Accepted), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let msg1 = recv_binary(ws).await?;
    if msg1.len() != 79 || &msg1[..4] != MAGIC {
        return Err("not an AgentBench relay handshake".into());
    }
    let linking = msg1[4] == 1;
    let ei: Pub = take(&msg1, 5)?;
    let si: Pub = take(&msg1, 38)?;
    let link_id: [u8; 8] = take(&msg1, 71)?;
    let psk = if linking {
        link_secret(&link_id).ok_or("unknown or expired link code")?
    } else {
        if !authorized(&si) {
            return Err("this bench is not linked here".into());
        }
        [0u8; 32]
    };
    let e = new_secret();
    let er = compressed(&e.public_key());
    let sr = me.dh_pub();
    let lr = me.sig_pub();
    let th = transcript(&msg1, &er, &sr, &lr);
    let d = derive(&th, &dh(&e, &ei)?, &dh(&me.dh, &ei)?, &dh(&e, &si)?, &psk);
    let tag_r = tag(&d.confirm, b"responder", &th).finalize().into_bytes();
    let msg2 = [er.as_slice(), &sr, &lr, &tag_r].concat();
    ws.send(Message::Binary(msg2.into())).await.map_err(|e| e.to_string())?;

    let msg3 = recv_binary(ws).await?;
    tag(&d.confirm, b"initiator", &th)
        .verify_slice(&msg3)
        .map_err(|_| "the connecting bench failed to prove its key or link code".to_string())?;
    Ok((
        Session {
            send: Aes256Gcm::new_from_slice(&d.r2i).expect("32-byte key"),
            recv: Aes256Gcm::new_from_slice(&d.i2r).expect("32-byte key"),
        },
        Accepted { peer: si, linked: linking.then_some(link_id) },
    ))
}

fn nonce(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

/// Turn an established session into a plain byte stream. A task moves bytes
/// between the returned stream and the WebSocket, encrypting one way and
/// decrypting the other; either side closing closes both.
pub fn secure_pipe<S>(ws: WebSocketStream<S>, session: Session) -> DuplexStream
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (app, mut pump) = tokio::io::duplex(4 * CHUNK);
    tokio::spawn(async move {
        let (mut sink, mut stream) = ws.split();
        let Session { send, recv } = session;
        let (mut tx_n, mut rx_n) = (0u64, 0u64);
        let mut buf = vec![0u8; CHUNK];
        // A build can go quiet for minutes; pings keep proxies between us and
        // the relay from deciding the connection is idle.
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(25));
        keepalive.tick().await;
        loop {
            tokio::select! {
                _ = keepalive.tick() => {
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
                n = pump.read(&mut buf) => {
                    let n = match n { Ok(0) | Err(_) => break, Ok(n) => n };
                    let Ok(sealed) = send.encrypt(Nonce::from_slice(&nonce(tx_n)), &buf[..n]) else { break };
                    tx_n += 1;
                    if sink.send(Message::Binary(sealed.into())).await.is_err() {
                        break;
                    }
                }
                msg = stream.next() => {
                    match msg {
                        Some(Ok(Message::Binary(b))) => {
                            let Ok(plain) = recv.decrypt(Nonce::from_slice(&nonce(rx_n)), b.as_ref()) else { break };
                            rx_n += 1;
                            if pump.write_all(&plain).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Text(_))) => {}
                        _ => break,
                    }
                }
            }
        }
        let _ = sink.send(Message::Close(None)).await;
        let _ = pump.shutdown().await;
    });
    app
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::protocol::Role;

    /// Two WebSocket ends joined by an in-memory pipe — the relay, minus the
    /// relay.
    async fn pair() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (a, b) = tokio::io::duplex(1 << 20);
        (
            WebSocketStream::from_raw_socket(a, Role::Client, None).await,
            WebSocketStream::from_raw_socket(b, Role::Server, None).await,
        )
    }

    #[tokio::test]
    async fn link_then_reconnect_then_carry_bytes() {
        let host = Identity::generate();
        let mac = Identity::generate();
        let host_id = host.id();
        let link = LinkSecret::generate();
        let (lid, psk) = (link.id, link.psk);

        // first contact: the link secret admits an unknown key
        let (mut a, mut b) = pair().await;
        let mac_pub = mac.dh_pub();
        let resp = tokio::spawn(async move {
            respond(&mut b, &host, |id| (*id == lid).then_some(psk), |_| false)
                .await
                .map(|(s, acc)| (s, acc, b, host))
        });
        let s_i = initiate(&mut a, &mac, &host_id, Some(&link)).await.unwrap();
        let (s_r, acc, b, host) = resp.await.unwrap().unwrap();
        assert_eq!(acc.peer, mac_pub);
        assert_eq!(acc.linked, Some(lid));

        // the session carries bytes both ways, intact
        let mut left = secure_pipe(a, s_i);
        let mut right = secure_pipe(b, s_r);
        let big: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        left.write_all(&big).await.unwrap();
        let mut got = vec![0u8; big.len()];
        right.read_exact(&mut got).await.unwrap();
        assert_eq!(got, big);
        right.write_all(b"pong").await.unwrap();
        let mut four = [0u8; 4];
        left.read_exact(&mut four).await.unwrap();
        assert_eq!(&four, b"pong");

        // later: the authorized key gets in without any secret
        let (mut a, mut b) = pair().await;
        let resp = tokio::spawn(async move {
            respond(&mut b, &host, |_| None, |k| *k == mac_pub).await.map(|(_, acc)| acc.linked)
        });
        initiate(&mut a, &mac, &host_id, None).await.unwrap();
        assert_eq!(resp.await.unwrap().unwrap(), None);
    }

    #[tokio::test]
    async fn strangers_and_wrong_secrets_are_refused() {
        let host = Identity::generate();
        let host_id = host.id();
        let stranger = Identity::generate();

        let (mut a, mut b) = pair().await;
        let resp = tokio::spawn(async move { respond(&mut b, &host, |_| None, |_| false).await.err() });
        let _ = initiate(&mut a, &stranger, &host_id, None).await;
        assert!(resp.await.unwrap().unwrap().contains("not linked"));

        // a guessed secret with the right link id still fails the tag check
        let host = Identity::generate();
        let host_id = host.id();
        let real = LinkSecret::generate();
        let guess = LinkSecret { id: real.id, psk: [7; 32] };
        let (lid, psk) = (real.id, real.psk);
        let (mut a, mut b) = pair().await;
        let resp = tokio::spawn(async move {
            respond(&mut b, &host, |id| (*id == lid).then_some(psk), |_| false).await.err()
        });
        let err = initiate(&mut a, &stranger, &host_id, Some(&guess)).await.unwrap_err();
        assert!(err.contains("prove its identity"), "{err}");
        drop(a);
        assert!(resp.await.unwrap().is_some());
    }

    #[tokio::test]
    async fn an_impostor_with_other_keys_is_caught() {
        let real = Identity::generate();
        let impostor = Identity::generate();
        let mac = Identity::generate();
        let (mut a, mut b) = pair().await;
        tokio::spawn(async move {
            let _ = respond(&mut b, &impostor, |_| None, |_| true).await;
        });
        let err = initiate(&mut a, &mac, &real.id(), None).await.unwrap_err();
        assert!(err.contains("not the one in the link code"), "{err}");
    }

    #[test]
    fn listener_signatures_bind_the_id() {
        let me = Identity::generate();
        let challenge = random_bytes::<32>();
        let sig = me.sign_challenge(&challenge);
        assert_eq!(
            verify_listener(&me.dh_pub(), &me.sig_pub(), &challenge, &sig).as_deref(),
            Some(me.id().as_str())
        );
        // someone else's signing key cannot claim this dh key's id
        let other = Identity::generate();
        let forged = other.sign_challenge(&challenge);
        assert!(verify_listener(&me.dh_pub(), &me.sig_pub(), &challenge, &forged).is_none());
        assert_ne!(
            verify_listener(&me.dh_pub(), &other.sig_pub(), &challenge, &forged),
            Some(me.id())
        );
    }

    #[test]
    fn identities_survive_a_reload() {
        let dir = std::env::temp_dir().join(format!("abr-id-{}", std::process::id()));
        let path = dir.join("relay-identity.json");
        let a = Identity::load_or_create(&path).unwrap();
        let b = Identity::load_or_create(&path).unwrap();
        assert_eq!(a.id(), b.id());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
