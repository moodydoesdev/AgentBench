//! Build hosts: other machines that build, run and screenshot a project for
//! an agent, without anything showing up on their screens.
//!
//! A build host is just an SSH target. Unlike a remote host it needs no
//! AgentBench daemons, so it can be Linux or a Mac. Each call ships the
//! project's changed files over, runs the work inside
//! `~/.agentbench/builds/projects/<slug>/src` on the host, and brings back
//! whatever the agent asked for: exit code and output, build artifacts, or a
//! PNG it can read.
//!
//! The remote half is `abkit.sh` (and `shot.mjs` for browser captures),
//! uploaded on first use and again whenever their contents change. All the
//! toolchain installs and captures are written there in shell, because that is
//! what is on every build host. This side owns the parts that need to know
//! about the local project: which files to send, which host to use, and where
//! the results land.
//!
//! Agents reach it as `agentbench-build` — a wrapper the desktop app writes
//! into `~/.claude/skills/agentbench-build/` that execs
//! `agentbench-gateway build …`. Run commands with a build host target use the
//! same CLI from a local terminal pane.

pub mod cli;

use crate::remote::{last_json, shell_quote, ssh_base, ssh_script, ssh_with};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const KIT_SH: &str = include_str!("abkit.sh");
const SHOT_MJS: &str = include_str!("shot.mjs");

/// Every kit the provisioner knows. Matches the `kit_*` functions in abkit.sh.
pub const KITS: &[&str] = &["web", "linux", "android", "ios", "mac"];

const EXEC_TIMEOUT: Duration = Duration::from_secs(60);

/// `.agentbench/build.json` in a project. Every field is optional: a project
/// with no file builds with whatever the host already has.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildConfig {
    /// Preferred build host (an entry from the registry, or any SSH target).
    pub host: Option<String>,
    /// mise tool specs put on PATH for every run: `node@22`, `rust@stable`,
    /// `java@temurin-21`, `python@3.12`, `go@1.23` …
    pub tools: Vec<String>,
    /// System packages the build needs (`libwebkit2gtk-4.1-dev`). Installed
    /// only when the host allows passwordless sudo; otherwise reported.
    pub packages: Vec<String>,
    /// Capture kits to provision: web, linux, android, ios, mac.
    pub kits: Vec<String>,
    /// Paths/globs under the project brought back after a successful run.
    pub artifacts: Vec<String>,
    /// Paths/globs never sent to the host, on top of .gitignore.
    pub exclude: Vec<String>,
    /// Secret-looking files the build genuinely needs (`.env.production`).
    /// Everything matching `SECRETS` stays home unless listed here.
    pub include: Vec<String>,
    /// Extra environment for runs and captures.
    pub env: BTreeMap<String, String>,
}

/// A local project as the build host sees it.
#[derive(Debug, Clone)]
pub struct Project {
    pub root: PathBuf,
    pub slug: String,
    pub config: BuildConfig,
}

impl Project {
    /// The project containing `dir`: the nearest folder with a
    /// `.agentbench/build.json`, else the git root, else `dir` itself.
    pub fn find(dir: &Path) -> Result<Project, String> {
        let dir = dir
            .canonicalize()
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        let root = dir
            .ancestors()
            .find(|d| d.join(".agentbench").join("build.json").is_file())
            .map(Path::to_path_buf)
            .or_else(|| git_root(&dir))
            .unwrap_or(dir);
        let config = read_config(&root)?;
        let slug = slug_for(&root);
        Ok(Project { root, slug, config })
    }

    /// `--tools` for abkit.sh: the mise specs, space separated.
    fn tools_arg(&self) -> String {
        self.config.tools.join(" ")
    }

    fn env_args(&self) -> Vec<String> {
        self.config
            .env
            .iter()
            .flat_map(|(k, v)| ["--env".to_string(), format!("{k}={v}")])
            .collect()
    }
}

fn git_root(dir: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty()).then(|| PathBuf::from(p))
}

fn read_config(root: &Path) -> Result<BuildConfig, String> {
    let path = root.join(".agentbench").join("build.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(_) => Ok(BuildConfig::default()),
    }
}

/// Folder name plus a short hash of the full path: readable on the host, and
/// two checkouts both called `app` never share a tree.
pub fn slug_for(root: &Path) -> String {
    let name: String = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let name = name.trim_matches('-');
    let hash = &crate::gateway::tokens::hash(&root.to_string_lossy())[..8];
    format!("{}-{hash}", if name.is_empty() { "project" } else { name })
}

