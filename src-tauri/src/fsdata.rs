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
    let list = std::fs::read_to_string(projects_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default();
    normalize_projects(list)
}

/// Hand-typed paths (web/phone "Add project") arrive as `~/…`; expand them so
/// one directory is one project — a `~` twin gets its own pane set and its
/// sessions land under a different slug than the absolute entry's.
fn normalize_projects(list: Vec<Value>) -> Vec<Value> {
    let mut index = std::collections::HashMap::new();
    let mut out: Vec<Value> = Vec::with_capacity(list.len());
    for mut p in list {
        let Some(path) = p["path"].as_str().map(str::to_owned) else {
            out.push(p);
            continue;
        };
        let full = crate::broker::expand_home(&path);
        p["path"] = json!(full);
        match index.get(&full) {
            // Duplicate of an earlier entry: keep whichever carries more
            // detail (commands, color, …) — a `~` twin is usually the bare
            // hand-typed one, but sidebar order doesn't guarantee it.
            Some(&i) => {
                let keys = |v: &Value| v.as_object().map_or(0, |o| o.len());
                if keys(&p) > keys(&out[i]) {
                    out[i] = p;
                }
            }
            None => {
                index.insert(full, out.len());
                out.push(p);
            }
        }
    }
    out
}

pub fn write_projects(projects: &Value) -> Result<(), String> {
    let dir = crate::broker::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let list = projects.as_array().cloned().unwrap_or_default();
    let text = serde_json::to_string_pretty(&normalize_projects(list)).map_err(|e| e.to_string())?;
    std::fs::write(projects_file(), text).map_err(|e| e.to_string())
}

/// One level of folders for the phone's "Add project" browser: the phone has
/// no picker for the workstation's disk, and typing absolute paths on a phone
/// keyboard is miserable. Dotfolders are left out; `~` expands to home.
pub fn list_dirs(path: &str) -> Result<Value, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let dir = browse_path(&home, path);
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        // metadata() follows symlinks, so a linked code folder still shows
        .filter(|e| std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    Ok(json!({
        "path": dir,
        "parent": dir.parent(),
        "home": home,
        "git": dir.join(".git").exists(),
        "dirs": names,
    }))
}

/// `""`/`~` is home and `~/…` expands; anything else is taken as typed.
fn browse_path(home: &Path, path: &str) -> PathBuf {
    let path = path.trim();
    if path.is_empty() || path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}

/// "New folder" in the phone's project browser: one new folder directly
/// inside `parent`, then that folder's listing so the browser steps into it.
/// The name is a single segment — no separators or `..` — so this can't
/// reach anywhere the browser wasn't already showing.
pub fn make_dir(parent: &str, name: &str) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(format!("Not a valid folder name: {name:?}"));
    }
    let home = dirs::home_dir().unwrap_or_default();
    let dir = browse_path(&home, parent);
    if !dir.is_dir() {
        return Err(format!("{}: not a folder", dir.display()));
    }
    let target = dir.join(name);
    std::fs::create_dir(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{name} already exists"),
        _ => format!("{}: {e}", target.display()),
    })?;
    list_dirs(&target.to_string_lossy())
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

fn teams_file(project: &str) -> PathBuf {
    Path::new(project).join(".agentbench").join("teams.json")
}

