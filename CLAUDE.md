# panex

開源、跨平台（Windows 優先）的多 agent 終端機 App，模仿 cmux。Tauri 2 + xterm.js + portable-pty。

## Session 開始順序

1. `docs/context/reference/overview.md`（系統架構大圖，**必讀**）
2. `docs/context/reference/boundaries.md`（編碼規範 + 邊界 + 跨全站的雷，**必讀**）
3. `docs/context/journal/process.md` 最近數筆（流水帳）
4. 其餘 reference 檔按需從下方索引讀

## 文件索引（需要時才讀）

| 文件 | 涵蓋 | 何時讀 |
|------|------|--------|
| `reference/overview.md` | 系統架構大圖 | **必讀** |
| `reference/boundaries.md` | 編碼規範、邊界、跨全站的雷 | **必讀** |
| `reference/operations.md` | 建置、獨立測試實例、macOS 端對端測試（`--features e2e`）、重拍 README 截圖、發布 GitHub release | 要測試（含 Mac 上自動化驗收）、拍截圖或發新版前 |
| `reference/modules/terminal-font.md` | 終端機字型組成、彩色 emoji 的 `@font-face`、設定頁字型選單與 `fonts_list` | 動字型、emoji 渲染或字型選單前 |
| `reference/modules/terminal-input.md` | macOS 輸入法下的輸入路徑（`guardImeInput`）、用真實按鍵測輸入的方法 | 動 `terminal.ts` 的輸入處理、或要在 Mac 上測打字前 |
| `reference/modules/updates.md` | App 內更新（updater）、macOS 簽章身分與更新後權限保留、本機端到端更新測試 | 動更新相關程式、`release.yml` 的簽章與 `latest.json`，或使用者回報收不到更新、更新後權限又被問前 |

> 新增任何 reference 檔（data-model / api-spec / modules/xxx …）時，archive-to-context 會在此表補一行。
> 本表每列只寫「涵蓋什麼、何時讀」各一兩句，**不寫雷或結論的摘要**（那些寫在各檔本身）——本檔每個 session 都自動載入，摘要會讓它只增不減。

## 共通規範

- 重要結論用 archive-to-context 歸檔進 `reference/`；只屬單一模組／技術層的雷寫到對應主題檔，跨全站的才進 `boundaries.md`；時間線變更記 `journal/process.md` 最上方（寫「為什麼」與「下一步」）。
- 判斷型結論（行銷、成效類的「有效／無效／已否決／常態」、基準線與成效數字、評估過但沒做的事）不歸檔，只在當次對話交付——會成為思考錨點，且模型與市場會變。
