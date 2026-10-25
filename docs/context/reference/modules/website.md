# 介紹網站（`website/`）

> **何時讀**：改網站內容、發新版要更新網站的版本號、重拍網站截圖、或排查 GitHub Pages 部署前。

純靜態 HTML + CSS + 一支 `site.js`，沒有建置工具、沒有依賴。英文在 `website/`（`index.html`、`guide.html`），繁中在 `website/zh/`；兩套各自手寫、共用 `style.css`／`site.js`／`assets/`。部署由 `.github/workflows/pages.yml` 做：`website/**` 有變動並 push 到 main 就發布到 `https://firstfu.github.io/panex/`（repo 的 Settings → Pages 要設成 GitHub Actions）。

## 規則

- **不得出現 cmux 的名稱或品牌**（同 `boundaries.md`）。對照表只跟「通用終端機（Windows Terminal）」比，且只寫確定的列；想講同類工具時說「過去只有 macOS 才有的 agent 終端機」。
- **公開 repo**：網站截圖與文案不能出現使用者真實的工作區名、路徑、帳號。截圖一律用測試實例的示範資料（見 `operations.md`），路徑只能是 `/Users/Shared/demo/…`。
- **功能描述以程式碼與 `overview.md` 為準**，UI 路徑與按鈕名稱要對照 `src/i18n.ts`（例如「Close workspace and delete worktree…」）。網站不寫還沒做的東西；沒做的（分割窗格）明寫「not yet」。
- 英文與繁中內容要同步改，改任一頁的功能描述時兩邊都動。
- FAQ 不加 `FAQPage` 結構化資料（Google 已撤掉該 rich result）；首頁只有 `SoftwareApplication` 的 JSON-LD。

## 發版時要手動改的地方

安裝檔檔名與版本號寫死在 `website/index.html` 與 `website/zh/index.html` 的安裝區（`.exe` 與 `.dmg` 各出現在 `<code>` 裡）。發版步驟的「改版本號」要一併 `grep -rn "panex_<舊版本>" website` 改掉。沒有自動化：每次發版只多改兩處。

## 標題與關鍵字

英文標題與描述的用字來自 2026-10-25 的 Google Suggest：有人搜「best terminal for claude code (windows/mac)」「run multiple claude code sessions at once／in parallel」「claude code notifications」「claude code git worktree manager」「claude code resume session after restart」；繁中是「claude code windows 終端機」「多個 session」。改標題前先重查，不要憑感覺換字。

## 素材

- `assets/hero.png`、`demo.mp4`、`shortcuts.png`、`icon.png`：從根目錄 `assets/` 複製來的，README 重拍後要重新複製。
- `shot-diff.png`、`shot-files.png`：從 `demo.mp4` 的第 18、24 秒用 `ffmpeg -ss <秒> -frames:v 1` 抽出，`magick … -colors 128 PNG8:` 壓縮。
- `shot-worktrees.png`、`shot-crew.png`：在 macOS 測試實例（`--features e2e`，做法同 `operations.md` 的重拍截圖）用真的 `panex-cli open --worktree`／`--title` 與 `panex-cli notify` 拍的，示範 repo 在 `/Users/Shared/demo/`，拍完刪除；同樣用 `magick … -colors 128 PNG8:` 壓縮。小隊那張三個 agent 共用 `shop` 資料夾（`open` 不帶 `--worktree` 沿用呼叫者的資料夾），側欄會重複出現同一個路徑，這是功能本來的行為。
- `og.png`、`og-zh.png`（1200×630）：以 hero.png 為底用 Pillow 合成，沒有放進 repo 的腳本；要重做時照同一版面（深色底、左上 icon＋「panex」、64 px 標語、下方圓角截圖出血）。繁中字型用 macOS 的 PingFang TC（`/System/Library/AssetsV2/…/PingFang.ttc` 的 index 10 是 Semibold、2 是 Regular；`/System/Library/Fonts/` 裡沒有它）。
