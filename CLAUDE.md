# Pinboard Bookmark Enhanced 项目配置

作者：pine2D
更新：2026-07-11

## 项目概述

Chrome Extension (Manifest V3)，一键将当前页面保存到 Pinboard，支持多 LLM 提供商的 AI 标签生成、摘要、全文翻译、Ask-the-page 问答与 opt-in 要点提炼（skim），md-preview 阅读器带划词高亮/笔记/搜索/专注模式，导出可 Send-to Obsidian/Gist/Webhook，可选 Wayback 自动归档与标签治理，并自带 13 套 pinboard.in 站点主题（GitHub Light、Dracula、Catppuccin、Nord、Solarized、Flexoki、Terminal 等）。

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
├── options-connectivity.js      # 各 provider 联通性测试 UI（运行时，非 dev 测试页）
├── options-backup.js            # 设置导出/导入
├── options-theme-early.js       # 同 popup
│
├── md-preview.html/css/js       # markdown 预览弹窗（摘要 / 全文翻译 / Ask-the-page / 阅读器）
├── md-ai-core.js                # md-preview AI 公共层（block 索引、占位符 shield、流式 JSON 解析、IDB 缓存）
├── md-translate.js              # md-preview 全文翻译（术语抽取 + 占位符守恒质量门 + 批队列 + 双语视图）
├── md-ask.js                    # md-preview Ask-the-page 问答（引用 chip 管线）
├── md-highlight.js              # 划词高亮（五色 + 笔记 + Notebook 面板 + 重渲染/翻译锚定恢复）
├── md-reader.js                 # 阅读工具（`/` 搜索含正则、脚注浮层、静默回位、`?` 快捷键帮助、专注模式）
├── md-skim.js                   # AI 要点层（设置 opt-in，默认关——生成消耗 token）
├── ai-cache.js                  # md-preview AI 结果 IDB 缓存（全局 200 条 LRU，tr_/ask_/skim_ 共享）
├── md-preview-theme-early.js    # md-preview 明暗 bootstrap（跟随 optTheme，防白闪，同 popup 模式）
├── md-convert.js                # markdown 转换中枢（marked→DOMPurify 单点 sanitize + 导出 + frontmatter/byline）
├── md-embed.js                  # 导出图片离线内嵌（扫描/预算/并发抓取远程图转 data URI 或 fetched Map，供 .md/.html/EPUB 导出复用）+ 防盗链修复取图（pbpImgFixWithReferer：向 SW 申请规则 → 带 Referer 重取）
├── md-epub.js                   # 单文章 EPUB 打包（纯层 zip/OPF/nav/XML 转义 + 运行时 XHTML 序列化与 DOM 派生目录 pbpBuildEpub）
├── export-targets.js            # Send-to 目标注册表（Obsidian / GitHub Gist / Webhook；纯层，测试页可载）
├── md-export-send.js            # Send-to 运行时（权限请求 + 预检 + 发送 + 剪贴板兜底）
├── ai.js                        # AI 调用核心（被 popup.html / options.html / md-preview.html 共载）
├── shared.js                    # 跨文件常量 + 工具（含 $id 记忆化 DOM 缓存）
├── jina.js                      # Jina Reader fallback
├── i18n.js                      # 多语言
├── tag-gov.js                   # 标签治理（重复/低频聚类 + 节流批量合并）
├── wayback.js                   # Wayback Machine 自动归档（队列 + 日志 + 重试）
├── site-rules.js                # 站点抽取适配器（Zhihu / HN / SO / arXiv…，注入并先于 Defuddle 运行）
├── pinboard-style.js            # 注入 pinboard.in 站点主题 CSS
├── pinboard-sort.js             # pinboard.in 标签页热度排序（第二段 content script，document_idle）
├── pinboard-themes.js           # 13 套主题 CSS preset（theme factory 产物，588KB）
│
├── icons/                       # 图标资源（16~128px，default / saved 两种状态）
├── _locales/                    # i18n 字符串（en / zh-CN / zh-HK / zh-TW / ja / de / fr / pl / ru）
├── vendor/                      # Defuddle 本地化（懒注入到 content script）
├── tests/                       # dev 测试页（md-ai / md-convert / export-targets，file:// 直开；不入 release ZIP）
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
| 存储分层 | `optSyncEnabled` 始终存于 `chrome.storage.local` 且按设备生效；普通设置按该标志选择 `sync` / `local`。凭据另受账号级 `syncApiKeys` 控制，但仅本机设置同步开启时参与；缓存、状态与离线队列始终用 `local` |
| 书签缓存 | URL 书签状态 TTL 为 5 分钟 |
| Storage prime | 冷启动慢，靠 `chrome.alarms` 周期性预热 SETTINGS_DEFAULTS |
| 提示词模板变量 | `{{title}}`、`{{url}}`、`{{content}}`、`{{lang_instruction}}` |
| 图标状态 | 区分 default（未收藏）和 saved（已收藏）两套图标 |
| DOM 查询 | 用 `shared.js` 的 `$id(id)`（记忆化），不要 `document.getElementById`；**例外**：`md-preview.html` 加载 shared.js（供 `SETTINGS_DEFAULTS`/`deobfuscate*` 使用），但 `md-preview.*` 与 `md-*.js` 仍一律用原生 `document.getElementById`，不用 `$id` |
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

