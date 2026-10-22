// Shortcut bindings in cmux's format: action id → "ctrl+shift+t" (one combo),
// ["ctrl+k", "ctrl+r"] (a chord), or null / "" / "none" (unbound).
// Keys are matched by physical key (KeyboardEvent.code), so layouts don't move them.

import { IS_MAC } from "./platform";

export type Binding = string | string[] | string[][] | null;

export interface ActionDef {
  id: string;
  group: string;
  label: string;
  default: Binding;
  /** macOS default when it differs: ⌘ takes Ctrl's place, so Ctrl keys reach the terminal. */
  mac?: Binding;
  /** Binding's key "1" stands for the whole 1–9 row; the handler gets the digit. */
  digits?: boolean;
}

// Same structure as cmux: the sidebar lists workspaces, each workspace has horizontal tabs.
export const GROUPS = ["工作區（側欄）", "分頁（水平）", "編輯", "檢視", "設定"];
const WS = GROUPS[0];
const TAB = GROUPS[1];

export const ACTIONS: ActionDef[] = [
  { id: "newWorkspace", group: WS, label: "新工作區", default: "ctrl+n", mac: "meta+n" },
  { id: "newWorkspaceWithShell", group: WS, label: "用 ⌄ 選單第 N 個 shell 開新工作區", default: "ctrl+shift+1", mac: "meta+shift+1", digits: true },
  { id: "newWorktree", group: WS, label: "用新 git worktree 開新工作區", default: null },
  { id: "newSsh", group: WS, label: "開 SSH 連線（新工作區）", default: null },
  { id: "closeWorkspace", group: WS, label: "關閉工作區（含裡面所有分頁）", default: null },
  { id: "renameWorkspace", group: WS, label: "重新命名工作區（也可雙擊）", default: "ctrl+shift+r", mac: "meta+shift+r" },
  { id: "selectWorkspaceByNumber", group: WS, label: "跳到第 1–8 個工作區，9 = 最後一個", default: "ctrl+1", mac: "meta+1", digits: true },
  { id: "nextWorkspace", group: WS, label: "下一個工作區", default: "ctrl+pagedown", mac: "meta+down" },
  { id: "prevWorkspace", group: WS, label: "上一個工作區", default: "ctrl+pageup", mac: "meta+up" },
  { id: "moveWorkspaceUp", group: WS, label: "工作區上移", default: "ctrl+shift+pageup", mac: "meta+alt+up" },
  { id: "moveWorkspaceDown", group: WS, label: "工作區下移", default: "ctrl+shift+pagedown", mac: "meta+alt+down" },
  { id: "jumpToUnread", group: WS, label: "跳到需要處理的分頁", default: "ctrl+shift+u", mac: "meta+shift+u" },
  { id: "newTab", group: TAB, label: "在目前工作區開新分頁", default: "ctrl+t", mac: "meta+t" },
  { id: "closeTab", group: TAB, label: "關閉分頁（最後一個會連工作區一起關）", default: "ctrl+w", mac: "meta+w" },
  { id: "renameTab", group: TAB, label: "重新命名分頁（也可雙擊）", default: "ctrl+alt+r", mac: "meta+alt+r" },
  { id: "selectTabByNumber", group: TAB, label: "跳到第 1–8 個分頁，9 = 最後一個", default: "alt+1", mac: "alt+1", digits: true },
  { id: "nextTab", group: TAB, label: "下一個分頁", default: "ctrl+tab", mac: "meta+right" },
  { id: "prevTab", group: TAB, label: "上一個分頁", default: "ctrl+shift+tab", mac: "meta+left" },
  { id: "moveTabLeft", group: TAB, label: "分頁左移", default: null },
  { id: "moveTabRight", group: TAB, label: "分頁右移", default: null },
  { id: "toggleSidebar", group: "檢視", label: "顯示 / 隱藏側欄", default: "ctrl+alt+h", mac: "meta+b" },
  { id: "toggleGitPanel", group: "檢視", label: "顯示 / 隱藏 Git 面板", default: "ctrl+shift+g", mac: "meta+shift+g" },
  { id: "find", group: "編輯", label: "搜尋捲動歷史", default: "ctrl+shift+f", mac: "meta+f" },
  { id: "clearScrollback", group: "編輯", label: "清除捲動歷史", default: "ctrl+shift+k", mac: "meta+k" },
  { id: "copy", group: "編輯", label: "複製選取文字", default: "ctrl+shift+c", mac: "meta+c" },
  { id: "paste", group: "編輯", label: "貼上", default: "ctrl+shift+v", mac: null },
  // Sends ESC+CR (what Alt+Enter sends): Claude Code inserts a newline instead of submitting.
  { id: "insertNewline", group: "編輯", label: "換行而不送出（Claude Code 等）", default: "ctrl+enter", mac: null },
  { id: "increaseFontSize", group: "檢視", label: "放大字型", default: "ctrl+equal", mac: "meta+equal" },
  { id: "decreaseFontSize", group: "檢視", label: "縮小字型", default: "ctrl+minus", mac: "meta+minus" },
  { id: "resetFontSize", group: "檢視", label: "重設字型大小", default: "ctrl+0", mac: "meta+0" },
  { id: "openSettings", group: "設定", label: "設定", default: "ctrl+comma", mac: "meta+comma" },
  { id: "openConfigFile", group: "設定", label: "用編輯器開啟 panex.json", default: null },
  { id: "reloadConfiguration", group: "設定", label: "重新載入設定檔", default: "ctrl+shift+comma", mac: "meta+shift+comma" },
];

const UNBOUND = new Set(["", "none", "clear", "unbound", "disabled"]);
const MODS = ["ctrl", "alt", "shift", "meta"] as const;

