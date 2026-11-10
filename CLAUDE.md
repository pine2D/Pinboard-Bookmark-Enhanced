# Bookmark Enhanced 项目配置

作者：pine2D
更新：2026-11-10

> 本文件只保留每个会话都需要的跨领域约定。子系统深水区规则在 `.claude/rules/`（按 paths 匹配自动加载），按任务的流程在 `.claude/skills/`（按描述触发），有到期日的一次性迁移在 `.claude/expiring-items.md`；三者都列在文末索引表。不自动加载 rules 或 skills 的工具（Codex 等）在改对应文件或执行对应任务前，按索引表先读。机器可验证的铁律已由 pre-commit / verify.sh / release 硬门强制——prose 是提醒，lint 是底线。

## 项目概述

Chrome Extension (Manifest V3)，将当前页面保存到可选主服务 Pinboard、Karakeep 或 linkding（后两者无需 Pinboard 账号），支持多 LLM 提供商的 AI 标签/摘要/全文翻译/Ask-the-page 问答与 opt-in 要点提炼（skim）。md-preview 阅读器支持直接保存/编辑/删除所选服务的书签，完整 Ask 问答可连同引用单独导出或附在正文后；带划词高亮/笔记/搜索/专注模式、YouTube / B 站视频页的播放器+多语种字幕面板、在线词典与可选离线词典（CC-CEDICT 汉英、用户自备 ECDICT 英汉与多语言 Yomitan v3 包）；高亮、笔记、生词与已保存的问答集中在独立的「资料库」页（library.html，索引 + 详情平铺双栏）；生词、高亮、笔记、AI 词条归档与 Ask 历史由所有书签服务共用一个个人资料库，可按语言筛选、从查词结果选义保存并关联原形；支持完整 TSV 与可选多语言 Anki 笔记类型，保留原六字段导出，也可发送到欧路词典；连接 Google Drive 即同步生词、高亮、笔记及完整 AI 词条、补充用法和 Ask 问答记录。导出可 Send-to Obsidian/Notion/NotebookLM/Gist/Webhook，另有 Wayback 自动归档、标签治理和 13 套 pinboard.in 站点主题。功能全貌见 README.md。

显示名称为 **Bookmark Enhanced**（简体中文：书签增强）；仓库地址、扩展 ID、公钥/OAuth client、`pbp-*` 存储标识、默认 Anki 牌组与 Karakeep 稍后读列表识别标记保持兼容，不随品牌名更改。

## 技术栈

| 层级 | 技术 |
|------|------|
| 平台 | Chrome Extension Manifest V3 |
| 语言 | Vanilla JavaScript（无框架、无构建步骤、零运行时依赖——保持这一点） |
| 存储 | Chrome Storage API（sync + local）+ IndexedDB |
| AI providers | OpenAI / Anthropic / Gemini / DeepSeek / Alibaba Cloud Model Studio (Bailian) / MiniMax / OpenRouter / Groq / Mistral / Cohere / SiliconFlow / Zhipu (BigModel) / Moonshot (Kimi) / Volcengine Ark / BytePlus ModelArk / OpenCode Zen / Command Code / Ollama (local)；另可添加多个 OpenAI / Anthropic 兼容的自定义端点 |
| 页面正文抽取 | Defuddle（vendor/ 本地化，懒注入）；备用 Jina Reader API |
| 主题生产 | 自建 theme factory（`docs/theme-surface/`） |

## 目录结构（速览）

细节看各文件头注释与索引表里的规则；下表只给定位。

