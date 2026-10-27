// Which desktop we run on. Defaults (font, shortcuts) and a few hints differ on macOS,
// where ⌘ does what Ctrl does on Windows and Ctrl stays with the terminal.

export const IS_MAC = /Mac/.test(navigator.userAgent);
export const IS_WIN = /Windows/.test(navigator.userAgent);
/** Tabs whose whole process tree the backend can measure and end (Job Object on Windows,
 *  descendant walk on macOS): per-tab memory, hibernation. Not offered elsewhere. */
export const CAN_MANAGE = IS_WIN || IS_MAC;
