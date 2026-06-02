# Pinboard Bookmark Enhanced 项目配置

作者：pine2D
更新：2026-06-02

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

### Release 打包规则（release.sh）

`release.sh` 自动扫描 + sanity check，不再硬编码文件清单：

- **自动包含**（root 下匹配 glob）：`*.html` / `*.js` / `*.css` / `manifest.json`
- **递归包含目录**：`vendor/` / `icons/` / `_locales/`
- **显式排除**：
  - `url-strip-tests.html`（dev 测试页）
  - `perf-baseline.json` / `perf-after-*.json`（measurement 数据）
  - `*.md` / `LICENSE`（文档）
  - 隐藏文件/目录（`.git/` / `.claude/` / `.qa-scan/` 等）
  - 项目目录 `scripts/` / `docs/` / `release/`（不在 INCLUDE_DIRS 里自动 skip）
- **Sanity check**：扫 `manifest.json` 的 `background.service_worker` / `content_scripts.js+css` / `action.default_popup` / `options_page`，再扫所有 included HTML 的 `<script src>` / `<link href>`，**断言**每个引用都在 ZIP 内。少一个就 release.sh exit 1。

**新增扩展运行时文件时**：只要文件落在 root 且 `.js` / `.html` / `.css` 后缀，自动被 release.sh 包含——无需手动改脚本。Sanity check 会兜底报错。

**新增其他类型的运行时资源**（如 `themes/*.js` / 子目录 / 非 `.js`/`.html`/`.css` 后缀的文件）：必须更新 `scripts/release.sh` 的 `INCLUDE_DIRS` 或 `TOP_LEVEL_PATTERNS`。

### Release ZIP smoke test

`release.sh` 在 ZIP 构建后、`gh release create` 前会自动跑 `scripts/zip-install-smoke.mjs`：

- 解压 ZIP 到临时目录
- 用 Playwright bundled Chromium + `--load-extension` 安装该 ZIP
- 校验 Service Worker 注册成功（catch importScripts 404 等）
- 校验 popup.html 打开无 pageerror（catch `ReferenceError` 等）
- 校验 options.html 打开无 pageerror
- 任一失败 → release.sh 中止，不发 GitHub release

**跳过 smoke**：`bash scripts/release.sh --skip-smoke`（仅在调试 release 脚本本身时使用）

**单独运行 smoke**：`node scripts/zip-install-smoke.mjs` 默认拿 release/ 里最新 ZIP；`--zip <path>` 指定。

**前置**：`.qa-scan/` 装好 playwright + bundled Chromium（`cd .qa-scan && npm install && npx playwright install chromium`）。

## API 规范

- Pinboard API v1：通过 `auth_token` 认证
- AI 请求统一走各 provider 的 chat completion 接口
- 所有 API key 存储在 `chrome.storage.sync`，不能硬编码
- Defuddle 在 popup 打开时**懒注入**，避免冷启动开销

## 性能与踩坑（hard-won，改 UI / SW / 字体前必读）

> 真实事故的根因沉淀，**勿重新引入**。机制依据：Blink fonts README、crbug 1266022/491556、developer.chrome.com（SW lifecycle / storage / CSP / alarms）、web.dev（content-visibility / style 计算）。

### 字体回退卡顿（2026-06 根因）

popup/options 是**短命单次渲染、无暖 shape cache**——首屏要付满「字体匹配 + 回退 + HarfBuzz shaping + 字体首次加载」成本。任何「UI 文本回退到一个大/慢字体」都会在高 DPI Windows 上造成 **1-3s 冻结**（计入 Rendering / Recalc+Layout，Paint 反而很小）。已踩中三种形态，对应三条铁律：

| 形态 | 机制 | 铁律 |
|------|------|------|
| emoji / dingbat（⚠ ✓ ✗ ✕ ↻ ▸ ▾ ℹ …） | 回退到 Segoe UI Emoji 彩色字体，首次加载 ~1.6s | UI 里**一律内联 SVG**（`PBP_ICONS` / `setBtnIcon` / `setStatusIcon` / CSS 三角），**禁止字面 emoji/符号字符**。`U+FE0E`(VS15) 和 `font-variant-emoji:text` 在 Chrome 实测**无效**，别依赖 |
| CJK 正文 | font-family 只列拉丁字体 + 通用 `sans-serif` → 中文回退到 profile 的 **Standard 字体**（用户可能设了大 CJK 字体如 Sarasa） | body font-family **必须在 `sans-serif` 前显式列快 CJK 字体**：`"PingFang SC","Microsoft YaHei","Hiragino Sans","Noto Sans CJK SC"` |
| 等宽 | 裸 `monospace` 关键字 → profile 的 **Fixed-width 字体** | 用显式栈 `ui-monospace,"SF Mono",Consolas,monospace`，**禁止裸 `monospace`** |

**测量陷阱**：chrome-dbg / 已打开的页面是**暖态**，测不到冷首屏（同代码暖态 ~3ms vs 日常 Chrome 1.7s）。判定：第二次操作就快 = 一次性冷成本；**只能在用户真实机器冷启动验证**。预热（idle 强制 layout）会阻塞主线程造成「看着渲染完却卡死」，**不可取**——优先消除慢字体回退这个根因。热路径避免 `:has()` 等慢选择器；超长面板可考虑 `content-visibility:auto`。

### MV3 不变量（改 background.js / 存储 / manifest 前别破坏）

- **SW 无持久状态**：30s idle 即终止、全局变量被清空。状态一律落 `chrome.storage`，每个 handler 开头重读；全局只作单次调用内的暖缓存。
- **监听器顶层同步注册**：`chrome.*.on*` 与 `importScripts` 只能在 SW 顶层同步执行；async 注册在 MV3 不保证生效。
- **存储分层**：设置→`sync`（单 item ≤8KB、总 ~100KB、写入限流；写后查 `lastError`）；缓存/大/瞬态→`local`（已用 `chrome.alarms` 最小 30s 预热 SETTINGS_DEFAULTS）。
- **消息异步响应**：`onMessage` 里 `return true` 保持通道，且**别**把该 listener 设成 `async`（二者只能取一）。
- **CSP**：禁 `eval`/远程代码；只能远程取**数据**（JSON/CSS）。Defuddle 因此本地 vendor。
- **content script**：仅 `pinboard.in` 注入、保持瘦身；`document_start` 仅主题注入需要。
- **setIcon**：仅状态真正变化时调用 + 缓存 ImageData，别每个 tab 事件重新 fetch PNG（见 `9b689c1` 回归修复）。

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
