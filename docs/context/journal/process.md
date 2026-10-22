# 流水帳（倒序，最新在最上方）

> 放「特定 commit／當下」的變更紀錄（變更 + 為什麼 + 下一步）。永久結論進 reference/，不進這裡。超 300 筆提醒搬 process-archive.md。
>
> **process-archive.md 的讀法**：預設不讀。要回溯時先 Grep 關鍵字（日期、功能名、表名）定位，再用 offset/limit 只讀那一筆，不得整份讀進來。

## 2026-10-22 — 拆分 `src/main.ts`（2715 行 → 22 個模組），每個檔案補上檔頭註解

**變更**
- 前端依原本的 `// ──` 區塊拆成 `main`（只剩啟動與後端事件）、`state`、`settings`、`types`、`util`、`config`、`session`、`terminal`、`agent`、`workspaces`、`render`、`input`、`actions`、`git-panel`、`settings-panel`、`search`、`links`、`rename`、`context-menu`、`close-ask`、`worktree-dialog`、`ssh-dialog`，最大的 `settings-panel.ts` 約 400 行。
- 其他模組會重新賦值的 9 個值改放在 `state.ts` 的 `S` 物件上；只有單一模組用的狀態留在原地，對外給 getter（`isGitOpen`、`isCapturing`、`configWritesPending`）；關窗前的存檔整理成 `flushForClose`。
- 搬移用腳本按行號切、自動產生 import，再用 `tsc` 收斂。逐行比對原檔與新檔（去掉 `export`／`S.`），除了上面列的刻意改動之外，沒有一行遺失、重複或改動。打包大小幾乎不變（585.8 → 586.4 kB），搜尋仍是獨立 chunk。
- 所有原始碼檔頂部都有說明它負責什麼的註解：新模組、`index.html`、`style.css`、`vite.config.ts`、測試、`lib.rs`、`git.rs`、`main.rs`、`build.rs`、`Cargo.toml`、`tsconfig.json`、`.gitignore`。不能寫註解、所以沒加的只有 `package.json`、`tauri.conf.json`、`capabilities/*.json`、`schemas/*.json`。
- 驗收：寫一份 CDP 腳本跑 32 個檢查點（還原與捲動歷史、打字、搜尋、Git 面板與 diff、新分頁／工作區、各種切換、agent 三種狀態、跳到需處理的分頁、關分頁與關視窗確認、改名、右鍵選單、worktree／SSH 對話框、設定頁與寫回 panex.json、側欄切換、縮放、關閉後存檔），拆分前後各跑多次；另外補兩條手寫接線的檢查（設定頁錄快捷鍵寫入 `panex.json`、從外部改 `panex.json` 後畫面套用），兩版結果相同。所有差異都能在兩個版本中各自重現（視窗焦點決定切過去時是否清掉狀態、git 徽章的時間差），沒有一個只出現在拆分後；5 次執行 0 個 JS 例外。`npm test`、Rust 16 個測試全過。
- 為了不跟同時在跑的 session 撞檔，在 `../panex-worktrees/split-main` 的分支上做，完成後合回 main。

**為什麼**
- 第一性分析第 4 項：多個 session 同時改同一個 2700 行的檔案容易互相干擾（曾發生 commit 帶走別人改動）；拆開後改一個功能只碰一個檔案，也更省讀取量。使用者要求每個檔案頂部都要有註解。

**下一步**
- 沒有自動化驗到的：拖曳排序、從檔案總管拖檔進來、Ctrl+點擊開連結、macOS。請使用者實機試一下。
- 新增模組時記得：頂層只查 DOM、掛事件，不要在模組頂層呼叫別的模組（見 `overview.md`）。

## 2026-10-22 — Windows／Linux 關閉分頁預設改成 Ctrl+W（`d1e6475`）

**變更**
- `keys.ts` 的 `closeTab` 預設從 `ctrl+shift+w` 改成 `ctrl+w`（Mac 維持 `meta+w`），README 中英快捷鍵表同步。只跑過 `tsc`，沒在 App 實按。

**為什麼**
- 使用者要跟 Mac 一樣用 Ctrl+W 關分頁。代價：終端機裡 Ctrl+W（往回刪一個字）不再送進 shell／Claude Code；agent 跑到一半時仍會先跳確認框。

**下一步**
- 下次發版時實按驗一次 Ctrl+W 關分頁，並在 release notes 提醒這個行為變更。

## 2026-10-22 — 發佈 v0.4.1（真實環境驗收、VS Code 改走 CLI）

**變更**
- 使用者授權我自己驗收後直接發版。用測試實例搭配**真的 Claude Code** 驗收：
  - Claude 跑到一半按 Esc：Claude 停止並顯示「Interrupted」，側欄轉圈停止，改成「已中斷」。
  - Claude 在跑時關閉視窗：跳出確認框，按取消後視窗沒有關。
  - Claude 正常做完：側欄顯示完成和最後回覆的內容。
  - 輸入 `/exit`：`session.json` 裡的 `agentSession` 被清掉（SessionEnd 生效）。
- 真的 Ctrl+點擊：
  - 網址：Chrome 開出 Example Domain。
  - `note.txt`：用記事本打開。
  - `run.bat`：只在檔案總管裡標出來，沒有執行（陷阱 `ran.marker` 沒有產生）。
  - 選 VS Code 的路徑一開始走 `vscode://file/...`，VS Code 每次都跳「外部應用程式想要在 Code 中開啟…」確認框。修正（`e5b6392`）：改成先找 PATH 上的 `code`／`cursor`，用 `-g 檔案:行:欄` 開啟；找不到 CLI 才退回用網址開。修正後 VS Code 直接開檔，沒有確認框。
  - 測試開出的記事本、檔案總管、VS Code 視窗事後已關閉；Chrome 的 example.com 分頁留著沒動。
