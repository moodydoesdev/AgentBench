//! Claude plan usage — the numbers `/usage` shows inside Claude Code.
//!
//! Claude Code stores its claude.ai OAuth login in the macOS keychain
//! (`Claude Code-credentials`) or, elsewhere, `~/.claude/.credentials.json`.
//! That access token can read `api/oauth/usage`, which answers the 5-hour and
//! weekly utilization windows. The token is only ever read, never refreshed:
//! Claude Code owns the refresh-token rotation, and writing a refreshed pair
//! back from here could race it and log the user out.

use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The endpoint is rate limited and the numbers move slowly; a page left open
/// on a phone (or several) must not poll Anthropic once per refresh.
const CACHE_FOR: Duration = Duration::from_secs(60);

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

fn credentials_json() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .ok()?;
        if out.status.success() {
            return Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
    }
    let home = dirs_home()?;
    std::fs::read_to_string(home.join(".claude").join(".credentials.json")).ok()
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// `(accessToken, subscriptionType, expiresAt ms)` from Claude Code's login.
fn oauth_login() -> Result<(String, Value, Option<i64>), String> {
    let raw = credentials_json()
        .ok_or("No Claude login found on this machine — run `claude` and /login.")?;
    let creds: Value = serde_json::from_str(&raw).map_err(|_| "Unreadable Claude credentials.")?;
    let oauth = &creds["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .ok_or("Claude is logged in with an API key, not a claude.ai plan — no plan usage to show.")?;
    Ok((
        token.to_string(),
        oauth["subscriptionType"].clone(),
        oauth["expiresAt"].as_i64(),
    ))
}

/// Usage windows plus the plan name, cached for a minute.
pub async fn claude_usage() -> Result<Value, String> {
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < CACHE_FOR {
            return Ok(v.clone());
        }
    }
    // the keychain read spawns a process; keep it off the async workers
    let (token, plan, expires_at) = tokio::task::spawn_blocking(oauth_login)
        .await
        .map_err(|e| e.to_string())??;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(USAGE_URL)
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "agentbench")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Anthropic: {e}"))?;
    let status = res.status();
    if status.as_u16() == 401 {
        let expired = expires_at
            .map(|ms| ms < now_ms())
            .unwrap_or(false);
        return Err(if expired {
            "Claude's login token has expired — use Claude Code on this machine once to refresh it."
        } else {
            "Anthropic rejected Claude's login token — run /login in Claude Code."
        }
        .into());
    }
    if !status.is_success() {
        return Err(format!("Anthropic answered {status}"));
    }
    let mut body: Value = res.json().await.map_err(|e| e.to_string())?;
    body["plan"] = plan;
    body["fetchedAt"] = Value::from(now_ms());
    *CACHE.lock().unwrap() = Some((Instant::now(), body.clone()));
    Ok(body)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
