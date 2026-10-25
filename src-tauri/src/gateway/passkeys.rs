//! Passkey (WebAuthn) login for the gateway's browser front door.
//!
//! A passkey is a second way to mint the same revocable device token the
//! password login mints — nothing downstream knows which one was used.
//!
//! Deliberately small and pure Rust: the usual WebAuthn crates pull OpenSSL,
//! which does not build here. The browser does the heavy lifting —
//! `getPublicKey()` hands over the credential key as SPKI DER, so there is no
//! CBOR to parse — and attestation is "none", so what is left to check is
//! exactly what proves possession: the challenge, the origin, the relying
//! party hash and user-verification flags in authenticator data, and an ES256
//! signature. ES256 is what iCloud Keychain, Google Password Manager, Windows
//! Hello and security keys all produce.
//!
//! The relying party is the browser's origin host (bench.example.com behind
//! the tunnel). Each passkey remembers the host it was made on and only
//! answers there; WebAuthn refuses IP addresses and plain http (bar
//! localhost), so tailnet-IP and LAN URLs keep using the password.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn passkeys_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-passkeys.json")
}

/// How long a ceremony may sit between start and finish. Face ID takes a
/// couple of seconds; two minutes covers fumbling for a security key.
const CHALLENGE_TTL: Duration = Duration::from_secs(120);
/// Login start is unauthenticated, so the challenge list must stay bounded.
const MAX_PENDING: usize = 64;
/// COSE algorithm id for ECDSA P-256 with SHA-256.
const ES256: i64 = -7;

const FLAG_UP: u8 = 0x01; // user present
const FLAG_UV: u8 = 0x04; // user verified (Face ID, PIN…)
const FLAG_AT: u8 = 0x40; // attested credential data follows

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Browsers send base64url without padding, but be lenient about padding a
/// client library may have added.
fn unb64(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s.trim().trim_end_matches('='))
        .map_err(|_| "malformed base64".to_string())
}

fn random_b64(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    super::tokens::fill_random(&mut bytes);
    b64(&bytes)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    /// Credential id, base64url.
    pub id: String,
    /// SubjectPublicKeyInfo DER, base64url.
    pub public_key: String,
    /// Host the passkey was made on; it answers nowhere else.
    pub rp_id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(default)]
    pub last_used: u64,
    /// Authenticator signature counter. Synced passkeys always report 0;
    /// hardware keys count up, and a step backwards means a cloned key.
    #[serde(default)]
    pub sign_count: u32,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    /// The WebAuthn user handle. One per machine: there is one user here.
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    passkeys: Vec<Passkey>,
}

#[derive(PartialEq, Clone, Copy)]
enum Ceremony {
    Register,
    Login,
}

struct Pending {
    challenge: String,
    ceremony: Ceremony,
    origin: String,
    rp_id: String,
    expires_at: u64,
}

pub struct Passkeys {
    stored: Mutex<Stored>,
    /// Outstanding challenges. In memory only — a restart voids them.
    pending: Mutex<Vec<Pending>>,
    /// `None` keeps everything in memory (tests).
    path: Option<PathBuf>,
}

/// The relying-party id for a browser origin: its host. Only origins a
/// browser will run WebAuthn on are accepted — https, or http on localhost —
/// and never an IP literal.
pub fn rp_for_origin(origin: &str) -> Result<String, String> {
    let origin = origin.trim().to_ascii_lowercase();
    let (secure, rest) = if let Some(r) = origin.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = origin.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("passkeys need an https address".into());
    };
    if rest.contains('/') || rest.starts_with('[') {
        return Err("passkeys need a host name, not an IP address".into());
    }
    let host = rest.split(':').next().unwrap_or_default();
    if host.is_empty() {
        return Err("bad origin".into());
    }
    if !secure && host != "localhost" {
        return Err("passkeys need an https address — use the tunnel URL".into());
    }
    if host.parse::<std::net::Ipv4Addr>().is_ok() {
        return Err("passkeys need a host name, not an IP address".into());
    }
    Ok(host.to_string())
}

/// Checks authenticator data against the relying party and the flags every
/// ceremony here demands, returning the signature counter.
fn check_auth_data(data: &[u8], rp_id: &str) -> Result<u32, String> {
    if data.len() < 37 {
        return Err("authenticator data too short".into());
    }
    if data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err("passkey belongs to a different site".into());
    }
    let flags = data[32];
    if flags & FLAG_UP == 0 || flags & FLAG_UV == 0 {
        return Err("the device did not verify you (Face ID / PIN)".into());
    }
    Ok(u32::from_be_bytes([data[33], data[34], data[35], data[36]]))
}

