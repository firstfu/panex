//! macOS privacy permissions for the settings page. panex itself needs none of them, but macOS
//! charges whatever runs in its tabs (an agent's `osascript`, `screencapture`, reading
//! `~/Library`) to panex, so the page shows their state and opens the matching System Settings
//! pane. Read on demand only (settings open, window focus); nothing polls. Other platforms have
//! no such permissions and get an empty answer.

use serde::Serialize;

#[derive(Serialize, Default)]
pub struct PermStatus {
    /// Accessibility (sending keys, driving other apps). None off macOS.
    accessibility: Option<bool>,
    /// Screen Recording (screenshots, window titles).
    screen_recording: Option<bool>,
    /// Full Disk Access; None when it can't be told (no API, see `full_disk`).
    full_disk: Option<bool>,
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> u8;
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
        pub static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> u8;
        pub fn CGRequestScreenCaptureAccess() -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub static kCFBooleanTrue: *const c_void;
        pub static kCFTypeDictionaryKeyCallBacks: u8;
        pub static kCFTypeDictionaryValueCallBacks: u8;
        pub fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        pub fn CFRelease(cf: *const c_void);
    }

    /// Asks macOS to show its Accessibility prompt, which also puts panex in the list.
    pub fn prompt_accessibility() {
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let dict = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const u8 as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const u8 as *const c_void,
            );
            if !dict.is_null() {
                AXIsProcessTrustedWithOptions(dict);
                CFRelease(dict);
            }
        }
    }

    /// There is no API for Full Disk Access; the TCC database is readable only with it.
    pub fn full_disk() -> Option<bool> {
        let home = std::env::var_os("HOME")?;
        let db = std::path::Path::new(&home).join("Library/Application Support/com.apple.TCC/TCC.db");
        match std::fs::File::open(db) {
            Ok(_) => Some(true),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Some(false),
            Err(_) => None,
        }
    }
}

/// Current state of the permissions programs in panex's tabs may need.
#[tauri::command]
pub fn perms_status() -> PermStatus {
    #[cfg(target_os = "macos")]
    unsafe {
        PermStatus {
            accessibility: Some(mac::AXIsProcessTrusted() != 0),
            screen_recording: Some(mac::CGPreflightScreenCaptureAccess() != 0),
            full_disk: mac::full_disk(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    PermStatus::default()
}

/// Opens the System Settings pane for one permission ("accessibility", "screen", "disk",
/// "files"). For the first two, macOS's own prompt comes first, which also adds panex to the
/// list (it only appears there after asking once).
#[tauri::command]
pub fn perms_open(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match kind.as_str() {
            "accessibility" => {
                mac::prompt_accessibility();
                "Privacy_Accessibility"
            }
            "screen" => {
                // Shows the prompt only the first time; after that System Settings is the way.
                if unsafe { mac::CGRequestScreenCaptureAccess() } != 0 {
                    return Ok(());
                }
                "Privacy_ScreenCapture"
            }
            "disk" => "Privacy_AllFiles",
            "files" => "Privacy_FilesAndFolders",
            _ => return Err(format!("unknown permission: {kind}")),
        };
        std::process::Command::new("open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err(format!("no {kind} permission on this platform"))
}
