//! One pseudo-terminal per tab. Output streams to the frontend as raw bytes over a Tauri
//! channel; xterm.js does the UTF-8 decoding, so multi-byte characters split across
//! reads are never mangled here.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session::valid_id;
use crate::AppState;

pub struct Pane {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// None if the job could not be set up; the tab still works, it just isn't contained.
    #[cfg(windows)]
    job: Option<crate::job::Job>,
    /// The shell's pid, the root of the tree `pty_hibernate` inspects.
    #[cfg(windows)]
    pid: Option<u32>,
    /// Swappable so a reloaded webview can re-attach to a shell that is still running.
    out: Arc<Mutex<Channel<InvokeResponseBody>>>,
}

pub type PtyMap = Mutex<HashMap<String, Pane>>;

#[derive(Serialize, Clone)]
pub struct ShellInfo {
    id: &'static str,
    name: &'static str,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
    code: u32,
}

#[tauri::command]
pub fn shells_list() -> Vec<ShellInfo> {
    let mut v = Vec::new();
    if cfg!(windows) {
        v.push(ShellInfo { id: "cmd", name: "命令提示字元" });
        v.push(ShellInfo { id: "powershell", name: "Windows PowerShell" });
        if find_in_path("pwsh.exe").is_some() {
            v.push(ShellInfo { id: "pwsh", name: "PowerShell 7" });
        }
    } else {
        v.push(ShellInfo { id: "default", name: "預設 shell" });
    }
    v
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    shell: String,
    ssh: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("invalid id".into());
    }
    if let Some(pane) = state.ptys.lock().unwrap().get(&id) {
        *pane.out.lock().unwrap() = on_data;
        return Ok(());
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let dir = cwd
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(home_dir);
    let mut cmd = match (shell.as_str(), ssh.as_deref()) {
        ("ssh", Some(target)) => crate::ssh::command(target)?,
        ("ssh", None) => return Err("missing ssh target".into()),
        _ => build_command(&shell),
    };
    if let Some(d) = &dir {
        cmd.cwd(d);
    }
    scrub_parent_agent_env(&mut cmd);
    cmd.env("PANEX_PANE_ID", &id);
    cmd.env("PANEX_PIPE", crate::notify::pipe_name());
    // Lets `panex-cli open|wait` in this tab drive panex; processes outside panex never see it.
    cmd.env("PANEX_TOKEN", crate::control::token());
    cmd.env("TERM_PROGRAM", "panex");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM", "xterm-256color");
    if let Some(path) = path_with_exe_dir() {
        cmd.env("PATH", path);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    #[cfg(windows)]
    let pid = child.process_id();
    #[cfg(windows)]
    let job = child.as_raw_handle().and_then(|h| {
        crate::job::Job::assign(h).map_err(|e| eprintln!("panex: tab {id} not in a job: {e}")).ok()
    });

    let out = Arc::new(Mutex::new(on_data));
    let mine = out.clone();
    state.ptys.lock().unwrap().insert(
        id.clone(),
        Pane {
            writer,
            master: pair.master,
            killer,
            #[cfg(windows)]
            job,
            #[cfg(windows)]
            pid,
            out: out.clone(),
        },
    );

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // A send error means the webview is gone (reload/crash); keep draining.
                    let _ = out.lock().unwrap().send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                }
            }
        }
    });

    // On ConPTY the reader never sees EOF while the pseudoconsole is open, so exit is
    // driven by waiting on the child; dropping the pane closes the console and frees the reader.
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let state = app.state::<AppState>();
        if state.quitting() {
            return;
        }
        // A pane that is no longer this one's was hibernated (and maybe already restarted):
        // the tab lives on, so there is no exit to report.
        let pane = {
            let mut map = state.ptys.lock().unwrap();
            match map.get(&id) {
                Some(p) if Arc::ptr_eq(&p.out, &mine) => map.remove(&id),
                _ => None,
            }
        };
        let Some(pane) = pane else { return };
        crate::control::pane_exited(&app, &id);
        drop(pane);
        let _ = app.emit("pty-exit", ExitPayload { id, code });
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let pane = map.get_mut(&id).ok_or("no such pty")?;
    pane.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pane.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.ptys.lock().unwrap();
    let pane = map.get(&id).ok_or("no such pty")?;
    pane.master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Usage {
    id: String,
    bytes: u64,
    procs: u32,
}