### 发版前文档核查（硬规则）

每次发版前核查三件套是否与新功能同步：**README.md（×9 locale 逐行镜像，同 commit 内更新）/ CLAUDE.md / docs/privacy.md（隐私政策）**。新增任何数据出口（新 API 调用、新导出目标、新 AI 触发面）时，privacy.md 的 Network Requests / Permissions / Third-Party 三处必须同步披露。`release.sh` 内置硬门：自上个 tag 以来存在 feat commit 而三件套全部未改动时直接中止；确认确实无需更新后可用 `--docs-ok` 显式跳过。privacy.md 经 GitHub Pages 自动部署（push 即生效），不依赖扩展发版。

### Release 打包规则（release.sh）

`release.sh` 自动扫描 + sanity check，不再硬编码文件清单：

- **自动包含**（root 下匹配 glob）：`*.html` / `*.js` / `*.css` / `manifest.json`
- **递归包含目录**：`vendor/` / `icons/` / `_locales/`
- **显式排除**：
  - `tests/`（dev 测试页整目录——不在 INCLUDE_DIRS，自动 skip）
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
- **Pinboard 账号隔离不变量**：所有 Pinboard v1 请求在实际 dispatch 前必须原子重读有效凭据；同用户名 token 轮换时用新 token 重写请求，登出或跨用户名切换时取消且不得发网。任何由账号数据派生的 cache / message / preview payload / 持久任务必须携带非秘密 owner，并在读取、异步回写和 UI 提交时逐次校验 owner。
- AI 请求统一走各 provider 的 chat completion 接口
- API key、token、password 与导出目标凭据不能硬编码。新用户默认保存在 `chrome.storage.local`；仅当本机 `optSyncEnabled=true` 且账号级 `syncApiKeys=true` 时使用 `chrome.storage.sync`。旧云端已有非空 secret 时迁移保留 `syncApiKeys=true`，避免升级丢失凭据
- Defuddle 在 popup 打开时**懒注入**，避免冷启动开销；`site-rules.js` 与其成对注入且**先于** Defuddle 运行（命中站点规则即短路）
- **网络端点与 host 权限不变量**：required host 仅 Pinboard；AI / Jina / Wayback / Gist / Webhook / WebDAV 与 Batch 所选站点只在用户动作中请求当前精确 origin，后台/自动路径只做 `permissions.contains`，禁止运行时申请 wildcard。可配置网络端点必须 HTTPS，HTTP 仅允许字面 `localhost` / `127.0.0.1` / `[::1]`；LAN/public HTTP、凭据 URL 与无权限请求一律阻断并保留配置。升级时一次性清理 legacy all-sites grant。
- **防盗链图片修复不变量（`declarativeNetRequestWithHostAccess`，改 md-embed / background 规则代码前必读）**：部分 CDN（实测 cdnfile.sspai.com）**只拒空 Referer**，而扩展页只能发空 Referer（且预览对图片强制 `no-referrer`——这对更常见的"封外站/放空"型防盗链是正确默认，勿改）。修复=**SW 独占**的临时 DNR session rule：① rule id 由 SW 在保留段 786001-786999 内分配，**页面绝不自行分配**（id 是扩展全局的，页面局部计数器必然跨 tab 冲突）；② install / remove / sweep **全部走同一条串行队列**，install 在临界区内用 `tabs.get` 重核验该 tab 仍是**同一预览文档**（否则规则会落到已导航走的普通网站 tab 上）；③ 规则条件必须含 `initiatorDomains:[chrome.runtime.id]`——这是"普通网页请求不可能命中"的**结构性**保证，不是靠清扫抢时间；④ tab 作用域取自 `sender.tab`；删除做 (tab, 文档) owner-check——但 owner 表是 SW 内存态，**SW 重启后降级为仅 tab 校验**（同 tab 跨文档的 id 复用在那个窗口内仍可能误删，属已知残留风险，非不变量）；⑤ 清扫三路：tab 关闭 / 离开预览文档 / 预览页加载时自清（同 URL reload 不触发 `changeInfo.url`，靠第三路兜底）；⑥ 重试取图必须 `cache:"reload"`——失败的 `<img>` 已把 403 写进 HTTP 缓存，`force-cache` 会直接复用它导致规则形同虚设。自动修复只对**已授权 origin** 生效（`permissions.contains`，绝不 prompt），批次在首个 await 前**冻结**（否则等待授权期间新入队的未授权 origin 会混进自动批次）。`zip-install-smoke.mjs` check 5 守护其中五条：跨 tab id 唯一、跨 tab 删除被拒、非预览 tab 拒装、规则带 `initiatorDomains`、离开预览即清扫（**不覆盖** SW 重启后的同 tab 跨文档删除）。
- **关思考（thinking/reasoning）—— 勿凭记忆改 provider 表**：`ai.js` `OPENAI_COMPAT_PROVIDERS` 每家用 **per-provider `thinkingOff` 方言字段**（非 always-on `extraBody`），经 `_aiWithThinkingFallback` 在 **4xx(400/422) 时去字段重试一次 + `storage.local` 记忆**。根因：model 字段是自由文本，blanket 关思考会把用户切换的不兼容模型打 400。**custom/ollama/groq 不加 thinkingOff**；gemini 走 `thinkingBudget:0`；deepseek 也走 thinkingOff（reasoner 会拒收）。各家已核验字段勿凭记忆改（会 400），核验表见 CC 记忆 `reference_provider_thinking_disable_params`。
- **md-preview 全文翻译（`md-translate.js`，改前必读）**：block 切分 → `pbpAiShield` 占位符 `⟦C/L/I/M\d+⟧` 屏蔽代码/链接/图片/数学 → JSON `{translations:[{id,text}]}` 流式 → 块 hash 缓存。三条不变量勿破坏：① **占位符守恒**门（`pbpTrPlaceholdersConserved`，硬）+ 长度比（软）二者皆过才 fill；② glossary = 用户表 ∪ 自动抽取（**用户优先**）按批命中裁剪注入；③ 抽取/缓存任何失败必须 **degrade 不阻断**翻译。`md-translate.js` 顶段保持纯（无 DOM/chrome/fetch，供 `tests/md-ai-tests.html` file:// 加载）。

