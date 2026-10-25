# 維運：建置、測試實例、發布

> **何時讀**：要測試 panex、重拍 README 截圖、或發新版 release 之前。
>
> 來源索引：根 `CLAUDE.md` 文件索引表。

## 建置

- 開發：`cargo tauri dev`；正式：`cargo tauri build`，安裝檔在 `src-tauri/target/release/bundle/nsis/panex_<版本>_x64-setup.exe`。NSIS hook（`src-tauri/installer-hooks.nsh`）會把 `panex-cli.exe` 一起裝進去。
- 從零編譯時 rustc 可能在 `windows`／`tokio` crate 崩潰（`STATUS_STACK_BUFFER_OVERRUN`），設 `RUST_MIN_STACK=134217728` 後重跑即過；`CARGO_TARGET_DIR` 換新目錄就是從零編譯，會碰到這個。
- 使用者的 panex 開著時 `target/release/panex.exe` 被鎖住，可設 `CARGO_TARGET_DIR` 到別處建置。
- 測試實例還開著時再建置 `test-build`，會因 `panex.exe` 被鎖住而報 `存取被拒 (os error 5)`，但背景指令的 exit code 仍是 0，很容易誤以為建好了、拿舊版在測。建置前先關掉測試實例，建完用 `ls -la --time-style=full-iso` 確認 exe 時間戳。
- release 設了 `lto = true`＋`codegen-units = 1`，每次建置要好幾分鐘。**驗證功能用 `[profile.test-build]`**（不 LTO、平行 codegen、增量）：`cargo tauri build --no-bundle --config '…' -- --profile test-build`，產物在 `target\test-build\panex.exe`；發布安裝檔仍用 release。
- **`cargo tauri build` 會改寫 `src-tauri/Cargo.toml`**：Windows 上 `tauri.conf.json` 沒開 macOS private API，CLI 會把 `[dependencies]` 的 `tauri = { …, features = ["macos-private-api"] }` 自動改成 `features = []`。建置完用 `git diff src-tauri/Cargo.toml` 檢查並改回，不要連同功能一起 commit。反過來，直接 `cargo check` 會因為 feature 和設定檔對不上而失敗（`The tauri dependency features … does not match the allowlist`），Rust 端建置走 `cargo tauri build`；單元測試的繞法見下方「單元測試」。
- **PowerShell 5.1 會吃掉傳給原生程式的 `--`**：`cargo tauri build … -- --profile test-build` 在 PowerShell 裡跑，`--profile` 會被當成 tauri-cli 自己的參數，結果 panic 在 `Option::unwrap()`（2026-10-22 踩過）。這條指令一律用 Bash 跑。
- **另一個程序正在 `rustup update` 時**，工具鏈會裝到一半（`rustc.exe` 暫時不存在），`cargo` 報 `binary … is not applicable to the toolchain`、tauri-cli 在讀 `rustc -vV` 時 panic。等它跑完再建，不要去砍那個程序。

## 單元測試

- 前端：`npm test`（Node 內建 `node --test`，跑 `tests/*.test.ts`，靠 Node 的型別剝除直接載入 TS，沒有測試框架依賴）。被測的函式必須放在不 import DOM／Tauri 的模組（例如 `src/sanitize.ts`、`src/settings.ts`）；其他前端模組一載入就會查 DOM、掛事件，不能拿來測。`tests/` 不在 `tsconfig` 的 `include` 裡，編輯器會對 `node:test` 標紅，不影響執行。
- Rust：在 `src-tauri/` 執行 `RUST_MIN_STACK=134217728 TAURI_CONFIG='{"app":{"macOSPrivateApi":true}}' cargo test`。`TAURI_CONFIG` 讓 build script 看到 private API 已開、不再拒絕 `macos-private-api` feature；這只影響這次編譯，不會改到任何檔案。從零編譯偶爾還是會 `STATUS_STACK_BUFFER_OVERRUN`，重跑即可。
- 要讀寫檔案的邏輯（遷移、`config_set`）做成吃 `&Path` 的 `_at` 版本來測，不要在測試裡改 `XDG_CONFIG_HOME` 這類全域環境變數（測試是平行跑的）。

