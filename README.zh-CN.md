# Pinboard 书签增强

[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

全面增强 [Pinboard](https://pinboard.in) 书签体验的 Chrome 扩展：AI 智能标签、自动摘要，以及全套可定制主题界面。

> **说明：** 需要 Pinboard.in 账号 —— Pinboard（pinboard.in）是一项独立的**付费**书签服务。本扩展是第三方客户端，使用你自己的 Pinboard API token 连接到你已有的 Pinboard 账号。本项目与 Pinboard 官方无关，未获其赞助或认可。你必须已经拥有（或注册）一个付费的 Pinboard.in 账号才能使用本扩展。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 功能特性

- **智能填表** — 自动填充标题、URL、页面描述、来源链接和选中文本，并在保存或粘贴时去除 URL 里的追踪参数（`utm_*`、`gclid`、`fbclid`、…），支持激进模式和自定义保留/移除列表
- **快速保存与批量保存** — 用快捷键直接保存当前页（或保存为*稍后阅读*），无需打开弹窗；也可批量保存所有打开的标签页，每个标签独立 AI 打标签、实时显示进度，并打包成一个 Tab Set；离线时草稿进入队列，重新联网时自动同步
- **AI 标签与摘要** — 自备 API key 接入 13 家主流 LLM 服务商，或任意 OpenAI 兼容接口；AI 读取的是去除广告、菜单、侧边栏后的纯净正文
- **标签工具** — 从你自己的标签、Pinboard 建议标签和一键标签预设中自动补全；还有标签治理面板，找出重复和低频标签（启发式 + 按需 AI 聚类），限流分批合并并实时显示进度
- **快速入口与状态** — 一键直达 Unread、Network、Notes、Popular 页面；当前页若已收藏，工具栏图标会自动切换状态
- **当前页转 Markdown** — 把当前网页转成干净的 Markdown，内置预览（渲染/源码切换、目录、阅读统计）；可复制或下载为 `.md` 或带样式的 `.html`，可调整 frontmatter（含作者、发布日期、站点、封面图与字数统计）、图片处理与目录，也可直接导出到 [Obsidian](https://obsidian.md)、GitHub Gist，或任意 webhook（兼容 Readwise）。站点感知抽取让问答和论坛贴保持可读（知乎、Hacker News、Stack Overflow、…）；后端可选 [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（本地）或 [Jina Reader](https://jina.ai/reader)（云端）
- **向页面提问与翻译** — 在 Markdown 预览里向页面提问，获得带可核查引用的流式回答（点击引用即跳到原文出处），就地解读或翻译任意选中段落（并可将结果存为笔记），也可将整页翻译，配有自定义术语表、实时用量统计，以及原文 / 双语 / 译文三种视图
- **阅读工具** — 五色高亮且笔记在重新渲染和翻译后依然保留、在 Notebook 面板中浏览高亮、搜索文章（`/`，可选正则 —— 笔记内容也一并匹配）、就地查看脚注、随时接续上次读到的位置、开启专注模式获得清爽的无干扰阅读体验，或启用默认关闭的 AI 要点摘要；按 `?` 查看完整快捷键列表
- **自动存档** — 可选：保存时把网页一并存入互联网档案馆的 [Wayback Machine](https://web.archive.org)（附存档日志与重试），原网页日后失效也能找回
- **`pinboard.in` 主题** — 13 套精心调优的配色（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …），外加多设备同步的自定义 CSS 覆盖层、可调的弹窗宽度，以及标签页按热度排序
- **9 种语言**、可自定义快捷键、本地优先存储、零追踪

## 安装

**[→ 从 Chrome 网上应用店安装](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推荐

或从 release ZIP 手动加载：
1. 下载最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解压
3. `chrome://extensions/` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择解压后的目录

安装完成后：点击工具栏图标 → 粘贴你的 [Pinboard API token](https://pinboard.in/settings/password) → 保存

## 隐私

零追踪、零分析、零遥测。所有数据默认通过 `chrome.storage` 保存在你的本机；若开启设置同步，你的设置（不含书签内容）会通过 Chrome 账号在你的设备间同步。AI 请求**仅**在你主动触发某个 AI 操作时才会发出——AI 标签/摘要、页面问答、翻译、选中段落解读，或可选启用的 AI 要点摘要——并直接发送到你配置的服务商。扩展页面强制执行严格的内容安全策略（Content-Security-Policy，禁止远程代码）。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 许可证

MIT — 见 [LICENSE](LICENSE)。
