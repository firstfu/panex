# 維運：建置、測試實例、發布

> **何時讀**：要測試 panex、重拍 README 截圖、或發新版 release 之前。
>
> 來源索引：根 `CLAUDE.md` 文件索引表。

## 建置

- 開發：`cargo tauri dev`；正式：`cargo tauri build`，安裝檔在 `src-tauri/target/release/bundle/nsis/panex_<版本>_x64-setup.exe`。NSIS hook（`src-tauri/installer-hooks.nsh`）會把 `panex-cli.exe` 一起裝進去。
- 使用者的 panex 開著時 `target/release/panex.exe` 被鎖住，可設 `CARGO_TARGET_DIR` 到別處建置。

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
- 截圖：`PrintWindow` 擷取該程序的視窗。

## 重拍 README 截圖

用上面的測試實例、全新空資料夾開一個示範版面（例如 `D:\demo\panex`、`api-server`、`docs` 三個工作區，一個送 permission_prompt 通知、一個送 Stop），截圖存到 `assets/`。截圖裡不能出現使用者真實的分頁名稱或路徑；拍完刪掉示範資料夾與測試實例資料。

## 發布 release

1. 改版本號（`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`），README／繁中版的安裝檔檔名一起改。
2. 用要 tag 的那份原始碼重新 `cargo tauri build`（安裝檔要跟推上去的程式碼一致）。
3. commit、`git push origin main`。
4. `gh release create v<版本> <安裝檔路徑> --repo firstfu/panex --title "panex <版本>" --notes-file <notes.md> --target main`。
5. 驗證：`curl -sI https://github.com/firstfu/panex/releases/latest/download/<安裝檔名>` 回 302。
