# Pinboard 書籤強化

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **繁體中文（香港）** | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

全面強化 [Pinboard](https://pinboard.in) 書籤體驗嘅 Chrome 擴充功能：AI 智能標籤、自動摘要，加埋全套可自訂主題介面。

> **說明：** 本擴充功能係 [Pinboard](https://pinboard.in)（一項**付費**書籤服務）嘅獨立第三方客戶端。使用前需要你自己嘅 Pinboard.in 帳號同 API token。本專案與 Pinboard 官方無關。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 功能特色

- **智能填表** — 自動填入標題、URL、頁面描述、來源連結同選取嘅文字；儲存或者貼上嗰陣，仲會由 URL 移除追蹤參數（`utm_*`、`gclid`、`fbclid`、…），另設進取模式同自訂保留／移除清單
- **AI 標籤同摘要** — 自備 API key 接入 13 家主流 LLM 服務商，或者任何 OpenAI 相容端點；送畀 AI 嘅係去除咗廣告、選單、側欄之後嘅乾淨正文
- **標籤助手** — 由你自己嘅標籤、Pinboard 建議標籤同一撳即用嘅標籤預設提供自動完成
- **快速儲存** — 唔使開彈出視窗，撳一下快捷鍵就直接儲存頁面（或者標記為*稍後閱讀*）；又或者批次儲存所有開咗嘅分頁，每個分頁獨立 AI 加標籤兼即時顯示進度，仲可以打包成一個分頁集
- **搜尋同重溫** — 搜尋你嘅書籤，快速跳去未讀／Network／Notes／熱門，瀏覽最近儲存嘅項目；目前頁如果已經收藏咗，工具列圖示會自動切換狀態
- **離線佇列** — 離線儲存嘅草稿留喺本機，重新連線時自動同步
- **`pinboard.in` 佈景主題** — 13 套精心調校嘅配色（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …），仲有自訂 CSS 覆蓋層，多裝置同步，彈出視窗寬度亦可調整
- **當前頁轉 Markdown** — 將目前網頁轉為乾淨嘅 Markdown，內建預覽（渲染/原始碼切換、目錄、閱讀統計）；可以複製或者下載做 `.md` 或者帶樣式嘅 `.html`，可以調整 front-matter、圖片處理同目錄，亦可按需匯出去 [Obsidian](https://obsidian.md)；後端可揀 [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（本機）或者 [Jina Reader](https://jina.ai/reader)（雲端）
- **9 種語言**、可自訂快捷鍵、零追蹤

## 安裝

**[→ 由 Chrome 線上應用程式商店安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推薦

或者由 release ZIP 手動載入：
1. 下載最新嘅 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 揀解壓縮後嘅資料夾

安裝完成之後：撳工具列圖示 → 貼上你嘅 [Pinboard API token](https://pinboard.in/settings/password) → 儲存

## 私隱

零追蹤、零分析、零遙測。所有資料透過 `chrome.storage` 儲存喺你嘅本機。AI 請求**只**喺你撳「AI 標籤」或者「AI 摘要」嗰陣先觸發，並直接傳送去你設定嘅服務商。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT — 見 [LICENSE](LICENSE)。
