# Pinboard 书签增强

[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

全面增强 [Pinboard](https://pinboard.in) 书签体验的 Chrome 扩展：AI 智能标签、自动摘要，以及全套可定制主题界面。

> **说明：** 本扩展是 [Pinboard](https://pinboard.in)（一项**付费**书签服务）的独立第三方客户端。使用前需要你自己的 Pinboard.in 账号及 API token。本项目与 Pinboard 官方无关。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 功能特性

- **智能填表** — 自动填充标题、URL、页面描述、来源链接和选中文本，并在保存或粘贴时去除 URL 里的追踪参数（`utm_*`、`gclid`、`fbclid`、…），支持激进模式和自定义保留/移除列表
- **AI 标签与摘要** — 自备 API key 接入 13 家主流 LLM 服务商，或任意 OpenAI 兼容接口；AI 读取的是去除广告、菜单、侧边栏后的纯净正文
- **标签助手** — 从你自己的标签、Pinboard 建议标签和一键标签预设中自动补全
- **快速保存** — 用快捷键直接保存当前页（或保存为*稍后阅读*），无需打开弹窗；也可批量保存所有打开的标签页，每个标签独立 AI 打标签并实时显示进度，还能打包成一个 Tab Set
- **查找与回顾** — 搜索你的书签，快速跳转到 Unread / Network / Notes / Popular，浏览最近保存；当前页若已收藏，工具栏图标会自动切换状态
- **离线队列** — 离线保存的草稿留在本地，重新联网时自动同步
- **`pinboard.in` 主题** — 13 套精心调优的配色（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …），外加自定义 CSS 覆盖层，多设备同步，弹窗宽度可调
- **当前页转 Markdown** — 把当前网页转成干净的 Markdown，内置预览（渲染/源码切换、目录、阅读统计）；可复制或下载为 `.md` 或带样式的 `.html`，可调整 front-matter、图片处理与目录，也可按需导出到 [Obsidian](https://obsidian.md)；后端可选 [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（本地）或 [Jina Reader](https://jina.ai/reader)（云端）
- **9 种语言**、可自定义快捷键、零追踪

## 安装

**[→ 从 Chrome 网上应用店安装](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推荐

或从 release ZIP 手动加载：
1. 下载最新的 [release ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. 解压
3. `chrome://extensions/` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择解压后的目录

安装完成后：点击工具栏图标 → 粘贴你的 [Pinboard API token](https://pinboard.in/settings/password) → 保存

## 隐私

零追踪、零分析、零遥测。所有数据通过 `chrome.storage` 保存在你的本机。AI 请求**仅**在你点击"AI 标签"或"AI 摘要"时触发，并直接发送到你配置的服务商。完整政策：<https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## 许可证

MIT — 见 [LICENSE](LICENSE)。
