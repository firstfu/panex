# 流水帳（倒序，最新在最上方）

> 放「特定 commit／當下」的變更紀錄（變更 + 為什麼 + 下一步）。永久結論進 reference/，不進這裡。超 300 筆提醒搬 process-archive.md。
>
> **process-archive.md 的讀法**：預設不讀。要回溯時先 Grep 關鍵字（日期、功能名、表名）定位，再用 offset/limit 只讀那一筆，不得整份讀進來。

## 2026-10-20 — 工作區狀態改底色（拿掉邊框）、側欄快捷鍵改 Ctrl+Alt+H

**變更**
- `.tab.st-attention/done/running` 原本的左側色條＋藍色外框拿掉，改成淡藍／淡綠／淡黃底色（比照 cmux），hover 稍加深；選中（`.active`）時仍用灰白底，狀態只剩 `.t-note` 文字色。
- `toggleSidebar` 預設鍵 `Ctrl+Shift+B` → `Ctrl+Alt+H`（`src/keys.ts`；每個動作只能綁一組，是替換不是新增）。
- 已重打包並靜默安裝；commit `435598d` 已推上。

**為什麼**
- 使用者再次指出狀態外框是 AI 味 border；要求側欄快捷鍵改 Ctrl+Alt+H。

**下一步**
- 請使用者實測底色與快捷鍵；若要選中時也看到狀態色，或舊鍵與新鍵並存，需再改。

## 2026-10-20 — 側欄收合按鈕、選中分頁樣式、拖曳插入線改用無邊框風格

**變更**
- 分頁列最左邊加側欄收合按鈕（`#sidebar-toggle`），點一下切換 `sidebarHidden`，與既有快捷鍵 `Ctrl+Shift+B` 行為一致；分頁列外包一層 `#topbar`。
- 側欄最大拖曳寬度 360→280px（使用者仍嫌寬，`main.ts` 的 `SIDEBAR_W.max`）。
- 選中分頁（`.htab.active`）樣式改了三次才定案：先是邊框＋底線＋白字，使用者說「AI 味的 border 風格」打回；改成純底色＋白字粗體，拿掉所有邊框／陰影／頂線。
- 拖曳排序時的插入線，原本側欄與分頁列都是實心藍色邊框（`box-shadow`），同樣被判定是 AI 味的樣式；改成插在項目縫隙間的一小段半透明白色短條（`::before`/`::after` 偽元素），不再用強調色邊框。
- 每次調整都重新 `cargo tauri build` 並靜默安裝到 `%LOCALAPPDATA%\panex`。

**為什麼**
- 使用者持續嫌側欄拖曳上限太寬；選中分頁原本太不明顯，調整後又被指出邊框／頂線是常見的 AI 生成樣式 tell，改走純色塊 + 柔和短條的方向。

**影響檔案**：`index.html`、`src/main.ts`、`src/style.css`

**下一步**
- 這些樣式改動和側欄收合按鈕都還沒 commit／push。
- 工作區「有 agent 需要處理」狀態的藍色外框（`.tab.st-attention`）還沒動；使用者若也覺得像 AI 味再調。

## 2026-10-20 — 側欄可拖曳寬度、拖曳排序修復、圖示改 SVG、快捷鍵提示預設關

**變更**
- 側欄右緣加拖曳把手（`#sidebar-resizer`）：寬度 160–280px（520、360 都被嫌太寬）、存 `localStorage` 的 `panex.sidebarWidth`、雙擊還原 220px。
- 側欄工作區與分頁列的拖曳排序原本程式就有，但在 Windows 完全沒反應：`tauri.conf.json` 主視窗加 `"dragDropEnabled": false`（雷已記進 `boundaries.md`）。
- 側欄底部三顆按鈕的 `＋`／`⌄`／`⚙` 文字符號改成內嵌 SVG，按鈕改 `inline-flex`。使用者回報「1 個 icon 跑版」，但截圖太小、沒確認是哪顆，也沒確認修好沒，屬預防性處理。
- 「快捷鍵提示」（按住 Ctrl／Alt 顯示編號）：`modifierHints` 預設改 `false`（schema 同步），設定面板「外觀」頁新增「快捷鍵提示」開關。原本只有 `panex.json` 的 `shortcuts.showModifierHoldHints` 能關。
- 重新 `cargo tauri build` 並靜默安裝到 `%LOCALAPPDATA%\panex`（第一個重裝時 panex 正在跑，安裝程式把它關掉）。

