# App 內更新（tauri-plugin-updater）

> **何時讀**：動 `src-tauri/src/updater.rs`、`src/update.ts`、`tauri.conf.json` 的 `plugins.updater`／`createUpdaterArtifacts`、`release.yml` 的簽章與 `latest.json` 步驟，或使用者回報收不到更新、更新後權限又被問時。
>
> 來源索引：根 `CLAUDE.md` 文件索引表。發版步驟與 secrets 見 `../operations.md`；金鑰不可遺失的邊界見 `../boundaries.md`。

## 機制
- 後端 `updater.rs` 只有兩個指令：`update_check`（回 `{version, notes}` 或 null）與 `update_install`（**重新 check 一次**再下載、安裝、`app.restart()`，不在狀態裡留 `Update` 物件）。下載用 `tauri.conf.json` 的 minisign 公鑰驗簽；端點是 `releases/latest/download/latest.json`，由 CI 的 `manifest` job 產生（每平台一筆：Windows `windows-x86_64`＝NSIS 安裝檔本身、macOS `darwin-aarch64`＝`panex.app.tar.gz`）。
- 前端 `update.ts` 決定時機：**啟動、視窗取回焦點且距上次檢查 ≥ 6 小時**才查，沒有計時器（閒置零成本的硬需求）。找到新版只在側欄 `#update-row` 顯示，**按下按鈕才安裝**；不像 Liftoff 閒置時自動重啟，因為重啟會結束所有分頁裡的 agent。有 agent 在工作時沿用 `openCloseAsk` 確認。
- 開關是 `app.checkForUpdates`（預設開）。只管背景檢查；設定頁「立即檢查」不受影響。
- Windows 的 `installMode` 是 `passive`（只有小進度視窗、不問問題，裝完自動重開）；macOS 換掉 `.app` 後由 `restart()` 啟動新版。

## 會中招的點
- **重啟不經視窗的 close handler**：`restart()` 不會觸發 `onCloseRequested`，scrollback 與 session 不會被 flush。所以 `installUpdate` 必須先 `await flushForClose()` 再 invoke。
- **debug build 與測試實例一律不檢查也不安裝**（`updater::enabled` 沿用 `hooks::may_write`）：否則測試實例會被換成已發佈的版本。唯一例外是 `--features e2e` 的測試版加環境變數 `PANEX_E2E_UPDATES`。
- 新增 `tauri-plugin-updater` 後 `cargo check` 仍需 `TAURI_CONFIG` 開 private API（見 `../operations.md`）。

## macOS 權限為何更新後會保留
- macOS 的 TCC 權限認的是簽章的 designated requirement。ad-hoc 簽章的 DR 是 `cdhash`（每版都變），所以以前每次更新都要重新授權。
- 現在 CI 用自簽憑證「panex Release Signing」簽章，DR 是 `identifier "dev.panex.terminal" and certificate leaf = H"<憑證 SHA-1>"`，不隨程式碼改變。憑證 SHA-1 `B163CEB0…15DF`、2046-10 到期、只有 CN 沒有 Team ID。2026-10-23 實測 0.5.6／0.5.7 兩版 DR 完全一致。
- 憑證在鑰匙圈會顯示「不受信任」（`CSSMERR_TP_NOT_TRUSTED`），不影響 codesign 與 TCC。Gatekeeper 仍判 rejected，所以**手動下載的版本**第一次仍要「仍要打開」；從 panex 內更新的版本沒有 quarantine 屬性，不用。
- 從 ad-hoc 的舊版換到這個身分時，使用者要最後再授權一次（0.6.0 發佈時就是這樣）。Windows 沒有對應問題：panex 在 Windows 上沒有跟簽章綁定的系統權限。

## 本機端到端驗證法（macOS）
1. 用臨時 keychain 匯入 `~/.config/panex-signing/panex-signing.p12`（不要動登入鑰匙圈；`security list-keychains -s` 暫時加進搜尋清單，測完還原並刪掉）。
2. 以測試 identifier／productName 各建兩版（例如 0.5.6、0.5.7）：`tauri build --bundles app --features e2e --config '<version、identifier、productName、signingIdentity、plugins.updater.endpoints 指向 http://127.0.0.1:<port>/latest.json 並加 dangerousInsecureTransportProtocol>' -- --profile test-build`，需設 `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`。
3. 本機起 http server 放新版 `.app.tar.gz` 與手寫的 `latest.json`；啟動舊版（設 `PANEX_E2E_UPDATES`、`PANEX_E2E_TOKEN`、短的 `PANEX_PIPE_NAME`），用 `panex-cli e2e` 讀 `#update-row`、點按鈕，檢查 `Info.plist` 版本、PID 變化、`codesign -dr -`。把更新檔尾巴塞幾個位元組可驗證竄改會被拒（`The signature verification failed`）。

## 踩過的雷
- **本機 `tauri build` 報 `xattr: option -r not recognized`**：pyenv 的 Python 版 `xattr` 蓋過 `/usr/bin/xattr`。建置時 `PATH=/usr/bin:$PATH`。CI 的 runner 沒有這問題。
