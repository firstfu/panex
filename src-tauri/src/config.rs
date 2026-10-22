//! User config in `~/.config/panex/panex.json`, modeled on cmux's `cmux.json`:
//! one JSON file the user can hand-edit, a `$schema` next to it for editor completion,
//! and live reload ~300 ms after the last save. The settings panel writes single keys
//! into the same file and leaves everything else (including unknown keys) alone.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SCHEMA: &str = include_str!("../../schemas/panex.schema.json");
const FILE: &str = "panex.json";
/// 2: sidebar entries became workspaces holding horizontal tabs; shortcut ids were renamed.
const SCHEMA_VERSION: u64 = 2;

/// v1 action id → v2 id. In v1 every sidebar entry was a single terminal ("tab"); in v2 the
/// sidebar holds workspaces and "tab" means a horizontal tab inside one (as in cmux).
const V1_RENAMES: [(&str, &str); 9] = [
    ("newTab", "newWorkspace"),
    ("newTabWithShell", "newWorkspaceWithShell"),
    ("renameTab", "renameWorkspace"),
    ("selectTabByNumber", "selectWorkspaceByNumber"),
    ("nextTab", "nextWorkspace"),
    ("prevTab", "prevWorkspace"),
    ("moveTabUp", "moveWorkspaceUp"),
    ("moveTabDown", "moveWorkspaceDown"),
    ("cycleTabNext", "nextTab"),
];

#[derive(Serialize, Clone)]
pub struct Loaded {
    config: Value,
    /// Parse error of the file on disk; `config` is then the last good one (or empty).
    error: Option<String>,
    path: String,
}

pub fn dir() -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".config"))
        .join("panex")
}

fn path() -> PathBuf {
    dir().join(FILE)
}

fn read(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(b) if b.iter().all(u8::is_ascii_whitespace) => Ok(Value::Object(Map::new())),
        Ok(b) => {
            let b = b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b);
            let v: Value = serde_json::from_slice(b).map_err(|e| e.to_string())?;
            if v.is_object() { Ok(v) } else { Err("the top level must be an object { }".into()) }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(e.to_string()),
    }
}

fn write_atomic(path: &Path, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn with_header(mut v: Value) -> Value {
    let obj = v.as_object_mut().expect("config is an object");
    let mut out = Map::new();
    out.insert("$schema".into(), json!("./panex.schema.json"));
    out.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    for (k, val) in std::mem::take(obj) {
        if k != "$schema" && k != "schemaVersion" {
            out.insert(k, val);
        }
    }
    Value::Object(out)
}

/// Opening window size (logical px) when panex.json doesn't set `app.windowWidth/Height`.
/// Keep in sync with DEFAULTS in main.ts and tauri.conf.json.
const DEFAULT_WINDOW: (f64, f64) = (1518.0, 860.0);

/// Sizes the window from `app.windowWidth` / `app.windowHeight`, shrunk to fit its monitor.
/// The window-state plugin restores position only, so this is the size every launch opens at.
pub fn apply_window_size(w: &tauri::WebviewWindow) {
    let cfg = read(&path()).unwrap_or_default();
    let get = |k: &str, d: f64| cfg.pointer(&format!("/app/{k}")).and_then(Value::as_f64).unwrap_or(d);
    let (mut width, mut height) = (get("windowWidth", DEFAULT_WINDOW.0), get("windowHeight", DEFAULT_WINDOW.1));
    if let Ok(Some(m)) = w.current_monitor() {
        let area = m.work_area().size.to_logical::<f64>(m.scale_factor());
        width = width.min(area.width);
        height = height.min(area.height);
    }
    let _ = w.set_size(tauri::LogicalSize::new(width.max(480.0), height.max(300.0)));
}

/// Creates the config dir, refreshes the bundled schema, migrates the old
/// app-data `settings.json` once, and starts the file watcher.
pub fn init(app: &AppHandle, old_settings: PathBuf) {
    let d = dir();
    let _ = fs::create_dir_all(&d);
    let schema = d.join("panex.schema.json");
    if fs::read_to_string(&schema).ok().as_deref() != Some(SCHEMA) {
        let _ = fs::write(&schema, SCHEMA);
    }
    if !path().exists() {
        let migrated = migrate(&old_settings);
        let _ = write_atomic(&path(), &with_header(migrated));
        let _ = fs::remove_file(&old_settings);
    }
    migrate_v1_bindings();
    watch(app.clone());
}

/// Renames v1 shortcut ids in one pass (each old key maps to exactly one new key), keeping
/// a backup. Runs only on files that say schemaVersion 1, so it never runs twice.
fn migrate_v1_bindings() {
    migrate_v1_bindings_at(&path());
}

fn migrate_v1_bindings_at(p: &Path) {
    let Ok(mut root) = read(p) else { return };
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return;
    }
    let _ = fs::copy(p, p.with_extension("json.v1.bak"));
    if let Some(old) = root.pointer_mut("/shortcuts/bindings").and_then(Value::as_object_mut) {
        let mut new = Map::new();
        for (k, v) in std::mem::take(old) {
            let k = match V1_RENAMES.iter().find(|(from, _)| *from == k) {
                Some((_, to)) => to.to_string(),
                None if k == "cycleTabPrev" => "prevTab".into(),
                None => k,
            };
            new.insert(k, v);
        }
        *old = new;
    }
    let _ = write_atomic(p, &with_header(root));
}

