# Pinboard 書籤強化

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **繁體中文（香港）** | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

為 [Pinboard](https://pinboard.in) 而設的 Chrome 擴充功能：AI 標籤與摘要、支援翻譯與高亮的內置閱讀器，以及 13 套網站主題。

> **說明：** 需要 Pinboard.in 帳號 —— [Pinboard](https://pinboard.in) 是一項獨立、**付費**的書籤服務。本擴充功能是第三方客戶端，以你自己的 Pinboard API Token 連接你現有的 Pinboard 帳號。本專案與 Pinboard 沒有任何隸屬、贊助或認可關係。你必須已經擁有（或註冊）一個付費 Pinboard.in 帳號，方可使用本擴充功能。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![AI 生成標籤與摘要後儲存，深色與淺色主題](docs/screenshots/readme/hero.webp)

[![30 秒影片介紹：儲存、閱讀、留存](docs/screenshots/readme/promo-video.webp)](https://youtu.be/DMQS8LC09kU)

---

## 功能特色

### 儲存
- **一鍵儲存，資料自動填好**：標題、描述與選取文字一併填入，並移除 URL 中的追蹤參數
- **快捷鍵與批量儲存**：不開彈出視窗直接儲存，或一次收藏目前視窗的所有標籤頁
- **離線也能儲存**：先進本機佇列，重新連線後自動重試
- **草稿不會遺失**：關掉彈出視窗再打開，繼續寫

### 標籤
- **AI 產生標籤與摘要**：只讀文章正文，不含廣告、選單與側欄；自備 API Key，14 家服務商或任何 OpenAI 兼容端點
- **標籤自動完成**：歷史標籤、Pinboard 建議、一按即用的預設
- **標籤治理**：合併相近標籤，清理少用的標籤

### 閱讀
- **網頁變成清爽的閱讀器**：Markdown 檢視，附目錄、搜尋與註腳速覽；數學公式、圖表與表格都正常顯示
- **GitHub Discussions（試行）**：保留已載入的主帖、留言、回覆關係及獲採納的答案，並說明擷取範圍
- **閱讀時管理書籤**：在閱讀器內儲存、編輯或刪除 Pinboard 書籤，不用切回彈出視窗
- **五色高亮與筆記**：切換翻譯、原文改動後仍留在原處
- **整頁翻譯，或向文章提問**：雙語對照；答案附引註，一按即跳回原文出處
- **問答連同引用一併保留**：完成後自動儲存，連線 Google Drive 後同步；可在問答頁查看記錄、返回閱讀器繼續提問，或獨立匯出、附在正文後。臨時對話不儲存。
- **邊讀邊查詞**：查看詞典釋義及發音；生詞一鍵傳送到 Anki 及歐路詞典，亦可選用離線中英、英中詞典包。AI 詞條釋義可獨立選擇語言，生詞本亦可按語言篩選。 查詞浮動視窗可拖曳邊緣調整大小，亦可移至右側面板；切換位置時保留目前結果、所選釋義及生成進度。
- **多語言離線詞典**：匯入 Yomitan v3 ZIP 檔案，即可在本機查閱釋義和讀音；詞典包不會納入 Drive 同步或 JSON 備份。 所有離線詞典（包括漢英及英漢詞典）均可停用，資料仍保留在此裝置。 可識別的釋義會與例句、詞源分開呈現，其他內容保留為完整詞條供閱讀。舊詞包需重新匯入以重新識別結構，已有生詞及詞包的啟用狀態維持不變。
- **AI 詞條**：先以母語或指定語言生成詞義、發音和例句，再按需要生成詞源與相關詞、具體用法及有出處的文學用例。補充內容部分有效時會保留並說明，可另行補全缺少的內容。完整結果透過已連線的 Google Drive 同步，更新保留舊版。可選擇查詞預設顯示詞典或 AI，基本詞條的自動生成需另行開啟。
- **結合文章理解所選文字**：使用「解釋」了解詞語或段落在目前文章中的含義；查詞提供詞語的常見含義及用法。
- **資料庫**：集中查看標記、筆記、生詞和已儲存的問答，隨手查詞、批量管理生詞。可直接儲存查詞結果並選擇釋義，透過可編輯的原形關聯詞形；每個詞保留自己的筆記及學習狀態。
- **完整匯出生詞**：可選用獨立的多語言 Anki 筆記類型，區分不同語言中拼寫相同的詞；完整 TSV 保留筆記、原形及每段語境的來源，原有六欄位格式仍可使用
- **傳送或下載**：[Obsidian](https://obsidian.md)、Notion、NotebookLM、GitHub Gist 或任何 webhook；`.md`、`.html`、`.epub` 供電子書閱讀器
- **邊讀邊看**：YouTube 與 B 站影片旁邊配上跟着播放捲動的字幕，AI 標籤與摘要亦能直接讀字幕

![清爽閱讀器：雙語對照、五色高亮與筆記](docs/screenshots/readme/reader.webp)

![向文章提問，答案附帶引註](docs/screenshots/readme/ask.webp)

![筆記頁：同一篇文章的高亮連成摘錄](docs/screenshots/readme/notes.webp)

![生詞詳情：原文語境與詞典參考欄](docs/screenshots/readme/vocab.webp)

![YouTube 預覽：字幕跟着播放捲動](docs/screenshots/readme/video.webp)

### 個人化
- **13 套 pinboard.in 佈景主題**（Dracula、Nord、Catppuccin、Solarized 等），更可疊加自訂 CSS
- **自動存檔至 [Wayback Machine](https://web.archive.org)**：每次儲存都留一份快照，原連結失效也能找回
- **備份與同步**：設定透過 Chrome Sync，生詞、標記、筆記、AI 詞條及問答記錄透過自己的 Google Drive；JSON 備份包含設定、生詞、標記及筆記
- **9 種語言**、可自訂快捷鍵、本機優先儲存、零追蹤

![13 套 pinboard.in 佈景主題](docs/screenshots/readme/themes.webp)

## 安裝

**[→ 從 Chrome Web Store 安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)**（推薦）

或從 release ZIP 手動載入：
1. 下載最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 選擇解壓縮後的資料夾

原始碼目錄使用獨立而固定的開發版本 ID，可與 Chrome Web Store 版本並存以便測試。release ZIP 使用 Chrome Web Store ID，不能與商店版本同時安裝在同一個 Chrome 個人檔案。在每部裝置開啟設定同步後，Chrome Sync 便可共享設定。如要取代較舊的解壓安裝版本，先在舊版設定頁按「匯出備份」，載入新版本後再按「匯入備份」。

安裝完成後：按一下工具列圖示 → 貼上你的 [Pinboard API Token](https://pinboard.in/settings/password) → 登入

## 私隱

零追蹤、零分析、零遙測。新用戶的設定與憑證預設儲存在本機。一般設定同步需在每部裝置分別開啟。憑證同步是 Chrome 帳戶層級的選項，但只有開啟了一般設定同步的裝置才會參與；關閉一般設定同步的裝置會繼續使用本機憑證。新用戶預設關閉憑證同步；如升級時 Chrome Sync 已有非空憑證，為免資料遺失會保持開啟。開啟後，API Key、Token、密碼與匯出憑證會透過 Chrome Sync 共享，只經混淆處理，並未加密。書籤內容、頁面內容與離線佇列不會透過 Chrome Sync 同步。AI 請求**只**來自你開啟或使用的 AI 功能，並直接傳送至你設定的服務商。安裝時只會授予 Pinboard 的存取權限。其他網站（AI 服務商、匯出或存檔目標、詞典、Google Drive、影片字幕，以及批量儲存涉及的網站）都會在你首次使用相應功能時逐一申請，而且只申請確切網站。自訂網絡端點必須使用 HTTPS；HTTP 只可用於 `localhost`、`127.0.0.1` 與 `[::1]`。擴充功能頁面實施嚴格的 Content-Security-Policy（不會執行遠端程式碼）。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

Google Drive 需在每部裝置分別連線，連線後同步目前 Pinboard 帳戶的生詞、標記、筆記、完整 AI 詞條和補充用法，以及儲存的問答與原文依據。Drive 私有 appDataFolder 中的副本是明文，未經端對端加密。可選的詞源資料來自維基詞典；手動要求的文學及文化補充使用維基文庫或維基百科的原文段落。擴充功能會核對原文，將短摘錄及相關來源資料傳送給所選 AI 服務商；其他教學例句由 AI 編寫。已有付費結果繼續保留，只有主動更新才生成新版。

使用生詞同步的裝置都需要更新擴充功能。新版可讀取現有生詞資料，但舊版無法接收新版寫入的生詞變更。

## 授權

MIT，見 [LICENSE](LICENSE)。