/// A project's saved agent teams (.agentbench/teams.json). A missing file is
/// an empty list; an unreadable one is an error, so a save can never clobber
/// a file the user is hand-editing.
pub fn read_teams(project: &str) -> Result<Value, String> {
    let path = teams_file(project);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "version": 1, "teams": [] }))
        }
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Replace the teams file. Written to a temp file and renamed so a crash
/// mid-write leaves the old file intact — this file is meant to be committed.
pub fn write_teams(project: &str, teams: &Value) -> Result<(), String> {
    if !Path::new(project).is_dir() {
        return Err(format!("{project} is not a folder"));
    }
    let path = teams_file(project);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut text = serde_json::to_string_pretty(teams).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
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

/// All text blocks of a transcript record's message, joined. Handles both the
/// string and block-array content shapes.
fn message_text(rec: &Value) -> String {
    match &rec["message"]["content"] {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| (b["type"] == "text").then(|| b["text"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Harness plumbing dressed as a user message, not something a human typed.
fn is_noise_user_text(t: &str) -> bool {
    t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:")
}

fn clip(text: &str, max: usize) -> String {
    let clipped: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        format!("{clipped}…")
    } else {
        clipped
    }
}

struct SessionScan {
    /// first human-authored user line — skips harness plumbing (<tag>…, Caveat:)
    preview: Option<String>,
    msgs: u64,
    /// Claude's own ai-title records (the same short summary the terminal
    /// title shows); refined as the session goes, so the last one wins.
    title: Option<String>,
    /// the agent's closing words — "what happened", not just "something did"
    last_text: Option<String>,
}

fn scan_session(path: &Path) -> SessionScan {
    let mut scan = SessionScan {
        preview: None,
        msgs: 0,
        title: None,
        last_text: None,
    };
    let Ok(f) = std::fs::File::open(path) else {
        return scan;
    };
    // Cheap contains() prefilters + parse-at-end keep this from JSON-parsing
    // every record of a megabyte transcript: candidate lines are only carried
    // as raw strings and parsed once the scan is over. A small tail of
    // assistant candidates is kept because the substring match can hit
    // non-assistant records (someone typing the word "assistant").
    let mut title_line: Option<String> = None;
    let mut assistant_tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        scan.msgs += 1;
        if line.contains("\"ai-title\"") {
            title_line = Some(line);
            continue;
        }
        let is_candidate = line.contains("\"assistant\"");
        if scan.preview.is_none() {
            if let Ok(rec) = serde_json::from_str::<Value>(&line) {
                if rec["type"].as_str() == Some("user")
                    && rec["isMeta"].as_bool() != Some(true)
                {
                    let text = message_text(&rec);
                    let t = text.trim_start();
                    if !is_noise_user_text(t) {
                        scan.preview = Some(t.chars().take(140).collect());
                    }
                }
            }
        }
        if is_candidate {
            assistant_tail.push_back(line);
            if assistant_tail.len() > 5 {
                assistant_tail.pop_front();
            }
        }
    }
    if let Some(l) = title_line {
        if let Ok(v) = serde_json::from_str::<Value>(&l) {
            if let Some(t) = v["aiTitle"].as_str().filter(|t| !t.trim().is_empty()) {
                scan.title = Some(t.trim().to_string());
            }
        }
    }
    for l in assistant_tail.iter().rev() {
        let Ok(rec) = serde_json::from_str::<Value>(l) else {
            continue;
        };
        if rec["type"].as_str() != Some("assistant") {
            continue;
        }
        let text = message_text(&rec);
        let t = text.trim();
        if !t.is_empty() {
            scan.last_text = Some(clip(t, 160));
            break;
        }
    }
    scan
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
/// Where Claude Code keeps per-session scratch, including background tasks'
/// live output: <tmp>/claude-<uid>/<cwd-slug>/<session>/tasks/<task>.output.
#[cfg(not(unix))]
fn claude_tmp_roots() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(unix)]
fn claude_tmp_roots() -> Vec<PathBuf> {
    let uid = unsafe { libc::getuid() };
    let mut roots: Vec<PathBuf> = Vec::new();
    for base in [PathBuf::from("/private/tmp"), PathBuf::from("/tmp"), std::env::temp_dir()] {
        if let Ok(root) = base.join(format!("claude-{uid}")).canonicalize() {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    roots
}

/// The live output file of one of a session's background tasks.
pub fn task_output_path(cwd: &str, sid: &str, task: &str) -> Option<String> {
    let name = format!("{task}.output");
    if task.is_empty() || task.contains(['/', '.']) {
        return None;
    }
    let roots = claude_tmp_roots();
    for root in &roots {
        let direct = root.join(cwd_slug(cwd)).join(sid).join("tasks").join(&name);
        if direct.is_file() {
            return Some(direct.to_string_lossy().into_owned());
        }
    }
    // The slug scheme is Claude Code's to change; fall back to looking in
    // every project and session directory for the task.
    for root in &roots {
        for project in std::fs::read_dir(root).into_iter().flatten().flatten() {
            for session in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
                let candidate = session.path().join("tasks").join(&name);
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

/// New bytes of a command's output file from `offset` on, for the dock's log
/// view and the chat's Bash cards to follow. Only output-like files are
/// readable this way — *.output from background tasks, and the *.log / *.txt
/// / *.out an agent redirects a long command into, wherever it put them (it
/// picks /tmp, the scratchpad, or the project). That is no extra reach: a
/// paired device can already fetch any file through read_file_base64 and
/// /api/file; the extension check just keeps this op from being a general
/// reader. A file that shrank (rewritten) restarts from
/// the top; a first read of a big file starts near its end.
pub fn tail_output(path: &str, offset: u64) -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom};
    const FIRST: u64 = 256 * 1024;
    const CHUNK: u64 = 1024 * 1024;
    let real = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    let allowed = real
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "output" | "log" | "txt" | "out"));
    if !allowed {
        return Err("not a Claude Code output file".into());
    }
    let mut f = std::fs::File::open(&real).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut from = if offset > len { 0 } else { offset };
    if from == 0 && len > FIRST {
        from = len - FIRST;
    }
    f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    f.take(CHUNK).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    // Stop short of a UTF-8 sequence split across reads; the rest comes next time.
    let keep = match std::str::from_utf8(&raw) {
        Ok(_) => raw.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => raw.len(),
    };
    raw.truncate(keep);
    Ok(json!({
        "data": String::from_utf8_lossy(&raw),
        "offset": from + keep as u64,
        "size": len,
        "restarted": offset > len,
    }))
}

/// Every task on a Claude Code task list (~/.claude/tasks/<list>/<id>.json),
/// in creation order. Teams share one list per team; see `taskListId`.
pub fn task_list(list: &str) -> Vec<Value> {
    let safe: String = list
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let Some(dir) = dirs::home_dir().map(|h| h.join(".claude").join("tasks").join(safe)) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut tasks: Vec<Value> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|t| t["id"].is_string())
        .collect();
    let num = |t: &Value| t["id"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(u64::MAX);
    tasks.sort_by_key(num);
    tasks
}

/// One line on what a session is doing right now, for the team sidebar:
/// its in-progress todo if it keeps a list, else its latest tool call
/// ("Editing App.jsx", "Running tests"), else the start of what it last said
/// or was asked. Reads only the transcript's tail, so it's cheap to poll.
pub fn session_brief(cwd: &str, sid: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 256 * 1024;
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

    let mut latest: Option<String> = None;
    let mut todo: Option<String> = None;
    for line in text.lines() {
        let Ok(rec) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Sub-agent records describe the sub-agent, not this session.
        if rec["isSidechain"] == true || rec["isMeta"] == true {
            continue;
        }
        match rec["type"].as_str() {
            Some("assistant") => {
                let Value::Array(blocks) = &rec["message"]["content"] else {
                    continue;
                };
                for b in blocks {
                    match b["type"].as_str() {
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or("");
                            if name == "TodoWrite" {
                                todo = active_todo(&b["input"]);
                            }
                            latest = Some(describe_tool(name, &b["input"]));
                        }
                        Some("text") => {
                            if let Some(t) = first_line(b["text"].as_str().unwrap_or("")) {
                                latest = Some(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                // A prompt (not a tool result) starts a new turn: until the
                // agent acts on it, "what it's doing" is what it was asked.
                let prompt = match &rec["message"]["content"] {
                    Value::String(s) => Some(s.as_str()),
                    Value::Array(blocks) => blocks
                        .iter()
                        .find(|b| b["type"] == "text")
                        .and_then(|b| b["text"].as_str()),
                    _ => None,
                };
                if let Some(t) = prompt.filter(|t| !is_noise_user_text(t.trim())).and_then(first_line) {
                    latest = Some(format!("Asked: {t}"));
                    todo = None;
                }
            }
            _ => {}
        }
    }
    todo.or(latest)
}

const BRIEF_MAX: usize = 110;

fn active_todo(input: &Value) -> Option<String> {
    input["todos"].as_array()?.iter().find_map(|t| {
        (t["status"] == "in_progress").then(|| {
            t["activeForm"]
                .as_str()
                .or(t["content"].as_str())
                .unwrap_or("")
                .to_string()
        })
    }).filter(|s| !s.is_empty())
}

fn describe_tool(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("").trim().to_string();
    let file = |k: &str| {
        let p = s(k);
        Path::new(&p)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or(p)
    };
    let out = match name {
        "Edit" | "MultiEdit" | "NotebookEdit" => format!("Editing {}", file("file_path")),
        "Write" => format!("Writing {}", file("file_path")),
        "Read" => format!("Reading {}", file("file_path")),
        "Bash" => {
            let d = s("description");
            if d.is_empty() {
                format!("Running {}", s("command"))
            } else {
                d
            }
        }
        "Grep" => format!("Searching for “{}”", s("pattern")),
        "Glob" => format!("Finding {}", s("pattern")),
        "Task" | "Agent" => format!("Delegating: {}", s("description")),
        "WebFetch" => format!("Fetching {}", s("url")),
        "WebSearch" => format!("Searching the web: {}", s("query")),
        "TodoWrite" => "Updating its todo list".to_string(),
        "SendMessage" => "Messaging a teammate".to_string(),
        n if n.starts_with("mcp__") => {
            format!("Using {}", n.rsplit("__").next().unwrap_or(n))
        }
        n => format!("Using {n}"),
    };
    clip(&out, BRIEF_MAX)
}

fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(clip(line.trim_start_matches('#').trim(), BRIEF_MAX))
}

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

/// A project's transcript dir (~/.claude/projects/<slug>) and its .jsonl
/// session files, for the resume pickers.
fn session_files(project: &str) -> Vec<(String, PathBuf, std::time::SystemTime)> {
    let dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(cwd_slug(project));
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(sid) = p.file_stem().and_then(|x| x.to_str()).map(String::from) else {
            continue;
        };
        let mtime = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        out.push((sid, p, mtime));
    }
    out
}

fn mtime_to_ms(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resumable Claude sessions for a project: scan its transcript dir and return
/// { sid, mtime, preview, msgs, title, lastText } newest-first, so the UI can
/// offer "resume a previous session" with enough context to tell them apart.
/// The slug is Claude Code's own: every non-alphanumeric char in cwd → '-'.
pub fn list_sessions(project: &str) -> Vec<Value> {
    let mut out: Vec<(std::time::SystemTime, Value)> = Vec::new();
    for (sid, path, mtime) in session_files(project) {
        let scan = scan_session(&path);
        // an empty transcript (0 messages) can't be resumed to anything useful
        if scan.msgs == 0 {
            continue;
        }
        out.push((
            mtime,
            json!({
                "sid": sid,
                "mtime": mtime_to_ms(mtime),
                "preview": scan.preview,
                "msgs": scan.msgs,
                "title": scan.title,
                "lastText": scan.last_text,
            }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, v)| v).collect()
}

/// A short window of the matched text with the hit roughly centered, ellipsized
/// at both ends. `pos` may come from a lowercased copy, so it is snapped to
/// the nearest char boundary rather than trusted.
fn excerpt_around(text: &str, pos: usize, qlen: usize) -> String {
    const PAD: usize = 70;
    let mut start = pos.saturating_sub(PAD).min(text.len());
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (pos + qlen + PAD).min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let mut s = text[start..end].replace(['\n', '\r'], " ");
    if start > 0 {
        s = format!("…{s}");
    }
    if end < text.len() {
        s.push('…');
    }
    s
}

/// Ripgrep-style content search across a project's session transcripts:
/// case-insensitive substring over what was actually said (user + assistant
/// text — not raw JSON), returning per-session match counts and one
/// highlightable excerpt. Empty query behaves like `list_sessions`.
pub fn search_sessions(project: &str, query: &str) -> Vec<Value> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return list_sessions(project);
    }
    let mut out: Vec<(std::time::SystemTime, Value)> = Vec::new();
    for (sid, path, mtime) in session_files(project) {
        let Ok(f) = std::fs::File::open(&path) else {
            continue;
        };
        let mut msgs = 0u64;
        let mut matches = 0u64;
        let mut title: Option<String> = None;
        let mut excerpt: Option<(String, String)> = None; // (role, text)
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            msgs += 1;
            if line.contains("\"ai-title\"") {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(t) = v["aiTitle"].as_str().filter(|t| !t.trim().is_empty()) {
                        title = Some(t.trim().to_string());
                    }
                }
                continue;
            }
            // cheap prefilter on the raw JSON; the real check runs on the
            // extracted text so structure keys can't fake a hit
            if !line.to_lowercase().contains(&q) {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let role = match rec["type"].as_str() {
                Some("user") if rec["isMeta"].as_bool() != Some(true) => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            let text = message_text(&rec);
            let t = text.trim();
            if role == "user" && is_noise_user_text(t.trim_start()) {
                continue;
            }
            let Some(pos) = t.to_lowercase().find(&q) else {
                continue;
            };
            matches += 1;
            if excerpt.is_none() {
                excerpt = Some((role.to_string(), excerpt_around(t, pos, q.len())));
            }
        }
        if matches == 0 {
            continue;
        }
        let (role, text) = excerpt.unwrap_or_default();
        out.push((
            mtime,
            json!({
                "sid": sid,
                "mtime": mtime_to_ms(mtime),
                "msgs": msgs,
                "matches": matches,
                "title": title,
                "excerpt": text,
                "role": role,
            }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.truncate(60);
    out.into_iter().map(|(_, v)| v).collect()
}

#[cfg(test)]
mod teams_tests {
    use super::*;

    #[test]
    fn teams_round_trip_and_bad_file() {
        let dir = std::env::temp_dir().join(format!("ab-teams-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let project = dir.to_str().unwrap();
        assert_eq!(read_teams(project).unwrap()["teams"], json!([]));
        let v = json!({"version":1,"teams":[{"name":"Hexa","agents":[{"role":"Manager"}]}]});
        write_teams(project, &v).unwrap();
        assert_eq!(read_teams(project).unwrap(), v);
        std::fs::write(teams_file(project), "{oops").unwrap();
        assert!(read_teams(project).is_err());
        assert!(write_teams(dir.join("missing").to_str().unwrap(), &v).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
