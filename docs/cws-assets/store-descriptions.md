# Chrome Web Store — Store Descriptions (per locale)

> Paste the matching locale block into **CWS Dashboard → Store listing → Detailed description**
> for that language. **Plain text** — the Chrome Web Store renders no Markdown, so this file
> already has the bold markers, backticks and link syntax removed.
>
> **Generated** by `node scripts/sync-store-descriptions.mjs` from the nine READMEs. Edit the
> READMEs and regenerate; do not hand-edit the blocks below. The leading ⚠ paid-account
> disclosure states that Pinboard requires a paid account, while the other services do not; it is carried across regenerations
> untouched.

---

## English (en)

```text
⚠ Choose one bookmark service in Settings. Karakeep and linkding work without a Pinboard account. Pinboard is an independent paid service and requires your own account and API token. This third-party extension is not affiliated with, sponsored by, or endorsed by Pinboard. AI features are optional and use an API key you supply for the LLM provider of your choice.

# Save
- One click, everything filled in: title, description, and selected text, with tracking parameters stripped from the URL
- Hotkeys and Batch Save: save without opening the popup, or bookmark every tab in the window at once
- Works offline: saves are queued locally and retried when you're back online
- Drafts survive: close the popup mid-edit and pick up where you left off

# Tag
- AI tags & summary: reads the article body without the ads, menus, and sidebars; bring your own key (14 providers, or any OpenAI-compatible endpoint)
- Autocomplete from your own tags, Pinboard's suggestions, and one-tap presets
- Tag cleanup: merge near-duplicate tags and prune rarely used ones

# Read
- Any page becomes a clean reader: a Markdown view with table of contents, search, and footnote peek; math, diagrams, and tables render properly
- GitHub Discussions (pilot): keeps the loaded main post, comments, reply structure, and which reply was accepted; shows how much was loaded
- Manage bookmarks as you read: save, edit, or delete the article’s bookmark without returning to the popup
- Five-color highlights with notes: they stay in place through translation and even later edits to the page
- Translate the page or ask it questions: full-page translation with a bilingual view; answers cite the source and jump straight to it
- Keep questions and answers with their citations: completed answers save automatically and sync through Google Drive. Browse conversations in the library, continue in the reader, or export them alone or with the article. Temporary conversations stay unsaved.
- Look up words as you read: see dictionary definitions and pronunciation; send saved words to Anki or Eudic in one click, or add offline Chinese-English and English-Chinese dictionaries. Choose the language for AI entry definitions independently of the interface, and filter saved words by language. Resize the lookup window by dragging its edges, or move it into the side panel while keeping the current results, selected definition, and generation progress. See a word in real sentences from texts on Wikisource, with author and source, without using AI.
- Multilingual offline dictionaries: look up words on this device with definitions and readings from Yomitan v3 ZIP files you import; dictionary packs are excluded from Drive sync and JSON backups. All offline dictionaries, including Chinese–English and English–Chinese, can be disabled without removing their data. Recognized structure keeps individual definitions separate from examples and word origins; other content remains readable as full entries. Reimport older packs to reprocess their structure without changing saved vocabulary or whether the dictionary is enabled.
- AI dictionary entries: generate definitions, pronunciation and examples in your native or chosen explanation language, then add usage points and word origins when you need them. Valid parts of an incomplete supplement remain available and are marked as partial. Full results sync through connected Google Drive; updates keep earlier versions. Dictionary results and AI content read in one column, with live generation progress and the definition you will save kept in view. Automatic basic-entry generation is optional.
- Explain selected text in context: use Explain to understand a word or passage in the current article; dictionary entries describe its general meanings and usage.
- Your reading library: find highlights, notes, saved words and conversations in one place, with dictionary lookup and batch vocabulary management. Save words straight from dictionary results, choose a definition, and link related word forms through an editable base form. Each word keeps its own notes and learning status.
- Vocabulary exports: choose a separate multilingual Anki note type to distinguish the same spelling in different languages. Complete TSV keeps notes, base forms and every context with its source; the original six-field formats remain available
- Send or download: send articles to your notes app or your own webhook, or save them as e-books for your e-reader
- Watch while you read: YouTube and bilibili videos sit beside a transcript that follows playback; AI tags and summaries can read the subtitles

# Make Pinboard yours
- 13 themes for pinboard.in: light and dark looks for the site itself, plus room for your own custom CSS
- Auto-archive to the Wayback Machine: snapshot each page you save, so it stays readable after the original link dies
- Backup and sync: Chrome Sync for settings, your own Google Drive for vocabulary, highlights, notes, AI dictionary entries and conversations; JSON backups cover settings, vocabulary, highlights and notes
- Private by default: your data stays in your browser with zero tracking; the interface comes in 9 languages and every shortcut is configurable
```

---

## 简体中文 (zh-CN)

