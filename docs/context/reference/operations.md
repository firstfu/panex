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
- 自動化：用 CDP（port 9556）的 `Input.dispatchKeyEvent` 送真實按鍵、`Runtime.evaluate` 讀 DOM；只連 URL 是 `tauri.localhost` 的頁面。從 Bash 送通知時 `\\.\pipe\...` 的反斜線會被吃掉，改用 PowerShell 跑 `panex-cli notify`。
- 測 `claude --resume` 這類流程時，在測試實例啟動前把一個假的 `claude.cmd`（印一行字再 `ping -n 40 127.0.0.1`）放進 `PATH` 最前面：真的 `claude` 會對假 session id 報 `No conversation found`、跳信任資料夾詢問，還會用真的 hook 回報新 session id 干擾結果。
- 截圖：`PrintWindow` 擷取該程序的視窗；CDP 的 `Page.captureScreenshot` 只擷取網頁內容。
- 機器上同時有使用者正在用的 panex，視窗標題也是 `panex`；操作視窗時一律用測試實例的行程 ID，不要用名稱。
- **不要對桌面注入真實滑鼠輸入**（`SetCursorPos`／`mouse_event` 做 OLE 拖放）：自製的拖曳來源視窗沒有浮到最上層，按下、拖曳、放開全落在使用者前景的 Claude Code 視窗上（2026-10-20 發生，只造成文字被反白選取）。檔案拖入只靠 CDP 對 `tauri://drag-drop` 發 `plugin:event|emit_to`（`target: {kind:'Webview', label:'main'}`）驗證處理邏輯，原生拖放請使用者實測。
- CDP 的 `Input.dispatchKeyEvent` 不帶字元，表單的 Enter 不會送出；要送出就直接 `.click()` 送出鈕。拖曳排序可用 `Input.dispatchMouseEvent` 驗（pointer 事件）。

## 重拍 README 截圖

用上面的測試實例、全新空資料夾開一個示範版面（例如 `D:\demo\panex`、`api-server`、`docs` 三個工作區，一個送 permission_prompt 通知、一個送 Stop），截圖存到 `assets/`。截圖裡不能出現使用者真實的分頁名稱或路徑；拍完刪掉示範資料夾與測試實例資料。

## 發布 release

1. 改版本號（`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`），README／繁中版的安裝檔檔名一起改。
2. 用要 tag 的那份原始碼重新 `cargo tauri build`（安裝檔要跟推上去的程式碼一致）。
3. commit、`git push origin main`。
4. `gh release create v<版本> <安裝檔路徑> --repo firstfu/panex --title "panex <版本>" --notes-file <notes.md> --target main`。
5. 驗證：`curl -sI https://github.com/firstfu/panex/releases/latest/download/<安裝檔名>` 回 302。
