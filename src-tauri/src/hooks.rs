//! Registers `panex-cli notify` as a Claude Code hook in ~/.claude/settings.json.
//! Existing hooks are kept; only entries pointing at a panex-cli are replaced.
//! Outside panex the CLI finds no PANEX_PANE_ID and exits 0 at once, so the global hook is harmless.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

const EVENTS: [&str; 5] = ["Notification", "Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"];

fn settings_path() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude").join("settings.json"))
}

fn cli_path() -> Option<String> {
    let name = if cfg!(windows) { "panex-cli.exe" } else { "panex-cli" };
    let p = std::env::current_exe().ok()?.parent()?.join(name);
    Some(p.to_string_lossy().into_owned())
}

fn is_panex_group(group: &Value) -> bool {
    group["hooks"].as_array().is_some_and(|hs| {
        hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains("panex-cli")))
    })
}

fn has_current(group: &Value, cli: &str) -> bool {
    group["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"].as_str() == Some(cli)))
}

#[tauri::command]
pub fn hooks_status() -> bool {
    let (Some(path), Some(cli)) = (settings_path(), cli_path()) else { return false };
    let Ok(v) = fs::read(path).map(|b| serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null)) else { return false };
    EVENTS.iter().all(|e| v["hooks"][e].as_array().is_some_and(|gs| gs.iter().any(|g| has_current(g, &cli))))
}

#[tauri::command]
pub fn hooks_install() -> Result<String, String> {
    let path = settings_path().ok_or("cannot find the user directory")?;
    let cli = cli_path().ok_or("cannot find the panex-cli path")?;
    let mut root: Value = match fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("settings.json is not valid JSON, left unchanged: {e}"))?,
        Err(_) => Value::Object(Map::new()),
    };
    let obj = root.as_object_mut().ok_or("settings.json top level is not an object, left unchanged")?;
    let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks.as_object_mut().ok_or("hooks in settings.json is not an object, left unchanged")?;
    for e in EVENTS {
        let groups = hooks.entry(e).or_insert_with(|| Value::Array(vec![]));
        let groups = groups.as_array_mut().ok_or(format!("hooks.{e} is not an array, left unchanged"))?;
        groups.retain(|g| !is_panex_group(g));
        // Exec form: no shell, so paths with spaces or backslashes need no quoting.
        groups.push(json!({ "hooks": [{ "type": "command", "command": cli, "args": ["notify"], "timeout": 10 }] }));
    }
    if path.exists() {
        fs::copy(&path, path.with_extension("json.panex-bak")).map_err(|e| e.to_string())?;
    } else if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(&path, text + "\n").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
