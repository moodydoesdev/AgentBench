//! Device tokens and pairing codes for the mobile gateway.
//!
//! Agents are launched permission-skipped, so reaching this gateway is
//! equivalent to running code as the user. Nothing here is decorative: tokens
//! are random, stored hashed, and revocable, and a pairing code is one-shot
//! and short-lived.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Pairing codes expire quickly — the QR is on screen, not in a password
/// manager.
const CODE_TTL: Duration = Duration::from_secs(10 * 60);

/// Wrong password guesses before login locks, and for how long. A password is
/// durable (unlike a pairing code) so the window has to close hard: five
/// misses is a fat-fingered human, not a dictionary.
const LOGIN_MAX_MISSES: u8 = 5;
const LOGIN_LOCKOUT: Duration = Duration::from_secs(15 * 60);

pub fn tokens_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-tokens.json")
}

/// Web-login config: the salted password hash plus whether the desktop UI is
/// served at `/`. Separate from the device list so revoking devices and
/// changing the password never race each other's writes.
pub fn auth_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-auth.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Hex sha256. Tokens are stored only as digests: a leaked tokens file must
/// not hand over live access.
pub fn hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Cryptographically-random opaque string. Uses the OS RNG through
/// `getrandom` as re-exported by sha2's dependency tree is not guaranteed, so
/// entropy is gathered from the platform directly.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A short human-typable pairing code: 4821-9937.
pub fn random_code() -> String {
    let mut bytes = [0u8; 4];
    fill_random(&mut bytes);
    let a = u16::from_le_bytes([bytes[0], bytes[1]]) % 10000;
    let b = u16::from_le_bytes([bytes[2], bytes[3]]) % 10000;
    format!("{a:04}-{b:04}")
}

#[cfg(windows)]
pub(crate) fn fill_random(buf: &mut [u8]) {
    // BCryptGenRandom via the system preferred RNG, declared inline so the
    // gateway needs no extra crate for 32 bytes of entropy.
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            h_algorithm: *mut core::ffi::c_void,
            pb_buffer: *mut u8,
            cb_buffer: u32,
            dw_flags: u32,
        ) -> i32;
    }
    const USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            USE_SYSTEM_PREFERRED_RNG,
        )
    };
    assert!(status == 0, "BCryptGenRandom failed: {status:#x}");
}

