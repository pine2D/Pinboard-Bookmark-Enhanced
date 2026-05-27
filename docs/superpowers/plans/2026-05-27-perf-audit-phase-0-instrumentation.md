# Performance Audit Phase 0 — Instrumentation & Baseline Sampling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 popup / options / SW / pinboard.in content_script / batch / AI 六条入口装上可量化的 perf marks，并跑一次自动化 CDP 采样产出 `perf-baseline.json`。

**Architecture:** 新增一个无依赖的 `perf-mark.js`（~70 行），通过 `<script>` / `importScripts` / manifest `content_scripts` 注入四种执行上下文。所有 measure 写入 `chrome.storage.local._perfSamples` 环形 buffer（cap 2000）。开关 `chrome.storage.local._perfEnabled` 默认 `false`，零开销发布给真实用户。采样脚本 `scripts/perf-sample.mjs` 复用项目现有的 `.qa-scan` + Playwright `connectOverCDP` 模式。

**Tech Stack:** Vanilla JS / Performance API (`performance.mark` + `performance.measure`) / chrome.storage.local / chrome-remote-interface / Playwright (existing `.qa-scan/node_modules`)

**Spec reference:** [`docs/superpowers/specs/2026-05-27-perf-audit-design.md`](../specs/2026-05-27-perf-audit-design.md) Section 1

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `perf-mark.js` | **创建** | pbpMark / pbpMeasure / pbpFlush 原语；buffer + enable gate |
| `scripts/perf-sample.mjs` | **创建** | CDP-driven 自动采样脚本，产出 perf-baseline.json |
| `manifest.json` | 修改 | 在 content_scripts 数组首位加入 perf-mark.js |
| `popup.html` | 修改 | 顶部加 perf-mark 引入 + 1 行 mark |
| `popup-theme-early.js` | 修改 | 顶部第 1 行 mark（T0） |
| `popup.js` | 修改 | DOMContentLoaded + form-ready + status-ready marks |
| `options.html` | 修改 | 同 popup.html |
| `options-theme-early.js` | 修改 | T0 mark |
| `options.js` | 修改 | DOMContentLoaded + settings-filled mark |
| `background.js` | 修改 | importScripts 增加 perf-mark.js；SW wakeup T0/T1 marks |
| `pinboard-style.js` | 修改 | content_script T1（pbp-injected mounted）+ T2（uncloak） marks |
| `popup-batch.js` | 修改 | batch button click + first/last write marks |
| `popup-ai.js` | 修改 | AI 端到端 marks |

---

## Pre-flight

### Task 0: 打基线 tag

**Files:** None

- [ ] **Step 1: 确认当前 git 状态干净**

```bash
git status --porcelain
```

Expected: 空输出（除了 `??` 的 `.superpowers/` 之类已知未跟踪目录）。

- [ ] **Step 2: 打 tag**

```bash
git tag -a pre-perf-overhaul-v2.69 -m "Baseline before performance audit overhaul (spec: docs/superpowers/specs/2026-05-27-perf-audit-design.md)"
```

- [ ] **Step 3: 推送 tag（询问用户确认后执行）**

```bash
git push origin pre-perf-overhaul-v2.69
```

> **不要自动 push。** 用户全局 CLAUDE.md 要求未明确请求不主动 push。先打本地 tag，把"是否 push"作为单独步骤让用户拍板。

- [ ] **Step 4: 验证 tag 存在**

```bash
git tag --list "pre-perf-overhaul-*"
```

Expected: `pre-perf-overhaul-v2.69`

---

## Task 1: 创建 `perf-mark.js`

**Files:**
- Create: `perf-mark.js`

- [ ] **Step 1: 定义期望行为**

```
- 暴露三个全局函数：pbpMark(name), pbpMeasure(name, fromMark, toMark), pbpFlush()
- pbpMark/pbpMeasure 是同步的，性能开销 < 0.1ms
- pbpMeasure 把样本 push 到内存 buffer（cap 200/上下文）
- pbpFlush 把 buffer 写入 chrome.storage.local._perfSamples（全扩展共享，cap 2000）
- 当 chrome.storage.local._perfEnabled === false 时，pbpFlush 清空 buffer 但不写入
- 在 popup/options 上下文，自动监听 visibilitychange/pagehide 触发 flush
- 在 SW/content_script 上下文，调用方需显式 await pbpFlush()
```

- [ ] **Step 2: 写代码**

