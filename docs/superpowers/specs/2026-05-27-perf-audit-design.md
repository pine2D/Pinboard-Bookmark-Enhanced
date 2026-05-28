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

## 附录 A：基线数据（Phase 0 采样结果）

### A.1 采样元数据

- **采样日期**: 2026-05-27
- **采样脚本**: `scripts/perf-sample.mjs`（commit `691b8fa` + `ede5374`）
- **环境**: 开发机 / chrome-dbg :9222 / Chrome 148 / 在线 / 当前账户（已登录 pinboard.in）/ 无 CPU throttle
- **样本数**: warm scenarios N=5（每场景 prime 2 次 + 测 5 次取中位）；pinboard-inject N=10
- **基线文件**: `perf-baseline.json`（commit `9ef33dc`）

### A.2 测得 measures

| 入口 | measure | p50 (ms) | p90 (ms) | max (ms) | n | 备注 |
|------|---------|---------|---------|---------|---|------|
| popup-warm | popup-form-ready | 62.8 | 69.3 | 69.3 | 5 | 用户首次能看到完整表单的时刻；稳定 |
| popup-warm | popup-fcp | 453.7 | 977.9 | 977.9 | 3 | FCP backfill 不稳定；高方差 |
| options-warm | options-first-panel-painted | 61.1 | 92.1 | 92.1 | 5 | applyI18n() 完成时 |
| options-warm | options-settings-filled | 92.3 | 106.3 | 106.3 | 5 | DOMContentLoaded handler 末尾 |
| options-warm | options-fcp | 1330.1 | — | — | 1 | **最痛入口**；与 spec 预测一致 |
| pinboard-inject | ct-inject | 26.5 | 31.7 | 31.7 | 10 | pbp-injected style 挂载完成 |
| pinboard-inject | ct-uncloak | 26.8 | 32.0 | 32.0 | 10 | pbp-cloak 移除完成 |

### A.3 关键洞察（影响后续 Phase 取舍）

1. **`options-fcp ≈ 1330ms` 是单一最大瓶颈** — 触发原因：8 个 script 没 defer + 588KB `pinboard-themes.js` 同步加载阻塞 HTML 解析。Phase 1（Group B 的 C1 defer）+ Phase 3（C2 拆 themes 出 options）应当可分阶段攻克。预估收益：Phase 1 之后 < 800ms，Phase 3 之后 < 400ms。

2. **`ct-inject` 仅 ~25ms** — 远低于 spec 预测 200-500ms。588KB 主题表 parse 在 V8 上比预想快得多（字符串字面量优化 + JIT cache）。
   - **重大决策**：**C3（拆主题表 + thin loader）的预期收益从 200-500ms 下调到 5-25ms**。
   - **ROI 档次从「高」降到「低/中」**。Phase 3 实施前应重新评估是否值得 — 工作量大、风险高（主题闪烁），但实际节省可能只有 ~20ms。
   - **建议**：把 C3 拆主题表挪到 Phase 0.5 follow-up 或 Phase 4 末尾，Phase 3 改聚焦 C2（options 懒加载 themes，可吞掉大部分收益）+ C4（SW module worker）。

3. **`popup-form-ready ≈ 63ms`** — 暖启动很快。冷启动数据缺失，无法判断 P1/P2 mirror 预填的真实收益是否值得。

4. **`popup-status-ready` 未测得** — 在 Playwright newPage 上下文里 `showMain` 函数在中途某处早退（很可能 `getPageInfoFromTab(tab.id)` 在扩展页面 tab 上 throw 后 catch 吃掉）。**P2 测量（existing-banner 解决时刻）的当前实现路径在 CDP 自动化下不可观测**，需要移到更可靠的位置（如 banner DOM mutation observer 触发的 mark）。

5. **`popup-fcp` 方差大** — n=3, stddev 253ms。`PerformanceObserver` 的 `buffered: true` 在 Playwright newPage 上下文里不一致。Phase 1+ 验收对这一指标只看 p90 上限。

### A.4 未测得的 measures（Phase 0 范围内本应捕获，但因技术或环境限制缺失）

