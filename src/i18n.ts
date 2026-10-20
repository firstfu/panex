// UI language. Source strings are Traditional Chinese and double as the lookup key (gettext style):
// t("新分頁") returns the English text when the language is English, otherwise the key itself.
// Placeholders are {name}. A missing entry falls back to the key, so a forgotten string stays readable.

import { IS_MAC } from "./platform";

export type Lang = "en" | "zh-Hant";
export type LangPref = "auto" | Lang;

const EN: Record<string, string> = {
  // Static HTML
  "新工作區": "New workspace",
  "選擇 shell": "Choose shell",
  "設定（Ctrl+,）": "Settings (Ctrl+,)",
  "設定（⌘,）": "Settings (⌘,)",
  "設定": "Settings",
  "拖曳調整側邊欄寬度（雙擊還原）": "Drag to resize the sidebar (double-click to reset)",
  "顯示 / 隱藏側欄": "Show / hide sidebar",
  "外觀": "Appearance",
  "終端機": "Terminal",
  "快捷鍵": "Shortcuts",
  "設定檔": "Config file",
  "改動會立即套用並存進 panex.json": "Changes apply immediately and are saved to panex.json",
  "關閉設定": "Close settings",
  "語言": "Language",
  "介面語言，自動 = 跟隨系統": "Interface language; Auto follows the system",
  "自動": "Auto",
  "不透明度": "Opacity",
  "文字永遠清楚，只有背景會變透明": "Text stays sharp; only the background becomes transparent",
  "背景效果": "Background effect",
  "透出桌面的模糊或色調，需要不透明度低於 100%": "Blur or tint from the desktop showing through; needs opacity below 100%",
  "無": "None",
  "字型大小": "Font size",
  "也可以用 Ctrl+滾輪調整": "Also adjustable with Ctrl+scroll",
  "也可以用 ⌘+滾輪調整": "Also adjustable with ⌘+scroll",
  "視窗大小": "Window size",
  "啟用 Claude Code 通知？": "Enable Claude Code notifications?",
  "Claude Code 需要你處理或做完時，分頁會亮起；關掉重開後也能一鍵恢復 session。":
    "Tabs light up when Claude Code needs you or finishes, and you can resume its session with one click after reopening panex.",
  "會在 ~/.claude/settings.json 加入 panex 的 hooks，寫入前先備份，你原本的 hooks 都會保留。":
    "This adds panex's hooks to ~/.claude/settings.json. The file is backed up first and your existing hooks are kept.",
  "不用了": "No thanks",
  "以後再說": "Later",
  "每次開啟時的寬 × 高，改了立刻套用": "Width × height the window opens at; applied right away",
  "用目前大小": "Use current size",
  "寬": "Width",
  "高": "Height",
  "縮小": "Smaller",
  "放大": "Larger",
  "快捷鍵提示": "Shortcut hints",
  "按住 Ctrl 或 Alt 時，在工作區與分頁上顯示快捷鍵編號": "Show shortcut numbers on workspaces and tabs while holding Ctrl or Alt",
  "按住 ⌘ 或 ⌥ 時，在工作區與分頁上顯示快捷鍵編號": "Show shortcut numbers on workspaces and tabs while holding ⌘ or ⌥",
  "字型": "Font",
  "可以列多個字型，前面的找不到就用下一個": "List several fonts; the next one is used if an earlier one isn't found",
  "新分頁用的 shell": "Shell for new tabs",
  "⌄ 選單隨時可以開別的": "The ⌄ menu can open any other one at any time",
  "智慧複製貼上": "Smart copy & paste",
  "有選取時 Ctrl+C 複製，沒選取仍是中斷；Ctrl+V 貼上": "Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V pastes",
  "游標閃爍": "Cursor blink",
  "關掉比較省電": "Turning it off saves power",
  "捲動歷史": "Scrollback",
  "每個分頁保留的行數，越多越吃記憶體；新分頁才生效": "Lines kept per tab; more uses more memory; applies to new tabs only",
  "行": "lines",
  "搜尋動作或按鍵": "Search actions or keys",
  "全部恢復預設": "Reset all to defaults",
  "所有設定都存在這個檔案。用編輯器改完存檔，約 0.3 秒後自動套用；旁邊的 panex.schema.json 讓 VS Code 有自動完成。":
    "All settings live in this file. Edit it and save; changes apply after about 0.3 s. The panex.schema.json next to it gives VS Code autocomplete.",
  "用編輯器開啟": "Open in editor",
  "重新載入": "Reload",
  "快捷鍵寫法": "Binding syntax",
  "字串是一組按鍵，陣列是依序按的連續按鍵，陣列裡放陣列代表多組任選一組，null 代表不綁定。":
    "A string is one key combo, an array is a sequence of combos pressed in order, an array of arrays lists alternatives (any one works), and null means unbound.",

  // Shortcut groups and actions (keys.ts)
  "工作區（側欄）": "Workspaces (sidebar)",
  "分頁（水平）": "Tabs (horizontal)",
  "編輯": "Edit",
  "檢視": "View",
  "用 ⌄ 選單第 N 個 shell 開新工作區": "New workspace with the Nth shell in the ⌄ menu",
  "關閉工作區（含裡面所有分頁）": "Close workspace (and all its tabs)",
  "重新命名工作區（也可雙擊）": "Rename workspace (or double-click)",
  "跳到第 1–8 個工作區，9 = 最後一個": "Go to workspace 1–8; 9 = last",
  "下一個工作區": "Next workspace",
  "上一個工作區": "Previous workspace",
  "工作區上移": "Move workspace up",
  "工作區下移": "Move workspace down",
  "跳到需要處理的分頁": "Jump to tab needing attention",
  "在目前工作區開新分頁": "New tab in current workspace",
  "關閉分頁（最後一個會連工作區一起關）": "Close tab (the last one closes the workspace)",
  "重新命名分頁（也可雙擊）": "Rename tab (or double-click)",
  "跳到第 1–8 個分頁，9 = 最後一個": "Go to tab 1–8; 9 = last",
  "下一個分頁": "Next tab",
  "上一個分頁": "Previous tab",
  "分頁左移": "Move tab left",
  "分頁右移": "Move tab right",
  "清除捲動歷史": "Clear scrollback",
  "複製選取文字": "Copy selection",
  "貼上": "Paste",
  "放大字型": "Increase font size",
  "縮小字型": "Decrease font size",
  "重設字型大小": "Reset font size",
  "用編輯器開啟 panex.json": "Open panex.json in editor",
  "重新載入設定檔": "Reload config",

  // main.ts
  "工作區": "Workspace",
  "命令提示字元": "Command Prompt",
  "預設 shell": "Default shell",
  "開啟 panex.json": "Open panex.json",
  "panex.json 有錯誤，沿用上次的設定：{e}": "panex.json has an error; keeping the previous settings: {e}",
  "── 已還原工作階段（{time}）──": "── Session restored ({time}) ──",
  "🔔 響鈴": "🔔 Bell",
  "無法啟動 {shell}：{e}": "Failed to start {shell}: {e}",
  "{n} 個分頁": "{n} tabs",
  "關閉工作區": "Close workspace",
  "關閉分頁": "Close tab",
  "新分頁": "New tab",
  "Claude Code 通知：已啟用": "Claude Code notifications: enabled",
  "Claude Code 通知：未啟用": "Claude Code notifications: not enabled",
  "啟用": "Enable",
  "在 ~/.claude/settings.json 加入 panex 的 hooks（會先備份）": "Add panex hooks to ~/.claude/settings.json (backed up first)",
  "啟用失敗：{e}": "Failed to enable: {e}",
  "重新命名工作區…": "Rename workspace…",
  "上移": "Move up",
  "下移": "Move down",
  "移到最上面": "Move to top",
  "關閉其他工作區": "Close other workspaces",
  "關閉下方工作區": "Close workspaces below",
  "關閉上方工作區": "Close workspaces above",
  "重新命名分頁…": "Rename tab…",
  "左移": "Move left",
  "右移": "Move right",
  "關閉其他分頁": "Close other tabs",
  "關閉右側分頁": "Close tabs to the right",
  "無顏色": "No color",
  "放大／縮小字型": "Increase / decrease font size",
  "滾輪": "Scroll wheel",
  "顯示工作區與分頁編號": "Show workspace and tab numbers",
  "按住 Ctrl 或 Alt": "Hold Ctrl or Alt",
  "按住 ⌘ 或 ⌥": "Hold ⌘ or ⌥",
  "重新命名": "Rename",
  "雙擊工作區或分頁": "Double-click a workspace or tab",
  "顏色、排序、關閉": "Color, reorder, close",
  "右鍵工作區或分頁": "Right-click a workspace or tab",
  "關閉": "Close",
  "中鍵點工作區或分頁": "Middle-click a workspace or tab",
  "雙擊分頁列空白處": "Double-click empty space in the tab bar",
  "再按": "then",
  "按修飾鍵＋任一數字": "Press modifiers + any digit",
  "按下新的組合鍵": "Press the new key combo",
  "變更「{name}」的第 {n} 組快捷鍵": "Change shortcut {n} for \"{name}\"",
  "移除這組": "Remove this one",
  "未設定": "Unbound",
  "再加一組快捷鍵": "Add another shortcut",
  "為「{name}」再加一組快捷鍵": "Add another shortcut for \"{name}\"",
  "恢復預設": "Reset to default",
  "滑鼠與固定操作": "Mouse and fixed actions",
  "找不到「{q}」。試試動作名稱，例如「分頁」，或按鍵，例如「ctrl+shift」。":
    "No match for \"{q}\". Try an action name such as \"tab\", or a key such as \"ctrl+shift\".",
  "Esc 取消，Backspace 移除這一組快捷鍵。": "Esc to cancel, Backspace to remove this shortcut.",
  "已移除「{name}」的一組快捷鍵。": "Removed a shortcut for \"{name}\".",
  "請加上 Ctrl、Alt 或 Win 鍵（F1–F12 可單獨使用），一般按鍵要留給終端機輸入。":
    "Add Ctrl, Alt or Win (F1–F12 work alone); plain keys are reserved for terminal input.",
  "請加上 ⌘、⌃ 或 ⌥ 鍵（F1–F12 可單獨使用），一般按鍵要留給終端機輸入。":
    "Add ⌘, ⌃ or ⌥ (F1–F12 work alone); plain keys are reserved for terminal input.",
  "這個動作要用「修飾鍵＋數字」，例如按 Ctrl+Alt+1 就代表 Ctrl+Alt+1–9。":
    "This action needs \"modifier + digit\"; for example Ctrl+Alt+1 stands for Ctrl+Alt+1–9.",
  "這個動作要用「修飾鍵＋數字」，例如按 ⌘⌥1 就代表 ⌘⌥1–9。":
    "This action needs \"modifier + digit\"; for example ⌘⌥1 stands for ⌘⌥1–9.",
  "已設定。「{names}」原本用這組按鍵，現在改為未設定。": "Set. \"{names}\" used this combo and is now unbound.",
  "、": ", ",
  "已移除一組快捷鍵。": "Removed a shortcut.",
  "已恢復預設。": "Reset to default.",
  "已將所有快捷鍵恢復預設。": "All shortcuts reset to defaults.",
  "[程序已結束（代碼 {code}）。按 Enter 重新啟動{close}]": "[Process exited (code {code}). Press Enter to restart{close}]",
  "，{key} 關閉分頁": ", {key} to close the tab",
  "已完成": "Done",
  "需要你的回應": "Needs your response",
  "建立 worktree": "Create worktree",
  "分支名稱": "Branch name",
  "從哪個分支開始（分支已存在時忽略）": "Start from (ignored if the branch exists)",
  "取消": "Cancel",
  "建立": "Create",
  "目前的工作目錄不在 git repo 裡": "The current folder is not inside a git repository",
  "已複製：{files}": "Copied: {files}",
  "用新 worktree 開新工作區…": "New workspace in a new worktree…",
  "用新 git worktree 開新工作區": "New workspace in a new git worktree",
  "上次的 Claude Code session 可以接回": "The last Claude Code session can be resumed",
  "恢復": "Resume",
  "略過": "Dismiss",
  "恢復上次的 Claude Code session": "Resume the last Claude Code session",
  "恢復 Claude Code session": "Resume Claude Code sessions",
  "Claude Code 結束後，在終端機下方與側欄提供一鍵 claude --resume": "After Claude Code exits, offer a one-click claude --resume under the terminal and in the sidebar",
};

