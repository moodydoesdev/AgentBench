//! Scheduled prompts: a saved prompt + project + cadence, fired by the broker
//! so it runs whether or not any UI is open. A run is an ordinary headless
//! chat pane (`claude -p`) with the prompt written to its stdin — which makes
//! every run a real session: reviewable in any chat view, resumable later,
//! and replyable ("tighten that email and send it") like any conversation.

use chrono::{DateTime, Datelike, Local, TimeZone};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use super::Core;

/// Runs kept per schedule; older ones fall off (their transcripts remain on
/// disk like any session, they just stop being listed).
const RUNS_PER_SCHEDULE: usize = 20;
/// How often the scheduler wakes to check for due schedules.
const TICK_SECS: u64 = 30;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Cadence {
    /// "daily" | "weekdays" | "weekly" | "interval"
    pub kind: String,
    /// "HH:MM" local time, for the timed kinds.
    #[serde(default)]
    pub time: Option<String>,
    /// 1=Mon … 7=Sun, for "weekly".
    #[serde(default)]
    pub days: Vec<u8>,
    /// Minutes between runs, for "interval".
    #[serde(default, rename = "everyMin")]
    pub every_min: Option<u32>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub prompt: String,
    pub cadence: Cadence,
    pub enabled: bool,
    /// Kill the previous run's pane when a new run starts, so a daily
    /// schedule holds one live pane instead of accumulating seven a week.
    #[serde(default = "yes")]
    pub close_previous: bool,
    #[serde(default)]
    pub created_at: u64,
    /// Floor for timed cadences: slots before this moment never fire. Set at
    /// creation and on unpause, so "daily 08:00" saved at 5 PM waits for
    /// tomorrow instead of launching an autonomous run within one tick.
    /// (Catch-up for a machine asleep at slot time still works — sleeping
    /// moves neither this nor last_start.)
    #[serde(default)]
    pub anchor_at: u64,
}