**為什麼**
- 使用者要側欄能拖曳、icon 跑版要修、Alt+Shift 的提示太吵要能關且預設關。

**下一步**
- 新版（含快捷鍵提示預設關、最大寬度 360）已打包安裝並推上 `698eeb6`；拖曳排序、寬度把手、圖示都還沒經使用者確認，要請使用者開新版實測。
- 跑版圖示若仍存在，請對方提供整排三顆按鈕的大張截圖再查。

## 2026-10-20 — 公開發佈到 GitHub + v0.1.0 release + README 改版

**變更**
- 建立公開 repo `firstfu/panex` 並推送：初始 commit `5f9269b`（全部原始碼）、README 改版 commit `68c98bd`。
- README 依 Liftoff 風格重寫（置中頂部、徽章、Why／Features／Performance／Privacy／Install／Configuration／FAQ／比較／投票清單／Build／Contributing），新增 `translations/README.zh-Hant.md`、`assets/`（icon、hero、shortcuts 截圖，用獨立測試實例的示範資料拍，不含使用者真實分頁）。
- 發佈 v0.1.0 release，附 `panex_0.1.0_x64-setup.exe`（用推上去的同一份原始碼重新打包）。下載連結實測 302。
- 公開前掃描個資：字型預覽的 `C:\Users\mis` 改為 `C:\Users\you`。
- 歸檔：`overview.md` 修正為工作區／分頁現況並加「專案狀態」、新增 `operations.md`（測試實例、重拍截圖、發布流程）、`boundaries.md` 加一條「公開 repo 混進私人路徑」。

**為什麼**
- 使用者要求公開到 GitHub，README 格式比照自己的 Liftoff 專案。

**下一步**
- 依 README「投票清單」：英文介面、搜尋捲動歷史、分割窗格、側欄 git branch／port、一鍵 worktree。

## 2026-10-20 — 改成 cmux 的兩層結構：側欄工作區 + 水平分頁

**變更**
- 側欄改列「工作區」，每個工作區上方一排水平分頁，每個分頁一個終端機。Ctrl+N 新工作區、Ctrl+T 在目前工作區新分頁（使用者指定）。
- session.json 改為 `{workspaces:[{id,title,color,tabs:[{id,shell,cwd,title}],active}], active}`；前端擁有版面、整份 `session_save`（結構變動立即存、cwd 變動 500ms 防抖、關窗前 flush）；`pty_spawn` 不再登記分頁；`tab_close` 只殺 PTY＋刪 scrollback，前端先存版面再呼叫。
- 遷移：舊 `{tabs,active}` 每個分頁變成一個單分頁工作區（工作區 id = `w`＋分頁 id 前 11 碼，名稱與顏色搬到工作區，分頁 id 不變所以 scrollback 對得上），先備份 `session.v1.json.bak`。panex.json `schemaVersion` 1→2 時把快捷鍵 id 一次改名（newTab→newWorkspace、nextTab→nextWorkspace…、cycleTabNext→nextTab），先備份 `panex.json.v1.bak`。
- 通知：分頁有自己的狀態點，工作區顯示其分頁中最緊急的狀態；跳到未處理會連工作區一起切。關掉工作區最後一個分頁會連工作區一起關；最後一個工作區關掉會自動開新的。
- `PANEX_PIPE_NAME` 環境變數可覆寫通知管道名稱（給測試實例用）。