```text
⚠ 在设置中选择一种书签服务。使用 Karakeep 或 linkding 无需 Pinboard 账号。Pinboard 是独立的付费服务，使用时需自备账号和 API Token。本扩展是第三方客户端，与 Pinboard 官方无关，未获其赞助或认可。 AI 功能是可选的，需要你自备所选 LLM 服务商的 API Key。

# 保存
- 一键保存，信息自动填好：标题、描述和选中文本一并填入，并去掉 URL 里的追踪参数
- 快捷键与批量保存：不开弹窗直接保存，或一次收藏当前窗口的所有标签页
- 断网也能保存：先进本地队列，恢复联网后自动重试
- 草稿不丢：关掉弹窗再打开，接着写

# 标签
- AI 生成标签和摘要：只读文章正文，不掺广告、菜单和侧边栏；自备 API Key，14 家服务商或任意 OpenAI 兼容接口
- 标签自动补全：历史标签、Pinboard 建议、一键预设
- 标签治理：合并近似标签，清理低频标签

# 阅读
- 网页变成清爽的阅读器：Markdown 视图，带目录、搜索和脚注速览；公式、图表、表格都正常显示
- GitHub Discussions（试点）：保留已加载的主帖、评论、回复关系和采纳标记，并说明提取范围
- 阅读时管理书签：在阅读器里保存、编辑或删除书签，不用切回弹窗
- 五色高亮与笔记：切换翻译、原文改动后仍留在原处
- 整页翻译，或向文章提问：双语对照；回答附引用，点击直达原文出处
- 问答连同引用一起留存：完成后自动保存，连接 Google Drive 后同步；可在问答页查看历史、回阅读器继续提问，或单独导出、附在正文后。临时对话不保存。
- 边读边查词：查看词典释义和发音；生词一键发到 Anki 和欧路词典，还可以选择离线汉英、英汉词典包。AI 词条释义可单独选择语言，生词本支持按语言筛选。 查词气泡可拖动边缘调整大小，也可移入右侧面板；切换位置时保留当前结果、选定释义和生成进度。从 Wikisource 的作品里读到这个词的真实原句，附作者与出处，不用 AI。
- 多语言离线词典：导入 Yomitan v3 ZIP 文件，即可在本机查阅释义和读音；词典包不参与 Drive 同步，也不包含在 JSON 备份中。 所有离线词典（包括汉英和英汉词典）均可停用，数据继续保留在本机。 可识别的释义会与例句、词源分开呈现，其他内容保留为完整词条供阅读。旧词包需重新导入以重新识别结构，已有生词和词包启用状态保持不变。
- AI 词条：先用母语或指定语言生成词义、发音和例句，需要时再补充用法要点和词源。补充内容部分有效时会保留有效部分并注明。完整结果随已连接的 Google Drive 同步，更新保留旧版。词典结果与 AI 内容在同一栏依次排开，生成时实时显示进度，要保存的释义始终留在底部。基础词条的自动生成需另行开启。
- 结合文章理解选中文本：使用“解释”了解词语或段落在当前文章中的含义；查词提供词语的常见含义和用法。
- 资料库：集中查看高亮、笔记、生词和已保存的问答，随手查词、批量管理生词。可直接保存查词结果并选择释义，通过可编辑的原形关联词形；各词保留独立笔记和学习状态。
- 生词完整导出：可选择独立的多语言 Anki 笔记类型，区分不同语言的同形词；完整 TSV 保留笔记、原形及每段语境的来源，原有六字段格式仍可使用
- 发送或下载：把文章发到常用的笔记应用或你自己的 webhook，或者存成电子书放进阅读器
- 边读边看：YouTube 和 B 站视频旁边配上随播放滚动的字幕，AI 标签和摘要可以直接读字幕

# 个性化
- 13 套 pinboard.in 主题：给网站本身换上浅色或深色外观，还能叠加自定义 CSS
- 自动存档到 Wayback Machine：每次保存都留一份快照，原链接失效也能找回
- 备份与同步：设置走 Chrome Sync，生词、高亮、笔记、AI 词条和问答记录走自己的 Google Drive；JSON 备份包含设置、生词、高亮与笔记
- 隐私优先：数据留在你自己的浏览器里，零追踪；界面支持 9 种语言，快捷键可自定义
```

---

## 繁體中文 (zh-TW)

```text
⚠ 在設定中選擇一種書籤服務。使用 Karakeep 或 linkding 不需要 Pinboard 帳號。Pinboard 是獨立的付費服務，使用時需自備帳號與 API Token。本擴充功能是第三方用戶端，與 Pinboard 無隸屬、贊助或背書關係。 AI 功能為選用，並使用你自行提供、你所選 LLM 服務商的 API key。

# 儲存
- 一鍵儲存，資料自動填妥：標題、描述與選取文字一併填入，並移除 URL 裡的追蹤參數
- 快捷鍵與批次儲存：不開彈出視窗直接儲存，或一次收藏目前視窗的所有分頁
- 離線也能儲存：先進本機佇列，重新連線後自動重試
- 草稿不會遺失：關掉彈出視窗再打開，接著寫

# 標籤
- AI 產生標籤與摘要：只讀文章正文，不含廣告、選單與側欄；自備 API Key，14 家服務商或任何 OpenAI 相容端點
- 標籤自動補全：歷史標籤、Pinboard 建議、一鍵預設
- 標籤治理：合併相近標籤，清理低使用率標籤

# 閱讀
- 網頁變成清爽的閱讀器：Markdown 檢視，內建目錄、搜尋與註腳速覽；數學式、圖表與表格都正確呈現
- GitHub Discussions（試行）：保留已載入的主文、留言、回覆層級與採納標記，並註明擷取範圍
- 閱讀時管理書籤：在閱讀器裡儲存、編輯或刪除書籤，不用切回彈出視窗
- 五色劃重點與筆記：切換翻譯、原文改動後仍留在原處
- 整頁翻譯，或向文章提問：雙語對照；回答附引用，一按即跳回原文出處
- 問答與引用一起留存：完成後自動儲存，連線 Google Drive 後同步；可在問答頁查看歷史、回閱讀器繼續提問，或單獨匯出、附在正文後。臨時對話不儲存。
- 邊讀邊查詞：查看詞典釋義與發音；生詞一鍵傳送到 Anki 與歐路詞典，也可以選用離線中英、英中詞典包。AI 詞條釋義可獨立選擇語言，生詞本也能依語言篩選。 查詞浮動視窗可拖曳邊緣調整大小，也可移至右側面板；切換位置時保留目前結果、選取的釋義及生成進度。從 Wikisource 的作品讀到這個詞的真實原句，附作者與出處，不使用 AI。
- 多語言離線詞典：匯入 Yomitan v3 ZIP 檔案，即可在本機查閱釋義與讀音；詞典包不會納入 Drive 同步或 JSON 備份。 所有離線詞典（包括漢英及英漢詞典）都可停用，資料仍保留在此裝置。 可辨識的釋義會與例句、詞源分開呈現，其他內容保留為完整詞條供閱讀。舊詞包需重新匯入以重新辨識結構，既有生詞與詞包的啟用狀態維持不變。
- AI 詞條：先以母語或指定語言產生詞義、發音與例句，需要時再補充用法要點與詞源。補充內容部分有效時會保留有效部分並註明。完整結果透過已連線的 Google Drive 同步，更新保留舊版。詞典結果與 AI 內容在同一欄依序排列，產生時即時顯示進度，要儲存的釋義一直留在底部。基礎詞條的自動產生需另行開啟。
- 結合文章理解選取文字：使用「解釋」了解詞語或段落在目前文章中的含義；查詞提供詞語的常見含義與用法。
- 資料庫：集中查看標記、筆記、生詞和已儲存的問答，隨手查詞、批次管理生詞。可直接儲存查詞結果並選擇釋義，透過可編輯的原形關聯詞形；各詞保留自己的筆記與學習狀態。
- 完整匯出生詞：可選用獨立的多語言 Anki 筆記類型，區分不同語言中拼寫相同的詞；完整 TSV 保留筆記、原形與各段語境的來源，原有六欄位格式仍可使用
- 傳送或下載：把文章傳到常用的筆記應用程式或你自己的 webhook，或存成電子書放進閱讀器
- 邊讀邊看：YouTube 與 B 站影片旁邊配上隨播放捲動的字幕，AI 標籤與摘要也能直接讀字幕

# 個人化
- 13 套 pinboard.in 佈景主題：替網站本身換上淺色或深色外觀，還可疊加自訂 CSS
- 自動存檔到 Wayback Machine：每次儲存都留一份快照，原連結失效也能找回
- 備份與同步：設定透過 Chrome Sync，生詞、標記、筆記、AI 詞條與問答記錄透過自己的 Google Drive；JSON 備份包含設定、生詞、標記與筆記
- 隱私優先：資料留在你自己的瀏覽器裡，零追蹤；介面支援 9 種語言，快捷鍵可自訂
```