```
manifest.json / background.js   # MV3 配置；Service Worker（图标状态、书签检测、URL 缓存、storage 预热、DNR 防盗链、popup AI 代理）
popup.* + popup-{ai,batch,offline,tags,theme-early}.js       # 主弹窗（AI 标签/摘要、批量、离线兜底、标签补全、防 FOUC）
options.* + options-{connectivity,backup,vocab,theme-early}.js  # 设置页（联通测试、JSON 备份、生词设置侧）
library.* + library-{vocab,notes,ask}.js   # 资料库页（索引 + 详情平铺双栏，owner 隔离；library-ask.js 按文章与会话浏览、继续提问和删除 Ask 历史）；listbox.js 是 options/library 共用列表框
md-preview.* + md-*.js           # 阅读器及其子模块；md-preview-theme-early.js 首帧明暗；bili-player-bridge.js 是 B 站播放器桥
vocab-store.js / notes-sync.js / dict-archive.js / ask-archive.js  # 四类个人资料的本机写边界；各自的 *-gdrive.js 是 SW-only Drive 同步；restore-points.js 是生词与高亮笔记的本机还原点
dict-pack.js / dict-entry.js / dict-evidence.js   # 离线词典包 / AI 词条与补充 / 原文用例检索
ai.js / ai-cache.js              # AI 调用核心（popup/options/library/md-preview 共载）/ 结果 IDB 缓存
bookmark-services.js / export-targets.js / anki-connect.js / eudic-sync.js / vocab-send.js  # Karakeep/linkding 适配（统一保存入口在 background.js）/ Send-to 注册表（纯层）/ 生词外发（本机 AnkiConnect / 欧路 OpenAPI；纯层，测试页可载）
shared.js                        # 跨文件常量 + $id 记忆化 DOM 缓存
jina.js / i18n.js / tag-gov.js / wayback.js / site-rules.js  # 兜底抽取 / 多语言 / 标签治理 / 归档队列 / 站点适配器
pinboard-style.js / pinboard-sort.js / pinboard-themes.js    # pinboard.in 注入：主题 CSS（生成产物，勿手改）+ 标签热度排序
icons/  _locales/（9 locale）  vendor/（Defuddle 等，由 update-vendor.sh 同步）  README*.md ×9 / privacy-policy.md / LICENSE
tests/                           # file:// 直开的 HTML 测试页 80+ 套 + render-audit / ui-contract 等 .mjs（不入 release ZIP）
scripts/                         # 质量门：verify.sh（门的权威清单以其自身的阶段 echo 为准）/ pre-commit-hook.sh / commit-msg-hook.sh / ui-consumer-lint.mjs（编辑期）；发布链：bump-version.sh / release.sh / zip-install-smoke.mjs；工具：setup-hooks.sh / update-vendor.sh / sync-runtime.sh / qa-drive.mjs / perf 与截图辅助若干
docs/                            # GitHub Pages（index.md / privacy.md / _layouts / assets / screenshots / cws-assets）；docs/theme-surface/ 主题工厂（composers/ pilots/ tools/ qa-harness/ snapshots/ + COMPONENTS.md / NEW_THEME.md / README.md）；docs/site-rules/ 站点适配器编写文档 + 调试脚本
docs/superpowers/ DESIGN-IS-2026-07-22/ release/   # gitignored 本地产物（.qa-scan/ 仅 package*.json 与 run-test.mjs 入库）
```

## 开发约定

| 约定 | 说明 |
|------|------|
| 加载方式 | `chrome://extensions/` → 加载已解压的扩展，选择项目根目录 |
| 无构建流程 | 直接编辑源文件、刷新扩展即生效（vendor/ 例外，走 update-vendor.sh） |
| DOM 查询 | 用 shared.js 的 `$id(id)`（记忆化）；**例外**：md-preview.html 虽加载 shared.js（供 SETTINGS_DEFAULTS/deobfuscate* 使用），但 `md-preview.*` 与 `md-*.js` 一律用原生 `document.getElementById` |
| 提示词模板变量 | `{{title}}`、`{{url}}`、`{{content}}`、`{{lang_instruction}}` |
| 书签缓存 | URL 书签状态 TTL 5 分钟 |
| Storage prime | 冷启动慢，靠 chrome.alarms 周期性预热 SETTINGS_DEFAULTS |
| 图标 | 工具栏 `pin-*` 分 default（未收藏）/ saved（已收藏）/ toread（待读）三套，商店与通知用 `app-*`；全部由 `node scripts/gen-icons.mjs` 生成，勿手改 PNG |
| Commit message | conventional commits（feat / fix / refactor / perf / docs / style / chore），英文 |

## 存储与同步边界（摘要）

唯一权威表述在 `.claude/rules/storage-sync.md`，改存储路由、同步、备份、书签连接或离线队列前先读。最要紧的几条：