/// The credential id inside registration authenticator data:
/// rpIdHash(32) flags(1) count(4) aaguid(16) idLen(2) id(idLen) …
fn attested_credential_id(data: &[u8]) -> Option<&[u8]> {
    if data.get(32)? & FLAG_AT == 0 {
        return None;
    }
    let len = u16::from_be_bytes([*data.get(53)?, *data.get(54)?]) as usize;
    data.get(55..55 + len)
}

impl Passkeys {
    pub fn load() -> Self {
        let stored: Stored = std::fs::read_to_string(passkeys_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Passkeys {
            stored: Mutex::new(stored),
            pending: Mutex::new(Vec::new()),
            path: Some(passkeys_file()),
        }
    }

    #[cfg(test)]
    fn ephemeral() -> Self {
        Passkeys {
            stored: Mutex::new(Stored::default()),
            pending: Mutex::new(Vec::new()),
            path: None,
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let stored = self.stored.lock().unwrap();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&*stored) {
            let _ = std::fs::write(path, text);
        }
    }

    fn user_id(&self) -> String {
        let mut stored = self.stored.lock().unwrap();
        if stored.user_id.is_empty() {
            stored.user_id = random_b64(16);
            drop(stored);
            self.persist();
            return self.stored.lock().unwrap().user_id.clone();
        }
        stored.user_id.clone()
    }

    fn issue(&self, ceremony: Ceremony, origin: &str, rp_id: &str) -> String {
        let challenge = random_b64(32);
        let mut pending = self.pending.lock().unwrap();
        let now = now_ms();
        pending.retain(|p| p.expires_at > now);
        if pending.len() >= MAX_PENDING {
            pending.remove(0);
        }
        pending.push(Pending {
            challenge: challenge.clone(),
            ceremony,
            origin: origin.trim().to_ascii_lowercase(),
            rp_id: rp_id.to_string(),
            expires_at: now + CHALLENGE_TTL.as_millis() as u64,
        });
        challenge
    }

    /// Consume the challenge a client echoed back. One shot either way: a
    /// failed finish cannot be retried against the same challenge.
    fn redeem(&self, ceremony: Ceremony, client_data: &Value) -> Result<Pending, String> {
        let challenge = client_data["challenge"].as_str().unwrap_or_default();
        let mut pending = self.pending.lock().unwrap();
        let i = pending
            .iter()
            .position(|p| p.challenge == challenge && p.ceremony == ceremony)
            .ok_or("passkey request expired — try again")?;
        let p = pending.remove(i);
        if p.expires_at <= now_ms() {
            return Err("passkey request expired — try again".into());
        }
        let origin = client_data["origin"].as_str().unwrap_or_default();
        if origin.to_ascii_lowercase() != p.origin {
            return Err("passkey origin mismatch".into());
        }
        if client_data["crossOrigin"].as_bool() == Some(true) {
            return Err("passkey used from an embedded frame".into());
        }
        Ok(p)
    }

    /// Options for `navigator.credentials.create()`, binary fields base64url.
    pub fn register_start(&self, origin: &str, machine: &str) -> Result<Value, String> {
        let rp_id = rp_for_origin(origin)?;
        let challenge = self.issue(Ceremony::Register, origin, &rp_id);
        let exclude: Vec<Value> = self
            .stored
            .lock()
            .unwrap()
            .passkeys
            .iter()
            .filter(|p| p.rp_id == rp_id)
            .map(|p| json!({ "type": "public-key", "id": p.id }))
            .collect();
        Ok(json!({
            "challenge": challenge,
            "rp": { "id": rp_id, "name": "AgentBench" },
            "user": {
                "id": self.user_id(),
                "name": format!("AgentBench · {machine}"),
                "displayName": format!("AgentBench · {machine}"),
            },
            "pubKeyCredParams": [{ "type": "public-key", "alg": ES256 }],
            "timeout": CHALLENGE_TTL.as_millis() as u64,
            "attestation": "none",
            "authenticatorSelection": {
                "residentKey": "required",
                "requireResidentKey": true,
                "userVerification": "required",
            },
            "excludeCredentials": exclude,
        }))
    }

    /// Verify a `create()` result and store the passkey. Only reachable with
    /// a valid device token, so the caller is already trusted; this checks
    /// the ceremony is genuine and bound to this site.
    pub fn register_finish(&self, body: &Value) -> Result<Value, String> {
        let client_raw = unb64(body["clientDataJSON"].as_str().unwrap_or_default())?;
        let client: Value =
            serde_json::from_slice(&client_raw).map_err(|_| "malformed client data")?;
        if client["type"] != "webauthn.create" {
            return Err("wrong ceremony".into());
        }
        let pending = self.redeem(Ceremony::Register, &client)?;

        let auth = unb64(body["authenticatorData"].as_str().unwrap_or_default())?;
        let count = check_auth_data(&auth, &pending.rp_id)?;
        let raw_id = unb64(body["id"].as_str().unwrap_or_default())?;
        if raw_id.is_empty() || raw_id.len() > 1023 {
            return Err("bad credential id".into());
        }
        if attested_credential_id(&auth) != Some(&raw_id[..]) {
            return Err("credential id does not match authenticator data".into());
        }
        if body["alg"].as_i64() != Some(ES256) {
            return Err("this authenticator offered an unsupported key type".into());
        }
        let spki = unb64(body["publicKey"].as_str().unwrap_or_default())?;
        VerifyingKey::from_public_key_der(&spki).map_err(|_| "unreadable passkey public key")?;

        let name = body["name"].as_str().unwrap_or_default().trim();
        let name = if name.is_empty() { "Passkey" } else { name };
        let passkey = Passkey {
            id: b64(&raw_id),
            public_key: b64(&spki),
            rp_id: pending.rp_id,
            name: name.chars().take(60).collect(),
            created_at: now_ms(),
            last_used: 0,
            sign_count: count,
        };
        {
            let mut stored = self.stored.lock().unwrap();
            if stored.passkeys.iter().any(|p| p.id == passkey.id) {
                return Err("that passkey is already registered".into());
            }
            stored.passkeys.push(passkey.clone());
        }
        self.persist();
        Ok(summary(&passkey))
    }

    /// Options for `navigator.credentials.get()`. No allow-list: the passkeys
    /// are discoverable, so the browser offers whichever it holds for this
    /// site and nothing about them leaks to an unauthenticated caller.
    pub fn login_start(&self, origin: &str) -> Result<Value, String> {
        let rp_id = rp_for_origin(origin)?;
        let challenge = self.issue(Ceremony::Login, origin, &rp_id);
        Ok(json!({
            "challenge": challenge,
            "rpId": rp_id,
            "timeout": CHALLENGE_TTL.as_millis() as u64,
            "userVerification": "required",
            "allowCredentials": [],
        }))
    }

    /// Verify a `get()` assertion. Ok means the caller holds a registered
    /// passkey for this site and just unlocked it; returns its name.
    pub fn login_finish(&self, body: &Value) -> Result<String, String> {
        const REFUSED: &str = "passkey not recognised";
        let client_raw = unb64(body["clientDataJSON"].as_str().unwrap_or_default())?;
        let client: Value =
            serde_json::from_slice(&client_raw).map_err(|_| "malformed client data")?;
        if client["type"] != "webauthn.get" {
            return Err("wrong ceremony".into());
        }
        let pending = self.redeem(Ceremony::Login, &client)?;
        let id = b64(&unb64(body["id"].as_str().unwrap_or_default())?);
        let passkey = self
            .stored
            .lock()
            .unwrap()
            .passkeys
            .iter()
            .find(|p| p.id == id && p.rp_id == pending.rp_id)
            .cloned()
            .ok_or(REFUSED)?;

        let auth = unb64(body["authenticatorData"].as_str().unwrap_or_default())?;
        let count = check_auth_data(&auth, &pending.rp_id)?;
        let key = VerifyingKey::from_public_key_der(&unb64(&passkey.public_key)?)
            .map_err(|_| REFUSED)?;
        let sig = Signature::from_der(&unb64(body["signature"].as_str().unwrap_or_default())?)
            .map_err(|_| REFUSED)?;
        let mut signed = auth.clone();
        signed.extend_from_slice(&Sha256::digest(&client_raw));
        key.verify(&signed, &sig).map_err(|_| REFUSED)?;
        if (count != 0 || passkey.sign_count != 0) && count <= passkey.sign_count {
            return Err("passkey counter went backwards — the key may be cloned".into());
        }

        {
            let mut stored = self.stored.lock().unwrap();
            if let Some(p) = stored.passkeys.iter_mut().find(|p| p.id == id) {
                p.sign_count = count;
                p.last_used = now_ms();
            }
        }
        self.persist();
        Ok(passkey.name)
    }

    pub fn list(&self) -> Value {
        Value::Array(self.stored.lock().unwrap().passkeys.iter().map(summary).collect())
    }

    pub fn remove(&self, id: &str) -> bool {
        let removed = {
            let mut stored = self.stored.lock().unwrap();
            let before = stored.passkeys.len();
            stored.passkeys.retain(|p| p.id != id);
            stored.passkeys.len() != before
        };
        if removed {
            self.persist();
        }
        removed
    }
}

/// What clients see: never the key itself.
fn summary(p: &Passkey) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "rpId": p.rp_id,
        "createdAt": p.created_at,
        "lastUsed": p.last_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePublicKey;

