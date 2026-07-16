# Pinboard 書籤強化

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **繁體中文（香港）** | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

全面強化 [Pinboard](https://pinboard.in) 書籤體驗嘅 Chrome 擴充功能：AI 智能標籤、自動摘要，加埋全套可自訂主題介面。

> **說明：** 需要 Pinboard.in 帳號 —— [Pinboard](https://pinboard.in) 係一項獨立、**付費**嘅書籤服務。本擴充功能係第三方客戶端，會用你自己嘅 Pinboard API token 連接你現有嘅 Pinboard 帳號。本專案與 Pinboard 無任何隸屬、贊助或認可關係。你必須已經擁有（或註冊）一個付費 Pinboard.in 帳號先可以使用本擴充功能。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 功能特色

### 儲存
- **一鍵儲存，資料自動填好** — 自動填入標題、描述同選取嘅文字，仲會移除 URL 入面嘅追蹤參數
- **快捷鍵直接儲存** — 唔使開彈出視窗；仲可以一次過儲存所有開咗嘅分頁
- **離線都儲存到** — 內容先入本機佇列，重新連線之後自動重試

### 標籤
- **AI 產生標籤同摘要** — 讀取去除咗廣告、選單同側欄嘅文章正文；自備 API key，支援 13 家服務商或者任何 OpenAI 相容端點
- **標籤自動完成** — 你嘅歷史標籤、Pinboard 建議標籤、一撳即用嘅預設
- **標籤治理** — 揪出重複同低使用次數嘅標籤，分批合併

### 閱讀
- **網頁變成清爽嘅閱讀器** — Markdown 檢視，有目錄、全文搜尋、註腳速覽
- **五色 highlight 加筆記** — 重新渲染、翻譯、內容改咗之後都仲會保留
- **成版翻譯，或者直接問吓篇文** — 支援雙語對照；答案附帶引註，撳一下即跳返原文出處
- **傳送或者下載** — 傳送去 [Obsidian](https://obsidian.md)、GitHub Gist 或者任何 webhook；又可以下載做 `.md`、`.html`、`.epub`，用電子書閱讀器睇

### 個人化
- **13 套 pinboard.in 佈景主題**（Dracula、Nord、Catppuccin、Solarized 等），仲可以疊加自訂 CSS
- **自動存檔去 [Wayback Machine](https://web.archive.org)** — 可以揀每次儲存時一併提交；原連結死咗都仲搵得返網頁
- **設定備份** — 匯出做檔案，或者自動備份去自己嘅 WebDAV
- **9 種語言**、可自訂快捷鍵、本機優先儲存、零追蹤

## 安裝

**[→ 由 Chrome 線上應用程式商店安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推薦

或者由 release ZIP 手動載入：
1. 下載最新嘅 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 揀解壓縮後嘅資料夾

安裝完成之後：撳工具列圖示 → 貼上你嘅 [Pinboard API token](https://pinboard.in/settings/password) → 儲存

## 私隱

零追蹤、零分析、零遙測。對新用戶，設定同憑據預設儲存喺本機。一般設定同步要喺每部裝置分別開啟。憑據同步係 Chrome 帳號級選項，但只有開咗一般設定同步嘅裝置會參與；關閉一般設定同步嘅裝置會繼續使用本機憑據。新用戶預設關閉憑據同步；如果升級時 Chrome Sync 已經有非空憑據，為免資料遺失會保留開啟。開啟後，API 金鑰、token、密碼同匯出憑據會透過 Chrome Sync 共享，只經過混淆處理，並無加密。書籤內容、頁面內容同離線佇列唔會透過 Chrome Sync 同步。AI 請求**只**會透過你啟用或使用嘅功能發出——AI 標籤／摘要、頁面問答、翻譯、選取段落解釋，或者 opt-in 嘅重點摘要——並直接傳送去你設定嘅服務商。安裝時只會授予 Pinboard 存取權限；AI、Jina、批次操作揀選嘅網站，以及可選嘅匯出、封存同備份目的地，只會喺你執行相應操作時申請目前確切網站嘅權限。自訂網絡端點必須使用 HTTPS；HTTP 只可以用於 `localhost`、`127.0.0.1` 同 `[::1]`。擴充功能頁面實施嚴格嘅 Content-Security-Policy（唔會執行遠端程式碼）。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT — 見 [LICENSE](LICENSE)。
