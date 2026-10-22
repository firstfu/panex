//! Opening what the terminal prints: web links and file paths (Ctrl/⌘+click).
//! Both come from untrusted program output, so nothing here goes through a shell: Windows uses
//! ShellExecuteW, macOS `open`, Linux `xdg-open`, each handed the target as a single argument.

use std::path::{Path, PathBuf};

/// Clicking these would run them rather than show them, so they are revealed in the file manager instead.
const RUNNABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "scr", "hta",
    "cpl", "lnk", "url", "reg", "jar", "pif", "inf", "scf", "appref-ms", "application", "app", "command", "sh",
];

/// Resolves paths seen in the terminal against the tab's cwd; None for anything that doesn't exist.
#[tauri::command]
pub async fn links_resolve(cwd: Option<String>, paths: Vec<String>) -> Vec<Option<String>> {
    paths.iter().take(32).map(|p| resolve(cwd.as_deref(), p)).collect()
}

/// Network paths (\\server\share) are never touched: probing one on hover can stall or leak credentials.
fn is_network(p: &str) -> bool {
    p.starts_with("\\\\") || p.starts_with("//")
}

fn resolve(cwd: Option<&str>, p: &str) -> Option<String> {
    if is_network(p) {
        return None;
    }
    let path = match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => home()?.join(rest),
        None => PathBuf::from(p),
    };
    let full = if path.is_absolute() { path } else { Path::new(cwd?).join(path) };
    full.exists().then(|| full.to_string_lossy().into_owned())
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http(s) links are opened".into());
    }
    shell_open(&url)
}

/// Opens a file `links_resolve` found, in the editor picked in settings ("vscode", "cursor") at the
/// line, or with the system default app ("system"). Runnable files are only revealed.
#[tauri::command]
pub fn open_file(path: String, line: Option<u32>, col: Option<u32>, editor: String) -> Result<(), String> {
    let p = Path::new(&path);
    if is_network(&path) || !p.is_absolute() || !p.exists() {
        return Err(format!("not found: {path}"));
    }
    let runnable = p.is_file()
        && p.extension().and_then(|e| e.to_str()).is_some_and(|e| RUNNABLE.contains(&e.to_ascii_lowercase().as_str()));
    match editor.as_str() {
        "vscode" | "cursor" => shell_open(&editor_url(&editor, &path, line, col)),
        _ if runnable => reveal(p),
        _ => shell_open(&path),
    }
}

/// `vscode://file/C:/src/main.ts:12:3` (Cursor registers the same form under `cursor://`).
fn editor_url(scheme: &str, path: &str, line: Option<u32>, col: Option<u32>) -> String {
    let path = path.replace('\\', "/");
    let mut url = format!("{scheme}://file");
    if !path.starts_with('/') {
        url.push('/');
    }
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:".contains(&b) {
            url.push(b as char);
        } else {
            url.push_str(&format!("%{b:02X}"));
        }
    }
    if let Some(l) = line {
        url.push_str(&format!(":{l}"));
        if let Some(c) = col {
            url.push_str(&format!(":{c}"));
        }
    }
    url
}

#[cfg(windows)]
fn shell_exec(file: &str, params: Option<&str>) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (op, file) = (wide("open"), wide(file));
    let params = params.map(wide);
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            params.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        )
    };
    // Values above 32 mean success.
    if r as isize > 32 { Ok(()) } else { Err(format!("could not open it (ShellExecute error {})", r as isize)) }
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    shell_exec(target, None)
}

#[cfg(windows)]
fn reveal(p: &Path) -> Result<(), String> {
    // Windows file names can't contain '"', so quoting is enough.
    shell_exec("explorer.exe", Some(&format!("/select,\"{}\"", p.display())))
}

#[cfg(target_os = "macos")]
fn shell_open(target: &str) -> Result<(), String> {
    std::process::Command::new("open").arg(target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn reveal(p: &Path) -> Result<(), String> {
    std::process::Command::new("open").arg("-R").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn shell_open(target: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal(p: &Path) -> Result<(), String> {
    shell_open(&p.parent().unwrap_or(p).to_string_lossy())
}
