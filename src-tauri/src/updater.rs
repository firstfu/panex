//! In-app updates: asks the release manifest (`latest.json` on GitHub Releases) whether a newer
//! version exists, and on request downloads, installs and relaunches. The download is verified
//! against the minisign public key in tauri.conf.json, so the manifest and the host are not trusted.
//!
//! The frontend decides when to check (launch, window focus; never on a timer) and when to
//! install (only after the user clicks), because relaunching ends every running shell and agent.
//! Debug and test builds never check or install: an update would replace the test binary with a
//! released one (and a check would be a pointless network call).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// What the sidebar shows about an available update.
#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    /// Release notes from the manifest, when it has any.
    notes: Option<String>,
}

/// Download progress, sent to the frontend as the `update-progress` event.
#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    /// Missing when the server sends no Content-Length.
    total: Option<u64>,
}

/// Whether this build may touch updates at all (same rule as writing the Claude Code hooks).
/// An e2e test build (never released) can opt in with `PANEX_E2E_UPDATES`, to try the whole
/// update against a local manifest.
fn enabled(app: &AppHandle) -> bool {
    #[cfg(feature = "e2e")]
    if std::env::var_os("PANEX_E2E_UPDATES").is_some() {
        return true;
    }
    crate::hooks::may_write(cfg!(debug_assertions), &app.config().identifier)
}

/// Looks for a newer version.
///
/// Returns `None` when this build is up to date or updates are disabled for it. Errors (offline,
/// manifest missing, bad signature format) come back as text; the caller treats a failed
/// background check as "nothing new" and only shows the text for a manual check.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !enabled(&app) {
        return Ok(None);
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// Downloads the newest version, installs it and relaunches panex. Does not return on success.
///
/// Checks again instead of remembering the result of `update_check`: the manifest may have moved
/// on since, and the `Update` handle isn't worth keeping in shared state. The frontend must flush
/// scrollback and the session before calling, because the relaunch doesn't go through the window's
/// close handler. On Windows the installer takes over and the process exits inside
/// `download_and_install`; on macOS the bundle is swapped and `restart` starts the new one.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if !enabled(&app) {
        return Err("updates are disabled in this build".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("already up to date")?;
    let mut downloaded = 0u64;
    // The chunk callback fires per network read; only report when the whole percent changes.
    let mut last_percent = u64::MAX;
    let events = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let percent = total.map_or(downloaded, |t| downloaded * 100 / t.max(1));
                if percent != last_percent {
                    last_percent = percent;
                    let _ = events.emit("update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}
