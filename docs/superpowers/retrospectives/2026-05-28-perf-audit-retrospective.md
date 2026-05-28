# Perf Audit 项目经验总结

> Retrospective for Pinboard Bookmark Enhanced performance overhaul (v2.69 → v2.71)
> Date: 2026-05-28
> Author: pine2D (with Claude Code subagent-driven)

## 一、项目元数据

| 维度 | 数据 |
|------|------|
| 时间 | 2026-05-27 → 2026-05-28（约 2 工作日） |
| 范围 | 30+ commits, 5 phases, 3 版本发布（v2.69 → v2.70 → v2.71） |
| 涉及文件 | 16 个核心文件（含新增 perf-mark.js / ai-cache.js / scripts/perf-sample.mjs） |
| 工具链 | Claude Code (subagent-driven) + Playwright CDP + chrome-dbg + 项目自带 theme factory + pre-commit hooks |
| 治理产物 | 1 spec（含附录 A.1-A.9）+ 5 plans + 5 baseline JSON + 5 feature branches + 1 baseline tag |

---

## 二、技术发现

### 真正起作用的优化（按实测 ROI 排序）

| 优化 | Phase | 实测改善 | 启示 |
|------|-------|---------|------|
| **options.html 加 defer** | 1 (B1) | options-fcp **-947ms** | 最大单一收益，1 行 HTML 属性 |
| **i18n.js 改 sync mirror** | 1 (B3) | first-panel-painted **-54ms** | 消除 boot path 的唯一 storage await |
| **popup mirror 预填 url/title/banner** | 1 (B4) | form-ready **-38ms** + 体感"立刻显示" | localStorage 同步层 + chrome.storage 异步校对 |
| **options 高频字段 mirror** | 1 (B5) | settings-filled **-59ms** | 同上 pattern |
| **options 懒加载 themes** | 3 (A2) | options-fcp 再 -10~20ms（噪声内） | 删 588KB 同步 parse；但 defer 已经把这个 cost 移到 fcp 之后了 |
| **R5 getSettingsStorage cache** | 2 | ct-inject 意外 -7ms + 多处微优 | 共享层 cache 受益面广 |

### Spec 预测 vs 实测的偏差

| Spec 预测 | 实测 | 教训 |
|----------|------|------|
| **C3 拆主题表 200-500ms** | < 5ms（V8 parse 588KB 实际只要 ~25ms） | spec 不应靠估算，应靠 Phase 0 实测后再分档 |
| **B1 defer 80-200ms** | -947ms | 估算保守得离谱 |
| **W1 popup 并发 40-100ms** | 数据噪声内 | Phase 1 mirror 已经吃掉了这部分预期 |
| **W3 options lazy panel 30-80ms** | 数据噪声内 | 同上 |

→ **核心教训：性能优化的 ROI 必须有"先 baseline 再排序"的环节，不能从 spec 主观估算直接进实施。**

### 5 phase 累计性能改善

| measure | baseline | 最终 (p4) | 总改善 |
|---------|---------|----------|--------|
| **options-first-panel-painted** | 61ms | **4.8ms** | **-92%** |
| **options-settings-filled** | 92ms | **26.4ms** | **-71%** |
| **popup-form-ready** | 63ms | **21.9ms** | **-65%** |
| **options-fcp** | 1330ms | ~360ms* | -73% |
| **popup-fcp** | 454ms | **351.5ms** | **-23%** |
| ct-inject | 26.5ms | 26.1ms | -1%（noise） |

*options-fcp 数据噪声大（stddev 271ms），取 phase-3 稳定测量值

---

## 三、过程方法论

### 工作流编排

```
brainstorming → writing-plans → subagent-driven-development
                                    ↓
            （每 task: implementer → spec-review → code-review → fix loop）
                                    ↓
                  validate (perf-sample 实测) → spec 附录 A.x
                                    ↓
                  ff-merge to main → bump → release
```

每 phase 独立：

- 独立 spec 章节 + 独立 plan 文件 + 独立 feature 分支 + 独立 perf-baseline JSON
- 决策点写进 plan（如 A1 跳过条件：`options-fcp < 250 && ct-inject < 20`）
- spec 附录 A.1-A.9 持续追加实测数据 + 诚实标注 deferred/partial/noise

### Subagent 流程数据

| 指标 | 值 |
|------|---|
| 总 dispatch 次数 | ~50（per-task implementer + 2 reviewers） |
| BLOCKED 次数 | 3（每次都暴露了 plan 没预见的真实问题） |
| Review-driven fix 次数 | 4（小幅 follow-up commit） |
| Implementer 主动改良 spec 次数 | 2（如 D1.c labeled break 优于 return） |
| 全程 `--no-verify` 次数 | 0 |
| 数据驱动决策跳过的 spec 项 | A1（拆主题表，ROI 过低）/ A3（SW module worker，风险/收益不对等） |

---

## 四、做对的事

1. **第一性原理：先建测量基础**
   Phase 0 单独投 11 commits 建埋点 + 自动化采样器，给后续每 phase 提供可比基线。如果没有 Phase 0，C3 不会被降级、A1 不会被跳过、所有 ROI 判断都是猜的。

2. **每 phase 独立验收，避免 all-or-nothing**
   Phase 1 已经把主要瓶颈砍掉了。Phase 2/3/4 即使收益减少也不会让前面的成果白费。

3. **决策点写进 plan 而不是 spec**
   Spec 是"想做什么"，plan 是"基于数据决定怎么做"。A1/A3 的跳过判断都在 plan 里有明确的阈值条件，避免了"必须做完 spec 才完整"的执念。

