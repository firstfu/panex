// The settings model: every field of panex.json the UI reads, its key path, default and
// valid range, plus the terminal font stack. Pure data and functions, no DOM or Tauri.

import { type LangPref } from "./i18n";
import { IS_MAC } from "./platform";

// Flat view of panex.json (~/.config/panex/panex.json); CONFIG_PATHS maps each field to its key.
export interface Settings {
  opacity: number; // 30–100 (%)
  effect: "none" | "mica" | "acrylic";
  fontSize: number;
  fontFamily: string;
  defaultShell: string;
  cursorBlink: boolean;
  scrollback: number;
  smartCopyPaste: boolean;
  sidebarHidden: boolean;
  modifierHints: boolean;
  language: LangPref;
  resumeSession: boolean;
  confirmClose: boolean; // ask before closing while an agent is mid-turn
  openFilesWith: "system" | "vscode" | "cursor"; // what Ctrl/⌘+clicking a file path in the terminal opens
  windowWidth: number; // size the window opens at (logical px)
  windowHeight: number;
}

export const CONFIG_PATHS: Record<keyof Settings, string[]> = {
  opacity: ["app", "opacity"],
  effect: ["app", "windowEffect"],
  fontSize: ["terminal", "fontSize"],
  fontFamily: ["terminal", "fontFamily"],
  defaultShell: ["terminal", "defaultShell"],
  cursorBlink: ["terminal", "cursorBlink"],
  scrollback: ["terminal", "scrollback"],
  smartCopyPaste: ["terminal", "smartCopyPaste"],
  sidebarHidden: ["sidebar", "hidden"],
  modifierHints: ["shortcuts", "showModifierHoldHints"],
  language: ["app", "language"],
  resumeSession: ["agent", "resumeSession"],
  confirmClose: ["agent", "confirmCloseWhileRunning"],
  openFilesWith: ["terminal", "openFilesWith"],
  windowWidth: ["app", "windowWidth"],
  windowHeight: ["app", "windowHeight"],
};

export const DEFAULTS: Settings = {
  opacity: 100,
  effect: "none",
  fontSize: 14,
  // Per platform: a missing font makes xterm measure cells wider than the glyphs it draws.
  fontFamily: IS_MAC ? "ui-monospace, Menlo, 'PingFang TC', monospace" : "'Cascadia Mono', Consolas, 'Microsoft JhengHei', monospace",
  defaultShell: "cmd",
  cursorBlink: false,
  scrollback: 3000,
  smartCopyPaste: true,
  sidebarHidden: false,
  modifierHints: false,
  language: "auto",
  resumeSession: true,
  confirmClose: true,
  openFilesWith: "system",
  // Keep in sync with config.rs DEFAULT_WINDOW and tauri.conf.json.
  windowWidth: 1400,
  windowHeight: 820,
};

// Appended after the chosen fonts so CJK text still has a font whatever the user picks.
const FALLBACK_FONTS = IS_MAC ? ["PingFang TC"] : ["Microsoft JhengHei"];
export const GENERIC_FONTS = ["monospace", "ui-monospace", "sans-serif", "serif", "system-ui"];
export const FONT_CUSTOM = ":custom"; // font picker value for the free-text field (no font name starts with ':')

export const fontNames = (css: string) =>
  css.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
export const cssFont = (name: string) => (GENERIC_FONTS.includes(name.toLowerCase()) ? name : `'${name}'`);

/** What xterm gets: the "panex emoji" face (style.css) first so emoji win over the chosen font's
 *  own glyphs, then the user's fonts, the CJK fallback and monospace. */
export function termFontFamily(css: string): string {
  const names = fontNames(css).filter((n) => n.toLowerCase() !== "monospace");
  const have = new Set(names.map((n) => n.toLowerCase()));
  const extra = FALLBACK_FONTS.filter((n) => !have.has(n.toLowerCase()));
  return ["panex emoji", ...names, ...extra, "monospace"].map(cssFont).join(", ");
}

const getPath = (obj: any, path: string[]) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

export function settingsFrom(cfg: any): Settings {
  const s = { ...DEFAULTS } as any;
  for (const [field, path] of Object.entries(CONFIG_PATHS)) {
    const v = getPath(cfg, path);
    if (v !== undefined && typeof v === typeof (DEFAULTS as any)[field]) s[field] = v;
  }
  s.opacity = Math.min(100, Math.max(30, s.opacity));
  s.fontSize = Math.min(32, Math.max(8, s.fontSize));
  s.windowWidth = Math.min(10000, Math.max(480, Math.round(s.windowWidth)));
  s.windowHeight = Math.min(10000, Math.max(300, Math.round(s.windowHeight)));
  if (!["none", "mica", "acrylic"].includes(s.effect)) s.effect = "none";
  if (!["auto", "en", "zh-Hant"].includes(s.language)) s.language = "auto";
  if (!["system", "vscode", "cursor"].includes(s.openFilesWith)) s.openFilesWith = "system";
  return s;
}
