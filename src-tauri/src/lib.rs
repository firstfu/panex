mod config;
mod fonts;
mod git;
mod hooks;
mod links;
mod notify;
mod pty;
mod session;
mod ssh;

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
    use tauri_plugin_window_state::StateFlags;
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu).on_menu_event(|app, e| {
        // Quit by closing the window, so the frontend's close handler saves scrollback first.
        if e.id() == "quit" {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
        }
    });
    builder
        // Must be first: a second launch only focuses the running window, so two
        // instances never fight over the same session file.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // Size comes from panex.json (config::apply_window_size); only position etc. are restored.
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() - StateFlags::SIZE).build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            pty::init_shell_integration(&dir);
            let session = session::Store::open(dir)?;
            config::init(app.handle(), session.legacy_settings_path());
            if let Some(w) = app.get_webview_window("main") {
                config::apply_window_size(&w);
            }
            app.manage(AppState {
                ptys: Default::default(),
                session,
                quitting: AtomicBool::new(false),
            });
            notify::start_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git::git_branch,
            git::git_worktree_add,
            git::git_branches,
            git::git_status,
            git::git_diff,
            git::git_log,
            git::git_show,
            pty::shells_list,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::tab_close,
            ssh::ssh_hosts,
            session::session_load,
            session::session_save,
            config::config_load,
            config::config_set,
            config::config_open,
            fonts::fonts_list,
            links::links_resolve,
            links::open_url,
            links::open_file,
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

/// The standard macOS menu minus Window › Close (⌘W closes a tab in panex). Edit keeps
/// Cut/Copy/Paste so ⌘V and text fields work natively.
#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let quit = MenuItemBuilder::with_id("quit", "Quit panex").accelerator("Cmd+Q").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "panex")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().fullscreen().build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &window]).build()
}
