# Performance Audit Phase 3 — manifest + 文件结构 (Group A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 攻 options-fcp 残余的 354ms 大头（588KB pinboard-themes.js sync parse）+ 释放 pinboard.in 每 tab 540KB 常驻内存 + 让 SW 唤醒不再付 ai.js parse 成本。

**Architecture:** 3 项独立但级联的改动。**A2**（options 懒加载 pinboard-themes）最小风险最大回报；**A1**（拆主题表 + thin loader）涉及 theme factory 工具链更新；**A3**（SW module worker + ai.js dynamic import）需要改 manifest 和 SW 入口，重启风险最高。建议**严格按顺序**：先 A2 验证收益、再考虑 A1 是否值得（看 A2 后 options-fcp 是否已可接受）、最后 A3（带明确回滚路径）。

**Tech Stack:** Vanilla JS / Chrome MV3 manifest / `chrome.scripting.executeScript` / dynamic `<script>` injection / ES modules / `web_accessible_resources`

**Spec reference:** `docs/superpowers/specs/2026-05-27-perf-audit-design.md` Section 3 Group A（A1/A2/A3 共 3 项）

**Baseline reference:** Phase 2 完成后基线 `perf-after-phase2.json`（commit `0a9d134`）

---

## 重要前置判断（基于 Phase 1/2 数据）

| 项 | spec 原 ROI | 现实预估 | 风险 | 建议 |
|----|------------|---------|------|------|
| **A2** (C2 options 懒加载 themes) | 高 | 高（再砍 100-200ms options-fcp） | 低 | **必做** |
| **A1** (C3 拆主题表) | 高 → 低/中（已下调） | 低（5-15ms parse + 540KB/tab 内存）| 中（theme factory 链路改动） | **看 A2 后再定** |
| **A3** (C4 SW module worker) | 中 | 不可测（SW wakeup baseline 缺失） | 高（manifest 改 + 全链路 shared.js/i18n.js 转 module） | **谨慎；可选用 feature flag 回退路径** |

**A1 决策点（plan Task 2 Step 1）**：A2 跑完后看 `options-fcp` 是否已 < 250ms。若是，A1 收益太小可跳过；若否，A1 还有空间。

