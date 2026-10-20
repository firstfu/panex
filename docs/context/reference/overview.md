# 系統架構大圖

> **何時讀**：每個 session 開場必讀。

panex：開源、跨平台（Windows 優先）的多 agent 終端機 App，模仿 cmux（manaflow-ai/cmux，macOS only）的核心體驗。技術棧 Tauri 2（Rust）+ xterm.js 6 + portable-pty，前端純 TypeScript + Vite（刻意不用框架，壓資源）。授權 MIT；cmux 是 GPL，只參考功能、不抄程式碼。

## 需求（使用者定案）

- 跟 cmux 一樣的兩層結構：側欄是「工作區」（Ctrl+N），每個工作區上方一排水平「分頁」（Ctrl+T），每個分頁一個終端機。
- 預設 shell 為 cmd，可選 Windows PowerShell／PowerShell 7（偵測得到才列）。
- agent 通知：Claude Code hooks → `panex-cli notify` → 分頁亮起、所屬工作區顯示其分頁中最緊急的狀態；視窗不在前景時再加 toast＋工作列閃爍。
- 關閉或 crash 後重開，還原工作區、分頁、各分頁 shell 與 cwd、捲動歷史（跟 cmux 一樣；執行中的程式不保留）。
- 效能與資源占用最小化。

## 專案狀態

- 已公開發佈：https://github.com/firstfu/panex（public、MIT），v0.1.0 release 附 NSIS 安裝檔。
- README 仿使用者另一個專案 Liftoff 的寫法（置中頂部、Why／Features／Performance／Privacy／FAQ…），英文版在根目錄、繁中版在 `translations/README.zh-Hant.md`，截圖在 `assets/`。
- 介面有英文與繁體中文（`app.language`：`auto` 依 webview 的 `navigator.language`，`zh*` 用繁中、其餘用英文）。發布與重拍截圖的做法見 `operations.md`。

## 模組地圖

| 位置 | 職責 |
|---|---|
| `src-tauri/src/pty.rs` | 每分頁一個 PTY。輸出走 Tauri `Channel` 的 raw bytes（不經 JSON、不在 Rust 解 UTF-8）；waiter 執行緒等子程序結束後才丟掉 master（ConPTY reader 不會自己 EOF）。channel 可替換，webview reload 後重接仍在跑的 shell。 |
| `src-tauri/src/session.rs` | `app_data_dir`（`%APPDATA%\dev.panex.terminal\`）下的 `session.json`：`{workspaces:[{id,title,color,tabs:[{id,shell,cwd,title}],active}], active}`，與 `scrollback/<分頁 id>.txt`。前端擁有版面、整份 `session_save`；全部 tmp + rename 原子寫入；檔案壞了就當空白開始。讀到 v0.1 的扁平 `{tabs,active}` 會先備份 `session.v1.json.bak` 再轉成「每分頁一個工作區」（工作區 id ＝ `w`＋分頁 id 前 11 碼）。 |
| `src-tauri/src/notify.rs` | named pipe `\\.\pipe\panex-<USERNAME>`（Unix 為 socket）收 `panex-cli` 的 JSON，轉成 `agent-notify` 事件；`alert` 指令發 toast＋閃工作列。 |
| `src-tauri/src/hooks.rs` | 把 hooks 合併進 `~/.claude/settings.json`（exec form，先備份 `.panex-bak`，只替換含 `panex-cli` 的條目）。只由使用者在 UI 按「啟用」觸發。 |
| `src-tauri/src/bin/panex-cli.rs` | 獨立 console 小程式。讀 hook stdin JSON，帶上 `PANEX_PANE_ID` 寫入 `PANEX_PIPE`。環境變數不在就立刻 exit 0；永遠 exit 0。`PANEX_DEBUG=1` 印出送出的內容。 |
| `src/main.ts` | 工作區（側欄，改名、顏色、拖曳、右鍵選單）與水平分頁（分頁列，改名、拖曳、右鍵選單）、設定面板（左側分頁＋快捷鍵錄製）、OSC 解析（9;9 / 7 = cwd；9 / 777 / BEL = 通知）、scrollback 快照。關掉工作區最後一個分頁會連工作區一起關，最後一個工作區關掉會自動開新的。 |
| `src-tauri/src/config.rs` + `schemas/panex.schema.json` | 使用者設定檔 `~/.config/panex/panex.json`（仿 cmux 的 `cmux.json`）：只寫改過的鍵、旁邊放 schema 供編輯器補完、`notify` 監看目錄、最後一次寫入後 300 ms 發 `config-changed`。`config_set` 只改單一鍵、檔案壞掉時拒寫。目前 `schemaVersion` 2；讀到 1 時先備份 `panex.json.v1.bak` 再依 `V1_RENAMES` 改名快捷鍵 id（v1 的「分頁」＝現在的工作區）。 |
| `src/i18n.ts` | 介面語言。以繁中原文當 key、`t("原文", {var})` 查英文（找不到就回原文）；靜態 HTML 用 `data-i18n`／`-title`／`-aria`／`-ph` 標記，`translateDom()` 首次記下原文後可來回切換。新增任何使用者看得到的字串都要同時加進 `EN` 字典；`keys.ts` 的動作 label 維持繁中，顯示時才 `t()`。Rust 端錯誤訊息一律英文。 |
| `src-tauri/src/git.rs` | `git_branch(cwd)`：往上找 `.git`（目錄或 worktree 的 `gitdir:` 檔）直接讀 `HEAD`，不開 git 程序；detached 回 7 碼 hash。前端在每次 cwd 回報（每個 prompt）重查，同分頁 1 秒內不重複，所以原地 `git checkout` 下個 prompt 就更新。 |
| `src/keys.ts` | 快捷鍵：`ACTIONS`／`GROUPS`（工作區、分頁、編輯、檢視、設定）。綁定格式與 cmux 相容：字串＝單一組合、字串陣列＝連續按鍵、陣列裡放陣列＝多組任選一組、`null`/`"none"`＝取消。以 `KeyboardEvent.code` 比對實體按鍵；`digits` 動作以 `…+1` 代表 1–9 整組。 |
| 外觀 | 視窗 `transparent: true`，透明度靠 CSS `--alpha`，xterm 背景全透明；Mica／Acrylic 用 `setEffects`。 |

## 還原機制

- cwd 來源：cmd 啟動時設 `PROMPT=$e]9;9;$P$e\<原 PROMPT>`；PowerShell 用 `-NoExit -EncodedCommand` 包一層 `prompt` 函式送 OSC 9;9。前端解析後更新分頁 cwd，500 ms 防抖後整份存 session。
- scrollback：有輸出才標 dirty，4 秒後用 `@xterm/addon-serialize`（最後 1000 行、排除 alt buffer）存檔；關窗時 `onCloseRequested` 再 flush 一次。crash 最多掉約 4 秒。
- 重開：先把快照寫回 xterm，游標移到最後一行非空白之下再印「已還原」分隔線。還原的分頁要點開才啟動 shell（lazy spawn）。
- 單一實例（single-instance plugin）避免兩個 panex 互相覆寫 session；視窗大小位置由 window-state plugin 還原。
