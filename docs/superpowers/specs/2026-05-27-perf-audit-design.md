# Performance Audit & Overhaul — Design Spec

**Date**: 2026-05-27
**Author**: pine2D (with Claude)
**Status**: Draft → pending implementation plan
**Baseline version**: v2.69
**Scope**: 全栈性能普查 + 高/中 ROI 项实施

---

## 0. Background

历史上 popup / options 打开延迟问题反复修过多轮（v2.22 perf sprint、B6 rate-limit 串行化分析、storage-warm alarm、localStorage mirror 等），但缺乏一份**完整的全栈性能审计**。本次目标是：

1. 对所有性能相关入口（popup / options / SW wakeup / pinboard.in 注入 / 批量保存 / AI 调用）建立可重复的测量基线
2. 列出全部已知优化项，按 ROI 排序
3. 落实高/中 ROI 项（共 15 项），每项均有 before/after 数据支撑
4. 给后续未做的低 ROI 项留索引

约束：
- **可改架构**：拆大文件、重排 manifest 注入时机、Service Worker 入口重构均接受
- **保持无构建**：不引入打包工具（项目 CLAUDE.md 明文要求）
- **保持无新依赖**：所有改动用浏览器原生 API + 项目现有工具栈

---

## 1. 测量埋点 + 基线采样

### 1.1 埋点工具

新增 `perf-mark.js` (~50 行)，四端共用：

```
pbpMark(name)                        // performance.mark
pbpMeasure(name, fromMark, toMark)   // 计算并写入 buffer
pbpFlush()                           // 写入 chrome.storage.local._perfSamples
```

- 样本存 `chrome.storage.local._perfSamples`，环形 buffer 每入口 cap 500 条
- 开关：`chrome.storage.local._perfEnabled`，**默认 false**（不影响真实用户）

### 1.2 埋点位置

| 入口 | T0 | 关键中间点 / 终点 |
|------|----|----------------|
| popup open | `popup-theme-early.js` 顶部 | FCP / form-ready / status-ready |
| options open | `options-theme-early.js` 顶部 | FCP / first-panel-painted / settings-filled |
| SW wakeup | `background.js` 顶部 | importScripts done / onMessage 首响 |
| pinboard.in 注入 | `pinboard-themes.js` 顶部 | `#pbp-injected` mounted / `#pbp-cloak` 移除 |
| 批量保存 | batch button click | 1st write / last write |
| AI 端到端 | AI button click | result rendered |

### 1.3 采样脚本

`scripts/perf-sample.mjs` — 复用项目现有 CDP 工具栈（`docs/theme-surface/tools/screenshot-themes.mjs` 已用 chrome-remote-interface + Playwright connectOverCDP）。

- **冷启动样本**：每次跑前 `chrome.runtime.reload()` + 5s wait
- **暖启动样本**：连续 5 次操作，丢前 2 次取后 3 次中位数
- 每入口 N=10
- 输出 `perf-baseline.json`（p50 / p90 / max / mean ± stddev）

### 1.4 跑测口径

| 维度 | 取值 |
|------|------|
| 机器 | 开发机 + CPU 4× throttle |
| 网络 | 在线 + 离线 |
| 浏览器状态 | 标签数 1 vs 30 |
| 数据集 | 空账户 / 中等账户（500 tags）/ 大账户（5000+ tags） |

### 1.5 本节完成的标志

- `perf-mark.js` 四端注入完成
- `scripts/perf-sample.mjs` 一键跑完所有入口
- `perf-baseline.json` 落盘，覆盖上表所有维度
- 报告 markdown 嵌入本 spec 作为附录

---

## 2. 普查清单（5 维度 × 19 项）

### 维度 1 — 入口冷启动

| ID | 项 | 收益 | ROI |
|----|----|------|-----|
| C1 | options.html 全部 script 加 defer | 80–200ms | 高 |
| C2 | `pinboard-themes.js` 在 options 改懒加载 | 100–300ms | 高 |
| C3 | 拆 `pinboard-themes.js` + manifest 改 thin loader 注入 | 200–500ms parse + 540KB/tab | 高 |
| C4 | SW module worker + ai.js 按需 import | 30–80ms / wakeup | 中 |
| C5 | i18n.js 加 localStorage mirror | 20–50ms | 中 |
| C6 | 去 options `body opacity:0` 强制等待 | 体感 ~180ms TTI 前移 | 中 |

### 维度 2 — 入口暖启动

