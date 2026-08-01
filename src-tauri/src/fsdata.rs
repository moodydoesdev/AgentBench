//! Filesystem-backed reads shared by the Tauri commands and the mobile
//! gateway. These never touch the broker — they read Claude Code's own
//! transcript layout, project plan folders, and the project registry — so both
//! processes call the same implementation instead of keeping two in sync.

use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// Where the desktop app mirrors its project registry so other processes
/// (the gateway) can read it. Desktop-owned: the gateway never writes here.
pub fn projects_file() -> PathBuf {
    crate::broker::config_dir().join("projects.json")
}

/// The registry as written by the desktop app: [{ path, name, color?,
/// commands?, previewPort?, captureTargets? }]. Empty when the desktop has
/// never run (or predates the mirror).
pub fn read_projects() -> Vec<Value> {
    std::fs::read_to_string(projects_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default()
}

pub fn write_projects(projects: &Value) -> Result<(), String> {
    let dir = crate::broker::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    std::fs::write(projects_file(), text).map_err(|e| e.to_string())
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read a plan MDX file for the plan pane. Returns content + mtime (ms) so
/// the frontend can cheaply poll for changes.
pub fn read_plan(path: &str) -> Result<Value, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(json!({ "content": content, "mtime": mtime_ms(Path::new(path)) }))
}

/// A project's plan documents (.agentbench/plans/*/plan.mdx) for the plans
/// rail. Title comes from the first `# ` heading; newest first.
pub fn list_plans(project: &str) -> Value {
    let dir = Path::new(project).join(".agentbench").join("plans");
    let mut out: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let plan = entry.path().join("plan.mdx");
            if !plan.is_file() {
                continue;
            }
            let title = std::fs::read_to_string(&plan)
                .ok()
                .and_then(|c| {
                    c.lines()
                        .find(|l| l.starts_with("# "))
                        .map(|l| l[2..].trim().to_string())
                })
                .filter(|t| !t.is_empty());
            out.push(json!({
                "path": plan.to_string_lossy(),
                "slug": entry.file_name().to_string_lossy(),
                "title": title,
                "mtime": mtime_ms(&plan),
            }));
        }
    }
    out.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
    json!(out)
}

/// description: from SKILL.md / command frontmatter, first match wins
fn frontmatter_desc(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines()
        .take(40)
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| {
            let d = d.trim().trim_matches('"');
            d.chars().take(120).collect()
        })
}

/// Slash commands available to a Claude session in `project`, for the chat
/// composer's autocomplete: user + project custom commands (.claude/commands
/// /*.md) and skills (.claude/skills/*/SKILL.md). Built-ins live frontend-side.
pub fn list_slash_commands(project: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();

    let mut push_commands = |dir: PathBuf, source: &str| {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("md") {
                    if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
                        out.push(json!({
                            "name": stem,
                            "desc": frontmatter_desc(&p),
                            "source": source,
                        }));
                    }
                }
            }
        }
    };
    let home = dirs::home_dir().unwrap_or_default();
    let proj = Path::new(project);
    push_commands(home.join(".claude").join("commands"), "user");
    push_commands(proj.join(".claude").join("commands"), "project");

    let mut push_skills = |dir: PathBuf, source: &str| {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let skill = e.path().join("SKILL.md");
                if skill.is_file() {
                    if let Some(name) = e.file_name().to_str() {
                        out.push(json!({
                            "name": name,
                            "desc": frontmatter_desc(&skill),
                            "source": source,
                        }));
                    }
                }
            }
        }
    };
    push_skills(home.join(".claude").join("skills"), "skill");
    push_skills(proj.join(".claude").join("skills"), "skill");

    out
}

/// first human-authored user line — skips harness plumbing (<tag>…, Caveat:)
fn preview_of(path: &Path) -> (Option<String>, u64) {
    let Ok(f) = std::fs::File::open(path) else {
        return (None, 0);
    };
    let mut msgs = 0u64;
    let mut preview = None;
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        msgs += 1;
        if preview.is_some() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if rec["type"].as_str() != Some("user") || rec["isMeta"].as_bool() == Some(true) {
            continue;
        }
        let text = match &rec["message"]["content"] {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .find_map(|b| {
                    (b["type"] == "text").then(|| b["text"].as_str().unwrap_or("").to_string())
                })
                .unwrap_or_default(),
            _ => String::new(),
        };
        let t = text.trim_start();
        if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
            continue;
        }
        preview = Some(t.chars().take(140).collect::<String>());
    }
    (preview, msgs)
}