- 版號改成 0.4.1（`c2f4a13`）。`package-lock.json` 開頭的版本號也一起改了，`operations.md` 列的版本號檔案清單裡沒有它。推上 main 並推 tag `v0.4.1`，CI 兩個平台都建置成功。發布後，`releases/latest` 的 `.exe`、`.dmg` 連結都回 302，指向 v0.4.1。

**為什麼**
- 使用者說「你測就好，不要再問我。測好後，發新版到 github」。

**下一步**
- 使用者要裝 v0.4.1，並在 panex 按一次「啟用」：一方面補上兩個新 hook，另一方面把 hook 從 `target/test-build/panex-cli.exe` 改回指向安裝版的路徑。
- 值得歸檔、還沒歸檔的雷：①`vscode://` 網址會觸發 VS Code 的確認框；②測試實例覆寫 `USERPROFILE` 會起不來；③Git Bash 會把 `/exit` 這類開頭是 `/` 的參數轉成路徑（`MSYS_NO_PATHCONV=1`）；④`operations.md` 的版本號檔案清單要補上 `package-lock.json`。

## 2026-10-22 — 發佈 v0.4.3（hooks 自動寫入），本機更新

**變更**
- 版本改成 0.4.3，推 tag，CI 兩個平台成功後發布；`releases/latest/download` 兩個檔名都轉到 v0.4.3，下載的安裝檔 SHA-256 與 GitHub 記錄一致。
- 本機更新沿用上次的排程器腳本，另外在重開 panex 後把 `settings.json` 裡 panex-cli 的路徑寫進 log，確認 `hooks::ensure` 真的把 hooks 改回正式路徑。

**為什麼**
- 使用者要求發版並更新本機，讓 hooks 不必按「啟用」就修好。

**下一步**
- 重開後看 log：版本應為 0.4.3，hooks 應指向 `%LOCALAPPDATA%\panex\panex-cli.exe`。

## 2026-10-22 — Claude Code hooks 改成啟動時自動寫入，不再詢問

**變更**
- `hooks::ensure` 在 `setup` 時呼叫：正式安裝的 panex（release build 且 identifier 為 `dev.panex.terminal`）發現 hooks 缺少，或指向別的 panex-cli，就自動寫入；照舊先備份 `.panex-bak`、只替換含 `panex-cli` 的條目。debug build 與測試實例一律不寫。
- 移除啟動時的「啟用 Claude Code 通知？」對話框和 `agent.askToEnableHooks` 設定（schema、i18n、CSS 一起清掉）。側欄「啟用」按鈕保留，只在自動寫入失敗（例如 settings.json 壞掉）時出現。
- `hooks.rs` 拆出 `status_at`／`install_at`／`may_write` 並加 4 個測試：只有正式版會寫、保留其他 hooks 並把舊的 panex 條目換掉而不是重複加、檔案不存在時建立、檔案壞掉時不動。Rust 測試共 16 個。
- 測試實例實測：啟動後沒有對話框，使用者真正的 `settings.json` 前後 SHA-256 相同。
- `boundaries.md`、`overview.md`、README 兩版（功能、隱私、Claude Code 通知、FAQ、解除安裝）同步改寫。

**為什麼**
- 使用者裁定 hooks 是必要功能，不要再徵求同意。同時這也修好「hooks 被指到別的位置就一直壞著」的問題：新版每次啟動都會把它們改回自己這份安裝。

**下一步**
- 要發 0.4.3 並更新本機，使用者的 hooks 才會自動從 `target\test-build` 改回正式路徑，同時補上 0.4.1 新增的兩個 hook。

## 2026-10-22 — 發佈 v0.4.2，本機更新

**變更**
- 發版前兩組測試全過（前端 6、Rust 12）。版本改成 0.4.2（`chore: bump to 0.4.2`），推 tag `v0.4.2`，CI 兩個平台都成功，換上發布說明後發布；`releases/latest/download` 的 `.exe`、`.dmg` 都回 302 指向 v0.4.2。
- 內容：關閉分頁／工作區前先確認、`validSessionId` 拒絕 `-` 開頭、遷移測試。
- 本機更新：panex 一關，在裡面跑的 Claude Code（包括執行更新的這個 session）就會中斷，所以用排程器（`schtasks`）在 panex 外跑腳本：強制結束已安裝的 panex（正常關閉會停在「還有 agent 在工作」的確認框）→ `setup.exe /S` → 重開 panex，每步寫進 log。

**為什麼**
- 使用者要求 commit 全部、發新版並在本機安裝，並授權「幫我做到好」。

**下一步**
- 重開後確認 log 與 `panex.exe` 版本是 0.4.2。
- hooks 仍指向 `target\test-build\panex-cli.exe`，要使用者在新版側欄按「啟用」改回正式路徑。

## 2026-10-22 — 補上遷移與輸入檢查的測試

**變更**
- Rust（`cargo test`，12 個）：`session.rs` 測 v0.1 扁平分頁轉工作區（id、標題顏色、active、壞 id 丟棄、備份、轉完再讀一致）、現行格式所有欄位來回不掉、壞檔或沒檔從空白開始、`valid_id`。`config.rs` 測 v1 快捷鍵改名（含 `cycleTabPrev`、只跑一次、備份）、改名目標不重複、v2 檔不動、v0.1 settings 對應、`read` 的 BOM／空白／非物件、`config_set` 只改單一鍵且清空殼、壞檔拒寫。為了能指定路徑，`migrate_v1_bindings`／`config_set` 拆出 `_at(&Path)` 版本，行為不變。
- 前端（`npm test`，6 個，Node 內建 `node --test`，沒有新增依賴）：`validSshTarget`、`validSessionId`、`squeezeBlankRuns` 從 `main.ts` 搬到沒有副作用的 `src/sanitize.ts`，測試在 `tests/`。
- 順手修正：`validSessionId` 原本接受 `-` 開頭（例如 `--dangerously-skip-permissions`），會變成 `claude --resume` 後面的另一個選項；改成第一個字必須是英數字。
- 故意改壞 v1 工作區 id 與 `cycleTabPrev` 對應，兩個測試都會失敗，改回後全過。