---

## 繁體中文（香港） (zh-HK)

```text
⚠ 在設定選擇一種書籤服務。使用 Karakeep 或 linkding 無需 Pinboard 帳號。Pinboard 是獨立的付費服務，使用時需自備帳號及 API Token。本擴充功能是第三方客戶端，與 Pinboard 沒有隸屬、贊助或認可關係。 AI 功能係可選嘅，會使用你為自選 LLM 服務商提供嘅 API key。

# 儲存
- 一鍵儲存，資料自動填好：標題、描述與選取文字一併填入，並移除 URL 中的追蹤參數
- 快捷鍵與批量儲存：不開彈出視窗直接儲存，或一次收藏目前視窗的所有標籤頁
- 離線也能儲存：先進本機佇列，重新連線後自動重試
- 草稿不會遺失：關掉彈出視窗再打開，繼續寫

# 標籤
- AI 產生標籤與摘要：只讀文章正文，不含廣告、選單與側欄；自備 API Key，14 家服務商或任何 OpenAI 兼容端點
- 標籤自動完成：歷史標籤、Pinboard 建議、一按即用的預設
- 標籤治理：合併相近標籤，清理少用的標籤

# 閱讀
- 網頁變成清爽的閱讀器：Markdown 檢視，附目錄、搜尋與註腳速覽；數學公式、圖表與表格都正常顯示
- GitHub Discussions（試行）：保留已載入的主帖、留言、回覆關係及獲採納的答案，並說明擷取範圍
- 閱讀時管理書籤：在閱讀器內儲存、編輯或刪除書籤，不用切回彈出視窗
- 五色高亮與筆記：切換翻譯、原文改動後仍留在原處
- 整頁翻譯，或向文章提問：雙語對照；答案附引註，一按即跳回原文出處
- 問答連同引用一併保留：完成後自動儲存，連線 Google Drive 後同步；可在問答頁查看記錄、返回閱讀器繼續提問，或獨立匯出、附在正文後。臨時對話不儲存。
- 邊讀邊查詞：查看詞典釋義及發音；生詞一鍵傳送到 Anki 及歐路詞典，亦可選用離線中英、英中詞典包。AI 詞條釋義可獨立選擇語言，生詞本亦可按語言篩選。 查詞浮動視窗可拖曳邊緣調整大小，亦可移至右側面板；切換位置時保留目前結果、所選釋義及生成進度。從 Wikisource 的作品讀到這個詞的真實原句，附作者及出處，不使用 AI。
- 多語言離線詞典：匯入 Yomitan v3 ZIP 檔案，即可在本機查閱釋義和讀音；詞典包不會納入 Drive 同步或 JSON 備份。 所有離線詞典（包括漢英及英漢詞典）均可停用，資料仍保留在此裝置。 可識別的釋義會與例句、詞源分開呈現，其他內容保留為完整詞條供閱讀。舊詞包需重新匯入以重新識別結構，已有生詞及詞包的啟用狀態維持不變。
- AI 詞條：先以母語或指定語言生成詞義、發音和例句，需要時再補充用法要點和詞源。補充內容部分有效時會保留有效部分並註明。完整結果透過已連線的 Google Drive 同步，更新保留舊版。詞典結果與 AI 內容在同一欄依次排列，生成時即時顯示進度，要儲存的釋義一直留在底部。基本詞條的自動生成需另行開啟。
- 結合文章理解所選文字：使用「解釋」了解詞語或段落在目前文章中的含義；查詞提供詞語的常見含義及用法。
- 資料庫：集中查看標記、筆記、生詞和已儲存的問答，隨手查詞、批量管理生詞。可直接儲存查詞結果並選擇釋義，透過可編輯的原形關聯詞形；每個詞保留自己的筆記及學習狀態。
- 完整匯出生詞：可選用獨立的多語言 Anki 筆記類型，區分不同語言中拼寫相同的詞；完整 TSV 保留筆記、原形及每段語境的來源，原有六欄位格式仍可使用
- 傳送或下載：把文章傳到常用的筆記應用程式或你自己的 webhook，或存成電子書放進閱讀器
- 邊讀邊看：YouTube 與 B 站影片旁邊配上跟着播放捲動的字幕，AI 標籤與摘要亦能直接讀字幕

# 個人化
- 13 套 pinboard.in 佈景主題：為網站本身換上淺色或深色外觀，更可疊加自訂 CSS
- 自動存檔至 Wayback Machine：每次儲存都留一份快照，原連結失效也能找回
- 備份與同步：設定透過 Chrome Sync，生詞、標記、筆記、AI 詞條及問答記錄透過自己的 Google Drive；JSON 備份包含設定、生詞、標記及筆記
- 私隱優先：資料留在你自己的瀏覽器內，零追蹤；介面支援 9 種語言，快捷鍵可自訂
```

---

## Deutsch (de)

