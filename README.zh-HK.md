# 書籤增強

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **繁體中文（香港）** | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

支援 [Pinboard](https://pinboard.in)、[Karakeep](https://karakeep.app) 和 [linkding](https://linkding.link) 的 Chrome 擴充功能：AI 標籤與摘要、支援翻譯與高亮的閱讀器，以及 13 套 pinboard.in 網站主題。

> **說明：** 在設定選擇一種書籤服務。使用 Karakeep 或 linkding 無需 Pinboard 帳號。Pinboard 是獨立的**付費**服務，使用時需自備帳號及 API Token。本擴充功能是第三方客戶端，與 Pinboard 沒有隸屬、贊助或認可關係。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![AI 生成標籤與摘要後儲存，深色與淺色主題](docs/screenshots/readme/hero.webp)

[![1 分鐘影片介紹：儲存、閱讀、留存](docs/screenshots/readme/promo-video.webp)](https://youtu.be/YWvA_Vux0CI)

---

## 功能特色

### 儲存
- **儲存到你選擇的服務**：Pinboard、Karakeep 或 linkding 都可以，標題、描述與選取文字會自動填好。
- **AI 標籤與摘要**：根據文章內容提出建議，使用你自己的 API Key。
- **離線也能儲存**：書籤會先存在本機，重新連線後自動提交。

### 閱讀
- **清爽閱讀**：任何網頁都可以去掉廣告和側欄，還可以高亮和做筆記。
- **雙語閱讀**：翻譯整頁，原文就在旁邊對照。
- **向文章提問**：答案附引註，按一下就能跳到引用的句子。
- **邊讀邊查詞**：不用離開頁面就能查看釋義與發音，生詞亦可傳送到 Anki。
- **邊讀邊看**：YouTube 與 B 站影片旁邊配上跟着播放捲動的字幕。

![清爽閱讀器：雙語對照、五色高亮與筆記](docs/screenshots/readme/reader.webp)

![向文章提問，答案附帶引註](docs/screenshots/readme/ask.webp)

![YouTube 預覽：字幕跟着播放捲動](docs/screenshots/readme/video.webp)

### 留存
- **資料庫**：標記、筆記、生詞與過往提問都在這裏，可以透過你自己的 Google Drive 同步。
- **傳送或下載**：傳送到 [Obsidian](https://obsidian.md)、Notion 等服務，或下載為 `.md`、`.html` 或 `.epub`。

![筆記頁：同一篇文章的高亮連成摘錄](docs/screenshots/readme/notes.webp)

![生詞詳情：原文語境與詞典參考欄](docs/screenshots/readme/vocab.webp)

### 個人化
- **13 套 pinboard.in 佈景主題**：為網站換上淺色或深色外觀，亦可加上自訂 CSS。
- **標籤治理**：合併相近標籤，清理少用的標籤。
- **自動存檔至 [Wayback Machine](https://web.archive.org)**：儲存過的網頁，即使原連結失效仍可閱讀。

![13 套 pinboard.in 佈景主題](docs/screenshots/readme/themes.webp)

## 安裝

**[→ 從 Chrome Web Store 安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)**（推薦）

或從 release ZIP 手動載入：
1. 下載最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 選擇解壓縮後的資料夾

然後開啟**設定 → 帳號**，連線你的書籤服務：Pinboard 需要 [API Token](https://pinboard.in/settings/password)，Karakeep（0.31 或更新版本）或 linkding 則需要伺服器網址及 API Token。

## 私隱

擴充功能不會追蹤你，也不會收集使用數據。除非開啟同步，設定與憑證只會留在本機；同步的憑證只經混淆處理，並未加密。AI 請求只會在你使用 AI 功能時發出，而且只傳送至你設定的服務商。如要存取 Pinboard 以外的網站，擴充功能會在你第一次使用相關功能時才請求權限。Google Drive 副本存放在擴充功能的私人應用程式資料夾，未經端對端加密。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT，見 [LICENSE](LICENSE)。
