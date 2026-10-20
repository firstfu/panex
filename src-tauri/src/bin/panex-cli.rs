//! panex-cli: tiny helper for agent hooks.
//!
//!   panex-cli notify [message]
//!
//! Reads the hook JSON from stdin (Claude Code passes it there), adds the pane id from
//! PANEX_PANE_ID and sends it to the running panex over PANEX_PIPE. Outside panex those
//! variables are missing and it exits 0 immediately. It always exits 0 so a hook never
//! shows an error or blocks the agent.

use serde_json::{json, Value};
use std::io::{IsTerminal, Read, Write};
use std::sync::mpsc;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("notify") => notify(&args[1..]),
        _ => eprintln!("usage: panex-cli notify [message]"),
    }
}

fn notify(rest: &[String]) {
    let (Ok(pane), Ok(pipe)) = (std::env::var("PANEX_PANE_ID"), std::env::var("PANEX_PIPE")) else {
        return;
    };
    let hook = read_stdin_json().unwrap_or(Value::Null);
    let event = hook["hook_event_name"].as_str().unwrap_or("Notification").to_string();
    let message = match event.as_str() {
        "Stop" => hook["last_assistant_message"].as_str(),
        _ => hook["message"].as_str(),
    }
    .map(|s| truncate(s, 140))
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| rest.join(" "));

    let payload = json!({
        "pane": pane,
        "event": event,
        "message": message,
        "notificationType": hook["notification_type"],
        "sessionId": hook["session_id"],
    });
    let result = send(&pipe, payload.to_string().as_bytes());
    if std::env::var_os("PANEX_DEBUG").is_some() {
        eprintln!("panex-cli: {payload} -> {pipe}: {result:?}");
    }
}

/// Reads stdin unless it's an interactive console; gives up after 2 s so a stray
/// open stdin can never hang the agent.
fn read_stdin_json() -> Option<Value> {
    if std::io::stdin().is_terminal() {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::stdin().take(1 << 20).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let buf = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    // Windows PowerShell may prepend a UTF-8 BOM when piping to native programs.
    let json = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
    serde_json::from_slice(json).ok()
}

fn truncate(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    match one_line.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &one_line[..i]),
        None => one_line,
    }
}

#[cfg(windows)]
fn send(pipe: &str, bytes: &[u8]) -> std::io::Result<()> {
    // All pipe instances can be momentarily busy; retry briefly.
    let mut last = None;
    for _ in 0..10 {
        match std::fs::OpenOptions::new().write(true).open(pipe) {
            Ok(mut f) => return f.write_all(bytes),
            // 231 = ERROR_PIPE_BUSY; anything else (e.g. panex not running) fails fast.
            Err(e) if e.raw_os_error() != Some(231) => return Err(e),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(30));
            }
        }
    }
    Err(last.unwrap())
}

#[cfg(not(windows))]
fn send(pipe: &str, bytes: &[u8]) -> std::io::Result<()> {
    std::os::unix::net::UnixStream::connect(pipe)?.write_all(bytes)
}