```javascript
// ============================================================
// Pinboard Bookmark Enhanced - Performance Measurement Primitive
// ============================================================
// Cross-context (popup / options / SW / content_script) timing collector.
// Zero-cost when chrome.storage.local._perfEnabled is false (default).
// Samples go to chrome.storage.local._perfSamples (capped 2000).

const _pbpBuf = [];
const _PBP_BUF_CAP = 200;
const _PBP_STORAGE_CAP = 2000;
let _pbpEnabled = null; // null = unknown, true/false = cached

async function _pbpEnsureEnabled() {
  if (_pbpEnabled !== null) return _pbpEnabled;
  try {
    const { _perfEnabled = false } = await chrome.storage.local.get({ _perfEnabled: false });
    _pbpEnabled = !!_perfEnabled;
  } catch (_) { _pbpEnabled = false; }
  return _pbpEnabled;
}

function pbpMark(name) {
  try { performance.mark(`pbp:${name}`); } catch (_) {}
}

function pbpMeasure(name, fromMark, toMark) {
  try {
    const m = performance.measure(`pbp:${name}`, `pbp:${fromMark}`, `pbp:${toMark}`);
    _pbpBuf.push({
      name,
      ms: Math.round(m.duration * 100) / 100,
      ts: Date.now(),
      ctx: typeof document !== "undefined"
        ? (document.location.pathname.split("/").pop() || "doc")
        : "sw"
    });
    if (_pbpBuf.length > _PBP_BUF_CAP) _pbpBuf.shift();
  } catch (_) {}
}

async function pbpFlush() {
  if (!_pbpBuf.length) return;
  if (!(await _pbpEnsureEnabled())) { _pbpBuf.length = 0; return; }
  try {
    const { _perfSamples = [] } = await chrome.storage.local.get({ _perfSamples: [] });
    const merged = _perfSamples.concat(_pbpBuf);
    const trimmed = merged.length > _PBP_STORAGE_CAP
      ? merged.slice(-_PBP_STORAGE_CAP)
      : merged;
    await chrome.storage.local.set({ _perfSamples: trimmed });
    _pbpBuf.length = 0;
  } catch (_) {}
}

// Browser-context auto-flush (popup/options/content_script)
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pbpFlush();
  });
  window.addEventListener("pagehide", () => pbpFlush(), { once: true });
}

// Invalidate cached enable flag when toggled
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes._perfEnabled) _pbpEnabled = null;
  });
}

// Content-script T0: mark when perf-mark.js finishes loading on a non-extension page.
// This sidesteps modifying pinboard-themes.js (handedit-audit lint forbids non-composer
// lines there). perf-mark.js is listed first in manifest.content_scripts.js, so this
// mark fires immediately before pinboard-themes.js starts parsing.
if (typeof location !== "undefined" && location.protocol !== "chrome-extension:") {
  pbpMark("ct-t0");
}
```

- [ ] **Step 3: 手动验证（DevTools console）**

加载未打包扩展后打开 popup → F12 → 切换到 Console，执行：

```javascript
// 启用埋点
await chrome.storage.local.set({ _perfEnabled: true });

// 手动埋两个 mark
pbpMark("test-start");
await new Promise(r => setTimeout(r, 50));
pbpMark("test-end");
pbpMeasure("test", "test-start", "test-end");

// flush
await pbpFlush();

// 查看
const r = await chrome.storage.local.get("_perfSamples");
console.log(r._perfSamples);
```

- [ ] **Step 4: 验证输出**

Expected: `_perfSamples` 数组包含一条 `{ name: "test", ms: ~50, ts: <now>, ctx: "popup.html" }`。`ms` 在 45–60 范围内为正常（setTimeout 精度）。

- [ ] **Step 5: 清理测试数据**

```javascript
await chrome.storage.local.remove(["_perfSamples", "_perfEnabled"]);
```

- [ ] **Step 6: Commit**

```bash
git add perf-mark.js
git commit -m "feat(perf): add cross-context performance measurement primitive"
```

---

## Task 2: 装到 popup 入口

**Files:**
- Modify: `popup.html` (第 7 行附近，加入 `<script src="perf-mark.js">`)
- Modify: `popup-theme-early.js` (顶部加 mark)
- Modify: `popup.js` (DOMContentLoaded + form-ready + status-ready marks)

- [ ] **Step 1: 定义期望行为**

```
- T0: popup-theme-early.js 第一行 → mark "popup-t0"
- FCP 由 PerformanceObserver 自动捕获，转成 mark "popup-fcp"
- form-ready: showMain() 末尾，url-input 已填 → mark "popup-form-ready"
- status-ready: existing-banner 决议完成 → mark "popup-status-ready"
- 在 pagehide 时自动 flush（perf-mark.js 已内置）
- 期望测得至少 4 条 measure（cold-start 时）：popup-fcp, popup-form-ready, popup-status-ready
```

- [ ] **Step 2: 修改 `popup.html` (第 7 行后插入 perf-mark.js)**

当前第 7-8 行：
```html
  <script src="popup-theme-early.js"></script>
  <link rel="stylesheet" href="popup.css" />
```

改成（perf-mark.js 必须先于 popup-theme-early.js 加载）：
```html
  <script src="perf-mark.js"></script>
  <script src="popup-theme-early.js"></script>
  <link rel="stylesheet" href="popup.css" />
```

- [ ] **Step 3: 修改 `popup-theme-early.js` 第 1 行**

在文件顶部第一行（注释之前）插入：

```javascript
pbpMark("popup-t0");
```

- [ ] **Step 4: 修改 `popup.js` 加 FCP observer 和 form-ready / status-ready marks**

在 `popup.js` 文件顶部（`pinboardFetch` 之前）加入 FCP observer：