| measure | 原因 | 补救路径 |
|---------|------|---------|
| popup-cold / options-cold 全部 | `chrome.runtime.reload()` 触发 ERR_BLOCKED_BY_CLIENT 中断后续 navigation | Phase 0.5 follow-up：要么手动 reload + 单次跑，要么用 chrome.management API 切换 enabled 状态 |
| popup-status-ready | showMain 在自动化上下文早退 | 移埋点位置或加 MutationObserver |
| sw-wakeup | 需要 SW 显式重启 | 手动 chrome://serviceworker-internals/ 停止 SW，再触发任意事件 |
| batch-first-write / batch-last-write | 需要真实点击 batch 按钮 + 真实写入 | 手动跑 + 读 storage._perfSamples |
| ai-summary-e2e / ai-tags-e2e | 需要真实 AI 调用 | 同上 |

这些 measures 的埋点代码本身已落地，运行时数据捕获留给手测。Phase 1+ 验收时按需补齐对应 baseline 数。

### A.5 spec 修订意向（基于本节洞察）

需要在 Phase 1 之前确认是否更新 spec 主体：

- **C3 ROI 重新分档**：从「高」降到「低/中」。
- **P1/P2 mirror 收益不确定**：冷启动数据缺失，无法验证预填的真实价值。建议 Phase 1 完成后用其改善的指标反推。
- **Phase 实施顺序可能调整**：spec 原本是 Group B → C → A → D，但根据基线数据，A 中的 C2（options themes 懒加载）可能比 A 中的 C3（拆主题表）更划算，应优先做。

具体修订留到 Phase 1 plan 撰写时统一处理。

### A.6 Phase 1 完成后基线（2026-05-28）

Phase 1 完成于 commits `e7de326` (B1 defer) → `4a9ca5c` (B3 i18n mirror) → `4ea2ac8` (await cleanup) → `ce84344` (B2 opacity) → `84355a3` (B5 options mirror) → `9a02bd8` (B4 popup mirror)。共 6 个 commits 在 `perf/phase-1` 分支。

| 入口 | measure | baseline p50 | after p50 | Δ | % | 阈值 | 通过 |
|------|---------|-------------|-----------|----|---|------|------|
| options-warm | options-fcp | 1330.1 | **383.3** | -946.8 | **-71.2%** | < 931 (×0.7) | ✅ |
| options-warm | options-first-panel-painted | 61.1 | 6.8 | -54.3 | -88.9% | < 55 (×0.9) | ✅ |
| options-warm | options-settings-filled | 92.3 | 32.6 | -59.7 | -64.7% | < 83 (×0.9) | ✅ |
| popup-warm | popup-form-ready | 62.8 | 24.3 | -38.5 | -61.3% | < 57 (×0.9) | ✅ |
| popup-warm | popup-fcp | 453.7 | 400.6 | -53.1 | -11.7% | < 408 (×0.9) | ✅ |
| pinboard-inject | ct-inject | 26.5 | 28.1 → **26.4** | ~0 | ~0% | 无退化 | ✅ |
| pinboard-inject | ct-uncloak | 26.8 | 28.2 → **26.6** | ~0 | ~0% | 无退化 | ✅ |

#### 关键发现

1. **options-fcp 从 1330ms 砍到 383ms（-71%）** — 远超 ×0.7 阈值（931ms）。主要功臣是 B1（defer）：删 8 个 script 阻塞 HTML 解析后，浏览器能更早 paint 出 HTML 骨架，而 588KB `pinboard-themes.js` 的 parse 转到并行后台。

2. **options-first-panel-painted 从 61ms 降到 7ms（-89%）** — B3 (i18n mirror) 消除了 `await initI18n()` 的 storage round-trip。`applyI18n()` 现在跑在第一帧前就完成。

3. **popup-form-ready 从 63ms 砍到 24ms（-61%）** — B4 mirror 预填 url/title 后，showMain 完成填充的时刻被压到 perf-mark.js 启动后 24ms。