```text
⚠ Wähle deinen Lesezeichendienst in den Einstellungen. Karakeep und linkding funktionieren ohne Pinboard-Konto. Pinboard ist ein unabhängiger, kostenpflichtiger Dienst und erfordert ein eigenes Konto mit API-Token. Diese Erweiterung stammt von einem Drittanbieter und wird von Pinboard weder gesponsert noch unterstützt. KI-Funktionen sind optional und nutzen einen API-Key, den du für den LLM-Anbieter deiner Wahl bereitstellst.

# Speichern
- Ein Klick, alles ausgefüllt: Titel, Beschreibung und markierter Text werden übernommen, Tracking-Parameter aus der URL entfernt
- Tastenkürzel und Stapelspeicherung: speichern, ohne das Popup zu öffnen, oder alle Tabs des Fensters auf einmal als Lesezeichen anlegen
- Funktioniert offline: Gespeichertes landet in einer lokalen Warteschlange und wird gesendet, sobald du wieder online bist
- Entwürfe bleiben erhalten: Popup schließen, wieder öffnen und genau dort weiterschreiben

# Tags
- KI-Tags und Zusammenfassung: gelesen wird der Artikeltext ohne Werbung, Menüs und Seitenleisten; eigener API-Schlüssel, 14 Anbieter oder ein beliebiger OpenAI-kompatibler Endpunkt
- Autovervollständigung: aus deinen Tags, Pinboards Vorschlägen und Ein-Klick-Voreinstellungen
- Tags aufräumen: ähnliche Tags zusammenführen und selten genutzte ausmisten

# Lesen
- Jede Seite wird zur Leseansicht: Markdown-Ansicht mit Inhaltsverzeichnis, Suche und Fußnoten-Vorschau; Formeln, Diagramme und Tabellen werden sauber dargestellt
- GitHub Discussions (Pilot): übernimmt den geladenen Ausgangsbeitrag und die Kommentare, erhält die Antwortstruktur und markiert die akzeptierte Antwort; zeigt den Umfang der erfassten Inhalte
- Lesezeichen beim Lesen verwalten: Lesezeichen direkt im Reader speichern, bearbeiten oder löschen, ohne zum Popup zurückzukehren
- Markieren in fünf Farben, mit Notizen: beide bleiben an ihrer Stelle, auch nach der Übersetzung und späteren Änderungen an der Seite
- Seite übersetzen oder befragen: Ganzseiten-Übersetzung mit zweisprachiger Ansicht; Antworten zitieren die Quelle, ein Klick führt direkt zur Fundstelle
- Fragen und Antworten mit Quellen behalten: fertige Antworten werden automatisch gespeichert und über Google Drive synchronisiert. Gespräche in der Bibliothek lesen, im Lesemodus fortsetzen oder einzeln bzw. mit dem Artikel exportieren. Temporäre Gespräche bleiben ungespeichert.
- Wörter beim Lesen nachschlagen: Definitionen und Aussprache im Wörterbuch anzeigen; gespeicherte Vokabeln gehen mit einem Klick an Anki oder Eudic, dazu auf Wunsch Offline-Wörterbücher für Chinesisch–Englisch und Englisch–Chinesisch. Wähle die Definitionssprache der KI-Einträge unabhängig von der Oberfläche und filtere gespeicherte Wörter nach Sprache. Ziehe an den Rändern, um das Nachschlagefenster zu vergrößern oder zu verkleinern, oder verschiebe es in die Seitenleiste; Ergebnisse, ausgewählte Definition und laufende Generierung bleiben dabei erhalten. Sieh Wörter in echten Sätzen aus Texten auf Wikisource, mit Autor und Quelle, ganz ohne KI.
- Mehrsprachige Offline-Wörterbücher: schlage Wörter mit Definitionen und Ausspracheangaben aus selbst importierten Yomitan-v3-ZIP-Dateien auf diesem Gerät nach; Wörterbuchpakete sind von der Drive-Synchronisierung und JSON-Sicherungen ausgeschlossen. Alle Offline-Wörterbücher, auch Chinesisch–Englisch und Englisch–Chinesisch, lassen sich deaktivieren, ohne ihre Daten zu löschen. Bei erkannter Struktur werden einzelne Definitionen getrennt von Beispielen und Wortherkunft angezeigt; andere Inhalte bleiben als vollständige Einträge lesbar. Importiere ältere Pakete erneut, um ihre Struktur neu auszuwerten. Gespeicherte Vokabeln und der Aktivierungsstatus bleiben dabei unverändert.
- KI-Wörterbucheinträge: Erhalte zunächst Definitionen, Aussprache und Beispiele in deiner Muttersprache oder einer gewählten Erklärungssprache und ergänze bei Bedarf Gebrauchshinweise und Wortherkunft. Gültige Teile einer unvollständigen Ergänzung bleiben erhalten und werden als unvollständig gekennzeichnet. Vollständige Ergebnisse werden bei verbundenem Google Drive synchronisiert, frühere Versionen bleiben bei Aktualisierungen erhalten. Wörterbuchergebnisse und KI-Inhalte stehen in einer Spalte, der Fortschritt der Erstellung ist laufend zu sehen, und die zu speichernde Definition bleibt unten sichtbar. Die automatische Erstellung von Basiseinträgen ist optional.
- Ausgewählten Text im Zusammenhang verstehen: Nutze „Erklären“, um ein Wort oder einen Abschnitt im aktuellen Artikel zu verstehen; Wörterbucheinträge beschreiben allgemeine Bedeutungen und Verwendung.
- Deine Bibliothek: Markierungen, Notizen, gespeicherte Wörter und Gespräche an einem Ort, mit Wörterbuchsuche und Stapelbearbeitung von Vokabeln. Wörter direkt aus Wörterbucheinträgen speichern, eine Definition auswählen und Wortformen über eine bearbeitbare Grundform verknüpfen. Jedes Wort behält eigene Notizen und seinen Lernstatus.
- Vokabeln vollständig exportieren: Ein eigener mehrsprachiger Anki-Notiztyp unterscheidet gleich geschriebene Wörter verschiedener Sprachen. Die vollständige TSV bewahrt Notizen, Grundformen und alle Kontexte mit ihren Quellen; die bisherigen Formate mit sechs Feldern bleiben verfügbar
- Senden oder herunterladen: Artikel an deine Notiz-App oder deinen eigenen Webhook senden oder als E-Book für den E-Reader speichern
- Sehen beim Lesen: YouTube- und Bilibili-Videos laufen neben einem Transkript, das der Wiedergabe folgt; KI-Tags und -Zusammenfassungen lesen auf Wunsch die Untertitel

# Pinboard nach deinem Geschmack
- 13 Themes für pinboard.in: helle und dunkle Looks für die Seite selbst, dazu dein eigenes CSS
- Automatisch in die Wayback Machine archivieren: von jeder gespeicherten Seite ein Snapshot, damit sie lesbar bleibt, auch wenn der Originallink tot ist
- Sichern und synchronisieren: Einstellungen über Chrome Sync, Vokabeln, Markierungen, Notizen, KI-Wörterbucheinträge und Gespräche über dein eigenes Google Drive; JSON-Backups enthalten Einstellungen, Vokabeln, Markierungen und Notizen
- Privat von Anfang an: deine Daten bleiben im Browser, ohne Tracking; die Oberfläche gibt es in 9 Sprachen, alle Tastenkürzel sind anpassbar
```

