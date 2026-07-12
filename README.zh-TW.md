# Pinboard 書籤強化

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

全面強化 [Pinboard](https://pinboard.in) 書籤體驗的 Chrome 擴充功能：AI 智能標籤、自動摘要，以及全套可自訂主題介面。

> **說明：** 需要 Pinboard.in 帳號 —— [Pinboard](https://pinboard.in) 是一項獨立的**付費**書籤服務。本擴充功能是第三方用戶端，使用你自己的 Pinboard API token 連接到你既有的 Pinboard 帳號。本專案與 Pinboard 無任何隸屬、贊助或背書關係。你必須已擁有（或註冊）付費的 Pinboard.in 帳號才能使用本擴充功能。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 功能特色

- **智慧填表** — 自動填入標題、URL、頁面描述、來源連結和選取的文字，並在擷取或貼上時從儲存的 URL 移除追蹤參數（`utm_*`、`gclid`、`fbclid`、…），另有積極模式與自訂保留／移除清單
- **快速與批次儲存** — 直接用鍵盤快捷鍵儲存頁面（或標為*稍後閱讀*），無需開啟彈出視窗；或批次儲存所有開啟的分頁，每個分頁獨立 AI 標籤化、即時顯示進度，還能打包成 Tab Set（也可綁定專屬鍵盤快捷鍵）；離線草稿會保留在本機佇列，重新連線後自動重試儲存至 Pinboard
- **AI 標籤與摘要** — 自備 API key 接入 13 家主流 LLM 服務商，或任何 OpenAI 相容端點；送往 AI 的是去除廣告、選單、側欄後的乾淨正文
- **標籤工具** — 從你自己的標籤、Pinboard 建議標籤，以及一鍵標籤預設中自動補全；另有標籤治理面板，能找出重複與低使用次數的標籤（啟發式 + 隨選 AI 分群），並以限流批次合併，同時即時顯示進度
- **快速連結與狀態** — 一鍵前往你的 Unread、Network、Notes 與 Popular 頁面；工具列圖示會一眼顯示目前頁是未儲存、已收藏，還是已收藏並標記*稍後閱讀*
- **當前頁轉 Markdown** — 將目前網頁轉為乾淨的 Markdown，內建預覽（渲染/原始碼切換、目錄、閱讀統計）；可複製或下載為 `.md`、帶樣式的 `.html`，或單篇 `.epub`（Kindle / Kobo / KOReader 可讀），可調整 frontmatter（涵蓋作者、發布日期、網站、封面圖片與字數統計）、圖片處理（保留、移除或內嵌離線可讀）與目錄，也可直接送往 [Obsidian](https://obsidian.md)、GitHub Gist，或任何 webhook（相容 Readwise）。站台感知擷取讓問答、社群貼文與論壇討論串保持易讀（知乎、Hacker News、Stack Overflow、X/Twitter、…）；後端可選 [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（本機）或 [Jina Reader](https://jina.ai/reader)（雲端）
- **向頁面提問與翻譯** — 在該 Markdown 預覽中，你可以提問並取得串流回答，附帶可跳至原文的查證引用，也能就地解說或翻譯任何選取段落（並將回答存為筆記），或以自訂詞彙表翻譯整頁、即時顯示 token 用量，並提供原文／雙語／譯文三種檢視
- **閱讀工具** — 以五種顏色劃重點並加註筆記，重新渲染或翻譯後依然保留；在筆記本面板瀏覽所有重點，用 `/` 搜尋全文（可選正規表達式，連你的筆記也搜得到），就地檢視註腳，自動接續上次的閱讀進度，開啟專注模式排除干擾，或加開選用的 AI 重點速覽（預設關閉）；按 `?` 可叫出完整快捷鍵列表
- **自動封存** — 可選擇在每次儲存時將網頁一併存入網際網路檔案館的 [Wayback Machine](https://web.archive.org)（附封存記錄與重試），原網頁日後失效也找得回
- **`pinboard.in` 佈景主題** — 13 套精心調校的配色（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …），加上多裝置同步的自訂 CSS 覆蓋層、可調整的彈出視窗寬度，以及標籤頁的人氣排序
- **設定備份** — 將所有設定（並可選擇連同你的重點）匯出／匯入為檔案，或自動備份到你自己的 WebDAV 伺服器（如 Nextcloud），讓你的組態與自訂主題在不同裝置間流通
- **9 種語言**、可自訂快捷鍵、本機優先儲存、零追蹤

## 安裝

**[→ 從 Chrome 線上應用程式商店安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推薦

或從 release ZIP 手動載入：
1. 下載最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 選擇解壓縮後的資料夾

安裝完成後：點擊工具列圖示 → 貼上你的 [Pinboard API token](https://pinboard.in/settings/password) → 儲存

## 隱私

零追蹤、零分析、零遙測。對新使用者，設定與憑證預設儲存在本機。一般設定同步必須在每台裝置上分別開啟。憑證同步是 Chrome 帳號層級的選項，但只有開啟一般設定同步的裝置才會參與；關閉一般設定同步的裝置會繼續使用本機憑證。新使用者的憑證同步預設關閉；若升級時 Chrome Sync 已有非空憑證，為避免資料遺失會保持開啟。開啟後，API 金鑰、權杖、密碼與匯出憑證會透過 Chrome Sync 共用，且僅經過混淆處理，並未加密。書籤內容、頁面內容與離線佇列不會透過 Chrome Sync 同步。AI 請求**僅**透過你啟用或使用的功能發送——包括 AI 標籤／摘要、頁面問答、翻譯、選取解說，或選用的重點速覽——並直接傳送到你設定的服務商。安裝時僅授予 Pinboard 存取權限；AI、Jina、批次操作中選取的網站，以及選用的匯出、封存與備份目的地，只會在你執行相應操作時申請目前確切網站的權限。自訂網路端點必須使用 HTTPS；HTTP 僅允許用於 `localhost`、`127.0.0.1` 和 `[::1]`。擴充功能頁面採用嚴格的 Content-Security-Policy（不執行遠端程式碼）。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT — 見 [LICENSE](LICENSE)。
