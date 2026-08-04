//! Tokens this gateway holds for *other* benches.
//!
//! Direction matters here. `gateway-tokens.json` records devices allowed
//! *into* this machine (hashed — we verify, never present them). This file
//! records machines this bench can reach *out* to, so the tokens are stored
//! as issued: they are client credentials, the same thing a phone keeps in
//! localStorage. It is written by exactly one flow — a link-back received
//! from another bench during pairing — and read by the desktop app over the
//! loopback control channel, which merges it into its own machine list.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub fn links_file() -> PathBuf {
    crate::broker::config_dir().join("gateway-links.json")
}

pub struct Links {
    list: Mutex<Vec<Value>>,
    /// `None` means in-memory only (tests).
    path: Option<PathBuf>,
}

impl Links {
    pub fn load() -> Links {
        let list: Vec<Value> = std::fs::read_to_string(links_file())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Links {
            list: Mutex::new(list),
            path: Some(links_file()),
        }
    }

    #[cfg(test)]
    fn ephemeral() -> Links {
        Links {
            list: Mutex::new(Vec::new()),
            path: None,
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let list = self.list.lock().unwrap();
        if let Ok(text) = serde_json::to_string_pretty(&*list) {
            let _ = std::fs::write(path, text);
        }
    }

    /// Record (or refresh) a link. One entry per URL: re-linking the same
    /// machine replaces its token instead of growing the list.
    pub fn add(&self, url: &str, token: &str, machine: &str) {
        let entry = json!({
            "url": url,
            "token": token,
            "machine": machine,
            "kind": "bench",
            "linkedAt": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        {
            let mut list = self.list.lock().unwrap();
            list.retain(|l| l["url"].as_str() != Some(url));
            list.push(entry);
        }
        self.persist();
    }

    pub fn forget(&self, url: &str) -> bool {
        let removed = {
            let mut list = self.list.lock().unwrap();
            let before = list.len();
            list.retain(|l| l["url"].as_str() != Some(url));
            list.len() != before
        };
        if removed {
            self.persist();
        }
        removed
    }

    pub fn list_json(&self) -> Value {
        json!(*self.list.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relinking_replaces_rather_than_duplicates() {
        let links = Links::ephemeral();
        links.add("http://100.1.2.3:8473", "tok-a", "MAC");
        links.add("http://100.1.2.3:8473", "tok-b", "MAC");
        let list = links.list_json();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["token"], "tok-b");
    }

    #[test]
    fn forget_removes_only_the_named_machine() {
        let links = Links::ephemeral();
        links.add("http://a:8473", "tok-a", "A");
        links.add("http://b:8473", "tok-b", "B");
        assert!(links.forget("http://a:8473"));
        assert!(!links.forget("http://a:8473"));
        assert_eq!(links.list_json().as_array().unwrap().len(), 1);
    }
}