---

## Français (fr)

```text
⚠ Choisissez votre service de signets dans les paramètres. Karakeep et linkding fonctionnent sans compte Pinboard. Pinboard est un service indépendant payant, qui nécessite votre propre compte et votre jeton API. Cette extension tierce n’est ni affiliée à Pinboard, ni sponsorisée ou approuvée par Pinboard. Les fonctionnalités IA sont optionnelles et utilisent une clé API que vous fournissez pour le fournisseur LLM de votre choix.

# Enregistrer
- Un clic, tout est rempli : titre, description et texte sélectionné sont repris, les paramètres de suivi retirés de l'URL
- Raccourcis et enregistrement groupé : enregistrez sans ouvrir le popup, ou mettez d'un coup tous les onglets de la fenêtre en signets
- Fonctionne hors ligne : les enregistrements passent par une file d'attente locale et sont renvoyés au retour de la connexion
- Brouillons préservés : fermez la fenêtre en pleine saisie et reprenez là où vous en étiez

# Étiquettes
- Étiquettes et résumé par IA : l'IA lit le corps de l'article, débarrassé des publicités, des menus et des barres latérales ; votre propre clé API, 14 fournisseurs ou tout point de terminaison compatible OpenAI
- Autocomplétion : à partir de vos étiquettes, des suggestions de Pinboard et de préréglages en un clic
- Nettoyage des étiquettes : fusionnez les étiquettes quasi identiques et élaguez celles qui servent peu

# Lecture
- Chaque page passe en mode lecture épuré : vue Markdown avec table des matières, recherche et aperçu des notes de bas de page ; formules, diagrammes et tableaux s'affichent correctement
- GitHub Discussions (phase pilote) : conserve le message initial et les commentaires chargés, la structure des réponses et la réponse acceptée ; précise le contenu récupéré
- Gérez vos signets pendant la lecture : enregistrez, modifiez ou supprimez le signet de l’article sans revenir au popup
- Surlignage en cinq couleurs, avec notes : les deux restent à leur place après une traduction, et même si la page change ensuite
- Traduisez la page ou posez-lui vos questions : traduction intégrale avec vue bilingue ; les réponses citent la source et y renvoient d'un clic
- Conservez les questions et réponses avec leurs citations : les réponses terminées sont enregistrées automatiquement et synchronisées via Google Drive. Retrouvez les conversations dans la bibliothèque, poursuivez-les dans le lecteur ou exportez-les seules ou avec l’article. Les conversations temporaires ne sont pas enregistrées.
- Cherchez les mots au fil de la lecture : consultez les définitions et la prononciation ; envoyez les mots enregistrés vers Anki ou Eudic en un clic, et ajoutez si vous le souhaitez des dictionnaires hors connexion chinois-anglais et anglais-chinois. Choisissez la langue des définitions des entrées IA indépendamment de l’interface et filtrez les mots enregistrés par langue. Redimensionnez la fenêtre de recherche en faisant glisser ses bords ou déplacez-la dans le panneau latéral : les résultats, la définition sélectionnée et la génération en cours sont conservés. Découvrez un mot dans de vraies phrases tirées de textes de Wikisource, avec l’auteur et la source, sans recours à l’IA.
- Dictionnaires multilingues hors connexion : consultez les définitions et les prononciations sur cet appareil grâce aux fichiers ZIP Yomitan v3 que vous importez ; les dictionnaires sont exclus de la synchronisation Drive et des sauvegardes JSON. Tous les dictionnaires hors connexion, y compris chinois–anglais et anglais–chinois, peuvent être désactivés sans supprimer leurs données. Lorsque la structure est reconnue, les définitions sont séparées des exemples et de l’origine du mot ; les autres contenus restent lisibles sous forme d’entrées complètes. Réimporter les anciens dictionnaires permet de réanalyser leur structure sans modifier le vocabulaire enregistré ni leur état activé ou désactivé.
- Entrées de dictionnaire IA: obtenez d’abord les définitions, la prononciation et des exemples dans votre langue maternelle ou la langue choisie, puis ajoutez au besoin des points d’emploi et l’étymologie. Si un complément est incomplet, ses éléments valides restent disponibles et sont signalés comme partiels. Google Drive synchronise les résultats complets une fois connecté ; les mises à jour conservent les versions précédentes. Les résultats du dictionnaire et le contenu IA se lisent sur une seule colonne, la génération affiche sa progression en direct et la définition à enregistrer reste visible en bas ; la génération automatique des entrées de base reste facultative.
- Comprenez la sélection dans son contexte : utilisez Expliquer pour comprendre un mot ou un passage de l’article en cours ; le dictionnaire présente ses sens et usages généraux.
- Votre bibliothèque : retrouvez surlignages, notes, mots et conversations enregistrées au même endroit, avec consultation du dictionnaire et gestion du vocabulaire par lots. Enregistrez des mots directement depuis les résultats, choisissez une définition et reliez les formes d’un mot grâce à une forme de base modifiable. Chaque mot conserve ses notes et son état d’apprentissage.
- Exporter le vocabulaire complet : choisissez un type de note Anki multilingue distinct pour différencier les mots de même orthographe dans plusieurs langues. Le TSV complet conserve les notes, les formes de base et chaque contexte avec sa source ; les formats d’origine à six champs restent disponibles
- Envoyer ou télécharger : envoyez vos articles vers votre application de notes ou votre propre webhook, ou enregistrez-les en livre numérique pour votre liseuse
- Regarder en lisant : les vidéos YouTube et Bilibili s'affichent à côté d'une transcription qui suit la lecture ; les tags et résumés IA peuvent lire les sous-titres

# Personnalisation
- 13 thèmes pour pinboard.in : des apparences claires et sombres pour le site lui-même, plus votre CSS personnalisé
- Archivage automatique dans la Wayback Machine : chaque page enregistrée est capturée et reste lisible même quand le lien d'origine disparaît
- Sauvegarde et synchronisation: Chrome Sync pour les réglages, votre Google Drive pour le vocabulaire, les surlignages, les notes, les entrées IA et les conversations ; les sauvegardes JSON couvrent les réglages, le vocabulaire, les surlignages et les notes
- Confidentiel par défaut : vos données restent dans votre navigateur, sans aucun pistage ; l'interface existe en 9 langues et tous les raccourcis sont configurables
```

