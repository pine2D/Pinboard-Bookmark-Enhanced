# Performance Audit Phase 2 — Runtime Optimizations (Group C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 已把 i18n/数据填充层面的低垂果实摘完。Phase 2 攻 popup/options 内部运行时残余成本——`getSettingsStorage` 重复 storage round-trip、popup `getPageInfoFromTab` 与 bookmark 查询串行、options 6 个 panel 一次性绑定全部 listener。

**Architecture:** 3 项独立小优化 + 1 项已被 Phase 1 自然覆盖的 spec 收口。R5（storage selector cache）改 shared.js 单点；W1（popup 数据并发）只动 showMain 内部 await 顺序；W3（options panel lazy init）引入 `_initPanel(name)` 入口，把"绑事件"和"填值"分离。

**Tech Stack:** 同 Phase 1（vanilla JS / chrome.storage / localStorage mirror / Promise.all）

**Spec reference:** `docs/superpowers/specs/2026-05-27-perf-audit-design.md` Section 3 Group C（W1/W3/P3/R5 共 4 项）

**Baseline reference:** Phase 1 完成后基线 `perf-after-phase1.json`（commit `9134f08`）

**P3 状态**：已在 Phase 1 `ce84344` (B2 删 body opacity) + `4a9ca5c` (B3 i18n mirror) 完成。本 plan 不重复实现，验收阶段标注「已达成」即可。

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `shared.js` | 修改 | `getSettingsStorage()` 加 module-level cache + onChanged invalidation + localStorage mirror |
| `popup.js` | 修改 | `showMain` 内 `getPageInfoFromTab` + bookmark check 并发化（Promise.all） |
| `options.js` | 修改 | DOMContentLoaded 只跑 active panel 的 listener 绑定；tab 切换触发 `_initPanel(name)` 幂等绑定 |
| `perf-after-phase2.json` | 创建 | Phase 2 完成后采样数据 |
| `docs/superpowers/specs/2026-05-27-perf-audit-design.md` | 修改 | 追加附录 A.7（Phase 2 数据） |

---

## Pre-flight

### Task 0: 创建 perf/phase-2 分支

**Files:** none

- [ ] **Step 1: 确认 main 是 Phase 1 已合并状态**

```bash
git log --oneline -1 main
```

Expected: `772e3bc chore: bump manifest to 2.70`

- [ ] **Step 2: 从 main 创建分支**

```bash
git checkout -b perf/phase-2 main
git branch --show-current
```

Expected: `perf/phase-2`

---

## Task 1: R5 — `getSettingsStorage` cache + localStorage mirror

**Files:**
- Modify: `shared.js`（约 line 223-230）

**Spec mapping:** R5（中 ROI）— 预估每个入口启动省 10-20ms（去掉 storage.get round-trip）

- [ ] **Step 1: 定义期望行为**

```
- getSettingsStorage() 第一次调用：读 chrome.storage.local.get({optSyncEnabled})，缓存结果到 module-level 变量 _settingsStorageCache
- 后续调用：直接返回缓存（无 await round-trip，但函数签名保持 async 不破现有 await 调用方）
- chrome.storage.onChanged 监听 optSyncEnabled，变化时 invalidate cache
- localStorage 同步 mirror：写 pp-sync-enabled。第一次调用先尝试 mirror，命中则同步可用、异步刷新校对
- mirror 不命中时按原 storage.get 路径走（不退化）
```

- [ ] **Step 2: 修改 `shared.js`**

定位当前 `getSettingsStorage` 函数（约 line 223-230）：

```javascript
// ---- Settings storage selector (sync vs local based on user preference) ----
// The preference itself is always stored in chrome.storage.local (bootstrap location)
async function getSettingsStorage() {
  try {
    const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
    return optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
  } catch (_) {
    return chrome.storage.local;
  }
}
```

替换为（保留同名 async 函数 + module 变量 + onChanged listener）：