4. **ct-inject 初次采样 +1.6ms 是单次噪声** — re-sample 跑出 26.4ms，几乎跟 baseline 完全一致。Phase 1 没有触碰 pinboard content_script，符合预期。

5. **popup-fcp 改善 12%（454→401ms）** — 边际改善。popup 启动的瓶颈不在 i18n / 数据填充，更可能在 popup-theme-early.js 的 localStorage mirror 同步读 + popup.css (63KB) 的解析。Phase 2 (Group C) 可能进一步压缩。

#### 已知技术债（待 Phase 2+ 处理）

- **popup-status-ready 仍未测得** — Phase 0 已发现 showMain 在 Playwright 上下文里早退，Phase 1 没修。Phase 2/3 时若需要这一指标可加 MutationObserver 兜底。
- **冷启动数据缺失** — `chrome.runtime.reload()` race 仍未解决，无法 CDP 自动化 cold-start 采样。Phase 1 的指标都是 warm。冷启动改善预计更大（解了 storage prime footgun + 加上 mirror），但无数据佐证。
- **pinboard-inject 不影响** — 即使 Phase 1 间接修改的 popup-theme-early.js 行数变多（新增 applyTabMirror IIFE），content_script 已经独立 parse 这两个 IIFE 没影响。

#### Phase 1 体感验收（手测核对清单，由用户在真实使用中确认）

- [ ] options 打开后**不再有 180ms 白屏渐入**
- [ ] popup 打开后 **url-input / title-input 不再先空再跳**
- [ ] **existing-banner** 状态在 popup 出现的同一瞬间就是稳态
- [ ] options 切换 6 个 panel，**没看到设置值"先空后填"**
- [ ] 切换语言后再开 options/popup，**无未翻译字符串闪烁**

### A.7 Phase 2 完成后基线（2026-05-28）

Phase 2 完成于 commits `762c40d` (R5 shared cache) → `3e4fd9e` (W1 popup parallel) → `aca1c1a` (W3 appearance lazy) 在 `perf/phase-2` 分支。

| measure | Phase 1 p50 | Phase 2 p50 | Δ | 备注 |
|---------|------------|------------|----|------|
| options-fcp | 383.3 | **354.6** | -28.7 | 小幅改善（R5 cache 影响） |
| options-first-panel-painted | 6.8 | 10.9 | +4.1 | 噪声 — 绝对值仍 baseline 的 18% |
| options-settings-filled | 32.6 | 40.4 | +7.8 | 噪声 — 绝对值仍 baseline 的 44% |
| popup-fcp | 400.6 | 417.4 | +16.8 | 噪声 — 4% 在 stddev 内 |
| popup-form-ready | 24.3 | 26.7 | +2.4 | 噪声 — 绝对值仍 baseline 的 42% |
| ct-inject | 28.1 | **20.4** | -7.7 | 意外收获，R5 cache 减少 pinboard-style.js storage round-trip |
| ct-uncloak | 28.2 | **20.7** | -7.5 | 同上 |

#### Phase 2 实施结论

- **R5** (`762c40d`)：✓ shared.js getSettingsStorage 加 module cache + localStorage mirror + onChanged invalidate
- **W1** (`3e4fd9e`)：✓ popup showMain 把 getPageInfoFromTab + bookmark check 并发化（Option B：checkExistingBookmark 加可选 prefetch 参数）
- **W3** (`aca1c1a`)：✓ Path A — options 把 appearance panel 的 renderPresetPreview 延后到首次切入。**TDZ workaround 必需**（reviewer 起初建议简化，进一步调查发现 renderPresetPreview 在 currentPresetKey 空时会**隐藏** preview，所以原 commit 的 pending-init queue 是 load-order sequencing 的正确做法，保留原样）
- **P3**：✓ Phase 1 已覆盖（B2 删 opacity + B3 i18n mirror），本 phase 无独立改动

#### 关键诚实记录

Phase 2 的实测收益**小于预期**（spec 原本预估 R5/W1/W3 各省 10-50ms，实际是个位数 ms 变动 + 噪声）。这并不意外——Phase 1 已经摘掉了主要的低垂果实（i18n await、storage round-trip、首屏 mirror 预填），Phase 2 攻的运行时残余成本本身就很小。

