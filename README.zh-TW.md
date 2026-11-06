# 書籤強化

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

支援 [Pinboard](https://pinboard.in)、[Karakeep](https://karakeep.app) 和 [linkding](https://linkding.link) 的 Chrome 擴充功能：AI 標籤與摘要、支援翻譯與標記的閱讀器，以及 13 套 pinboard.in 佈景主題。

> **說明：** 在設定中選擇一種書籤服務。使用 Karakeep 或 linkding 不需要 Pinboard 帳號。Pinboard 是獨立的**付費**服務，使用時需自備帳號與 API Token。本擴充功能是第三方用戶端，與 Pinboard 無隸屬、贊助或背書關係。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![AI 產生標籤與摘要後儲存，深色與淺色主題](docs/screenshots/readme/hero.webp)

[![1 分鐘影片介紹：儲存、閱讀、留存](docs/screenshots/readme/promo-video.webp)](https://youtu.be/YWvA_Vux0CI)

---

## 功能特色

### 儲存
- **儲存到你選的服務**：Pinboard、Karakeep 或 linkding，標題、描述與選取文字自動填妥。
- **AI 標籤與摘要**：根據文章正文提供建議，使用你自己的 API Key。
- **離線也能儲存**：書籤先存在本機，重新連線後自動送出。

### 閱讀
- **清爽閱讀**：任何網頁都能去除廣告與側欄，還能標記、做筆記。
- **雙語對照閱讀**：翻譯整頁，原文就在旁邊。
- **向文章提問**：回答附有引用，一按就能跳到原句。
- **隨手查詞**：不必離開頁面就能看釋義與發音，生詞還能傳送到 Anki。
- **邊讀邊看**：YouTube 與 B 站影片旁邊配上隨播放捲動的字幕。

![清爽閱讀器：雙語對照、五色標記與筆記](docs/screenshots/readme/reader.webp)

![向文章提問，回答附帶引用](docs/screenshots/readme/ask.webp)

![YouTube 預覽：字幕隨播放捲動](docs/screenshots/readme/video.webp)

### 留存
- **資料庫**：標記、筆記、生詞與過往的問答都在這裡，可以透過你自己的 Google Drive 同步。
- **傳送或下載**：傳送到 [Obsidian](https://obsidian.md)、Notion 等，或下載為 `.md`、`.html`、`.epub`。

![筆記頁：同一篇文章的標記連成摘錄](docs/screenshots/readme/notes.webp)

![生詞詳情：原文語境與詞典參考欄](docs/screenshots/readme/vocab.webp)

### 個人化 Pinboard
- **13 套 pinboard.in 佈景主題**：為網站換上淺色或深色外觀，還可疊加自訂 CSS。
- **標籤治理**：合併相近標籤，清理不常用的標籤。
- **自動存檔到 [Wayback Machine](https://web.archive.org)**：儲存過的網頁，原連結失效後仍能找回。

![13 套 pinboard.in 佈景主題](docs/screenshots/readme/themes.webp)

## 安裝

**[→ 從 Chrome 線上應用程式商店安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)**（推薦）

或從 release ZIP 手動載入：
1. 下載最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 選擇解壓縮後的資料夾

接著開啟**設定 → 帳號**，連線書籤服務：Pinboard 填入 [API Token](https://pinboard.in/settings/password)；Karakeep（0.31 或更新版本）或 linkding 填入伺服器網址與 API Token。

## 隱私

擴充功能不會追蹤你，也不收集使用資料。設定與憑證預設只存在本機，開啟同步後才會離開這台裝置；同步的憑證只經過混淆，沒有加密。AI 請求只在你使用 AI 功能時送出，且只傳送到你設定的服務商。存取 Pinboard 以外的網站時，擴充功能會在你第一次用到相關功能時請求權限。Google Drive 中的副本存放在擴充功能的私有應用程式資料夾，未經端對端加密。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT，見 [LICENSE](LICENSE)。
