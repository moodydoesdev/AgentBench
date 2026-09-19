//! Codex rollout discovery. The originator marker ties a transcript to a
//! specific broker/pane; cwd or newest-file guesses mix concurrent agents.
use super::Core;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::atomic::Ordering,
};

pub(super) fn originator(port: u16, id: u32) -> String {
    format!("agentbench-{port}-{id}")
}

pub(super) fn transcript(core: &Core, id: u32, cwd: &str) -> Option<String> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| core.home_dir.join(".codex"))
        .join("sessions");
    let marker = originator(core.hook_port.load(Ordering::SeqCst) as u16, id);
    let spawned = core.panes.lock().unwrap().get(&id)?.spawned;
    let cutoff = chrono::DateTime::<chrono::Utc>::from(spawned)
        .format("%Y/%m/%d")
        .to_string();
    let mut dirs = vec![root.clone()];
    let mut best = None;
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                // Rollouts use YYYY/MM/DD. Skip historical date trees.
                let rel = path
                    .strip_prefix(&root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel.len() <= cutoff.len() && rel.as_str() >= &cutoff[..rel.len()] {
                    dirs.push(path);
                }
                continue;
            }
            if !kind.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(born) = meta.created().or_else(|_| meta.modified()) else {
                continue;
            };
            if born < spawned {
                continue;
            }
            let Ok(file) = std::fs::File::open(&path) else {
                continue;
            };
            let Some(Ok(line)) = BufReader::new(file).lines().next() else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if matches_session(&record, &marker, cwd)
                && best.as_ref().is_none_or(|(time, _)| born > *time)
            {
                best = Some((born, path.to_string_lossy().into_owned()));
            }
        }
    }
    best.map(|(_, path)| path)
}

fn matches_session(record: &Value, marker: &str, cwd: &str) -> bool {
    record["type"] == "session_meta"
        && record["payload"]["source"] == "cli"
        && record["payload"]["originator"] == marker
        && record["payload"]["cwd"] == cwd
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_adopts_another_panes_session() {
        let r = serde_json::json!({"type":"session_meta", "payload":{
            "originator":"agentbench-123-4", "cwd":"/project", "source":"cli"}});
        assert!(matches_session(&r, "agentbench-123-4", "/project"));
        assert!(!matches_session(&r, "agentbench-123-5", "/project"));
        assert!(!matches_session(&r, "agentbench-123-4", "/other"));
        let mut subagent = r.clone();
        subagent["payload"]["source"] = serde_json::json!({"subagent": {"thread_spawn": {}}});
        assert!(!matches_session(&subagent, "agentbench-123-4", "/project"));
    }
}