## 性能与踩坑（hard-won，改 UI / SW / 字体前必读）

> 真实事故的根因沉淀，**勿重新引入**。机制依据：Blink fonts README、crbug 1266022/491556、developer.chrome.com（SW lifecycle / storage / CSP / alarms）、web.dev（content-visibility / style 计算）。

### 字体回退卡顿（2026-06 根因）

popup/options 是**短命单次渲染、无暖 shape cache**——首屏要付满「字体匹配 + 回退 + HarfBuzz shaping + 字体首次加载」成本。任何「UI 文本回退到一个大/慢字体」都会在高 DPI Windows 上造成 **1-3s 冻结**（计入 Rendering / Recalc+Layout，Paint 反而很小）。已踩中三种形态，对应三条铁律：

| 形态 | 机制 | 铁律 |
|------|------|------|
| emoji / dingbat（⚠ ✓ ✗ ✕ ↻ ▸ ▾ ℹ …） | 回退到 Segoe UI Emoji 彩色字体，首次加载 ~1.6s | UI 里**一律内联 SVG**（`PBP_ICONS` / `setBtnIcon` / `setStatusIcon` / CSS 三角），**禁止字面 emoji/符号字符**。`U+FE0E`(VS15) 和 `font-variant-emoji:text` 在 Chrome 实测**无效**，别依赖 |
| CJK 正文 | font-family 只列拉丁字体 + 通用 `sans-serif` → 中文回退到 profile 的 **Standard 字体**（用户可能设了大 CJK 字体如 Sarasa） | body font-family **必须在 `sans-serif` 前显式列快 CJK 字体**：`"PingFang SC","Microsoft YaHei","Hiragino Sans","Noto Sans CJK SC"` |
| 等宽（Latin） | 裸 `monospace` **和 `ui-monospace` 都** → profile 的 **Fixed-width 字体**（`ui-monospace` 在 Chrome 不映射到 OS 等宽 UI 字体，而是同 Fixed-width 设置） | **以命名字体打头**：`"SF Mono",Consolas,Menlo,…`。**禁止用 `ui-monospace` 或裸 `monospace` 打头** |
| 等宽里的 **CJK**（最隐蔽） | Consolas/SF Mono **没有中文字形**，monospace 元素里的中文字符会穿过整个 Latin 栈、落到栈尾 `monospace` 通用名 → **Fixed-width CJK = Sarasa** 又中招。**典型触发**：zh-CN 下 Bookmark 的 tag-presets、Appearance 的 custom-CSS 这两个 textarea 的**中文 placeholder** | monospace 栈在 `monospace` 之前**必须再列快 CJK 字体**：`…,"PingFang SC","Microsoft YaHei","Hiragino Sans","Noto Sans CJK SC",monospace`。只修 Latin 一半 → Bookmark/Appearance 仍卡（2026-06 实测）。用 `CSS.getPlatformFontsForNode` 验证：Latin→Consolas、CJK→YaHei，都不到通用名 |
| **表单控件**的 CJK（2026-06 实际根因） | `<button>`/`<input>`/`<select>` 默认**不继承** `font-family` → 吃 UA 默认 `Arial`（无中文字形）→ 中文标签掉到 Standard 字体 = Sarasa。按钮**每个 tab 都有** → 表现为「每次首切 tab 都卡」。`.fg textarea` 反而早已命名 YaHei 没事——前几轮只盯 textarea 全找错了方向 | options.css 顶部 `button, input, select { font-family: inherit; }` 让其继承 body 的 CJK 栈（`.fg textarea` 凭更高 specificity 仍保 monospace） |

