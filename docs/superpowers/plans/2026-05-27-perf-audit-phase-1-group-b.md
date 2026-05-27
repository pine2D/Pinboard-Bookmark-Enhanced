# Performance Audit Phase 1 — HTML & Early Script Mirrors (Group B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 攻 `options-fcp ≈ 1330ms` 的最大瓶颈 — 通过 `defer` 释放 HTML 解析、删 body opacity 强等、用 localStorage mirror 同步预填 i18n / popup tab 数据 / options 高频字段，把 options 首次可视化时间砍到 < 800ms，popup 暖启动可视稳态压到 ≤ 70ms。

**Architecture:** 5 项基本独立的小改动。**B1**（options.html 加 defer）和 **B3**（i18n mirror）是基础；**B2**（删 body opacity 渐入）依赖 B3 才不会出现未翻译字符串闪烁；**B5**（options 设置值 mirror）扩展现有 `options-theme-early.js` 的 localStorage mirror 模式；**B4**（popup tab 数据 mirror）需要 SW 写 `chrome.storage.session._currentTab`、popup-theme-early 同步读 localStorage、popup.js 异步校对刷写。所有 mirror 不命中时回退到现有路径，不破坏任何已有功能。

**Tech Stack:** Vanilla JavaScript / HTML `<script defer>` / `chrome.storage.session` (MV3) / localStorage / `performance.mark` (复用 Phase 0 埋点)

**Spec reference:** `docs/superpowers/specs/2026-05-27-perf-audit-design.md` Section 3 Group B（B1–B5）

**Baseline reference:** `perf-baseline.json` (committed `9ef33dc`) + Appendix A in spec

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `options.html` | 修改 | 1. 给所有 9 个 `<script>` 加 `defer`；2. 删 line 8 `<style>body { opacity: 0; }</style>` |
| `options.js` | 修改 | 删 line 19-20（启动 fade-in），保留 line 400/494（语言切换 fade，是不同场景） |
| `i18n.js` | 重写 | `initI18n` 从 async 改 sync（localStorage mirror 同步应用 + 异步刷新） |
| `options-theme-early.js` | 扩展 | mirror 已有 theme/width，加 isLoggedIn / aiProvider / notify\* 字段；同步预填对应 DOM |
| `background.js` | 修改 | `chrome.tabs.onActivated` / `onUpdated` 写 `chrome.storage.session._currentTab` |
| `popup-theme-early.js` | 扩展 | 同步读 `localStorage.pp-last-tab` mirror，预填 url-input / title-input / existing-banner |
| `popup.js` | 修改 | 启动时异步读 `chrome.storage.session._currentTab` 校对，tab id/ts 不匹配时清空预填并显示骨架；showMain 末尾把当前 tab 数据写回 mirror |
| `perf-after-phase1.json` | 创建 | Phase 1 完成后用 `perf-sample.mjs` 重测的数据快照，用于 commit message 引用 |

---

## Pre-flight

### Task 0：创建 perf/phase-1 分支

**Files:** none

- [ ] **Step 1: 确认 main 是 Phase 0 合并后状态**

```bash
git log --oneline -1 main
```

Expected: `07eb398 docs(superpowers): append phase 0 baseline data and insights to design spec`

- [ ] **Step 2: 从 main 创建 phase-1 分支**

```bash
git checkout -b perf/phase-1 main
git branch --show-current
```

Expected output: `perf/phase-1`

- [ ] **Step 3: 确认起点 SHA 用于回滚**

```bash
git rev-parse HEAD
```

Note: This SHA = "rollback target if Phase 1 misfires". Same as main HEAD.

---

## Task 1: B1 — `options.html` 全部 script 加 `defer`

**Files:**
- Modify: `options.html` lines 563-571

**Spec mapping:** C1（高 ROI）— 预估 options-fcp p50 降 80-200ms

- [ ] **Step 1: 定义期望行为**

```
- 9 个 <script> 标签（包括 Phase 0 已加的 perf-mark.js）全部加 `defer` 属性
- defer 保留 DOM 顺序，但解析与 HTML 并行；DOMContentLoaded 之前所有 defer 脚本都执行完
- 不影响 perf-mark.js 在 options-theme-early.js 之前定义全局（defer 顺序保持）
- 不引入新 script，不调整顺序
```

- [ ] **Step 2: 修改 `options.html`**

当前（lines 563-571）：

```html
<script src="perf-mark.js"></script>
<script src="i18n.js"></script>
<script src="options-theme-early.js"></script>
<script src="shared.js"></script>
<script src="ai.js"></script>
<script src="pinboard-themes.js"></script>
<script src="options-api-tests.js"></script>
<script src="options-backup.js"></script>
<script src="options.js"></script>
```

改成（每个标签加 `defer`）：