## 獨立測試實例（不碰使用者正在用的 panex）

```powershell
# 建置：換 identifier，app data、WebView2 資料、single-instance 都會分開
cargo tauri build --no-bundle --config '{\"identifier\":\"dev.panex.terminal.test\",\"productName\":\"panex-test\"}'
# 啟動：設定檔、通知管道、除錯埠都換掉
$env:XDG_CONFIG_HOME = '<scratch>\testcfg'          # config.rs 會讀 <這裡>\panex\panex.json
$env:PANEX_PIPE_NAME = '\\.\pipe\panex-test'          # notify.rs 與注入給分頁的 PANEX_PIPE 都用它
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9556'
Start-Process <target>\release\panex.exe
```

- app data 在 `%APPDATA%\dev.panex.terminal.test\`、WebView2 資料在 `%LOCALAPPDATA%\dev.panex.terminal.test\`，測完兩個都刪。
- 要測遷移就把使用者的 `session.json`、`scrollback\`、`panex.json` **複製**進去，不要直接指向原檔。
- 要測多工作區／多分頁的固定情境（例如每個工作區指到一個準備好狀態的測試資料夾），直接寫一份合成的 `session.json`（`{active, workspaces:[{id,title,tabs:[{id,shell,cwd}],active}]}`）再啟動，比在 UI 手動建快。**用 Python `json.dumps` 寫，不要用 PowerShell `ConvertTo-Json | Out-File -Encoding utf8`**：2026-10-22 這樣寫出的檔案 panex 不認，默默改開一個預設工作區（沒細查是 BOM 還是單一元素陣列被攤平成物件）。
- 自動化：用 CDP（port 9556）的 `Input.dispatchKeyEvent` 送真實按鍵、`Runtime.evaluate` 讀 DOM；只連 URL 是 `tauri.localhost` 的頁面。從 Bash 送通知時 `\\.\pipe\...` 的反斜線會被吃掉，改用 PowerShell 跑 `panex-cli notify`。Python `websocket-client` 連 CDP 預設帶 Origin，WebView2 會回 403（`Rejected an incoming WebSocket connection`），`create_connection(..., suppress_origin=True)` 即可。
- 驗證「閒置零成本」：`window.__TAURI_INTERNALS__.invoke` 是不可寫屬性，monkey-patch 不會生效（計數永遠是 0，看起來像通過）。改用 CDP `Network.enable` 收 `Network.requestWillBeSent`，數 URL 含 `ipc.localhost` 的請求；每次 invoke 會有一筆 `POST` 加一筆 CORS 預檢 `OPTIONS`，只數 `POST`。用 `Win32_Process` 輪詢 git.exe 這類短命子程序太慢、抓不到，也不可靠。
- 測 `claude --resume` 這類流程時，在測試實例啟動前把一個假的 `claude.cmd`（印一行字再 `ping -n 40 127.0.0.1`）放進 `PATH` 最前面：真的 `claude` 會對假 session id 報 `No conversation found`、跳信任資料夾詢問，還會用真的 hook 回報新 session id 干擾結果。
- 截圖：`PrintWindow` 擷取該程序的視窗；CDP 的 `Page.captureScreenshot` 只擷取網頁內容。
- 機器上同時有使用者正在用的 panex，視窗標題也是 `panex`；操作視窗時一律用測試實例的行程 ID，不要用名稱。
- **不要對桌面注入真實滑鼠輸入**（`SetCursorPos`／`mouse_event` 做 OLE 拖放）：自製的拖曳來源視窗沒有浮到最上層，按下、拖曳、放開全落在使用者前景的 Claude Code 視窗上（2026-10-20 發生，只造成文字被反白選取）。檔案拖入只靠 CDP 對 `tauri://drag-drop` 發 `plugin:event|emit_to`（`target: {kind:'Webview', label:'main'}`）驗證處理邏輯，原生拖放請使用者實測。
- CDP 的 `Input.dispatchKeyEvent` 不帶字元，表單的 Enter 不會送出；要送出就直接 `.click()` 送出鈕。拖曳排序可用 `Input.dispatchMouseEvent` 驗（pointer 事件）。

