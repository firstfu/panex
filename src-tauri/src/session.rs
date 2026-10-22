//! Session persistence: the workspace/tab layout in `session.json`, scrollback snapshots in
//! `scrollback/<tab id>.txt`. The frontend owns the layout and saves it whole; every write
//! goes to a temp file and is renamed over the target, so a crash mid-write never leaves a
//! half-written file behind.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

use crate::AppState;

/// One terminal (a horizontal tab inside a workspace).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Tab {
    pub id: String,
    pub shell: String,
    /// `[user@]host[:port]` for `shell == "ssh"` tabs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// User-chosen name; None means "derive from program title / cwd".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Claude Code session id last seen in this tab (from hooks); offered for `claude --resume`.
    #[serde(default, rename = "agentSession", skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<String>,
}

/// A sidebar entry holding one or more tabs (cmux's "workspace").
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Workspace {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    #[serde(default)]
    pub active: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Session {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub active: Option<String>,
}

impl Session {
    fn has_tab(&self, id: &str) -> bool {
        self.workspaces.iter().any(|w| w.tabs.iter().any(|t| t.id == id))
    }
}

pub struct Store {
    dir: PathBuf,
    data: Mutex<Session>,
}

impl Store {
    pub fn open(dir: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(dir.join("scrollback"))?;
        let path = dir.join("session.json");
        let data = match fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            // v0.1 kept a flat list of tabs. Parsing that straight into the new struct would
            // silently yield zero workspaces and the next save would wipe them, so convert it.
            Some(v) if v.get("tabs").is_some() && v.get("workspaces").is_none() => {
                let _ = fs::copy(&path, dir.join("session.v1.json.bak"));
                let s = migrate_v1(&v);
                if let Ok(json) = serde_json::to_vec_pretty(&s) {
                    let _ = write_atomic(&path, &json);
                }
                s
            }
            Some(v) => serde_json::from_value(v).unwrap_or_default(),
            // Missing or corrupt: start fresh.
            None => Session::default(),
        };
        Ok(Self { dir, data: Mutex::new(data) })
    }

    pub fn snapshot(&self) -> Session {
        self.data.lock().unwrap().clone()
    }

    pub fn has_tab(&self, id: &str) -> bool {
        self.data.lock().unwrap().has_tab(id)
    }

    /// v0.1 location of the app settings, now only read once for migration.
    pub fn legacy_settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    pub fn scrollback_path(&self, id: &str) -> Option<PathBuf> {
        valid_id(id).then(|| self.dir.join("scrollback").join(format!("{id}.txt")))
    }
}

/// Each old tab becomes a one-tab workspace; its name and color move to the workspace, and
/// tab ids are kept so scrollback files still match.
fn migrate_v1(v: &Value) -> Session {
    let str_of = |t: &Value, k: &str| t.get(k).and_then(Value::as_str).map(str::to_string);
    let old_active = str_of(v, "active");
    let mut s = Session::default();
    for t in v["tabs"].as_array().into_iter().flatten() {
        let Some(id) = str_of(t, "id").filter(|id| valid_id(id)) else { continue };
        let ws_id = format!("w{}", &id[..id.len().min(11)]);
        if old_active.as_deref() == Some(id.as_str()) {
            s.active = Some(ws_id.clone());
        }
        s.workspaces.push(Workspace {
            id: ws_id,
            title: str_of(t, "title"),
            color: str_of(t, "color"),
            active: Some(id.clone()),
            tabs: vec![Tab { id, shell: str_of(t, "shell").unwrap_or_else(|| "cmd".into()), cwd: str_of(t, "cwd"), ssh: None, title: None, agent_session: None }],
        });
    }
    s
}

/// Ids come from the frontend and end up in file names; only allow a safe alphabet.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[tauri::command]
pub fn session_load(state: State<AppState>) -> Session {
    state.session.snapshot()
}

/// Replaces the whole layout. Ignored during shutdown so closing the window can't
/// overwrite the session that the next launch should restore.
#[tauri::command]
pub fn session_save(state: State<AppState>, session: Session) -> Result<(), String> {
    if state.quitting() {
        return Ok(());
    }
    let json = serde_json::to_vec_pretty(&session).map_err(|e| e.to_string())?;
    let mut cur = state.session.data.lock().unwrap();
    write_atomic(&state.session.dir.join("session.json"), &json).map_err(|e| e.to_string())?;
    *cur = session;
    Ok(())
}

#[tauri::command]
pub async fn scrollback_load(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let Some(path) = state.session.scrollback_path(&id) else { return Ok(String::new()) };
    Ok(fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
pub async fn scrollback_save(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    // A snapshot that races with closing the tab must not resurrect its file.
    if !state.session.has_tab(&id) {
        return Ok(());
    }
    let Some(path) = state.session.scrollback_path(&id) else { return Err("invalid id".into()) };
    write_atomic(&path, data.as_bytes()).map_err(|e| e.to_string())
}
