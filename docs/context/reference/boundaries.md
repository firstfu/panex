# 編碼規範 / 不可踩越的邊界 / 踩過的雷

> **何時讀**：每個 session 開場必讀。只放**跨全站**、一句話就能擋坑的東西；只屬某模組或某技術層的雷放 modules/ 或 `<主題>-pitfalls.md`，長機制放 modules/ 或 data-model.md。

## 編碼規範
- 資源最小化是硬需求：閒置時不跑任何計時器（只用有事件才啟動的 debounce）；新功能先想「沒在用時成本是不是零」。
- 前端不引入 UI 框架；Rust 依賴新增前先確認沒有更輕的做法。

## 不可踩越的邊界
- 不複製 cmux（GPL-3.0）的程式碼，也不用 cmux 名稱或品牌。
- `~/.claude/settings.json` 是使用者全域設定：只能由使用者在 UI 按「啟用」觸發寫入，且必須備份、保留既有 hooks。開發測試時不要替使用者寫。
- `panex-cli` 在 panex 外必須安靜地 exit 0，不能讓 Claude Code 顯示 hook error 或卡住。

- **測試不要碰使用者正在用的 panex**：用獨立測試實例（`--config '{"identifier":"dev.panex.terminal.test"}'` 建置、`XDG_CONFIG_HOME` 指 scratch、`PANEX_PIPE_NAME` 換管道、WebView2 除錯埠用 9556），資料用使用者檔案的複本。要換掉使用者的實例前先問，他可能有 agent 在跑。
- **改 session／config 格式一定要寫遷移並備份**：`#[serde(default)]` 會把舊格式靜默讀成空的，下一次存檔就把使用者資料洗掉。

## 踩過的雷
- **PTY 輸出在 Rust 端轉字串 → 中文亂碼**：多位元組字元會被切在兩次 read 之間。輸出一律以 raw bytes 傳給 `term.write(Uint8Array)`，由 xterm 解 UTF-8。
- **ConPTY 開機會先問游標位置（portable-pty 開了 INHERIT_CURSOR）**：前端必須在 `pty_spawn` 回來之前就把 `running` 設 true，讓 xterm 的回覆送得進去，否則 console 卡住不出 prompt。
- **在視窗 focus 事件裡呼叫 `webview.setFocus()` → 無限迴圈**：setFocus 會再觸發一次視窗 focus 事件，結果 CPU 空轉、游標狂閃、整個 App 卡頓。這個「自動焦點」功能已整個移除（2026-10-20，使用者裁定不需要）：點一下視窗本來就會聚焦終端機。不要再加回來；若真的遇到拿不到焦點，先問清楚實際操作情境再查。
- **WebView2 除錯埠撞到使用者自己的 Chrome**：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` 測試前先確認該埠沒被占用，CDP 腳本只連 URL 是 `localhost:1420`／`tauri.localhost` 的頁面。
- **從 Claude Code session 裡啟動 panex（開發時）→ 分頁裡的 claude 全灰、出現 transcript 警告**：Claude Code 的工具 shell 帶 `NO_COLOR=1`、`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION` 等，會一路被分頁繼承。`pty.rs` 的 `scrub_parent_agent_env` 只在偵測到 `CLAUDECODE` 時剝掉這份固定清單；不要擴大成剝掉所有 `CLAUDE_CODE_*`（使用者可能刻意設了 `CLAUDE_CODE_USE_BEDROCK` 之類）。
