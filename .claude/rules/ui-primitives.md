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
  - "shared.js"
  - "listbox.js"
  - "docs/theme-surface/ui-vocabulary.json"
  - "scripts/ui-vocabulary-baseline.json"
---

# UI 原语与设计语言（改任何表面 HTML/CSS 前必读）

设计语言不是靠记住规范，是靠**词汇注册表 + 门**。规范原文在 `docs/theme-surface/COMPONENTS.md`（§1–§9 组件族，§10 布局原语与关系律），注册表在 `docs/theme-surface/ui-vocabulary.json`，遗留基线在 `scripts/ui-vocabulary-baseline.json`。

## 新增任何 UI 元素，先答三问

1. **它属于哪个既有原语？** 先查注册表该表面的 `primitives`（options：`.fg` / `.fg-actions` / `.hint` / `.section-title` / `section.settings-section` / `.pref-group` / `.pref-row` / `.fg.entry-block` / `.fg.edit-area` / `.switch` / `.pick` / `.listbox` / `details.disclosure` + `.disclosure-body` / `.context-help-host` / `.pf`；popup：`.row` / `.label` / `.field` / `.suggest-area` / `.divider` / `.actions`（按钮行，gap sp-4）；library：`.notes-toolbar` / `.vocab-batch-bar` + `.notes-batch-bar` / `.notes-empty` / `.lib-cluster`（紧凑控件簇，gap sp-1）/ `.lib-section` / `.lib-block`（详情区的分节 / 文本块）；md-preview：`.rail-section` / `.rail-label` / `.rail-sec-head` / `.msg-bar` / `.send-menu` / `.send-mi` / `.pop-panel`（浮层面板 chrome + sp-3 内距）/ `.row`（控件行，gap sp-2）/ `.panel-head`（面板标题行））。能用就用，不新造包装类。
2. **它的几何落在哪个阶梯？** 按钮/字段高度按表面分：options 与 library 在密度阶上（md 32 / sm 28，紧凑档 28 / 24，读 `--opt-control-h` / `--lib-control-h`，library 的按钮阶由 composer `btnRules` 的 lib 分支发射），popup 与 md-preview 仍是 md 26px 与 sm 20px 两阶（COMPONENTS.md §1.1 / §6.3）；图标按钮命中区 ≥24px；按钮行 gap 一律 8px、图标簇 gap 一律 4px；可见文字 ≥11px；间距只用本表面的 `--*-sp-N` 刻度（md-preview 是 `--sp-N`）——margin、以及条/面板/弹层/行的 padding 与 gap 都算；控件与 chip 自身的竖向 inset 是组件几何（阶梯算术），可以是字面 px；圆角只用 `--*-radius-*` token。刻度外的字面 px 是缺陷，不是微调。
3. **它的间距由谁拥有？** 关系规则（容器 margin-bottom、`.fg > .fg-actions` 这类相邻规则）拥有间距；元素自身不带 margin，HTML 不写内联 `style="margin/padding/gap"`（layout-lint RULE 5 会 BLOCK）。

## library 是平铺画布（2026-10-03 起）

library 整页一个底色，分区只靠字阶、留白、栏位对齐、悬挂标签与节首小标题。页面骨架类登记在 `ui-vocabulary.json` 的 `library.canvasStructures`：它们不画底色（`--lib-bg` 除外）、不画任何 `border*`、`box-shadow`，`outline` 只许出现在 `:focus-visible` 上。可交互行与切换按钮的悬停填充是状态反馈，不算分区；弹层（列表框、「筛选」、确认）是唯一画 panel 底、1px 边与 `radius-lg` 的东西。新增骨架类时同一提交追加进 `canvasStructures`（必须先登记在 primitives / regions / components 之一，lint 会拦），ui-contract 的平铺画布门随即覆盖它。

## 真要新造一个结构类

只有在三问都答"不能复用"时才新造：在 `ui-vocabulary.json` 对应表面的 `primitives` 登记（一个名字 = 一份几何契约），在 COMPONENTS.md §10 补一行契约，然后才写 CSS。`ui-vocabulary-lint` 会拦下任何名字像结构包装（`-row/-actions/-bar/-toolbar/-card/-section/...`，完整正则见注册表）却未登记、也不在遗留基线里的类；基线只能减不能增，`--write-baseline` 只在有意接受遗留时手动跑。

## 值盒子（阶段 4 起）

popup / library 的值盒子（文本、搜索、密钥输入框，textarea，原生 select，以及 `.tags-input-wrap`、`.vocab-group-unit` 这类融合壳）只有一种字段语言：只有填充，四边同一框色，**不画底边**，四角同一个 `--*-radius-md`；聚焦 = 四边 `field-border-focus` + 手写光晕，另在 `@media (forced-colors: active)` 里补 `outline: 1px solid Highlight`（非负 offset）。