/// v0.1 kept flat settings in app data; map them onto the nested layout.
fn migrate(old: &Path) -> Value {
    let Ok(Value::Object(o)) = fs::read(old).map(|b| serde_json::from_slice(&b).unwrap_or(Value::Null)) else {
        return Value::Object(Map::new());
    };
    let mut v = json!({});
    let mut put = |section: &str, key: &str, val: Option<&Value>| {
        if let Some(val) = val {
            v[section][key] = val.clone();
        }
    };
    put("app", "opacity", o.get("opacity"));
    put("app", "windowEffect", o.get("effect"));
    put("terminal", "fontSize", o.get("fontSize"));
    put("terminal", "fontFamily", o.get("fontFamily"));
    put("terminal", "defaultShell", o.get("defaultShell"));
    put("terminal", "cursorBlink", o.get("cursorBlink"));
    put("sidebar", "hidden", o.get("sidebarHidden"));
    v
}

fn watch(app: AppHandle) {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| p.file_name().is_some_and(|n| n == FILE)) {
                let _ = tx.send(());
            }
        }
    }) {
        Ok(w) => w,
        Err(e) => return eprintln!("panex: config watcher unavailable: {e}"),
    };
    // Watch the directory: editors often save by writing a temp file and renaming it.
    if let Err(e) = watcher.watch(&dir(), RecursiveMode::NonRecursive) {
        return eprintln!("panex: cannot watch config dir: {e}");
    }
    std::thread::spawn(move || {
        let _keep = watcher;
        while rx.recv().is_ok() {
            // Coalesce bursts; reload 300 ms after the last write.
            while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
            let _ = app.emit("config-changed", load_now());
        }
    });
}

fn load_now() -> Loaded {
    let p = path();
    let (config, error) = match read(&p) {
        Ok(v) => (v, None),
        Err(e) => (Value::Null, Some(e)),
    };
    Loaded { config, error, path: p.to_string_lossy().into_owned() }
}

#[tauri::command]
pub fn config_load() -> Loaded {
    load_now()
}

/// Sets one key, e.g. path ["shortcuts","bindings","newTab"]. `null` removes the key
/// (falls back to the default). Refuses to touch a file that doesn't parse.
#[tauri::command]
pub fn config_set(path: Vec<String>, value: Value) -> Result<(), String> {
    config_set_at(&self::path(), &path, value)
}

fn config_set_at(file: &Path, path: &[String], value: Value) -> Result<(), String> {
    let mut root = read(file).map_err(|e| format!("panex.json has an error, nothing written: {e}"))?;
    let Some((last, parents)) = path.split_last() else { return Err("empty path".into()) };
    let mut cur = &mut root;
    for k in parents {
        if !cur.get(k).is_some_and(Value::is_object) {
            cur[k] = json!({});
        }
        cur = cur.get_mut(k).unwrap();
    }
    let obj = cur.as_object_mut().unwrap();
    if value.is_null() {
        obj.remove(last);
    } else {
        obj.insert(last.clone(), value);
    }
    prune_empty(&mut root);
    write_atomic(file, &with_header(root))
}

/// Drops sections left empty after removing keys, so the file stays minimal.
fn prune_empty(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        for child in o.values_mut() {
            prune_empty(child);
        }
        o.retain(|_, c| !c.as_object().is_some_and(Map::is_empty));
    }
}

/// Opens panex.json in the user's default editor for .json files.
#[tauri::command]
pub fn config_open() -> Result<(), String> {
    let p = path();
    if !p.exists() {
        write_atomic(&p, &with_header(json!({})))?;
    }
    open_path(&p)
}

