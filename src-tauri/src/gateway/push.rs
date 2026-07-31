//! Web Push to paired phones.
//!
//! The point of the mobile app is not having to watch it. A phone that is
//! asleep in a pocket should be told when an agent finishes or gets stuck, and
//! that means a real push through the browser's push service rather than
//! anything this process can do while the app is closed.
//!
//! Keys are generated once and kept beside the device tokens: the private half
//! signs the VAPID assertion, and the public half is handed to the app so its
//! subscription is bound to this machine and no other.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use web_push_native::{
    jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair},
    p256::elliptic_curve::{sec1::ToEncodedPoint, PublicKey},
    Auth, WebPushBuilder,
};

/// Push services reject anonymous senders, so VAPID wants a contact. Nothing
/// is sent anywhere else and no mail is expected; it identifies the sender if a
/// service ever needs to complain about volume.
const VAPID_CONTACT: &str = "mailto:agentbench@localhost";

fn keys_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-push.json")
}

fn subs_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-push-subs.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn b64(bytes: &[u8]) -> String {
    use base64ct::{Base64UrlUnpadded, Encoding};
    Base64UrlUnpadded::encode_string(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    use base64ct::{Base64UrlUnpadded, Encoding};
    Base64UrlUnpadded::decode_vec(text.trim()).ok()
}

/// One browser's push subscription. `endpoint` is the push service URL the
/// browser handed us; the keys encrypt payloads so the service itself cannot
/// read them.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    /// The browser's public key (base64url, uncompressed P-256 point).
    pub p256dh: String,
    /// The subscription's auth secret (base64url, 16 bytes).
    pub auth: String,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub created: u64,
    /// Set when the push service says the subscription is gone, so a dead
    /// endpoint is not retried forever.
    #[serde(default)]
    pub failed: bool,
}

#[derive(Debug)]
enum SendError {
    /// The subscription is permanently gone; stop retrying it.
    Gone(u16),
    Failed(String),
}

pub struct Push {
    /// PKCS#8 DER of the VAPID signing key, base64url.
    private: String,
    public_key: String,
    subs: Mutex<Vec<Subscription>>,
    client: reqwest::Client,
}