---

## 日本語 (ja)

```text
⚠ 設定でブックマークサービスを選択します。Karakeep と linkding は Pinboard アカウントなしで使えます。Pinboard は独立した有料サービスで、自分のアカウントと API トークンが必要です。本拡張機能は第三者製で、Pinboard との提携・出資・公式の承認はありません。 AI 機能は任意で、ご自身が用意したお好みの LLM プロバイダーの API キーを使用します。

# 保存
- ワンクリック保存：タイトル・説明・選択テキストを自動入力し、URL のトラッキングパラメーターを除去します
- ショートカットと一括保存：ポップアップを開かずに保存したり、ウィンドウ内のタブをまとめてブックマークしたりできます
- オフラインでも保存：いったんローカルキューに入り、再接続後に自動で再試行します
- 下書きが消えない：ポップアップを閉じても、開き直せば続きから書けます

# タグ
- AI タグ・要約：広告・メニュー・サイドバーを除いた記事本文だけを読み取ります。API キーは自前で、14 のプロバイダーまたは任意の OpenAI 互換エンドポイントを使えます
- タグ補完：自分のタグ、Pinboard のおすすめ、ワンタップのプリセットから入力できます
- タグ整理：似たタグを統合し、ほとんど使わないタグを片付けます

# リーダー
- どんなページもすっきりしたリーダーに：目次・検索・脚注プレビュー付きの Markdown 表示。数式・図・表もきちんと表示されます
- GitHub Discussions（試験対応）：読み込み済みの本文とコメント、返信の階層、採用された回答を保持し、取得した範囲も表示
- 読みながらブックマークを管理：ポップアップに戻らず、ブックマークを保存・編集・削除できます
- 5 色のハイライトとメモ：翻訳しても、あとでページが書き換わっても、元の位置に残ります
- ページ全体の翻訳とページへの質問：対訳表示に対応し、回答には出典への引用が付き、クリックで該当箇所へジャンプします
- 質問と回答を引用付きで残す：完了した回答を自動保存し、Google ドライブで同期します。ライブラリで履歴を確認し、リーダーで質問を続けたり、単独または記事と一緒にエクスポートしたりできます。一時的な会話は保存しません。
- 読みながら単語を調べる：辞書の語義と発音を確認できます。保存した単語はワンクリックで Anki や Eudic に送れ、中英・英中のオフライン辞書パックも選べます。AI辞書の説明言語は表示言語と別に設定でき、単語帳は言語で絞り込めます。 辞書のポップアップは端をドラッグしてサイズを変えたり、サイドパネルへ移したりできます。表示場所を切り替えても、検索結果・選択した語義・生成中の処理はそのまま引き継がれます。Wikisource の作品から、その語を含む実際の一文を著者・出典つきで表示します。AI は使いません。
- 多言語オフライン辞書：Yomitan v3 の ZIP ファイルをインポートすると、このデバイスで語義と読みを調べられ、辞書パックは Drive 同期や JSON バックアップには含まれません。 漢英・英漢辞書を含むすべてのオフライン辞書は、データを削除せずに無効にできます。 構造を認識できる語義は例文や語源と分けて表示し、その他の内容は項目の全文として読めます。旧形式で取り込んだ辞書は再インポートすると構造を再解析でき、保存済みの単語や辞書の有効・無効の設定は変わりません。
- AI辞書：まず母語または指定した言語で意味・発音・例文を確認し、必要なときに用法のポイントと語源を追加できます。補足の一部だけが有効な場合は、その部分を残して不足を表示します。結果全体は接続済みの Google ドライブで同期され、更新前の版も保持されます。辞書の結果と AI の内容は 1 列に並び、生成中はその場で進み具合が見え、保存する語義は下部に残ります。基本項目の自動生成は別途有効にします。
- 選択した文章を文脈から理解：「解説」で今の記事における単語や段落の意味を確認できます。辞書では一般的な意味と使い方を調べられます。
- ライブラリ：ハイライト、ノート、保存した単語と会話を一か所で確認できます。辞書検索や単語の一括管理にも対応しています。辞書の検索結果から語義を選んで単語を保存し、編集可能な基本形で関連する語形をまとめられます。メモと学習状態は単語ごとに保持されます。
- 単語の情報をまとめてエクスポート：専用の多言語Ankiノートタイプを選ぶと、つづりが同じでも言語が違う単語を区別できます。完全なTSVにはメモ、基本形、各文脈とその出典を保存でき、従来の6フィールド形式も引き続き使えます
- 送信もダウンロードも：記事を普段使いのノートアプリや自分の webhook に送ったり、電子書籍として保存してリーダーで読んだりできます
- 読みながら観る：YouTube と Bilibili の動画の横に、再生に合わせて流れる字幕を表示。AI タグと要約も字幕を直接読めます

# カスタマイズ
- pinboard.in 用テーマ 13 種：サイト自体をライトにもダークにも着せ替えられ、自分のカスタム CSS も重ねられます
- Wayback Machine へ自動アーカイブ：保存したページごとにスナップショットを残すので、元のリンクが切れても読めます
- バックアップと同期：設定は Chrome Sync、単語帳・ハイライト・メモ・AI 辞書項目・会話履歴は自分の Google ドライブ で同期。JSON バックアップには設定・単語帳・ハイライト・メモを含められます
- プライバシー重視：データはブラウザー内に保存され、トラッキングは一切なし。9 言語に対応し、ショートカットも自由に変更できます
```