let lang: Lang = "zh-Hant";

export const getLang = () => lang;

/** Resolves "auto" from the OS/webview locale: Chinese stays Chinese, everything else gets English. */
export function resolveLang(pref: LangPref): Lang {
  if (pref === "en" || pref === "zh-Hant") return pref;
  return /^zh\b/i.test(navigator.language) ? "zh-Hant" : "en";
}

export function setLang(next: Lang) {
  lang = next;
  document.documentElement.lang = next;
}

// macOS wording for strings that name Windows modifier keys. Applied before the EN lookup,
// so each Mac variant needs its own EN entry.
const MAC: Record<string, string> = {
  "設定（Ctrl+,）": "設定（⌘,）",
  "也可以用 Ctrl+滾輪調整": "也可以用 ⌘+滾輪調整",
  "按住 Ctrl 或 Alt 時，在工作區與分頁上顯示快捷鍵編號": "按住 ⌘ 或 ⌥ 時，在工作區與分頁上顯示快捷鍵編號",
  "按住 Ctrl 或 Alt": "按住 ⌘ 或 ⌥",
  "Ctrl": "⌘",
  "請加上 Ctrl、Alt 或 Win 鍵（F1–F12 可單獨使用），一般按鍵要留給終端機輸入。":
    "請加上 ⌘、⌃ 或 ⌥ 鍵（F1–F12 可單獨使用），一般按鍵要留給終端機輸入。",
  "這個動作要用「修飾鍵＋數字」，例如按 Ctrl+Alt+1 就代表 Ctrl+Alt+1–9。":
    "這個動作要用「修飾鍵＋數字」，例如按 ⌘⌥1 就代表 ⌘⌥1–9。",
};

export function t(key: string, vars?: Record<string, string | number>): string {
  if (IS_MAC) key = MAC[key] ?? key;
  let s = lang === "en" ? (EN[key] ?? key) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/**
 * Translates the static markup. An element marks what to translate with data-i18n (text),
 * data-i18n-title, data-i18n-aria or data-i18n-ph (placeholder); the original Chinese is
 * remembered on first pass so switching back and forth always works from the same source.
 */
export function translateDom(root: ParentNode = document) {
  const apply = (sel: string, read: (el: HTMLElement) => string, write: (el: HTMLElement, v: string) => void, store: string) => {
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const src = (el.dataset[store] ??= read(el));
      write(el, t(src));
    });
  };
  apply("[data-i18n]", (el) => el.textContent ?? "", (el, v) => (el.textContent = v), "zh");
  apply("[data-i18n-title]", (el) => el.title, (el, v) => (el.title = v), "zhTitle");
  apply("[data-i18n-aria]", (el) => el.getAttribute("aria-label") ?? "", (el, v) => el.setAttribute("aria-label", v), "zhAria");
  apply("[data-i18n-ph]", (el) => el.getAttribute("placeholder") ?? "", (el, v) => el.setAttribute("placeholder", v), "zhPh");
}