impl Push {
    /// Load the VAPID key pair, generating one on first use.
    pub fn load() -> Push {
        let stored: Option<Value> = std::fs::read_to_string(keys_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let (private, public_key) = match stored
            .as_ref()
            .and_then(|v| Some((v["private"].as_str()?, v["public"].as_str()?)))
        {
            Some((private, public)) => (private.to_string(), public.to_string()),
            None => {
                let pair = ES256KeyPair::generate();
                let private = b64(&pair.to_bytes());
                // The uncompressed SEC1 point (65 bytes) — a browser rejects
                // the compressed form as an applicationServerKey.
                let public = b64(&pair.public_key().public_key().to_bytes_uncompressed());
                let _ = std::fs::create_dir_all(crate::broker::config_dir());
                let _ = std::fs::write(
                    keys_file(),
                    serde_json::to_string_pretty(&json!({
                        "private": private,
                        "public": public,
                    }))
                    .unwrap(),
                );
                (private, public)
            }
        };
        let subs: Vec<Subscription> = std::fs::read_to_string(subs_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Push {
            private,
            public_key,
            subs: Mutex::new(subs),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
        }
    }

    /// The application server key the browser needs to subscribe.
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    fn persist(&self) {
        let subs = self.subs.lock().unwrap();
        let _ = std::fs::create_dir_all(crate::broker::config_dir());
        if let Ok(text) = serde_json::to_string_pretty(&*subs) {
            let _ = std::fs::write(subs_file(), text);
        }
    }

    /// Record a subscription, replacing any earlier one with the same endpoint
    /// (browsers hand out a fresh subscription rather than a duplicate).
    pub fn subscribe(&self, sub: Value, device: &str) -> Result<(), String> {
        let endpoint = sub["endpoint"]
            .as_str()
            .filter(|e| e.starts_with("https://"))
            .ok_or("subscription needs an https endpoint")?;
        let p256dh = sub["keys"]["p256dh"]
            .as_str()
            .ok_or("subscription missing p256dh")?;
        let auth = sub["keys"]["auth"]
            .as_str()
            .ok_or("subscription missing auth")?;
        if unb64(p256dh).is_none() || unb64(auth).is_none() {
            return Err("subscription keys are not base64url".into());
        }
        let mut subs = self.subs.lock().unwrap();
        subs.retain(|s| s.endpoint != endpoint);
        subs.push(Subscription {
            endpoint: endpoint.to_string(),
            p256dh: p256dh.to_string(),
            auth: auth.to_string(),
            device: device.to_string(),
            created: now_ms(),
            failed: false,
        });
        drop(subs);
        self.persist();
        Ok(())
    }

    pub fn unsubscribe(&self, endpoint: &str) {
        let mut subs = self.subs.lock().unwrap();
        subs.retain(|s| s.endpoint != endpoint);
        drop(subs);
        self.persist();
    }

    pub fn list(&self) -> Value {
        let subs = self.subs.lock().unwrap();
        json!(subs
            .iter()
            .map(|s| json!({
                "device": s.device,
                "created": s.created,
                "failed": s.failed,
                // the endpoint is a capability URL; only enough to tell them apart
                "service": s.endpoint.split('/').nth(2).unwrap_or_default(),
            }))
            .collect::<Vec<_>>())
    }

    pub fn count(&self) -> usize {
        self.subs.lock().unwrap().iter().filter(|s| !s.failed).count()
    }

    /// Deliver one notification to every live subscription.
    ///
    /// Returns what each push service said. "Send a test" surfaces this: a
    /// notification that never arrives is otherwise completely silent, and the
    /// answer is almost always in the service's reply.
    pub async fn notify(&self, payload: &Value) -> Value {
        let targets: Vec<Subscription> = {
            let subs = self.subs.lock().unwrap();
            subs.iter().filter(|s| !s.failed).cloned().collect()
        };
        if targets.is_empty() {
            return json!([]);
        }
        let body = payload.to_string();
        let mut gone: Vec<String> = Vec::new();
        let mut results = Vec::new();
        for sub in targets {
            let service = sub.endpoint.split('/').nth(2).unwrap_or_default().to_string();
            match self.send_one(&sub, body.clone()).await {
                Ok(status) => results.push(json!({ "service": service, "status": status })),
                // The push service says this subscription no longer exists —
                // the app was uninstalled, or the browser rotated it.
                Err(SendError::Gone(status)) => {
                    gone.push(sub.endpoint.clone());
                    results.push(json!({ "service": service, "status": status, "gone": true }));
                }
                Err(SendError::Failed(e)) => {
                    eprintln!("push to {}: {e}", sub.device);
                    results.push(json!({ "service": service, "error": e }));
                }
            }
        }
        if !gone.is_empty() {
            let mut subs = self.subs.lock().unwrap();
            for s in subs.iter_mut() {
                if gone.contains(&s.endpoint) {
                    s.failed = true;
                }
            }
            drop(subs);
            self.persist();
        }
        json!(results)
    }

    /// Build the signed, encrypted request for one subscription. Split out so
    /// a test can decrypt exactly what would go on the wire.
    fn build_request(
        &self,
        sub: &Subscription,
        body: String,
    ) -> Result<http::Request<Vec<u8>>, SendError> {
        let fail = |e: String| SendError::Failed(e);
        let key_bytes = unb64(&self.private).ok_or_else(|| fail("bad stored key".into()))?;
        let pair = ES256KeyPair::from_bytes(&key_bytes).map_err(|e| fail(e.to_string()))?;
        let ua_public = PublicKey::from_sec1_bytes(
            &unb64(&sub.p256dh).ok_or_else(|| fail("bad p256dh".into()))?,
        )
        .map_err(|e| fail(e.to_string()))?;
        let auth_bytes = unb64(&sub.auth).ok_or_else(|| fail("bad auth".into()))?;
        if auth_bytes.len() != 16 {
            return Err(fail("auth secret must be 16 bytes".into()));
        }
        let ua_auth = Auth::clone_from_slice(&auth_bytes);

        let request = WebPushBuilder::new(
            sub.endpoint
                .parse()
                .map_err(|_| fail("bad endpoint".into()))?,
            ua_public,
            ua_auth,
        )
        .with_valid_duration(Duration::from_secs(12 * 3600))
        .with_vapid(&pair, VAPID_CONTACT)
        .build(body)
        .map_err(|e| fail(e.to_string()))?;

        Ok(request)
    }

    /// Ok(status) on acceptance; `Gone` when the subscription is dead.
    async fn send_one(&self, sub: &Subscription, body: String) -> Result<u16, SendError> {
        let fail = |e: String| SendError::Failed(e);
        let request = self.build_request(sub, body)?;
        let (parts, payload) = request.into_parts();
        let mut req = self
            .client
            .post(parts.uri.to_string())
            .body::<Vec<u8>>(payload);
        for (name, value) in parts.headers.iter() {
            req = req.header(name.as_str(), value.as_bytes());
        }
        let res = req.send().await.map_err(|e| fail(e.to_string()))?;
        let status = res.status().as_u16();
        // 404/410 are the standard "this subscription is dead" answers
        if status == 404 || status == 410 {
            return Err(SendError::Gone(status));
        }
        if !(200..300).contains(&status) {
            let text = res.text().await.unwrap_or_default();
            return Err(fail(format!(
                "push service returned {status}: {}",
                text.trim().chars().take(200).collect::<String>()
            )));
        }
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscriptions_must_be_well_formed() {
        let push = Push {
            private: String::new(),
            public_key: String::new(),
            subs: Mutex::new(Vec::new()),
            client: reqwest::Client::new(),
        };
        assert!(push.subscribe(json!({}), "phone").is_err());
        // http endpoints are refused: a push endpoint is a capability URL
        assert!(push
            .subscribe(
                json!({ "endpoint": "http://push.example/x", "keys": { "p256dh": "AAA", "auth": "AAA" } }),
                "phone"
            )
            .is_err());
        assert!(push
            .subscribe(
                json!({ "endpoint": "https://push.example/x", "keys": { "auth": "AAA" } }),
                "phone"
            )
            .is_err());
        assert!(push
            .subscribe(
                json!({ "endpoint": "https://push.example/x", "keys": { "p256dh": "!!not base64!!", "auth": "AAA" } }),
                "phone"
            )
            .is_err());
    }

    /// The payload a phone receives has to survive the round trip: the same
    /// keys, the same encoding, the same base64 handling this module uses when
    /// it reads a real browser's subscription. A push that is accepted by the
    /// service but cannot be decrypted is dropped silently by the browser, so
    /// this is the only place the mistake would ever show up.
    #[tokio::test]
    async fn a_notification_survives_encryption() {
        use web_push_native::p256;
        use web_push_native::p256::elliptic_curve::rand_core::{OsRng, RngCore};

        // Stand in for a browser: it keeps a secret key and an auth secret,
        // and publishes the matching public key exactly as `keys.p256dh`.
        let ua_secret = p256::SecretKey::random(&mut OsRng);
        let mut auth_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut auth_bytes);
        let ua_auth = Auth::clone_from_slice(&auth_bytes);

        let push = Push {
            private: b64(&ES256KeyPair::generate().to_bytes()),
            public_key: String::new(),
            subs: Mutex::new(Vec::new()),
            client: reqwest::Client::new(),
        };
        push.subscribe(
            json!({
                "endpoint": "https://push.example/abc",
                "keys": {
                    "p256dh": b64(ua_secret.public_key().as_affine()
                        .to_encoded_point(false).as_bytes()),
                    "auth": b64(&auth_bytes),
                }
            }),
            "phone",
        )
        .unwrap();

        let sub = push.subs.lock().unwrap()[0].clone();
        let payload = json!({ "title": "Agent finished", "body": "in AgentBench" });
        let request = push.build_request(&sub, payload.to_string()).unwrap();

        let decrypted =
            web_push_native::decrypt(request.into_body(), &ua_secret, &ua_auth).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&decrypted).unwrap(),
            payload,
            "what the phone decrypts must be what was sent"
        );
    }

    #[test]
    fn resubscribing_replaces_rather_than_duplicates() {
        let push = Push {
            private: String::new(),
            public_key: String::new(),
            subs: Mutex::new(Vec::new()),
            client: reqwest::Client::new(),
        };
        let sub = json!({
            "endpoint": "https://push.example/abc",
            "keys": { "p256dh": "BBBB", "auth": "AAAA" }
        });
        push.subscribe(sub.clone(), "phone").unwrap();
        push.subscribe(sub, "phone").unwrap();
        assert_eq!(push.count(), 1);
    }
}
