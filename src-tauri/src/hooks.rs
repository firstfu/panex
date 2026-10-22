//! Registers `panex-cli notify` as a Claude Code hook in ~/.claude/settings.json.
//! The installed app does this by itself at launch (`ensure`); the sidebar button is the
//! fallback when that fails. Existing hooks are kept; only entries pointing at a panex-cli are replaced.
//! Outside panex the CLI finds no PANEX_PANE_ID and exits 0 at once, so the global hook is harmless.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

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

/// Identifier of the released app; test instances are built with another one.
const RELEASE_ID: &str = "dev.panex.terminal";

/// Called once at launch: adds the hooks, or repoints them at this install, when they're
/// missing or stale. Debug and test builds never write, so testing can't point the user's
/// real Claude Code at a panex-cli inside `target/`.
pub fn ensure(app: &AppHandle) {
    if !may_write(cfg!(debug_assertions), &app.config().identifier) || hooks_status() {
        return;
    }
    if let Err(e) = hooks_install() {
        eprintln!("panex: could not install Claude Code hooks: {e}");
    }
}

fn may_write(debug_build: bool, identifier: &str) -> bool {
    !debug_build && identifier == RELEASE_ID
}

#[tauri::command]
pub fn hooks_status() -> bool {
    let (Some(path), Some(cli)) = (settings_path(), cli_path()) else { return false };
    status_at(&path, &cli)
}

fn status_at(path: &Path, cli: &str) -> bool {
    let Ok(v) = fs::read(path).map(|b| serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null)) else { return false };
    EVENTS.iter().all(|e| v["hooks"][e].as_array().is_some_and(|gs| gs.iter().any(|g| has_current(g, cli))))
}

#[tauri::command]
pub fn hooks_install() -> Result<String, String> {
    let path = settings_path().ok_or("cannot find the user directory")?;
    let cli = cli_path().ok_or("cannot find the panex-cli path")?;
    install_at(&path, &cli)?;
    Ok(path.to_string_lossy().into_owned())
}

fn install_at(path: &Path, cli: &str) -> Result<(), String> {
    let mut root: Value = match fs::read(path) {
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
        fs::copy(path, path.with_extension("json.panex-bak")).map_err(|e| e.to_string())?;
    } else if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(path, text + "\n").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir; each test gets its own.
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("panex-test-hooks-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const CLI: &str = r"C:\Users\you\AppData\Local\panex\panex-cli.exe";

    #[test]
    fn only_the_released_app_writes() {
        assert!(may_write(false, "dev.panex.terminal"));
        assert!(!may_write(true, "dev.panex.terminal"), "debug build (cargo tauri dev)");
        assert!(!may_write(false, "dev.panex.terminal.test"), "isolated test instance");
    }

    #[test]
    fn install_keeps_other_hooks_and_repoints_stale_ones() {
        let d = scratch("install");
        let p = d.join("settings.json");
        let before = json!({
            "model": "opus",
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "my-own-hook.sh" }] },
                    { "hooks": [{ "type": "command", "command": r"D:\src\panex\target\test-build\panex-cli.exe", "args": ["notify"] }] }
                ],
                "PreToolUse": [{ "hooks": [{ "type": "command", "command": "guard" }] }]
            }
        });
        fs::write(&p, before.to_string()).unwrap();
        assert!(!status_at(&p, CLI), "a hook pointing at another panex-cli is stale");

        install_at(&p, CLI).unwrap();
        assert!(status_at(&p, CLI));
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["model"], json!("opus"));
        assert_eq!(v["hooks"]["PreToolUse"], before["hooks"]["PreToolUse"]);
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "the stale panex entry is replaced, not duplicated");
        assert_eq!(stop[0]["hooks"][0]["command"], json!("my-own-hook.sh"));
        assert_eq!(stop[1]["hooks"][0]["command"], json!(CLI));
        let bak: Value = serde_json::from_slice(&fs::read(p.with_extension("json.panex-bak")).unwrap()).unwrap();
        assert_eq!(bak, before);

        // The next launch finds everything current and writes nothing.
        assert!(status_at(&p, CLI));
    }

    #[test]
    fn install_creates_a_missing_file() {
        let p = scratch("missing").join(".claude").join("settings.json");
        install_at(&p, CLI).unwrap();
        assert!(status_at(&p, CLI));
    }

    #[test]
    fn install_leaves_a_broken_file_alone() {
        let p = scratch("broken").join("settings.json");
        for text in ["{ not json", "[]", r#"{"hooks":[]}"#, r#"{"hooks":{"Stop":{}}}"#] {
            fs::write(&p, text).unwrap();
            assert!(install_at(&p, CLI).is_err(), "{text}");
            assert_eq!(fs::read_to_string(&p).unwrap(), text);
        }
    }
}