**為什麼**
- 第一性分析的第 3 項：遷移寫錯會靜默洗掉使用者資料，是全專案風險最高、又完全沒測試的地方；之後要拆 `main.ts` 也需要安全網。

**下一步**
- 測試跑法已歸檔進 `operations.md` 的「單元測試」，發版步驟加上「先跑測試」。CI 刻意不跑：每次 push 都要從零編 Rust，遷移又很少改，不划算。
- 刪掉 `src/pty.rs`：第一個 commit 就混進來的 0 位元組空檔，沒有任何地方引用。

## 2026-10-22 — 關閉分頁／工作區也先確認

**變更**
- 使用者主動關閉的路徑（Ctrl+Shift+W、分頁 ×、中鍵、右鍵「關閉分頁／其他／右側」、工作區 ×、中鍵、`closeWorkspace` 與右鍵各項）改走 `askCloseTabs`：其中有 agent 在這一輪中（`workingTabs()`）就沿用關視窗的對話框。`pty-exit` 代碼 0 的自動關閉不經過確認（程序已經結束）。原本的 `closeWorkspaces` 沒人用了，已刪。
- 對話框內文改成依情境填入：關視窗沿用「重開會自動接回」；關分頁是「不會自動接回對話」（分頁關掉，接回紀錄也跟著沒了）。沿用設定 `agent.confirmCloseWhileRunning`，設定頁、schema、README 兩版的說明一起改。
- 測試實例＋CDP 實測 8/8：執行中按 × 會問、取消保留、Ctrl+Shift+W 會問、確認後關閉；等你回應的那一輪中關工作區會問；閒置直接關；設定關掉直接關；關視窗的對話框文字與「仍要關閉」照舊。

**為什麼**
- 第一性分析的「不丟狀態」缺口：只擋了關視窗，Ctrl+W 誤關一個跑著 agent 的分頁反而損失更大（不會自動接回）。

**下一步**
- 已 commit（`78a2998`）並推上 main，還沒發版。
- 建置時遇到另一個程序在跑 `rustup update`，工具鏈裝到一半，`rustc` 暫時消失，tauri-cli 會在 `rustc -vV` 的 `unwrap` panic。等它跑完就好；另外 PowerShell 5.1 會吃掉 `cargo tauri build … -- --profile` 的 `--`，要改用 Bash 建置。

## 2026-10-22 — agent 工作中關閉前先確認

**變更**
- 新增 `fbe769a`：在 `onCloseRequested` 裡，只要有分頁「執行中」，或在這一輪中等你回應（狀態是 `attention` 且 `runStart` 還在），就先 `preventDefault`，跳出對話框列出這些分頁。按「仍要關閉」會先存檔再 `win.destroy()`；按「取消」或 Esc 就不關。焦點預設停在「取消」上，免得原本要給終端機的 Enter 把視窗關掉。macOS 的 Quit 也會走關閉視窗這條路，所以一樣會問。
- 新設定 `agent.confirmCloseWhileRunning`（預設開，設定頁「終端機」也能切換）；schema、i18n、README 兩版同步更新。
- 測試實例實測：對測試行程送 `CloseMainWindow()`，有 agent 在跑時會出現對話框且行程沒結束；Esc、取消都不會關；「仍要關閉」會結束行程，且 `session.json` 有寫入；閒置時直接關閉。

**為什麼**
- 和使用者用第一性原理討論 orca 的背景常駐程式後的決定：「關閉 App 時 agent 正在工作」機率低、損失小（`--resume` 能接回對話，損失的只有正在做的這一輪），不值得為此加一個常駐背景程式（違反「不用時零成本」）。所以只用確認對話框擋掉最常見的誤關。

**下一步**
- 單獨關掉一個正在跑 agent 的分頁（Ctrl+W）還不會詢問；有需要再加。

## 2026-10-22 — 側欄狀態不再卡住、捲動歷史搜尋、Ctrl+點擊連結

**變更**
- 側欄狀態（`c40f478`）：hooks 改成接五個事件，新增 `StopFailure`、`SessionEnd`。`StopFailure` 時顯示藍點加 API 錯誤原文；`SessionEnd` 時清掉「執行中」和接回紀錄；分頁在「執行中」時按 Esc 或 Ctrl+C，改顯示「已中斷」；shell 提示符回來時，如果還卡在「執行中」也一併清掉。README 兩版的 hook 清單同步更新。
- 捲動歷史搜尋（`59a922b`）：`find` 動作預設 Ctrl+Shift+F（mac 是 ⌘F），搜尋框在終端機右上角，打字就逐字搜尋，Enter／Shift+Enter 跳下一個／上一個，Esc 關閉並把焦點還給終端機。`@xterm/addon-search` 拆成獨立 chunk，第一次搜尋時才載入。只有焦點在搜尋框時，Esc 才會被攔下；焦點在終端機時，Esc 照常送給程式（用來中斷 Claude）。
- 可點擊的連結（`2bbae96`）：按住 Ctrl（mac 是 ⌘）點擊才會開，單純點擊還是選取文字。網址用 `@xterm/addon-web-links`。檔案路徑由自寫的 link provider 比對，相對路徑以分頁的 cwd 為準，用 `links_resolve` 確認檔案存在才標成連結；SSH 分頁不處理檔案路徑。新增 `src-tauri/src/links.rs`：Windows 用 `ShellExecuteW`（`windows-sys` 本來就在依賴樹裡，只是補上 features），不經過 shell；只開 http(s) 網址；可執行檔（.exe、.bat、.ps1 等）只在檔案總管裡標出來，不會執行；網路路徑（`\\server\...`）完全不去探測。新設定 `terminal.openFilesWith`（`system`／`vscode`／`cursor`，在設定頁「終端機」），選編輯器時用 `vscode://file/...:行:欄` 開檔並跳到行號。
- README 兩版：搜尋與連結加進功能列表，把「搜尋捲動歷史」從投票清單移除（`78c3b51`）。
- 測試實例＋CDP 實測：用 `panex-cli` 模擬 hook，狀態轉換全部正確；搜尋的筆數、上下跳、無符合、Esc 關閉都正常，且一開始沒有載入 chunk；滑鼠移到連結上的偵測（含行號、結尾句點、不存在的檔案、`v1.2.3` 不被誤判）、拒絕危險輸入（`file:`／`javascript:`／`ms-settings:`、相對路徑、網路路徑）、設定頁寫回 `panex.json` 都驗過。**沒有實際點開任何連結**，因為點下去會在使用者桌面開出視窗。

