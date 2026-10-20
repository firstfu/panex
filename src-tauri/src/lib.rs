mod config;
mod hooks;
mod notify;
mod pty;
mod session;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, RunEvent};

pub struct AppState {
    ptys: pty::PtyMap,
    session: session::Store,
    quitting: AtomicBool,
}

impl AppState {
    fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch only focuses the running window, so two
        // instances never fight over the same session file.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let session = session::Store::open(dir)?;
            config::init(app.handle(), session.legacy_settings_path());
            app.manage(AppState {
                ptys: Default::default(),
                session,
                quitting: AtomicBool::new(false),
            });
            notify::start_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::shells_list,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::tab_close,
            session::session_load,
            session::session_save,
            config::config_load,
            config::config_set,
            config::config_open,
            session::scrollback_load,
            session::scrollback_save,
            notify::alert,
            hooks::hooks_status,
            hooks::hooks_install,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build panex")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.quitting.store(true, Ordering::SeqCst);
                pty::kill_all(&state);
            }
        });
}
