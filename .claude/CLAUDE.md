# Pinboard Bookmark Plus 项目配置

作者：wwj
更新：2026-04-01

## 项目概述

Chrome Extension (Manifest V3)，一键将当前页面保存到 Pinboard，支持多 LLM 提供商的 AI 标签生成与摘要功能。

## 技术栈

| 层级 | 技术 |
|------|------|
| 平台 | Chrome Extension Manifest V3 |
| 语言 | Vanilla JavaScript（无框架、无构建步骤） |
| 存储 | Chrome Storage API（sync + local） |
| AI | OpenAI / Anthropic / Gemini / DeepSeek / Qwen / MiniMax / OpenRouter / Ollama |

## 目录结构

```
.
├── manifest.json      # MV3 配置
├── background.js      # Service Worker（图标状态、书签检测、缓存）
├── popup.html/js/css  # 主弹出界面
├── options.html/js    # 设置页面
└── icons/             # 图标资源（16~128px，默认/已保存两种状态）
```

## 开发约定

| 约定 | 说明 |
|------|------|
| 加载方式 | `chrome://extensions/` → 加载已解压的扩展，选择项目根目录 |
| 无构建流程 | 直接编辑源文件，刷新扩展即可生效 |
| 存储分层 | 设置用 `chrome.storage.sync`，缓存用 `chrome.storage.local` |
| 书签缓存 | URL 书签状态 TTL 为 5 分钟 |
| 提示词模板变量 | `{{title}}`、`{{url}}`、`{{content}}`、`{{lang_instruction}}` |
| 图标状态 | 区分 default（未收藏）和 saved（已收藏）两套图标 |

## API 规范

- Pinboard API v1：通过 `auth_token` 认证
- AI 请求统一走各 provider 的 chat completion 接口
- 所有 API key 存储在 `chrome.storage.sync`，不能硬编码

## 与 Claude Code 协作

### 期望你主动做的

- 发现 JS 中的类型隐患和潜在 Bug（null 判断、异步错误处理）
- 指出 Chrome Extension API 的使用限制（MV3 Service Worker 生命周期）
- 补充缺失的 try/catch，尤其是 fetch 调用和 chrome API 调用

### 不希望你做的

- 不要将项目迁移到框架或引入构建工具（保持零依赖）
- 不要过度拆分文件（当前单文件结构是刻意为之）
- 不要添加未要求的功能
- 不要主动创建文档文件