```javascript
// ---- Settings storage selector (sync vs local based on user preference) ----
// The preference itself is always stored in chrome.storage.local (bootstrap location).
// R5: cached + invalidated on optSyncEnabled change. First call seeds from localStorage
// mirror if present (synchronous fast path), then storage.get confirms.
let _settingsStorageCache = null;

// Sync fast-path: hydrate from localStorage mirror if available.
// Caller still treats getSettingsStorage as async (signature preserved).
try {
  if (typeof localStorage !== "undefined") {
    const m = localStorage.getItem("pp-sync-enabled");
    if (m === "1") _settingsStorageCache = chrome.storage.sync;
    else if (m === "0") _settingsStorageCache = chrome.storage.local;
  }
} catch (_) {}

async function getSettingsStorage() {
  if (_settingsStorageCache) return _settingsStorageCache;
  try {
    const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
    _settingsStorageCache = optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
    try { localStorage.setItem("pp-sync-enabled", optSyncEnabled ? "1" : "0"); } catch (_) {}
    return _settingsStorageCache;
  } catch (_) {
    return chrome.storage.local;
  }
}

// Invalidate cache + mirror when user toggles optSyncEnabled
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.optSyncEnabled) {
      _settingsStorageCache = null;
      try {
        const v = changes.optSyncEnabled.newValue;
        if (typeof v === "boolean") localStorage.setItem("pp-sync-enabled", v ? "1" : "0");
      } catch (_) {}
    }
  });
}
```

- [ ] **Step 3: 验证 SW 兼容**

In SW context (`background.js`), `localStorage` is undefined. The two `try { localStorage... } catch (_) {}` wrappers handle this — module init still runs, just skips mirror.

```bash
node --check shared.js
```

Expected: exit 0.

- [ ] **Step 4: 验证 callers 全部兼容**

`getSettingsStorage()` 还是 async。所有 `await getSettingsStorage()` 仍正常工作。`grep -n "getSettingsStorage" *.js | head -10` 应该看到多处调用，都不需要改动。

- [ ] **Step 5: Commit**

```bash
git add shared.js
git commit -m "perf(shared): cache getSettingsStorage selector with localStorage mirror"
```

Pre-commit hook 应该静默通过（未触碰 theme-surface / pinboard-themes.js）。

---

## Task 2: W1 — popup `showMain` 并发化

**Files:**
- Modify: `popup.js`（`showMain` 函数体内部，约 line 226 后）

**Spec mapping:** W1（中 ROI）— 预估 popup 端到端可视稳态时间省 30-80ms（getPageInfoFromTab + bookmark check 并发）

> **注意 Phase 1 余量**：popup-form-ready p50 已 24ms（B4 mirror 预填覆盖了主感知点）。本任务影响的是 **popup-status-ready** 之前的内部串行——即从 form-ready 到 existing-banner 决议之间。这个间隔 Phase 1 没测到（status-ready 在 CDP 上下文里没触发）。Phase 2 目标是消除可测情境下的串行 cost；用户体感上 status-ready 与 form-ready 之间的间隔已经因 mirror 而几乎不可见。

- [ ] **Step 1: 定义期望行为**

```
- showMain 在拿到 tab 后，把 getPageInfoFromTab(tab.id) 和 bookmark 数据请求改成 Promise.all 并发
- 不改变后续依赖这两个结果的代码（pageInfo / existingBookmark 被赋值后才用）
- 不破坏 Phase 1 的 popup-form-ready mark 触发时机（必须在 url/title 填好后立即）
- 不破坏 Phase 1 的 popup-status-ready mark 触发时机（必须在 existing-banner 决议后）
```

- [ ] **Step 2: 读 `popup.js` showMain 内部 await 链**

```bash
sed -n '226,260p' popup.js
```

定位三段：
- A: `const [tab] = await chrome.tabs.query(...)` 后填 url/title 的位置
- B: `pageInfo = (await getPageInfoFromTab(tab.id)) || {...}` 行（约 line 234-236）
- C: bookmark 查询路径起点（搜 `chrome.runtime.sendMessage` + `get_bookmark_data`）

