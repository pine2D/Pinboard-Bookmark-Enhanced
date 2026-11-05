# 书签增强

[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

支持 [Pinboard](https://pinboard.in)、Karakeep 和 linkding 的 Chrome 扩展：AI 标签与摘要、带翻译和高亮的阅读器，以及 13 套 pinboard.in 站点主题。

> **说明：** 在设置中选择一种书签服务。使用 Karakeep 或 linkding 无需 Pinboard 账号。Pinboard 是独立的**付费**服务，使用时需自备账号和 API Token。本扩展是第三方客户端，与 Pinboard 官方无关，未获其赞助或认可。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![AI 生成标签和摘要后保存，深色与浅色主题](docs/screenshots/readme/hero.webp)

[![1 分钟视频介绍：保存、阅读、留存](docs/screenshots/readme/promo-video.webp)](https://youtu.be/f3F8Se2rnoc)

---

## 功能特性

### 保存
- **保存到你选的服务**：Pinboard、Karakeep 或 linkding，标题、描述和选中文本自动填好。
- **AI 标签与摘要**：根据文章正文给出建议，使用你自己的 API Key。
- **断网也能保存**：书签先进离线队列，恢复联网后自动提交。

### 阅读
- **任何网页都能变成清爽的阅读器**：去掉广告和侧边栏，支持五色高亮与笔记。
- **双语对照阅读**：整页翻译，原文就在旁边。
- **向文章提问**：回答附带引用，点一下就跳到原句。
- **就地查词**：不离开页面就能看释义和发音，生词可发到 Anki。
- **边读边看**：YouTube 和 B 站视频旁边配上随播放滚动的字幕。

![清爽阅读器：双语对照、五色高亮与笔记](docs/screenshots/readme/reader.webp)

![向文章提问，回答附带引用](docs/screenshots/readme/ask.webp)

![YouTube 预览：字幕随播放滚动](docs/screenshots/readme/video.webp)

### 留存
- **留下的内容都在资料库**：高亮、笔记、生词和以往的问答集中在一处，通过你自己的 Google Drive 同步。
- **发送或下载**：发到 [Obsidian](https://obsidian.md)、Notion 等，或下载为 `.md`、`.html`、`.epub`。

![笔记页：同一篇文章的高亮连成摘录流](docs/screenshots/readme/notes.webp)

![生词详情：原文语境与词典参考栏](docs/screenshots/readme/vocab.webp)

### 个性化 Pinboard
- **13 套 pinboard.in 主题**：Dracula、Nord、Catppuccin 等，还能叠加自定义 CSS。
- **标签治理**：合并近似标签，清理不常用的标签。
- **自动存档到 [Wayback Machine](https://web.archive.org)**：保存过的网页，原链接失效后仍能找回。

![13 套 pinboard.in 主题](docs/screenshots/readme/themes.webp)

## 安装

**[→ 从 Chrome 网上应用店安装](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)**（推荐）

或从 release ZIP 手动加载：
1. 下载最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解压
3. `chrome://extensions/` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择解压后的目录

然后打开**设置 → 账号**，连接书签服务：Pinboard 填 [API Token](https://pinboard.in/settings/password)；Karakeep（0.31 或更高版本）或 linkding 填服务器地址和 API Token。

## 隐私

零追踪、零分析、零遥测。设置和凭据默认只存在本机，开启同步后才会离开这台设备；同步的凭据只做混淆，没有加密。AI 请求只在你使用 AI 功能时发出，且只发往你配置的服务商。除 Pinboard 外，扩展需要访问的其他站点都在你首次使用相应功能时逐个申请。Google Drive 中的副本存放在扩展的私有应用文件夹里，未经端到端加密。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 许可证

MIT，见 [LICENSE](LICENSE)。