## macOS 端對端測試（`--features e2e`）

Mac 的 WKWebView 沒有 WebDriver 也沒有遠端除錯埠，上面的 CDP 測法用不了；改用測試版專屬的 `panex-cli e2e '<js>'` 在真的 App 裡跑 JS。

```bash
npm run build
cd src-tauri && TAURI_CONFIG='{"identifier":"dev.panex.terminal.test","productName":"panex-test","app":{"macOSPrivateApi":true}}' \
  cargo build --profile test-build --features e2e,tauri/custom-protocol
cd .. && node tests/e2e/run.mjs [--keep]   # --keep 留下暫存資料夾供檢查
```

- 本機沒有 `cargo tauri`：直接 `cargo build`，加 `tauri/custom-protocol` 把 `dist/` 嵌進執行檔（不加會去連 dev server），`TAURI_CONFIG` 換成測試 identifier。
- 機制：`panex-cli e2e` 走既有控制通道（`PANEX_PIPE_NAME`）→ `src-tauri/src/e2e.rs` 用 `webview.eval` 執行 → 結果經 `ctl_reply` 傳回（共用 `control::ask_frontend`）。三道鎖：feature 預設關、要帶啟動時設的 `PANEX_E2E_TOKEN`、identifier 是 `dev.panex.terminal` 一律拒絕。
- 隔離：`run.mjs` 把 `HOME` 指到暫存資料夾，app data（含合成的 `session.json`）、`~/.claude`、shell rc 都落在那裡；剪貼簿改成在視窗裡攔 `navigator.clipboard.writeText` 記錄，不碰系統剪貼簿。小隊模式用假 `claude` 腳本（commit 後自己送 Stop 給 `panex-cli notify`）。
- 雷：
  - **CSP 擋 `new Function`／`eval`**：視窗內動態編譯 JS 會丟錯（WebKit 的 stack 還不帶訊息，只看到 `AsyncFunction@[native code]`）。原生的 `webview.eval` 不受 CSP 限制，所以 JS 本體直接嵌進注入的腳本。
  - **送進去的 JS 有語法錯誤 → 整段不執行，60 秒後才逾時**，不會回錯誤訊息。看到 `panex did not answer` 先查語法。
  - **WebKit 的 `new KeyboardEvent` 忽略 `keyCode`**，xterm 卻是讀它：用 `Object.defineProperty` 補上 `keyCode`／`which`。送文字用 textarea 的 `paste` 事件（`DataTransfer`），xterm 會照真的貼上轉給 shell。
  - **Unix socket 路徑上限約 104 字元**：`PANEX_PIPE_NAME` 放在太深的資料夾（例如 Claude Code 的 scratchpad）時 socket 建不起來，`panex-cli e2e` 只會一直逾時、沒有錯誤訊息。管道路徑用 `os.tmpdir()` 底下的短路徑。
  - **macOS 暫存資料夾在 `/var`，它是 `/private/var` 的連結**；shell 回報的 cwd 和 git 給的路徑都是 `/private/var/...`。比對路徑前先 `realpath`／`fs::canonicalize`（`git::tests` 與 `run.mjs` 都踩過）。

## 重拍 README 截圖

用上面的測試實例、全新空資料夾開一個示範版面（例如 `D:\demo\panex`、`api-server`、`docs` 三個工作區，一個送 permission_prompt 通知、一個送 Stop），截圖存到 `assets/`。截圖裡不能出現使用者真實的分頁名稱或路徑；拍完刪掉示範資料夾與測試實例資料。

### macOS 上重拍截圖與 demo 影片（2026-10-25）

用上面「macOS 端對端測試」的測試版，另寫一支腳本（不放進 repo）：`HOME` 指到暫存資料夾、`.zshrc` 設中性提示字元（`PROMPT='%F{green}%1~%f %# '`，否則提示字元會露出帳號與主機名）、`panex.json` 設 `app.language: "en"`、`session.json` 合成三個工作區，示範 repo 放 `/Users/Shared/demo/…`（側欄顯示完整 cwd，放暫存資料夾會顯示 `/private/tmp/…`）。