**為什麼**
- 第一性原理分析後，使用者同意的優先順序：AI 終端機的瓶頸是人的注意力和驗收，所以先修狀態信號的正確性（Claude Code 官方文件寫明使用者中斷時 `Stop` 不會觸發，API 錯誤觸發的是 `StopFailure`），再做搜尋與連結，縮短驗收流程。

**影響檔案**
- `src-tauri/src/hooks.rs`、`src-tauri/src/bin/panex-cli.rs`、`src-tauri/src/links.rs`（新增）、`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`／`Cargo.lock`
- `src/main.ts`、`src/keys.ts`、`src/i18n.ts`、`src/style.css`、`index.html`、`schemas/panex.schema.json`、`package.json`
- `README.md`、`translations/README.zh-Hant.md`

**下一步**
- 使用者的 `~/.claude/settings.json` 在 10:19:42 被加進 `StopFailure`、`SessionEnd`（指向 `target/test-build/panex-cli.exe`），**原因沒查清楚**：可能是本 session 的測試實例，也可能是同時在跑的另一個 session。已經問使用者要保留還是還原，還在等回覆。
- 請使用者實機確認：Ctrl+點擊網址、檔案、`.exe`（應該只在檔案總管裡標出來）、選 VS Code 時是否跳到行號；在真的 Claude Code 裡按 Esc，側欄是否顯示「已中斷」。
- 還沒發版。剩下的建議：分割窗格、Codex 等其他 agent 的 adapter、量測側欄掃描光帶的耗用。

## 2026-10-22 — 發佈 v0.4.0（Git 面板、SSH、彩色 emoji）

**變更**
- 唯讀 Git 面板（`8319574`）以 fast-forward 合併進 main，刪掉本機的 `feat/git-panel`（這個分支沒推上 GitHub 過）。版號改成 0.4.0（`1458ed3`），推上 main 並推 tag `v0.4.0`。CI 兩個平台都建置成功，換上發布說明後發布。`releases/latest` 的 `.exe`、`.dmg` 兩個連結都回 302，指向 v0.4.0。
- 這一版包含 v0.3.1 之後的所有功能：Git 面板與側欄徽章、SSH 連線、終端機彩色 emoji、字型下拉選單、可改綁的換行鍵、側欄狀態行。新功能多，所以升 minor 版號。
- `operations.md` 的「發布 release」改成目前實際的流程（推 tag → CI 建草稿 → 發布）。

**為什麼**
- 使用者要求合併、推送並發新版。

**下一步**
- 使用者自己的機器還是舊版，要裝 v0.4.0 才用得到 Git 面板。

## 2026-10-22 — 唯讀 Git 面板＋側欄 git 徽章

**變更**
- 右側新增可收合的 Git 面板（`toggleGitPanel`，預設 `ctrl+shift+g`／mac `meta+shift+g`，上方列右側也有按鈕）：分支與 upstream 同步狀態、已暫存／變更（含未追蹤）檔案、最近 30 筆提交（未推送的有藍點）。點檔案或提交在終端機區上方開 diff 檢視，Esc 或切分頁就關；agent 送出 attention 時也會自動關掉，免得提示被蓋住。
- 側欄分支後面加 `↑n`（未推送）`↓n`（上游較新，上次 fetch 的結果）`●n`（未提交）。
- `git.rs` 新增 `git_status`／`git_diff`／`git_log`／`git_show`（async＋spawn_blocking、`--no-optional-locks`、輸出有上限）；`git_branch` 改用共用的 `repo_root`。
- 測試實例實測：各種檔案狀態（M／A／D／R／二進位／未追蹤檔與資料夾）、未推送標記、非 repo／空 repo／SSH 分頁的訊息、輸入指令後的 prompt 刷新、`panex-cli` 送 Stop 後的刷新、重開後面板狀態保留都正確。用 CDP Network 監看 IPC：面板開著閒置 20 秒是 0 次呼叫，每個 prompt 只有 1 次 `git_status`＋1 次 `git_branch`。

**為什麼**
- 使用者想在 panex 內像 VS Code 原始檔控制那樣看到哪些已改、未 commit、未 push，並能看 diff 與提交內容；同時明確要求資源占用最小。所以只做唯讀、不輪詢不 watch，靠既有事件（prompt、hook Stop、focus）觸發；操作類（stage／commit／push）與完整檔案樹經討論後不做。
- 這台 Git for Windows（`core.autocrlf=true`）的 `git diff`／`git status` 會對每個檔案往 stderr 印 CRLF 警告；只讀 stdout 不讀 stderr 會在檔案多時塞滿管道而卡住，所以 `git_capped` 另開執行緒讀 stderr，並加 `-c core.safecrlf=false`。