```html
<script defer src="perf-mark.js"></script>
<script defer src="i18n.js"></script>
<script defer src="options-theme-early.js"></script>
<script defer src="shared.js"></script>
<script defer src="ai.js"></script>
<script defer src="pinboard-themes.js"></script>
<script defer src="options-api-tests.js"></script>
<script defer src="options-backup.js"></script>
<script defer src="options.js"></script>
```

- [ ] **Step 3: 验证 HTML 解析正确**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('options.html', 'utf8');
const matches = html.match(/<script[^>]*src=/g) || [];
const withDefer = html.match(/<script defer src=/g) || [];
console.log('Total script tags:', matches.length);
console.log('Tags with defer:', withDefer.length);
if (matches.length !== withDefer.length) {
  console.error('Mismatch — some scripts lack defer');
  process.exit(1);
}
console.log('All scripts have defer');
"
```

Expected: `Total script tags: 9 / Tags with defer: 9 / All scripts have defer`

- [ ] **Step 4: Commit**

```bash
git add options.html
git commit -m "perf(options): add defer to all script tags to unblock HTML parsing"
```

The pre-commit hook only fires on theme-surface / pinboard-themes.js — should pass silently. (Note: pinboard-themes.js is referenced in options.html but NOT staged here, so the drift-guard doesn't run.)

---

## Task 2: B3 — `i18n.js` 同步 mirror + 异步刷新

**Files:**
- Modify: `i18n.js` (rewrite `initI18n` + add helper)

**Spec mapping:** C5（中 ROI）— 预估 popup/options form-ready p50 降 20-50ms（消除 `await initI18n()` 阻塞）

- [ ] **Step 1: 定义期望行为**

```
- initI18n() 从 async 改成 sync（仍返回 undefined；callers' `await initI18n()` 表达式仍 work 因为 await 非 Promise 立即 resolve）
- 同步路径：读 localStorage.pp-i18n-lang / pp-i18n-msgs，populate _i18nMessages
- 异步路径：fire-and-forget 从 storage 读最新 optLang，按需 fetch _locales/<lang>/messages.json，更新 mirror，若内容变化则重新 applyI18n()
- "auto" mode 用户不需要 mirror messages（chrome.i18n.getMessage 本身同步）
- chrome.storage.onChanged 暂不监听（保持现状：用户改语言需要重开 popup/options，符合现有 UX）
```

- [ ] **Step 2: 完全重写 `i18n.js`（保留 `_resolveMsg` / `t` / `applyI18n` 不变）**

```javascript
// ============================================================
// Pinboard Bookmark Enhanced - i18n Helper
// ============================================================

let _i18nMessages = null;
let _i18nReady = false;

/**
 * Synchronously populate _i18nMessages from localStorage mirror (if user
 * set manual language). Auto-mode users hit chrome.i18n.getMessage which
 * is already synchronous, so no mirror is needed for them. Then kicks off
 * an async refresh that updates the mirror and re-applies translations if
 * data changed.
 *
 * Signature is callable as both sync (returns undefined) and via `await`
 * (await on non-Promise resolves immediately) — preserves call sites in
 * popup.js / options.js / background.js that do `await initI18n();`.
 */
function initI18n() {
  if (_i18nReady) {
    _refreshI18nAsync().catch(() => {});
    return;
  }
  // Sync mirror apply
  try {
    const lang = localStorage.getItem("pp-i18n-lang");
    if (lang && lang !== "auto") {
      const msgs = localStorage.getItem("pp-i18n-msgs");
      if (msgs) {
        try { _i18nMessages = JSON.parse(msgs); } catch (_) {}
      }
    }
  } catch (_) {}
  _i18nReady = true;
  // Async refresh (fire-and-forget)
  _refreshI18nAsync().catch(() => {});
}

/**
 * Async refresh: read latest optLang from storage, fetch locale messages
 * if needed, update localStorage mirror + _i18nMessages, re-apply
 * translations if anything changed.
 */
async function _refreshI18nAsync() {
  try {
    const _storage = typeof getSettingsStorage === "function"
      ? await getSettingsStorage()
      : chrome.storage.local;
    const { optLang = "auto" } = await _storage.get({ optLang: "auto" });

    const prevLang = (typeof localStorage !== "undefined" ? localStorage.getItem("pp-i18n-lang") : null) || "auto";

    if (optLang === "auto") {
      try {
        localStorage.setItem("pp-i18n-lang", "auto");
        localStorage.removeItem("pp-i18n-msgs");
      } catch (_) {}
      const changed = _i18nMessages !== null;
      if (changed) {
        _i18nMessages = null;
        if (typeof applyI18n === "function") applyI18n();
      }
      return;
    }

    // Manual language: fetch locale messages
    const url = chrome.runtime.getURL(`_locales/${optLang}/messages.json`);
    const resp = await fetch(url);
    if (!resp.ok) return;
    const msgs = await resp.json();

    try {
      localStorage.setItem("pp-i18n-lang", optLang);
      localStorage.setItem("pp-i18n-msgs", JSON.stringify(msgs));
    } catch (_) {
      // localStorage may be full or unavailable (e.g. SW context); proceed without mirror
    }

    const changed = prevLang !== optLang || _i18nMessages === null;
    _i18nMessages = msgs;
    if (changed && typeof applyI18n === "function") applyI18n();
  } catch (e) {
    console.warn("[i18n] async refresh failed:", e?.message || e);
  }
}