```javascript
// Perf: capture FCP
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === "first-contentful-paint") {
        performance.mark("pbp:popup-fcp");
        pbpMeasure("popup-fcp", "popup-t0", "popup-fcp");
      }
    }
  }).observe({ type: "paint", buffered: true });
} catch (_) {}
```

在 `showMain()` 函数末尾（找到 `async function showMain(token)` 的结束 `}` 之前最后一行可执行代码后）插入：

```javascript
  pbpMark("popup-form-ready");
  pbpMeasure("popup-form-ready", "popup-t0", "popup-form-ready");
```

> **注意：** `showMain` 实际上是 async 函数，可能在末尾还有 await 后续操作。把 mark 放在 url-input.value 赋值后立即——即"用户首次能看到完整表单"的那一行。具体行号需要打开 `popup.js` 查找 `function showMain` 并找到 `$id("url-input").value = ...` 第一次出现的位置，在其后插入。

在 existing-banner 决议代码后（搜索 `existing-banner` 在 popup.js 中的设置点，通常是 `$id("existing-banner").textContent = ...` 之后）插入：

```javascript
pbpMark("popup-status-ready");
pbpMeasure("popup-status-ready", "popup-t0", "popup-status-ready");
```

- [ ] **Step 5: 手动验证**

```javascript
// DevTools console (popup):
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
// 关闭 popup，重新打开
// 重新 F12 进 popup console:
await pbpFlush();
const r = await chrome.storage.local.get("_perfSamples");
console.log(r._perfSamples.filter(s => s.ctx === "popup.html"));
```

- [ ] **Step 6: 验证输出**

Expected: 至少 3 条样本 `{name: "popup-fcp", ...}`, `{name: "popup-form-ready", ...}`, `{name: "popup-status-ready", ...}`。FCP 通常 < 100ms，form-ready 通常 50-300ms，status-ready 通常 100-500ms。

如果缺 `popup-status-ready`：说明 existing-banner 未触发（当前 URL 不在 bookmark 里），属正常 — 在 bookmark 列表里的 URL 重新打开 popup 验证。

- [ ] **Step 7: Commit**

```bash
git add popup.html popup-theme-early.js popup.js
git commit -m "feat(perf): instrument popup open path with T0/FCP/form-ready/status-ready marks"
```

---

## Task 3: 装到 options 入口

**Files:**
- Modify: `options.html`
- Modify: `options-theme-early.js`
- Modify: `options.js`

- [ ] **Step 1: 修改 `options.html` 在 `options-theme-early.js` 之前插入 perf-mark.js**

当前第 563-570 行附近：
```html
<script src="i18n.js"></script>
<script src="options-theme-early.js"></script>
<script src="shared.js"></script>
...
```

改成（perf-mark.js 排首位）：
```html
<script src="perf-mark.js"></script>
<script src="i18n.js"></script>
<script src="options-theme-early.js"></script>
<script src="shared.js"></script>
...
```

- [ ] **Step 2: 修改 `options-theme-early.js` 第 1 行**

```javascript
pbpMark("options-t0");
```

- [ ] **Step 3: 修改 `options.js`：加 FCP observer + first-panel-painted + settings-filled marks**

`options.js` 顶部（DOMContentLoaded handler 之前）插入 FCP observer：

```javascript
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === "first-contentful-paint") {
        performance.mark("pbp:options-fcp");
        pbpMeasure("options-fcp", "options-t0", "options-fcp");
      }
    }
  }).observe({ type: "paint", buffered: true });
} catch (_) {}
```

在 DOMContentLoaded handler 内部，紧接 `applyI18n()` 之后（第 4 行左右），插入：

```javascript
pbpMark("options-first-panel-painted");
pbpMeasure("options-first-panel-painted", "options-t0", "options-first-panel-painted");
```

在 DOMContentLoaded handler 末尾，所有 settings 回填到 input 之后（搜索最后一处 `$id("...").value = s.xxx` 之后），插入：

```javascript
pbpMark("options-settings-filled");
pbpMeasure("options-settings-filled", "options-t0", "options-settings-filled");
```

> **注意：** options.js 的 settings 回填散落在 DOMContentLoaded handler 后半段，找"最后一处赋值"需要读完整个 handler。可保守地把 mark 放在 handler 的最后一行（`});` 之前的最后一句可执行代码后）。

- [ ] **Step 4: 手动验证**

```javascript
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
// 重新打开 options 页（chrome.runtime.openOptionsPage）
// F12 进 options console:
await pbpFlush();
const r = await chrome.storage.local.get("_perfSamples");
console.log(r._perfSamples.filter(s => s.ctx === "options.html"));
```

- [ ] **Step 5: 验证输出**

Expected: 3 条 — options-fcp, options-first-panel-painted, options-settings-filled。

- [ ] **Step 6: Commit**

```bash
git add options.html options-theme-early.js options.js
git commit -m "feat(perf): instrument options open path with T0/FCP/first-paint/settings-filled marks"
```

---

## Task 4: 装到 Service Worker

**Files:**
- Modify: `background.js`

- [ ] **Step 1: 定义期望行为**

