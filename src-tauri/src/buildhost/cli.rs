//! `agentbench-build`: the build-host CLI agents and run panes call.
//!
//! Reached as `agentbench-gateway build …`, so it ships inside binaries that
//! already exist on every install. Output is plain text written for an agent
//! to read: what happened, then the paths it can open.

use super::*;
use std::io::IsTerminal;

const USAGE: &str = "agentbench-build — build, run and screenshot this project on a build host

usage: agentbench-build <command> [--host H] [-C DIR] [options]

  hosts                       list build hosts and their capture kits
  add <user@host>             check a host over SSH and save it
  remove <host>               forget a host (nothing on it is deleted)
  provision [--kits a,b]      install mise, this project's tools and packages,
                              and capture kits: web, linux, windows, android,
                              ios, mac
  sync                        send changed files (runs before run/shot anyway)
  run [--no-sync] -- <cmd>    run <cmd> in the project on the host (cmd.exe
                              syntax on Windows hosts); output
                              streams back, exit code is preserved, and
                              build.json \"artifacts\" are copied back after
                              a successful run
  shot <target> [options]     capture a screenshot without showing anything
                              on the host's screen; prints the local PNG path
      --web <url>             headless browser
      --linux <cmd>           Linux desktop app on a private virtual display
      --windows <cmd>         Windows program on a private, never-shown desktop
      --ios <app|url>         iOS simulator (macOS host)
      --android <apk|pkg|url> Android emulator
      --mac <app>             macOS app inside a VM (Apple Silicon host)
      --serve <cmd>           start a server first; --url says when it is up
      --url <url>             readiness URL for --serve, or a deep link
      --size WxH  --full  --wait <selector|window>  --delay <ms>
      --do <step>             repeatable: click:SEL type:SEL=TEXT press:KEY
                              (desktop: click:X,Y type:TEXT key:ctrl+s)
      --device <name>  --appearance dark|light  --browser chromium|webkit
      --name <label>  --no-sync
  pull <glob>...              copy files from the host's copy of the project
  stop                        shut down warm simulators, emulators and VMs
  clean                       delete the host's copy of this project
  where                       show the project root, slug and host

The host is --host, else $AGENTBENCH_BUILD_HOST, else \"host\" in
.agentbench/build.json, else the first saved build host.
";

/// Entry point. Returns the process exit code.
pub fn main(argv: &[String]) -> i32 {
    match dispatch(argv) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("agentbench-build: {e}");
            1
        }
    }
}

struct Args {
    rest: Vec<String>,
}

impl Args {
    /// Remove `--flag value` and return the value.
    fn value(&mut self, flag: &str) -> Result<Option<String>, String> {
        let Some(i) = self.flag_index(flag) else {
            return Ok(None);
        };
        if i + 1 >= self.rest.len() {
            return Err(format!("{flag} needs a value"));
        }
        let v = self.rest.remove(i + 1);
        self.rest.remove(i);
        Ok(Some(v))
    }

    /// Remove every `--flag value` and return the values in order.
    fn values(&mut self, flag: &str) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        while let Some(v) = self.value(flag)? {
            out.push(v);
        }
        Ok(out)
    }

    fn switch(&mut self, flag: &str) -> bool {
        match self.flag_index(flag) {
            Some(i) => {
                self.rest.remove(i);
                true
            }
            None => false,
        }
    }

    /// Only flags before a bare `--` count; everything after it is a command.
    fn flag_index(&self, flag: &str) -> Option<usize> {
        let end = self.rest.iter().position(|a| a == "--").unwrap_or(self.rest.len());
        self.rest[..end].iter().position(|a| a == flag)
    }

    fn after_dashdash(&mut self) -> Option<String> {
        let i = self.rest.iter().position(|a| a == "--")?;
        let cmd = self.rest.split_off(i + 1);
        self.rest.pop();
        Some(cmd.join(" "))
    }
}

