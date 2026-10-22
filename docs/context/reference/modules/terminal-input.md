# 終端機輸入：macOS 輸入法與丟字（terminal input）

> **何時讀**：動到 `src/terminal.ts` 的 `guardImeInput`、xterm 的鍵盤／`input`／composition 處理，或遇到「用輸入法時符號偶爾沒出現」「字重複送兩次」之前。要在 Mac 上用真實按鍵測輸入，也先讀這裡。
>
> 來源索引：根 `CLAUDE.md` 文件索引表。本檔是 macOS 輸入法輸入路徑的單一事實源。

## 機制

- **`guardImeInput`**（`src/terminal.ts`，只在 macOS 掛上）：在 tab 容器的 capture 階段攔 `input`。`insertText` 的 `input` 若比它的 `keydown`（keyCode 229）先到，就由 panex 用 `term.input(data, true)` 送出並 `stopPropagation`，不讓 xterm 處理。
- **交回 xterm 的情況**：229 的 `keydown` 先到（Chromium 的順序，xterm 的 textarea 比對會補送）、正在組字（`compositionstart`～`compositionend` 後一個 tick）、`isComposing`。

## 踩過的雷

### IME 下 `input` 比 `keydown` 先到，xterm 把字丟掉
WKWebView 在輸入法（實測 OpenVanilla 嘸蝦米）啟用時，一個鍵的事件順序是 `input` → `keydown`(229) → `keyup`。xterm 的 `_inputEvent` 在 `_keyDownSeen` 為 true 時忽略 `insertText`；`_keyDownSeen` 在 `keydown` 設、`keyup` 清，上一鍵的 `keyup` 晚到就會讓它還是 true，字被丟。接著 229 的 `keydown` 走 `CompositionHelper._handleAnyTextareaChanges`，拿 textarea 比對，但字早就在 textarea 裡了，補不到。結果是符號（實測 Shift+:）偶爾沒進 pty：2026-10-23 真實按鍵測試 40 個冒號掉 7 個，修正後 40/40。

- **不能改成「input 一律由 panex 送」**：229 的 `keydown` 先到時，xterm 的 textarea 比對會自己送一次，再送就重複。所以只接管「input 先於 keydown」的那一種。
- **原生 App（Terminal.app、cmux）沒有這個問題**，因為沒有「事件轉成 DOM 事件再由 xterm 解讀」這一層。

### 輸入路徑只能用真實按鍵測
`panex-cli e2e` 與 `__e2e.key` 合成的 `KeyboardEvent` 跳過 macOS 原生的 NSEvent → WebKit 文字輸入路徑，重現不出上面這類問題。

- 測法：測試版實例（見 `operations.md`）＋ `osascript`（JXA 的 System Events `keyCode`，Shift 用 `using: "shift down"`）送真實按鍵，同時在頁面 capture 記 `keydown`／`input`／composition 事件，在 pty 端用 raw 模式的小程式（Python `tty.setraw`＋`os.read`）記每個字抵達的時間。比對「送出的鍵數」與「抵達 pty 的字數」才看得出丟字；用逐鍵順序配對會在丟字後整個錯位。
- 送鍵前要給 panex「輔助使用」權限（系統設定 → 隱私權與安全性）。從 panex 分頁裡跑 `osascript`，macOS 把權限算在 panex 頭上。ad-hoc 簽章的 panex 換版後，清單裡的舊項目會對不上、開關顯示開著仍回 `不允許「osascript」傳送按鍵 (1002)`：`tccutil reset Accessibility dev.panex.terminal` 清掉，再重新加入並重開 panex。
- 送鍵期間測試視窗要在最前面，不能碰鍵盤滑鼠。
