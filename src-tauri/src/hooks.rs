//! Registers `panex-cli notify` as a Claude Code hook in ~/.claude/settings.json.
//! The installed app does this by itself at launch (`ensure`); the sidebar button is the
//! fallback when that fails. Existing hooks are kept; only entries pointing at a panex-cli are replaced.
//! Outside panex the CLI finds no PANEX_PANE_ID and exits 0 at once, so the global hook is harmless.
//! `ensure` also keeps ~/.claude/skills/panex/SKILL.md (how an agent uses `panex-cli open|wait`)
//! in step with this version; the skill itself tells the agent to do nothing outside panex.
//! With agent.worktreeViaPanex on (the default), a WorktreeCreate hook (`panex-cli worktree-create`)
//! is added too, so worktrees Claude opens land next to the repo and in panex's sidebar. Unlike
//! notify it changes what Claude Code does everywhere (the hook replaces its own `git worktree`
//! step), so it is removed again when the setting is turned off.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const EVENTS: [&str; 5] = ["Notification", "Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"];
const WORKTREE_EVENT: &str = "WorktreeCreate";

/// Shipped inside the binary, so the skill always matches this version's panex-cli.
const SKILL: &str = include_str!("../../skills/panex/SKILL.md");

fn claude_dir() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude"))
}

