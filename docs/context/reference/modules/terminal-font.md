# 終端機字型與彩色 emoji（terminal font）

> **何時讀**：動到終端機字型（`termFontFamily`、`DEFAULTS.fontFamily`）、設定頁字型選單（`s-font-pick`／`s-font-family`）、`style.css` 的 `"panex emoji"` `@font-face`、`src-tauri/src/fonts.rs`，或遇到「某符號變彩色／變線條」「emoji 擠到隔壁字」「滑鼠選取落在隔壁行」之前。
>
> 來源索引：根 `CLAUDE.md` 文件索引表。本檔是終端機字型機制的單一事實源。

## 機制

- **設定值**：`panex.json` 的 `terminal.fontFamily` 仍是 CSS font-family 字串（舊值直接相容，不需遷移）。設定頁從下拉選單挑一個字型時存成 `'<名稱>'`，選「預設」時把這個鍵拿掉。
- **實際交給 xterm 的字串**：`termFontFamily()` 組成 `'panex emoji', <使用者的字型（去掉 monospace）>, <中文備援，Windows 用 Microsoft JhengHei、macOS 用 PingFang TC，已有就不重複>, monospace`。中文和 emoji 不管選哪個字型都有。設定頁的預覽也走同一個函式。
- **`"panex emoji"`**（`style.css` 的 `@font-face`）：`src` 依序是 `local()` Segoe UI Emoji／Apple Color Emoji／Noto Color Emoji；`unicode-range` 只含 Unicode 預設就是 emoji 的字元（Emoji_Presentation）再加上 U+26A0 ⚠。排在最前面，所以就算使用者的字型自己有這些字形，也會用 emoji 版。要讓別的文字預設符號變彩色，就把它加進 `unicode-range`，但要先對照下方的雷。
- **寬度**：⚠ 在 Unicode 裡只佔 1 格，彩色字形比較寬。xterm 開了 `rescaleOverlappingGlyphs: true`（只在 WebGL renderer 有效），把它縮回 1 格。
- **載入時機**：用 `local()` 載入的字型要等第一次用到才會載入，但 xterm WebGL 會把先畫出來的字形快取在 atlas 裡。所以 `applyConfig` 第一次執行時先 `document.fonts.load('16px "panex emoji"', "⚠")`，載入完再對已經開啟的分頁呼叫 `term.clearTextureAtlas()`（`emojiFontReq` 確保只做一次）。
- **字型清單**：Rust 端的 `fonts::fonts_list` 用 `fontdb` 掃系統字型，只回傳 `monospaced` 的家族名稱（取英文名，排序後去重），在 `spawn_blocking` 裡執行。前端只在**第一次打開設定頁**時呼叫一次並快取（`fontsReq`／`fontList`），閒置時不花資源。fontdb 判斷等寬是看字型檔的 `isFixedPitch` 旗標，有些 CJK 字型（例如細明體）也會被列進來。
- **選單狀態**：選項依序是「預設（第一個預設字型）」、已安裝字型、「自訂…」。目前的值不是預設、也不是清單裡的單一字型時，就顯示「自訂」並打開文字框（`fontCustom`）。清單還沒回來時，先把目前的字型放進選項，避免畫面上暫時變成「自訂」。

## 踩過的雷

### 不能把 emoji 字型整個加進 font-family 備援
最直覺的做法是在字型清單後面加 `'Segoe UI Emoji'`。**但這樣一來**，凡是 Cascadia／Consolas／正黑體缺的符號都會改用它畫，其中 ⏺ U+23FA、✳ U+2733、⏸ U+23F8、✔ U+2714 在 Segoe UI Emoji 裡是彩色字形（2026-10-22 用 fontTools 查 COLR 表確認過）。

- **真義**：Claude Code 用 ⏺ 的前景色表示狀態（綠／紅／白），✳ 是 spinner。變成固定顏色的 emoji 之後，狀態就看不出來了。
- **連帶**：所以只能用 `@font-face` 加 `unicode-range` 列出允許的字元。✗ ✘ ☐ ☒ ⇄ ↻ 在 Segoe UI Emoji 裡是單色字形，就算加進去也不會變彩色，但沒有必要加。

### 滑鼠選取落在隔壁行：格子尺寸沒跟上 DPI 縮放
症狀是拖曳選取的位置和滑鼠不符，越往下偏越多；在 DPI 125% 的 Windows 上，修之前每個分頁都偏成目標位置的 0.8 倍（1/1.25），選取帶高度也變短（15px／應為 20px）。在該分頁按 Ctrl+滾輪放大再縮回、或縮放視窗，選取就恢復正常。

- **真義**：xterm 把滑鼠位置換成行列，用的是它自己記的字元格寬高，不是問畫面；那組尺寸在分頁剛開、換 WebGL 渲染器（`showTab` 每次切換都會 dispose／重新 attach）或字型載入前後量到，會和實際畫面對不上。改 `fontSize` 或 `fit` 會逼它重量。
- **處理**：`terminal.ts` 的 `remeasureTab(tab)`（fontSize +1 再改回，再 `fit`），在 `showTab` 的下一個 animation frame 和 `"panex emoji"` 字型載完後各呼叫一次；隱藏中的分頁（`display:none`）量不準，略過。
- **為什麼只在部分分頁發生**：沒查出來，在 125% DPI 的測試機上每個分頁都重現，沒重現「部分正常」。

### `<option value>` 不能用 `\u0000` 當代表值
字型選單的「自訂…」原本用 `"\u0000custom"` 當值，再用 `innerHTML` 組 `<option>`。**實際上** HTML 解析會把 NUL 換成 U+FFFD，程式裡的值和 DOM 裡的值就對不上，選了「自訂」卻被當成「預設」，設定也跟著被重設。現在改用 `":custom"`（字型名稱不會以 `:` 開頭）。