| ID | 项 | 收益 | ROI |
|----|----|------|-----|
| W1 | popup 首屏数据填充并发化 | 40–100ms | 中 |
| W2 | SW 推 cached posts 到 session storage | 10–30ms | 低 |
| W3 | options panel lazy init | 30–80ms initial | 中 |

### 维度 3 — 运行时

| ID | 项 | 收益 | ROI |
|----|----|------|-----|
| R1 | pinboard.in 主题改 adoptedStyleSheets | 5–20ms | 低 |
| R2 | AI cache 迁 IndexedDB | 50–100ms/hit + 容量解锁 | 中 |
| R3 | `_pbRateLimitTs` 改 SW 内存 + sendMessage | 5–15ms 偶发 | 低 |
| R4 | batch skip-existing 改单次 `posts/all` | N × 3.1s | 中 |
| R5 | `getSettingsStorage` selector 缓存 | 10–20ms × 2 | 中 |

### 维度 4 — 用户体感

| ID | 项 | 收益 | ROI |
|----|----|------|-----|
| P1 | popup url/title 用 mirror 预填 | 50–150ms 视觉延迟 | 高 |
| P2 | popup existing-banner 由 SW statusCache 预渲染 | 100–300ms 视觉延迟 | 高 |
| P3 | options 立即显示 + 渐进翻译 | 翻译跳变 | 中 |
| P4 | options 设置值 mirror 预填 | 80–200ms | 中 |
| P5 | batch 立即显示 progress | 体感"立即响应" | 低 |

### 维度 5 — 内存 / 生命周期

| ID | 项 | 状态 |
|----|----|------|
| M1 | statusCache capped 500 | 已正确 |
| M2 | content_script 主题表 540KB/tab | 跟随 C3 |
| M3 | `_checkDebounceTimers` 清理 | 已正确 |
| M4 | AI cache index 写放大 | 跟随 R2 |

### ROI 汇总

- **高 (5)**：C1, C2, C3, P1, P2
- **中 (10)**：C4, C5, C6, W1, W3, R2, R4, R5, P3, P4
- **低 (4)**：W2, R1, R3, P5

**本次实施范围：高 + 中（共 15 项）。低 ROI 项保留作未来索引。**

---

## 3. 改造方案（按模块分组）

### Group A — manifest.json + 文件结构

#### A1. C3：拆 `pinboard-themes.js` + manifest 改 thin loader

- 拆 `pinboard-themes.js` → `themes/<key>.js`（13 个，每个 ~40KB）+ `themes/index.json`
- manifest `content_scripts` 只留 `pinboard-style.js`（thin loader），删 `pinboard-themes.js` 注入
- `pinboard-style.js` 改：读 `themePresetKey` → `chrome.scripting.executeScript` 注入对应主题 → 注入 CSS
- 加 `web_accessible_resources` 让 content_script 能 fetch `themes/*.js`
- **风险**：注入时机后移引入主题闪烁。**缓解**：`#pbp-cloak` 保留到主题 JS 加载完成；兜底从 800ms 收到 400ms
- **验收**：pinboard inject T0→T2 p50 < 200ms；单 tab 常驻 540KB → ~40KB

#### A2. C2：`pinboard-themes.js` 不再被 options.html 同步加载

- options.html 删 `<script src="pinboard-themes.js">`
- options.js `renderPresetPreview` 改：appearance panel 切换时 `await import("./themes/<key>.js")`
- **风险**：首次切 appearance panel 卡顿 ~50ms。**缓解**：可接受
- **验收**：options settings-filled p50 降 100–300ms

#### A3. C4：SW module worker + ai.js 懒加载

- manifest `background.service_worker` 加 `"type": "module"`
- background.js `importScripts(...)` → ES `import`
- ai.js 改 ES module
- 调用点 `const { callAI } = await import("./ai.js")`，结果 memoize 在 SW 内存
- **风险**：shared.js / i18n.js 在 content_script 里不能再共享。**缓解**：pinboard-style.js 已内联 storage selector，i18n 在 content_script 里没用，可分裂
- **验收**：SW wakeup T0→T1 p50 降 30–80ms

### Group B — 入口 HTML + early script

#### B1. C1：options.html 加 defer

- 8 个 `<script>` 加 `defer`
- A2 之后 pinboard-themes.js 已移除
- **风险**：defer 保留 DOM 顺序，无功能风险
- **验收**：options open FCP p50 降 80–200ms

#### B2. C6：去 options `body opacity:0`

- 删 options.js 顶部 `body.style.opacity` 设置 + 对应 CSS
- 依赖 C5 的 mirror 避免翻译跳变
- **验收**：体感