/// Claude Code's project-dir slug: cwd with every non-alphanumeric char
/// replaced by '-'.
fn cwd_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// A human name for a session, for clients that cannot see the terminal title.
///
/// Claude Code writes `ai-title` records into the transcript — the same short
/// summary the desktop shows — and refines them as the session goes on, so the
/// last one wins. Falling back to the first thing the user actually typed
/// still beats a pane number.
///
/// Transcripts run to megabytes, and this is called for every pane, so it
/// reads a bounded window from each end rather than the whole file.
pub fn session_title(cwd: &str, sid: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 256 * 1024;
    const HEAD: usize = 64 * 1024;

    let path = dirs::home_dir()?
        .join(".claude")
        .join("projects")
        .join(cwd_slug(cwd))
        .join(format!("{sid}.jsonl"));
    let mut f = std::fs::File::open(&path).ok()?;
    let len = f.metadata().ok()?.len();

    // newest title first: scan the tail
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let mut title = None;
    for line in text.lines() {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(t) = v["aiTitle"].as_str().filter(|t| !t.trim().is_empty()) {
                title = Some(t.trim().to_string());
            }
        }
    }
    if title.is_some() {
        return title;
    }

    // no title yet — use the opening message, minus harness plumbing
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut head = vec![0u8; HEAD];
    let read = f.read(&mut head).ok()?;
    for line in String::from_utf8_lossy(&head[..read]).lines() {
        let Ok(rec) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if rec["type"].as_str() != Some("user") || rec["isMeta"].as_bool() == Some(true) {
            continue;
        }
        let text = match &rec["message"]["content"] {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .find_map(|b| {
                    (b["type"] == "text").then(|| b["text"].as_str().unwrap_or("").to_string())
                })
                .unwrap_or_default(),
            _ => String::new(),
        };
        let t = text.trim();
        if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") || t.starts_with('/') {
            continue;
        }
        return Some(t.chars().take(60).collect());
    }
    None
}

/// The newest transcript in a project, for naming a pane when the broker has
/// not reported a session id.
///
/// Only safe when the project has a single pane: with several agents in one
/// directory there is no way to tell whose transcript this is, and a confident
/// wrong label is worse than none. A broker that reports session ids (see
/// `list_panes`) makes this unnecessary.
pub fn newest_session_id(cwd: &str) -> Option<String> {
    let dir = dirs::home_dir()?
        .join(".claude")
        .join("projects")
        .join(cwd_slug(cwd));
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(sid) = path.file_stem().and_then(|x| x.to_str()).map(String::from) else {
            continue;
        };
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(b, _)| mtime > *b) {
            best = Some((mtime, sid));
        }
    }
    best.map(|(_, sid)| sid)
}