fn yes() -> bool {
    true
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub schedule_id: String,
    pub pane_id: u32,
    /// Bound from the run's stream-json; how a retired run reopens (resume).
    #[serde(default)]
    pub session_id: Option<String>,
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    /// "running" | "done" | "failed"
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static SEQ: AtomicU32 = AtomicU32::new(1);

fn fresh_id(prefix: &str) -> String {
    format!("{prefix}{}-{}", now_ms(), SEQ.fetch_add(1, Ordering::SeqCst))
}

// ---- persistence -----------------------------------------------------------

pub fn load_schedules(core: &Core) -> Vec<Schedule> {
    std::fs::read_to_string(core.config_dir.join("schedules.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn load_runs(core: &Core) -> Vec<Run> {
    std::fs::read_to_string(core.config_dir.join("schedule-runs.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_schedules(core: &Core) {
    let list = core.schedules.lock().unwrap().clone();
    let _ = std::fs::write(
        core.config_dir.join("schedules.json"),
        serde_json::to_string_pretty(&list).unwrap(),
    );
}

fn save_runs(core: &Core) {
    let list = core.runs.lock().unwrap().clone();
    let _ = std::fs::write(
        core.config_dir.join("schedule-runs.json"),
        serde_json::to_string_pretty(&list).unwrap(),
    );
}

// ---- cadence math ----------------------------------------------------------

fn parse_hhmm(t: &str) -> Option<(u32, u32)> {
    let (h, m) = t.split_once(':')?;
    let (h, m) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

/// The next moment this schedule should fire, given when it last started.
/// A timed slot that passed today without a run still counts (a machine that
/// was asleep at 08:00 catches up when it wakes) — the slot is only consumed
/// once a run has started at or after it.
fn next_at(s: &Schedule, last_start: Option<DateTime<Local>>, now: DateTime<Local>) -> Option<DateTime<Local>> {
    match s.cadence.kind.as_str() {
        "interval" => {
            let every = s.cadence.every_min.filter(|m| *m > 0)? as i64;
            Some(match last_start {
                Some(l) => l + chrono::Duration::minutes(every),
                None => now,
            })
        }
        kind => {
            let (hh, mm) = parse_hhmm(s.cadence.time.as_deref()?)?;
            // slots older than the anchor were never owed — see anchor_at
            let anchor = (s.anchor_at > 0)
                .then(|| Local.timestamp_millis_opt(s.anchor_at as i64).single())
                .flatten();
            let last_start = match (last_start, anchor) {
                (Some(l), Some(a)) => Some(l.max(a)),
                (l, a) => l.or(a),
            };
            let day_ok = |d: &DateTime<Local>| match kind {
                "daily" => true,
                "weekdays" => d.weekday().number_from_monday() <= 5,
                "weekly" => s.cadence.days.contains(&(d.weekday().number_from_monday() as u8)),
                _ => false,
            };
            for offset in 0..=8 {
                let date = now.date_naive() + chrono::Duration::days(offset);
                let naive = date.and_hms_opt(hh, mm, 0)?;
                // DST gaps make a local time ambiguous or nonexistent; take
                // the earliest interpretation and skip a slot that has none
                let Some(candidate) = Local.from_local_datetime(&naive).earliest() else {
                    continue;
                };
                if !day_ok(&candidate) {
                    continue;
                }
                if last_start.map_or(true, |l| l < candidate) {
                    return Some(candidate);
                }
            }
            None
        }
    }
}

fn last_start_of(core: &Core, schedule_id: &str) -> Option<DateTime<Local>> {
    let runs = core.runs.lock().unwrap();
    let ms = runs
        .iter()
        .filter(|r| r.schedule_id == schedule_id)
        .map(|r| r.started_at)
        .max()?;
    Local.timestamp_millis_opt(ms as i64).single()
}

fn has_running(core: &Core, schedule_id: &str) -> bool {
    core.runs
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.schedule_id == schedule_id && r.status == "running")
}

// ---- firing ----------------------------------------------------------------

/// Everything a UI needs, in one payload — also broadcast as the `schedules`
/// event on every change so open UIs never poll.
pub fn state_json(core: &Core) -> Value {
    let now = Local::now();
    let schedules: Vec<Value> = core
        .schedules
        .lock()
        .unwrap()
        .iter()
        .map(|s| {
            let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
            let next = s
                .enabled
                .then(|| next_at(s, last_start_of(core, &s.id), now))
                .flatten()
                .map(|d| d.timestamp_millis());
            v["nextAt"] = json!(next);
            v
        })
        .collect();
    let runs = core.runs.lock().unwrap().clone();
    json!({ "schedules": schedules, "runs": runs })
}

fn broadcast_state(core: &Core) {
    let mut ev = state_json(core);
    ev["ev"] = json!("schedules");
    core.broadcast(&ev);
}

/// Start one run: close the previous run's pane if asked, spawn a headless
/// chat pane in the project, write the prompt, record the run.
///
/// Serialized: the run record only exists after the spawn, so without this
/// a "Run now" landing on the same instant as the timer tick would pass two
/// `has_running` checks and start the prompt twice.
static FIRING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn fire(core: &Arc<Core>, schedule: &Schedule) -> Result<String, String> {
    let _one_at_a_time = FIRING.lock().unwrap();
    if has_running(core, &schedule.id) {
        return Err("a run is already in progress for this schedule".into());
    }
    if schedule.close_previous {
        let stale: Vec<u32> = {
            let runs = core.runs.lock().unwrap();
            let chat = core.chat_panes.lock().unwrap();
            let touched = core.last_input.lock().unwrap();
            runs.iter()
                .filter(|r| r.schedule_id == schedule.id && chat.contains_key(&r.pane_id))
                // "replyable like any conversation" must hold: someone mid-
                // conversation with yesterday's run keeps their pane — only
                // panes untouched for a while are housekeeping.
                .filter(|r| {
                    touched
                        .get(&r.pane_id)
                        .map_or(true, |t| t.elapsed().as_secs() > 30 * 60)
                })
                .map(|r| r.pane_id)
                .collect()
        };
        for id in stale {
            super::kill_pane(core, id);
        }
    }

    let run_id = fresh_id("r");
    let run = match super::create_chat_pane(core, schedule.cwd.clone(), None, None)
        .and_then(|pane_id| {
            super::write_chat_pane(core, pane_id, &schedule.prompt).map(|_| pane_id)
        }) {
        Ok(pane_id) => {
            // the pane appears in every UI like a hand-started agent; this
            // event lets shells adopt it (and gateways re-broadcast panes)
            core.broadcast(&json!({
                "ev": "schedule-run",
                "scheduleId": schedule.id,
                "runId": run_id,
                "paneId": pane_id,
                "cwd": schedule.cwd,
                "name": schedule.name,
            }));
            Run {
                id: run_id.clone(),
                schedule_id: schedule.id.clone(),
                pane_id,
                session_id: None,
                started_at: now_ms(),
                ended_at: None,
                status: "running".into(),
                error: None,
            }
        }
        Err(e) => Run {
            id: run_id.clone(),
            schedule_id: schedule.id.clone(),
            pane_id: 0,
            session_id: None,
            started_at: now_ms(),
            ended_at: Some(now_ms()),
            status: "failed".into(),
            error: Some(e),
        },
    };

    {
        let mut runs = core.runs.lock().unwrap();
        runs.push(run);
        // cap per schedule, oldest first
        let ids: Vec<String> = {
            let mut mine: Vec<&Run> = runs
                .iter()
                .filter(|r| r.schedule_id == schedule.id)
                .collect();
            mine.sort_by_key(|r| r.started_at);
            let excess = mine.len().saturating_sub(RUNS_PER_SCHEDULE);
            mine.iter().take(excess).map(|r| r.id.clone()).collect()
        };
        runs.retain(|r| !ids.contains(&r.id));
    }
    save_runs(core);
    broadcast_state(core);
    Ok(run_id)
}

// ---- scheduler + run tracking ---------------------------------------------

/// A run that outlives any plausible turn (hung model call, a question the
/// headless harness can never answer) must not wedge its schedule forever.
const MAX_RUN_SECS: u64 = 2 * 60 * 60;
/// Grace before "running with no live pane" counts as dead — covers the gap
/// between pushing the run record and the pane appearing in chat_panes.
const DEAD_PANE_GRACE_SECS: u64 = 90;

/// Reconcile "running" runs against reality: kill and fail ones that have
/// run absurdly long, and fail ones whose pane vanished without the tracker
/// catching the exit (a pane that dies in the instant before its run record
/// lands would otherwise stay "running" and block the schedule until a
/// broker restart).
fn sweep_stale_runs(core: &Arc<Core>) {
    let now = now_ms();
    let (timed_out, orphaned): (Vec<u32>, bool) = {
        let mut runs = core.runs.lock().unwrap();
        let chat = core.chat_panes.lock().unwrap();
        let mut kill = Vec::new();
        let mut changed = false;
        for r in runs.iter_mut().filter(|r| r.status == "running") {
            let age_secs = now.saturating_sub(r.started_at) / 1000;
            if age_secs > MAX_RUN_SECS {
                kill.push(r.pane_id);
                r.status = "failed".into();
                r.ended_at = Some(now);
                r.error = Some("timed out after 2h".into());
                changed = true;
            } else if age_secs > DEAD_PANE_GRACE_SECS && !chat.contains_key(&r.pane_id) {
                r.status = "failed".into();
                r.ended_at = Some(now);
                r.error = Some("pane died before finishing".into());
                changed = true;
            }
        }
        (kill, changed)
    };
    let changed = orphaned || !timed_out.is_empty();
    for id in timed_out {
        super::kill_pane(core, id);
    }
    if changed {
        save_runs(core);
        broadcast_state(core);
    }
}

pub fn start(core: Arc<Core>) {
    // Tick thread: fire whatever is due. One run at a time per schedule —
    // a slow run simply delays the next slot rather than stacking a second.
    let tick_core = core.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(TICK_SECS));
        sweep_stale_runs(&tick_core);
        let now = Local::now();
        let due: Vec<Schedule> = {
            let schedules = tick_core.schedules.lock().unwrap();
            schedules
                .iter()
                .filter(|s| s.enabled && !has_running(&tick_core, &s.id))
                .filter(|s| {
                    next_at(s, last_start_of(&tick_core, &s.id), now)
                        .is_some_and(|t| t <= now)
                })
                .cloned()
                .collect()
        };
        for s in due {
            let _ = fire(&tick_core, &s);
        }
    });

    // Tracker thread: subscribe to the broker's own event bus (the same
    // interface every client uses) and settle runs when their pane finishes
    // or dies. `agent-event done` comes from the chat pane's `result` record.
    let track_core = core;
    let rx = track_core.subscribe();
    std::thread::spawn(move || {
        for line in rx {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let ev = v["ev"].as_str().unwrap_or_default();
            if ev != "agent-event" && ev != "pane-exit" {
                continue;
            }
            let Some(pane_id) = v["id"].as_u64().map(|i| i as u32) else {
                continue;
            };
            let done = ev == "agent-event" && v["kind"] == "done";
            let changed = {
                let mut runs = track_core.runs.lock().unwrap();
                let Some(run) = runs
                    .iter_mut()
                    .find(|r| r.pane_id == pane_id && r.status == "running")
                else {
                    continue;
                };
                if done {
                    run.status = "done".into();
                    run.ended_at = Some(now_ms());
                    if let Some(sid) = v["sid"].as_str() {
                        run.session_id = Some(sid.to_string());
                    }
                    true
                } else if ev == "pane-exit" {
                    // exited without ever producing a result record; the sid
                    // rides on the event so the partial transcript — the most
                    // interesting artifact of a failure — stays openable
                    run.status = "failed".into();
                    run.ended_at = Some(now_ms());
                    if let Some(sid) = v["sid"].as_str() {
                        run.session_id = Some(sid.to_string());
                    }
                    run.error = Some(match v["code"].as_u64() {
                        Some(c) => format!("exited with code {c}"),
                        None => "exited before finishing".into(),
                    });
                    true
                } else {
                    false
                }
            };
            if changed {
                save_runs(&track_core);
                broadcast_state(&track_core);
            }
        }
    });
}

// ---- ops -------------------------------------------------------------------

/// `schedule-save`: create (empty/missing id) or update. Returns the saved
/// schedule with its id, so a creating UI can select it.
pub fn save_op(core: &Arc<Core>, body: &Value) -> Result<Value, String> {
    let b = &body["schedule"];
    let name = b["name"].as_str().map(str::trim).unwrap_or_default();
    let cwd = b["cwd"].as_str().map(str::trim).unwrap_or_default();
    let prompt = b["prompt"].as_str().map(str::trim).unwrap_or_default();
    if name.is_empty() || cwd.is_empty() || prompt.is_empty() {
        return Err("a schedule needs a name, a project, and a prompt".into());
    }
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("project folder does not exist: {cwd}"));
    }
    let cadence: Cadence =
        serde_json::from_value(b["cadence"].clone()).map_err(|_| "bad cadence".to_string())?;
    match cadence.kind.as_str() {
        "interval" => {
            if cadence.every_min.filter(|m| *m > 0).is_none() {
                return Err("interval cadence needs everyMin > 0".into());
            }
        }
        "daily" | "weekdays" | "weekly" => {
            if cadence.time.as_deref().and_then(parse_hhmm).is_none() {
                return Err("timed cadence needs time \"HH:MM\"".into());
            }
            if cadence.kind == "weekly" && cadence.days.is_empty() {
                return Err("weekly cadence needs at least one day".into());
            }
        }
        _ => return Err("cadence kind must be daily, weekdays, weekly, or interval".into()),
    }

    let incoming_id = b["id"].as_str().unwrap_or_default().to_string();
    let saved = {
        let mut schedules = core.schedules.lock().unwrap();
        let existing = schedules.iter_mut().find(|s| s.id == incoming_id);
        match existing {
            Some(s) => {
                let enabled = b["enabled"].as_bool().unwrap_or(s.enabled);
                // unpausing re-anchors: a week of missed slots is not debt
                if enabled && !s.enabled {
                    s.anchor_at = now_ms();
                }
                s.name = name.into();
                s.cwd = cwd.into();
                s.prompt = prompt.into();
                s.cadence = cadence;
                s.enabled = enabled;
                s.close_previous = b["closePrevious"].as_bool().unwrap_or(s.close_previous);
                s.clone()
            }
            None => {
                let s = Schedule {
                    id: fresh_id("s"),
                    name: name.into(),
                    cwd: cwd.into(),
                    prompt: prompt.into(),
                    cadence,
                    enabled: b["enabled"].as_bool().unwrap_or(true),
                    close_previous: b["closePrevious"].as_bool().unwrap_or(true),
                    created_at: now_ms(),
                    anchor_at: now_ms(),
                };
                schedules.push(s.clone());
                s
            }
        }
    };
    save_schedules(core);
    broadcast_state(core);
    serde_json::to_value(&saved).map_err(|e| e.to_string())
}