#### B3. C5：i18n.js 加 localStorage mirror

- `initI18n` 内部立刻读 `localStorage.getItem("pp-i18n-cache")` 同步返回
- 异步路径校对并写回 mirror
- `chrome.storage.onChanged` 监听语言切换主动 invalidate
- **风险**：切换语言后第一次打开仍是旧字符串
- **验收**：popup/options T0→form-ready p50 降 20–50ms

#### B4. P1 + P2：popup 同步预填 url/title/banner

- SW `onActivated` 写 `chrome.storage.session._currentTab = {url, title, posts, ts, tabId}`
- popup 同时维护 `localStorage.pp-last-tab` mirror（供下次冷启同步读）
- popup-theme-early **同步**读 localStorage mirror 预填 url-input / title-input / existing-banner
- popup-theme-early **异步**读 session storage 校对；timestamp 或 tabId 不匹配则显示骨架
- **风险**：陈旧数据视觉跳变。**缓解**：骨架策略
- **验收**：首屏正确数据时间 ≤ FCP（视频对比）

#### B5. P4：options 设置值 mirror 预填

- options-theme-early 扩展：高频字段（aiProvider / notify 开关 / 是否登录）写入 localStorage mirror
- 同步预填，异步校对
- mirror key 加 timestamp，超过 7 天强制走 storage
- **验收**：options settings-filled p50 降 80–200ms

### Group C — popup.js / options.js 运行时

#### C1-runtime. W1：popup 数据填充并发化

- 当前：串行 `await initI18n → settingsLoad → tabsQuery → bookmarkCheck`
- 改：`Promise.all([...])`
- 渲染按需 await 单个
- **验收**：popup form-ready p50 降 40–100ms

#### C2-runtime. W3：options panel lazy init

- DOMContentLoaded 只初始化 active panel
- 切换时 `initPanel(name)`（幂等）
- `saveAll` 跳过未初始化 panel 的字段
- **验收**：options settings-filled p50 降 30–80ms

#### C3-runtime. P3：options 立即显示 + 渐进翻译

- 配合 B2 删 opacity:0
- DOMContentLoaded：先 `applyI18nFromMirror()` 同步，再 `applyI18nFromAsync()` 刷新差异
- **验收**：体感

#### C4-runtime. R5：getSettingsStorage selector 缓存

- module-level 变量缓存
- `chrome.storage.onChanged` 监听 `optSyncEnabled` invalidate
- localStorage mirror `pp-sync-enabled` 提供冷启同步可用
- **验收**：popup/options T0→FCP p50 降 10–20ms

### Group D — 共享层运行时

#### D1. R2：AI cache 迁 IndexedDB

- 新增 `ai-cache.js`（IDB CRUD + LRU + TTL 懒清理）
- 替换 ai.js 里 `getAICache` / `setAICache`
- **迁移逻辑**：SW 启动检测 `chrome.storage.local.ai_cache_*` → 搬到 IDB → 备份到 `_aiCacheMigrationBackup` → 7 天后清
- 删 `cleanupExpiredAICache` + `ai-cache-cleanup` alarm
- **Feature flag**：`_useIndexedDBCache`，默认 true，14 天观察期保留旧路径代码
- **风险**：数据丢失。**缓解**：备份 + flag 可回退
- **验收**：AI cache hit < 5ms；storage.local 体积下降

#### D2. R4：批量保存 skip-existing 改 `posts/all`

- 开始批量前调一次 `posts/all`（cached 10 min），构建 URL set
- 每个 tab 只查内存
- **大账户回落**：`posts/all` 返回 > 5000 条时回落旧路径（per-tab `posts/get`）
- **风险**：`posts/all` 在大账户慢。**缓解**：阈值回退
- **验收**：skip-existing 批量 p50 < N × 0.3s

---

## 4. 验收门槛

### 4.1 每项硬指标

| 改动 | 指标 | 阈值 |
|------|------|------|
| C1 | options FCP p50 | < baseline × 0.7 |
| C2 | options settings-filled p50 | < baseline × 0.6 |
| C3 | pinboard inject T0→T2 p50 | < 200ms |
| C4 | SW wakeup T0→T1 p50 | < baseline × 0.7 |
| C5 / C6 | form-ready p50 | < baseline × 0.9 + 体感无跳变 |
| W1 / W3 | 对应入口 p50 | < baseline × 0.85 |
| R2 | AI cache hit | < 5ms |
| R4 | skip-existing batch p50 | < N × 0.3s |
| R5 | storage selector cost | < 1ms |
| P1–P5 | 首屏正确数据 | ≤ FCP，无视觉跳变 |

