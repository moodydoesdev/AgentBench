//! Files sent to an agent from a browser or phone. The browser never has a
//! path Claude could read, so the bytes land in a temp file here and the
//! composer hands Claude that path instead — any file type, not just images.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Cloudflare's free plan rejects request bodies over 100 MB anyway, so a
/// larger cap would only fail later and less clearly.
pub const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;

/// Write `bytes` under a fresh directory as `name` (sanitized) and return the
/// absolute path. Each upload gets its own directory so the original file
/// name survives — Claude reads more from `report.pdf` than from a stamp.
pub fn save_upload(name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err("file too large (max 100 MB)".into());
    }

    let root = std::env::temp_dir().join("agentbench-uploads");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    prune_old(&root);

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = root.join(format!("{stamp}-{seq}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// A file name that is safe to paste unquoted into a prompt or a shell: no
/// separators, no spaces, no leading dot.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut out: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    out = out.trim_start_matches('.').to_string();
    if out.len() > 120 {
        // keep the extension when trimming a very long name
        let ext = out.rfind('.').map(|i| out[i..].to_string()).unwrap_or_default();
        out = format!("{}{}", &out[..120 - ext.len().min(20)], &ext[..ext.len().min(20)]);
    }
    if out.is_empty() || out.chars().all(|c| c == '_' || c == '.') {
        "upload".into()
    } else {
        out
    }
}

/// Drop upload directories older than a day so temp doesn't grow unbounded.
fn prune_old(root: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in rd.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age.as_secs() > 24 * 3600)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_flattened_and_pasteable() {
        assert_eq!(safe_name("My Report (v2).pdf"), "My_Report__v2_.pdf");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\x\\notes.txt"), "notes.txt");
        assert_eq!(safe_name(".env"), "env");
        assert_eq!(safe_name(""), "upload");
        assert_eq!(safe_name("日本.csv"), "__.csv");
        assert!(safe_name(&"a".repeat(300)).len() <= 120);
    }

    #[test]
    fn upload_round_trips() {
        let p = save_upload("hello world.txt", b"hi").unwrap();
        assert!(p.ends_with("hello_world.txt"));
        assert_eq!(std::fs::read(&p).unwrap(), b"hi");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }
}