/// Memory and process count of each running tab, read on demand (the resources dialog,
/// hovering a workspace). Empty off Windows, where tabs have no job to ask.
#[tauri::command]
pub fn pty_usage(state: State<AppState>) -> Vec<Usage> {
    #[cfg(windows)]
    {
        let map = state.ptys.lock().unwrap();
        map.iter()
            .filter_map(|(id, p)| p.job.as_ref().map(|j| (id, j.usage())))
            .map(|(id, (bytes, procs))| Usage { id: id.clone(), bytes, procs })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Vec::new()
    }
}

/// Closes a tab for good: deletes its scrollback and kills its shell. The frontend saves
/// the layout without the tab first, so a late snapshot can't bring the file back.
#[tauri::command]
pub fn tab_close(state: State<AppState>, id: String) {
    if state.quitting() {
        return;
    }
    if let Some(p) = state.session.scrollback_path(&id) {
        let _ = std::fs::remove_file(p);
    }
    if let Some(pane) = state.ptys.lock().unwrap().get_mut(&id) {
        #[cfg(windows)]
        if let Some(job) = &pane.job {
            job.terminate();
        }
        let _ = pane.killer.kill();
    }
}

/// Ends a tab's shell and everything in it to free their memory, keeping the tab (its
/// scrollback stays in the frontend's xterm). The next `pty_spawn` starts a fresh shell.
/// With `only_agent`, does nothing and returns false unless all that would end is a
/// Claude Code the frontend can `--resume` (see `Job::only_agent`).
#[tauri::command]
pub fn pty_hibernate(state: State<AppState>, id: String, only_agent: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let mut map = state.ptys.lock().unwrap();
        let Some(pane) = map.get(&id) else { return Ok(false) };
        let Some(job) = &pane.job else { return Err("tab not in a job".into()) };
        if only_agent && !pane.pid.is_some_and(|pid| job.only_agent(pid)) {
            return Ok(false);
        }
        let mut pane = map.remove(&id).unwrap();
        drop(map);
        if let Some(job) = &pane.job {
            job.terminate();
        }
        let _ = pane.killer.kill();
        // Closing the pseudoconsole can block while it drains; keep that off the IPC thread.
        std::thread::spawn(move || drop(pane));
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        // Killing the shell would leave claude and its MCP servers running: nothing freed.
        let _ = (state, id, only_agent);
        Err("not supported on this platform".into())
    }
}

/// Called once on app exit. The session is left untouched so the next launch restores it.
pub fn kill_all(state: &AppState) {
    let mut map = state.ptys.lock().unwrap();
    for pane in map.values_mut() {
        let _ = pane.killer.kill();
    }
    // Closing a pseudoconsole can block while it drains; the process is exiting anyway,
    // so let the OS reclaim the handles instead of dropping them here. That includes the
    // job handles, whose closing then kills whatever is left in each tab.
    for (_, pane) in map.drain() {
        std::mem::forget(pane);
    }
}

#[cfg(windows)]
fn build_command(shell: &str) -> CommandBuilder {
    match shell {
        "powershell" | "pwsh" => {
            let mut cmd = CommandBuilder::new(if shell == "pwsh" { "pwsh.exe" } else { "powershell.exe" });
            // Wrap the user's prompt so every prompt reports the cwd (OSC 9;9).
            // -EncodedCommand avoids quoting issues and is not blocked by ExecutionPolicy.
            let script = "$global:__panexPrompt = $function:prompt\n\
                function global:prompt { $o = & $global:__panexPrompt; \
                \"$([char]27)]9;9;$($executionContext.SessionState.Path.CurrentLocation.ProviderPath)$([char]27)\\$o\" }";
            cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encode_ps(script)]);
            cmd
        }
        _ => {
            let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
            let mut cmd = CommandBuilder::new(comspec);
            // $e]9;9;$P$e\ reports the cwd on every prompt (same convention as Windows Terminal).
            let prompt = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
            cmd.env("PROMPT", format!("$e]9;9;$P$e\\{prompt}"));
            cmd
        }
    }
}