- 場景用假 agent 腳本印 Claude Code 風格的輸出，通知用真的 `panex-cli notify`。**目前正在看的分頁不會亮燈**，所以通知要等切到別的工作區之後才送（腳本等一個檔案出現再送，錄影時再 `touch`）。
- `__e2e` 的文字輸入要找「看得見的」textarea：`[...document.querySelectorAll(".xterm-helper-textarea")].find(t => t.offsetParent)`；用 `querySelector` 會拿到第一個（隱藏的）分頁。
- 視窗用行程 ID 在 `CGWindowListCopyWindowInfo` 裡挑最大的（使用者自己的 panex 同名，還有一堆 500×500 與 30 px 高的雜窗）；`screencapture -x -o -l<id>` 截圖，`screencapture -v -x -l<id> out.mov` 錄影。
- 錄影的左上角會被系統的紫色錄影指示蓋住紅綠燈，視窗外還有陰影：用 `ffmpeg` 裁掉標題列與陰影，只留 App 內容（1× 螢幕，視窗 1518×860，影片含陰影共 1630×972，裁成 `crop=1514:822:58:72`）。mp4 用 H.264 `-crf 27`，GIF 用 `palettegen`／`paletteuse`、10 fps、960 寬（約 0.5 MB）。
- 拍攝用的 DOM 微調（例如藏掉側欄底部「Claude Code 通知：未啟用」那列 `#hooks-row`）只在測試實例裡做。
- 設定頁的「一般」頁會顯示啟動它的終端機的權限狀態，不要拿來當截圖。
- 腳本重新啟動時若清掉暫存資料夾，裡面的 `.mov`／`.mp4` 也跟著沒了：轉檔後立刻複製到 `assets/`。

## 發布 release

安裝檔由 CI 建（`.github/workflows/release.yml`），本機不必建置：

0. 先跑上方「單元測試」的兩組測試，全過才發版（CI 不跑測試）。另外 repo 要有四個 secrets，缺任何一個 CI 在檢查步驟就失敗：`TAURI_SIGNING_PRIVATE_KEY`／`_PASSWORD`（更新包簽章）、`MACOS_CERT_P12`（p12 的 base64）／`MACOS_CERT_PASSWORD`（macOS 簽章憑證「panex Release Signing」）。來源檔在 `~/.config/panex-signing/`，機制與風險見 `modules/updates.md`。
1. 改版本號，六個檔：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（`name = "panex"` 那段）、`package.json`，以及 README 與繁中版裡的安裝檔檔名（`.exe`、`.dmg` 各處），還有 `website/index.html`、`website/zh/index.html` 安裝區的檔名（見 `modules/website.md`）。提交前確認 `Cargo.toml` 的 `macos-private-api` 還在（見上方「建置」）。
2. commit、`git push origin main`，再 `git tag v<版本>` 並 `git push origin v<版本>`。
3. tag 觸發 CI：先建草稿 release，再由 Windows、macOS 兩個 job 各自建安裝檔與更新包（`.sig`、`panex.app.tar.gz`）並上傳，最後 `manifest` job 產生 `latest.json`。macOS 在 build 時用 `--config` 把 `signingIdentity` 覆寫成憑證（本機建置仍是 ad-hoc `-`）。草稿這時的說明只是 `Notes pending.`。兩個平台平行跑，LTO＋沒有快取，約 8–15 分鐘；`gh run watch <run id> --exit-status` 可以等它結束。
4. 兩個安裝檔都上傳後才發布：`gh release edit v<版本> --repo firstfu/panex --title "panex <版本>" --notes-file <notes.md> --draft=false --latest`。說明的格式照前一版（New／Changed／Install，英文）。
5. 驗證：`curl -sI https://github.com/firstfu/panex/releases/latest/download/<檔名>`，兩個安裝檔與 `latest.json` 都要回 302、`Location` 指向新版。只看轉址就好，不要跟著轉址把檔案下載下來，免得算進 GitHub 的下載次數。