// ---------------------------------------------------------------- registry

/// One saved build host. Lives in `build-hosts.json` next to the remote hosts,
/// so the desktop's Settings and the CLI agents run read the same list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildHost {
    pub host: String,
    pub os: String,
    pub arch: String,
    pub cores: u64,
    pub mem_mb: u64,
    pub sudo: bool,
    /// kit → ready | missing | unsupported, from the last probe or provision.
    pub kits: BTreeMap<String, String>,
    /// kit → what a person still has to do, from the last provision.
    pub needs: BTreeMap<String, String>,
}

fn hosts_file() -> PathBuf {
    crate::broker::config_dir().join("build-hosts.json")
}

pub fn list_hosts() -> Vec<BuildHost> {
    std::fs::read_to_string(hosts_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_hosts(hosts: &[BuildHost]) -> Result<(), String> {
    let _ = std::fs::create_dir_all(crate::broker::config_dir());
    let text = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    std::fs::write(hosts_file(), text).map_err(|e| e.to_string())
}

fn upsert_host(entry: BuildHost) -> Result<(), String> {
    let mut hosts = list_hosts();
    match hosts.iter_mut().find(|h| h.host == entry.host) {
        Some(h) => *h = entry,
        None => hosts.push(entry),
    }
    save_hosts(&hosts)
}

/// Probe a host and save it. Safe to repeat: it refreshes the saved facts.
pub fn add_host(host: &str) -> Result<BuildHost, String> {
    let host = check_target(host)?;
    let mut entry = probe(&host)?;
    if let Some(old) = list_hosts().into_iter().find(|h| h.host == host) {
        entry.needs = old.needs;
    }
    upsert_host(entry.clone())?;
    Ok(entry)
}

/// An SSH target goes on ssh's command line, so one starting with `-` would be
/// read as an option (`-oProxyCommand=…`). Refuse that and whitespace.
fn check_target(host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || host.starts_with('-') || host.contains(char::is_whitespace) {
        return Err(format!("{host:?} is not an SSH target; use user@host or a Host alias"));
    }
    Ok(host.to_string())
}

pub fn remove_host(host: &str) -> Result<(), String> {
    let mut hosts = list_hosts();
    hosts.retain(|h| h.host != host);
    save_hosts(&hosts)
}

/// Pick the host for a project: an explicit choice, then
/// `AGENTBENCH_BUILD_HOST`, then the project's `host`, then the only (or
/// first) saved one.
pub fn resolve_host(explicit: Option<&str>, project: &Project) -> Result<String, String> {
    pick_host(explicit, project).and_then(|h| check_target(&h))
}

fn pick_host(explicit: Option<&str>, project: &Project) -> Result<String, String> {
    if let Some(h) = explicit.filter(|h| !h.trim().is_empty()) {
        return Ok(h.trim().to_string());
    }
    if let Ok(h) = std::env::var("AGENTBENCH_BUILD_HOST") {
        if !h.trim().is_empty() {
            return Ok(h.trim().to_string());
        }
    }
    if let Some(h) = project.config.host.as_deref().filter(|h| !h.trim().is_empty()) {
        return Ok(h.trim().to_string());
    }
    list_hosts().into_iter().next().map(|h| h.host).ok_or_else(|| {
        "no build host yet. Add one in Settings → Build hosts, or run: \
         agentbench-build add user@host"
            .to_string()
    })
}

// ---------------------------------------------------------------- remote kit

/// Remote command line that runs abkit.sh with `args`, each one quoted.
fn kit(args: &[String]) -> String {
    let mut line = String::from(r#"bash "$HOME/.agentbench/builds/bin/abkit.sh""#);
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    line
}

fn kit_version() -> String {
    crate::gateway::tokens::hash(&format!("{KIT_SH}\0{SHOT_MJS}"))[..16].to_string()
}

/// Upload abkit.sh and shot.mjs unless the host already has this version.
/// One round trip when they are current.
pub fn ensure_kit(host: &str) -> Result<(), String> {
    let want = kit_version();
    let check = format!(
        r#"set -u
v="$(cat "$HOME/.agentbench/builds/bin/.kit" 2>/dev/null || true)"
printf '{{"current":%s}}\n' "$([ "$v" = "{want}" ] && echo true || echo false)""#
    );
    if last_json(&ssh_script(host, &check, EXEC_TIMEOUT)?)?["current"] == json!(true) {
        return Ok(());
    }
    // Quoted heredoc delimiters: nothing inside is expanded by the remote
    // shell, so the files land byte for byte.
    let upload = format!(
        "set -eu\nd=\"$HOME/.agentbench/builds/bin\"\nmkdir -p \"$d\"\n\
         cat > \"$d/abkit.sh.new\" <<'ABKIT_EOF_7c1f'\n{KIT_SH}\nABKIT_EOF_7c1f\n\
         cat > \"$d/shot.mjs.new\" <<'ABKIT_EOF_7c1f'\n{SHOT_MJS}\nABKIT_EOF_7c1f\n\
         mv \"$d/abkit.sh.new\" \"$d/abkit.sh\"\nmv \"$d/shot.mjs.new\" \"$d/shot.mjs\"\n\
         chmod +x \"$d/abkit.sh\"\nprintf '%s' '{want}' > \"$d/.kit\"\nprintf '{{\"ok\":true}}\\n'\n"
    );
    last_json(&ssh_script(host, &upload, EXEC_TIMEOUT)?).map(|_| ())
}

/// Run a kit subcommand and return its last JSON line. stderr (download
/// progress, install chatter) is passed to `on_log` line by line.
fn kit_json(
    host: &str,
    args: &[String],
    stdin: Option<Vec<u8>>,
    mut on_line: impl FnMut(&str, bool),
) -> Result<Value, String> {
    let mut child = ssh_base(host)
        .arg(kit(args))
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run ssh: {e}"))?;
    if let Some(bytes) = stdin {
        let mut pipe = child.stdin.take().ok_or("no stdin on ssh")?;
        std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    // stderr on its own thread so a chatty install cannot fill the pipe and
    // stall the child while we are blocked reading stdout.
    let err = child.stderr.take().ok_or("no stderr on ssh")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let err_thread = std::thread::spawn(move || {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let mut stdout = String::new();
    let out = child.stdout.take().ok_or("no stdout on ssh")?;
    let mut tail: Vec<String> = Vec::new();
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        while let Ok(e) = rx.try_recv() {
            on_line(&e, true);
            tail.push(e);
        }
        on_line(&line, false);
        stdout.push_str(&line);
        stdout.push('\n');
    }
    let _ = err_thread.join();
    for e in rx.try_iter() {
        on_line(&e, true);
        tail.push(e);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let start = tail.len().saturating_sub(12);
        let detail = tail[start..].join("\n");
        return Err(if detail.trim().is_empty() {
            format!("the build host failed ({status})\n{}", stdout.trim())
        } else {
            detail
        });
    }
    last_json(&stdout)
}

/// What the host is and which kits are ready.
pub fn probe(host: &str) -> Result<BuildHost, String> {
    ensure_kit(host)?;
    let v = kit_json(host, &["probe".into()], None, |_, _| {})?;
    let os = v["os"].as_str().unwrap_or_default().to_string();
    if os != "Linux" && os != "Darwin" {
        return Err(format!("{host} runs {os}; build hosts are Linux or macOS"));
    }
    Ok(BuildHost {
        host: host.to_string(),
        os,
        arch: v["arch"].as_str().unwrap_or_default().to_string(),
        cores: v["cores"].as_u64().unwrap_or(0),
        mem_mb: v["memMb"].as_u64().unwrap_or(0),
        sudo: v["sudo"].as_bool().unwrap_or(false),
        kits: v["kits"]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, s)| (k.clone(), s.as_str().unwrap_or_default().to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        needs: BTreeMap::new(),
    })
}

/// Install mise, any toolchains and packages, and the capture kits. Each
/// report line goes to `on_line` as it arrives; the saved host entry is
/// updated with what is now ready and what still needs a person.
pub fn provision(
    host: &str,
    kits: &[String],
    tools: &[String],
    packages: &[String],
    mut on_line: impl FnMut(&str, bool),
) -> Result<BuildHost, String> {
    for k in kits {
        if !KITS.contains(&k.as_str()) {
            return Err(format!("unknown kit {k}; choose from {}", KITS.join(", ")));
        }
    }
    ensure_kit(host)?;
    let mut args = vec!["provision".to_string(), "--kits".into(), kits.join(",")];
    if !tools.is_empty() {
        args.extend(["--tools".into(), tools.join(" ")]);
    }
    if !packages.is_empty() {
        args.extend(["--pkgs".into(), packages.join(" ")]);
    }
    let v = kit_json(host, &args, None, &mut on_line)?;
    let mut entry = probe(host)?;
    if let Some(old) = list_hosts().into_iter().find(|h| h.host == host) {
        entry.needs = old.needs;
    }
    if let Some(results) = v["kits"].as_object() {
        for (kit, r) in results {
            match r["status"].as_str() {
                Some("needs") | Some("failed") => {
                    entry.needs.insert(
                        kit.clone(),
                        r["detail"].as_str().unwrap_or_default().to_string(),
                    );
                }
                _ => {
                    entry.needs.remove(kit);
                }
            }
        }
    }
    upsert_host(entry.clone())?;
    Ok(entry)
}

// ---------------------------------------------------------------- sync

/// (size, mtime seconds) — enough to spot a changed file without hashing.
type Stamp = (u64, i64);

/// Files to send, relative to the root with `/` separators. Git decides when
/// it can (tracked plus untracked-but-not-ignored), so `node_modules`,
/// `target` and everything else in .gitignore stays home.
fn project_files(project: &Project) -> Result<BTreeMap<String, Stamp>, String> {
    let root = &project.root;
    let listed = Command::new("git")
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .current_dir(root)
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            o.stdout
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
                .map(|p| String::from_utf8_lossy(p).to_string())
                .collect::<Vec<_>>()
        });
    let paths = match listed {
        Some(p) => p,
        None => walk(root),
    };
    let mut files = BTreeMap::new();
    for rel in paths {
        if skipped(&rel, &project.config) {
            continue;
        }
        // Tracked files deleted from the work tree still appear in ls-files.
        let Ok(meta) = std::fs::symlink_metadata(root.join(&rel)) else {
            continue;
        };
        if meta.is_dir() {
            continue; // a submodule; its contents are not ours to send
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        files.insert(rel, (meta.len(), mtime));
    }
    Ok(files)
}

/// Folder walk for a project that is not a git repo. Skips the usual
/// dependency and output folders so a first sync is not gigabytes.
fn walk(root: &Path) -> Vec<String> {
    const SKIP: &[&str] = &[
        ".git", "node_modules", "target", "dist", "build", ".next", ".venv", "venv",
        "__pycache__", ".gradle", "Pods", "DerivedData",
    ];
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out
}

/// Files that look like credentials. Usually gitignored, but an untracked,
/// unignored `.env` would otherwise ride along to every build host.
const SECRETS: &[&str] = &[
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks",
    "*.mobileprovision", "id_rsa*", "id_ed25519*", "id_ecdsa*", ".npmrc", ".netrc",
    "credentials.json", "service-account*.json",
];

/// Never sent: our own outputs, secrets not explicitly included, and the
/// project's `exclude` list.
fn skipped(rel: &str, config: &BuildConfig) -> bool {
    const OURS: &[&str] = &[".agentbench/shots/", ".agentbench/artifacts/", ".agentbench/plans/"];
    if OURS.iter().any(|p| rel.starts_with(p)) || config.exclude.iter().any(|p| glob_match(p, rel)) {
        return true;
    }
    let secret = SECRETS.iter().any(|p| glob_match(p, rel));
    secret && !config.include.iter().any(|p| glob_match(p, rel))
}

/// Small glob: `*` and `?` within a path segment, `**` across segments. A
/// pattern without a slash matches a file or folder name anywhere; a pattern
/// that names a folder covers everything inside it.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim().trim_start_matches("./").trim_end_matches('/');
    if pattern.is_empty() {
        return false;
    }
    if !pattern.contains('/') {
        return path.split('/').any(|seg| seg_match(pattern.as_bytes(), seg.as_bytes()));
    }
    let pat: Vec<&str> = pattern.split('/').collect();
    let segs: Vec<&str> = path.split('/').collect();
    // a folder pattern matches anything under it
    (1..=segs.len()).any(|n| parts_match(&pat, &segs[..n]))
}

fn parts_match(pat: &[&str], segs: &[&str]) -> bool {
    match pat.first() {
        None => segs.is_empty(),
        Some(&"**") => (0..=segs.len()).any(|i| parts_match(&pat[1..], &segs[i..])),
        Some(p) => {
            !segs.is_empty()
                && seg_match(p.as_bytes(), segs[0].as_bytes())
                && parts_match(&pat[1..], &segs[1..])
        }
    }
}

fn seg_match(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => seg_match(&p[1..], s) || (!s.is_empty() && seg_match(p, &s[1..])),
        (Some(b'?'), Some(_)) => seg_match(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => seg_match(&p[1..], &s[1..]),
        _ => false,
    }
}

#[derive(Debug, Default)]
pub struct SyncStats {
    pub sent: usize,
    pub deleted: usize,
    pub unchanged: usize,
    pub bytes: u64,
}

/// Bring the host's copy of the project in line with the local one.
///
/// The host keeps a manifest of what it last received. Only files whose size
/// or mtime differ travel, as one gzipped tar over the existing SSH
/// connection; files gone locally are deleted there. Build outputs the host
/// made itself (target/, node_modules/) are never in the manifest, so they
/// survive between runs and builds stay incremental.
pub fn sync(host: &str, project: &Project) -> Result<SyncStats, String> {
    ensure_kit(host)?;
    let local = project_files(project)?;
    let remote_raw = ssh_base(host)
        .arg(kit(&["manifest".into(), project.slug.clone()]))
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("cannot run ssh: {e}"))?;
    if !remote_raw.status.success() {
        return Err(String::from_utf8_lossy(&remote_raw.stderr).trim().to_string());
    }
    let remote: HashMap<String, Stamp> =
        serde_json::from_slice(&remote_raw.stdout).unwrap_or_default();

    let changed: Vec<&String> = local
        .iter()
        .filter(|(p, s)| remote.get(*p) != Some(*s))
        .map(|(p, _)| p)
        .collect();
    let deleted: Vec<&String> = remote.keys().filter(|p| !local.contains_key(*p)).collect();
    let mut stats = SyncStats {
        sent: changed.len(),
        deleted: deleted.len(),
        unchanged: local.len() - changed.len(),
        bytes: changed.iter().map(|p| local[*p].0).sum(),
    };

    if !changed.is_empty() {
        send_tar(host, project, &changed)?;
    }
    if !deleted.is_empty() {
        let mut list = Vec::new();
        for p in &deleted {
            list.extend_from_slice(p.as_bytes());
            list.push(0);
        }
        kit_json_raw(host, &["prune".into(), project.slug.clone()], list)?;
    }
    if !changed.is_empty() || !deleted.is_empty() || remote.is_empty() {
        let manifest = serde_json::to_vec(&local).map_err(|e| e.to_string())?;
        kit_json_raw(host, &["put-manifest".into(), project.slug.clone()], manifest)?;
    }
    if stats.sent == 0 && stats.deleted == 0 {
        stats.bytes = 0;
    }
    Ok(stats)
}

/// A kit subcommand fed `stdin`, ignoring its stdout.
fn kit_json_raw(host: &str, args: &[String], stdin: Vec<u8>) -> Result<(), String> {
    let mut child = ssh_base(host)
        .arg(kit(args))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run ssh: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin on ssh")?
        .write_all(&stdin)
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `tar -cz` of `files` piped straight into `ssh … unpack`. The system tar is
/// on every platform we run on (bsdtar on macOS and Windows, GNU on Linux),
/// and both read a NUL-separated list from stdin.
fn send_tar(host: &str, project: &Project, files: &[&String]) -> Result<(), String> {
    let mut tar = Command::new("tar")
        .args(["-czf", "-", "--null", "-T", "-"])
        .current_dir(&project.root)
        // macOS tar would otherwise add AppleDouble `._*` entries for xattrs.
        .env("COPYFILE_DISABLE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run tar: {e}"))?;
    let tar_out = tar.stdout.take().ok_or("no stdout on tar")?;
    let ssh = ssh_base(host)
        .arg(kit(&["unpack".into(), project.slug.clone()]))
        .stdin(Stdio::from(tar_out))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run ssh: {e}"))?;
    let mut list = Vec::new();
    for f in files {
        list.extend_from_slice(f.as_bytes());
        list.push(0);
    }
    let mut stdin = tar.stdin.take().ok_or("no stdin on tar")?;
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&list);
    });
    let ssh_out = ssh.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    let tar_res = tar.wait_with_output().map_err(|e| e.to_string())?;
    if !tar_res.status.success() {
        return Err(format!(
            "tar failed: {}",
            String::from_utf8_lossy(&tar_res.stderr).trim()
        ));
    }
    if !ssh_out.status.success() {
        return Err(format!(
            "unpacking on {host} failed: {}",
            String::from_utf8_lossy(&ssh_out.stderr).trim()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- run

/// Run `command` in the project's folder on the host, streaming its output to
/// ours. Returns the remote exit code. With `tty`, ssh gets a terminal so
/// colours, progress bars and Ctrl-C behave as they would locally.
pub fn run(host: &str, project: &Project, command: &str, tty: bool) -> Result<i32, String> {
    let mut args = vec![
        "run".to_string(),
        "--slug".into(),
        project.slug.clone(),
        "--tools".into(),
        project.tools_arg(),
    ];
    args.extend(project.env_args());
    args.push("--".into());
    args.push(command.to_string());
    let flags: &[&str] = if tty { &["-tt"] } else { &[] };
    let status = ssh_with(host, flags)
        .arg(kit(&args))
        .stdin(if tty { Stdio::inherit() } else { Stdio::null() })
        .status()
        .map_err(|e| format!("cannot run ssh: {e}"))?;
    Ok(status.code().unwrap_or(1))
}

/// Pack files matching `patterns` on the host and unpack them under `dest`.
/// Returns the paths written, relative to `dest`.
///
/// The archive comes from another machine, so it is treated as untrusted: it
/// lands in a temp file first and every entry is checked before anything is
/// extracted. Absolute paths, `..` and links of any kind are refused outright,
/// so a compromised build host cannot write outside `dest`.
pub fn pull(host: &str, project: &Project, patterns: &[String], dest: &Path) -> Result<Vec<String>, String> {
    let mut args = vec!["pack".to_string(), project.slug.clone()];
    args.extend(patterns.iter().cloned());
    let staging = std::env::temp_dir().join(format!(
        "agentbench-pull-{}-{}.tar",
        std::process::id(),
        chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let file = std::fs::File::create(&staging).map_err(|e| e.to_string())?;
    let ssh = ssh_base(host)
        .arg(kit(&args))
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("cannot run ssh: {e}"));
    let result = ssh.and_then(|out| {
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let entries = checked_entries(&staging)?;
        if entries.is_empty() {
            return Ok(entries);
        }
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        let x = Command::new("tar")
            .arg("-xf")
            .arg(&staging)
            .current_dir(dest)
            .output()
            .map_err(|e| format!("cannot run tar: {e}"))?;
        if !x.status.success() {
            return Err(format!("unpacking failed: {}", String::from_utf8_lossy(&x.stderr).trim()));
        }
        Ok(entries)
    });
    let _ = std::fs::remove_file(&staging);
    result
}

/// The regular files in a tar, or an error naming the first entry that could
/// land outside the extraction folder.
fn checked_entries(tar: &Path) -> Result<Vec<String>, String> {
    let verbose = Command::new("tar")
        .arg("-tvf")
        .arg(tar)
        .output()
        .map_err(|e| format!("cannot run tar: {e}"))?;
    let names = Command::new("tar")
        .arg("-tf")
        .arg(tar)
        .output()
        .map_err(|e| format!("cannot run tar: {e}"))?;
    if !verbose.status.success() || !names.status.success() {
        return Err("the build host sent an archive tar cannot read".into());
    }
    let modes: Vec<char> = String::from_utf8_lossy(&verbose.stdout)
        .lines()
        .filter_map(|l| l.chars().next())
        .collect();
    let names: Vec<String> = String::from_utf8_lossy(&names.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    if modes.len() != names.len() {
        return Err("could not verify the archive from the build host".into());
    }
    let mut files = Vec::new();
    for (mode, name) in modes.iter().zip(&names) {
        let unsafe_path = name.starts_with('/')
            || name.starts_with('\\')
            || name.get(1..2) == Some(":")
            || name.split(['/', '\\']).any(|seg| seg == "..");
        if unsafe_path {
            return Err(format!("refused: the build host sent a path outside the project ({name})"));
        }
        match mode {
            '-' => files.push(name.trim_start_matches("./").to_string()),
            'd' => {}
            _ => {
                return Err(format!(
                    "refused: the build host sent a link or special file ({name}); \
                     only regular files and folders are copied back"
                ))
            }
        }
    }
    Ok(files)
}

// ---------------------------------------------------------------- shots

/// Where a capture runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShotMode {
    /// A URL in a headless browser on the host.
    Web,
    /// A Linux desktop app on a private Xvfb display.
    Linux,
    /// An iOS app (.app) or URL in a windowless simulator. macOS hosts.
    Ios,
    /// An .apk, package or URL in a windowless emulator.
    Android,
    /// A macOS .app inside a Tart VM. Apple Silicon hosts.
    Mac,
}

impl ShotMode {
    fn sub(self) -> &'static str {
        match self {
            ShotMode::Web => "shot-web",
            ShotMode::Linux => "shot-app",
            ShotMode::Ios => "shot-ios",
            ShotMode::Android => "shot-android",
            ShotMode::Mac => "shot-mac",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ShotOptions {
    /// URL, command, .app, .apk or package — whatever the mode captures.
    pub target: String,
    pub serve: Option<String>,
    pub url: Option<String>,
    pub size: Option<String>,
    pub full: bool,
    pub wait: Option<String>,
    pub delay: Option<u64>,
    pub browser: Option<String>,
    pub device: Option<String>,
    pub appearance: Option<String>,
    pub steps: Vec<String>,
    /// Short label for the file name.
    pub name: Option<String>,
}

pub struct Shot {
    pub path: PathBuf,
    pub notes: String,
}

/// Capture a screenshot on the host and copy it into
/// `<project>/.agentbench/shots/`.
pub fn shot(host: &str, project: &Project, mode: ShotMode, o: &ShotOptions) -> Result<Shot, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let label: String = o
        .name
        .clone()
        .unwrap_or_else(|| format!("{mode:?}").to_lowercase())
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(40)
        .collect();
    let file = format!("{stamp}-{label}.png");

    let mut args = vec![
        mode.sub().to_string(),
        "--slug".into(),
        project.slug.clone(),
        "--tools".into(),
        project.tools_arg(),
        "--out".into(),
        file.clone(),
    ];
    args.extend(project.env_args());
    let t = o.target.clone();
    match mode {
        ShotMode::Web => args.extend(["--url".into(), t]),
        ShotMode::Linux | ShotMode::Mac => args.extend(["--app".into(), t]),
        ShotMode::Ios => {
            if t.contains("://") {
                args.extend(["--url".into(), t]);
            } else if !t.is_empty() {
                args.extend(["--app".into(), t]);
            }
        }
        ShotMode::Android => {
            if t.contains("://") {
                args.extend(["--url".into(), t]);
            } else if t.ends_with(".apk") {
                args.extend(["--app".into(), t]);
            } else if !t.is_empty() {
                args.extend(["--package".into(), t]);
            }
        }
    }
    let pairs = [
        ("--serve", &o.serve),
        ("--size", &o.size),
        ("--wait", &o.wait),
        ("--browser", &o.browser),
        ("--device", &o.device),
        ("--appearance", &o.appearance),
    ];
    for (flag, v) in pairs {
        if let Some(v) = v {
            args.extend([flag.to_string(), v.clone()]);
        }
    }
    // a URL alongside an app (ios/android deep link) or for --serve readiness
    if let Some(u) = &o.url {
        if mode != ShotMode::Web {
            args.extend(["--url".into(), u.clone()]);
        }
    }
    if o.full {
        args.push("--full".into());
    }
    if let Some(d) = o.delay {
        args.extend(["--delay".into(), d.to_string()]);
    }
    for s in &o.steps {
        args.extend(["--do".into(), s.clone()]);
    }

    // The host's progress and errors stream to stderr as they happen, so a
    // failure only needs a one-line summary afterwards.
    let v = kit_json(host, &args, None, |line, is_err| {
        if is_err {
            eprintln!("{line}");
        }
    })
    .map_err(|_| "the capture failed (details above)".to_string())?;
    let remote_path = v["path"].as_str().ok_or("the host reported no screenshot")?;

    let dir = project.root.join(".agentbench").join("shots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let local = dir.join(&file);
    fetch(host, remote_path, &local)?;
    Ok(Shot {
        path: local,
        notes: v["notes"].as_str().unwrap_or_default().to_string(),
    })
}

/// Copy one file off the host.
fn fetch(host: &str, remote: &str, local: &Path) -> Result<(), String> {
    let mut child = ssh_base(host)
        .arg(format!("cat {}", shell_quote(remote)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run ssh: {e}"))?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or("no stdout on ssh")?
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() || bytes.is_empty() {
        return Err(format!(
            "could not copy {remote} back: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    std::fs::write(local, bytes).map_err(|e| e.to_string())
}

/// Shut down simulators, emulators and VMs kept warm between captures.
pub fn stop(host: &str) -> Result<(), String> {
    ensure_kit(host)?;
    kit_json(host, &["stop".into()], None, |_, _| {}).map(|_| ())
}

/// Delete the host's copy of a project. Toolchains and caches stay.
pub fn clean(host: &str, project: &Project) -> Result<(), String> {
    ensure_kit(host)?;
    kit_json(host, &["clean".into(), project.slug.clone()], None, |_, _| {}).map(|_| ())
}

/// Registry entry as JSON for the desktop's Settings.
pub fn describe(h: &BuildHost) -> Value {
    serde_json::to_value(h).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_names_anywhere() {
        assert!(glob_match("*.psd", "art/raw/logo.psd"));
        assert!(glob_match("fixtures", "tests/fixtures/big.bin"));
        assert!(!glob_match("*.psd", "art/logo.png"));
    }

    #[test]
    fn glob_matches_paths_and_folders() {
        assert!(glob_match("assets/video", "assets/video/a.mp4"));
        assert!(glob_match("assets/**/*.mp4", "assets/x/y/a.mp4"));
        assert!(glob_match("assets/**/*.mp4", "assets/a.mp4"));
        assert!(!glob_match("assets/video", "src/assets/video/a.mp4"));
        assert!(glob_match("./docs/", "docs/a.md"));
    }

    #[test]
    fn our_own_outputs_are_never_sent() {
        let c = BuildConfig::default();
        assert!(skipped(".agentbench/shots/a.png", &c));
        assert!(skipped(".agentbench/artifacts/h/1/app.dmg", &c));
        assert!(!skipped(".agentbench/build.json", &c));
    }

    #[test]
    fn secrets_stay_home_unless_included() {
        let mut c = BuildConfig::default();
        assert!(skipped(".env", &c));
        assert!(skipped("apps/web/.env.local", &c));
        assert!(skipped("certs/server.key", &c));
        assert!(skipped("android/release.keystore", &c));
        assert!(!skipped("src/environment.ts", &c));
        c.include = vec![".env.production".into()];
        assert!(!skipped(".env.production", &c));
        assert!(skipped(".env.local", &c));
    }

    /// Tars built with the system tar, checked the way `pull` checks them.
    fn tar_of(build: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentbench-tartest-{}-{}",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join("w")).unwrap();
        let out = Command::new("bash")
            .arg("-c")
            .arg(format!("cd w && {build}"))
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        dir.join("t.tar")
    }

    #[test]
    fn pulled_archives_with_links_or_escapes_are_refused() {
        let ok = tar_of("mkdir -p out && echo hi > out/a.txt && tar -cf ../t.tar out");
        assert_eq!(checked_entries(&ok).unwrap(), vec!["out/a.txt"]);

        let link = tar_of("ln -s /etc/passwd evil && tar -cf ../t.tar evil");
        assert!(checked_entries(&link).unwrap_err().contains("link"));

        // bsdtar and GNU tar both store `..` verbatim with -P
        let escape = tar_of("mkdir -p a && echo x > a/f && tar -P -cf ../t.tar a/../a/f");
        assert!(checked_entries(&escape).unwrap_err().contains("outside"));
    }

    #[test]
    fn slug_is_readable_and_path_specific() {
        let a = slug_for(Path::new("/Users/me/Code/My App"));
        let b = slug_for(Path::new("/Users/me/Other/My App"));
        assert!(a.starts_with("My-App-"), "{a}");
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn kit_args_are_quoted() {
        let line = kit(&["run".into(), "--".into(), "npm run build && echo 'done'".into()]);
        assert_eq!(
            line,
            r#"bash "$HOME/.agentbench/builds/bin/abkit.sh" 'run' '--' 'npm run build && echo '\''done'\'''"#
        );
    }

    #[test]
    fn config_fields_are_optional() {
        let c: BuildConfig = serde_json::from_str(r#"{"tools":["node@22"]}"#).unwrap();
        assert_eq!(c.tools, vec!["node@22"]);
        assert!(c.host.is_none() && c.artifacts.is_empty());
    }

    #[test]
    fn add_host_rejects_option_injection() {
        assert!(add_host("-oProxyCommand=evil").is_err());
        assert!(add_host("a b").is_err());
    }
}