**影響檔案**
- `src-tauri/src/git.rs`、`src-tauri/src/lib.rs`
- `src/main.ts`、`src/keys.ts`、`src/i18n.ts`、`src/style.css`、`index.html`、`schemas/panex.schema.json`

**下一步**
- Claude Code 一輪做很久時，中途改的檔案要等 `Stop` 才反映；若使用者覺得不夠即時，可考慮加 `PostToolUse` hook（需要使用者重按「啟用」寫入 settings.json）。
- 使用者實際用一陣子後，確認大型 repo 每個 prompt 跑一次 `git status` 的負擔是否可接受。

## 2026-10-22 — 換行快捷鍵改成設定頁可調

**變更**
- 新增動作 `insertNewline`（分類「編輯」，預設 `ctrl+enter`），可在設定頁「快捷鍵」比照其他動作改綁，也能改成 `shift+enter`（原本的按鍵合法性檢查只收 Ctrl/Alt/Win 組合，特別放行 `shift+enter` 這個例外）。觸發時送出 `ESC CR`（和 Alt+Enter 送的序列一樣），Claude Code 等會收成插入換行而不是送出。
- 原本寫死在 `isWindows` 分支裡、只認 Ctrl+Enter 的 `attachCustomKeyEventHandler` 移除，改走 `runAction("insertNewline")`，所以 mac 使用者原則上也能自行綁一組（預設沒綁，`mac: null`）。
- 這段改動原本是獨立改的，過程中被同一台機器上另一個同時在跑的 session 的「SSH 連線」commit（`20420cb`）一起帶進去 push 了，commit 訊息沒提到這件事，這裡補記。
- 測試實例實測：預設 Ctrl+Enter 送 `ESC CR`、Enter 送 `\r`；在設定頁改綁成 Shift+Enter 後，Shift+Enter 送 `ESC CR`、Ctrl+Enter 變回送 `\r`，`panex.json` 正確寫入 `shortcuts.bindings.insertNewline`。「Claude Code 收到 `ESC CR` 真的換行」只在早先同一個改動下用真的 Claude Code 畫面確認過一次，這次改綁後沒有再用真的 Claude Code 複驗。

**為什麼**
- 使用者在 Windows Terminal 習慣用 Ctrl+Enter 換行，搬來 panex 後這個鍵變成直接送出；原本寫死處理掉之後，使用者接著問「這個也能在設定頁配置嗎」，所以比照其他快捷鍵的模式做成可調動作而不是寫死行為。

**影響檔案**
- `src/keys.ts`（新增 `insertNewline` 這個 `ActionDef`）
- `src/main.ts`（移除 `attachCustomKeyEventHandler` 分支、`runAction` 加 case、按鍵合法性檢查放行 `shift+enter`）
- `src/i18n.ts`、`schemas/panex.schema.json`

**下一步**
- 找機會用真的 Claude Code（不是記位元組的小程式）確認改綁後的按鍵一樣會換行，而不是只驗證送出的位元組對。

## 2026-10-22 — SSH 連線

**變更**
- ⌄ 選單最下面新增「SSH 連線…」，也可以綁快捷鍵（`newSsh`，預設沒有綁）。點了會開對話框，主機清單來自 `~/.ssh/config` 的 `Host`，會跟著 `Include` 讀，略過萬用字元和行尾註解；也可以手打 `帳號@主機:埠號`。每個連線開一個新工作區。
- 分頁裡直接跑系統的 `ssh`（`src-tauri/src/ssh.rs`），分頁的 shell 設為 `"ssh"`，`session.json` 的分頁多一個可省略的 `ssh` 欄位，所以舊檔不必轉換。主機字串會變成 ssh 的參數，前後端都會檢查格式：不能用 `-` 開頭，只允許主機、帳號、埠號會用到的字元；另外在主機前面加 `--`。
- SSH 分頁不記錄 cwd（遠端路徑對本機沒有意義，免得新分頁或 git 分支誤用）。斷線時顯示「連線已中斷，按 Enter 重新連線」。
- 測試實例實測：主機清單正確，錯誤格式會被擋，實際連上遠端主機、全螢幕 `top` 顯示正常，關掉再重開會自動重連，連不上的主機會顯示中斷提示。

**為什麼**
- 使用者要 SSH 功能。改用系統的 ssh、不內建 SSH 函式庫：金鑰、config、known_hosts、agent 都能照常沿用，panex 不碰密碼，沒在用時也不佔資源。

**影響檔案**
- `src-tauri/src/ssh.rs`（新增）、`pty.rs`、`session.rs`、`lib.rs`
- `src/main.ts`、`src/keys.ts`、`src/i18n.ts`、`src/style.css`、`index.html`、`schemas/panex.schema.json`

**下一步**
- 已 commit。
- 遠端 cwd 與 Claude Code 通知目前不支援，要做得另外設計。

## 2026-10-22 — 終端機彩色 emoji＋字型改下拉選單

**變更**
- 新增 `@font-face "panex emoji"`（`local()` Segoe UI Emoji／Apple Color Emoji／Noto Color Emoji）。`unicode-range` 只包含預設就是 emoji 的字元，另外加上 ⚠。改完後 ⚠ ✨ 會顯示成彩色，⏺ ✳ ⏸ ✔ 仍是單色、照樣跟著前景色變色。xterm 開啟 `rescaleOverlappingGlyphs`；啟動時先用 `document.fonts.load` 載入 emoji 字型，再呼叫 `clearTextureAtlas`。
- 交給 xterm 的字型字串改由 `termFontFamily()` 組成：最前面固定是 emoji 字型，接著是使用者選的字型，再補上中文備援字型和 `monospace`。
- 設定頁的字型欄位從手打 CSS 字串改成下拉選單，選項有「預設」、已安裝的等寬字型、「自訂…」，選「自訂…」時才顯示原本的文字框。舊的 `fontFamily` 值照樣能讀，不需要遷移。
- Rust 新增 `fonts::fonts_list`，用 `fontdb` 列出系統裡的等寬字型。只在第一次打開設定頁時掃描一次，閒置時沒有負擔。
- 測試實例實測：彩色 emoji、字型清單（14 個）、挑選字型、自訂、改回預設都能正確寫回 `panex.json`。測試中發現「自訂」選項的值原本用 `\u0000`，已修正。