fn settings_path() -> Option<PathBuf> {
    Some(claude_dir()?.join("settings.json"))
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
pub(crate) const RELEASE_ID: &str = "dev.panex.terminal";

/// Called once at launch: adds the hooks, or repoints them at this install, when they're
/// missing or stale. Debug and test builds never write, so testing can't point the user's
/// real Claude Code at a panex-cli inside `target/`.
pub fn ensure(app: &AppHandle) {
    if !may_write(cfg!(debug_assertions), &app.config().identifier) {
        return;
    }
    if !hooks_status() {
        if let Err(e) = hooks_install() {
            eprintln!("panex: could not install Claude Code hooks: {e}");
        }
    }
    if let Some(dir) = claude_dir() {
        if let Err(e) = skill_at(&dir.join("skills").join("panex")) {
            eprintln!("panex: could not install the Claude Code skill: {e}");
        }
    }
}

/// Writes SKILL.md into `dir` unless it already holds this version's text; true if it wrote.
fn skill_at(dir: &Path) -> Result<bool, String> {
    let path = dir.join("SKILL.md");
    if fs::read_to_string(&path).is_ok_and(|t| t == SKILL) {
        return Ok(false);
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(&path, SKILL).map_err(|e| e.to_string())?;
    Ok(true)
}

fn may_write(debug_build: bool, identifier: &str) -> bool {
    !debug_build && identifier == RELEASE_ID
}

/// agent.worktreeViaPanex in panex.json; on unless it is explicitly false.
fn worktree_via_panex() -> bool {
    fs::read(crate::config::dir().join("panex.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).ok())
        .map_or(true, |v| v["agent"]["worktreeViaPanex"] != Value::Bool(false))
}

#[tauri::command]
pub fn hooks_status() -> bool {
    let (Some(path), Some(cli)) = (settings_path(), cli_path()) else { return false };
    status_at(&path, &cli, worktree_via_panex())
}

/// Whether settings.json has the notify hooks for `cli` and, exactly when `worktree` is on, its WorktreeCreate hook.
fn status_at(path: &Path, cli: &str, worktree: bool) -> bool {
    let Ok(v) = fs::read(path).map(|b| serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null)) else { return false };
    let has = |e: &str| v["hooks"][e].as_array().is_some_and(|gs| gs.iter().any(|g| has_current(g, cli)));
    let wt = v["hooks"][WORKTREE_EVENT].as_array();
    let any_panex = wt.is_some_and(|gs| gs.iter().any(is_panex_group));
    let foreign = wt.is_some_and(|gs| gs.iter().any(|g| !is_panex_group(g)));
    // The user's own WorktreeCreate hook wins: ours is not added next to it (see install_at).
    let worktree_ok = if worktree && !foreign { has(WORKTREE_EVENT) } else { !any_panex };
    EVENTS.iter().all(|e| has(e)) && worktree_ok
}

#[tauri::command]
pub fn hooks_install() -> Result<String, String> {
    let path = settings_path().ok_or("cannot find the user directory")?;
    let cli = cli_path().ok_or("cannot find the panex-cli path")?;
    install_at(&path, &cli, worktree_via_panex())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Called when the worktree setting changes: brings settings.json in line with it right away.
/// Like `ensure`, only the installed app writes.
#[tauri::command]
pub fn hooks_sync(app: AppHandle) -> Result<(), String> {
    if !may_write(cfg!(debug_assertions), &app.config().identifier) || hooks_status() {
        return Ok(());
    }
    hooks_install().map(|_| ())
}

fn install_at(path: &Path, cli: &str, worktree: bool) -> Result<(), String> {
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
    // Only one WorktreeCreate hook can supply the path, so ours goes in or out as a whole.
    if let Some(groups) = hooks.get_mut(WORKTREE_EVENT) {
        let groups = groups.as_array_mut().ok_or(format!("hooks.{WORKTREE_EVENT} is not an array, left unchanged"))?;
        groups.retain(|g| !is_panex_group(g));
        if groups.is_empty() {
            hooks.remove(WORKTREE_EVENT);
        }
    }
    // Claude Code takes the worktree path from the hook, so two hooks would fight over it; a
    // WorktreeCreate hook the user set up themselves is left in charge.
    if worktree && !hooks.contains_key(WORKTREE_EVENT) {
        let groups = hooks.entry(WORKTREE_EVENT).or_insert_with(|| Value::Array(vec![]));
        let groups = groups.as_array_mut().ok_or(format!("hooks.{WORKTREE_EVENT} is not an array, left unchanged"))?;
        groups.push(json!({ "hooks": [{ "type": "command", "command": cli, "args": ["worktree-create"], "timeout": 120 }] }));
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
        assert!(!status_at(&p, CLI, true), "a hook pointing at another panex-cli is stale");

        install_at(&p, CLI, true).unwrap();
        assert!(status_at(&p, CLI, true));
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
        assert!(status_at(&p, CLI, true));
    }

    #[test]
    fn skill_is_written_once_and_refreshed_when_it_differs() {
        let d = scratch("skill").join("skills").join("panex");
        assert!(skill_at(&d).unwrap(), "missing: written");
        assert_eq!(fs::read_to_string(d.join("SKILL.md")).unwrap(), SKILL);
        assert!(!skill_at(&d).unwrap(), "current: left alone");
        fs::write(d.join("SKILL.md"), "old version").unwrap();
        assert!(skill_at(&d).unwrap(), "stale: replaced");
        assert_eq!(fs::read_to_string(d.join("SKILL.md")).unwrap(), SKILL);
        // The embedded file is the real skill (git may check it out with either line ending).
        assert!(SKILL.starts_with("---") && SKILL.lines().nth(1) == Some("name: panex"));
    }

    #[test]
    fn worktree_hook_follows_the_setting_and_yields_to_the_users_own() {
        let d = scratch("worktree");
        let p = d.join("settings.json");
        install_at(&p, CLI, true).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"]["WorktreeCreate"][0]["hooks"][0]["args"], json!(["worktree-create"]));
        assert!(!status_at(&p, CLI, false), "setting turned off: the hook must go");

        install_at(&p, CLI, false).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert!(v["hooks"].get("WorktreeCreate").is_none(), "removed, not left as an empty list");
        assert!(status_at(&p, CLI, false));

        // The user's own WorktreeCreate hook stays alone, whatever the setting.
        let own = json!({ "hooks": { "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "svn-worktree.sh" }] }] } });
        fs::write(&p, own.to_string()).unwrap();
        install_at(&p, CLI, true).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"]["WorktreeCreate"], own["hooks"]["WorktreeCreate"]);
        assert!(status_at(&p, CLI, true), "nothing left to do, so launch does not rewrite the file");
    }

    #[test]
    fn install_creates_a_missing_file() {
        let p = scratch("missing").join(".claude").join("settings.json");
        install_at(&p, CLI, true).unwrap();
        assert!(status_at(&p, CLI, true));
    }

    #[test]
    fn install_leaves_a_broken_file_alone() {
        let p = scratch("broken").join("settings.json");
        for text in ["{ not json", "[]", r#"{"hooks":[]}"#, r#"{"hooks":{"Stop":{}}}"#] {
            fs::write(&p, text).unwrap();
            assert!(install_at(&p, CLI, true).is_err(), "{text}");
            assert_eq!(fs::read_to_string(&p).unwrap(), text);
        }
    }
}