**驗證**（獨立測試實例：identifier `dev.panex.terminal.test`、`XDG_CONFIG_HOME` 指 scratch、管道 `panex-test`，種子為使用者真實 session/config 的複本）
- 5 個舊分頁 → 5 個工作區，scrollback 還原；快捷鍵改名正確、schemaVersion 2，UI 寫入後仍為 2。
- 真實按鍵：Ctrl+T 同工作區多一個分頁（沿用 cwd）、Ctrl+N 多一個工作區、Ctrl+Shift+W 關最後一個分頁會關工作區。
- panex-cli 通知背景分頁：分頁藍點、工作區亮起並顯示訊息。重開後各工作區的選中分頁還原。

**為什麼**
- 測試改用獨立實例：之前直接在使用者的 panex 上測，重開會殺掉他正在跑的 agent，也可能關錯分頁。

## 2026-10-20 — 一個動作可綁多組快捷鍵

**變更**
- `shortcuts.bindings` 新增「陣列裡放陣列＝多組任選一組」（如 `"newTab": [["ctrl+n"], ["ctrl+t"]]`），字串與字串陣列（連續按鍵）維持 cmux 相容。
- 設定面板每組按鍵是一個 chip，滑過出現 × 可移除；列尾 ＋ 再加一組；衝突時只從別的動作拿走撞到的那一組。
- 移除「切回視窗自動給焦點」（造成 focus 事件無限迴圈；使用者裁定不需要）。
- 使用者設定：newTab 改為 Ctrl+N 與 Ctrl+T。實測真實按鍵兩組都能開新分頁。

**注意**
- Ctrl+T 在 Claude Code 是切換待辦清單，綁給 panex 後 Claude Code 收不到。

## 2026-10-20 — 設定面板改版

**變更**
- 設定面板改成左側分頁（外觀／終端機／快捷鍵／設定檔）＋右側內容；每列為「名稱＋一行說明」配右側控制項。
- 控制項：不透明度滑桿（填色軌道）、背景效果與預設 shell 改成分段按鈕、字型大小加減按鈕、開關取代核取方塊、字型欄位下方即時預覽。
- 快捷鍵頁：依「分頁／切換／編輯／檢視／設定」分組、可搜尋；按鍵畫成一顆顆鍵帽（面板唯一的擬物元素），錄製中整格變藍；固定操作（Ctrl+滾輪、雙擊、右鍵、中鍵）列在最後。
- 設定檔頁：路徑、用編輯器開啟、重新載入、快捷鍵寫法範例。

**為什麼**
- 刻意不用卡片堆疊與區塊小標，只用細分隔線；強調色只沿用 App 既有的「需要注意」藍。

## 2026-10-20 — 可自訂快捷鍵 + 仿 cmux 的 panex.json 設定檔

**變更**
- 設定改存 `~/.config/panex/panex.json`（舊的 app-data `settings.json` 自動搬遷後刪除），附 `panex.schema.json`，存檔 0.3 秒後即時套用；JSON 壞掉時沿用上次設定並跳出錯誤提示（可直接開檔）。
- 快捷鍵全部可改：設定面板點按鍵後直接錄新組合，衝突時自動從原動作移除並提示，每列可單獨恢復預設，另有「全部恢復預設」。檔案格式同 cmux `shortcuts.bindings`（含連續按鍵、取消綁定）。側欄編號提示、右鍵選單、shell 選單的按鍵標示都跟著綁定變。
- 新增設定：`terminal.scrollback`、`terminal.smartCopyPaste`、`shortcuts.showModifierHoldHints`；新動作 `openConfigFile`、`reloadConfiguration`（Ctrl+Shift+,）。
- 實測（release）：錄製 F2 → 衝突移除、寫檔只留覆寫值；手改檔案（改 opacity、加連續按鍵）即時生效；故意寫壞 JSON 出現錯誤提示且設定不變；Ctrl+K Ctrl+N 連續按鍵可用。

