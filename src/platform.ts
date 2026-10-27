// Which desktop we run on. Defaults (font, shortcuts) and a few hints differ on macOS,
// where ⌘ does what Ctrl does on Windows and Ctrl stays with the terminal.

export const IS_MAC = /Mac/.test(navigator.userAgent);
/** Only Windows tabs run in a Job Object, so per-tab memory is only known there. */
export const IS_WIN = /Windows/.test(navigator.userAgent);
