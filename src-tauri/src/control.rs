//! Control requests from `panex-cli open|wait`, so an agent in one tab can start others and
//! wait for them. They arrive over the notification pipe (notify.rs) and must carry the token
//! that only shells started by this panex get in PANEX_TOKEN; any other local process is refused.
//!
//! `open` is carried out by the frontend, which owns the layout: we emit `ctl-request` and the
//! answer comes back through `ctl_reply`. `wait` is answered here, from the hook events that
//! pass through the pipe anyway, so a waiting agent costs nothing until one of them arrives.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::BuildHasher;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Notify};

use crate::AppState;

/// How long the frontend may take to open a tab (a `git worktree add` included).
const FRONTEND_TIMEOUT: Duration = Duration::from_secs(60);
/// `wait` returns by then at the latest; the agent calls it again if it wants to keep waiting.
const MAX_WAIT: Duration = Duration::from_secs(3600);

#[derive(Default)]
pub struct Control {
    /// Agent state of each tab as last reported by its hooks: (state, message).
    panes: Mutex<HashMap<String, (&'static str, String)>>,
    changed: Notify,
    replies: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next: AtomicU64,
}

/// Random per launch; handed to our shells in PANEX_TOKEN.
pub fn token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    // RandomState is keyed from the OS random generator, so its hashes can't be guessed.
    TOKEN.get_or_init(|| (0..2).map(|i| format!("{:016x}", std::collections::hash_map::RandomState::new().hash_one(i))).collect())
}

/// The agent state a hook event puts a tab in; None leaves it as it was.
fn state_for(event: &str, kind: Option<&str>, current: Option<&str>) -> Option<&'static str> {
    Some(match event {
        "UserPromptSubmit" => "running",
        "Stop" => "done",
        "StopFailure" => "error",
        "SessionEnd" => "exited",
        "Notification" => match kind {
            Some("auth_success") => return None,
            // "Waiting for your input" a minute after a finished turn adds nothing.
            Some("idle_prompt") if matches!(current, Some("done" | "error")) => return None,
            _ => "needs-input",
        },
        _ => return None,
    })
}

/// Every hook message passes through here on its way to the frontend.
pub fn record(app: &AppHandle, msg: &Value) {
    let Some(pane) = msg["pane"].as_str() else { return };
    let ctl = app.state::<Control>();
    let mut panes = ctl.panes.lock().unwrap();
    let current = panes.get(pane).map(|p| p.0);
    if let Some(state) = state_for(msg["event"].as_str().unwrap_or(""), msg["notificationType"].as_str(), current) {
        let message = msg["message"].as_str().unwrap_or("").to_string();
        panes.insert(pane.to_string(), (state, message));
        drop(panes);
        ctl.changed.notify_waiters();
    }
}

/// The tab's shell ended (or the tab was closed).
pub fn pane_exited(app: &AppHandle, id: &str) {
    set(&app.state::<Control>(), id, "exited", String::new());
}

/// A key the user pressed in the tab changed its agent's state where no hook reports it:
/// Enter answering a prompt (running again) or Esc / Ctrl+C interrupting the turn (done).
#[tauri::command]
pub fn agent_state(ctl: State<Control>, id: String, state: String, message: String) {
    match state.as_str() {
        "running" => set(&ctl, &id, "running", message),
        "done" => set(&ctl, &id, "done", message),
        _ => {}
    }
}

fn set(ctl: &Control, id: &str, state: &'static str, message: String) {
    ctl.panes.lock().unwrap().insert(id.to_string(), (state, message));
    ctl.changed.notify_waiters();
}

pub async fn handle(app: &AppHandle, req: &Value) -> Value {
    if req["token"].as_str() != Some(token()) {
        return json!({ "error": "refused: run panex-cli from a panex tab" });
    }
    let result = match req["op"].as_str() {
        Some("open") => open(app, req).await,
        Some("wait") => wait(app, req).await,
        _ => Err("unknown request".into()),
    };
    result.unwrap_or_else(|e| json!({ "error": e }))
}