const ALIASES: Record<string, string> = {
  control: "ctrl", option: "alt", opt: "alt", cmd: "meta", command: "meta", win: "meta", super: "meta",
  "=": "equal", plus: "equal", "-": "minus", ",": "comma", ".": "period", "/": "slash", ";": "semicolon",
  "'": "quote", "`": "backquote", "[": "bracketleft", "]": "bracketright", "\\": "backslash",
  pgup: "pageup", pgdn: "pagedown", esc: "escape", return: "enter", del: "delete", ins: "insert",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
};

const DISPLAY: Record<string, string> = {
  ...(IS_MAC ? { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" }),
  equal: "=", minus: "-", comma: ",", period: ".", slash: "/", semicolon: ";", quote: "'",
  backquote: "`", bracketleft: "[", bracketright: "]", backslash: "\\",
  pageup: "PgUp", pagedown: "PgDn", up: "↑", down: "↓", left: "←", right: "→",
};

/** Canonical "ctrl+shift+t" for a key event, or undefined for a lone modifier. */
export function eventCombo(e: KeyboardEvent): string | undefined {
  const key = codeToKey(e.code);
  if (!key) return;
  const mods = MODS.filter((m) => (m === "ctrl" ? e.ctrlKey : m === "alt" ? e.altKey : m === "shift" ? e.shiftKey : e.metaKey));
  return [...mods, key].join("+");
}

function codeToKey(code: string): string | undefined {
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return `f${m[1]}`;
  if ((m = /^Arrow(Up|Down|Left|Right)$/.exec(code))) return m[1].toLowerCase();
  if (code === "NumpadAdd") return "equal";
  if (code === "NumpadSubtract") return "minus";
  if (code === "NumpadEnter") return "enter";
  return code.toLowerCase() || undefined; // Tab, PageUp, Comma, Equal, Minus, Space, Enter, ...
}

/** Normalizes a user-written combo; returns undefined if it isn't valid. */
export function normalizeCombo(s: string): string | undefined {
  const parts = s.toLowerCase().replace(/\s+/g, "").split("+");
  // "ctrl++" means ctrl + the plus key.
  if (parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "plus");
  const mods = new Set<string>();
  let key: string | undefined;
  for (const raw of parts) {
    const p = ALIASES[raw] ?? raw;
    if ((MODS as readonly string[]).includes(p)) mods.add(p);
    else if (!key && p) key = p;
    else return;
  }
  if (!key) return;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/** One way to trigger an action: a single combo, or several pressed in turn (a chord). */
export type Steps = string[];

function parseSteps(b: unknown): Steps | undefined {
  if (typeof b === "string") {
    const c = normalizeCombo(b);
    return c ? [c] : undefined;
  }
  if (Array.isArray(b) && b.length && b.every((x) => typeof x === "string")) {
    const steps = b.map((x) => normalizeCombo(x));
    return steps.every(Boolean) ? (steps as string[]) : undefined;
  }
}

/**
 * A binding as its alternatives; [] when unbound or invalid.
 *   "ctrl+n"                 → one combo
 *   ["ctrl+k", "ctrl+n"]     → one chord (cmux-compatible)
 *   [["ctrl+n"], ["ctrl+t"]] → either one (an array holding arrays lists alternatives)
 */
export function parseBinding(b: unknown): Steps[] {
  if (b == null) return [];
  if (typeof b === "string" && UNBOUND.has(b.trim().toLowerCase())) return [];
  if (Array.isArray(b) && b.some(Array.isArray)) {
    return b.map(parseSteps).filter((s): s is Steps => !!s);
  }
  const one = parseSteps(b);
  return one ? [one] : [];
}

export function formatCombo(c: string): string {
  return c
    .split("+")
    .map((p) => DISPLAY[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join(IS_MAC ? "" : "+"); // macOS writes ⌘⇧T, not ⌘+⇧+T
}

/** This platform's default binding of an action. */
export const defaultBinding = (a: ActionDef): Binding => (IS_MAC && a.mac !== undefined ? a.mac : a.default);

export function formatBinding(alts: Steps[], digits = false): string {
  return alts
    .map((steps) => steps.map((s) => (digits ? formatCombo(s).replace(/1$/, "1…9") : formatCombo(s))).join("  "))
    .join(" / ");
}

/** Effective bindings: defaults overridden by the config's shortcuts.bindings. */
export function resolveBindings(overrides: Record<string, unknown> | undefined): Map<string, Steps[]> {
  const out = new Map<string, Steps[]>();
  for (const a of ACTIONS) {
    const has = overrides && Object.prototype.hasOwnProperty.call(overrides, a.id);
    out.set(a.id, parseBinding(has ? overrides![a.id] : defaultBinding(a)));
  }
  return out;
}

/** For a combo, the digit-family key ("ctrl+3" → { family: "ctrl+1", digit: 3 }). */
export function digitFamily(combo: string): { family: string; digit: number } | undefined {
  const m = /^(.*\+)?([1-9])$/.exec(combo);
  return m ? { family: `${m[1] ?? ""}1`, digit: +m[2] } : undefined;
}

const key = (alts: Steps[]) => JSON.stringify(alts);

export const isDefault = (id: string, alts: Steps[]) => {
  const a = ACTIONS.find((x) => x.id === id);
  return key(parseBinding(a ? defaultBinding(a) : null)) === key(alts);
};

/** Value to store: a string for one combo, an array for one chord, an array of arrays for alternatives, "none" when cleared. */
export function toConfigValue(alts: Steps[]): unknown {
  if (alts.length === 0) return "none";
  if (alts.length === 1) return alts[0].length === 1 ? alts[0][0] : alts[0];
  return alts;
}