**為什麼**
- 按鍵用 `KeyboardEvent.code` 比對，換鍵盤配置也不會跑掉；錄製時要求 Ctrl/Alt/Win（F 鍵例外），避免綁到一般字元吃掉終端機輸入。
- 自己寫檔觸發的 reload 在寫入排隊中時略過，否則拖透明度滑桿時會被舊值拉回。

**下一步**
- 搜尋（Ctrl+Shift+F）、分割窗格。

## 2026-10-20 — 分頁改名／顏色／排序、cmux 對應快捷鍵、設定面板（透明度）

**變更**
- 分頁：雙擊、右鍵選單或 Ctrl+Shift+R 改名（清空＝回到自動名稱）；右鍵選單可標 8 種顏色（cmux 同名色）、上移／下移／移到最上、關閉其他／下方／上方；拖曳排序；中鍵關閉；按住 Ctrl 顯示分頁編號。名稱、顏色、順序存進 session.json。
- 快捷鍵依 cmux README 的配置對應到 Windows（⌘ → Ctrl／Ctrl+Shift，避開終端機常用的 Ctrl 單鍵）：Ctrl+1–8／9、Ctrl+PgUp/PgDn、Ctrl+Shift+PgUp/PgDn、Ctrl+Shift+B/K/U/R/W、Ctrl+=/-/0、Ctrl+滾輪、Ctrl+,。
- 設定面板（`settings.json`）：透明度 30–100%、背景效果（無／Mica／Acrylic）、字型大小與字型、預設 shell、游標閃爍；附快捷鍵表。視窗改為 `transparent: true`，背景由 `#terms`／側欄的 rgba 畫，xterm 背景全透明。
- 實測（release）：右鍵選單、雙擊改名、顏色、透明度 75% 真的透出後方視窗、Acrylic 毛玻璃生效、設定與 session 落檔。

**為什麼**
- 雙擊改名用手動偵測兩次點擊：第一下點擊會重繪側欄，原生 dblclick 的目標被換掉時不會觸發。
- cmux 參考碼只放 scratchpad、只看行為與按鍵，不抄 GPL 程式碼。

**下一步**
- 搜尋（Ctrl+Shift+F，@xterm/addon-search）、分割窗格。

## 2026-10-20 — v0.1 骨架：垂直分頁 + 通知 + 還原

**變更**
- 建專案（Tauri 2.12 + xterm.js 6 + portable-pty 0.9，前端純 TS + Vite 8）。context-kit 初始化。
- 垂直分頁（每頁一個 PTY）、預設 cmd、⌄ 選單可開 Windows PowerShell／PowerShell 7。
- agent 通知：`panex-cli` + named pipe；Notification＝藍、Stop＝綠、UserPromptSubmit＝黃（執行中）；視窗不在前景才發 toast＋閃工作列。側欄「啟用」按鈕寫入 Claude Code hooks。
- 還原：session.json + 每分頁 scrollback 快照；lazy spawn；single-instance、window-state。
- 實測：cmd/PowerShell、中文、OSC 9;9 cwd 追蹤正常；`Stop-Process -Force` 後重開分頁、cwd、scrollback 都回來，且沒有遺留 cmd/conhost；release 閒置 10 秒 panex+WebView2 CPU 0.03 秒；panex.exe 9 MB、安裝檔 2.2 MB。

**為什麼**
- 先做分頁不做分割窗格：通知與還原要有多個工作階段才有意義，分割窗格留到下一輪。
- scrollback 用 serialize 快照而非重播 raw bytes：TUI（Claude Code/Ink）重繪流換寬度重播會亂掉。
- `panex-cli` 獨立成 console 小程式：GUI exe 有 windows_subsystem 與 single-instance，不適合給 hook 呼叫。

**下一步**
- 分割窗格（窗格樹 + 存進 session）。
- 側欄顯示 git branch、監聽中的 port；一鍵建 worktree 開 agent。
- 驗證安裝版的 toast（dev 版受 AUMID 限制可能不跳）與安裝檔內含 panex-cli.exe（NSIS hook）。
- 分頁拖曳排序、重新命名。