**為什麼**
- 使用者 statusline 的 ⚠ 在 panex 裡是單色線條，在 Windows Terminal 裡是彩色 emoji，使用者要彩色版。原因是預設字型都沒有 ⚠，WebView2 自動挑了 Segoe UI Symbol 來畫。
- 字型原本要手打 CSS 字串，容易打錯。

**影響檔案**
- `src/main.ts`（`termFontFamily`、`fillFontPicker`、`FONT_CUSTOM`、`emojiFontReq`）、`src/style.css`、`index.html`、`src/i18n.ts`、`schemas/panex.schema.json`
- `src-tauri/src/fonts.rs`（新增）、`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`／`Cargo.lock`（`fontdb` 0.23）

**下一步**
- 尚未 commit。請使用者在自己的 panex 上確認 Claude Code 畫面：⚠ 是否為彩色、狀態圓點的顏色有沒有受影響。

## 2026-10-22 — 側邊欄狀態顯示改版（執行中／需回應／完成）

**變更**
- 原本三種狀態都只靠整列淡底色區分（執行中底色太淡，選中時又被 active 底色蓋掉，幾乎看不出來）。改成每列有明確的狀態列：執行中＝轉圈圖示＋「執行中…」＋右側即時計時（每秒更新）；需要回應＝藍點＋通知內容，仍保留淡藍底讓它跟單純在跑的列分開；完成＝綠勾＋這一輪花了多久。執行中另外在卡片底部加一道左右掃動的光帶。
- 計時：`Tab` 新增 `runStart`（本輪開始時間）/`runMs`（上一輪耗時），從送出提示到完成都算，中途等待權限核准不會被歸零。計時器只在畫面上有「執行中」列時才跑 `setInterval`，沒有就自己清掉，不常駐背景。
- 系統開啟「減少動態效果」時，轉圈與掃描光帶都會停住。

**為什麼**
- 使用者反映側邊欄狀態「不太清楚與明白」，希望比照 cmux 的清楚度但不要原樣抄，要有 panex 自己的特色（計時是 cmux 沒有的）。

**影響檔案**
- `src/main.ts`（`stateLine`、`fmtDuration`、`startElapsedTimer`、`wsStatus`、`notify`、`Tab` 型別）
- `src/style.css`（`.t-state`、`.s-ico`、`.t-time`、`.t-scan` 相關樣式）
- `src/i18n.ts`（新增「執行中…」「已執行時間」「這一輪花的時間」）

**下一步**
- 尚未用測試實例實機截圖確認三種狀態的視覺效果與光帶動畫速度，使用者看過後可能要再微調。

## 2026-10-21 — 發佈 v0.3.1（自動接回 Claude Code）

**變更**
- 提交 `03ba09c`（自動接回、拿掉提示列／側欄 ↻）與 `0f657b2`（版本號 0.3.1），推上 main 並推 tag `v0.3.1`，由 CI 同時建 Windows `.exe` 與 macOS `.dmg` 到草稿 release；補上發佈說明後手動發布，兩個下載連結實測回 302 → 200。
- 設定頁左下角顯示版本號（`7eef377`）一併進入此版。
- 使用者機器：先解除安裝舊版（保留資料）再裝本機建置的新版。

**為什麼**
- 使用者要求把「重開後自動接回」發成新版。

**下一步**
- 提交前務必先 `git checkout src-tauri/Cargo.toml`：在 Windows 跑 `cargo tauri build` 時，tauri CLI 會依 Windows 設定把 `tauri` 依賴的 `macos-private-api` feature 自動刪掉（`tauri.macos.conf.json` 才有 `macOSPrivateApi`），這個改動不能提交，否則 macOS 版建置會壞。
- 使用者的 `~/.claude/settings.json` hooks 目前指向測試實例的路徑（`target/test-build/panex-cli.exe`），不是正式安裝的路徑；要使用者開新版 panex 按一次「啟用」改回來（規定只能由使用者按鈕寫入，我沒有動）。
- 發版流程已改成「推 `v*` tag → CI 建兩平台 → 補說明並發布草稿」，`operations.md` 的「發布 release」段還是舊的手動流程，待更新。

## 2026-10-20 — macOS 版：可編譯打包、平台預設字型／快捷鍵、視窗大小設定

