//! Team decisions: a question a team manager needs the user to settle, filed
//! once through the hook server instead of re-asked in chat. The user answers
//! from the team sidebar or a phone; the broker types the answer into the
//! manager's session. The manager keeps working in the meantime.

use serde_json::{json, Value};
use std::sync::Mutex;

use super::{write_pane, Core, TeamSeat};

/// Answered/withdrawn decisions kept per team, so a manager that lost its
/// context (/clear) can still read what was settled.
const SETTLED_KEEP: usize = 30;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// "D<n>", machine-wide counter
    pub id: String,
    pub team_id: String,
    pub team: String,
    /// Session name of the manager that filed it.
    pub asked_by: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    /// Why it matters / what's blocked on it.
    #[serde(default)]
    pub context: Option<String>,
    pub created_at: u64,
    /// "open" | "answered" | "withdrawn"
    pub status: String,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub settled_at: Option<u64>,
    /// Whether the answer reached the manager's pane (false when no live
    /// manager pane existed — it can still read it back with `decisions`).
    #[serde(default)]
    pub delivered: bool,
}

static STORE: Mutex<Option<Vec<Decision>>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with<R>(core: &Core, f: impl FnOnce(&mut Vec<Decision>) -> R) -> R {
    let mut guard = STORE.lock().unwrap();
    let list = guard.get_or_insert_with(|| {
        std::fs::read_to_string(core.config_dir.join("decisions.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    f(list)
}

fn save(core: &Core, list: &[Decision]) {
    let _ = std::fs::write(
        core.config_dir.join("decisions.json"),
        serde_json::to_string_pretty(list).unwrap(),
    );
}

pub fn state_json(core: &Core) -> Value {
    with(core, |list| json!({ "decisions": list }))
}

fn broadcast_state(core: &Core) {
    let mut ev = state_json(core);
    ev["ev"] = json!("decisions");
    core.broadcast(&ev);
}

fn seat_of(core: &Core, pane: u32) -> Option<TeamSeat> {
    core.panes.lock().unwrap().get(&pane).and_then(|p| p.team.clone())
}

/// The live pane holding a team's manager seat.
fn manager_pane(core: &Core, team_id: &str) -> Option<u32> {
    core.panes
        .lock()
        .unwrap()
        .iter()
        .find(|(_, p)| p.team.as_ref().is_some_and(|t| t.team_id == team_id && t.manager))
        .map(|(&id, _)| id)
}

/// Bracketed paste, then Enter once the TUI has settled (the second Enter is
/// a no-op when the first already submitted). Shared with the `command` hook.
pub fn type_line(core: &std::sync::Arc<Core>, id: u32, text: &str) -> Result<(), String> {
    write_pane(core, id, &format!("\x1b[200~{text}\x1b[201~"))?;
    let core = core.clone();
    std::thread::spawn(move || {
        for delay in [400, 1200] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let _ = write_pane(&core, id, "\r");
        }
    });
    Ok(())
}

/// Hook `decision`: a manager files a question. Returns the text its curl
/// prints back.
pub fn file(core: &Core, pane: u32, body: &Value) -> Result<String, (u16, String)> {
    let seat = seat_of(core, pane)
        .filter(|s| s.manager)
        .ok_or((403, "only a team manager can file decisions".into()))?;
    let question = body["question"].as_str().unwrap_or_default().trim().to_string();
    if question.is_empty() {
        return Err((400, "missing \"question\"".into()));
    }
    let options: Vec<String> = body["options"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| o.as_str().or_else(|| o["label"].as_str()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let context = body["context"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let filed = with(core, |list| {
        // the same open question filed twice is the re-asking this exists to stop
        if let Some(d) = list.iter().find(|d| {
            d.status == "open" && d.team_id == seat.team_id && d.question.eq_ignore_ascii_case(&question)
        }) {
            return (d.clone(), false);
        }
        let n = list
            .iter()
            .filter_map(|d| d.id.strip_prefix('D')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0)
            + 1;
        let d = Decision {
            id: format!("D{n}"),
            team_id: seat.team_id.clone(),
            team: seat.team.clone(),
            asked_by: seat.session_name.clone().unwrap_or_else(|| seat.role.clone()),
            question,
            options,
            context,
            created_at: now_ms(),
            status: "open".into(),
            answer: None,
            note: None,
            settled_at: None,
            delivered: false,
        };
        list.push(d.clone());
        save(core, list);
        (d, true)
    });
    let (d, fresh) = filed;
    if fresh {
        broadcast_state(core);
        // pane-scoped event for notifications (desktop + phone push)
        core.broadcast(&json!({ "ev": "decision", "id": pane, "fresh": true, "decision": d }));
        Ok(format!(
            "Filed {}. The user sees it in the team's Decisions list; the answer will be typed into this session as \"[Decision {}] ...\". Do not ask it again in chat — carry on with unblocked work.\n",
            d.id, d.id
        ))
    } else {
        Ok(format!("{} is already open with the same question — still waiting on the user. Do not re-ask.\n", d.id))
    }
}

/// Hook `decision-withdraw`: the manager no longer needs an answer.
pub fn withdraw(core: &Core, pane: u32, body: &Value) -> Result<String, (u16, String)> {
    let seat = seat_of(core, pane)
        .filter(|s| s.manager)
        .ok_or((403, "only a team manager can withdraw decisions".into()))?;
    let id = body["id"].as_str().unwrap_or_default().trim().to_uppercase();
    with(core, |list| {
        let d = list
            .iter_mut()
            .find(|d| d.id == id && d.team_id == seat.team_id && d.status == "open")
            .ok_or((404, format!("no open decision {id} for this team")))?;
        d.status = "withdrawn".into();
        d.settled_at = Some(now_ms());
        save(core, list);
        Ok(())
    })?;
    broadcast_state(core);
    Ok(format!("Withdrew {id}.\n"))
}

/// Hook `decisions`: what this pane's team has open and recently settled,
/// as plain text for the agent.
pub fn list_for(core: &Core, pane: u32) -> Result<String, (u16, String)> {
    let seat = seat_of(core, pane).ok_or((403, "not a team seat".into()))?;
    let out = with(core, |list| {
        let mine: Vec<&Decision> = list.iter().filter(|d| d.team_id == seat.team_id).collect();
        let mut out = String::new();
        for d in mine.iter().filter(|d| d.status == "open") {
            out += &format!("{} OPEN: {}\n", d.id, d.question);
        }
        for d in mine.iter().rev().filter(|d| d.status == "answered").take(10) {
            out += &format!(
                "{} ANSWERED: {} -> {}{}\n",
                d.id,
                d.question,
                d.answer.as_deref().unwrap_or(""),
                d.note.as_deref().map(|n| format!(" (note: {n})")).unwrap_or_default()
            );
        }
        if out.is_empty() {
            out = "No decisions on file for this team.\n".into();
        }
        out
    });
    Ok(out)
}

/// Op `decision-answer` (UI): settle it and type the answer into the
/// manager's session.
pub fn answer_op(core: &std::sync::Arc<Core>, req: &Value) -> Result<Value, String> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let answer = req["answer"].as_str().unwrap_or_default().trim().to_string();
    let note = req["note"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    if answer.is_empty() && note.is_none() {
        return Err("empty answer".into());
    }
    let d = with(core, |list| {
        let d = list
            .iter_mut()
            .find(|d| d.id == id && d.status == "open")
            .ok_or(format!("{id} is not open"))?;
        d.status = "answered".into();
        d.answer = Some(answer.clone());
        d.note = note.clone();
        d.settled_at = Some(now_ms());
        Ok::<_, String>(d.clone())
    })?;
    let mut line = format!("[Decision {}] {} -> {}", d.id, d.question, if answer.is_empty() { "(see note)" } else { &answer });
    if let Some(n) = &note {
        line += &format!(". Note from the user: {n}");
    }
    let delivered = manager_pane(core, &d.team_id).is_some_and(|p| type_line(core, p, &line).is_ok());
    with(core, |list| {
        if let Some(x) = list.iter_mut().find(|x| x.id == d.id) {
            x.delivered = delivered;
        }
        prune(list);
        save(core, list);
    });
    broadcast_state(core);
    Ok(json!({ "delivered": delivered }))
}

/// Keep every open decision, drop the oldest settled ones past SETTLED_KEEP
/// per team.
fn prune(list: &mut Vec<Decision>) {
    let mut seen: std::collections::HashMap<String, usize> = Default::default();
    let mut keep = vec![true; list.len()];
    for (i, d) in list.iter().enumerate().rev() {
        if d.status == "open" {
            continue;
        }
        let n = seen.entry(d.team_id.clone()).or_default();
        *n += 1;
        keep[i] = *n <= SETTLED_KEEP;
    }
    let mut it = keep.into_iter();
    list.retain(|_| it.next().unwrap());
}