fn dispatch(argv: &[String]) -> Result<i32, String> {
    let Some(command) = argv.first() else {
        print!("{USAGE}");
        return Ok(2);
    };
    let mut a = Args { rest: argv[1..].to_vec() };
    if matches!(command.as_str(), "-h" | "--help" | "help") {
        print!("{USAGE}");
        return Ok(0);
    }
    let host_flag = a.value("--host")?;
    let dir = match a.value("-C")? {
        Some(d) => PathBuf::from(d),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };

    match command.as_str() {
        "hosts" => {
            let hosts = list_hosts();
            if a.switch("--json") {
                println!("{}", serde_json::to_string_pretty(&hosts).unwrap_or_default());
                return Ok(0);
            }
            if hosts.is_empty() {
                println!("No build hosts. Add one: agentbench-build add user@host");
            }
            for h in hosts {
                println!("{}  {} {}  {} cores  {} GB", h.host, h.os, h.arch, h.cores, h.mem_mb / 1024);
                for (kit, state) in &h.kits {
                    let need = h.needs.get(kit).map(|n| format!(" — {n}")).unwrap_or_default();
                    println!("    {kit:<8} {state}{need}");
                }
            }
            Ok(0)
        }
        "add" => {
            let target = a.rest.first().cloned().or(host_flag).ok_or("add needs user@host")?;
            eprintln!("checking {target} …");
            let h = add_host(&target)?;
            println!("added {} ({} {}, {} cores)", h.host, h.os, h.arch, h.cores);
            println!("next: agentbench-build provision --host {} --kits web", h.host);
            Ok(0)
        }
        "remove" => {
            let target = a.rest.first().cloned().or(host_flag).ok_or("remove needs a host")?;
            remove_host(&target)?;
            println!("removed {target}");
            Ok(0)
        }
        "where" => {
            let p = Project::find(&dir)?;
            println!("root  {}", p.root.display());
            println!("slug  {}", p.slug);
            match resolve_host(host_flag.as_deref(), &p) {
                Ok(h) => println!("host  {h}  (~/.agentbench/builds/projects/{}/src)", p.slug),
                Err(e) => println!("host  none — {e}"),
            }
            Ok(0)
        }
        "provision" => {
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            let kits: Vec<String> = match a.value("--kits")? {
                Some(k) => k.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                None if !p.config.kits.is_empty() => p.config.kits.clone(),
                None => vec!["web".into()],
            };
            eprintln!("provisioning {host}: {}", kits.join(", "));
            let h = provision(&host, &kits, &p.config.tools, &p.config.packages, print_progress)?;
            println!();
            for (kit, state) in &h.kits {
                println!("{kit:<8} {state}");
            }
            if !h.needs.is_empty() {
                println!("\nStill needs a person on {host}:");
                for (kit, need) in &h.needs {
                    println!("  {kit}: {need}");
                }
            }
            Ok(0)
        }
        "sync" => {
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            report_sync(&host, &sync(&host, &p)?);
            Ok(0)
        }
        "run" => {
            let no_sync = a.switch("--no-sync");
            let no_artifacts = a.switch("--no-artifacts");
            let cmd = a
                .after_dashdash()
                .or_else(|| (!a.rest.is_empty()).then(|| a.rest.join(" ")))
                .filter(|c| !c.trim().is_empty())
                .ok_or("run needs a command: agentbench-build run -- npm run build")?;
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            if !no_sync {
                report_sync(&host, &sync(&host, &p)?);
            } else {
                ensure_kit(&host)?;
            }
            let tty = std::io::stdout().is_terminal() && std::io::stdin().is_terminal();
            eprintln!("[{host}] $ {cmd}");
            let started = std::time::Instant::now();
            let code = run(&host, &p, &cmd, tty)?;
            eprintln!(
                "[{host}] exited {code} after {:.1}s",
                started.elapsed().as_secs_f64()
            );
            if code == 0 && !no_artifacts && !p.config.artifacts.is_empty() {
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
                let dest = p
                    .root
                    .join(".agentbench")
                    .join("artifacts")
                    .join(safe_host(&host))
                    .join(stamp);
                let got = pull(&host, &p, &p.config.artifacts, &dest).map_err(|e| {
                    format!("the build succeeded, but its artifacts were not copied back: {e}")
                })?;
                if got.is_empty() {
                    eprintln!("no artifacts matched {:?}", p.config.artifacts);
                } else {
                    println!("artifacts ({}) in {}", got.len(), dest.display());
                    for f in got.iter().take(20) {
                        println!("  {}", dest.join(f).display());
                    }
                    if got.len() > 20 {
                        println!("  … and {} more", got.len() - 20);
                    }
                }
            }
            Ok(code)
        }
        "shot" => {
            let modes = [
                ("--web", ShotMode::Web),
                ("--linux", ShotMode::Linux),
                ("--app", ShotMode::Linux),
                ("--ios", ShotMode::Ios),
                ("--android", ShotMode::Android),
                ("--mac", ShotMode::Mac),
                ("--windows", ShotMode::Windows),
            ];
            let mut picked = None;
            for (flag, mode) in modes {
                if let Some(v) = a.value(flag)? {
                    if picked.is_some() {
                        return Err("pick one of --web, --linux, --windows, --ios, --android, --mac".into());
                    }
                    picked = Some((mode, v));
                }
            }
            let (mode, target) = picked.ok_or(
                "shot needs a target: --web URL, --linux CMD, --windows CMD, --ios APP|URL, --android APK|PKG|URL or --mac APP",
            )?;
            let o = ShotOptions {
                target,
                serve: a.value("--serve")?,
                url: a.value("--url")?,
                size: a.value("--size")?,
                full: a.switch("--full"),
                wait: a.value("--wait")?,
                delay: a
                    .value("--delay")?
                    .map(|d| d.parse().map_err(|_| "--delay is in milliseconds"))
                    .transpose()?,
                browser: a.value("--browser")?,
                device: a.value("--device")?,
                appearance: a.value("--appearance")?,
                steps: a.values("--do")?,
                name: a.value("--name")?,
            };
            let no_sync = a.switch("--no-sync");
            if let Some(extra) = a.rest.first() {
                return Err(format!("unexpected argument {extra}"));
            }
            // --serve with a web capture: the served URL is what gets captured.
            let mut o = o;
            if mode == ShotMode::Web && o.serve.is_some() && o.url.is_none() {
                o.url = Some(o.target.clone());
            }
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            if !no_sync {
                report_sync(&host, &sync(&host, &p)?);
            } else {
                ensure_kit(&host)?;
            }
            let s = shot(&host, &p, mode, &o)?;
            if !s.notes.trim().is_empty() {
                println!("{}", s.notes.trim());
            }
            println!("screenshot: {}", s.path.display());
            Ok(0)
        }
        "pull" => {
            if a.rest.is_empty() {
                return Err("pull needs at least one path or glob".into());
            }
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            ensure_kit(&host)?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
            let dest = p.root.join(".agentbench").join("artifacts").join(safe_host(&host)).join(stamp);
            let got = pull(&host, &p, &a.rest, &dest)?;
            if got.is_empty() {
                println!("nothing matched");
                return Ok(1);
            }
            for f in got {
                println!("{}", dest.join(f).display());
            }
            Ok(0)
        }
        "stop" => {
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            stop(&host)?;
            println!("stopped warm simulators, emulators and VMs on {host}");
            Ok(0)
        }
        "clean" => {
            let p = Project::find(&dir)?;
            let host = resolve_host(host_flag.as_deref(), &p)?;
            clean(&host, &p)?;
            println!("deleted {} on {host}", p.slug);
            Ok(0)
        }
        other => Err(format!("unknown command {other}\n\n{USAGE}")),
    }
}