4. **诚实记录失败/部分/噪声**
   A.6 / A.7 / A.8 / A.9 都明确标注：
   - "ct-inject +1.6ms 是单次采样噪声"
   - "options-fcp stddev 271ms 单 run 不可靠"
   - "D2 是 cache-only 变体，非 spec 原意的 posts/get"
   - "A1 跳过，理由：[具体阈值]"

5. **回滚路径优于"完美方案"**
   Feature flag (`_useIndexedDBCache`) + 7 天数据 backup + 14 天观察期。哪怕 IDB 路径出 bug，一个 `chrome.storage.local.set` 就能回退。

---

## 五、教训

### 测量层面

1. **`PerformanceObserver` FCP 在 CDP 自动化下方差巨大** — 同一配置连续 3 跑出 960/370/699 ms。stddev > p50。**单 run 数据不能下退化判断**。
2. **n=5 warm sample 不够**。要么 n=20+，要么换稳定 metric（如 PerformanceTiming 同步字段、storage round-trip）。
3. **CDP 跑 popup ≠ 真实使用**。Playwright `newPage` 上下文里 `showMain` 中 `getPageInfoFromTab` 会早退，导致 `popup-status-ready` 永远测不到。生产环境是好的，测量自动化是坏的。
4. **`buffered: true` 不可靠**：FCP 有时被 `PerformanceObserver` 错过，n 数明显少于运行次数。

### 流程层面

1. **subagent output 频繁截断**（实测多次发生在 4-7 turn 的 implementer 任务中）— 拆小 task 比写大 prompt 更稳。
2. **subagent 不知道之前 task 的失败/成功**。每次 dispatch 都要重复项目背景。我把这个负担承担在 controller 端（写 prompt 时复述上下文），子代理质量明显提升。
3. **Review 子代理偶尔过度反应**。Phase 2 Task 3 的 W3 TDZ workaround 被 review 建议简化；幸亏 fix subagent 自己又做了深查，发现简化会破坏 UX。**review 提建议、不直接 fix 是对的**。
4. **诚实标注比好看的数字重要**。Phase 2 数据本可以挑漂亮的 metric 写"全面改善"，但我们记录了"5/7 measure 在噪声内浮动"。这种诚实给 Phase 3 提供了正确的判断基础。

### 架构层面

1. **manifest 改动成本远高于代码改动**。A3 SW module worker 三条候选路径都有问题（shared.js / i18n.js 双形式化、unsafe-eval 安全降级、保持现状）。**值得 deferred**。
2. **theme factory 工具链是 sunk cost**。A1 真的拆主题表需要适配 5 道 pre-commit lint + sync-all.mjs + handedit-audit — 不值得为 < 5ms 改善付。
3. **mirror pattern 是低悬果**。localStorage 同步预填 + chrome.storage 异步校对，几乎对每个 boot 场景都适用，且实现简单。

---

## 六、可复用资产

| 资产 | 用途 | 可移植性 |
|------|------|---------|
| **`perf-mark.js`**（76 行）| 跨 context perf 测量原语 | 通用 MV3 项目 |
| **`scripts/perf-sample.mjs`**（266 行）| CDP-driven 自动采样 | 任何 chrome-dbg + Playwright 项目 |
| **Mirror prefill pattern** | UI 启动优化 | 通用 Web UI |
| **Feature flag rollback pattern** | Storage 后端迁移 | 通用 |
| **Spec 模板**（决策点 + ROI 表格 + 风险矩阵 + 附录持续追加）| 中等复杂度 overhaul | 通用 |
| **Plan 模板**（pre-flight + 每 task 决策点 + validate）| Subagent-driven 执行 | 通用 |

---

## 七、关键教训一句话

1. **先测后改**：未量化的 ROI 都是猜测。
2. **每 phase 都能停**：完整 spec 不是成功标准，递增价值才是。
3. **接受噪声**：n=5 的 warm sample 不支持 5% 阈值判断。
4. **回滚优于完美**：feature flag + backup 让任何 risky 改动都可逆。
5. **诚实文档比漂亮数字重要**："deferred / partial / noise" 是合法状态。

---

## 八、本次项目留下的"未做"清单

按时间顺序记录，方便未来 perf 项目重启时直接接续：

### 短期（14 天内观察期到期后，约 2026-06-11）

- [ ] 删 `ai.js` 中 legacy `chrome.storage.local` 路径代码 + 移除 `_useIndexedDBCache` flag
- [ ] GC legacy `ai_cache_*` keys（避免永久残留在 storage.local）
- [ ] 验证 `_aiCacheMigrationBackup` 已被 `sweepAICacheMigrationBackup` 自动清理（7 天 TTL）

### 中期（视用户反馈）

- [ ] **D2 真实 per-tab posts/get** — 若 > 5000 bookmarks 用户报 duplicate-save 问题，加 opt-in setting + UX warning（"This may take 90s due to large account size"）
- [ ] **popup-status-ready 测不到的问题** — 移埋点位置或加 MutationObserver 兜底
- [ ] **CDP-friendly FCP 测量** — 用更稳定 metric 替代 PerformanceObserver buffered FCP

### 长期（独立 R&D phase）

- [ ] **A1 拆主题表** — 若内存敏感场景（多 pinboard tab）成为问题再启
- [ ] **A3 SW module worker** — 需先做 SW wakeup baseline 工具 + 评估 shared.js / i18n.js 双形式化方案

### 永不做（已 close-out）

- W2（SW 推 cached posts 到 session storage）— 已被 P1/P2 实质覆盖
- R1（adoptedStyleSheets 替代 `<style>` 注入）— 5-20ms 收益不值改造
- R3（`_pbRateLimitTs` 改 SW 内存）— 5-15ms 偶发，跨上下文同步反而引入复杂度
- P5（batch 立即显示 progress）— 视觉打磨，无指标收益