**變更**
- 可在 Mac（Apple Silicon）編譯打包：`notify` 開 `macos_kqueue`（原本 `default-features = false` 把 macOS 後端也關了，編不過）；新增 `tauri.macos.conf.json`（`app`/`dmg`、`macOSPrivateApi` 讓透明視窗生效、把 `panex-cli` 放進 `Contents/MacOS/`）；Cargo 以 macOS 專屬依賴開 `macos-private-api`。
- cwd 回報：zsh 用 ZDOTDIR 包一層（`<app data>/shell/zsh/`，各檔先 source 使用者原檔，`.zshrc` 還原 ZDOTDIR 並掛 precmd 送 OSC 9;9）；bash 用 `PROMPT_COMMAND`。macOS `/etc/zshrc` 會在 ZDOTDIR 還是我們的時候把 HISTFILE 指過來，`.zshrc` 先改回去（測試時踩到，歷史檔曾寫錯位置）。
- 平台預設：字型（Windows 字型在 Mac 不存在時 xterm 量錯字寬、字距被拉開）；快捷鍵 `ActionDef.mac`，⌘ 取代 Ctrl（⌘T/⌘W/⌘N/⌘1–9/⌥1–9、工作區 ⌘↓/⌘↑、分頁 ⌘→/⌘←（使用者指定））；Mac 上 ⌘V 走原生 Edit 選單（WKWebView 讀剪貼簿會跳權限提示）、Ctrl+C/V 一律給終端機；顯示改 ⌃⌥⇧⌘；Mac 版說明文字用 i18n 的 `MAC` 對照表。
- macOS 自訂選單：拿掉 Window › Close（會搶 ⌘W），Quit 改成關視窗以觸發存 scrollback。
- 視窗大小：預設 1400×820（使用者指定），設定頁「外觀」可改寬高（立刻 `setSize`，需 `core:window:allow-set-size`）或「用目前大小」；存 `app.windowWidth/Height`，啟動時由 `config::apply_window_size` 套用並縮到螢幕內，window-state 不再還原大小（只還原位置）。
- 開啟時若 hooks 未啟用就跳對話框（啟用／以後再說／不用了），「不用了」存 `agent.askToEnableHooks: false`。焦點刻意放在對話框本身而不是「啟用」：測試時連兩次在開啟後幾秒被寫入，判斷是使用者打給終端機的 Enter 觸發了已取得焦點的按鈕；改完後 Enter 不會寫入。測試實例用 `HOME` 指向 scratch，沒碰使用者的 `~/.claude/settings.json`。
- 已用測試實例（scratch `XDG_CONFIG_HOME`、`PANEX_PIPE_NAME=/tmp/panex-t.sock`）實測：字型、cwd、通知、工作階段還原、⌘, ⌘T ⌘W、視窗大小即時套用。

**為什麼**
- 使用者想在 Mac 上裝；並要求字型、快捷鍵依平台不同，視窗預設大一點且可調。

**下一步**
- 已 commit（6a4cc56、CI 修正 0091714），tag v0.3.0；新增 `.github/workflows/release.yml`：推 tag 就在 windows-latest／macos-latest 建置並附到草稿 release，發布草稿仍手動。v0.3.0 已由 CI 建置兩平台並發布（Windows 由 CI 編譯通過，執行面仍未在 Windows 實測）。推 workflow 檔需要 gh 權杖有 `workflow` scope。本機打包 macOS 要用系統的 `/usr/bin/xattr`（pyenv 的 xattr 不支援 `-r`，ad-hoc 簽章步驟會失敗）。
- Windows 端未實測：需在 Windows 建置確認 tauri-build 接受 macOS 專屬的 tauri feature、以及「不再記住視窗大小」這個行為改變使用者是否接受。
- 未做：Mac 版 GitHub release（未簽章，使用者第一次開要右鍵「打開」）、README 的 Mac 說明、fish shell 的 cwd 回報。測試實例的 session 寫在正式的 `~/Library/Application Support/dev.panex.terminal/`（這台 Mac 原本沒裝 panex）。

## 2026-10-21 — 恢復 Claude Code 改成重開後自動接回（拿掉按鈕）

**變更**
- 照 cmux 的做法：重開 panex 後，關閉時還在跑 Claude Code 的分頁，在第一次啟動 shell 時自動送 `claude --resume <id>`。`agentSession` 只在 Claude 執行期間保留，shell 回到提示符（或 shell 結束）就清掉，所以已正常退出的分頁不會被接回。
- 移除終端機下方的提示列（`#resume-bar`）、「恢復／略過」按鈕與相關樣式、字串；設定開關保留並改成「重開後接回 Claude Code」。README 兩版、`overview.md`、`operations.md` 同步。
- 用測試實例＋假的 `claude.cmd` 驗證：關閉時還在跑的兩個分頁各自在被打開時自動接回；跑完的分頁記錄被清掉、重開後不再接回；開關關掉就不自動接回；DOM 裡已沒有提示列。測試資料已清除。

**為什麼**
- 使用者要求「照 cmux 的做法，可以回復的重開後自己進到 claude code」；手動按鈕對每天更新 Claude Code 的流程多一步。

**下一步**
- 尚未 commit、未重新打包安裝；使用者的 panex 還是帶側欄 ↻ 與提示列的版本。
- 沒被打開的分頁不會自動接回（沿用 lazy spawn 以省資源）；若使用者希望一開 panex 全部接回，要另外決定（會一次啟動多個 Claude Code）。

## 2026-10-21 — 移除側欄的恢復標記 ↻（保留終端機下方的提示列）

**變更**
- 移除 `renderSidebar` 的 `↻` 標記、側欄點擊處理、`.t-resume` 樣式與相關字串；設定頁與 schema 的說明文字改成只提「終端機下方」。恢復提示列、設定開關、`agentSession` 記錄不變。README 兩版、`overview.md` 同步。

**為什麼**
- 使用者回報側欄的恢復只能恢復工作區的「第一個」可恢復分頁，無法一次恢復整個工作區，並要求整個移除。
- 曾試著改成恢復全部分頁：發現 ConPTY 會把同一個提示符回報兩次，背景分頁恢復後被誤判回「可恢復」；用去重修好，但使用者選擇直接移除，該改動未提交。

**下一步**
- 尚未 commit、未重新打包安裝；使用者的 panex 還是帶側欄 ↻ 的版本。

## 2026-10-20 — 一鍵恢復 Claude Code session（提示列＋側欄 ↻）

**變更**
- 事後加開關 `agent.resumeSession`（預設開；設定頁「終端機」、panex.json、schema 同步，`f1a27de`）。關掉只是不顯示，不刪已記的 id。用測試實例驗過開／關都即時生效並寫回設定檔。
- `panex-cli` 多帶 hook 的 `session_id`；前端存成每個分頁的 `agentSession`（`session.json` 新增選填欄位 `agentSession`），Claude 結束（下個 shell prompt）後在終端機下方顯示「恢復／略過」提示列，側欄工作區名稱旁顯示 `↻`。按恢復就把 `claude --resume <id>` 送進分頁。機制已歸檔在 `overview.md`。
- 用測試實例＋CDP＋`panex-cli` 模擬 hook 驗證：hook 進來時提示列隱藏、回到 prompt 後出現、按恢復真的啟動 claude、重開 panex 後仍顯示、略過會清掉 session 檔裡的 id。測試資料已清除。README 兩版同步。

