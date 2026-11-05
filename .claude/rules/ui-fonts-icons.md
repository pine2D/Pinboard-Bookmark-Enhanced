---
paths:
  - "popup.html"
  - "options.html"
  - "library.html"
  - "md-preview.html"
  - "popup.css"
  - "options.css"
  - "library.css"
  - "md-preview.css"
  - "popup.js"
  - "popup-*.js"
  - "options.js"
  - "options-*.js"
  - "library.js"
  - "library-*.js"
  - "listbox.js"
  - "shared.js"
  - "md-*.js"
---

# UI 性能铁律：字体回退与图标契约（改任何 UI 文本 / CSS / 图标前必读）

> 自根 CLAUDE.md 迁来（2026-11-05）。字体回退性能铁律的作用域以下文第一段为准（popup / options / library）。图标契约直接点名阅读器查词按钮（`wandSparkles` / `quote`），阅读器代码也按本规则用 SVG 代替字面符号（md-ask.js、md-reader.js、md-video.js、md-preview.css 的注释都引用它），所以 paths 同时覆盖 md-preview.* 与 md-*.js；这不扩大性能铁律的作用域。

<!-- 机制依据：Blink fonts README、crbug 1266022/491556、developer.chrome.com（SW lifecycle / storage / CSP / alarms）、web.dev（content-visibility / style 计算） -->
popup / options / library 三个扩展表面是短命单次渲染、无暖 shape cache——任何「UI 文本回退到大/慢字体」都会在高 DPI Windows 上造成 1-3s 首屏冻结。**作用域仅此三表面，不含 pinboard.in 站点主题**（`pinboard-themes.js` / `pilots/*.tokens.json`）：站点主题注入的是长命普通网页，性能模型不同；13/13 pilot 的 `typography.family` 均不列 CJK 字体，sans 栈与 mono 栈一视同仁，也无任何门禁检查它——据此报 Terminal / Solarized 违反下表形态 4 属误报。四种已踩形态：

| 形态 | 铁律 |
|------|------|
| emoji / dingbat 字符 | UI 一律内联 SVG（`PBP_ICONS` / `setBtnIcon` / `setStatusIcon` / CSS 三角），**禁止字面 emoji/符号**——⚠ ✓ ✗ ✕ ↻ ▸ ▾ ℹ 这类单色 dingbat 同禁（回退 Segoe UI Emoji，首次加载 ~1.6s）。`U+FE0E` 与 `font-variant-emoji:text` 实测无效 |
| CJK 正文 | body font-family 必须在 `sans-serif` 前显式列快 CJK 字体：`"PingFang SC","Microsoft YaHei","Hiragino Sans","Noto Sans CJK SC"`（CJK 名要列真实存在的全集：`"Noto Sans SC"` 与 `"Noto Sans CJK SC"` 是**不同 family**，另补 `"微软雅黑"` `"Source Han Sans SC"` `"WenQuanYi Micro Hei"` 覆盖 Win/Mac/Linux） |
| 等宽（Latin） | 以命名字体打头（`"SF Mono",Consolas,Menlo,…`）；**禁止 `ui-monospace` 或裸 `monospace` 打头**（都会落到 profile 的 Fixed-width 字体） |
| 等宽里的 CJK（最隐蔽） | monospace 栈在 `monospace` 之前必须再列快 CJK 字体，否则中文 placeholder 穿过 Latin 栈踩中 Fixed-width CJK |

- 表单控件（button/input/select）默认**不继承** font-family → 必须 `button, input, select { font-family: inherit; }`（`.fg textarea` 凭更高 specificity 保 monospace）。
- 图标契约：只从 Lucide v0.525.0（ISC）取 path（24-box、stroke 2，唯一例外 obsidian 品牌钻石；版本基准钉在 shared.js 顶部注释，勿从其他版本拷 path），新图标不手绘、SVG 内禁 `<text>` 节点；`eye/eyeOff` 独占密钥显隐、`refresh` 限定重跑同一动作、`cross` 是删除/移除/关闭家族、`extOpen` 限定真外链、`robot` 限定花 token 的 AI 动作（例外：查词的 AI 词条与补充生成沿用 `wandSparkles`，须带文字与模型名，2026-10-26 用户裁决；原文用例是免费动作，不用 `wandSparkles`，用 `quote` 加文字、不带模型名）；icon-only 按钮必须 `title` + `aria-label` + ≥24px 命中区。**唯一字面字符例外**：`×`（U+00D7）属 Latin-1 Supplement、无 emoji presentation，四处使用点（popup.html `#ai-error-dismiss`、popup.js `.edit-cancel`、shared.js `.fc-dismiss`、options.js `.saved-theme-del`）继承的 body 栈首个可解析家族即覆盖它、不触发回退，是安全字符、**勿迁 SVG**（2026-06-17 round-2 审计裁决，`80e3fe3` 已界定迁移范围；已两度重提，别再提第四次）。
- 测量陷阱：暖态（chrome-dbg / 已打开页面）测不到冷首屏，只能在用户真实机器冷启动验证；卡顿计入 Rendering / Recalc+Layout 而 Paint 很小，第二次操作就快 = 一次性冷成本；idle 预热会阻塞主线程，不可取——根治慢字体回退本身。判断字体存在用 `document.fonts.check('16px "字体名"', '中')` 或 DevTools Rendered Fonts / `CSS.getPlatformFontsForNode`，别用测 ASCII 宽度的探针（对 CJK 字体误报）。
- 热路径避免 `:has()` 等慢选择器；超长面板可考虑 `content-visibility:auto`。
