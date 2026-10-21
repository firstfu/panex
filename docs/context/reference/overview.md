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

- 已公開發佈：https://github.com/firstfu/panex（public、MIT），最新 release v0.2.0 附 NSIS 安裝檔（v0.1.0 為首發）。
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
| 一鍵 worktree | 側欄右鍵「用新 worktree 開新工作區…」（或可綁定的 `newWorktree`）開對話框，分支名與起點分支兩欄都有本機分支下拉（`git_branches`，datalist）。`git.rs::git_worktree_add` 以 `git worktree add` 建在主 repo 同層的 `<repo>-worktrees/<分支，非字母數字改 ->`（從 worktree 內再開也找回主 repo）；分支已存在就直接簽出，否則從起點建；路徑已存在就拒絕。接著依 `panex.json` 的 `worktree.copyFiles`（預設 `.env`、`.env.local`，只複製檔案、不覆蓋、相對路徑且不得含 `..`）從目前 worktree 根目錄複製過去，並開以分支命名的新工作區；`worktree.setupCommand` 存在就在 shell 啟動後（`spawn` 內）自動送入。git 不追蹤的檔案（.env、node_modules）不會自動出現在 worktree，這是兩個設定存在的原因。不做移除 worktree（可能有未提交內容）。 |
| 重開後自動接回 Claude Code | `panex-cli` 把 hook JSON 的 `session_id` 以 `sessionId` 帶進管道；`agent-notify` 處理時存進 `tab.agentSession`（`session.json` 的 `agentSession`，欄位可省略所以不需遷移）並設 `agentLive=true`。**存的是「正在跑」的 session**：下一個 shell prompt（`setCwd` 的 OSC 9;9）表示 Claude 已結束，`endAgent` 清掉 `agentSession`；shell 結束（`pty-exit`）也清。所以關閉 panex 時還在跑 Claude 的分頁才留有 id。重開後，該分頁第一次啟動 shell 時（`spawn` → `autoResume`，沿用 lazy spawn，沒被打開的分頁不會啟動）把 `claude --resume <id>` 當 `initialInput` 送進去，不需按任何按鈕（跟 cmux 一樣）。id 會被打進 shell，所以只收 `^[0-9A-Za-z-]{8,64}$`（`validSessionId`）。設定 `agent.resumeSession`（預設開，設定頁「終端機」有開關）關掉就不自動接回，記錄照常。**兩個會踩的地方**：①ConPTY 會把同一個 shell 提示符回報兩次（`setCwd` 相隔約 1 ms），所以 50 ms 內的重複回報視為一次（`promptAt`）；②自動接回後 shell 啟動時自己的那個提示符不是「Claude 結束」，用 `skipPrompt` 略過一次，否則剛接回就被誤判為已結束、記錄被清掉。只對安裝後、hook 通知過的分頁生效，不回溯舊分頁。曾提案「沒記錄時改讀 `~/.claude/projects/` 該資料夾最新的 session 當後備」，使用者已否決（依賴 Claude Code 內部檔案格式），不要再加。也曾做過「終端機下方提示列＋側欄 `↻` 按鈕」的手動恢復，改成自動後整個移除（2026-10-21，使用者裁定），不要再加回。沒有新增 hook 事件，既有使用者不必重按「啟用」。 |
| `src/keys.ts` | 快捷鍵：`ACTIONS`／`GROUPS`（工作區、分頁、編輯、檢視、設定）。綁定格式與 cmux 相容：字串＝單一組合、字串陣列＝連續按鍵、陣列裡放陣列＝多組任選一組、`null`/`"none"`＝取消。以 `KeyboardEvent.code` 比對實體按鍵；`digits` 動作以 `…+1` 代表 1–9 整組。 |
| 外觀 | 視窗 `transparent: true`，透明度靠 CSS `--alpha`，xterm 背景全透明；Mica／Acrylic 用 `setEffects`。 |

## 還原機制

- cwd 來源：cmd 啟動時設 `PROMPT=$e]9;9;$P$e\<原 PROMPT>`；PowerShell 用 `-NoExit -EncodedCommand` 包一層 `prompt` 函式送 OSC 9;9。前端解析後更新分頁 cwd，500 ms 防抖後整份存 session。
- scrollback：有輸出才標 dirty，4 秒後用 `@xterm/addon-serialize`（最後 1000 行、排除 alt buffer）存檔；關窗時 `onCloseRequested` 再 flush 一次。crash 最多掉約 4 秒。
- 重開：先把快照寫回 xterm，游標移到最後一行非空白之下再印「已還原」分隔線。還原的分頁要點開才啟動 shell（lazy spawn）。
- 還原時先過 `squeezeBlankRuns`（`src/main.ts`）：連續 3 行以上的空行壓成 2 行。原因：Claude Code 這類全螢幕 TUI 會用大量空行把輸入框墊到視窗底部，快照把這些空行原樣存下，還原後被當成歷史輸出，夾在舊畫面與「已還原」分隔線之間變成一大片空白、把內容往上擠（2026-10-20 使用者回報）。一般終端輸出的空行不受影響。
- 單一實例（single-instance plugin）避免兩個 panex 互相覆寫 session；視窗大小位置由 window-state plugin 還原。
