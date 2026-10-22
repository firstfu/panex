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

## 重拍 README 截圖

用上面的測試實例、全新空資料夾開一個示範版面（例如 `D:\demo\panex`、`api-server`、`docs` 三個工作區，一個送 permission_prompt 通知、一個送 Stop），截圖存到 `assets/`。截圖裡不能出現使用者真實的分頁名稱或路徑；拍完刪掉示範資料夾與測試實例資料。

## 發布 release

安裝檔由 CI 建（`.github/workflows/release.yml`），本機不必建置：

0. 先跑上方「單元測試」的兩組測試，全過才發版（CI 不跑測試）。
1. 改版本號，六個檔：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（`name = "panex"` 那段）、`package.json`，以及 README 與繁中版裡的安裝檔檔名（`.exe`、`.dmg` 各處）。提交前確認 `Cargo.toml` 的 `macos-private-api` 還在（見上方「建置」）。
2. commit、`git push origin main`，再 `git tag v<版本>` 並 `git push origin v<版本>`。
3. tag 觸發 CI：先建草稿 release，再由 Windows、macOS 兩個 job 各自建安裝檔並上傳。草稿這時的說明只是 `Notes pending.`。兩個平台平行跑，LTO＋沒有快取，約 8–15 分鐘；`gh run watch <run id> --exit-status` 可以等它結束。
4. 兩個安裝檔都上傳後才發布：`gh release edit v<版本> --repo firstfu/panex --title "panex <版本>" --notes-file <notes.md> --draft=false --latest`。說明的格式照前一版（New／Changed／Install，英文）。
5. 驗證：`curl -sI https://github.com/firstfu/panex/releases/latest/download/<安裝檔名>`，兩個檔名都要回 302、`Location` 指向新版。只看轉址就好，不要跟著轉址把檔案下載下來，免得算進 GitHub 的下載次數。