pub fn delete_op(core: &Arc<Core>, id: &str) -> Result<(), String> {
    {
        let mut schedules = core.schedules.lock().unwrap();
        let before = schedules.len();
        schedules.retain(|s| s.id != id);
        if schedules.len() == before {
            return Err("no such schedule".into());
        }
    }
    // history goes with it; live panes stay — they're just panes now
    core.runs.lock().unwrap().retain(|r| r.schedule_id != id);
    save_schedules(core);
    save_runs(core);
    broadcast_state(core);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched(kind: &str, time: Option<&str>, days: Vec<u8>, every: Option<u32>) -> Schedule {
        Schedule {
            id: "s1".into(),
            name: "t".into(),
            cwd: ".".into(),
            prompt: "p".into(),
            cadence: Cadence {
                kind: kind.into(),
                time: time.map(String::from),
                days,
                every_min: every,
            },
            enabled: true,
            close_previous: true,
            created_at: 0,
            anchor_at: 0,
        }
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(y, mo, d)
                    .unwrap()
                    .and_hms_opt(h, mi, 0)
                    .unwrap(),
            )
            .earliest()
            .unwrap()
    }

    #[test]
    fn daily_catches_up_same_day() {
        // slot passed, never run: still due today (machine was asleep at 08:00)
        let s = sched("daily", Some("08:00"), vec![], None);
        let next = next_at(&s, None, at(2026, 8, 17, 9, 30)).unwrap();
        assert_eq!(next, at(2026, 8, 17, 8, 0));
    }

    #[test]
    fn daily_consumed_slot_moves_to_tomorrow() {
        let s = sched("daily", Some("08:00"), vec![], None);
        let next = next_at(&s, Some(at(2026, 8, 17, 8, 5)), at(2026, 8, 17, 9, 0)).unwrap();
        assert_eq!(next, at(2026, 8, 18, 8, 0));
    }

    #[test]
    fn weekdays_skip_weekend() {
        // 2026-08-15 is a Saturday
        let s = sched("weekdays", Some("08:00"), vec![], None);
        let next = next_at(&s, Some(at(2026, 8, 14, 8, 0)), at(2026, 8, 15, 12, 0)).unwrap();
        assert_eq!(next, at(2026, 8, 17, 8, 0)); // Monday
    }

    #[test]
    fn weekly_picks_named_day() {
        // 2026-08-17 is a Monday; schedule fires Wednesdays (3)
        let s = sched("weekly", Some("06:30"), vec![3], None);
        let next = next_at(&s, None, at(2026, 8, 17, 12, 0)).unwrap();
        assert_eq!(next, at(2026, 8, 19, 6, 30));
    }

    #[test]
    fn interval_spaces_from_last_start() {
        let s = sched("interval", None, vec![], Some(120));
        assert_eq!(
            next_at(&s, Some(at(2026, 8, 17, 9, 0)), at(2026, 8, 17, 10, 0)).unwrap(),
            at(2026, 8, 17, 11, 0),
        );
        // never run: first run is immediate
        let now = at(2026, 8, 17, 10, 0);
        assert_eq!(next_at(&s, None, now).unwrap(), now);
    }

    #[test]
    fn anchor_skips_the_already_passed_slot() {
        // schedule created at 17:00: today's 08:00 is not owed, tomorrow is
        let mut s = sched("daily", Some("08:00"), vec![], None);
        s.anchor_at = at(2026, 8, 17, 17, 0).timestamp_millis() as u64;
        let next = next_at(&s, None, at(2026, 8, 17, 17, 0)).unwrap();
        assert_eq!(next, at(2026, 8, 18, 8, 0));
        // but a machine merely asleep at slot time (anchor long past) still
        // catches up the same day
        s.anchor_at = at(2026, 8, 1, 0, 0).timestamp_millis() as u64;
        let next = next_at(&s, Some(at(2026, 8, 16, 8, 0)), at(2026, 8, 17, 13, 0)).unwrap();
        assert_eq!(next, at(2026, 8, 17, 8, 0));
    }

    #[test]
    fn invalid_cadence_yields_none() {
        assert!(next_at(&sched("daily", None, vec![], None), None, Local::now()).is_none());
        assert!(next_at(&sched("interval", None, vec![], Some(0)), None, Local::now()).is_none());
        assert!(next_at(&sched("weekly", Some("08:00"), vec![], None), None, Local::now()).is_none());
    }
}

/// `schedule-run`: fire immediately — the same path the timer takes, so a
/// fresh schedule can be tested the moment it is written.
pub fn run_now_op(core: &Arc<Core>, id: &str) -> Result<Value, String> {
    // clear any wedged run first so "Run now" is also the recovery tool
    sweep_stale_runs(core);
    let schedule = core
        .schedules
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or("no such schedule")?;
    if has_running(core, id) {
        return Err("a run is already in progress for this schedule".into());
    }
    fire(core, &schedule).map(|run_id| json!({ "runId": run_id }))
}