---

## Polski (pl)

```text
⚠ Wybierz usługę zakładek w ustawieniach. Karakeep i linkding działają bez konta Pinboard. Pinboard to niezależna, płatna usługa, która wymaga własnego konta i tokenu API. To rozszerzenie jest klientem zewnętrznym, niepowiązanym z Pinboard, niesponsorowanym ani nieautoryzowanym przez ten serwis. Funkcje AI są opcjonalne i korzystają z klucza API, który podajesz dla wybranego przez Ciebie dostawcy LLM.

# Zapisywanie
- Jedno kliknięcie i wszystko wypełnione — tytuł, opis i zaznaczony tekst trafiają na miejsce, a z adresu URL znikają parametry śledzące
- Skróty klawiszowe i zapis zbiorczy — zapisuj bez otwierania okienka albo dodaj naraz do zakładek wszystkie karty z bieżącego okna
- Działa offline — zapisy trafiają do lokalnej kolejki i są ponawiane po odzyskaniu połączenia
- Szkice nie przepadają — zamknij okno w trakcie edycji i wróć do pisania w tym samym miejscu

# Tagi
- Tagi i streszczenie od AI — AI czyta treść artykułu bez reklam, menu i pasków bocznych; własny klucz API, 14 dostawców lub dowolny endpoint zgodny z OpenAI
- Autouzupełnianie — z własnych tagów, podpowiedzi Pinboarda i gotowych zestawów na jedno kliknięcie
- Porządki w tagach — scalaj prawie identyczne tagi i usuwaj te rzadko używane

# Czytanie
- Każda strona staje się czytelna — widok Markdown ze spisem treści, wyszukiwaniem i podglądem przypisów; wzory, diagramy i tabele wyświetlają się poprawnie
- GitHub Discussions (pilotaż) — zachowuje wczytany wpis główny, komentarze, strukturę odpowiedzi i oznaczenie zaakceptowanej odpowiedzi; pokazuje zakres pobranej treści
- Zarządzaj zakładkami podczas czytania — zapisuj, edytuj lub usuwaj zakładkę artykułu w wybranej usłudze bez wracania do okienka
- Zaznaczenia w pięciu kolorach, z notatkami — zostają na swoim miejscu mimo tłumaczenia, a nawet późniejszych zmian na stronie
- Przetłumacz stronę albo zadaj jej pytanie — tłumaczenie całości z widokiem dwujęzycznym; odpowiedzi cytują źródło i prowadzą prosto do niego
- Zachowaj pytania i odpowiedzi z cytatami — gotowe odpowiedzi zapisują się automatycznie i synchronizują przez Google Drive. Przeglądaj rozmowy w bibliotece, kontynuuj w czytniku lub eksportuj osobno albo wraz z artykułem. Rozmowy tymczasowe nie są zapisywane.
- Sprawdzaj słownictwo podczas czytania — przeglądaj definicje i wymowę w słowniku; zapisane słówka wyślesz jednym kliknięciem do Anki lub Eudic, a do wyboru masz też słowniki offline chińsko-angielski i angielsko-chiński. Wybierz język definicji w hasłach AI niezależnie od języka interfejsu i filtruj zapisane słowa według języka. Zmieniaj rozmiar okna słownika, przeciągając jego krawędzie, lub przenieś je do panelu bocznego — wyniki, wybrana definicja i trwające generowanie zostaną zachowane. Zobacz słowo w prawdziwych zdaniach z tekstów w Wikisource, z autorem i źródłem, bez użycia AI.
- Wielojęzyczne słowniki offline — sprawdzaj definicje i zapis wymowy na tym urządzeniu w samodzielnie zaimportowanych plikach ZIP Yomitan v3; pakiety słowników nie są synchronizowane z Dyskiem Google ani uwzględniane w kopiach JSON. Każdy słownik offline, także chińsko-angielski i angielsko-chiński, można wyłączyć bez usuwania danych. Rozpoznane definicje są wyświetlane osobno od przykładów i pochodzenia słowa; pozostałą treść można przeczytać jako pełne hasło. Ponowny import starszych pakietów pozwala ponownie rozpoznać ich strukturę bez zmiany zapisanego słownictwa ani ustawienia włączenia lub wyłączenia słownika.
- Hasła słownikowe AI — najpierw definicje, wymowa i przykłady w języku ojczystym lub wybranym języku objaśnień, a w razie potrzeby także wskazówki użycia i etymologia. Jeśli uzupełnienie jest niepełne, poprawne elementy pozostają dostępne z oznaczeniem częściowego wyniku. Pełne wyniki synchronizują się po połączeniu z Google Drive; aktualizacje zachowują wcześniejsze wersje. Wyniki słownika i treści AI układają się w jednej kolumnie, postęp generowania widać na bieżąco, a definicja do zapisania pozostaje widoczna na dole; automatyczne generowanie podstawowych haseł jest opcjonalne.
- Zrozum zaznaczony tekst w kontekście — użyj funkcji Wyjaśnij, by zrozumieć słowo lub fragment bieżącego artykułu; słownik opisuje ogólne znaczenia i zastosowania.
- Twoja biblioteka — wyróżnienia, notatki, zapisane słówka i rozmowy w jednym miejscu, z wyszukiwaniem w słowniku i zbiorczym zarządzaniem słownictwem. Zapisuj słowa bezpośrednio z wyników słownika, wybieraj definicje i łącz formy słów przez edytowalną formę podstawową. Każde słowo zachowuje własne notatki i stan nauki.
- Pełny eksport słownictwa: osobny wielojęzyczny typ notatek Anki rozróżnia słowa o tej samej pisowni w różnych językach. Pełny TSV zachowuje notatki, formy podstawowe i wszystkie konteksty ze źródłami; dotychczasowe formaty z sześcioma polami nadal są dostępne
- Wyślij albo pobierz — wyślij artykuł do swojej aplikacji z notatkami lub własnego webhooka albo zapisz go jako e-book na czytnik
- Oglądaj podczas czytania — filmy z YouTube i Bilibili wyświetlają się obok transkrypcji, która podąża za odtwarzaniem; tagi i podsumowania AI mogą czytać napisy

# Personalizacja
- 13 motywów dla pinboard.in — jasne i ciemne wersje samej witryny oraz miejsce na własny CSS
- Automatyczna archiwizacja w Wayback Machine — każda zapisana strona dostaje migawkę, więc przeczytasz ją nawet wtedy, gdy oryginalny link przestanie działać
- Kopie zapasowe i synchronizacja — Chrome Sync dla ustawień, własny Google Drive dla słownictwa, wyróżnień, notatek, haseł AI i rozmów; kopie JSON obejmują ustawienia, słownictwo, wyróżnienia i notatki
- Prywatność przede wszystkim — dane zostają w przeglądarce, zero śledzenia; interfejs w 9 językach, a skróty można dowolnie zmieniać
```