A → B 之间的 sync 代码必须保留在 A 后立即（包括 form-ready mark）。B 和 C 之间没有依赖（pageInfo 不需要 bookmark 数据；bookmark 查询只需要 tab.url）。

- [ ] **Step 3: 改造**

定位 popup.js 中目前**串行**的两段：

```javascript
// Current pattern (sequential):
//   ... pbpMark("popup-form-ready") ...
//   pageInfo = (await getPageInfoFromTab(tab.id)) || { ... };
//   ... URL clean / form sync ...
//   ... later: const bookmarkResp = await new Promise(r => chrome.runtime.sendMessage({type: "get_bookmark_data", url: tab.url}, r));
```

改成并发版本：在 `pbpMark("popup-form-ready")` 后立刻并发启动两个 promise，后续在需要时分别 await。

具体改动模板（实现者按实际行号定位）：

```javascript
  // Phase 2 W1: kick off page-info extraction and bookmark check in parallel.
  // pageInfo only needs tab.id; bookmark check only needs tab.url. Independent.
  const _pageInfoPromise = tab ? getPageInfoFromTab(tab.id) : Promise.resolve(null);
  const _bookmarkPromise = tab && tab.url
    ? new Promise(resolve => chrome.runtime.sendMessage(
        { type: "get_bookmark_data", url: tab.url },
        resp => { void chrome.runtime.lastError; resolve(resp || null); }
      ))
    : Promise.resolve(null);

  pbpMark("popup-form-ready");
  pbpMeasure("popup-form-ready", "popup-t0", "popup-form-ready");

  // ... existing Phase 1 / B4 prefill validation code (do not touch) ...

  // When pageInfo is needed (was: `pageInfo = await getPageInfoFromTab(...)`):
  pageInfo = (await _pageInfoPromise) || {
    url: tab?.url || "", title: tab?.title || "",
    selectedText: "", metaDescription: "", referrer: "", pageText: ""
  };

  // ... later, when bookmark data is needed:
  const _bookmarkResp = await _bookmarkPromise;
  // ... continue using _bookmarkResp.posts as before
```

> **重要：** 不要把两条 promise 用 `await Promise.all([a, b])` 一次性 await 完。原因：用 `_pageInfoPromise` / `_bookmarkPromise` 独立 await 允许两条 promise 真并发，后续代码在需要时单独 await，最大化并发窗口。`Promise.all` 在这个场景没有额外好处（结果使用点不同）。

执行者**必须先**读 popup.js 找到三个具体行号（form-ready mark 行 / pageInfo 赋值行 / bookmark sendMessage 行）然后做最小改动。如果发现 bookmark 数据通过 `checkExistingBookmark()` 函数封装而不是直接 sendMessage，改成在 showMain 顶部启动 promise，把封装函数改成接受可选的 cached promise。

如果定位不出确切的并发点（即 sendMessage 出现在 showMain 之外、不易并发），STOP 并报告 BLOCKED，说明你看到的结构。

- [ ] **Step 4: 验证语法 + 指标 mark 仍按原位**

```bash
node --check popup.js && grep -n "popup-form-ready\|popup-status-ready" popup.js
```

Expected: 4 hits（2 marks × 2 occurrences each: 1 mark + 1 measure），位置与 Phase 1 一致。

- [ ] **Step 5: Commit**

```bash
git add popup.js
git commit -m "perf(popup): parallelize getPageInfoFromTab and bookmark check in showMain"
```

---

## Task 3: W3 — options panel lazy init

**Files:**
- Modify: `options.js`

**Spec mapping:** W3（中 ROI）— 预估 options settings-filled 路径省 20-50ms（非 active panel 的 listener 绑定延后到 tab 切换时）

> **Phase 1 余量**：options-settings-filled 已 33ms。Phase 2 收益约 5-15ms（settings 回填本身已快，只能省 listener 绑定 cost）。**实施者注意**：如发现 init cost 主要来自 settings 回填而非 listener 绑定，本任务可降级或放弃——见 Step 7 决策点。

