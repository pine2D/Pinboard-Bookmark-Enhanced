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

- **智能填表** — 自動填入標題、URL、頁面描述、來源連結同選取嘅文字；儲存或者貼上嗰陣，仲會由 URL 移除追蹤參數（`utm_*`、`gclid`、`fbclid`、…），另設進取模式同自訂保留／移除清單
- **快速同批次儲存** — 唔使開彈出視窗，撳一下快捷鍵就直接儲存頁面（或者標記為*稍後閱讀*）；又或者批次儲存所有開咗嘅分頁，每個分頁獨立 AI 加標籤、即時顯示進度，仲可以打包成一個分頁集；離線儲存嘅草稿會排隊留喺本機，重新連線時自動同步
- **AI 標籤同摘要** — 自備 API key 接入 13 家主流 LLM 服務商，或者任何 OpenAI 相容端點；送畀 AI 嘅係去除咗廣告、選單、側欄之後嘅乾淨正文
- **標籤工具** — 由你自己嘅標籤、Pinboard 建議標籤同一撳即用嘅標籤預設提供自動完成；仲有一個治理面板，可以揪出重複同低使用次數嘅標籤（啟發式判斷 + 按需 AI 聚類），再分批限速合併，過程即時顯示進度
- **快速連結同狀態** — 一撳即去你嘅未讀、Network、Notes 同熱門頁面；目前頁如果已經收藏咗，工具列圖示會自動切換狀態
- **當前頁轉 Markdown** — 將目前網頁轉為乾淨嘅 Markdown，內建預覽（渲染/原始碼切換、目錄、閱讀統計）；可以複製或者下載做 `.md` 或者帶樣式嘅 `.html`，可以調整 frontmatter（包括作者、發佈日期、網站、封面圖同字數）、圖片處理同目錄，或者直接匯出去 [Obsidian](https://obsidian.md)、GitHub Gist，或者任何 webhook（同 Readwise 相容）。網站感知抽取會令問答、社交貼文同論壇串保持易讀（知乎、Hacker News、Stack Overflow、X/Twitter、…）；後端可揀 [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（本機）或者 [Jina Reader](https://jina.ai/reader)（雲端）
- **向頁面提問同翻譯** — 喺嗰個 Markdown 預覽入面，你可以直接提問並串流取得答案，附帶可核實嘅引註、撳一下即跳去原文；亦可以就任何選取段落做行內解釋或翻譯（仲可以將答案存為筆記），或者用自訂詞彙表將成版翻譯，並提供即時 token 用量同原文／雙語／譯文三種檢視
- **閱讀工具** — 用五種顏色 highlight 文字並加筆記，重新渲染或者翻譯之後都會保留低；喺 Notebook 面板瀏覽所有 highlight；搜尋文章內文（`/`，仲支援 regex——你自己嘅筆記都搜得到）；就地睇返註腳內容；自動記返你上次睇到邊度；開啟專注模式，減少畫面干擾；或者加開一個預設關閉、opt-in 嘅 AI 重點摘要；撳 `?` 就可以睇晒完整快捷鍵清單
- **自動存檔** — 可選擇將每次儲存一併存入 Internet Archive 嘅 [Wayback Machine](https://web.archive.org)（附存檔記錄同重試），就算原網頁日後失效都仲搵得返
- **`pinboard.in` 佈景主題** — 13 套精心調校嘅配色（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …），仲有自訂 CSS 覆蓋層，多裝置同步，彈出視窗寬度亦可調整，標籤頁仲可以按熱門度排序
- **9 種語言**、可自訂快捷鍵、本機優先儲存、零追蹤

## 安裝

**[→ 由 Chrome 線上應用程式商店安裝](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推薦

或者由 release ZIP 手動載入：
1. 下載最新嘅 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解壓縮
3. `chrome://extensions/` → 開啟**開發人員模式** → **載入未封裝項目** → 揀解壓縮後嘅資料夾

安裝完成之後：撳工具列圖示 → 貼上你嘅 [Pinboard API token](https://pinboard.in/settings/password) → 儲存

## 私隱

零追蹤、零分析、零遙測。所有資料預設透過 `chrome.storage` 儲存喺你嘅本機；若開咗設定同步，你嘅設定（唔包括書籤內容）會透過 Chrome 帳號喺你嘅裝置之間同步。AI 請求**只**會透過你啟用或使用嘅功能發出——AI 標籤／摘要、頁面問答、翻譯、選取段落解釋，或者 opt-in 嘅重點摘要——並直接傳送去你設定嘅服務商。安裝時只會授予 Pinboard 存取權限；AI、Jina、批次操作揀選嘅網站，以及可選嘅匯出、封存同備份目的地，只會喺你執行相應操作時申請目前確切網站嘅權限。自訂網絡端點必須使用 HTTPS；HTTP 只可以用於 `localhost`、`127.0.0.1` 同 `[::1]`。擴充功能頁面實施嚴格嘅 Content-Security-Policy（唔會執行遠端程式碼）。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 授權

MIT — 見 [LICENSE](LICENSE)。
