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
//! 同一個開關也控制 PreToolUse 的 `worktree-guard`（matcher `EnterWorktree`）：在 panex 分頁裡攔下 Claude Code
//! 內建的原地切換，改叫它用 `panex-cli open --worktree` 把任務交給新 agent；不靠使用者的措辭，靠攔動作。
//! WorktreeRemove（`panex-cli worktree-remove`）跟它成對裝、成對移除：有了 WorktreeCreate hook，Claude Code
//! 刪 worktree 時要靠它刪資料夾，panex 也藉此關掉那個 worktree 的工作區。

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const EVENTS: [&str; 5] = ["Notification", "Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"];
/// panex 的 worktree hooks 與對應的 panex-cli 子指令；一律成對安裝、成對移除。
const WORKTREE_HOOKS: [(&str, &str); 2] = [("WorktreeCreate", "worktree-create"), ("WorktreeRemove", "worktree-remove")];

/// 攔 `EnterWorktree` 的 PreToolUse hook：事件、matcher、panex-cli 子指令。跟 worktree hooks 同一個開關。
const GUARD: (&str, &str, &str) = ("PreToolUse", "EnterWorktree", "worktree-guard");

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

pub(crate) fn may_write(debug_build: bool, identifier: &str) -> bool {
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

/// 使用者是否有自己的 worktree hook（不是指向 panex-cli 的）。
fn foreign_worktree_hook(hooks: &Value) -> bool {
    WORKTREE_HOOKS.iter().any(|(e, _)| hooks[e].as_array().is_some_and(|gs| gs.iter().any(|g| !is_panex_group(g))))
}

/// Whether settings.json has the notify hooks for `cli` and, exactly when `worktree` is on, its worktree hooks.
fn status_at(path: &Path, cli: &str, worktree: bool) -> bool {
    let Ok(v) = fs::read(path).map(|b| serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null)) else { return false };
    let has = |e: &str| v["hooks"][e].as_array().is_some_and(|gs| gs.iter().any(|g| has_current(g, cli)));
    let any_panex = WORKTREE_HOOKS.iter().any(|(e, _)| v["hooks"][e].as_array().is_some_and(|gs| gs.iter().any(is_panex_group)));
    // 使用者自己的 worktree hook 優先：不在旁邊加我們的（見 install_at）。
    let worktree_ok = if worktree && !foreign_worktree_hook(&v["hooks"]) { WORKTREE_HOOKS.iter().all(|(e, _)| has(e)) } else { !any_panex };
    // guard 只看有沒有、跟開關是否一致；PreToolUse 裡使用者自己的條目不影響判斷。
    let guard_has = v["hooks"][GUARD.0].as_array().is_some_and(|gs| gs.iter().any(|g| is_panex_group(g) && has_current(g, cli)));
    let guard_any = v["hooks"][GUARD.0].as_array().is_some_and(|gs| gs.iter().any(is_panex_group));
    let guard_ok = if worktree { guard_has } else { !guard_any };
    EVENTS.iter().all(|e| has(e)) && worktree_ok && guard_ok
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
    // WorktreeCreate 只能有一個提供路徑，WorktreeRemove 要收拾的是它建的東西，所以我們的兩個一起進出。
    for (e, _) in WORKTREE_HOOKS {
        if let Some(groups) = hooks.get_mut(e) {
            let groups = groups.as_array_mut().ok_or(format!("hooks.{e} is not an array, left unchanged"))?;
            groups.retain(|g| !is_panex_group(g));
            if groups.is_empty() {
                hooks.remove(e);
            }
        }
    }
    // 兩個 WorktreeCreate 會搶路徑；使用者自己設的 worktree hook 就交給它（這時剩下的都是使用者的）。
    if worktree && WORKTREE_HOOKS.iter().all(|(e, _)| !hooks.contains_key(*e)) {
        for (e, arg) in WORKTREE_HOOKS {
            hooks.insert(e.into(), json!([{ "hooks": [{ "type": "command", "command": cli, "args": [arg], "timeout": 120 }] }]));
        }
    }
    // guard 與 worktree hooks 同開關；先清掉舊的 panex 條目再依開關決定要不要加（使用者自己的 PreToolUse 不動）。
    if let Some(groups) = hooks.get_mut(GUARD.0) {
        let groups = groups.as_array_mut().ok_or(format!("hooks.{} is not an array, left unchanged", GUARD.0))?;
        groups.retain(|g| !is_panex_group(g));
        if groups.is_empty() {
            hooks.remove(GUARD.0);
        }
    }
    if worktree {
        let groups = hooks.entry(GUARD.0).or_insert_with(|| Value::Array(vec![]));
        let groups = groups.as_array_mut().ok_or(format!("hooks.{} is not an array, left unchanged", GUARD.0))?;
        groups.push(json!({ "matcher": GUARD.1, "hooks": [{ "type": "command", "command": cli, "args": [GUARD.2], "timeout": 10 }] }));
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
        // 使用者自己的 PreToolUse 保留在前，我們的 guard 接在後面。
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[0], before["hooks"]["PreToolUse"][0]);
        assert_eq!(pre[1]["matcher"], json!("EnterWorktree"));
        assert_eq!(pre[1]["hooks"][0]["args"], json!(["worktree-guard"]));
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
        assert_eq!(v["hooks"]["WorktreeRemove"][0]["hooks"][0]["args"], json!(["worktree-remove"]));
        assert!(!status_at(&p, CLI, false), "setting turned off: the hook must go");

        install_at(&p, CLI, false).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert!(v["hooks"].get("WorktreeCreate").is_none(), "removed, not left as an empty list");
        assert!(v["hooks"].get("WorktreeRemove").is_none());
        assert!(v["hooks"].get("PreToolUse").is_none(), "guard goes with the setting");
        assert!(status_at(&p, CLI, false));

        // The user's own WorktreeCreate hook stays alone, whatever the setting.
        let own = json!({ "hooks": { "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "svn-worktree.sh" }] }] } });
        fs::write(&p, own.to_string()).unwrap();
        install_at(&p, CLI, true).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"]["WorktreeCreate"], own["hooks"]["WorktreeCreate"]);
        assert!(v["hooks"].get("WorktreeRemove").is_none(), "no WorktreeRemove of ours next to their WorktreeCreate");
        assert!(status_at(&p, CLI, true), "nothing left to do, so launch does not rewrite the file");

        // An install from before WorktreeRemove existed (only our WorktreeCreate) gets the partner added.
        let old = json!({ "hooks": { "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": CLI, "args": ["worktree-create"] }] }] } });
        fs::write(&p, old.to_string()).unwrap();
        assert!(!status_at(&p, CLI, true));
        install_at(&p, CLI, true).unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"]["WorktreeCreate"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["WorktreeRemove"][0]["hooks"][0]["args"], json!(["worktree-remove"]));
        assert!(status_at(&p, CLI, true));
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