/**
 * Resolve a message entry's placeholders with provided arguments.
 */
function _resolveMsg(entry, args) {
  let msg = entry.message;
  if (!msg) return "";
  if (entry.placeholders && args.length) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const m = (def.content || "").match(/^\$(\d+)$/);
      if (m) {
        const idx = parseInt(m[1]) - 1;
        if (idx >= 0 && idx < args.length) {
          msg = msg.replace(new RegExp("\\$" + name + "\\$", "gi"), args[idx]);
        }
      }
    }
  }
  return msg;
}

/**
 * Shorthand for chrome.i18n.getMessage with placeholder support.
 * When a manual language is loaded (via mirror or async refresh), uses
 * that; otherwise falls back to chrome.i18n.getMessage (browser locale).
 * Usage: t("key") or t("key", "arg1", "arg2")
 */
function t(key, ...args) {
  if (_i18nMessages && _i18nMessages[key]) {
    return _resolveMsg(_i18nMessages[key], args) || key;
  }
  const msg = chrome.i18n.getMessage(key, args.length ? args : undefined);
  return msg || key;
}

/**
 * Apply translations to all elements with data-i18n attributes.
 * Supports:
 *   data-i18n="key"               → textContent
 *   data-i18n-placeholder="key"   → placeholder attribute
 *   data-i18n-title="key"         → title attribute
 *   data-i18n-aria="key"          → aria-label attribute
 *
 * Note: All translations are applied as plain text (textContent)
 * to prevent XSS. No innerHTML injection is used.
 */
function applyI18n(root) {
  root = root || document;

  // P1.5: Merged 4 separate querySelectorAll passes into 1 DOM walk.
  root.querySelectorAll("[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria]").forEach(el => {
    const k1 = el.getAttribute("data-i18n");
    if (k1) el.textContent = t(k1);
    const k2 = el.getAttribute("data-i18n-placeholder");
    if (k2) el.placeholder = t(k2);
    const k3 = el.getAttribute("data-i18n-title");
    if (k3) el.title = t(k3);
    const k4 = el.getAttribute("data-i18n-aria");
    if (k4) el.setAttribute("aria-label", t(k4));
  });
}
```

- [ ] **Step 3: 验证 SW 兼容性**

The function `initI18n()` is called from `background.js` line 8. In SW context, `typeof localStorage` is `"undefined"` — but the code uses `try { localStorage... }` wrappers, which throw → caught. The `_refreshI18nAsync` fallback at "localStorage may be full" comment handles SW context cleanly.

`node --check i18n.js` should pass.

- [ ] **Step 4: 验证 callers 不破**

```bash
grep -n "await initI18n\|initI18n()" popup.js options.js background.js
```

Expected: `popup.js:73: await initI18n();` / `options.js:14: await initI18n();` / `background.js:8: initI18n();` — all 3 still work (await on non-Promise resolves to undefined immediately).

- [ ] **Step 5: Commit**

```bash
git add i18n.js
git commit -m "perf(i18n): make initI18n sync via localStorage mirror, async refresh in background"
```

---

## Task 3: B2 — 删 `options.html` 的 `body { opacity: 0 }` + 启动 fade

**Files:**
- Modify: `options.html` line 8
- Modify: `options.js` lines 19-20

**Spec mapping:** C6（中 ROI）— 预估体感 TTI 提前 ~180ms（删掉 0.18s 强等）

**Depends on:** Task 2（i18n mirror 必须先就位，否则首次打开 options 会闪一下未翻译字符串）

- [ ] **Step 1: 定义期望行为**

```
- options.html line 8 的 <style>body { opacity: 0; }</style> 删除
- options.js DOMContentLoaded handler 内部 line 19-20 的 fade-in 设置删除（line 400/494 在语言切换路径里，保留）
- 删后 body 默认 opacity: 1，无 fade-in 动画
- 依赖 i18n mirror：首次打开（mirror 冷）走 chrome.i18n.getMessage 同步（auto 模式）或 mirror 命中（manual 模式）
```

- [ ] **Step 2: 修改 `options.html` line 8**

当前 line 8:
```html
  <style>body { opacity: 0; }</style>