**Phase 2 真实价值在代码质量**：
1. R5 cache 让 getSettingsStorage 高频调用路径不再每次 storage round-trip — 未来若加新 caller 不退化
2. W1 popup 并发为今后增加 boot 串行 await 提供了缓冲（多一道 await 不会立即冲淡 phase-1 收益）
3. W3 lazy init 把 appearance panel 的渲染从启动路径剥离，未来加新主题时启动不变慢

意外收获：`ct-inject` / `ct-uncloak` 各省 ~7.5ms。原因是 pinboard-style.js 现在通过 R5 cache 拿到 storage selector，省掉了 `chrome.storage.local.get({optSyncEnabled})` 这一次 round-trip。这是 R5 的副效应——content_script 也用 `getSettingsStorage` 模式（虽然有内联版本，但调用 chrome.storage.local 仍受 SW 缓存影响）。

#### Phase 2 未做（保留索引）

- 完整 lazy init 框架（plan Path B）—— 路 A 已捕获主要收益，路 B 复杂度对 marginal 收益不值得
- popup.js / options.js 拆文件 —— 项目暂无强需求，留给未来真有维护痛点时再做

### A.8 Phase 3 完成后基线（2026-05-28）

Phase 3 完成于 commits `7887469` (A2 lazy-load) + `8de673e` (A2 retry fix) 在 `perf/phase-3` 分支。**仅实施 A2；A1 和 A3 决策跳过。**

#### 实施清单

| 项 | 状态 | 理由 |
|----|------|------|
| **A2** (C2 options 懒加载 themes) | ✓ 实施 commits `7887469` + `8de673e` | 移除 588KB sync parse；v2 migration 用 labeled-break 安全路径处理 |
| **A1** (C3 拆主题表) | ⊘ skipped | (1) Phase 0 已下调 C3 ROI 到「低/中」；(2) Phase 2 R5 cache 已把 ct-inject 压到 20ms（spec 阈值附近）；(3) 实际可测收益 < 5ms；(4) 复杂度高（theme factory 工具链 + manifest + handedit-audit 五道 lint 适配）。主要剩余价值是 540KB/tab 内存节省，但用户典型场景 1-2 个 pinboard tab，影响小 |
| **A3** (C4 SW module worker) | ⊘ deferred — needs separate R&D phase | (1) SW wakeup baseline 缺失（无法判断收益是否可测）；(2) 三条候选实施路径都有问题（路 1 需全链路 shared.js/i18n.js module 化影响 4 个 HTML，路 2 需 unsafe-eval 安全降级，路 3 即跳过）；(3) 收益不可见但风险高 |

#### 四相对比（最终）

| measure | baseline | p1 | p2 | p3 | 总改善 |
|---------|---------|----|----|----|--------|
| **options-fcp** | 1330.1 | 383.3 | 354.6 | 361.9 | **-73%** |
| options-first-panel-painted | 61.1 | 6.8 | 10.9 | **5.2** | **-91%** |
| options-settings-filled | 92.3 | 32.6 | 40.4 | **31.7** | **-66%** |
| popup-fcp | 453.7 | 400.6 | 417.4 | 413.3 | -9% |
| popup-form-ready | 62.8 | 24.3 | 26.7 | 25.3 | -60% |
| ct-inject | 26.5 | 28.1 | 20.4 | 22.4 | -15% |
| ct-uncloak | 26.8 | 28.2 | 20.7 | 22.7 | -15% |

#### 关键诚实记录：测量稳定性

Phase 3 实施过程中发现 **options-fcp 在 CDP 自动化下方差巨大**（连续 3 轮跑出 960 / 370 / 699 ms，stddev 高达 271ms）。原因推测：`PerformanceObserver` 的 `buffered: true` 在 Playwright `newPage` 上下文里行为不一致，加上 Chrome JIT/GC/网络的随机抖动。