#[cfg(not(windows))]
fn build_command(_shell: &str) -> CommandBuilder {
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(&sh);
    cmd.arg("-l");
    // Make every prompt report the cwd (OSC 9;9), like our cmd/PowerShell prompts do.
    match Path::new(&sh).file_name().and_then(|n| n.to_str()) {
        Some("zsh") => {
            if let Some(dir) = ZSH_DIR.get() {
                if let Some(user) = std::env::var_os("ZDOTDIR") {
                    cmd.env("PANEX_USER_ZDOTDIR", user);
                }
                cmd.env("ZDOTDIR", dir);
            }
        }
        // bash takes PROMPT_COMMAND from the environment; rc files that append to it keep ours.
        Some("bash") => cmd.env("PROMPT_COMMAND", r#"printf '\033]9;9;%s\033\\' "$PWD""#),
        _ => {}
    }
    cmd
}

#[cfg(not(windows))]
static ZSH_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// zsh has no env hook like PROMPT_COMMAND, so tabs start with ZDOTDIR pointing at these
/// files: each one sources the user's own copy, and `.zshrc` then restores the user's
/// ZDOTDIR (so `.zlogin` and child shells behave as usual) and adds a precmd hook.
/// macOS's /etc/zshrc runs while ZDOTDIR is still ours and points HISTFILE here, so
/// `.zshrc` moves it back before the user's own `.zshrc` gets a say.
#[cfg(not(windows))]
const ZSH_FILES: [(&str, &str); 3] = [
    (
        ".zshenv",
        r#"_panex_zd=$ZDOTDIR
ZDOTDIR=${PANEX_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
PANEX_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_panex_zd
"#,
    ),
    (
        ".zprofile",
        r#"ZDOTDIR=$PANEX_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zprofile ]] && source $ZDOTDIR/.zprofile
ZDOTDIR=$_panex_zd
"#,
    ),
    (
        ".zshrc",
        r#"ZDOTDIR=$PANEX_USER_ZDOTDIR
[[ $HISTFILE == $_panex_zd/.zsh_history ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
[[ $ZDOTDIR == $HOME ]] && unset ZDOTDIR
unset PANEX_USER_ZDOTDIR _panex_zd
_panex_cwd() { printf '\e]9;9;%s\e\\' "$PWD" }
autoload -Uz add-zsh-hook && add-zsh-hook precmd _panex_cwd
"#,
    ),
];

/// Writes the zsh startup files under `<app data>/shell/zsh`. Without them zsh tabs still
/// work, they just don't report their cwd.
#[cfg(not(windows))]
pub fn init_shell_integration(app_data: &Path) {
    let dir = app_data.join("shell").join("zsh");
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        for (name, body) in ZSH_FILES {
            std::fs::write(dir.join(name), body)?;
        }
        Ok(())
    };
    match write() {
        Ok(()) => {
            let _ = ZSH_DIR.set(dir);
        }
        Err(e) => eprintln!("panex: zsh integration unavailable: {e}"),
    }
}

#[cfg(windows)]
pub fn init_shell_integration(_app_data: &Path) {}

/// When panex itself was started from inside a Claude Code session, the tabs would
/// inherit that session's identity and its tool-shell settings (NO_COLOR=1 turns every
/// TUI grey; CLAUDE_CODE_CHILD_SESSION makes claude act as a sub-session). Drop those.
/// User-level CLAUDE_CODE_* settings (e.g. CLAUDE_CODE_USE_BEDROCK) are kept.
fn scrub_parent_agent_env(cmd: &mut CommandBuilder) {
    if std::env::var_os("CLAUDECODE").is_none() {
        return;
    }
    for k in [
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_BRIDGE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_ENTRYPOINT",
        "NO_COLOR",
        "GIT_TERMINAL_PROMPT",
    ] {
        cmd.env_remove(k);
    }
}

#[cfg(windows)]
fn encode_ps(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// PATH with panex's own directory prepended, so `panex-cli` is callable from every tab.
fn path_with_exe_dir() -> Option<std::ffi::OsString> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let mut parts = vec![dir];
    if let Some(p) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(parts).ok()
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| Path::new(p).is_file())
}
