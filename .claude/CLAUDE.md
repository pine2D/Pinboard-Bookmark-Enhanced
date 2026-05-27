# Pinboard Bookmark Enhanced 项目配置

作者：pine2D
更新：2026-05-27

## 项目概述

Chrome Extension (Manifest V3)，一键将当前页面保存到 Pinboard，支持多 LLM 提供商的 AI 标签生成与摘要功能，并自带 13 套 pinboard.in 站点主题（GitHub Light、Dracula、Catppuccin、Nord、Solarized、Flexoki、Terminal 等）。

## 技术栈

| 层级 | 技术 |
|------|------|
| 平台 | Chrome Extension Manifest V3 |
| 语言 | Vanilla JavaScript（无框架、无构建步骤） |
| 存储 | Chrome Storage API（sync + local） |
| AI providers | OpenAI / Anthropic / Gemini / DeepSeek / Qwen / MiniMax / OpenRouter / Groq / Mistral / Cohere / SiliconFlow / Zhipu (BigModel) / Moonshot / Ollama (local) |
| 页面正文抽取 | [Defuddle](vendor/) (本地化部署，懒注入) |
| 备用抽取 | Jina Reader API (r.jina.ai) |
| 主题生产 | 自建 theme factory（`docs/theme-surface/`） |

## 目录结构

```
.
├── manifest.json                # MV3 配置（permissions / host_permissions / 入口）
├── background.js                # Service Worker（图标状态、书签检测、URL 缓存、storage 预热）
│
├── popup.html/css/js            # 主弹出界面
├── popup-ai.js                  # AI 标签/摘要请求 + 各 provider 适配
├── popup-batch.js               # 批量保存操作
├── popup-offline.js             # 离线兜底
├── popup-tags.js                # 标签自动补全 + suggested tags
├── popup-theme-early.js         # 主题 bootstrap（防止 FOUC）
│
├── options.html/css/js          # 设置页
├── options-api-tests.js         # 各 provider 联通性测试 UI
├── options-backup.js            # 设置导出/导入
├── options-theme-early.js       # 同 popup
│
├── md-preview.html/css/js       # AI 摘要的 markdown 预览弹窗
├── ai.js                        # AI 调用核心（被 popup.html + options.html 共载）
├── shared.js                    # 跨文件常量 + 工具（含 $id 记忆化 DOM 缓存）
├── jina.js                      # Jina Reader fallback
├── i18n.js                      # 多语言
├── pinboard-style.js            # 注入 pinboard.in 站点主题 CSS
├── pinboard-themes.js           # 13 套主题 CSS preset（theme factory 产物，588KB）
│
├── icons/                       # 图标资源（16~128px，default / saved 两种状态）
├── _locales/                    # i18n 字符串（en / zh-CN / zh-HK / zh-TW / ja / de / fr / pl / ru）
├── vendor/                      # Defuddle 本地化（懒注入到 content script）
│
├── docs/                        # GitHub Pages + theme factory
│   ├── theme-surface/           # ← 主题工厂（重要架构）
│   │   ├── composers/           # 布局模板（classic-list-v2 主力 + 4 备用）
│   │   ├── pilots/              # 13 主题的 tokens.json（输入）
│   │   ├── tools/               # 5 道 lint + sync-all 同步管道
│   │   ├── manifest.json        # surface inventory
│   │   ├── tokens.schema.json   # tokens 校验
│   │   └── NEW_THEME.md         # 新主题脚手架文档
│   └── superpowers/             # 内部规划草稿（gitignored）
│
└── scripts/                     # 发布工具链
    ├── bump-version.sh          # 按 commit 类型自动 bump（feat→minor / fix→patch）
    ├── release.sh               # 打 ZIP + 创建 GH release + changelog + 刷 camo cache
    ├── pre-commit-hook.sh       # 5 道 lint（见下）
    ├── commit-msg-hook.sh       # conventional commits 检查
    ├── setup-hooks.sh           # 安装 hooks
    └── update-vendor.sh         # 更新 Defuddle 版本
```

## 开发约定

| 约定 | 说明 |
|------|------|
| 加载方式 | `chrome://extensions/` → 加载已解压的扩展，选择项目根目录 |
| 无构建流程 | 直接编辑源文件，刷新扩展即可生效（vendor/ 例外，由脚本同步） |
| 存储分层 | 设置用 `chrome.storage.sync`，缓存/状态用 `chrome.storage.local` |
| 书签缓存 | URL 书签状态 TTL 为 5 分钟 |
| Storage prime | 冷启动慢，靠 `chrome.alarms` 周期性预热 SETTINGS_DEFAULTS |
| 提示词模板变量 | `{{title}}`、`{{url}}`、`{{content}}`、`{{lang_instruction}}` |
| 图标状态 | 区分 default（未收藏）和 saved（已收藏）两套图标 |
| DOM 查询 | 用 `shared.js` 的 `$id(id)`（记忆化），不要 `document.getElementById` |
| Commit message | conventional commits（feat / fix / refactor / perf / docs / style / chore），英文 |

## Theme Factory 工作流

`docs/theme-surface/` 是 token-driven 的主题生成系统，13 套 preset 都从 `pilots/*.tokens.json` 经 composer 渲染出来，最终写入 `pinboard-themes.js`。

**编辑顺序**：改 `composers/*.mjs` 或 `pilots/*.tokens.json` → 跑 `node docs/theme-surface/tools/sync-all.mjs`（render → apply 到 pinboard-themes.js → drift 验证）→ commit。**禁止直接手工编辑 `pinboard-themes.js`**（会被 handedit-audit 拦截）。

**Pre-commit 5 道 lint**（任一红就 block，全部禁止 `--no-verify`）：
1. `diff-all --strict` — composer 输出 vs shipped 字符级一致
2. `token-coverage` — 所有 `v("...")` token 引用都解析得到
3. `cascade-lint` — CSS cascade 模拟（13 主题 × 15 探针，含 flexoki dark mode）
4. `override-drift` — 主题 overrides 不重新拉宽 composer 的 `:not(...)` 限定
5. `handedit-audit` — `pinboard-themes.js` 里没有 composer 不产出的规则

新主题脚手架：`docs/theme-surface/NEW_THEME.md`。

## 发布流程

```bash
# 1. 改完代码 + commit（pre-commit 会跑全套 lint）
git commit -m "fix(...): ..."

# 2. 按 commit 类型自动 bump manifest 版本
bash scripts/bump-version.sh

# 3. push
git push origin main

# 4. release（打 ZIP + GitHub release + 自动生成 changelog）
bash scripts/release.sh
```

## API 规范

- Pinboard API v1：通过 `auth_token` 认证
- AI 请求统一走各 provider 的 chat completion 接口
- 所有 API key 存储在 `chrome.storage.sync`，不能硬编码
- Defuddle 在 popup 打开时**懒注入**，避免冷启动开销

## 与 Claude Code 协作

### 期望你主动做的

- 发现 JS 中的类型隐患和潜在 Bug（null 判断、异步错误处理）
- 指出 Chrome Extension API 的使用限制（MV3 Service Worker 生命周期）
- 补充缺失的 try/catch，尤其是 fetch 调用和 chrome API 调用
- 改 theme 时走 composer + sync-all + lint 链路，不动 `pinboard-themes.js`

### 不希望你做的

- 不要将项目迁移到框架或引入构建工具（保持零依赖）
- 不要过度拆分文件（当前结构是刻意为之）
- 不要添加未要求的功能
- 不要主动创建文档文件
- 不要在 `pinboard-themes.js` 里手工加 CSS 规则
- 不要 `--no-verify` 绕过 pre-commit