**為什麼**
- 使用者每天更新 Claude Code 都要退出再重進；原本想的「當機後接回」場景太少見，改成涵蓋每日更新。

**下一步**
- 已 commit（0f12e57）、發佈 v0.2.0 release、使用者的 panex 已裝新版。注意：功能從安裝後的第一個 hook 才開始記錄，安裝前就在跑的 Claude Code 沒有 session id 可恢復（使用者以為壞掉，其實是沒資料）；可考慮後備方案讀 `~/.claude/projects/` 最新 session，但會依賴 Claude Code 內部檔案格式。
- 已知取捨：刻意結束的 session 也會一直顯示提示列，要按「略過」才消失；`--resume` 只在同一個專案目錄下找得到 session，tab 的 cwd 若已改掉會找不到。
- 「整批更新並恢復」尚未做，等使用者確認真的想要這個流程。

## 2026-10-20 — 一鍵 worktree、修復拖檔進終端機（排序改 pointer 事件）

**變更**
- 一鍵 worktree：`git.rs` 新增 `git_worktree_add`／`git_branches`，側欄右鍵與 `newWorktree` 動作開對話框（分支欄與起點欄皆為本機分支下拉）；建在 `<repo>-worktrees/`，複製 `worktree.copyFiles`、自動跑 `worktree.setupCommand`。schema 與 i18n 同步。機制已歸檔在 `overview.md`。
- 拖檔進終端機失效：上一輪為了讓排序可用把 `dragDropEnabled` 設成 false，同時殺掉了原生檔案拖放。改回預設 true，列表排序從 HTML5 拖曳改成 pointer 事件（`wireDrag`），拖入檔案由 `onDragDropEvent` 把路徑 paste 進目前分頁。雷已更正在 `boundaries.md`。
- 用測試實例驗證：建立（新分支／既有分支／被佔用報錯／非 git 目錄）、`.env` 複製與 setup 指令、縱向與橫向排序、點擊仍可切換。

**為什麼**
- 使用者要求 worktree 並要能帶 .env；回報 session 無法拖檔案與圖片進終端機（含 Claude Code）。

**下一步**
- 使用者的 panex 還是舊版：安裝會關掉他執行中的 panex（裡面有進行中的 Claude Code 分頁），要等他同意再裝。
- 真正從檔案總管拖檔：有一次真實 OLE 拖放成功把路徑貼進終端機，之後的自動化重試誤打到使用者桌面而中止（雷已記進 `operations.md`）。請使用者安裝後實測拖檔案與圖片檔。
- 新增 `[profile.test-build]`（不 LTO）加速驗證建置；錯誤訊息濾掉 git 的 `Preparing worktree` 進度行。

## 2026-10-20 — 還原後大片空白：還原時壓縮連續空行

**變更**
- `src/main.ts` 新增 `squeezeBlankRuns`，還原快照寫回 xterm 前把連續 3 行以上的空行壓成 2 行。機制與原因已歸檔在 `overview.md`「還原機制」。
- 已重新打包並靜默安裝；以使用者現有快照預演，兩個 Claude Code 分頁從 67 行縮到 20 行，其他分頁不變。

**為什麼**
- 使用者回報重開後有些 session 上方一大片空白：是 Claude Code 全螢幕介面墊在輸入框上方的空行被存進快照。

**下一步**
- 請使用者重開後確認空白消失；若 TUI 的空行帶有 SGR 底色（非純空白）就不會被壓到，到時再放寬規則。

## 2026-10-20 — 側欄顯示 git 分支、英文介面（含語言設定）

**變更**
- 側欄每個工作區在 cwd 下方多一行 `⎇ <分支>`：新增 `src-tauri/src/git.rs`（`git_branch` 直接讀 `.git/HEAD`，支援 worktree、detached 顯示 7 碼 hash），前端 `refreshBranch` 在每次 cwd 回報時重查（同分頁 1 秒節流），非 git 目錄整行不顯示。
- 英文介面：新增 `src/i18n.ts`（繁中原文當 key 的字典 + `translateDom`），`index.html` 以 `data-i18n*` 標記，`main.ts` 所有字串改走 `tr()`；設定「外觀」頁最上方新增「語言」（自動／English／繁體中文），存在 `app.language`，schema 同步。Rust 端的錯誤訊息（hooks.rs、config.rs）改成英文。README 兩版同步（移出投票清單、補功能條目）。
- 驗證用獨立測試實例 + CDP：英文介面各頁、語言來回切換、`git checkout` 後下個 prompt 分支更新、detached、離開 repo 隱藏，都正常；測試資料已清除。

**為什麼**
- 使用者要求把這兩項從投票清單提前做掉（英文介面為開源推廣所需，分支顯示對多 agent 並行最有用）。

**下一步**
- 已 commit（0f12e57）、發佈 v0.2.0 release、使用者的 panex 已裝新版。注意：功能從安裝後的第一個 hook 才開始記錄，安裝前就在跑的 Claude Code 沒有 session id 可恢復（使用者以為壞掉，其實是沒資料）；可考慮後備方案讀 `~/.claude/projects/` 最新 session，但會依賴 Claude Code 內部檔案格式。
- 沒做的：port 偵測、一鍵 worktree、搜尋捲動歷史、分割窗格。
- 從零編譯會遇到 rustc 崩潰，解法記在 `operations.md`。

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