async fn open(app: &AppHandle, req: &Value) -> Result<Value, String> {
    let cwd = req["cwd"].as_str().unwrap_or("");
    if !Path::new(cwd).is_dir() {
        return Err(format!("not a folder: {cwd}"));
    }
    let ctl = app.state::<Control>();
    let id = ctl.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    ctl.replies.lock().unwrap().insert(id, tx);
    let _ = app.emit("ctl-request", json!({ "req": id, "op": "open", "args": req }));
    match tokio::time::timeout(FRONTEND_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        _ => {
            ctl.replies.lock().unwrap().remove(&id);
            Err("panex did not answer".into())
        }
    }
}

#[tauri::command]
pub fn ctl_reply(ctl: State<Control>, req: u64, ok: bool, value: Value) {
    if let Some(tx) = ctl.replies.lock().unwrap().remove(&req) {
        let _ = tx.send(if ok { Ok(value) } else { Err(value.as_str().unwrap_or("failed").to_string()) });
    }
}

/// Blocks until none of the tabs has an agent at work (each is done, needs input, failed or
/// exited), or until the timeout. A tab whose agent hasn't reported yet counts as at work.
async fn wait(app: &AppHandle, req: &Value) -> Result<Value, String> {
    let ids: Vec<String> = req["tabs"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
    if ids.is_empty() {
        return Err("no tabs given".into());
    }
    let ctl = app.state::<Control>();
    {
        let state = app.state::<AppState>();
        let ptys = state.ptys.lock().unwrap();
        let panes = ctl.panes.lock().unwrap();
        if let Some(bad) = ids.iter().find(|id| !ptys.contains_key(*id) && !panes.contains_key(*id)) {
            return Err(format!("no such tab: {bad}"));
        }
    }
    let secs = req["timeout"].as_u64().unwrap_or(110);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs).min(MAX_WAIT);
    loop {
        // Registered before reading the states, so a change in between still wakes us.
        let changed = ctl.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let (states, busy) = snapshot(&ctl, &ids);
        if !busy {
            return Ok(json!({ "tabs": states, "timedOut": false }));
        }
        if tokio::time::timeout_at(deadline, changed).await.is_err() {
            return Ok(json!({ "tabs": snapshot(&ctl, &ids).0, "timedOut": true }));
        }
    }
}

fn snapshot(ctl: &Control, ids: &[String]) -> (Vec<Value>, bool) {
    let panes = ctl.panes.lock().unwrap();
    let mut busy = false;
    let states = ids
        .iter()
        .map(|id| {
            let (state, message) = panes.get(id).map(|(s, m)| (*s, m.as_str())).unwrap_or(("starting", ""));
            busy |= matches!(state, "starting" | "running");
            json!({ "tab": id, "state": state, "message": message })
        })
        .collect();
    (states, busy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_events_map_to_states() {
        assert_eq!(state_for("UserPromptSubmit", None, None), Some("running"));
        assert_eq!(state_for("Stop", None, Some("running")), Some("done"));
        assert_eq!(state_for("StopFailure", None, Some("running")), Some("error"));
        assert_eq!(state_for("Notification", Some("permission_prompt"), Some("running")), Some("needs-input"));
        assert_eq!(state_for("Notification", Some("auth_success"), Some("running")), None);
        assert_eq!(state_for("Notification", Some("idle_prompt"), Some("done")), None);
        assert_eq!(state_for("Notification", Some("idle_prompt"), None), Some("needs-input"));
        assert_eq!(state_for("SessionEnd", None, Some("done")), Some("exited"));
        assert_eq!(state_for("PreToolUse", None, None), None);
    }

    #[test]
    fn token_is_stable_and_long() {
        assert_eq!(token(), token());
        assert_eq!(token().len(), 32);
    }
}