- [ ] **Step 1: 定义期望行为**

```
- 引入 _initPanel(name) 函数：幂等地为指定 panel 绑定 listener / 渲染预览
- DOMContentLoaded 仍然 await settings 一次，并把所有 panel 的字段值填进 DOM（这部分必须保留以保证 saveAll 完整）
- 但 listener 绑定（事件订阅、动态渲染如 theme preview、API test 按钮）延后到对应 panel 首次显示时
- tab 切换 click handler 内调用 _initPanel(panelName)，幂等（用 Set 跟踪已 init panel）
- 启动时仅对 active panel 调用 _initPanel
```

- [ ] **Step 2: 摸 options.js 实际结构**

```bash
sed -n '1,50p' options.js
grep -n "panel-\|initPanel\|tab-btn" options.js | head -30
```

定位：
- panel 切换 handler 在哪里（应该在 DOMContentLoaded 前段）
- 哪些 init 是"设置字段值"（必须保留在启动）
- 哪些 init 是"绑事件 / 动态渲染"（可延后）

候选延后项：
- API key 字段的 connection test 按钮 wiring（AI panel）
- theme preview 渲染（appearance panel — 注意 Phase 0 数据显示这里很重）
- accordion 展开 handler（多处可见）
- panel reset 按钮 handler（每个 panel 一个）

- [ ] **Step 3: 实施判断**

读完结构后，**有两条路可选**：

**路 A：渐进式 lazy init（推荐）**
只对 appearance panel 的 theme preview 渲染做 lazy（它最重）。其他 listener 保留原启动绑定。这能拿到约 50% 的预期收益，风险极低。

**路 B：完整 lazy init 框架**
引入 `_initPanel(name)` + `_panelInited Set`，所有 6 个 panel 接入。能拿到 100% 预期收益，但代码改动大、风险高。

如选**路 A**：

定位 appearance panel 的 theme preview 渲染调用（搜 `renderPresetPreview` 或类似）。把该渲染从 DOMContentLoaded 提取到一个 `_initAppearancePanel()` 函数，并：
- DOMContentLoaded 检查 active panel 是否是 appearance：若是，立即调用；否则跳过
- tab 切换 handler 检测切到 appearance panel：调用 `_initAppearancePanel()` 一次（幂等用一个 `let _appearanceInited = false` 守门）

如选**路 B**：

实现完整的 `_initPanel(name)` 框架。Spec 已经描述。具体代码由实施者按实际 options.js 结构产出。

- [ ] **Step 4: 实施（选路 A 的代码模板）**

在 options.js 顶部 module scope 加：

```javascript
let _appearanceInited = false;
function _initAppearancePanel() {
  if (_appearanceInited) return;
  _appearanceInited = true;
  // Move existing appearance-specific init code here:
  // - renderPresetPreview() and similar theme preview rendering
  // - any other appearance-only listener wiring that's slow at boot
}
```

在 DOMContentLoaded handler 内，找到 appearance panel 当前的渲染调用，替换为：

```javascript
  // Phase 2 W3: appearance panel init deferred unless it's the active panel at boot
  const _activePanelAtBoot = document.querySelector(".tab-btn.active")?.dataset?.panel;
  if (_activePanelAtBoot === "appearance") _initAppearancePanel();
```

在 tab 切换 handler 内（找到 `.tab-btn` click handler），在切到 panel 之后加：

```javascript
    // Lazy-init the panel being switched to (idempotent)
    if (btn.dataset.panel === "appearance") _initAppearancePanel();
```

**重要：** 字段值回填（form input population）**不要动**——必须保留在启动以保证 saveAll 正确性。本任务只延迟 listener 绑定 / 动态渲染。

- [ ] **Step 5: 验证 settings 不丢**

```bash
node --check options.js
```