- 三条通道：Chrome Sync 只放普通设置（`optSyncEnabled` 是每设备 local 开关；凭据仅在 `syncApiKeys=true` 时随 sync）；Google Drive 只同步个人资料库的生词、高亮与笔记、完整 AI 词条及补充、Ask 问答记录（`drive.appdata`，不接管设置、凭据）；手工 JSON schema v3 是明文文件，凭据两端默认关、fail-closed。
- 凭据（API key / token / password / 导出目标）不能硬编码，默认存 `chrome.storage.local`；缓存、大对象、瞬态状态一律 local，sync 写后检查 `lastError`；离线队列禁止保存 token。
- 个人资料库 owner（`personalLibraryAccount`）与书签连接身份分开；本机实际保存到的服务是只存 local 的 `bookmarkServiceActive`，读取一律经 `pbpReadSettingsWithSecrets`。

## 跨领域安全铁律

- **Pinboard 账号隔离**：所有 Pinboard v1 请求（`auth_token` 认证）在实际 dispatch 前原子重读有效凭据；同用户名 token 轮换时用新 token 重写请求，登出或跨用户名切换时取消且不得发网。账号数据派生的 cache / message / preview payload / 持久任务必须携带非秘密 owner，并在读取、异步回写、UI 提交时逐次校验 owner。
- **网络端点与 host 权限**：required host 仅 Pinboard；Karakeep / linkding / AI / Jina / Wayback / Gist / Webhook / Notion / Free Dictionary / 欧路、AnkiConnect 精确回环 origin（`127.0.0.1:<端口>`，端口在设置里可改、默认 8765）、YouTube/B 站字幕（www.youtube.com / api.bilibili.com；**首次**由视频页预览内的「启用字幕并加载视频」点击申请精确 origin；授权后打开视频页预览即自动抓取——字幕即正文的产品语义，自动路径仅 `permissions.contains` 判定绝不 request。YouTube 优先注入用户已开的 www.youtube.com 标签页 same-origin 取数——页内自带登录与 PO Token 语境，扩展页跨站 fetch 被 LOGIN_REQUIRED 常态拦截；无标签页时回退扩展页 fetch，仅该回退受 `mdVideoUseLogin` 控制，默认开；B 站三个字幕 API 以登录态 credentials:include 调用；**B 站播放进度**走 `player.bilibili.com` 精确 origin——与 api.bilibili.com 同一次点击申请，授权后 md-video.js 用 `scripting.registerContentScripts` 注册 `bili-player-bridge.js` 到该 origin 的所有 frame，脚本在预览页以扩展 origin 握手前完全静默，只回传 currentTime/状态/时长并执行 seek/play/pause/rate；caption 的 `contains` 门只看 api origin，早期只授过 api 的用户由工具条「启用播放跟随」按钮补授）与 Batch 所选站点，以及**内嵌框架抽取**（顶层文档无正文而存在单个占视口 ≥40% 的跨源 https iframe 时，阅读器错误态给「授权并重试」按钮，点击才请求该帧精确 origin，随后以 `allFrames` 重抽取；`sandbox` 无 `allow-same-origin` 的帧不作候选）——**首次授权**一律只能来自直接用户动作请求当前精确 origin。**YouTube 播放器经本项目自有 Pages 中继页内嵌**（扩展页不发 Referer，YouTube 播放器因此拒载；中继页是 iframe，与封面图 `i.ytimg.com` 同属子资源，均不需 host 权限）。后台/自动路径只做 `permissions.contains`，禁止运行时申请 wildcard。可配置端点必须 HTTPS，HTTP 仅允许字面 `localhost` / `127.0.0.1` / `[::1]`；LAN/public HTTP、凭据 URL 与无权限请求一律阻断并保留配置。升级时一次性清理 legacy all-sites grant。
- AI 请求统一走各 provider 的 chat completion 接口（关思考方言勿凭记忆改，见 rules/ai-providers.md）。
- Defuddle 在 popup 打开时**懒注入**；site-rules.js 与其成对注入且**先于** Defuddle 运行（命中站点规则即短路）。
- **新增任何数据出口**（新 API 调用、新导出目标、新 AI 触发面）必须同步 privacy.md 的 Network Requests / Permissions / Third-Party 三处；发版文档硬门会拦（见 release skill）。