```

删除整行（line 8 完全移除）。

- [ ] **Step 3: 修改 `options.js` 删除 lines 19-20 的 fade-in 设置**

当前（DOMContentLoaded handler 内，约 line 14-20）：

```javascript
document.addEventListener("DOMContentLoaded", async () => {
  await initI18n();
  applyI18n();
  pbpMark("options-first-panel-painted");
  pbpMeasure("options-first-panel-painted", "options-t0", "options-first-panel-painted");
  // Fade in after i18n applied (prevents flash of untranslated/unstyled content)
  document.body.style.transition = "opacity 0.18s";
  document.body.style.opacity = "1";
```

改成（删 fade-in 4 行 — 注释 + transition + opacity + 空行）：

```javascript
document.addEventListener("DOMContentLoaded", async () => {
  await initI18n();
  applyI18n();
  pbpMark("options-first-panel-painted");
  pbpMeasure("options-first-panel-painted", "options-t0", "options-first-panel-painted");
```

之后 `// ---- Tab switching ----` 直接跟在 pbpMeasure 后。

- [ ] **Step 4: 验证 line 400/494 的语言切换 fade 仍在**

```bash
grep -n "opacity" options.js
```

Expected: 只看到 line 400-401（左右）和 line 494-495（左右）的语言切换 fade，没有 line 19-20 的启动 fade。

- [ ] **Step 5: Commit**

```bash
git add options.html options.js
git commit -m "perf(options): remove body opacity:0 boot-fade; i18n mirror covers FOUC"
```

---

## Task 4: B5 — `options-theme-early.js` 高频字段 mirror 预填

**Files:**
- Modify: `options-theme-early.js`（扩展现有 theme/width mirror）
- Modify: `options.js`（mirror 写回点）

**Spec mapping:** P4（中 ROI）— 预估 options settings-filled 视觉跳变消除 80-200ms

- [ ] **Step 1: 定义期望行为**

```
- options-theme-early.js 同步读 localStorage.pp-options-fields，预填以下 DOM 字段（仅可见结构，不影响业务字段）:
  - body[data-logged-in="1|0"] = pinboardToken 是否存在（控制 panel 显示）
  - #opt-ai-provider 的 selected option = aiProvider（如 "gemini" / "openai" / ...）
  - #notify-quick-save / #notify-read-later / #notify-tab-set / #notify-batch-save / #notify-errors checkbox 的 checked 状态
- 不预填密钥字段（API key），仅可见 UI 结构字段
- mirror TTL 7 天；超期忽略 mirror，走 async 路径
- options.js 在 DOMContentLoaded 末尾把当前字段值写回 mirror
- 异步路径仍正常执行（即覆盖 mirror 命中的字段，确保数据准确）
```

- [ ] **Step 2: 扩展 `options-theme-early.js`**

当前内容（19 行）：

```javascript
pbpMark("options-t0");
// Apply theme early to prevent flash (MV3 requires external script, no inline)
// shared.js not yet loaded here — inline storage selector
chrome.storage.local.get({ optSyncEnabled: false }).then(({ optSyncEnabled }) => {
  return (optSyncEnabled ? chrome.storage.sync : chrome.storage.local)
    .get({ optTheme: "auto", themePresetKey: "" });
}).then(s => {
  const prefersDark = s.optTheme === "dark" ||
    (s.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (s.themePresetKey === "flexoki") {
    document.documentElement.dataset.theme = prefersDark ? "flexoki-dark" : "flexoki-light";
  } else if (s.themePresetKey) {
    document.documentElement.dataset.theme = s.themePresetKey;
  } else if (prefersDark) {
    document.documentElement.dataset.theme = "flexoki-dark";
  }
});
```

改成（在 pbpMark 之后、theme 异步之前，加 mirror prefill 块）：

```javascript
pbpMark("options-t0");

// ---- Mirror prefill: high-frequency UI fields ----
// Synchronously apply cached field values from localStorage so the form
// doesn't visibly jump from empty → populated. Async path below still
// fires and corrects via storage.get. Mirror TTL 7 days; stale data
// falls back to async path.
const _OPTIONS_MIRROR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
try {
  const raw = localStorage.getItem("pp-options-fields");
  if (raw) {
    const m = JSON.parse(raw);
    if (m && m.ts && (Date.now() - m.ts) < _OPTIONS_MIRROR_TTL_MS) {
      // Logged-in marker (controls panel visibility CSS)
      if (typeof m.loggedIn === "boolean") {
        document.documentElement.dataset.loggedIn = m.loggedIn ? "1" : "0";
      }
      // AI provider selected option (needs DOM to exist — deferred to DOMContentLoaded)
      document.addEventListener("DOMContentLoaded", () => {
        if (m.aiProvider) {
          const sel = document.getElementById("opt-ai-provider");
          if (sel && sel.value !== m.aiProvider) {
            const opt = sel.querySelector(`option[value="${m.aiProvider}"]`);
            if (opt) sel.value = m.aiProvider;
          }
        }
        if (m.notify && typeof m.notify === "object") {
          for (const [id, checked] of Object.entries(m.notify)) {
            const el = document.getElementById(id);
            if (el && el.type === "checkbox") el.checked = !!checked;
          }
        }
      }, { once: true });
    }
  }
} catch (_) {}

// Apply theme early to prevent flash (MV3 requires external script, no inline)
// shared.js not yet loaded here — inline storage selector
chrome.storage.local.get({ optSyncEnabled: false }).then(({ optSyncEnabled }) => {
  return (optSyncEnabled ? chrome.storage.sync : chrome.storage.local)
    .get({ optTheme: "auto", themePresetKey: "" });
}).then(s => {
  const prefersDark = s.optTheme === "dark" ||
    (s.optTheme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (s.themePresetKey === "flexoki") {
    document.documentElement.dataset.theme = prefersDark ? "flexoki-dark" : "flexoki-light";
  } else if (s.themePresetKey) {
    document.documentElement.dataset.theme = s.themePresetKey;
  } else if (prefersDark) {
    document.documentElement.dataset.theme = "flexoki-dark";
  }
});
```

- [ ] **Step 3: 修改 `options.js` 末尾写回 mirror**

定位 options.js 末尾的 DOMContentLoaded 闭合（line 1000 之前最后一行 settings-filled mark）。在 `pbpMeasure("options-settings-filled", ...)` 之后、`});` 之前，加 mirror 写回：

```javascript
  pbpMark("options-settings-filled");
  pbpMeasure("options-settings-filled", "options-t0", "options-settings-filled");

  // Write back mirror for next options open (B5 — Phase 1)
  try {
    const mirror = {
      ts: Date.now(),
      loggedIn: !!(s.pinboardToken),
      aiProvider: s.aiProvider || "gemini",
      notify: {
        "notify-quick-save": s.notifyQuickSave !== false,
        "notify-read-later": s.notifyReadLater !== false,
        "notify-tab-set": s.notifyTabSet !== false,
        "notify-batch-save": s.notifyBatchSave !== false,
        "notify-errors": s.notifyErrors !== false,
      }
    };
    localStorage.setItem("pp-options-fields", JSON.stringify(mirror));
  } catch (_) {}
});
```

> **注意**：`s` 是 DOMContentLoaded handler 内部的 settings 对象（line ~127 `const s = await (await getSettingsStorage()).get(SETTINGS_DEFAULTS);`）。如果 `s` 在该 handler 末尾不可见（因为变量作用域），需要把这块代码放到 `s` 可见的位置。

如 `s` 变量名不同（例如 `settings`），相应替换。如果 settings 已被 deobfuscate，`s.pinboardToken` 是明文 token；mirror 只存 `loggedIn` boolean 而非 token 本身——这是设计要求（绝不写明文 key 到 localStorage）。

- [ ] **Step 4: 验证 mirror 不含敏感字段**

```bash
grep -n "ApiKey\|pinboardToken" options-theme-early.js options.js | head -20
```

In options-theme-early.js: no `ApiKey`, no `pinboardToken` (only `loggedIn` boolean).
In options.js: existing `pinboardToken` references are NOT in the new mirror-write block. The new block only stores boolean / aiProvider / notify flags.

- [ ] **Step 5: Commit**

```bash
git add options-theme-early.js options.js
git commit -m "perf(options): mirror high-frequency UI fields in localStorage for sync prefill"
```

---

## Task 5: B4 — popup tab data mirror（SW + popup-theme-early + popup）

**Files:**
- Modify: `background.js`（tab change → session storage write）
- Modify: `popup-theme-early.js`（同步预填 url-input / title-input / existing-banner）
- Modify: `popup.js`（启动校对 + 末尾写回 localStorage mirror）

**Spec mapping:** P1 + P2（高 ROI）— 预估去除 50-150ms（P1）+ 100-300ms（P2）的视觉延迟

- [ ] **Step 1: 定义期望行为**

```
- SW 在 chrome.tabs.onActivated 和 onUpdated(status:complete) 写 chrome.storage.session._currentTab
  schema: { tabId: number, url: string, title: string, posts: array|null, ts: number }
  posts: 来自 SW 内部 statusCache (5min TTL)，可能为 null（未查询过）
- popup-theme-early.js 同步读 localStorage.pp-last-tab，预填 #url-input / #title-input / #existing-banner
  仅在 mirror 存在且 ts < 10min 内时使用
- popup.js 启动后异步读 chrome.storage.session._currentTab，与当前 active tab 校对（chrome.tabs.query）：
  - 若 session._currentTab.tabId === active tab.id 且 ts < 60s：使用 session 数据，覆盖 localStorage mirror
  - 若不匹配：清除 input 的预填值（避免显示错误 URL），走原有 chrome.tabs.query 异步路径
- popup.js 在 showMain 末尾把当前 tab 写回 localStorage.pp-last-tab
- mirror 不含 posts.tags 全文（只存 .url, .title, posts[0].tags 给 existing-banner 用，简化 schema）
```

- [ ] **Step 2: 修改 `background.js` 写 session storage**

在 background.js 找到 `chrome.tabs.onActivated` listener（约 line 395-404）和 `chrome.tabs.onUpdated` listener（约 line 406-412）。在每个 listener 内部的 `_scheduleTabCheck` 调用之后、相同 setTimeout 块外部，加一个并行写 session storage 的辅助函数调用。

新增辅助函数（放在两个 listener 之前，约 line 390 附近）：

```javascript
// B4: write current tab data to session storage for popup mirror prefill
async function _writeCurrentTabMirror(tabId, url, title) {
  if (!url || !url.startsWith("http")) {
    try { await chrome.storage.session.remove("_currentTab"); } catch (_) {}
    return;
  }
  const cached = statusCache.get(url);
  const posts = (cached && Date.now() - cached.timestamp < CACHE_TTL) ? (cached.posts || null) : null;
  try {
    await chrome.storage.session.set({
      _currentTab: { tabId, url, title: title || "", posts, ts: Date.now() }
    });
  } catch (_) {}
}
```

修改 onActivated listener。当前：

```javascript
chrome.tabs.onActivated.addListener(({ tabId }) => {
  _scheduleTabCheck(tabId, async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === tabId && tab.url) await debouncedCheck(tabId, tab.url);
    } catch (_) {
      // Tab closed/replaced between event and query — expected race, skip
    }
  }, 150);
});
```

改成（同一 query 一次性触发 debouncedCheck + mirror write）：

```javascript
chrome.tabs.onActivated.addListener(({ tabId }) => {
  _scheduleTabCheck(tabId, async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === tabId && tab.url) {
        await debouncedCheck(tabId, tab.url);
        await _writeCurrentTabMirror(tabId, tab.url, tab.title);
      }
    } catch (_) {
      // Tab closed/replaced between event and query — expected race, skip
    }
  }, 150);
});
```

修改 onUpdated listener 类似：

```javascript
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("http")) {
    _scheduleTabCheck(tabId, () => {
      debouncedCheck(tabId, tab.url).catch(() => {});
      _writeCurrentTabMirror(tabId, tab.url, tab.title).catch(() => {});
    }, 150);
  }
});
```

> **注意：** `chrome.storage.session` 需要 manifest 的 `"storage"` permission（已有），无需新权限。Session storage 自 Chrome 102 起可用，扩展加载后才存活，浏览器重启清空 — 正符合我们对 "current tab" 短期缓存的语义。

- [ ] **Step 3: 修改 `popup-theme-early.js` 同步预填**

在 popup-theme-early.js 当前的 `applyFromLocalStorageMirror` IIFE 内（约 line 11-36），在 IIFE 末尾（`)();` 之前）加 tab data 预填：

```javascript
  // B4: tab data prefill — populate url-input / title-input / existing-banner
  //     synchronously from the last-known tab. popup.js will validate against
  //     chrome.storage.session asynchronously and clear stale prefill if mismatched.
  const _TAB_MIRROR_TTL_MS = 10 * 60 * 1000;
  try {
    const raw = localStorage.getItem("pp-last-tab");
    if (raw) {
      const m = JSON.parse(raw);
      if (m && m.ts && (Date.now() - m.ts) < _TAB_MIRROR_TTL_MS && m.url) {
        document.addEventListener("DOMContentLoaded", () => {
          const u = document.getElementById("url-input");
          const ti = document.getElementById("title-input");
          if (u && !u.value) u.value = m.url;
          if (ti && !ti.value) ti.value = m.title || "";
          if (m.tags) {
            const banner = document.getElementById("existing-banner");
            if (banner) {
              const tagCount = m.tags.split(/\s+/).filter(Boolean).length;
              banner.textContent = (m.bannerText || "Bookmarked") +
                (tagCount > 0 ? ` (${tagCount} tag${tagCount === 1 ? "" : "s"})` : "");
              banner.classList.remove("hidden");
              // Mark with mirror flag so popup.js knows to validate/replace
              banner.dataset.mirror = "1";
            }
          }
        }, { once: true });
      }
    }
  } catch (_) {}
```

- [ ] **Step 4: 修改 `popup.js` 启动校对 + 末尾写回**

`popup.js` 启动后异步校对：在 DOMContentLoaded handler 内部（line 73 `await initI18n()` 之后），加 session 校对块：

```javascript
  // B4: validate tab-data mirror against chrome.storage.session._currentTab
  // (set by SW on tab change). If mismatched (tabId or ts > 60s), clear prefill.
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { _currentTab } = await chrome.storage.session.get("_currentTab");
    const mirrorFresh = _currentTab && _currentTab.ts && (Date.now() - _currentTab.ts < 60000);
    if (!mirrorFresh || !activeTab || _currentTab?.tabId !== activeTab.id) {
      // Mismatch: clear prefill to avoid showing stale URL
      const u = document.getElementById("url-input");
      const ti = document.getElementById("title-input");
      const banner = document.getElementById("existing-banner");
      if (u && !document.activeElement?.isSameNode(u)) u.value = "";
      if (ti && !document.activeElement?.isSameNode(ti)) ti.value = "";
      if (banner && banner.dataset.mirror === "1") {
        banner.classList.add("hidden");
        delete banner.dataset.mirror;
      }
    }
  } catch (_) {}
```

写回 mirror：在 popup.js 的 `showMain` 末尾（在 `pbpMark("popup-status-ready")` 之前），加：

```javascript
  // B4: write tab mirror for next popup boot
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url) {
      const mirror = {
        tabId: activeTab.id,
        url: $id("url-input").value || activeTab.url,
        title: $id("title-input").value || activeTab.title || "",
        tags: existingBookmark?.tags || "",
        bannerText: $id("existing-banner")?.textContent || "",
        ts: Date.now()
      };
      localStorage.setItem("pp-last-tab", JSON.stringify(mirror));
    }
  } catch (_) {}
```

- [ ] **Step 5: 验证 manifest permission**

```bash
grep -n "storage\|session" manifest.json | head -5
```

Expected: `"storage"` already in permissions list. No new permission needed.

- [ ] **Step 6: Commit**

```bash
git add background.js popup-theme-early.js popup.js
git commit -m "perf(popup): mirror tab data via SW session + localStorage for sync prefill"
```

---

## Task 6: Validate — 重测 baseline 并对比

**Files:**
- Create: `perf-after-phase1.json`
- Modify: `docs/superpowers/specs/2026-05-27-perf-audit-design.md`（追加 Phase 1 对比块到附录 A）

- [ ] **Step 1: 在 chrome-dbg 重新加载扩展**

In chrome-dbg, `chrome://extensions/` → Pinboard-Bookmark-Enhanced → "Reload" button. This picks up all Phase 1 changes.

如 SW idle，点扩展工具栏图标唤醒。

- [ ] **Step 2: 跑 warm + pinboard scenarios**

```bash
node scripts/perf-sample.mjs \
  --ext-id aghcegglioapkbgjmbgkmkiiijccoiln \
  --only popup-warm,options-warm,pinboard-inject \
  --runs 10 \
  --out perf-after-phase1.json
```

> 用 Phase 0 已发现的 EXT_ID。如果 ID 变了（chrome 重启 / 重装扩展），先 `curl -s http://localhost:9222/json | grep aghc` 获取新 ID。

Expected runtime: ~3 min.

- [ ] **Step 3: 对比关键指标**

```bash
python3 -c "
import json
b = json.load(open('perf-baseline.json'))['results']
a = json.load(open('perf-after-phase1.json'))['results']
print(f'{\"scenario\":<20} {\"measure\":<35} {\"baseline p50\":<14} {\"after p50\":<13} {\"delta\":<10}')
print('-' * 95)
for scn in sorted(set(b) | set(a)):
    keys = sorted(set(b.get(scn, {})) | set(a.get(scn, {})))
    for k in keys:
        bp = b.get(scn, {}).get(k, {}).get('p50', None)
        ap = a.get(scn, {}).get(k, {}).get('p50', None)
        delta = None if (bp is None or ap is None) else round(ap - bp, 1)
        bs = f'{bp:.1f}' if bp is not None else '—'
        as_ = f'{ap:.1f}' if ap is not None else '—'
        ds = f'{delta:+.1f} ms' if delta is not None else '—'
        print(f'{scn:<20} {k:<35} {bs:<14} {as_:<13} {ds:<10}')
"
```

Expected pattern (Phase 1 success):
- `options-fcp` p50 should drop substantially (≥ 30% from 1330ms — target < 800ms)
- `options-first-panel-painted` p50 should also drop (i18n mirror cuts the await)
- `popup-form-ready` p50 may show small improvement (i18n mirror)
- `pinboard-inject` should be unchanged (Group B doesn't touch pinboard)

- [ ] **Step 4: 验收门槛**

Per spec Section 4.1:
- **C1 阈值**: `options-fcp p50 < baseline × 0.7` → < 931ms
- **C5/C6 阈值**: `popup/options form-ready p50 < baseline × 0.9` 且无视觉跳变
- **P1/P2 验收**: 首屏 url/title/banner ≤ FCP（视频对比）

Per spec Section 4.2: 任一改动 p50/p90 退化 > 5% → 不合并。

如有指标退化或目标未达，回退该 task 的 commit（`git revert <sha>`）并 escalate。

- [ ] **Step 5: 把 after 数据追加到 spec 附录 A**

在 `docs/superpowers/specs/2026-05-27-perf-audit-design.md` 附录 A.2 末尾追加新一节：

```markdown
### A.6 Phase 1 完成后基线（2026-XX-XX）

| 入口 | measure | baseline p50 | after p50 | Δ | 阈值 | 通过 |
|------|---------|-------------|-----------|-----|------|------|
| options-warm | options-fcp | 1330.1 | <填入> | <填入> | < 931 (×0.7) | <✓/✗> |
| options-warm | options-first-panel-painted | 61.1 | <填入> | <填入> | < 55 (×0.9) | <✓/✗> |
| options-warm | options-settings-filled | 92.3 | <填入> | <填入> | < 83 (×0.9) | <✓/✗> |
| popup-warm | popup-form-ready | 62.8 | <填入> | <填入> | < 57 (×0.9) | <✓/✗> |
| popup-warm | popup-fcp | 453.7 | <填入> | <填入> | < 408 (×0.9) | <✓/✗> |
| pinboard-inject | ct-inject | 26.5 | <填入> | <填入> | 无退化 | <✓/✗> |
| pinboard-inject | ct-uncloak | 26.8 | <填入> | <填入> | 无退化 | <✓/✗> |

体感验收（手测）：
- options 打开后**不再有 180ms 白屏**渐入
- popup 打开后 url-input / title-input **不再先空再跳**
- existing-banner 状态在 FCP 时就稳定
```

填入实际数字（替换 `<填入>` / `<✓/✗>`）。

- [ ] **Step 6: Commit baseline-after 数据 + spec 附录**

```bash
git add perf-after-phase1.json
git add -f docs/superpowers/specs/2026-05-27-perf-audit-design.md
git commit -m "test(perf): capture phase 1 after-baseline and validate thresholds"
```

---

## Self-Review

### 1. Spec coverage check

| Spec 改动 | 覆盖任务 |
|---|---|
| B1 (C1): options.html defer | Task 1 |
| B2 (C6): 去 options body opacity:0 | Task 3 |
| B3 (C5): i18n.js mirror | Task 2 |
| B4 (P1+P2): popup mirror tab data | Task 5 |
| B5 (P4): options mirror 高频字段 | Task 4 |
| Section 4 验收门槛 | Task 6 |
| Section 5 风险与回滚 | 每个 task 的 commit 都可独立 revert |

无 gap。

### 2. Placeholder scan

- 无 "TBD" / "TODO" / "implement later"
- 无 "add appropriate error handling"
- 每个 step 含完整代码或精确命令
- Task 6 Step 5 用 `<填入>` 占位符是**输出格式说明**（要等真实数据落地），不是实现占位

### 3. Type consistency

- `pbpMark` / `pbpMeasure` / `pbpFlush` 命名跨任务一致
- `localStorage` key 命名：`pp-i18n-lang` / `pp-i18n-msgs` / `pp-last-tab` / `pp-options-fields` — 都用 `pp-` 前缀，跟现有 mirror（`pp-logged-in` / `pp-theme` / `pp-popup-width`）一致
- `chrome.storage.session._currentTab` schema 在 SW 和 popup 两端用同样字段
- mirror TTL 常量在各文件独立但语义一致（`_OPTIONS_MIRROR_TTL_MS`、`_TAB_MIRROR_TTL_MS`）

### 4. 实施顺序依赖

Task 1 (B1) — 独立
Task 2 (B3) — 独立
Task 3 (B2) — **依赖 Task 2 落地后**（mirror 防 i18n 闪烁）
Task 4 (B5) — 独立
Task 5 (B4) — 独立
Task 6 — 依赖 1-5 全部落地

执行顺序必须是 1 → 2 → 3 → 4 → 5 → 6（或并行 1+2+4+5 然后 3，最后 6）。建议按顺序，避免分支同步问题。

---

## Phase 1 完成的标志

- ✅ 6 个 task 全部 commit（5 个 feat/perf + 1 个 test）
- ✅ Task 6 验收门槛全部通过（或个别未达项已 escalate）
- ✅ perf-after-phase1.json + spec 附录 A.6 已合并
- ⏭️ Phase 2 plan 待写（基于 A.6 数据决定下一步取舍）

## 总 Commit 数

6 个：每个 task 一个 commit。

## Phase 2+ 衔接

Phase 1 完成后下一步是 Phase 2 — Group C（popup/options 运行时优化，W1/W3/P3/R5 共 4 项）。Phase 2 plan 撰写时引用 perf-after-phase1.json 作为新基线。