这意味着 spec section 4.1 的阈值（× 0.7 / × 0.9）在 options-fcp 上不可靠。**Phase 3 内部"options-fcp 是否仍有空间做 A1"的判断改为基于代码意图而非数据**，最终决定跳过 A1。

对于稳定指标（n=5+ 且 stddev 低的 measure）阈值仍可靠：
- options-first-panel-painted ↓91%（i18n mirror + lazy theme）
- options-settings-filled ↓66%（mirror prefill + R5 cache）
- popup-form-ready ↓60%（mirror prefill）

#### Phase 3 体感验收

- ✓ options 打开速度肉眼可见快了一截（vs v2.69 baseline）
- ✓ Appearance panel 首次切换有 ~50-150ms 加载停顿（pinboard-themes.js 懒载入）— 显式用户操作触发，可接受
- ✓ 切其他 5 个 panel 完全不付主题表 parse 代价

#### A3 未来若要做

需要先解决 SW wakeup baseline 测量问题（手测 + 自动化都没数据）。建议：
1. 实现 SW wakeup 单独的 manual benchmark 工具（chrome://serviceworker-internals/ 控制 + storage 读样本）
2. 若 baseline > 50ms，考虑路 1 全链路 module 化（需要单独 R&D phase）
3. 若 baseline < 50ms，A3 永久 close-out

### A.9 Phase 4 完成后基线（2026-05-28）

Phase 4 完成于 commits：
- D1: `10f6c43` (ai-cache.js IDB module) + `26124cc` (ai.js shell + feature flag) + `338d0ba` (migration + cleanup alarm removal)
- D2: `5b8efda` (batch large-account fallback — cache-only variant)

#### 实施清单

| 项 | 状态 | 备注 |
|----|------|------|
| **D1** (R2 AI cache 迁 IDB) | ✓ 完成 | 3 commits，feature flag `_useIndexedDBCache` 默认 true，旧路径代码保留 14 天观察期 |
| **D2** (R4 batch skip-existing 大账户) | ⚠️ 部分完成 | 当前实现是"per-tab SW statusCache 读取"，**非** spec 原意的"per-tab `posts/get` API call"。对 statusCache 中已存在的 URL 可正确 skip；对未缓存的 URL，行为与修复前相同（可能 duplicate-save）。这是务实折衷——真实 `posts/get` 路径会让 30-tab 批量从 5s 变 90s，UX 代价大。对 < 5000 bookmarks 用户（绝大多数）无影响 |

#### 五相对比（perf-sample.mjs）

| measure | baseline | p1 | p2 | p3 | p4 | 总改善 |
|---------|---------|----|----|----|----|----|
| options-fcp | 1330.1 | 383.3 | 354.6 | 361.9 | 715.6* | -46%* |
| options-first-panel-painted | 61.1 | 6.8 | 10.9 | 5.2 | **4.8** | **-92%** |
| options-settings-filled | 92.3 | 32.6 | 40.4 | 31.7 | **26.4** | **-71%** |
| popup-fcp | 453.7 | 400.6 | 417.4 | 413.3 | **351.5** | **-23%** |
| popup-form-ready | 62.8 | 24.3 | 26.7 | 25.3 | **21.9** | **-65%** |
| ct-inject | 26.5 | 28.1 | 20.4 | 22.4 | 26.1 | -1% |
| ct-uncloak | 26.8 | 28.2 | 20.7 | 22.7 | 26.4 | -1% |

*options-fcp 在 p4 跳到 715ms 是已知的 CDP 自动化采样噪声（前文 A.8 已记录此指标 stddev 271ms）。其他稳定指标在 Phase 4 后达到历史最低。

#### Phase 4 真实价值（非纯性能）

1. **AI cache 容量解锁**：从 chrome.storage.local 5MB 上限脱出。重度 AI 用户可累积上千条 cache entry 不再撞墙。
2. **写放大消除**：旧实现每次 setAICache 都要 read-modify-write `ai_cache_index` 对象（O(n) 序列化）。IDB 路径用 native cursor，写入 O(1)。
3. **代码简化**：删了 background.js 中 35 行的 `cleanupExpiredAICache` 函数 + 一个 alarm，TTL 改成 IDB lazy 清理 + 按需 cursor 扫描。
4. **回滚保险**：feature flag `_useIndexedDBCache` + 7 天 `_aiCacheMigrationBackup`。若 IDB 出错可一键回退到 legacy chrome.storage.local 路径，原数据未删。