手测一次 options 打开 → 切到 appearance panel → 改 theme → 切回 general → save → 重新打开 options 验证持久化。**该手测在 Task 4 验收阶段做**，本任务只做代码改动。

- [ ] **Step 6: Commit**

```bash
git add options.js
git commit -m "perf(options): lazy-init appearance panel theme preview rendering"
```

如果选了路 B，commit message 改为 `lazy-init non-active panels via _initPanel framework`。

- [ ] **Step 7: 决策点 — 如果路 A 收益 < 5ms 或路 B 风险评估太高**

实施者如发现 settings-filled p50 在改动后没明显改善（重新跑 perf-sample 验证），或路 B 引入的 bug 风险无法在 Phase 2 内验证（如 saveAll 漏字段），**回滚本任务的 commit** (`git revert <sha>`) 并报告 "Task 3 deferred — no measurable benefit"。Phase 2 仍可关闭，W3 标记为「实施后无收益，已回滚」。

---

## Task 4: Validate — 重测对比 + 更新 spec

**Files:**
- Create: `perf-after-phase2.json`
- Modify: `docs/superpowers/specs/2026-05-27-perf-audit-design.md`（追加附录 A.7）

- [ ] **Step 1: chrome-dbg 里重新加载扩展 + 唤醒 SW**

`chrome://extensions/` → "重新加载"。点扩展图标唤醒 SW。

- [ ] **Step 2: 跑采样**

```bash
node scripts/perf-sample.mjs \
  --ext-id aghcegglioapkbgjmbgkmkiiijccoiln \
  --only popup-warm,options-warm,pinboard-inject \
  --runs 10 \
  --out perf-after-phase2.json
```

- [ ] **Step 3: 三方对比（baseline / after-phase1 / after-phase2）**

```bash
python3 -c "
import json
files = ['perf-baseline.json', 'perf-after-phase1.json', 'perf-after-phase2.json']
labels = ['baseline', 'phase-1', 'phase-2']
data = [json.load(open(f))['results'] for f in files]
print(f'{\"scenario\":<18} {\"measure\":<32} ' + ' '.join(f'{l:<14}' for l in labels) + 'Δ(p2-p1)')
print('-' * 110)
scenarios = sorted(set().union(*data))
for scn in scenarios:
    measures = sorted(set().union(*(d.get(scn, {}) for d in data)))
    for k in measures:
        ps = [d.get(scn, {}).get(k, {}).get('p50') for d in data]
        delta = None if (ps[1] is None or ps[2] is None) else round(ps[2] - ps[1], 1)
        row = f'{scn:<18} {k:<32} '
        for p in ps:
            row += f'{p:<14}' if p is not None else f'{\"—\":<14}'
        row += f'{delta:+.1f}' if delta is not None else '—'
        print(row)
"
```

- [ ] **Step 4: 验收阈值（spec section 4.1 适配 Phase 2）**

| measure | 验收 | 阈值 |
|---------|------|------|
| popup-form-ready | 不退化（已优于 Phase 1） | ≤ 24ms p50 |
| popup-fcp | 不退化 | ≤ 401ms p50 |
| options-fcp | 不退化 | ≤ 383ms p50 |
| options-first-panel-painted | 不退化 | ≤ 7ms p50 |
| options-settings-filled | 路 A 期望 ≤ 25ms（-8ms），路 B 期望 ≤ 20ms（-13ms） | 不退化即可 |
| ct-inject / ct-uncloak | 不退化 | ≤ 28ms p50 |

> **Phase 2 验收宽松度**：Phase 1 已超额完成主要目标。Phase 2 收益预期很小（R5/W1 单点 ~10ms），主要价值是**代码质量**（一致性 + 未来不退化保险）。**所有 measure 不退化** 是必须；improvement 是加分。

- [ ] **Step 5: 体感手测**

打开 popup / options / 切 panel / 改设置 / 保存 / 重开验证持久化。如选 Task 3 路 B，**特别关注 saveAll 没漏字段**（手测每个 panel 都改一个值 → 保存 → 重开验证）。