#[cfg(unix)]
pub(crate) fn fill_random(buf: &mut [u8]) {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom").expect("open /dev/urandom");
    f.read_exact(buf).expect("read /dev/urandom");
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Device {
    /// sha256 of the bearer token; the token itself is never stored.
    pub hash: String,
    pub name: String,
    pub paired_at: u64,
    #[serde(default)]
    pub last_seen: u64,
    /// "phone" (default) or "bench" — another AgentBench install. Both hold
    /// the same capabilities except build-host exec, which is bench-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct AuthConfig {
    /// Random per-password salt, hex. Regenerated whenever the password is set
    /// so identical passwords across machines still hash differently.
    #[serde(default)]
    salt: String,
    /// sha256(salt + password), hex. Empty means no password is configured and
    /// password login is refused outright.
    #[serde(default)]
    hash: String,
    /// Whether `/` serves the desktop web UI instead of the phone shell.
    #[serde(default, rename = "webUi")]
    web_ui: bool,
}

/// Wrong-password accounting. In memory only: a gateway restart clears it,
/// which is fine — restarting requires being on the machine already.
#[derive(Default)]
struct LoginGuard {
    misses: u8,
    locked_until: u64,
}

struct PendingCode {
    code: String,
    expires_at: u64,
    /// Wrong guesses so far. A single typo must not invalidate a QR the user
    /// is looking at, but the window still has to close on a brute-force
    /// attempt — the code is only 8 digits.
    misses: u8,
}

/// How many wrong guesses a pairing window survives.
const MAX_MISSES: u8 = 5;

pub struct TokenStore {
    devices: Mutex<Vec<Device>>,
    /// Live pairing codes, consumed on use. Not persisted — a code must not
    /// survive a gateway restart.
    pending: Mutex<Option<PendingCode>>,
    /// Per-token last-seen updates are debounced to avoid rewriting the file
    /// on every request.
    last_flush: Mutex<u64>,
    /// Where to persist. `None` means in-memory only, which is what tests use
    /// so they can exercise pairing without touching the real device list.
    path: Option<PathBuf>,
    /// Password + web-UI config, persisted separately (see `auth_file`).
    auth: Mutex<AuthConfig>,
    login_guard: Mutex<LoginGuard>,
}

impl TokenStore {
    pub fn load() -> Self {
        let devices: Vec<Device> = std::fs::read_to_string(tokens_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let auth: AuthConfig = std::fs::read_to_string(auth_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        TokenStore {
            devices: Mutex::new(devices),
            pending: Mutex::new(None),
            last_flush: Mutex::new(0),
            path: Some(tokens_file()),
            auth: Mutex::new(auth),
            login_guard: Mutex::new(LoginGuard::default()),
        }
    }

    #[cfg(test)]
    fn ephemeral() -> Self {
        TokenStore {
            devices: Mutex::new(Vec::new()),
            pending: Mutex::new(None),
            last_flush: Mutex::new(0),
            path: None,
            auth: Mutex::new(AuthConfig::default()),
            login_guard: Mutex::new(LoginGuard::default()),
        }
    }

    fn persist_auth(&self) {
        if self.path.is_none() {
            return; // ephemeral store (tests)
        }
        let auth = self.auth.lock().unwrap();
        let path = auth_file();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&*auth) {
            let _ = std::fs::write(path, text);
        }
    }

    pub fn has_password(&self) -> bool {
        !self.auth.lock().unwrap().hash.is_empty()
    }

    /// Set (or replace) the login password. Only ever called from the loopback
    /// control surface — the public side can verify, never change.
    pub fn set_password(&self, password: &str) -> Result<(), String> {
        let password = password.trim();
        if password.len() < 8 {
            return Err("password must be at least 8 characters".into());
        }
        let mut salt_bytes = [0u8; 16];
        fill_random(&mut salt_bytes);
        let salt: String = salt_bytes.iter().map(|b| format!("{b:02x}")).collect();
        {
            let mut auth = self.auth.lock().unwrap();
            auth.hash = hash(&format!("{salt}{password}"));
            auth.salt = salt;
        }
        *self.login_guard.lock().unwrap() = LoginGuard::default();
        self.persist_auth();
        Ok(())
    }

    pub fn clear_password(&self) {
        {
            let mut auth = self.auth.lock().unwrap();
            auth.hash.clear();
            auth.salt.clear();
        }
        self.persist_auth();
    }

    pub fn web_ui(&self) -> bool {
        self.auth.lock().unwrap().web_ui
    }

    pub fn set_web_ui(&self, on: bool) {
        self.auth.lock().unwrap().web_ui = on;
        self.persist_auth();
    }

    /// Exchange the login password for a device token. Five misses lock the
    /// endpoint for fifteen minutes — this is the one credential that lives on
    /// the public internet when a tunnel is up, so the window slams shut.
    pub fn login(&self, password: &str, device_name: &str) -> Result<String, String> {
        {
            let guard = self.login_guard.lock().unwrap();
            if guard.locked_until > now_ms() {
                let mins = (guard.locked_until - now_ms()) / 60_000 + 1;
                return Err(format!("too many attempts — locked for {mins} min"));
            }
        }
        let ok = {
            let auth = self.auth.lock().unwrap();
            !auth.hash.is_empty() && hash(&format!("{}{}", auth.salt, password)) == auth.hash
        };
        if !ok {
            let mut guard = self.login_guard.lock().unwrap();
            guard.misses += 1;
            if guard.misses >= LOGIN_MAX_MISSES {
                guard.locked_until = now_ms() + LOGIN_LOCKOUT.as_millis() as u64;
                guard.misses = 0;
            }
            // same message whether no password is set or the guess was wrong —
            // an unauthenticated caller learns nothing about the config
            return Err("wrong password".into());
        }
        *self.login_guard.lock().unwrap() = LoginGuard::default();
        Ok(self.mint_web(device_name))
    }

    /// A fresh device token for a browser that has already proven itself —
    /// by password above, or by passkey assertion (see `passkeys`).
    pub fn mint_web(&self, device_name: &str) -> String {
        let token = random_token();
        let name = device_name.trim();
        let name = if name.is_empty() { "Web" } else { name };
        self.devices.lock().unwrap().push(Device {
            hash: hash(&token),
            name: name.chars().take(60).collect(),
            paired_at: now_ms(),
            last_seen: now_ms(),
            kind: Some("web".into()),
        });
        self.persist();
        token
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let devices = self.devices.lock().unwrap();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&*devices) {
            let _ = std::fs::write(path, text);
        }
    }

    /// The code to display. A live code is returned as-is so that re-opening
    /// the panel, a re-render, or a second look at the QR cannot invalidate
    /// the very code the user is about to scan; `force` is the explicit
    /// "regenerate" action.
    pub fn new_code(&self, force: bool) -> String {
        let mut pending = self.pending.lock().unwrap();
        if !force {
            if let Some(live) = pending.as_ref().filter(|p| p.expires_at > now_ms()) {
                return live.code.clone();
            }
        }
        let code = random_code();
        *pending = Some(PendingCode {
            code: code.clone(),
            expires_at: now_ms() + CODE_TTL.as_millis() as u64,
            misses: 0,
        });
        code
    }

    pub fn clear_code(&self) {
        *self.pending.lock().unwrap() = None;
    }

    pub fn current_code(&self) -> Option<(String, u64)> {
        let pending = self.pending.lock().unwrap();
        let p = pending.as_ref()?;
        (p.expires_at > now_ms()).then(|| (p.code.clone(), p.expires_at))
    }

    /// Exchange a pairing code for a device token. Success consumes the code,
    /// so it is strictly single-use; a wrong guess only counts against the
    /// window, which closes after `MAX_MISSES`.
    pub fn redeem(&self, code: &str, device_name: &str, kind: Option<&str>) -> Option<String> {
        {
            let mut pending = self.pending.lock().unwrap();
            let live = pending.as_mut()?;
            if live.expires_at <= now_ms() {
                *pending = None;
                return None;
            }
            if live.code != code.trim() {
                live.misses += 1;
                if live.misses >= MAX_MISSES {
                    *pending = None;
                }
                return None;
            }
            *pending = None; // matched — burn it
        }
        let token = random_token();
        let name = device_name.trim();
        let name = if name.is_empty() { "Phone" } else { name };
        self.devices.lock().unwrap().push(Device {
            hash: hash(&token),
            name: name.chars().take(60).collect(),
            paired_at: now_ms(),
            last_seen: now_ms(),
            kind: kind
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(|k| k.chars().take(20).collect()),
        });
        self.persist();
        Some(token)
    }

    /// The kind a token was paired as ("bench", "web", or None for a phone).
    pub fn kind_of(&self, token: &str) -> Option<String> {
        let digest = hash(token);
        self.devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.hash == digest)
            .and_then(|d| d.kind.clone())
    }

    /// Whether a bearer token is currently valid; refreshes last-seen.
    pub fn verify(&self, token: &str) -> bool {
        let digest = hash(token);
        let mut devices = self.devices.lock().unwrap();
        let Some(dev) = devices.iter_mut().find(|d| d.hash == digest) else {
            return false;
        };
        dev.last_seen = now_ms();
        let flush = {
            let mut last = self.last_flush.lock().unwrap();
            if now_ms().saturating_sub(*last) > 30_000 {
                *last = now_ms();
                true
            } else {
                false
            }
        };
        drop(devices);
        if flush {
            self.persist();
        }
        true
    }

    pub fn list(&self) -> Value {
        let devices = self.devices.lock().unwrap();
        json!(devices
            .iter()
            .map(|d| json!({
                "id": &d.hash[..12],
                "name": d.name,
                "pairedAt": d.paired_at,
                "lastSeen": d.last_seen,
                "kind": d.kind,
            }))
            .collect::<Vec<_>>())
    }

    /// Whether a device with this short id (see `token_id`) is still paired.
    /// The WS bridge polls this so revoking a device drops its live sockets.
    pub fn device_exists(&self, id: &str) -> bool {
        self.devices
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.hash.starts_with(id))
    }

    /// Revoke by the short id shown in the desktop UI.
    pub fn revoke(&self, id: &str) -> bool {
        let mut devices = self.devices.lock().unwrap();
        let before = devices.len();
        devices.retain(|d| !d.hash.starts_with(id));
        let removed = devices.len() != before;
        drop(devices);
        if removed {
            self.persist();
        }
        removed
    }
}