```
- T0: importScripts 之前
- T1: importScripts done（即 importScripts 调用之后第一行）
- 立即 pbpFlush（SW 没有 visibilitychange，需手动）
- 期望测得 sw-wakeup 一条样本，ms 范围 5-50ms
```

- [ ] **Step 2: 修改 `background.js` 顶部**

当前第 1-8 行：
```javascript
// ============================================================
// Pinboard Bookmark Enhanced - Background Service Worker (v4.0)
// ============================================================

importScripts("i18n.js", "shared.js", "ai.js");

// Load manual language setting (async, t() falls back to browser locale until ready)
initI18n();
```

改成：
```javascript
// ============================================================
// Pinboard Bookmark Enhanced - Background Service Worker (v4.0)
// ============================================================

importScripts("perf-mark.js");
pbpMark("sw-t0");
importScripts("i18n.js", "shared.js", "ai.js");
pbpMark("sw-t1");
pbpMeasure("sw-wakeup", "sw-t0", "sw-t1");
pbpFlush().catch(() => {}); // fire-and-forget; SW may sleep before storage write completes

// Load manual language setting (async, t() falls back to browser locale until ready)
initI18n();
```

- [ ] **Step 3: 手动验证**

```javascript
// 1. 启用埋点（任意 chrome 上下文，比如 popup 或 options console）:
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });

// 2. 进入 chrome://extensions, 找到本扩展, 点击 "service worker" 链接打开 SW DevTools
// 3. 在 SW DevTools console 点击 "Stop" 按钮（如有），或等 30 秒让 SW 自然 idle
// 4. 在 popup 或扩展图标触发 SW 唤醒（例如点扩展图标打开 popup）
// 5. 在任意上下文 console:
const r = await chrome.storage.local.get("_perfSamples");
console.log(r._perfSamples.filter(s => s.ctx === "sw"));
```

- [ ] **Step 4: 验证输出**

Expected: 至少 1 条 `{name: "sw-wakeup", ctx: "sw", ms: 5-100}`。每次 SW 重新唤醒都会增加一条。

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "feat(perf): instrument service worker wakeup with T0/T1 marks"
```

---

## Task 5: 装到 content_script (pinboard.in)

**Files:**
- Modify: `manifest.json`
- Modify: `pinboard-style.js`

> **不修改 `pinboard-themes.js`** — handedit-audit lint 禁止该文件出现非 composer 产出行。T0 由 perf-mark.js 底部的 content_script 分支自动标记（Task 1 已包含）。

- [ ] **Step 1: 定义期望行为**

```
- T0: perf-mark.js 末尾在 content_script 上下文条件标记（已在 Task 1 内置）
- T1: pbp-injected style 元素 appendChild 完成那一行
- T2: pbp-cloak 移除那一行
- pbpFlush 在 T2 之后立即调用
- 期望 ctx 为 pinboard.in URL 路径末段（content_script 在页面上下文里跑）
```

- [ ] **Step 2: 修改 `manifest.json` content_scripts**

当前第 57-69 行：
```json
"content_scripts": [
  {
    "matches": [
      "https://pinboard.in/*",
      "https://*.pinboard.in/*"
    ],
    "js": [
      "pinboard-themes.js",
      "pinboard-style.js"
    ],
    "run_at": "document_start"
  }
],
```

改成（perf-mark.js 排首位）：
```json
"content_scripts": [
  {
    "matches": [
      "https://pinboard.in/*",
      "https://*.pinboard.in/*"
    ],
    "js": [
      "perf-mark.js",
      "pinboard-themes.js",
      "pinboard-style.js"
    ],
    "run_at": "document_start"
  }
],
```

- [ ] **Step 3: 修改 `pinboard-style.js`**

在文件末尾的 IIFE 内部，找到 `style.id = "pbp-injected"; style.textContent = combined; (document.head || document.documentElement).appendChild(style);` 这一段（约 105-110 行）。

在 `appendChild(style);` 之后**立即**插入：

```javascript
      pbpMark("ct-t1");
      pbpMeasure("ct-inject", "ct-t0", "ct-t1");
```

然后找到最后的 `uncloak();` 调用（最后一行 IIFE 之前），在 `uncloak();` 之后**立即**插入：

```javascript
  pbpMark("ct-t2");
  pbpMeasure("ct-uncloak", "ct-t0", "ct-t2");
  pbpFlush().catch(() => {});
```

- [ ] **Step 4: 手动验证**

```javascript
// 1. 任意上下文 console:
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });

// 2. 打开任意 pinboard.in/u:username 页面（hard reload: Ctrl+Shift+R）
// 3. 在该 pinboard.in 标签页 F12 console:
await chrome.storage.local.get("_perfSamples").then(r =>
  console.log(r._perfSamples.filter(s => s.name.startsWith("ct-")))
);
```

- [ ] **Step 5: 验证输出**

Expected: 2 条样本 — `ct-inject` 和 `ct-uncloak`，ctx 为 pinboard 页面 URL 末段。`ct-inject` ms 通常 50-300ms（含 588KB pinboard-themes.js parse 时间），`ct-uncloak` ms 略大于 `ct-inject`。

- [ ] **Step 6: Commit**

```bash
git add manifest.json pinboard-style.js
git commit -m "feat(perf): instrument pinboard.in content_script inject path with T1/T2 marks"
```

---

## Task 6: 装批量保存路径

**Files:**
- Modify: `popup-batch.js`

- [ ] **Step 1: 定义期望行为**

```
- batch-t0: 用户点 #batch-bookmark-btn 那一刻
- batch-first-write: 第一个 bookmark 写入成功（pinboard API 返回 done）
- batch-last-write: 最后一个 bookmark 完成（成功或失败）
- 之后 pbpFlush
- 期望 N tabs 的批量保存测得 batch-first-write 和 batch-last-write 各 1 条
```

- [ ] **Step 2: 找到 batch button 的 click handler**

打开 `popup-batch.js`，搜索 `batch-bookmark-btn`。找到 click handler 函数定义点。

- [ ] **Step 3: 在 click handler 开头插入 T0**

在 handler 的 async function 体的第一行插入：

```javascript
pbpMark("batch-t0");
```

- [ ] **Step 4: 在第一个 fetch 成功后插入 first-write**

找到处理单个 tab 保存的循环（通常是 `for (const tab of tabs)`），在第一次成功保存后插入：

```javascript
if (!_batchFirstWriteMarked) {
  pbpMark("batch-first-write");
  pbpMeasure("batch-first-write", "batch-t0", "batch-first-write");
  _batchFirstWriteMarked = true;
}
```

在 handler 之外（文件顶部 module scope）声明：

```javascript
let _batchFirstWriteMarked = false;
```

并在 handler 顶部重置：

```javascript
_batchFirstWriteMarked = false;
pbpMark("batch-t0");
```

- [ ] **Step 5: 在循环结束后插入 last-write**

在循环 `for...of` 结束之后插入：

```javascript
pbpMark("batch-last-write");
pbpMeasure("batch-last-write", "batch-t0", "batch-last-write");
pbpFlush().catch(() => {});
```

- [ ] **Step 6: 手动验证**

```javascript
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
// 在 popup 中点击 "📌 Batch Save" 处理 3-5 个标签
// 等待批量完成
const r = await chrome.storage.local.get("_perfSamples");
console.log(r._perfSamples.filter(s => s.name.startsWith("batch-")));
```

- [ ] **Step 7: 验证输出**

Expected: 2 条 — batch-first-write 和 batch-last-write。first-write ms ~3000-4000（首次 pinboardFetch + rate limit），last-write ms ≈ first-write + (N-1) × 3100。

- [ ] **Step 8: Commit**

```bash
git add popup-batch.js
git commit -m "feat(perf): instrument batch save path with T0/first-write/last-write marks"
```

---

## Task 7: 装 AI 端到端路径

**Files:**
- Modify: `popup-ai.js`

- [ ] **Step 1: 定义期望行为**

```
- ai-t0: 用户点 #ai-tags-btn 或 #ai-summary-btn 那一刻
- ai-result-rendered: AI 结果回填到 UI（tag 出现在 #ai-suggest-tags 或 summary 写入 #description-input）
- 之后 pbpFlush
- 区分两条路径 ai-tags-* 与 ai-summary-*
```

- [ ] **Step 2: 找到 AI tags / summary handler**

打开 `popup-ai.js`，搜索 `ai-tags-btn` 和 `ai-summary-btn`。

- [ ] **Step 3: AI tags handler 加 marks**

在 ai-tags-btn click handler 开头：

```javascript
pbpMark("ai-tags-t0");
```

在 AI 返回结果并 render 到 #ai-suggest-tags 之后：

```javascript
pbpMark("ai-tags-rendered");
pbpMeasure("ai-tags-e2e", "ai-tags-t0", "ai-tags-rendered");
pbpFlush().catch(() => {});
```

- [ ] **Step 4: AI summary handler 加 marks**

在 ai-summary-btn click handler 开头：

```javascript
pbpMark("ai-summary-t0");
```

在 summary 写入 `#description-input.value` 之后：

```javascript
pbpMark("ai-summary-rendered");
pbpMeasure("ai-summary-e2e", "ai-summary-t0", "ai-summary-rendered");
pbpFlush().catch(() => {});
```

- [ ] **Step 5: 手动验证**

```javascript
await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
// 在 popup 点击 🤖 generate (tags) 和 🤖 AI summary 各一次
const r = await chrome.storage.local.get("_perfSamples");
console.log(r._perfSamples.filter(s => s.name.startsWith("ai-")));
```

- [ ] **Step 6: 验证输出**

Expected: 各 1 条 `ai-tags-e2e` 和 `ai-summary-e2e`，ms 通常 1500-8000（含 LLM 调用网络）。

- [ ] **Step 7: Commit**

```bash
git add popup-ai.js
git commit -m "feat(perf): instrument AI tags/summary end-to-end paths"
```

---

## Task 8: 创建 `scripts/perf-sample.mjs`

**Files:**
- Create: `scripts/perf-sample.mjs`

