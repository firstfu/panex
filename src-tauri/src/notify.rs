//! Agent notifications. `panex-cli notify` (run by agent hooks inside a tab) connects to a
//! local named pipe / unix socket and writes one JSON message; we forward it to the
//! frontend as an `agent-notify` event. The frontend decides about badges and toasts.
//! A message with an `op` is a control request (control.rs); its answer goes back as one JSON line.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

pub fn pipe_name() -> String {
    // Lets a second (test) instance run beside the user's without stealing its pipe.
    if let Ok(name) = std::env::var("PANEX_PIPE_NAME") {
        if !name.is_empty() {
            return name;
        }
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_default();
        format!(r"\\.\pipe\panex-{}", sanitize(&user))
    }
    #[cfg(not(windows))]
    {
        let user = std::env::var("USER").unwrap_or_default();
        let base = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
        base.join(format!("panex-{}.sock", sanitize(&user))).to_string_lossy().into_owned()
    }
}

fn sanitize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

async fn handle<S: AsyncRead + AsyncWrite + Unpin>(stream: S, app: AppHandle) {
    let (rd, mut wr) = tokio::io::split(stream);
    let mut rd = BufReader::new(rd.take(64 * 1024));
    // One JSON line; `notify` writes it without the newline and closes, which ends it too.
    let mut buf = Vec::new();
    if rd.read_until(b'\n', &mut buf).await.is_err() {
        return;
    }
    let Ok(msg) = serde_json::from_slice::<serde_json::Value>(&buf) else { return };
    if msg.get("op").is_some() {
        let reply = crate::control::handle(&app, &msg).await;
        let mut line = reply.to_string().into_bytes();
        line.push(b'\n');
        if wr.write_all(&line).await.is_ok() {
            let _ = wr.flush().await;
            // Hold the connection until the client has read the answer and hung up.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), rd.read(&mut [0u8; 1])).await;
        }
    } else if msg.get("pane").and_then(|p| p.as_str()).is_some() {
        // 擋掉上一次啟動的 panex 開的 shell 送來的 hook：關閉 panex 會殺掉裡面的 Claude Code，
        // 它的 SessionEnd 約一秒後才送出，馬上重開的新 panex 已經在聽同一個 socket；還原的分頁
        // id 相同，這則訊息會把正要自動接回的 session id 清掉。
        // 沒帶 token 的照收：hooks 指向已安裝的 panex-cli，舊版 cli 不帶 token（例如開發中的 panex
        // 搭配舊的安裝版）。
        if msg["token"].as_str().is_some_and(|t| t != crate::control::token()) {
            return;
        }
        crate::control::record(&app, &msg);
        let _ = app.emit("agent-notify", msg);
    }
}

#[cfg(windows)]
pub fn start_server(app: AppHandle) {
    use tokio::net::windows::named_pipe::ServerOptions;
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(e) => return eprintln!("panex: notify pipe unavailable: {e}"),
        };
        loop {
            if server.connect().await.is_ok() {
                let conn = server;
                tauri::async_runtime::spawn(handle(conn, app.clone()));
            }
            server = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(e) => return eprintln!("panex: notify pipe failed: {e}"),
            };
        }
    });
}

#[cfg(not(windows))]
pub fn start_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        let _ = std::fs::remove_file(&name);
        let listener = match tokio::net::UnixListener::bind(&name) {
            Ok(l) => l,
            Err(e) => return eprintln!("panex: notify socket unavailable: {e}"),
        };
        while let Ok((conn, _)) = listener.accept().await {
            tauri::async_runtime::spawn(handle(conn, app.clone()));
        }
    });
}

/// Desktop toast + taskbar flash. Called by the frontend only when the user isn't looking.
#[tauri::command]
pub fn alert(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}
