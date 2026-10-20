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
            if v.is_object() { Ok(v) } else { Err("最外層必須是物件 { }".into()) }
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
    let p = path();
    let Ok(mut root) = read(&p) else { return };
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return;
    }
    let _ = fs::copy(&p, p.with_extension("json.v1.bak"));
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
    let _ = write_atomic(&p, &with_header(root));
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
    let file = self::path();
    let mut root = read(&file).map_err(|e| format!("panex.json 有錯誤，未寫入：{e}"))?;
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
    write_atomic(&file, &with_header(root))
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