- **颜色只来自生成的注册表**：`docs/theme-surface/composers/ui-components.mjs` 的 `FIELD_TARGETS.pp` / `FIELD_TARGETS.lib`（options 是 `.fg` 配方）。手写区只写几何（高度、内距、宽度、`border-width` + `border-style`、圆角、光晕、`outline: none`），不写任何颜色，也不写 `border` 简写（它把框色重置成 currentColor）。
- **新增值盒子要在同一提交里登记进 `FIELD_TARGETS`** 并跑 `sync-all`。library 在运行时创建的盒子，必须写成 `tests/ui-contract-tests.mjs` 收割得到的形式：在被收割的脚本（`library-vocab.js` / `library-notes.js` / `library.js`）里写 `const X = document.createElement("input" | "select" | "textarea")`；换写法或换文件就先扩展收割，否则这个盒子不在门内。
- ui-contract 的覆盖、颜色、形状、`url()` 与强制色扫描会拦下漏登记、手写颜色、底边与分段圆角。

## 门在哪里响

- 编辑期：`.claude/settings.json` 的 PostToolUse 钩子对 Edit/Write 命中表面文件时跑 `scripts/ui-consumer-lint.mjs`（layout-lint + ui-vocabulary，<1s），红了直接把结论回喂。
- 提交期：`scripts/pre-commit-hook.sh` 第二触发组（HTML/JS/md-preview.css/注册表/基线）。
- push 期：`scripts/verify.sh` 的 `[ui-vocabulary]`；渲染几何由 `scripts/ui-render-audit.mjs` 的类扫描家族兜底（family 4–12，见 COMPONENTS.md §10.3）。**新增任何交互后才出现的界面（弹层、面板、菜单、隐藏态），要在 `READER_SURFACES` / popup 状态腿登记开启方式**，否则它不在门内。控件高度一律 px（height / min-height / px line-height），控件字面也是 px（popup / md-preview：md 13、次级 12、sm 11；options / library 读密度 token：md 14、sm 13，紧凑档各减 1），em 只给正文——阅读器弹层曾因 `1.9em` 方块在默认字号档下量出 36px，`0.85em` 标签把 26px 按钮的文字内缩吃到 1.3px。**改了控件几何要在 push 前用 `FONTCONFIG_FILE="$PWD/scripts/ci-fonts.conf"` 跑一次 sweep**：本机借 Windows 字体（拉丁正文落在 Verdana，中文落在微软雅黑），CI 的拉丁正文落在 **Liberation Sans**（字体栈里的具名字体 CI 全缺，经 generic sans-serif → Arial 度量别名解析；不是 DejaVu），中文落在文泉驿正黑，且 Ubuntu 默认 hintslight + rgb 子像素。`line-height: normal` 的控件会在 CI 上多出或少掉 1px、CJK 墨迹会高出约 1 CSS px，本地都看不见。该 conf 引入本机 `/etc/fonts/conf.d` 并白名单 CI 实有的字体包，在 Ubuntu 24.04 主机上与 CI 逐字节一致（含 CJK），换发行版不保证。路径必须是绝对路径（相对路径 fontconfig 会静默落回默认配置），验证加载成功看 `fc-match "Microsoft YaHei:lang=en"` 是否解析到 DejaVu、`fc-match Arial` 是否解析到 Liberation Sans（不带 `:lang=en` 时中文/日文 locale 会答文泉驿，conf 明明加载了也像没加载）。两个审计脚本在设了该变量时自行把 `XDG_CONFIG_HOME` 指向空临时目录，隔离本机 `~/.config/fontconfig` 的个人 hinting / 子像素 / 字体偏好（经 conf.d 的 50-user.conf 混入，能盖掉 CI 保留的逐字体规则），测试页与裸 `fc-match` 不会自己隔离，要加 `XDG_CONFIG_HOME="$(mktemp -d)"` 前缀。`spacingScale` 的存量债在 `tests/render-audit-spacing-baseline.json`，只减不增：新写一个刻度外的 margin/padding/gap 会直接 FAIL，不要把它加进账本，改成 token。

## 已知反模式（本仓库真实踩过）

- 同一个「测试连接」按钮行三种 DOM 形态（内联 style / `.pf` 裸按钮 / `.vocab-entry-row`），间距 6/12/0px。
- 24px 帮助按钮撑高 grid 行，带帮助字段标签→控件 12.67px vs 4px。
- `.save-status` 基线 margin-left 对所有 flex 行都错，攒出 5 条逐行 reset。
- 两套折叠机制（JS accordion + native details）并存，三种标题面。
- 同特异性规则靠源序压住修复：`.fg-stack > label.bl` 与 `.fg label.bl` 平局，前者从未生效。
