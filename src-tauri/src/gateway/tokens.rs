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

pub fn tokens_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-tokens.json")
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
fn fill_random(buf: &mut [u8]) {
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
fn fill_random(buf: &mut [u8]) {
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
}

impl TokenStore {
    pub fn load() -> Self {
        let devices: Vec<Device> = std::fs::read_to_string(tokens_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        TokenStore {
            devices: Mutex::new(devices),
            pending: Mutex::new(None),
            last_flush: Mutex::new(0),
            path: Some(tokens_file()),
        }
    }

    #[cfg(test)]
    fn ephemeral() -> Self {
        TokenStore {
            devices: Mutex::new(Vec::new()),
            pending: Mutex::new(None),
            last_flush: Mutex::new(0),
            path: None,
        }
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
    pub fn redeem(&self, code: &str, device_name: &str) -> Option<String> {
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
        });
        self.persist();
        Some(token)
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
            }))
            .collect::<Vec<_>>())
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
        assert!(store.redeem(&code, "Phone").is_some());
        // a second redemption of the same code must fail — the pairing window
        // closes the instant it is used
        assert!(store.redeem(&code, "Phone").is_none());
    }

    #[test]
    fn a_typo_does_not_invalidate_the_displayed_code() {
        let store = TokenStore::ephemeral();
        let code = store.new_code(false);
        assert!(store.redeem("0000-0000", "Phone").is_none());
        // the QR on screen must still work after a wrong guess
        assert!(store.redeem(&code, "Phone").is_some());
    }

    #[test]
    fn repeated_wrong_guesses_close_the_window() {
        let store = TokenStore::ephemeral();
        let code = store.new_code(false);
        for _ in 0..MAX_MISSES {
            assert!(store.redeem("0000-0000", "Phone").is_none());
        }
        assert!(store.redeem(&code, "Phone").is_none());
    }

    #[test]
    fn showing_the_qr_again_keeps_the_same_code() {
        let store = TokenStore::ephemeral();
        let first = store.new_code(false);
        assert_eq!(first, store.new_code(false));
        assert_ne!(first, store.new_code(true));
    }

    #[test]
    fn tokens_are_unique_and_hashed() {
        assert_ne!(random_token(), random_token());
        let t = random_token();
        assert_ne!(hash(&t), t);
        assert_eq!(hash(&t), hash(&t));
    }
}