**统一硬规则**：任一改动如果 p50/p90 退化 > 5%，不合并。

### 4.2 通用门槛（每个 commit）

- pre-commit 5 道 lint 全通过
- 手测清单（见附录 B）通过
- commit message 含 before/after perf 数据
- 大改动含 feature flag

---

## 5. 风险与回滚

### 5.1 风险矩阵

| 风险 | 缓解 | 回滚路径 |
|------|------|---------|
| pinboard 主题闪烁（C3） | `#pbp-cloak` 保留 + 800ms 兜底 | `git revert <C3 commit>` + manifest 回旧 |
| SW 启动失败（C4） | 本地 reload 测过；release 前手测 5 种唤醒路径 | `git revert <C4 commit>` |
| AI cache 数据丢失（D1） | 备份 `_aiCacheMigrationBackup` + flag 14 天观察 | 关 flag → 旧路径；7 天内 backup 恢复 |
| popup 看陈旧数据（P1/P2） | timestamp + tabId 不匹配显骨架 | `git revert <B4 commit>` |
| 批量大账户卡顿（D2） | > 5000 bookmarks 阈值回落 | `git revert <D2 commit>` |
| 性能反而退化 | 每 commit 必带 before/after | 单 commit revert |

### 5.2 保护机制

1. **打 tag** `pre-perf-overhaul-v2.69`（实施前第一步）
2. **每 group 一个 PR**（5 个 PR，互不交叉）
3. **每个 commit 必带 perf 数据**（before / after / 差异说明）
4. **大改动 feature flag**：D1 的 IndexedDB 强制带 flag；其他改动如发现风险临时补 flag
5. **数据备份**：D1 的 IDB 迁移必须有 7 天 backup
6. **release 前完整手测**（附录 B 清单）

### 5.3 总体回滚策略

- 单项失败：`git revert <commit>` + 重发 release
- 多项失败：回到 `pre-perf-overhaul-v2.69` tag，重新规划
- 数据迁移失败（D1）：从 `_aiCacheMigrationBackup` 恢复 + 关 feature flag

---

## 6. 实施阶段与里程碑

| Phase | 内容 | Commit 数（预估） |
|-------|------|-----------------|
| 0 | 打 tag + 埋点 + 基线采样 | 2（埋点 + 采样脚本） |
| 1 | Group B（HTML/early script，5 项）| 2–3 |
| 2 | Group C（popup/options 运行时，4 项） | 2 |
| 3 | Group A（manifest + 文件结构，3 项，最高风险） | 3（每项独立） |
| 4 | Group D（共享层，2 项，含 IDB 迁移） | 2 |
| 5 | 全量 perf 复跑 + 汇总报告 + bump v2.70 release | 1 |

**预估总 commits**：12–13；预估总 PR：5。

---

## 7. 未实施项（低 ROI 索引）

留作未来：

- **W2** SW 推 cached posts 到 session（已被 P1/P2 部分实现）
- **R1** pinboard 主题改 adoptedStyleSheets
- **R3** `_pbRateLimitTs` 改 SW 内存 + sendMessage
- **P5** batch 立即显示 progress（视觉打磨，无指标收益）

---

## 附录 A：埋点字段定义

（待 Phase 0 实施时落地，本 spec 仅列接口）

## 附录 B：手测清单

每个 commit release 前手测：

1. 全新 Chrome profile 安装扩展 → 打开 popup → 登录 → 保存第一个 bookmark
2. 暖启动 popup 打开 5 次，肉眼无跳变
3. 切换 7 种主题（含 flexoki dark / catppuccin-mocha 等 adaptive）在 pinboard.in 验证无闪烁
4. options 打开 → 切 6 个 panel → 改 3 个设置 → 重新打开验证持久化
5. 批量保存 5 个 tab（含 skip-existing）
6. AI tags / summary（gemini + ollama 各一次）
7. SW 唤醒（关 chrome 5 分钟 → 重开 → 切 tab → 验图标）

## 附录 C：决策记录

- **2026-05-27 用户确认范围**：全栈普查 + 全部实测 + 接受拆大文件/重排 manifest/SW 重构
- **2026-05-27 用户确认实施集**：高 ROI 5 项 + 中 ROI 10 项 = 共 15 项
- **2026-05-27 用户确认 C4**：接受 SW module worker 改动
- **2026-05-27 用户委托判断**：B4 mirror 陈旧 → 骨架兜底；A3 shared 分裂 → 接受；D2 大账户 → 阈值回落