- [ ] **Step 1: 定义期望行为**

```
- CLI: node scripts/perf-sample.mjs --port 9222 --out ./perf-baseline.json --runs 10
- 复用 .qa-scan/node_modules/playwright 的 connectOverCDP（同 screenshot-themes.mjs 模式）
- 不依赖项目其他文件
- 工作流：
  1. 连接已运行的 chrome-dbg
  2. 启用 _perfEnabled = true，清空 _perfSamples
  3. 测 popup cold-start N 次（每次 reload 扩展 + 等 5s + 打开 popup chrome-extension://<id>/popup.html）
  4. 测 popup warm-start 5 次（连续打开关闭）
  5. 测 options cold + warm（同上）
  6. 测 pinboard.in inject（重新加载已开的 pinboard 标签）
  7. dump _perfSamples → 计算 p50/p90/max/mean
  8. 写入指定 out 文件
- 不测 SW wakeup / batch / AI（这些需要登录态 + 网络，留手动跑）
- 跑完恢复 _perfEnabled = false
```

- [ ] **Step 2: 写代码**

```javascript
#!/usr/bin/env node
// perf-sample — drives an already-running Chrome via CDP to collect performance
// baseline samples for popup/options/content_script. Mirrors the connection
// pattern from docs/theme-surface/tools/screenshot-themes.mjs.
//
// PREREQUISITES
//   1. Chrome running with --remote-debugging-port=9222
//   2. Pinboard Bookmark Enhanced extension loaded (any version with perf-mark.js)
//   3. A pinboard.in tab open (for content_script measurement)
//   4. .qa-scan/ has playwright installed:  cd .qa-scan && npm install
//
// USAGE
//   node scripts/perf-sample.mjs
//   node scripts/perf-sample.mjs --port 9222 --out ./perf-baseline.json --runs 10
//   node scripts/perf-sample.mjs --only popup-cold,options-cold

import { createRequire } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const QA_SCAN = resolve(REPO, '.qa-scan');

let chromium;
try {
  const req = createRequire(resolve(QA_SCAN, 'package.json'));
  ({ chromium } = req('playwright'));
} catch {
  console.error('[perf-sample] playwright not found.');
  console.error('  Install:  cd .qa-scan && npm install');
  process.exit(2);
}

// ---- CLI ----
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const PORT = flag('--port', '9222');
const OUT = flag('--out', resolve(REPO, 'perf-baseline.json'));
const RUNS = parseInt(flag('--runs', '10'), 10);
const ONLY = flag('--only', null);
const WARM_RUNS = 5;

const SCENARIOS = ['popup-cold', 'popup-warm', 'options-cold', 'options-warm', 'pinboard-inject'];
const ACTIVE = ONLY
  ? SCENARIOS.filter(s => ONLY.split(',').includes(s))
  : SCENARIOS;

// ---- Connect ----
console.log(`[perf-sample] connecting to chrome :${PORT}`);
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
const ctx = browser.contexts()[0];

// Find extension ID
const swTargets = await browser.newBrowserCDPSession().then(s =>
  s.send('Target.getTargets')
).catch(() => ({ targetInfos: [] }));
const swInfo = swTargets.targetInfos?.find(t =>
  t.type === 'service_worker' &&
  t.url.includes('chrome-extension://') &&
  t.url.endsWith('/background.js')
);
if (!swInfo) {
  console.error('[perf-sample] could not find extension service worker. Is the extension loaded?');
  await browser.close();
  process.exit(2);
}
const EXT_ID = new URL(swInfo.url).hostname;
console.log(`[perf-sample] extension id: ${EXT_ID}`);

// Use an existing pinboard tab (or any tab) to talk to chrome.storage
const anyTab = ctx.pages().find(p => p.url().startsWith('http')) || ctx.pages()[0];
if (!anyTab) {
  console.error('[perf-sample] no open tabs available');
  await browser.close();
  process.exit(2);
}

// Helper: read/write chrome.storage.local from any extension context.
// We open the extension's popup.html in a fresh tab as a sandbox.
async function withSandbox(fn) {
  const sb = await ctx.newPage();
  await sb.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await sb.waitForLoadState('domcontentloaded');
  const result = await fn(sb);
  await sb.close();
  return result;
}

async function enablePerf() {
  await withSandbox(async (sb) => {
    await sb.evaluate(async () => {
      await chrome.storage.local.set({ _perfEnabled: true, _perfSamples: [] });
    });
  });
}

async function disablePerf() {
  await withSandbox(async (sb) => {
    await sb.evaluate(async () => {
      await chrome.storage.local.set({ _perfEnabled: false });
    });
  });
}

async function clearSamples() {
  await withSandbox(async (sb) => {
    await sb.evaluate(async () => {
      await chrome.storage.local.set({ _perfSamples: [] });
    });
  });
}

async function readSamples() {
  return withSandbox(async (sb) => {
    return sb.evaluate(async () => {
      const r = await chrome.storage.local.get({ _perfSamples: [] });
      return r._perfSamples;
    });
  });
}

async function reloadExtension() {
  await withSandbox(async (sb) => {
    await sb.evaluate(() => chrome.runtime.reload());
  });
  // Wait for SW to come back
  await new Promise(r => setTimeout(r, 3000));
}

// ---- Scenarios ----

async function runPopupOpen(times) {
  for (let i = 0; i < times; i++) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${EXT_ID}/popup.html`);
    await p.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    await p.evaluate(() => pbpFlush().catch(() => {})).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    await p.close();
    await new Promise(r => setTimeout(r, 200));
  }
}

