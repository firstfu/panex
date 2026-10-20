//! Agent notifications. `panex-cli notify` (run by agent hooks inside a tab) connects to a
//! local named pipe / unix socket and writes one JSON message; we forward it to the
//! frontend as an `agent-notify` event. The frontend decides about badges and toasts.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncRead, AsyncReadExt};

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

async fn handle<S: AsyncRead + Unpin>(stream: S, app: AppHandle) {
    let mut buf = Vec::new();
    if stream.take(64 * 1024).read_to_end(&mut buf).await.is_err() {
        return;
    }
    if let Ok(msg) = serde_json::from_slice::<serde_json::Value>(&buf) {
        if msg.get("pane").and_then(|p| p.as_str()).is_some() {
            let _ = app.emit("agent-notify", msg);
        }
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
