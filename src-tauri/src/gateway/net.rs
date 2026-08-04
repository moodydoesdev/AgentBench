//! How this machine is reached from a phone: Tailscale identity and local
//! interface addresses. Shared by the gateway binary (pairing QR candidates)
//! and the preview proxy (which must hand the phone an IP its dev-server
//! URLs can use — IP-literal hosts pass Vite/webpack/Rails host checks where
//! a MagicDNS name would not).

use serde_json::Value;

pub struct TailscaleSelf {
    pub name: Option<String>,
    pub ips: Vec<String>,
    pub serving: bool,
}

/// The Tailscale CLI is usually NOT on PATH on Windows, and a gateway started
/// before Tailscale was installed would not see an updated PATH anyway, so the
/// standard install locations are probed directly.
fn tailscale_bins() -> Vec<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec!["tailscale".into()];
    #[cfg(windows)]
    {
        candidates.push(r"C:\Program Files\Tailscale\tailscale.exe".into());
        candidates.push(r"C:\Program Files (x86)\Tailscale\tailscale.exe".into());
    }
    #[cfg(unix)]
    {
        candidates.push("/usr/bin/tailscale".into());
        candidates.push("/usr/local/bin/tailscale".into());
        candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale".into());
    }
    // The bare name stays first for PATH installs, but it cannot be *assumed*
    // to work: probing it is the only way to tell, so callers try each in turn.
    candidates
}

fn tailscale_cmd(bin: &std::path::Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn tailscale_self() -> Option<TailscaleSelf> {
    let (bin, status) = tailscale_bins().into_iter().find_map(|bin| {
        let raw = tailscale_cmd(&bin, &["status", "--json"])?;
        let status: Value = serde_json::from_slice(&raw).ok()?;
        Some((bin, status))
    })?;
    if status["BackendState"].as_str() != Some("Running") {
        return None;
    }
    let name = status["Self"]["DNSName"]
        .as_str()
        .map(|n| n.trim_end_matches('.').to_string())
        .filter(|n| !n.is_empty());
    let ips = status["Self"]["TailscaleIPs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    // `serve status` is non-empty only once something is actually published,
    // which is what decides whether the HTTPS name is usable today.
    let serving = tailscale_cmd(&bin, &["serve", "status", "--json"])
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .map(|v| v.get("Web").is_some_and(|w| w.as_object().is_some_and(|o| !o.is_empty())))
        .unwrap_or(false);
    Some(TailscaleSelf { name, ips, serving })
}

/// Non-loopback IPv4 addresses, so a phone can be offered a LAN address when
/// Tailscale is not set up.
pub fn local_ips() -> Vec<String> {
    let mut cmd;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoLogo",
            "-Command",
            "(Get-NetIPAddress -AddressFamily IPv4).IPAddress",
        ]);
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        cmd = std::process::Command::new("sh");
        cmd.args(["-lc", "ifconfig 2>/dev/null | awk '/inet /{print $2}' || ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1"]);
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|ip| {
            !ip.is_empty()
                && !ip.starts_with("127.")
                && !ip.starts_with("169.254.")
                && ip.split('.').count() == 4
        })
        .take(4)
        .collect()
}

/// 0 = a real LAN address, 1 = an adapter that only talks to this machine's
/// own virtual machines or containers.
pub fn address_rank(ip: &str) -> u8 {
    // VirtualBox host-only, and the Docker/Hyper-V 172.16/12 block
    if ip.starts_with("192.168.56.") {
        return 1;
    }
    if let Some(second) = ip.strip_prefix("172.").and_then(|r| r.split('.').next()) {
        if let Ok(n) = second.parse::<u8>() {
            if (16..=31).contains(&n) {
                return 1;
            }
        }
    }
    0
}

/// IPs a preview URL can use, best first: Tailscale (works away from home),
/// then real LAN, then virtual adapters. Cached because Tailscale discovery
/// shells out twice — a couple of seconds, which must not sit inside every
/// "start preview" tap.
pub fn preview_hosts() -> Vec<String> {
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<String>)>> =
        std::sync::Mutex::new(None);
    const TTL: std::time::Duration = std::time::Duration::from_secs(30);

    if let Some((at, cached)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < TTL {
            return cached.clone();
        }
    }
    let ts_ips: Vec<String> = tailscale_self().map(|t| t.ips).unwrap_or_default();
    let mut out: Vec<String> = ts_ips
        .iter()
        .filter(|ip| !ip.contains(':')) // IPv6 needs bracket syntax; v4 is enough
        .cloned()
        .collect();
    let mut lan: Vec<(u8, String)> = local_ips()
        .into_iter()
        .filter(|ip| !ts_ips.contains(ip))
        .map(|ip| (address_rank(&ip), ip))
        .collect();
    lan.sort_by_key(|(rank, _)| *rank);
    out.extend(lan.into_iter().map(|(_, ip)| ip));
    *CACHE.lock().unwrap() = Some((std::time::Instant::now(), out.clone()));
    out
}
