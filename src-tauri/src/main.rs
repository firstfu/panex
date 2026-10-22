// Binary entry point; everything lives in lib.rs (`panex_lib::run`).
// windows_subsystem: no extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    panex_lib::run()
}