**测量陷阱**：chrome-dbg / 已打开的页面是**暖态**，测不到冷首屏（同代码暖态 ~3ms vs 日常 Chrome 1.7s）。判定：第二次操作就快 = 一次性冷成本；**只能在用户真实机器冷启动验证**。预热（idle 强制 layout）会阻塞主线程造成「看着渲染完却卡死」，**不可取**——优先消除慢字体回退这个根因。热路径避免 `:has()` 等慢选择器；超长面板可考虑 `content-visibility:auto`。

**CJK 字体名 & 检测**：① CJK 名要列**真实存在的全集**——`"Noto Sans SC"`（不是只 `"Noto Sans CJK SC"`，二者是不同 family）、本地化 `"微软雅黑"`、`"Source Han Sans SC"`、`"WenQuanYi Micro Hei"`，覆盖 Win/Mac/Linux。② 判断字体在不在**别用「测 ASCII 宽度」的探针**——它对 CJK 字体会**误报**（Win11 的 YaHei 被误判 false 害我绕了几轮）；用 `document.fonts.check('16px "字体名"', '中')` 或 DevTools「Rendered Fonts」/ `CSS.getPlatformFontsForNode` 这种按真实渲染判定的方法。

### MV3 不变量（改 background.js / 存储 / manifest 前别破坏）

- **SW 无持久状态**：30s idle 即终止、全局变量被清空。状态一律落 `chrome.storage`，每个 handler 开头重读；全局只作单次调用内的暖缓存。
- **监听器顶层同步注册**：`chrome.*.on*` 与 `importScripts` 只能在 SW 顶层同步执行；async 注册在 MV3 不保证生效。
- **存储分层**：`optSyncEnabled` 是每设备 `local` 开关，普通设置据此路由到 `sync` 或 `local`；`syncApiKeys` 是账号级 `sync` 标志，但设置同步关闭的设备始终读取本地凭据。凭据同步关闭时 secret 留在各设备 `local`，开启时仅参与设置同步的设备使用云端副本。`sync` 单 item ≤8KB、总约 100KB、写入限流；写后检查 `lastError`。缓存/大/瞬态始终用 `local`。
- **离线队列隔离**：`offlineQueue` 只存 `chrome.storage.local`。新记录仅保存保存模式、URL、标题、备注、标签、私密/稍后读/归档标志、书签时间、队列 ID/入队时间与非秘密 Pinboard 用户名绑定，禁止保存 token；启动或读取时把 legacy token 改写为账号绑定并删除 token。重放必须使用当前登录 token，且用户名与队列绑定精确一致，否则保留队列并失败关闭。
- **消息异步响应**：`onMessage` 里 `return true` 保持通道，且**别**把该 listener 设成 `async`（二者只能取一）。
- **CSP**：禁 `eval`/远程代码；只能远程取**数据**（JSON/CSS）。Defuddle 因此本地 vendor。
- **content script**：仅 `pinboard.in` 注入、保持瘦身；`document_start` 仅主题注入需要（第二段注册 = `pinboard-sort.js`，`document_idle`）。
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
