---
name: theme-surface
description: Bookmark Enhanced 跨表面主题预设新增、升级与样式兼容精修工作流（覆盖收藏弹窗、设置页、资料库、阅读器与 pinboard.in 全页面矩阵，含平铺软填充与立体窗口化双轨架构）。在新增或调整主题预设、排查跨主题样式回归、修复 pinboard.in 特殊页面布局或处理立体/有框控件与基底 CSS 冲突时使用。
---

# 主题预设与跨表面样式工作流（Bookmark Enhanced）

> 配套规则：`.claude/rules/theme-factory.md`（生成管线与双轨门禁）、`.claude/rules/ui-primitives.md`（原语阶梯与已知反模式）、`.claude/rules/md-preview.md`（阅读器明暗与外壳解析）、`.claude/decisions.md`（已拍板设计裁决）。脚手架参考：`docs/theme-surface/NEW_THEME.md`、`docs/theme-surface/COMPONENTS.md`。

## 1. 单轴预设架构（严禁正交外观开关）

1. **单一真源轴**：所有主题一律挂在 `themePresetKey` 上，禁止新增独立的「界面风格 / 外观模式」设置项（曾因拆出正交开关导致首帧镜像分裂、暗色缺失并返工 47 个文件）。
2. **明暗双态伞形映射**：自带浅色/深色双模式的预设必须同时登记 `shared.js` 的 `ADAPTIVE_THEME_MAP`、`popup-theme-early.js` 与 `options-theme-early.js` 的 `PBP_OPTIONS_ADAPTIVE_MAP`；声明紧凑密度的预设同步登记 `PBP_OPTIONS_DENSITY_MAP`。
3. **五处首帧防闪烁（FOUC）同步**：修改主题解析逻辑时，必须成对同步运行时与首帧脚本（`popup-theme-early.js`、`options-theme-early.js`、`md-preview-theme-early.js` 及 `pinboard-style.js`），核对 `pp-theme`、`pp-theme-preset`、`pp-theme-follow` 等 `localStorage` 镜像键。
4. **扩展生成表与审计表闭环**：在 `docs/theme-surface/pilots/*.tokens.json` 新增或调整目标后，同步核对 `docs/theme-surface/composers/popup-chrome.mjs`（`POPUP_THEME_MAP`）、`options-chrome.mjs`、`library-chrome.mjs` 及 `tests/render-audit-checklist.mjs`（`THEMES`）。

## 2. 有框/立体主题 vs 平铺无框基底兼容清单

基底 CSS 默认假设控件为「平铺软填充、静息无框」。为有框或立体斜面主题（如 `platinum-controls.css` 或带框豁免主题）编写样式时，逐项核查以下 8 类高频冲突：

1. **光学悬挂负边距归零**：平铺画布为无框 `.ghost` 按钮设置的负外边距（如 `.lib-hang-start`、`.lib-hang-end`、侧栏折叠行负缩进）在套上实体外框后会撞穿容器边线，有框态必须显式归零 `margin-inline: 0`。
2. **链接型按钮内距与下划线重置**：基底用 `padding: 0; text-decoration: underline` 表现的次级动作按钮（如 `.action-link`、`.regen-link`、`.es-retry`），升格为立体按钮时必须补齐横向内距并去掉静息下划线。
3. **聚焦环与立体阴影合成**：`:focus-visible` 不能直接用单层 `box-shadow` 覆盖，否则会抹掉立体按钮的高光/暗边斜面；必须把外层焦点环与内层斜面变量组合声明。
4. **窗口内部背景变量重绑**：窗口化主题下根级 `--opt-bg` / `--lib-bg` 是外层桌面灰，进入白底详情窗或灰底列表窗容器时必须就地重绑 `--opt-bg` / `--lib-bg`，且粘性底栏 `bottom` 与面板 `padding-bottom` 互为相反数。
5. **次级紧凑图标簇尺度**：标题栏、面板头、划词气泡色点旁的次级图标按钮统一走 sm 档 `20×20px`（`var(--pp-control-h-sm)`，立体态配精简斜面 `--pt-mini-bevel`）；其 `::before` 命中区基于 padding-box（`18×18px`）计算，必须写 `inset: -3px` 才能满足 `24×24px` 命中区硬门。
6. **`:is()` 特异性零污染**：Selectors Level 4 中 `:is(A, B)` 取参数最高特异性。共用的 `.btn` 规则内若需按 `#id` 排除元素，必须写成 `:not(:where(#id1, #id2))` 清零 ID 特异性，并显式 `:not(.saved-success, .save-error)`，防止 `(1,x,x)` 吞掉提交按钮的成功/报错反馈与 `.listbox-btn[aria-expanded="true"]`。
7. **`:not()` 布尔分划完备与融合子格排他**：拆分普通态与危险态时避免 `.btn:not(.danger)` + `.btn.danger:not(.ghost)` 漏掉 `.btn.danger.ghost`；通用 `.btn` 选择器必须排除融合输入框内部子格（如 `.vocab-group-step`），避免破坏一体式值盒子。
8. **粘性伪元素标题栏滚动留白**：在滚动窗格顶部用 `position: sticky; top: 0` 的 `::before` 绘制窗口标题栏时，必须同步给滚动容器设置不小于标题栏高度的 `scroll-padding-top`（桌面端 `28px`），防止键盘 Tab 与 `scrollIntoView` 将首项控件藏入标题栏背面。