- [ ] **Step 6: 更新 spec 附录 A.7**

在 `docs/superpowers/specs/2026-05-27-perf-audit-design.md` A.6 末尾追加：

```markdown
### A.7 Phase 2 完成后基线（2026-XX-XX）

Phase 2 完成于 commits `<R5 sha>` (R5) → `<W1 sha>` (W1) → `<W3 sha>` (W3 路 A 或 B 或回滚) → validate。

| measure | Phase 1 p50 | Phase 2 p50 | Δ | 备注 |
|---------|------------|------------|----|------|
| ...（填入实测） | | | | |

#### Phase 2 实施结论

- R5：✓ 实施 + commit `<sha>`
- W1：✓ 实施 + commit `<sha>`，popup 内部 await chain 缩短
- W3：✓/⊘ <路径选择 + 实测收益描述>
- P3：✓ Phase 1 已覆盖（B2 删 opacity + B3 i18n mirror），本 phase 无独立改动
```

填入实测数字 + 标注 W3 走的是路 A 还是路 B 还是回滚。

- [ ] **Step 7: Commit baseline + spec 附录**

```bash
git add perf-after-phase2.json
git add -f docs/superpowers/specs/2026-05-27-perf-audit-design.md
git commit -m "test(perf): capture phase 2 after-baseline and validate"
```

---

## Self-Review

### 1. Spec coverage

| Spec Group C 项 | 覆盖任务 |
|---|---|
| W1 popup 数据并发化 | Task 2 |
| W3 options panel lazy init | Task 3 |
| P3 options 立即显示 + 渐进翻译 | Phase 1 已覆盖（B2 + B3），本 plan 标注 |
| R5 getSettingsStorage cache | Task 1 |

无 gap。

### 2. Placeholder scan

- 无 "TBD" / "TODO"
- Task 2 Step 3 包含的"实施者按实际行号定位"是因为 popup.js 复杂结构需要让 subagent 自己读，提供完整代码模板 + 明确并发点。这不是 placeholder，是"提供 pattern 让实施者套用"的设计。
- Task 3 Step 3 提供两条具体路径（A / B）+ 决策标准，不是"implement later"占位。
- Task 4 Step 6 的"`<R5 sha>`" 等是 validate 阶段要填入实测数据的位置，标准做法。

### 3. Type consistency

- `getSettingsStorage` 签名（async function 返回 storage 对象）跨 Task 1 / 现有 callers 一致
- localStorage mirror key 命名：`pp-sync-enabled` 跟 Phase 1 的 `pp-` 前缀一致
- `_settingsStorageCache` / `_appearanceInited` / `_initAppearancePanel` 命名遵循 `_` 私有前缀
- pbpMark / pbpMeasure 命名 Phase 0 来不变

### 4. 任务依赖

Task 1 (R5) — 独立
Task 2 (W1) — 独立  
Task 3 (W3) — 独立（可能用到 R5 cache 提供的更快 getSettingsStorage，但不强依赖）
Task 4 — 依赖 1-3 全部落地

可并行 1+2+3，但顺序执行更安全。建议 1 → 2 → 3 → 4。

---

## Phase 2 完成的标志

- ✅ R5 实施
- ✅ W1 实施
- ✅ W3 实施或回滚（带数据决策）
- ✅ P3 标注「Phase 1 已覆盖」
- ✅ perf-after-phase2.json + spec 附录 A.7 落地
- ✅ 所有 measure 不退化

## 总 Commit 数

4-5 个：3 个实施 + 1 个 validate（如 W3 路径选择简单的话）。如 W3 回滚则多一个 revert commit。

## Phase 3+ 衔接

Phase 2 完成后下一步是 **Phase 3 (Group A)** — manifest / 文件结构改动，攻 options-fcp 383ms 残余 + SW wakeup。包含 C2 (options 懒加载 themes)、C3 (拆主题表，ROI 已下调到中)、C4 (SW module worker)。
