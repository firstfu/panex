//! Installed font families for the settings font picker.

use std::collections::BTreeSet;

/// Monospaced font families installed on the system, sorted. Scans the font files, so the
/// frontend asks once when the settings panel opens and caches the result.
#[tauri::command]
pub async fn fonts_list() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut names = BTreeSet::new();
        for face in db.faces().filter(|f| f.monospaced) {
            // The first entry is the English family name; localized names follow.
            if let Some((name, _)) = face.families.first() {
                if !name.starts_with('.') {
                    names.insert(name.clone());
                }
            }
        }
        names.into_iter().collect()
    })
    .await
    .unwrap_or_default()
}