    const ORIGIN: &str = "https://bench.example.com";
    const CRED: &[u8] = b"credential-0001";

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
    }

    fn auth_data(rp: &str, flags: u8, count: u32, attested: bool) -> Vec<u8> {
        let mut d = Sha256::digest(rp.as_bytes()).to_vec();
        d.push(flags | if attested { FLAG_AT } else { 0 });
        d.extend_from_slice(&count.to_be_bytes());
        if attested {
            d.extend_from_slice(&[0u8; 16]);
            d.extend_from_slice(&(CRED.len() as u16).to_be_bytes());
            d.extend_from_slice(CRED);
        }
        d
    }

    fn client(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({ "type": kind, "challenge": challenge, "origin": origin }))
            .unwrap()
    }

    fn register(pk: &Passkeys) {
        let opts = pk.register_start(ORIGIN, "mac").unwrap();
        let cd = client("webauthn.create", opts["challenge"].as_str().unwrap(), ORIGIN);
        let spki = key().verifying_key().to_public_key_der().unwrap();
        pk.register_finish(&json!({
            "id": b64(CRED),
            "clientDataJSON": b64(&cd),
            "authenticatorData": b64(&auth_data("bench.example.com", FLAG_UP | FLAG_UV, 0, true)),
            "publicKey": b64(spki.as_bytes()),
            "alg": ES256,
            "name": "iPhone",
        }))
        .unwrap();
    }

    fn assertion(pk: &Passkeys, origin: &str, rp: &str, count: u32) -> Value {
        let opts = pk.login_start(ORIGIN).unwrap();
        let cd = client("webauthn.get", opts["challenge"].as_str().unwrap(), origin);
        let ad = auth_data(rp, FLAG_UP | FLAG_UV, count, false);
        let mut signed = ad.clone();
        signed.extend_from_slice(&Sha256::digest(&cd));
        let sig: Signature = key().sign(&signed);
        json!({
            "id": b64(CRED),
            "clientDataJSON": b64(&cd),
            "authenticatorData": b64(&ad),
            "signature": b64(sig.to_der().as_bytes()),
        })
    }

    #[test]
    fn origins_map_to_host_names_only() {
        assert_eq!(rp_for_origin("https://Bench.Example.com").unwrap(), "bench.example.com");
        assert_eq!(rp_for_origin("https://bench.example.com:8443").unwrap(), "bench.example.com");
        assert_eq!(rp_for_origin("http://localhost:5173").unwrap(), "localhost");
        assert!(rp_for_origin("http://bench.example.com").is_err());
        assert!(rp_for_origin("https://100.64.1.2:8473").is_err());
        assert!(rp_for_origin("https://[::1]:8473").is_err());
        assert!(rp_for_origin("null").is_err());
    }

    #[test]
    fn a_registered_passkey_signs_in() {
        let pk = Passkeys::ephemeral();
        register(&pk);
        assert_eq!(pk.login_finish(&assertion(&pk, ORIGIN, "bench.example.com", 0)).unwrap(), "iPhone");
    }

    #[test]
    fn a_challenge_is_single_use() {
        let pk = Passkeys::ephemeral();
        register(&pk);
        let a = assertion(&pk, ORIGIN, "bench.example.com", 0);
        assert!(pk.login_finish(&a).is_ok());
        assert!(pk.login_finish(&a).is_err());
    }

    #[test]
    fn another_origin_or_site_is_refused() {
        let pk = Passkeys::ephemeral();
        register(&pk);
        assert!(pk.login_finish(&assertion(&pk, "https://evil.example", "bench.example.com", 0)).is_err());
        assert!(pk.login_finish(&assertion(&pk, ORIGIN, "evil.example", 0)).is_err());
    }

    #[test]
    fn a_tampered_signature_is_refused() {
        let pk = Passkeys::ephemeral();
        register(&pk);
        let mut a = assertion(&pk, ORIGIN, "bench.example.com", 0);
        let mut ad = unb64(a["authenticatorData"].as_str().unwrap()).unwrap();
        ad[36] = 9; // bump the counter after signing
        a["authenticatorData"] = json!(b64(&ad));
        assert!(pk.login_finish(&a).is_err());
    }

    #[test]
    fn a_counter_going_backwards_is_refused() {
        let pk = Passkeys::ephemeral();
        register(&pk);
        assert!(pk.login_finish(&assertion(&pk, ORIGIN, "bench.example.com", 5)).is_ok());
        assert!(pk.login_finish(&assertion(&pk, ORIGIN, "bench.example.com", 5)).is_err());
        assert!(pk.login_finish(&assertion(&pk, ORIGIN, "bench.example.com", 6)).is_ok());
    }

    #[test]
    fn a_removed_passkey_no_longer_signs_in() {
        let pk = Passkeys::ephemeral();
        register(&pk);
        assert!(pk.remove(&b64(CRED)));
        assert!(pk.login_finish(&assertion(&pk, ORIGIN, "bench.example.com", 0)).is_err());
    }
}