/// Run one git command in `cwd` with no console window, returning stdout on
/// success. Any failure — git missing, not a repo, bad cwd — reads as None.
fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Working-tree state of a project, phone-shaped: branch, changed files, and
/// one unified diff (unstaged + staged), capped so a huge refactor doesn't
/// push megabytes at a phone on cellular.
pub fn git_changes(cwd: &str) -> Result<Value, String> {
    if cwd.is_empty() || !Path::new(cwd).is_dir() {
        return Err("no such directory".into());
    }
    let Some(status) = run_git(cwd, &["status", "--porcelain=v1", "-b", "--no-renames"]) else {
        return Ok(json!({ "git": false }));
    };
    let mut branch = None;
    let mut files: Vec<Value> = Vec::new();
    for line in status.lines() {
        if let Some(b) = line.strip_prefix("## ") {
            branch = Some(b.split("...").next().unwrap_or(b).to_string());
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        files.push(json!({
            "status": line[..2].trim(),
            "path": line[3..].to_string(),
        }));
    }
    const CAP: usize = 200 * 1024;
    let mut diff = run_git(cwd, &["diff", "--no-color"]).unwrap_or_default();
    if let Some(staged) = run_git(cwd, &["diff", "--cached", "--no-color"]) {
        if !staged.trim().is_empty() {
            if !diff.trim().is_empty() {
                diff.push('\n');
            }
            diff.push_str(&staged);
        }
    }
    let truncated = diff.len() > CAP;
    if truncated {
        let mut end = CAP;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        diff.truncate(end);
    }
    Ok(json!({
        "git": true,
        "branch": branch,
        "files": files,
        "diff": diff,
        "truncated": truncated,
    }))
}

/// Token totals for one session transcript, summed from the usage block each
/// assistant record carries. Cost is only present when the harness wrote a
/// result record (headless runs); token counts are always derivable.
pub fn session_stats(project: &str, sid: &str) -> Result<Value, String> {
    // sid becomes a filename component — refuse anything path-shaped
    if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad session id".into());
    }
    let path = dirs::home_dir()
        .ok_or("no home dir")?
        .join(".claude")
        .join("projects")
        .join(cwd_slug(project))
        .join(format!("{sid}.jsonl"));
    let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let (mut input, mut output, mut cache_read, mut cache_write) = (0u64, 0u64, 0u64, 0u64);
    let mut turns = 0u64;
    let mut model: Option<String> = None;
    let mut cost: Option<f64> = None;
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        // cheap pre-filter: parsing every record of a megabyte transcript is
        // what this call must not do
        if !line.contains("\"usage\"") && !line.contains("total_cost_usd") {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if rec["type"] == "assistant" {
            let u = &rec["message"]["usage"];
            input += u["input_tokens"].as_u64().unwrap_or(0);
            output += u["output_tokens"].as_u64().unwrap_or(0);
            cache_read += u["cache_read_input_tokens"].as_u64().unwrap_or(0);
            cache_write += u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            turns += 1;
            if let Some(m) = rec["message"]["model"].as_str() {
                model = Some(m.to_string());
            }
        }
        if let Some(c) = rec["total_cost_usd"].as_f64() {
            cost = Some(cost.unwrap_or(0.0) + c);
        }
    }
    Ok(json!({
        "sid": sid,
        "inputTokens": input,
        "outputTokens": output,
        "cacheReadTokens": cache_read,
        "cacheWriteTokens": cache_write,
        "turns": turns,
        "model": model,
        "costUsd": cost,
    }))
}

/// The agent's closing words in a session, for a notification body that says
/// what happened instead of only that something did. Tail-bounded like
/// `session_title` — this runs on every push.
pub fn last_assistant_text(cwd: &str, sid: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 192 * 1024;
    let path = dirs::home_dir()?
        .join(".claude")
        .join("projects")
        .join(cwd_slug(cwd))
        .join(format!("{sid}.jsonl"));
    let mut f = std::fs::File::open(&path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let mut last: Option<String> = None;
    for line in text.lines() {
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if rec["type"].as_str() != Some("assistant") {
            continue;
        }
        let t = match &rec["message"]["content"] {
            Value::Array(blocks) => blocks
                .iter()
                .rev()
                .find_map(|b| {
                    (b["type"] == "text")
                        .then(|| b["text"].as_str().unwrap_or("").trim().to_string())
                })
                .unwrap_or_default(),
            Value::String(s) => s.trim().to_string(),
            _ => String::new(),
        };
        if !t.is_empty() {
            last = Some(t);
        }
    }
    last.map(|t| {
        let clipped: String = t.chars().take(160).collect();
        if t.chars().count() > 160 {
            format!("{clipped}…")
        } else {
            clipped
        }
    })
}

/// Resumable Claude sessions for a project: scan its transcript dir
/// (~/.claude/projects/<slug>/*.jsonl) and return { sid, mtime, preview, msgs }
/// newest-first, so the UI can offer "resume a previous session". The slug is
/// Claude Code's own: every non-alphanumeric char in cwd replaced by '-'.
pub fn list_sessions(project: &str) -> Vec<Value> {
    let slug: String = project
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(slug);

    let mut out: Vec<(std::time::SystemTime, Value)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(sid) = p.file_stem().and_then(|x| x.to_str()).map(String::from) else {
            continue;
        };
        let meta = e.metadata().ok();
        let mtime = meta.as_ref().and_then(|m| m.modified().ok());
        let mtime_ms = mtime
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let (preview, msgs) = preview_of(&p);
        // an empty transcript (0 messages) can't be resumed to anything useful
        if msgs == 0 {
            continue;
        }
        out.push((
            mtime.unwrap_or(std::time::UNIX_EPOCH),
            json!({ "sid": sid, "mtime": mtime_ms, "preview": preview, "msgs": msgs }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, v)| v).collect()
}