---

## Русский (ru)

```text
⚠ Выберите сервис закладок в настройках. Karakeep и linkding работают без аккаунта Pinboard. Pinboard — независимый платный сервис, для которого нужны собственный аккаунт и API-токен. Это стороннее расширение не связано с Pinboard, не спонсируется и не одобряется им. Функции AI необязательны и используют API-ключ, который вы предоставляете для выбранного вами LLM-провайдера.

# Сохранение
- Один клик — всё заполнено — заголовок, описание и выделенный текст подставляются сами, а трекинг-параметры удаляются из URL
- Горячие клавиши и пакетное сохранение — сохраняйте страницу, не открывая окно, или добавьте в закладки все вкладки окна разом
- Работает офлайн — записи попадают в локальную очередь и отправляются повторно после восстановления связи
- Черновики не теряются — закройте окно на середине правки и продолжите с того же места

# Теги
- AI-теги и краткое содержание — AI читает текст статьи без рекламы, меню и боковых панелей; свой API-ключ, 14 провайдеров или любой OpenAI-совместимый эндпоинт
- Автодополнение — из ваших тегов, подсказок Pinboard и пресетов в один клик
- Порядок в тегах — объединяйте похожие теги и убирайте редко используемые

# Чтение
- Любая страница превращается в режим чтения — Markdown-просмотр с оглавлением, поиском и предпросмотром сносок; формулы, диаграммы и таблицы отображаются правильно
- GitHub Discussions (пилотная поддержка) — сохраняет загруженный исходный пост, комментарии, связи между ответами и отметку принятого ответа; показывает объём извлечённого обсуждения
- Управляйте закладками во время чтения — сохраняйте, изменяйте или удаляйте закладку статьи в выбранном сервисе, не возвращаясь к окну расширения
- Выделения пяти цветов с заметками — остаются на своих местах и после перевода, и после правок на самой странице
- Переведите страницу или задайте ей вопрос — полный перевод с двуязычным режимом; ответы ссылаются на источник, и клик ведёт прямо к нему
- Сохраняйте вопросы и ответы вместе с цитатами — готовые ответы сохраняются автоматически и синхронизируются через Google Диск. Просматривайте разговоры в библиотеке, продолжайте в режиме чтения или экспортируйте отдельно либо вместе со статьёй. Временные разговоры не сохраняются.
- Ищите слова во время чтения — просматривайте определения и произношение; сохранённые слова отправляются в Anki или Eudic в один клик, а офлайн-словари (китайско-английский и англо-китайский) подключаются по желанию. Выбирайте язык определений в статьях AI независимо от языка интерфейса и фильтруйте сохранённые слова по языку. Меняйте размер окна словаря за края или переносите его на боковую панель — результаты, выбранное определение и текущая генерация сохранятся. Смотрите слово в настоящих предложениях из текстов Wikisource, с автором и источником, без ИИ.
- Многоязычные офлайн-словари — ищите определения и чтения слов на этом устройстве в импортированных ZIP-файлах Yomitan v3; пакеты словарей не входят в синхронизацию с Google Диском и резервные копии JSON. Любой офлайн-словарь, включая китайско-английский и англо-китайский, можно отключить без удаления данных. Если структура распознана, отдельные определения показываются отдельно от примеров и происхождения слова; остальное можно прочитать как полную статью. Повторный импорт старых пакетов заново обрабатывает их структуру, не меняя сохранённые слова и состояние словаря (включён или отключён).
- Словарные статьи AI — сначала значения, произношение и примеры на родном или выбранном языке объяснений, а при необходимости также особенности употребления и этимология. Если дополнение получено не полностью, проверенные пункты сохраняются с пометкой о неполном результате. Полные результаты синхронизируются через подключённый Google Диск; при обновлении прежние версии сохраняются. Результаты словаря и материалы ИИ идут одной колонкой, ход генерации виден сразу, а определение для сохранения всегда остаётся внизу; автоматическая генерация базовых статей включается отдельно.
- Понимайте выделенный текст в контексте — используйте «Объяснить», чтобы понять слово или отрывок в текущей статье; словарь описывает общие значения и употребление.
- Ваша библиотека — выделения, заметки, сохранённые слова и разговоры в одном месте, с поиском по словарю и пакетными действиями со словами. Сохраняйте слова прямо из словаря, выбирайте определение и связывайте формы слов через редактируемую начальную форму. У каждого слова остаются свои заметки и статус изучения.
- Полный экспорт словаря: отдельный многоязычный тип заметок Anki различает одинаково написанные слова разных языков. Полный TSV сохраняет заметки, начальные формы и все контексты с источниками; прежние форматы с шестью полями остаются доступны
- Отправить или скачать — отправляйте статьи в своё приложение для заметок или на собственный вебхук либо сохраняйте их как электронные книги для читалки
- Смотрите, пока читаете — видео с YouTube и Bilibili показываются рядом с расшифровкой, которая следует за воспроизведением; AI-теги и резюме могут читать субтитры

# Персонализация
- 13 тем для pinboard.in — светлое и тёмное оформление самого сайта плюс место для своего CSS
- Автоархив в Wayback Machine — снимок каждой сохранённой страницы, чтобы её можно было прочитать, даже когда исходная ссылка перестанет работать
- Резервное копирование и синхронизация — Chrome Sync для настроек, ваш Google Диск для словарика, выделений, заметок, статей ИИ и разговоров; резервная копия JSON включает настройки, словарик, выделения и заметки
- Конфиденциальность по умолчанию — данные остаются в браузере, никакого трекинга; интерфейс на 9 языках, все горячие клавиши настраиваются
```