fn open_path(p: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: don't flash a console for `cmd /c start`.
        std::process::Command::new("cmd")
            .args(["/c", "start", ""])
            .arg(p)
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir; each test gets its own.
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("panex-test-config-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn load(p: &Path) -> Value {
        serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
    }

    fn keys(k: &[&str]) -> Vec<String> {
        k.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn v1_bindings_are_renamed_once_with_a_backup() {
        let d = scratch("v1");
        let p = d.join(FILE);
        let v1 = json!({
            "schemaVersion": 1,
            "terminal": { "fontSize": 15 },
            "shortcuts": { "bindings": {
                "newTab": "ctrl+n", "cycleTabNext": "ctrl+tab", "cycleTabPrev": "ctrl+shift+tab",
                "moveTabUp": null, "clearScrollback": "ctrl+k"
            } }
        });
        fs::write(&p, v1.to_string()).unwrap();
        migrate_v1_bindings_at(&p);

        let v2 = load(&p);
        assert_eq!(v2["schemaVersion"], json!(SCHEMA_VERSION));
        assert_eq!(v2["$schema"], json!("./panex.schema.json"));
        assert_eq!(v2["terminal"]["fontSize"], json!(15));
        assert_eq!(
            v2["shortcuts"]["bindings"],
            json!({
                "newWorkspace": "ctrl+n", "nextTab": "ctrl+tab", "prevTab": "ctrl+shift+tab",
                "moveWorkspaceUp": null, "clearScrollback": "ctrl+k"
            })
        );
        assert_eq!(load(&p.with_extension("json.v1.bak")), v1);

        // A second run must not rename v2 ids again (v2 "newTab" is a different action).
        config_set_at(&p, &keys(&["shortcuts", "bindings", "newTab"]), json!("ctrl+t")).unwrap();
        migrate_v1_bindings_at(&p);
        assert_eq!(load(&p)["shortcuts"]["bindings"]["newTab"], json!("ctrl+t"));
        assert_eq!(load(&p)["shortcuts"]["bindings"]["newWorkspace"], json!("ctrl+n"));
    }

    #[test]
    fn every_v1_rename_lands_on_a_distinct_id() {
        let mut to: Vec<_> = V1_RENAMES.iter().map(|(_, t)| *t).collect();
        to.push("prevTab");
        let n = to.len();
        to.sort();
        to.dedup();
        assert_eq!(to.len(), n, "two v1 ids would merge into one v2 id and lose a binding");
    }

    #[test]
    fn v2_file_is_left_untouched() {
        let d = scratch("v2");
        let p = d.join(FILE);
        let text = r#"{"schemaVersion":2,"shortcuts":{"bindings":{"newTab":"ctrl+t"}}}"#;
        fs::write(&p, text).unwrap();
        migrate_v1_bindings_at(&p);
        assert_eq!(fs::read_to_string(&p).unwrap(), text);
        assert!(!p.with_extension("json.v1.bak").exists());
    }

    #[test]
    fn v01_settings_map_onto_sections() {
        let d = scratch("v01");
        let old = d.join("settings.json");
        fs::write(&old, r#"{"opacity":80,"effect":"mica","fontSize":14,"sidebarHidden":true,"unknown":1}"#).unwrap();
        assert_eq!(
            migrate(&old),
            json!({ "app": { "opacity": 80, "windowEffect": "mica" }, "terminal": { "fontSize": 14 }, "sidebar": { "hidden": true } })
        );
        assert_eq!(migrate(&d.join("missing.json")), json!({}));
    }

    #[test]
    fn read_accepts_bom_and_blank_and_rejects_non_objects() {
        let d = scratch("read");
        let p = d.join(FILE);
        fs::write(&p, b"\xEF\xBB\xBF{\"a\":1}").unwrap();
        assert_eq!(read(&p).unwrap(), json!({ "a": 1 }));
        fs::write(&p, " \r\n").unwrap();
        assert_eq!(read(&p).unwrap(), json!({}));
        assert_eq!(read(&d.join("missing.json")).unwrap(), json!({}));
        fs::write(&p, "[1]").unwrap();
        assert!(read(&p).is_err());
        fs::write(&p, "{ broken").unwrap();
        assert!(read(&p).is_err());
    }

    #[test]
    fn config_set_writes_one_key_and_prunes_empty_sections() {
        let d = scratch("set");
        let p = d.join(FILE);
        fs::write(&p, r#"{"terminal":{"fontSize":15},"custom":{"keep":true}}"#).unwrap();

        config_set_at(&p, &keys(&["shortcuts", "bindings", "find"]), json!(null)).unwrap();
        config_set_at(&p, &keys(&["agent", "confirmCloseWhileRunning"]), json!(false)).unwrap();
        let v = load(&p);
        assert_eq!(v["agent"]["confirmCloseWhileRunning"], json!(false));
        assert_eq!(v["terminal"]["fontSize"], json!(15));
        assert_eq!(v["custom"]["keep"], json!(true), "unknown keys survive");
        assert!(v.get("shortcuts").is_none(), "removing a missing key leaves no empty sections");

        config_set_at(&p, &keys(&["agent", "confirmCloseWhileRunning"]), json!(null)).unwrap();
        assert!(load(&p).get("agent").is_none());
        assert!(config_set_at(&p, &[], json!(1)).is_err());
    }

    #[test]
    fn config_set_refuses_a_broken_file() {
        let d = scratch("broken");
        let p = d.join(FILE);
        fs::write(&p, "{ \"terminal\": ").unwrap();
        assert!(config_set_at(&p, &keys(&["app", "opacity"]), json!(50)).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), "{ \"terminal\": ");
    }
}