## 3. 五大表面瞬态与 `pinboard.in` 全页面检查表

每次跨主题改动先审视「这个问题在其他主题或相邻表面是否同样存在」，不要只修截图里点名的单点：

- **扩展四表面高频遗漏点**：
  - 全页文本选区 `::selection`：阅读器必须在文档根级绑定 `background: var(--selection); color: var(--fg)`（不能只绑 `#rendered-view`，否则侧栏、Ask、查词弹层与要点区在深色下失明）；站点各 pilot 的 `selection-bg` 必须同时与 `bg` 和 `bg-surface` 保持可辨识度（`> 1.02:1`）。
  - 浮层与瞬态：阅读器加载骨架（首帧即挂主题外壳与阅读栏宽，消除跳变）、`#pb-hl-card`（无笔记与有笔记双态、`field-sizing: content` 自适应高度）、`#kbd-help-pop`（`max-height: calc(100dvh - 2 * var(--sp-4))` 防多余滚动条）、原生 `select` 弹层 `::picker(select)`、`setBtnIcon` 空 `<span>` 对 flex `gap` 的偏移、`<details><summary>` 展开箭头的伪元素/背景图去重。
- **`pinboard.in` 特殊页面矩阵（在 `docs/theme-surface/composers/classic-list-v2.mjs` 与 `_patterns.mjs` 统一兜底）**：
  - `/search/`：右侧栏 ID 为 `#search_right_bar`（非 `#right_bar`！表格悬浮、删除链与搜索框规则必须双挂）；顶部分页 `#top_next_prev` 为右浮动，`#bookmarks` 及其首段、`div.bookmark` 必须 `clear: both`，防止首条 `.display` 向右缩进空出一大块。
  - `/network/`：同样含右浮动 `#top_next_prev` 与 `.user_navbar`。
  - `/popular/`：`#right_bar` 嵌套在 `#main_column` **内部**并以 `position: absolute; left: 710px; width: 320px` 定位，必须在 `@media (max-width: 1060px)` 回退为静态流式布局防横向溢出。
  - `/u:<user>/` 行内编辑：`.bookmark` 被设为 flex 容器后，行内展开的 `.bookmark > #edit_bookmark_form` 必须设 `flex: 0 0 100%; max-width: 100%; box-sizing: border-box` 防撑破右边界。
  - `/u:<user>/profile/`：左栏首块是无类名的 `#profile_left_column > div:not(.service_box):first-child`，须与 `.service_box` 同步卡片化。
  - `/u:<user>/from:notes/` 与 `/note/<id>/`：源站 HTML 存在未闭合 `<div class="note">` 导致后续条目层层嵌套，必须用 `#bookmarks .note .note` 剥离内层重复边框、阴影与内距。
  - `/tabs/`、`/bundles/`、`/tweets/`、`/settings/*`、`/howto/`、`/add`：全局隐藏无实质子节点的空 `#right_column:not(:has(a, p, div, ul, ol, table))`，避免画出空框。

## 4. 必跑验证管线

```bash
# 1. 若改动了 docs/theme-surface/ 下的 composer 或 pilot：生成并跑通全部工厂门
node docs/theme-surface/tools/sync-all.mjs
node docs/theme-surface/tools/sync-all.mjs --check
node docs/theme-surface/tools/cascade-lint.mjs
node docs/theme-surface/tools/override-drift.mjs
node docs/theme-surface/tools/token-coverage.mjs

# 2. 改动 md-preview.css / platinum-controls.css / 表面 HTML·CSS·JS：跑编辑期门、对比度门与静态契约门
node scripts/ui-consumer-lint.mjs --file platinum-controls.css
node tests/md-preview-contrast-tests.mjs
node tests/ui-contract-tests.mjs

# 3. 评估受影响渲染场景并在真实 Chromium 验证站点/扩展渲染
node scripts/audit.mjs --changed --plan
xvfb-run -a node tests/pinboard-theme-render-tests.mjs
```