## MV3 铁律（摘要）

全文在 `.claude/rules/mv3.md`（改 background.js / manifest / SW 模块 / content script 前必读）。跨文件适用的三条：

- **SW 无持久状态**：30s idle 即终止、全局变量清空；状态落 chrome.storage，每个 handler 开头重读。监听器与 importScripts 只能在 SW 顶层同步执行。
- **optional permission 的 API 在调用点现取**（如 `chrome.identity`），不在顶层或默认参数里捕获。
- **吞异常必须留痕**：把平台 API 异常折叠成产品错误码前，先 `console.warn` 出 `error.name` / `error.message`（不含 token、邮箱、生词内容）。

## UI 性能铁律：字体回退与图标（摘要）

popup / options / library 的 UI 文本不能回退到慢字体：字面 emoji/dingbat 一律换内联 SVG（唯一例外 `×`），CJK 与等宽字体栈要先列快字体，图标只从 Lucide v0.525.0 取。全文与图标语义契约在 `.claude/rules/ui-fonts-icons.md`，改任何 UI 文本、CSS 或图标前必读。

## 设计精修工作流

- 设计技能 [make-interfaces-feel-better](https://github.com/jakubkrehel/make-interfaces-feel-better) 与 [Impeccable](https://github.com/pbakaus/impeccable) 自 2026-10-02 起为用户级安装（`~/.agents/skills`，Claude Code 与 Codex 共用，由本机更新脚本跟随上游维护），不再随项目安装或锁定版本。
- 采用 Impeccable 的 Operate 模式审视 popup/options/library，Read 模式审视阅读器；先检查实际界面的任务路径、层级和边界状态，再按 polish 工作流修正，最后用 make-interfaces-feel-better 检查排版、状态、图标、动效与性能。已有主题与 `COMPONENTS.md` 是设计依据。
- 开发审计先用 `node scripts/audit.mjs --changed --plan` 检查影响推荐，再按 `--surface` / `--scenario` / `--kind` 与所需语言、窗口、主题等维度执行；popup、options、library、reader、site、background 均可选择。复用 `qa-drive` 隔离夹具，只检查受影响流程；纯逻辑修改选择逻辑/契约检查，不机械截图无关页面。推荐是有理由的保守估计，跨界面流程与共同前置由场景注册表保留；规则及例子见 `.claude/rules/audit.md`。改完执行对应编辑期 lint、必需主题只读门与所选渲染门；检测器结合截图判断，不因通用建议改动已裁决的设计。
- 本项目的快 CJK 字体栈、Lucide stroke 2、控件阶梯、主题 token 与冷启动要求优先于技能的通用字体、40/44px 命中区、按压缩放或装饰动效建议。高频操作保留即时反馈；不引入运行时依赖、远程字体或首屏入场动画。

## 测试与夹具

- tests/ 全部 file:// 直开、不依赖构建；改逻辑同时跑对应测试页。
- **测试产物放仓库外**：用户的 Windows Chrome 直接把仓库根目录当作已解压扩展加载，仓库里的文件越多，Chrome 启动越慢。2026-11-05 实测：仓库约 12.6 万个文件，其中 11 万个是测试报告，Chrome 启动约 128 秒后才出窗口。截图、渲染与审计报告、真实测试留证一律写到 `$PBP_QA_REPORT_DIR`（默认 `~/.local/share/pbp-qa-report`）。qa-drive、readme-shots、cws-shots 默认已写到这里；`audit.mjs --report` 也别指向仓库内；新脚本读同一个变量。已归档的 dict-* 真实测试驱动按指纹锁定，仍写到仓库内的 `.qa-scan/report/`，跑完那一轮就把留证移到上面的目录。`.qa-scan/` 只放工具依赖与宣传片工程，仓库内文件数保持在约 2 万以内（`find . -type f | wc -l`）。
- **远端 API 响应夹具按真实抓包/官方 schema 手写，禁止用写入侧构造器生成**——「我和我自己一致」的自测全绿仍会真机 corrupt（2026-07 Drive 事故）。补纯函数谓词的单测不构成修复，runner 路径的夹具本身必须换成服务端形状；校验器越严（精确 key 集合 / 派生字段相等 / canonical 重序列化），这种自洽假安全感越强。夹具默认值用 `=== undefined` 判定，`||` 会吞掉 `""` 这类合法边界值。
- 断言要泛化到类别而不是枚举实例；新增或审查断言先问「这条检查漏判的最简单反例长什么样」，别只问「现在能不能过」。
- 「这个东西有没有被处理」的判定，要从程序真实消费的数据结构（注册表、Set、导出清单）拿答案，别退回源码文本 grep——注释与字符串字面量会击穿它（实例见 rules/theme-factory.md）。

### 真实 AI API 测试（必须明确授权）

- **任何真实 AI API 测试都必须事先取得用户明确授权。** 开发、修复、模拟测试的授权，或本机已有 Key，均不代表允许真实调用。授权、预算、`.env` 与留证的完整约定在 `.claude/skills/live-ai-test/SKILL.md`，任何真实调用前先读。

## Theme Factory（改主题源 / 三份 UI CSS / pinboard-themes.js 前必读 rules/theme-factory.md）

13 套站点主题与扩展三表面（popup/options/library）主题均由 `docs/theme-surface/` token-driven 生成。**唯一工作流**：改 `composers/*.mjs` 或 `pilots/*.tokens.json` → `node docs/theme-surface/tools/sync-all.mjs` → commit。**禁止手工编辑** `pinboard-themes.js` 与三份 CSS 里的六个 `@generated:*` 区——pre-commit（含 css-region-audit / handedit-audit 的 8 道门）会拦截，但 `ui-token-coverage` 与 `contrast-audit` 只在 sync-all / verify.sh 里，改生成区前必须手动跑一次。组件原语 generated，页面级布局与间距 token 的 `:root` 定义手写。规范：COMPONENTS.md；新主题：NEW_THEME.md。pinboard.in 站点主题只修不加（2026-11-10 用户裁决），不再新增预设。

## 提交、发布与对外文案

- **提交**：pre-commit 按改动文件分路跑门，全套 verify 由 push 后 CI 兜底，禁止 `--no-verify`。Claude Code 由 `.claude/settings.json` 的 PostToolUse 钩子在编辑时跑 `scripts/ui-consumer-lint.mjs`；没有编辑期钩子的工具（Codex 等）改完文件后自行执行 `node scripts/ui-consumer-lint.mjs --file <路径>`。
- **发版**：bump / push / release.sh、发版文档硬门、打包规则、扩展 ID 分层、ZIP smoke 与钩子分路详情都在 `.claude/skills/release/SKILL.md`。`bash scripts/release.sh` 只有带 `--build-only` 时不发布，其余任何运行都会直接发布。发版分两条线（2026-11-10 用户裁决）：GitHub release 随时发；商店两到四周提交一版，候选版先自己用满三天再提交。
- **对外材料只讲核心（用户已反复强调，2026-11-05 第五次）**：README×9、`docs/index.md`、商店描述（`docs/cws-assets/store-descriptions.md`，由 README 生成）以及宣传图和视频，都写给潜在用户看。只写核心功能，每个功能一句话，最多两句。实现细节、选项名、数字规格、边界条件、试点功能和操作步骤都不写，这些放在设置页提示或 release notes 里。新功能默认不进 README：能并进已有条目就并，只有本身就是卖点时才单列一条。docs-lint 会检查条目数和每条长度；超限时删内容，不许调阈值。子代理写这些材料时，要把这一条原文写进它的提示词。
- **用户看得到的文字都要说人话（2026-11-05 用户要求）**：适用于界面标签、设置提示、错误与状态信息、README、商店文案和宣传材料。
  - **写法**：用短句和常用词，直接说用户能做什么、会发生什么。不解释实现原理。
  - **不要 AI 腔**：不用破折号串句子，不用「无缝」「赋能」「不仅……还……」这类套话，不硬凑三连，不做宣传式拔高。
  - **设置页不配大段说明**：每个开关、输入框默认不配说明，标签本身说清楚就够。只有用户不知道就会出错、丢数据或多花钱时，才加一行提示。更长的说明放进 ? 帮助，分类规则见 `tests/options-hint-policy.json`。
  - **自查**：写完或改完，英文用 `humanizer` skill 检查，中文用 `humanizer-zh`，其他语种按 `content-l10n` 重写。子代理写这类文字时，要把这一条原文写进它的提示词。
- **用户可见文案 / README 改动**：×9 locale 逐行镜像、同 commit 更新；按目标语言重写而非翻译——细则见 rules/l10n.md。

## 临时事项

有到期日的一次性迁移与清扫登记在 `.claude/expiring-items.md`，到期日由 docs-lint（verify.sh / CI）检查：超期 14 天内 WARN、超过 14 天 FAIL。新增一次性迁移时在那里登记。

## 登记册

四份登记册放在 `.claude/` 根，格式由 `scripts/registers-lint.mjs` 检查（pre-commit / verify.sh / CI）。

- `.claude/decisions.md`：用户拍过板的取舍和否决过的方案。提新功能、做评审或审计前先读，里面列出的事不要再当新建议提。派子代理做评审时，把相关条目写进提示词。只记用户明确做的裁决。
- `.claude/acceptance-debt.md`：要人在真实环境里做的检查。每条有到期日，发版时 `scripts/release.sh` 会列出来，有过期的就中止，加 `--accept-debt` 才继续。过期超过 14 天 CI 会红，这时 `--accept-debt` 也没用，只能清账或改到期日。
- `.claude/flake-ledger.md`：时过时不过的测试。重跑后通过也要记一行，同一个用例第二次上榜就必须根治或隔离。
- `.claude/store-ledger.md`：商店的提交记录和后台数据。用户说了提交、过审、被拒或报了后台数字，就记一行。往商店提交前跑 `node scripts/registers-lint.mjs --store-check <版本>`。

## 与 Claude Code 协作

### 期望你主动做的

- 发现 JS 中的类型隐患和潜在 Bug（null 判断、异步错误处理）
- 指出 Chrome Extension API 的使用限制（MV3 Service Worker 生命周期）
- 补充缺失的 try/catch，尤其是 fetch 调用和 chrome API 调用
- 改主题时走 composer + sync-all + lint 链路，不动 `pinboard-themes.js`

### 不希望你做的

- 不要将项目迁移到框架或引入构建工具（保持零依赖）
- 不要过度拆分文件（当前结构是刻意为之；隔离脚本上下文间允许少量重复，不强行抽公共模块）
- 不要添加未要求的功能
- 不要主动创建文档文件
- 不要在 `pinboard-themes.js` 里手工加 CSS 规则
- 不要 `--no-verify` 绕过 pre-commit

## 规则与技能索引

`.claude/rules/` 读到匹配文件时自动加载，`.claude/skills/` 按任务触发；若本会话未触发（或你是不加载 rules / skills 的工具），改下列文件或做下列任务前**必须先读对应文件**：

| 改这些文件 / 做这件事 | 必读 |
|------|------|
| shared.js、background.js、options.js、options-backup.js、bookmark-services.js、popup.js、popup-offline.js、popup-batch.js、md-bookmark.js、vocab-store.js、vocab-gdrive.js、notes-sync.js、notes-gdrive.js（存储路由 / 同步 / 书签连接 / 离线队列） | `.claude/rules/storage-sync.md` |
| background.js、manifest.json、SW 用 importScripts 载入的数据模块（bookmark-services / vocab-store / notes-sync / dict-archive / ask-archive 及其 *-gdrive.js、restore-points.js、wayback.js）、pinboard-style.js、pinboard-sort.js、bili-player-bridge.js | `.claude/rules/mv3.md` |
| 四个表面 HTML/CSS、popup.js、popup-*.js、options.js、options-*.js、library.js、library-*.js、listbox.js、shared.js、md-*.js（UI 文本、字体栈、图标） | `.claude/rules/ui-fonts-icons.md` |
| 四个表面 HTML/CSS、shared.js、listbox.js、ui-vocabulary.json 与基线（新增任何 UI 元素；library 运行时创建值盒子的 library.js / library-vocab.js / library-notes.js 也要先读） | `.claude/rules/ui-primitives.md` |
| docs/theme-surface/**、popup.css、options.css、library.css、pinboard-themes.js、render-audit 家族（ui-render-audit / audit-render-scenarios / render-audit-ledger / checklist / known-failures）、ui-contract-tests、theme-*-tests | `.claude/rules/theme-factory.md` |
| scripts/audit*.mjs、tests/audit*-tests.mjs、qa-drive、ci-fonts、verify.sh、.qa-scan/run-test.mjs（选审计场景、`--font=ci`） | `.claude/rules/audit.md` |
| vocab-store.js、vocab-gdrive.js、notes-sync.js、notes-gdrive.js、options-vocab.js、library-vocab.js、library-notes.js、md-highlight.js、anki-connect.js、eudic-sync.js、vocab-send.js | `.claude/rules/vocab-sync.md` |
| vocab-gdrive.js、notes-gdrive.js、dict-archive-gdrive.js、ask-archive-gdrive.js、options-vocab.js、library.js、background.js、tests/ 下的 vocab-gdrive-tests.html、notes-gdrive-tests.html、options-drive-sync-tests.html、drive-scopes-tests.html、drive-migration-tests.html（连接层 / 身份缓存 / 错误码 / OAuth / 权限） | `.claude/rules/drive-sync.md` |
| dict-archive.js、dict-archive-gdrive.js、ask-archive.js、ask-archive-gdrive.js、library-ask.js | `.claude/rules/archive-sync.md` |
| md-preview.*、md-preview-theme-early.js、md-translate.js、md-ask.js、md-reader.js、md-highlight.js、md-ai-core.js、md-bookmark.js、md-skim.js、md-convert.js、md-epub.js、md-mermaid.js、md-export-send.js、md-video.js、md-dict.js、md-vocab-echo.js、bili-player-bridge.js | `.claude/rules/md-preview.md` |
| md-dict.js、md-vocab-echo.js、ai-cache.js、library-vocab.js（查词界面） | `.claude/rules/dict.md` |
| dict-entry.js、dict-evidence.js、md-dict.js（AI 词条与补充的生成） | `.claude/rules/dict-entry.md` |
| dict-pack.js、options-vocab.js、md-dict.js、library-vocab.js（离线词典包） | `.claude/rules/dict-pack.md` |
| options-backup.js（备份 schema v3 / 凭据 opt-in）、restore-points.js（还原点） | `.claude/rules/backup.md` |
| md-embed.js、background.js、zip-install-smoke.mjs（DNR 防盗链修复） | `.claude/rules/hotlink-dnr.md` |
| ai.js、popup-ai.js、options-connectivity.js（关思考与参数方言、popup AI 代理） | `.claude/rules/ai-providers.md` |
| ai.js、dict-entry.js（响应完整性、流式契约、任务输出要求、能力记录） | `.claude/rules/ai-response.md` |
| README*.md、_locales/**、docs/privacy.md、docs/index.md | `.claude/rules/l10n.md` |
| scripts/cws-shots.mjs、scripts/readme-shots*.mjs、docs/cws-assets/**、docs/screenshots/readme/**、.qa-scan/promo-video/**（商店图、README 图、宣传片） | `.claude/rules/promo-assets.md` |
| 发版、bump 版本、打 tag、release.sh、ZIP / CWS、弄清 pre-commit 分路 | `.claude/skills/release/SKILL.md` |
| 任何真实 AI API 调用或测试 | `.claude/skills/live-ai-test/SKILL.md` |
| 新增、改期或退役一次性迁移 | `.claude/expiring-items.md` |
| 提新功能、做界面评审或审计、给评审类子代理写提示词 | `.claude/decisions.md` |
| 留下要人验的事、清账、发版前看欠账 | `.claude/acceptance-debt.md` |
| 测试重跑后才通过、处理 CI 抖动 | `.claude/flake-ledger.md` |
| 往商店提交、记审核结果或后台数据 | `.claude/store-ledger.md` |