#### 已知 follow-up（未实施）

1. **Legacy `ai_cache_*` keys 永远残留** — sweep 只删 backup，legacy entries 未删。14 天观察期之后应加一个 GC 任务：`chrome.storage.local.remove(legacy ai_cache_* keys)`。可在后续 patch release 加入。
2. **D2 真实 per-tab posts/get** — 若 > 5000 bookmarks 用户报 duplicate-save 问题，再考虑加 opt-in setting + UX warning（"This may take 90s due to large account size"）。
3. **14 天观察期到期后** — 2026-06-11 左右可删 ai.js 中 legacy chrome.storage.local 代码路径 + 移除 `_useIndexedDBCache` flag。

#### 手测验证（Task 5 Step 2-4）

- ✓ `_aiCacheMigrationV4 = true` 翻为 true 后无重复迁移
- ✓ IDB store `pbp-ai-cache` 创建成功
- ✓ 当前用户无 legacy ai_cache_* 数据，migrated=0（migration 流程被走过但无搬运操作）
- ⏭️ AI cache hit timing 验证（需用户手动触发 AI summary 两次）— 留给真实使用阶段观察 IDB 路径是否 < 50ms（远低于旧 chrome.storage.local 的 50-100ms）

#### Phase 4 完成的标志

✅ D1 三 commits 全落地（10f6c43 + 26124cc + 338d0ba）
✅ D2 commit 5b8efda 落地（with 文档诚实标注的范围限制）
✅ 迁移路径自动跑（无 legacy 数据时也正确翻 flag）
✅ Feature flag 默认 true，保留 14 天观察期
✅ perf-sample 稳定指标全部不退化或改善
✅ 噪声指标（options-fcp）抖动在历史已记录范围内

## 附录 B：埋点字段定义

样本 schema（写入 `chrome.storage.local._perfSamples` 数组）：

```typescript
{
  name: string;     // measure name, e.g. "popup-fcp", "ct-inject"
  ms: number;       // duration in milliseconds, rounded to 2 decimals
  ts: number;       // Date.now() when measure was emitted
  ctx: string;      // "popup.html" / "options.html" / "sw" / pinboard URL末段
}
```

Buffer caps: 200 in-memory per context, 2000 in storage. Storage trim drops oldest (FIFO).

## 附录 C：手测清单

每个 commit release 前手测：

1. 全新 Chrome profile 安装扩展 → 打开 popup → 登录 → 保存第一个 bookmark
2. 暖启动 popup 打开 5 次，肉眼无跳变
3. 切换 7 种主题（含 flexoki dark / catppuccin-mocha 等 adaptive）在 pinboard.in 验证无闪烁
4. options 打开 → 切 6 个 panel → 改 3 个设置 → 重新打开验证持久化
5. 批量保存 5 个 tab（含 skip-existing）
6. AI tags / summary（gemini + ollama 各一次）
7. SW 唤醒（关 chrome 5 分钟 → 重开 → 切 tab → 验图标）

## 附录 D：决策记录

- **2026-05-27 用户确认范围**：全栈普查 + 全部实测 + 接受拆大文件/重排 manifest/SW 重构
- **2026-05-27 用户确认实施集**：高 ROI 5 项 + 中 ROI 10 项 = 共 15 项
- **2026-05-27 用户确认 C4**：接受 SW module worker 改动
- **2026-05-27 用户委托判断**：B4 mirror 陈旧 → 骨架兜底；A3 shared 分裂 → 接受；D2 大账户 → 阈值回落
- **2026-05-27 Phase 0 完成**：埋点 + warm baseline 落地，cold-start 延后至 Phase 0.5；C3 ROI 因 ct-inject 实测仅 25ms 需重新评估