async function runOptionsOpen(times) {
  for (let i = 0; i < times; i++) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${EXT_ID}/options.html`);
    await p.waitForLoadState('networkidle').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    await p.evaluate(() => pbpFlush().catch(() => {})).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    await p.close();
    await new Promise(r => setTimeout(r, 200));
  }
}

async function runPinboardInject(times) {
  const pb = ctx.pages().find(p => p.url().includes('pinboard.in'));
  if (!pb) {
    console.warn('[perf-sample] no pinboard.in tab open — skipping pinboard-inject');
    return;
  }
  for (let i = 0; i < times; i++) {
    await pb.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ---- Stats ----
function stats(samples) {
  const by = {};
  for (const s of samples) {
    if (!by[s.name]) by[s.name] = [];
    by[s.name].push(s.ms);
  }
  const out = {};
  for (const [name, arr] of Object.entries(by)) {
    arr.sort((a, b) => a - b);
    const p = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    out[name] = {
      n: arr.length,
      p50: Math.round(p(0.5) * 100) / 100,
      p90: Math.round(p(0.9) * 100) / 100,
      max: Math.round(arr[arr.length - 1] * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(sd * 100) / 100,
    };
  }
  return out;
}

// ---- Main ----
console.log(`[perf-sample] enabling perf collection`);
await enablePerf();

const results = {};

for (const scenario of ACTIVE) {
  console.log(`[perf-sample] scenario: ${scenario}`);
  await clearSamples();

  if (scenario === 'popup-cold') {
    for (let i = 0; i < RUNS; i++) {
      await reloadExtension();
      await runPopupOpen(1);
    }
  } else if (scenario === 'popup-warm') {
    await runPopupOpen(2); // prime
    await clearSamples();
    await runPopupOpen(WARM_RUNS);
  } else if (scenario === 'options-cold') {
    for (let i = 0; i < RUNS; i++) {
      await reloadExtension();
      await runOptionsOpen(1);
    }
  } else if (scenario === 'options-warm') {
    await runOptionsOpen(2);
    await clearSamples();
    await runOptionsOpen(WARM_RUNS);
  } else if (scenario === 'pinboard-inject') {
    await runPinboardInject(RUNS);
  }

  const samples = await readSamples();
  results[scenario] = stats(samples);
  console.log(`  ${Object.keys(results[scenario]).length} unique measures, ${samples.length} raw samples`);
}

console.log(`[perf-sample] disabling perf collection`);
await disablePerf();

const baseline = {
  generated: new Date().toISOString(),
  runs: RUNS,
  warmRuns: WARM_RUNS,
  results,
};
writeFileSync(OUT, JSON.stringify(baseline, null, 2));
console.log(`[perf-sample] wrote ${OUT}`);

await browser.close();
```

- [ ] **Step 3: 手动验证准备**

```bash
# 启动 chrome-dbg（如未运行）
# 在 chrome-dbg 中加载本扩展（chrome://extensions 开发者模式 → 加载已解压）
# 在 chrome-dbg 中打开一个 pinboard.in 页面（登录态）
```

- [ ] **Step 4: 跑一次冒烟（runs=2 快速验证）**

```bash
node scripts/perf-sample.mjs --runs 2 --out /tmp/perf-smoke.json
```

- [ ] **Step 5: 验证输出**

Expected: 终端打印每个 scenario 的进度，最终在 `/tmp/perf-smoke.json` 写入结构化结果，每个 scenario 包含 popup-fcp / popup-form-ready / popup-status-ready / options-fcp / options-first-panel-painted / options-settings-filled / ct-inject / ct-uncloak 等条目，每条带 p50/p90/max/mean/stddev/n。

- [ ] **Step 6: Commit**

```bash
git add scripts/perf-sample.mjs
git commit -m "feat(perf): add CDP-driven baseline sampling script"
```

---

## Task 9: 跑正式基线 + 提交 perf-baseline.json

**Files:**
- Create: `perf-baseline.json`

- [ ] **Step 1: 在干净环境跑**

```bash
# 关闭 chrome-dbg 中所有非必要标签，只留一个 pinboard.in 已登录 + 一个 about:blank
node scripts/perf-sample.mjs --runs 10 --out perf-baseline.json
```

- [ ] **Step 2: 检查结果合理性**

```bash
cat perf-baseline.json | head -80
```

Sanity checks:
- popup-cold.popup-fcp.p50 应该在 50-500ms 范围
- options-cold.options-fcp.p50 应该比 popup 大（因为 options-html 没 defer + 加载 588KB themes.js）
- pinboard-inject.ct-inject.p50 应该 100-500ms
- 各 measure 的 n 应 ≥ runs

如果某条 measure 的 n 是 0：说明对应 mark 没触发（可能 cold-start 时 reload 未完成 popup 就关闭了）。回到 Task 2-7 调试对应埋点。

- [ ] **Step 3: 决定是否 force-commit 基线数据**

`perf-baseline.json` 默认会被 gitignore（如果加进 .gitignore）。考虑两种策略：

(a) 提交到 git：未来回归对比直接 git diff（推荐）
(b) 不提交，只作为本地工作文件

如选 (a)，确认 perf-baseline.json 没有被 ignore：

```bash
git check-ignore -v perf-baseline.json
```

如果有输出（被 ignore），添加例外或选 (b)。如无输出（未被 ignore），继续 Step 4。

- [ ] **Step 4: Commit baseline data**

```bash
git add perf-baseline.json
git commit -m "test(perf): capture baseline before phase 1 optimizations"
```

- [ ] **Step 5: 写一份纯人类可读的摘要**

在 spec 的附录 A 位置追加一段表格摘要（手工编辑 `docs/superpowers/specs/2026-05-27-perf-audit-design.md` 附录 A）：

```markdown
## 附录 A：基线数据（2026-05-27 采样）

| 入口 | measure | p50 | p90 | max | n |
|------|---------|-----|-----|-----|---|
| popup-cold | popup-fcp | XX | XX | XX | 10 |
| popup-cold | popup-form-ready | XX | XX | XX | 10 |
| ... | ... | ... | ... | ... | ... |
```

数字从 `perf-baseline.json` 里抄。

- [ ] **Step 6: Commit 摘要**

```bash
git add -f docs/superpowers/specs/2026-05-27-perf-audit-design.md
git commit -m "docs(superpowers): append baseline data table to perf audit spec"
```

---

## Self-Review

### 1. Spec coverage check

| Spec 1.x 要求 | 覆盖任务 |
|------|---------|
| 1.1 perf-mark.js | Task 1 |
| 1.2 埋点位置（6 入口）| Task 2 (popup) / Task 3 (options) / Task 4 (SW) / Task 5 (content_script) / Task 6 (batch) / Task 7 (AI) |
| 1.3 采样脚本 | Task 8 |
| 1.4 跑测口径 | Task 9 Step 1 — **缺失**：CPU 4× throttle / 离线 / 标签数 30 / 不同账户规模这些维度本 plan 没自动化，需要手动跑 |
| 1.5 验收 | Task 9 |
| Spec 决策：pre-tag | Pre-flight Task 0 |

**发现的 gap**：spec 1.4 列了 4 个交叉维度（机器 / 网络 / 标签数 / 账户规模），本 plan 只跑了"开发机 / 在线 / 当前 chrome 状态 / 当前账户"一种组合。**修复方案**：在 Task 9 Step 1 之后追加 Step 1b/1c/1d 跑其余维度，或留作 Phase 0.5 follow-up（推荐后者，避免 Phase 0 拖太长）。

**决定**：本 plan 只覆盖"开发机基线"，其他维度作为 Phase 0 完成后的 follow-up task（在 Phase 1 plan 开头列出）。这样 Phase 0 可以快速 close 出，进入实际优化。

### 2. Placeholder scan

- "TBD / TODO / implement later"：无
- 模糊指令："Add error handling"：无；"handle edge cases"：无
- 缺代码的步骤：Task 2 Step 4 关于 `showMain` / `existing-banner` 插入点描述为"需读完函数找到合适位置"，未给精确行号——可接受（popup.js 已知 975 行，精确行号在写 plan 时不稳定且执行时易错；让执行者按 grep 关键字定位）

### 3. Type consistency

- pbpMark / pbpMeasure / pbpFlush 函数名全程一致 ✓
- chrome.storage.local key `_perfEnabled` / `_perfSamples` 全程一致 ✓
- mark name 规范：所有 mark name 都是 `<context>-<phase>` 形式（popup-t0 / sw-wakeup / ct-inject）✓
- measure name 与对应 mark name 一致 ✓

---

## Phase 0 完成的标志

- ✅ `perf-mark.js` 三端可用（popup/options/SW/content_script）
- ✅ `scripts/perf-sample.mjs` 一键跑通
- ✅ `perf-baseline.json` 落盘并 commit（或本地保留）
- ✅ spec 附录 A 填入基线数据表格
- ✅ tag `pre-perf-overhaul-v2.69` 已打
- ⏭️ Phase 1 plan 待写（应在 Phase 0 数据出来后决定 Phase 1 任务顺序与阈值）

## 总 Commit 数

11 个：tag 不计入 commit；Task 1-8 各 1 个；Task 9 拆 2 个（baseline + spec 附录）。

## Phase 1+ 衔接

Phase 0 跑完后，下一步是基于 `perf-baseline.json` 的数据撰写 Phase 1 plan（Group B：HTML/early script 5 项，低风险，先做）。Phase 1 plan 的每个任务验收阈值直接引用 `perf-baseline.json` 中的对应 p50 数字。