/// Provision's live log: the kit's report lines as ticks, its chatter dimmed.
fn print_progress(line: &str, is_err: bool) {
    if is_err {
        eprintln!("  {line}");
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if let Some(kit) = v["kit"].as_str() {
        let mark = match v["status"].as_str() {
            Some("ok") => "✓",
            Some("unsupported") => "–",
            Some("needs") => "!",
            _ => "✗",
        };
        eprintln!("{mark} {kit}: {}", v["detail"].as_str().unwrap_or_default());
    }
}

fn report_sync(host: &str, s: &SyncStats) {
    if s.sent == 0 && s.deleted == 0 {
        eprintln!("[{host}] up to date ({} files)", s.unchanged);
    } else {
        eprintln!(
            "[{host}] synced {} changed ({:.1} MB), {} deleted, {} unchanged",
            s.sent,
            s.bytes as f64 / 1_048_576.0,
            s.deleted,
            s.unchanged
        );
    }
}

fn safe_host(host: &str) -> String {
    host.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Args {
        Args { rest: v.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn flags_after_dashdash_belong_to_the_command() {
        let mut a = args(&["--host", "box", "--", "make", "--host", "x"]);
        assert_eq!(a.value("--host").unwrap().as_deref(), Some("box"));
        assert_eq!(a.after_dashdash().as_deref(), Some("make --host x"));
    }

    #[test]
    fn repeated_steps_keep_their_order() {
        let mut a = args(&["--do", "click:#a", "--full", "--do", "press:Enter"]);
        assert_eq!(a.values("--do").unwrap(), vec!["click:#a", "press:Enter"]);
        assert!(a.switch("--full"));
        assert!(a.rest.is_empty());
    }

    #[test]
    fn a_flag_missing_its_value_is_an_error() {
        assert!(args(&["--host"]).value("--host").is_err());
    }
}
