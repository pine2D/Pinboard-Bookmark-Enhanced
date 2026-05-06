# Pinboard 書籤強化

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

全面強化 [Pinboard](https://pinboard.in) 書籤體驗的 Chrome 擴充功能：AI 智能標籤、自動摘要，以及全套可自訂主題介面。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 功能特色

- **智慧填表** — 自動填入標題、URL、頁面描述、來源連結和選取的文字。送往 AI 的是去除廣告、選單、側欄後的乾淨正文
- **AI 標籤與摘要** — 自備 API key 接入 13 家服務商（OpenAI · Anthropic · Gemini · DeepSeek · Qwen · Kimi · Zhipu · Groq · Mistral · MiniMax · Cohere · OpenRouter · Ollama），或任何 OpenAI 相容端點
- **批次儲存** — 一次儲存所有開啟的分頁，每個分頁獨立 AI 標籤化並即時顯示進度
- **已收藏偵測** — 目前頁若已收藏，工具列圖示會自動切換狀態
- **`pinboard.in` 佈景主題** — 13 套精心調校的配色（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …），加上自訂 CSS 覆蓋層，多裝置同步
- **離線佇列** — 離線儲存的草稿留在本機，重新連線時自動同步
- **當前頁轉 Markdown** — 將目前網頁轉為乾淨的 Markdown，可預覽、複製到剪貼簿，或下載為 `.md`
- **9 種語言**、可自訂快捷鍵、零追蹤

## 安裝

1. 下載最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 選擇解壓縮後的資料夾
4. 點擊工具列圖示 → 貼上你的 [Pinboard API token](https://pinboard.in/settings/password) → 儲存

## 隱私

零追蹤、零分析、零遙測。所有資料透過 `chrome.storage` 儲存在你的本機。AI 請求**僅**在你點擊「AI 標籤」或「AI 摘要」時觸發，並直接傳送到你設定的服務商。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT — 見 [LICENSE](LICENSE)。