**A3 决策点（plan Task 3 Step 1）**：在 Phase 3 内做 SW wakeup 单独采样（用 chrome://serviceworker-internals/ 手动停 SW + 触发任意 chrome.action 操作，读 storage._perfSamples 里的 sw-wakeup 条目）。若 baseline > 50ms，做 A3 有意义；否则 A3 收益不可见。

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `options.html` | 修改 | 删 `<script defer src="pinboard-themes.js">` |
| `options.js` | 修改 | 添加 `_loadPinboardThemes()` lazy loader（首次 `_initAppearancePanel` 时调用） |
| `pinboard-themes.js` | 保留（A1 才删） | 仍是 theme factory 输出，content_script + options 都从此读取 |
| `manifest.json` | 修改 | A1 时改 content_scripts（删 pinboard-themes.js）；A3 时加 `"type": "module"` |
| `pinboard-style.js` | 修改 | A1 时改 thin loader（fetch + inject 单主题）；A3 不动 |
| `background.js` | 修改 | A3 时 importScripts → import；ai.js 调用点 dynamic import |
| `i18n.js` / `shared.js` | 修改 | A3 时加 `export`（保留全局兼容） |
| `themes/<13 keys>.js` | 创建（A1） | 每主题独立文件 |
| `themes/index.json` | 创建（A1） | 主题元数据 manifest |
| `docs/theme-surface/tools/sync-all.mjs` | 修改（A1） | 同时产出 pinboard-themes.js + themes/*.js |
| `perf-after-phase3.json` | 创建 | Phase 3 完成后采样 |

---

## Pre-flight

### Task 0: 创建 perf/phase-3 分支

**Files:** none

- [ ] **Step 1: 确认 main 是 Phase 2 已合并状态**

```bash
git log --oneline -1 main
```

Expected: `0a9d134 test(perf): capture phase 2 after-baseline...`

- [ ] **Step 2: 创建分支**

```bash
git checkout -b perf/phase-3 main
git branch --show-current
```

Expected: `perf/phase-3`

---

## Task 1: A2 — options 懒加载 `pinboard-themes.js`

**Files:**
- Modify: `options.html` (line ~568, 删 pinboard-themes.js script tag)
- Modify: `options.js` (Phase 2 `_initAppearancePanel` 内部 + lazy loader 函数)

**Spec mapping:** C2（高 ROI）— 预估 options-fcp p50 再降 100-200ms（删 588KB sync parse）

- [ ] **Step 1: 定义期望行为**

```
- options.html 不再 sync 加载 pinboard-themes.js（删除该 script tag）
- options.js 在 _initAppearancePanel 首次调用时，动态注入 pinboard-themes.js 到 page，等待其执行完成（PINBOARD_THEMES 全局可用）
- 注入方式：document.createElement("script") + onload promise（动态 <script>，因为 pinboard-themes.js 不是 ES module）
- 首次 appearance 切换会卡顿 ~50-150ms（pinboard-themes.js parse），可接受（显式用户操作触发，且只发生一次）
- Phase 2 _initAppearancePanel 的 pending-init queue 仍然工作（保证 currentPresetKey 已就绪后才渲染）
```

- [ ] **Step 2: 修改 `options.html`**

定位第 568 行（或附近）的：

```html
<script defer src="pinboard-themes.js"></script>
```

**删除整行**。8 script 标签变 7 个。

- [ ] **Step 3: 修改 `options.js` 加 lazy loader**

在 `options.js` 顶部 module scope（W3 flags 附近）加入 lazy load helper：

```javascript
let _pinboardThemesPromise = null;
function _loadPinboardThemes() {
  if (_pinboardThemesPromise) return _pinboardThemesPromise;
  _pinboardThemesPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "pinboard-themes.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load pinboard-themes.js"));
    document.head.appendChild(s);
  });
  return _pinboardThemesPromise;
}
```

- [ ] **Step 4: 修改 `_initAppearancePanel` 用 lazy loader**

Phase 2 commit `aca1c1a` 的 `_initAppearancePanel` 当前：

```javascript
function _initAppearancePanel() {
  if (_appearanceInited) return;
  if (!_appearancePanelBootReady) { _appearancePendingInit = true; return; }
  _appearanceInited = true;
  renderPresetPreview();
}
```

改成（先 await lazy load，再渲染）：

```javascript
async function _initAppearancePanel() {
  if (_appearanceInited) return;
  if (!_appearancePanelBootReady) { _appearancePendingInit = true; return; }
  _appearanceInited = true;
  try {
    await _loadPinboardThemes();
  } catch (e) {
    console.warn("[options] pinboard-themes lazy load failed:", e.message);
    _appearanceInited = false; // allow retry on next switch
    return;
  }
  renderPresetPreview();
}
```

注意：函数从 sync 变 async。Caller 不需要 await（调用方 `if (...) _initAppearancePanel();` 模式仍 work，函数返回的 Promise 被 ignored 是 OK 的）。

- [ ] **Step 5: 验证其他 PINBOARD_THEMES 使用点**

```bash
grep -n "PINBOARD_THEMES\|pinboard-themes" options.js
```

可能有其他地方引用 `PINBOARD_THEMES`（比如 `applyPreset` 或 `renderPresetPreview` 内部）。这些只在 appearance panel 激活后才会被调用，此时 `_loadPinboardThemes` 已经 resolve，PINBOARD_THEMES 全局可用。如果有 caller 在 appearance panel 激活前用 PINBOARD_THEMES，会 ReferenceError —— STOP 报告 BLOCKED。

预期场景：所有 `PINBOARD_THEMES` 引用要么在 `_initAppearancePanel` 之后的 render path 内，要么在用户主动点击主题按钮（`applyPreset` 之类）之后。如果都满足，proceed。

- [ ] **Step 6: 验证语法 + 引用清理**

```bash
node --check options.js
grep -n "pinboard-themes" options.html
```

Expected: node check pass; options.html 0 hits（pinboard-themes.js script 已删）。

- [ ] **Step 7: Commit**

```bash
git add options.html options.js
git commit -m "perf(options): lazy-load pinboard-themes.js when appearance panel first viewed"
```

---

## Task 2: A1 — 拆 `pinboard-themes.js` + manifest thin loader

> **决策点**：Task 1 完成后跑一次 `perf-sample.mjs --only options-warm,pinboard-inject` 看 options-fcp 是否已 < 250ms 且 ct-inject 是否 < 20ms。若两者都达到，A1 收益太小，**跳过本 task** 直接进 Task 3。把决策记录到 spec 附录。

**Files:**
- Create: `themes/<13 主题>.js`（13 个新文件，由 sync-all 生成）
- Create: `themes/index.json`（主题元数据 manifest）
- Modify: `docs/theme-surface/tools/sync-all.mjs`（同时输出 pinboard-themes.js + themes/*.js + index.json）
- Modify: `manifest.json`（content_scripts 删 pinboard-themes.js + 加 web_accessible_resources）
- Modify: `pinboard-style.js`（fetch + inject 单主题）
- Modify: `options.js`（_loadPinboardThemes 改成加载 index.json + 单主题文件 OR 保持 monolithic load）
- 保留：`pinboard-themes.js`（暂时仍由 sync-all 生成，作为单一回退；下个版本如不需要再删）

**Spec mapping:** C3（已下调到中/低 ROI）— 预估 ct-inject p50 再降 5-15ms + 单 pinboard tab 内存 540KB → ~40KB

**复杂度警告**：本 task 改动面大（涉及 theme factory 工具链 + 5 道 pre-commit lint）。实施前必读 `docs/theme-surface/NEW_THEME.md`。如理解不清 STOP 报告 BLOCKED。

- [ ] **Step 1: 决策点 — 跑数据**

```bash
node scripts/perf-sample.mjs --ext-id aghcegglioapkbgjmbgkmkiiijccoiln \
  --only options-warm,pinboard-inject --runs 10 --out /tmp/perf-after-task1.json
python3 -c "
import json
d = json.load(open('/tmp/perf-after-task1.json'))['results']
print('options-fcp:', d['options-warm'].get('options-fcp', {}).get('p50'))
print('ct-inject:', d['pinboard-inject'].get('ct-inject', {}).get('p50'))
"
```

If `options-fcp < 250` AND `ct-inject < 20`: **SKIP Task 2**，跳到 Task 3。在 spec 附录 A.8 记 "A1 skipped — A2 alone achieved target"。

If either still > threshold: proceed.

- [ ] **Step 2: 读 theme factory 现有产出**

```bash
sed -n '1,30p' docs/theme-surface/tools/sync-all.mjs
ls docs/theme-surface/pilots/*.tokens.json | head
```

理解：
- pilots/*.tokens.json 是输入
- sync-all.mjs 渲染 → 写 pinboard-themes.js
- handedit-audit lint 防止手动改 pinboard-themes.js

- [ ] **Step 3: 修改 sync-all.mjs 输出 per-theme + index**

在 sync-all.mjs 中找到当前写 pinboard-themes.js 的代码块。在该写入之后追加：

```javascript
// A1 Phase 3: also write per-theme files for runtime lazy load
const themesDir = resolve(REPO, "themes");
mkdirSync(themesDir, { recursive: true });
const indexEntries = {};
for (const [key, data] of Object.entries(PINBOARD_THEMES_OUT)) {
  const themeContent = `// Auto-generated by sync-all.mjs — DO NOT EDIT.
// Source: docs/theme-surface/pilots/${key}.tokens.json
window.__pbpTheme = window.__pbpTheme || {};
window.__pbpTheme[${JSON.stringify(key)}] = ${JSON.stringify(data)};
`;
  writeFileSync(resolve(themesDir, `${key}.js`), themeContent);
  indexEntries[key] = { name: data.name, desc: data.desc };
}
writeFileSync(resolve(themesDir, "index.json"), JSON.stringify(indexEntries, null, 2));
```

> 替换 `PINBOARD_THEMES_OUT` 为 sync-all.mjs 中实际持有完整 PINBOARD_THEMES 对象的变量名（实施时先 grep）。

- [ ] **Step 4: 跑 sync-all 生成产物**

```bash
cd docs/theme-surface
node tools/sync-all.mjs
ls -la ../../themes/
cd ../..
```

Expected: `themes/` 目录下 13 个 `<key>.js` 文件 + `index.json`。

- [ ] **Step 5: 修改 manifest content_scripts 删 pinboard-themes.js**

当前：

```json
"content_scripts": [
  {
    "matches": [...],
    "js": [
      "perf-mark.js",
      "pinboard-themes.js",
      "pinboard-style.js"
    ],
    "run_at": "document_start"
  }
],
```

改成（删 pinboard-themes.js）：

```json
"content_scripts": [
  {
    "matches": [...],
    "js": [
      "perf-mark.js",
      "pinboard-style.js"
    ],
    "run_at": "document_start"
  }
],
```

并加 `web_accessible_resources`（如不存在）：

```json
"web_accessible_resources": [
  {
    "resources": ["themes/*.js", "themes/index.json"],
    "matches": ["https://pinboard.in/*", "https://*.pinboard.in/*"]
  }
],
```

- [ ] **Step 6: 修改 pinboard-style.js fetch + inject 单主题**

当前 pinboard-style.js（commit a13abf2 后）依赖 `PINBOARD_THEMES` 全局。改造 IIFE 内部：

替换 `if (data.themePresetKey && typeof PINBOARD_THEMES !== "undefined") { ... }` 块为：

```javascript
    // A1: lazy fetch the active theme file via web_accessible_resources
    let presetCss = "";
    if (data.themePresetKey) {
      let themeKey = data.themePresetKey;
      if (PBP_ADAPTIVE_THEME_MAP[themeKey]) {
        const variantKey = PBP_ADAPTIVE_THEME_MAP[themeKey][isDark ? 1 : 0];
        const variantUrl = chrome.runtime.getURL(`themes/${variantKey}.js`);
        try {
          const r = await fetch(variantUrl);
          if (r.ok) themeKey = variantKey;
        } catch (_) {}
      }
      try {
        const url = chrome.runtime.getURL(`themes/${themeKey}.js`);
        const resp = await fetch(url);
        if (resp.ok) {
          const code = await resp.text();
          // Evaluate via inline script (CSP-safe in content_script extension origin)
          const s = document.createElement("script");
          s.textContent = code;
          (document.head || document.documentElement).appendChild(s);
          s.remove();
          if (window.__pbpTheme && window.__pbpTheme[themeKey]) {
            presetCss = window.__pbpTheme[themeKey].css || "";
          }
        }
      } catch (e) {
        console.warn("[pbp] theme fetch failed:", e.message);
      }
    }
```

注意 cloak 兜底应同时收紧到 400ms（spec A1 缓解）：

```javascript
// 找到 setTimeout(uncloak, 800) 改成：
setTimeout(uncloak, 400);
```

- [ ] **Step 7: 修改 options.js `_loadPinboardThemes` 仍用 monolithic**

为简化 options panel（避免再改 renderPresetPreview 等多处），保留 options 端的 monolithic 加载——pinboard-themes.js 仍由 sync-all 生成。Task 1 的 `_loadPinboardThemes` 不动。这是务实折衷：options 端 PINBOARD_THEMES 接口不变，避免大改 renderPresetPreview。

- [ ] **Step 8: pre-commit lint 适配**

`scripts/pre-commit-hook.sh` 的 5 道 lint 都基于 pinboard-themes.js。本 task 保留 pinboard-themes.js（仍由 sync-all 生成），所以 lint 应继续 pass。验证：

```bash
git add manifest.json pinboard-style.js docs/theme-surface/tools/sync-all.mjs themes/
git status
# 不要 commit themes/ 目录的内容，它们是 sync-all 输出，要看是否进 .gitignore
```

检查 `.gitignore` 是否需要把 `themes/` 加入（避免污染 commit）。如果不加，13 个生成文件会进 git，每次 sync-all 运行后都需要 commit。建议加入 .gitignore + 在 release.sh 里把 sync-all 跑一次确保打 ZIP 时有 themes/。

**实施决策**：加 `themes/` 到 .gitignore + 修改 release.sh 在打 ZIP 前 `node docs/theme-surface/tools/sync-all.mjs`。

- [ ] **Step 9: Commit（split into 3 commits）**

```bash
# Commit 1: theme factory output 扩展
git add docs/theme-surface/tools/sync-all.mjs .gitignore
git commit -m "feat(theme-factory): emit per-theme files + index.json for runtime lazy load"

# Commit 2: pinboard-style.js thin loader
git add pinboard-style.js
git commit -m "perf(pinboard): switch content_script to thin loader, fetch active theme on demand"

# Commit 3: manifest content_scripts 收缩
git add manifest.json
git commit -m "perf(manifest): remove pinboard-themes.js from content_scripts; add themes/* to web_accessible_resources"
```

如果 release.sh 改了：

```bash
# Commit 4: release.sh 集成 sync-all
git add scripts/release.sh
git commit -m "build(release): run sync-all before packaging to ensure themes/* in ZIP"
```

---

## Task 3: A3 — SW module worker + ai.js 懒加载

> **决策点**：本 task 是 Phase 3 最高风险项。SW wakeup baseline 缺失（Phase 0 没自动化采到）。实施前**必须先手测 SW wakeup baseline**：在 chrome://serviceworker-internals/ 找到扩展 SW → 点 "Stop" → 任意触发（例如打 popup）→ 在任意上下文 console 读 `chrome.storage.local._perfSamples` 的 sw-wakeup 条目。若 baseline p50 < 50ms（即 SW wakeup 本身已快），A3 收益不可见 → **跳过本 task**。

**Files:**
- Modify: `manifest.json`（`"background": { ..., "type": "module" }`）
- Modify: `background.js`（importScripts → import）
- Modify: `i18n.js`（加 export，保留全局兼容）
- Modify: `shared.js`（加 export，保留全局兼容）
- Modify: `ai.js`（改 module）
- popup.html / options.html 不动（shared.js / i18n.js 仍作 `<script>` 加载——这些文件需要双形式工作）

**Spec mapping:** C4（中 ROI）— 预估 SW wakeup p50 -30~80ms

- [ ] **Step 1: 决策点 — 测 SW wakeup baseline**

按上面"决策点"流程手测。如 baseline 已 < 50ms → 跳过 Task 3，记 spec 附录 A.8。

- [ ] **Step 2: 设计兼容方案**

挑战：`shared.js` / `i18n.js` / `ai.js` 在三个 context 加载：
- popup.html / options.html 通过 `<script>`（必须是脚本形式）
- background.js 通过 `importScripts`（旧）或 `import`（新）
- pinboard-style.js 不依赖这三个

技术路径选项：

**路 1**：SW 转 module worker → shared.js / i18n.js 必须改 module → 影响 popup/options 的 `<script>` 加载，需要双形式兼容
- shared.js / i18n.js 既要能作为 `<script>` 加载（产生全局），也要能作为 module 被 import
- 实现方式：保留全局赋值 + 添加 `export` 语句。但浏览器对非 module script 中的 `export` 报语法错误
- 折衷：popup.html / options.html 的 `<script src="shared.js">` 改成 `<script type="module" src="shared.js">`。但这影响加载顺序（module 默认 defer）
- 改动面：4 个 HTML 文件 script tag + 3 个 JS 文件改 module + background.js import 路径
- 风险：脚本加载顺序变化可能引入新 bug

**路 2**：保持 SW non-module，用其他机制懒加载 ai.js
- 例如 fetch ai.js source + eval（受 CSP `script-src` 限制，需要 `'unsafe-eval'`，安全降级，**不推荐**）
- 或拆 ai.js 为多个小函数文件，按需 importScripts 单文件
  - importScripts 在 SW 同步阻塞，且不允许在非顶级调用（只能在 SW 初始化阶段）
  - 实际不可行

**路 3**：接受现状
- importScripts ai.js 随 SW 启动 parse，~30ms 一次性成本
- 不改 manifest / SW 入口
- 跳过 A3

**结论**：在不破坏现有依赖结构的前提下，A3 的可行路径只有路 1。路 1 需要大改且风险高。**推荐：跳过 A3**（路 3）。

在 spec 附录 A.8 标记 "deferred — implementation complexity disproportionate to measured benefit (SW wakeup not on critical user-visible path)"。

如实施者**强烈想做**路 1，需要先做更深 R&D：
1. SW wakeup 用 importScripts 跑 ai.js 实际成本（手测）
2. 路 1 的全链路改造工作量评估（shared.js / i18n.js 也 module 化）
3. CSP 影响评估
4. Roll back 路径（若发现 release 后 SW 启动失败，需要紧急回退方案）

这些超出 Phase 3 自然 scope。STOP 报告 "A3 deferred — needs separate R&D phase"。

- [ ] **Step 3: 若按建议跳过**

不动任何文件。直接到 Task 4 (Validate) 时把 A3 状态记到 spec 附录 A.8。

- [ ] **Step 4: 若强行实施路 1（不推荐）**

按路 1 全面改造：manifest 加 `"type": "module"`，shared.js / i18n.js / ai.js 全部加 export + 同时保留 window 全局兼容。background.js 改 import 语法。popup.html / options.html 的 `<script src="shared.js">` 改 `<script type="module" src="shared.js">`（注意 type="module" 自动 defer，可能影响顺序）。

代码改动太大，本 plan 不展开。如真要做，单独写 Phase 3.5 plan。

---

## Task 4: Validate — 重测对比 + 更新 spec

**Files:**
- Create: `perf-after-phase3.json`
- Modify: `docs/superpowers/specs/2026-05-27-perf-audit-design.md`（追加附录 A.8）

- [ ] **Step 1: chrome-dbg 里重新加载扩展 + 唤醒 SW**

`chrome://extensions/` → "重新加载"。点扩展图标。**如做了 A1 + 改了 manifest**，可能需要"重新加载"两次（manifest 改动后 Chrome 偶有要求）。

- [ ] **Step 2: 跑采样**

```bash
node scripts/perf-sample.mjs --ext-id aghcegglioapkbgjmbgkmkiiijccoiln \
  --only popup-warm,options-warm,pinboard-inject --runs 10 --out perf-after-phase3.json
```

- [ ] **Step 3: 四方对比**

```bash
python3 -c "
import json
files = ['perf-baseline.json', 'perf-after-phase1.json', 'perf-after-phase2.json', 'perf-after-phase3.json']
labels = ['baseline', 'phase-1', 'phase-2', 'phase-3']
data = [json.load(open(f))['results'] for f in files]
print(f'{\"scenario\":<18} {\"measure\":<32} ' + ' '.join(f'{l:<10}' for l in labels))
print('-' * 100)
for scn in sorted(set().union(*data)):
    for k in sorted(set().union(*(d.get(scn, {}) for d in data))):
        ps = [d.get(scn, {}).get(k, {}).get('p50') for d in data]
        row = f'{scn:<18} {k:<32} '
        for p in ps:
            row += f'{str(p):<10}' if p is not None else f'{\"—\":<10}'
        print(row)
"
```

- [ ] **Step 4: 验收阈值**

- options-fcp p50 应 ≤ 250ms（A2 后）或更低
- ct-inject p50 应 ≤ 20ms 或更低（A1 后）
- 其他不退化（≤ phase-2 × 1.05）

- [ ] **Step 5: 体感手测**

- pinboard.in 切换 13 主题验证无闪烁
- options 打开 → 切到 appearance panel → 验证主题预览正常出现（lazy 加载完成后渲染）
- popup 打开 / batch save / AI 调用（如 A3 改了 SW，重点关注 SW 唤醒和 AI 路径）

- [ ] **Step 6: 更新 spec 附录 A.8**

写入 `docs/superpowers/specs/2026-05-27-perf-audit-design.md` 附录 A.7 之后：

```markdown
### A.8 Phase 3 完成后基线（2026-XX-XX）

Phase 3 完成于 commits <list>。

实施清单：
- A2: ✓ commit `<sha>`
- A1: ✓ commits `<sha list>` / ⊘ skipped — A2 alone achieved target / ⊘ deferred — reason
- A3: ⊘ deferred — implementation complexity / not implemented

| measure | Phase 2 p50 | Phase 3 p50 | Δ | 备注 |
|---------|------------|------------|----|------|
| ...（填入实测） | | | | |
```

- [ ] **Step 7: Commit**

```bash
git add perf-after-phase3.json
git add -f docs/superpowers/specs/2026-05-27-perf-audit-design.md
git commit -m "test(perf): capture phase 3 after-baseline and validate"
```

---

## Self-Review

### 1. Spec coverage

| Spec Group A 项 | 覆盖任务 | 状态 |
|---|---|---|
| A2 (C2) options 懒加载 themes | Task 1 | 必做 |
| A1 (C3) 拆主题表 | Task 2 | 决策点 — A2 后看 |
| A3 (C4) SW module worker | Task 3 | 推荐 deferred — 复杂度高 + benefit 不可测 |

A3 推荐 deferred 在 plan 内有完整论证（决策点 + 三条候选路径 + 推荐）。spec 仍可标记"已审议、暂缓"而非"已实施"。

### 2. Placeholder scan

- 无 "TBD" / "TODO"
- Task 4 Step 6 模板里的 `<sha>` `<sha list>` 是 validate 阶段实测填入位置
- 无 "implement later"

### 3. Type consistency

- `_loadPinboardThemes` 函数命名一致
- `_appearanceInited` / `_appearancePanelBootReady` / `_appearancePendingInit` Phase 2 状态延续
- `themes/<key>.js` 路径模式一致

### 4. 依赖与决策点

Task 0 → Task 1 → 决策点 → Task 2 (or skip) → 决策点 → Task 3 (or skip) → Task 4

Task 2 和 Task 3 都有可跳过路径，依赖前面任务的实测数据决定。Plan 把决策的依据（具体指标阈值）写明。

---

## Phase 3 完成的标志

- ✅ A2 实施 + 验证 options-fcp 大幅下降
- ✅ A1 实施 OR 决策跳过（基于数据）
- ✅ A3 决策跳过（推荐）OR 深 R&D 后单开 Phase 3.5
- ✅ perf-after-phase3.json + spec 附录 A.8 落地

## 总 Commit 数

- A2 only: 2 commits（1 实施 + 1 validate）
- A2 + A1: 5-6 commits（1 + 3-4 + 1）
- A2 + A1 + A3: 加 6-10 commits（A3 真要做的话需要单独 plan）

预期：3-6 commits（A2 必做、A1 视数据、A3 大概率 defer）
