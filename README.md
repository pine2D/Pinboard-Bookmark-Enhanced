# Pinboard Bookmark Plus

> 🔖 A modern Chrome extension for Pinboard — bookmark smarter with AI-powered tags and summaries.
>
> 🔖 一款现代化的 Pinboard Chrome 扩展 —— 借助 AI 智能生成标签与摘要，让书签管理更高效。

![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-2.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features / 功能特性

### 📌 Core Bookmarking / 核心书签功能

- **One-click save** — Quickly save the current page to Pinboard with title, URL, tags, and description.
  一键保存当前页面到 Pinboard，包含标题、URL、标签和描述。

- **Editable URL** — URL field is fully editable, allowing you to modify the link before saving.
  URL 字段可自由编辑，保存前可修改链接地址。

- **Duplicate detection** — Automatically detects if the current URL has already been bookmarked, and switches to edit mode.
  自动检测当前 URL 是否已收藏，若已存在则切换为编辑模式。

- **Private & Read Later** — Toggle private/public and "read later" flags per bookmark, with configurable defaults.
  支持逐条设置私有/公开和"稍后阅读"标记，可配置默认值。

- **Selected text as description** — Automatically captures selected text on the page and uses it as the bookmark description (optionally wrapped in `<blockquote>`).
  自动捕获页面选中文本作为书签描述（可选 `<blockquote>` 包裹）。

### 🤖 AI-Powered / AI 智能功能

- **AI tag suggestions** — Automatically generate relevant tags based on page content using LLM.
  基于页面内容，利用大语言模型自动生成相关标签建议。

- **AI summary generation** — Generate concise descriptions/summaries for bookmarks with one click.
  一键生成书签的简洁描述/摘要。

- **Multi-provider support** — Compatible with a wide range of AI providers:
  支持多种 AI 服务商：

  | Provider | Models |
  |----------|--------|
  | OpenAI | GPT-4o, GPT-4o-mini, etc. |
  | Anthropic | Claude series |
  | Google Gemini | Gemini series |
  | DeepSeek | DeepSeek series |
  | Alibaba Qwen | Qwen series |
  | MiniMax | MiniMax models |
  | OpenRouter | Access 100+ models |
  | Local (Ollama) | Any local model |

- **Customizable prompts** — Fully editable system prompts for both tag generation and summary generation.
  标签生成和摘要生成的系统提示词均可完全自定义。

- **Existing tags integration** — AI can reference your existing Pinboard tags to maintain consistency.
  AI 可参考你已有的 Pinboard 标签，保持标签体系一致性。

### 📑 Tab Set / 标签组功能

- **Save Tab Set** — Save all open tabs as a Pinboard tab set with one click.
  一键将所有打开的标签页保存为 Pinboard 标签组。

- **View Tab Sets** — Quick link to view saved tab sets on Pinboard.
  快速跳转查看已保存的标签组。

### ⚙️ Settings / 设置选项

- **General** — Default privacy, read later, blockquote wrapping, incognito behavior.
  通用设置 — 默认隐私、稍后阅读、引用包裹、隐身模式行为。

- **API Keys** — Manage Pinboard token and AI provider API keys in one place.
  API 密钥 — 集中管理 Pinboard 令牌和各 AI 服务商密钥。

- **AI Settings** — Choose provider, model, temperature, max tokens, and tag/summary language.
  AI 设置 — 选择服务商、模型、温度、最大 token 数及标签/摘要语言。

- **Prompts** — Customize system prompts for tag and summary generation.
  提示词 — 自定义标签和摘要生成的系统提示词。

---

## 📸 Screenshots / 截图

> _Add your screenshots here / 在此添加截图_
>
> ```
> ![Main popup](screenshots/popup.png)
> ![Settings](screenshots/settings.png)
> ```

---

## 🚀 Installation / 安装

### From source / 从源码安装

1. Clone or download this repository:
   克隆或下载本仓库：

   ```bash
   git clone https://github.com/YOUR_USERNAME/pinboard-bookmark-plus.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`
   打开 Chrome，访问 `chrome://extensions/`

3. Enable **Developer mode** (top right toggle)
   启用右上角的 **开发者模式**

4. Click **Load unpacked** and select the extension folder
   点击 **加载已解压的扩展程序**，选择扩展文件夹

5. Pin the extension to your toolbar for easy access
   将扩展固定到工具栏以便快速访问

### Prerequisites / 前置条件

- A [Pinboard](https://pinboard.in) account
  一个 Pinboard 账户

- Your Pinboard API token (found at [settings/password](https://pinboard.in/settings/password))
  你的 Pinboard API 令牌（在 [settings/password](https://pinboard.in/settings/password) 获取）

- *(Optional)* An API key from any supported AI provider for smart tagging & summaries
  *（可选）* 任一支持的 AI 服务商的 API 密钥，用于智能标签和摘要功能

---

## ⚡ Usage / 使用方法

1. Click the extension icon on any webpage.
   在任意网页上点击扩展图标。

2. The title, URL, and description are auto-filled.
   标题、URL 和描述会自动填充。

3. Click **AI Tags** to generate smart tag suggestions, or enter tags manually.
   点击 **AI Tags** 生成智能标签建议，或手动输入标签。

4. Click **AI Summary** to generate a description from page content.
   点击 **AI Summary** 从页面内容生成描述。

5. Toggle **Private** / **Read Later** as needed.
   根据需要切换 **私有** / **稍后阅读**。

6. Click **Save** to bookmark.
   点击 **Save** 保存书签。

---

## 🔒 Privacy / 隐私说明

- All API keys and tokens are stored **locally** in `chrome.storage.local` — never sent to any third-party server.
  所有 API 密钥和令牌均 **本地存储** 于 `chrome.storage.local`，绝不发送至任何第三方服务器。

- Page content is only sent to **your chosen AI provider** when you explicitly click the AI buttons.
  页面内容仅在你主动点击 AI 按钮时发送至 **你选择的 AI 服务商**。

- No analytics, no tracking, no data collection.
  无分析、无追踪、无数据收集。

---

## 🛠️ Tech Stack / 技术栈

- Chrome Extension Manifest V3
- Vanilla JavaScript (no framework dependencies)
- Pinboard API v1
- Multiple LLM provider APIs

---

## 📄 License / 许可证

[MIT License](LICENSE)

---

## 🙏 Acknowledgments / 致谢

- [Pinboard](https://pinboard.in) by Maciej Cegłowski
- Inspired by the original [Pinboard Chrome extension](https://pinboard.in/resources/)