/// Map devices to hashes for equality checks in tests and callers that only
/// have a token.
pub fn token_id(token: &str) -> String {
    hash(token)[..12].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_single_use() {
        let store = TokenStore::ephemeral();
        let code = store.new_code(false);
        assert!(store.redeem(&code, "Phone", None).is_some());
        // a second redemption of the same code must fail — the pairing window
        // closes the instant it is used
        assert!(store.redeem(&code, "Phone", None).is_none());
    }

    #[test]
    fn a_typo_does_not_invalidate_the_displayed_code() {
        let store = TokenStore::ephemeral();
        let code = store.new_code(false);
        assert!(store.redeem("0000-0000", "Phone", None).is_none());
        // the QR on screen must still work after a wrong guess
        assert!(store.redeem(&code, "Phone", None).is_some());
    }

    #[test]
    fn repeated_wrong_guesses_close_the_window() {
        let store = TokenStore::ephemeral();
        let code = store.new_code(false);
        for _ in 0..MAX_MISSES {
            assert!(store.redeem("0000-0000", "Phone", None).is_none());
        }
        assert!(store.redeem(&code, "Phone", None).is_none());
    }

    #[test]
    fn showing_the_qr_again_keeps_the_same_code() {
        let store = TokenStore::ephemeral();
        let first = store.new_code(false);
        assert_eq!(first, store.new_code(false));
        assert_ne!(first, store.new_code(true));
    }

    #[test]
    fn password_login_mints_a_web_device() {
        let store = TokenStore::ephemeral();
        // no password configured: login always refuses, and says nothing
        assert!(store.login("anything", "Web").is_err());
        store.set_password("correct horse").unwrap();
        assert!(store.has_password());
        let token = store.login("correct horse", "Web · test").unwrap();
        assert!(store.verify(&token));
        // clearing the password revokes future logins, not existing tokens
        store.clear_password();
        assert!(store.login("correct horse", "Web").is_err());
        assert!(store.verify(&token));
    }

    #[test]
    fn short_passwords_are_refused() {
        let store = TokenStore::ephemeral();
        assert!(store.set_password("short").is_err());
        assert!(!store.has_password());
    }

    #[test]
    fn five_wrong_passwords_lock_the_endpoint() {
        let store = TokenStore::ephemeral();
        store.set_password("correct horse").unwrap();
        for _ in 0..LOGIN_MAX_MISSES {
            assert!(store.login("wrong", "Web").is_err());
        }
        // even the right password is refused while locked
        let err = store.login("correct horse", "Web").unwrap_err();
        assert!(err.contains("locked"), "unexpected error: {err}");
    }

    #[test]
    fn a_correct_login_resets_the_miss_counter() {
        let store = TokenStore::ephemeral();
        store.set_password("correct horse").unwrap();
        for _ in 0..LOGIN_MAX_MISSES - 1 {
            assert!(store.login("wrong", "Web").is_err());
        }
        assert!(store.login("correct horse", "Web").is_ok());
        // the slate is clean: another few typos must not lock immediately
        assert!(store.login("wrong", "Web").is_err());
        assert!(store.login("correct horse", "Web").is_ok());
    }

    #[test]
    fn tokens_are_unique_and_hashed() {
        assert_ne!(random_token(), random_token());
        let t = random_token();
        assert_ne!(hash(&t), t);
        assert_eq!(hash(&t), hash(&t));
    }
}
