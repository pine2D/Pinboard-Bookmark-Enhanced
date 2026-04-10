# Defuddle Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace naive innerText extraction with Defuddle for higher-quality main content extraction, and enable local Markdown export as an alternative to Jina Reader API.

**Architecture:** Defuddle UMD (~238KB) is vendored and injected into page tabs on demand via `chrome.scripting.executeScript`. `getPageInfoFromTab()` uses Defuddle with innerText fallback. Markdown button supports both Local (Defuddle) and Jina modes based on existing `aiContentSource` setting.

**Tech Stack:** Defuddle (vendored UMD), Chrome Extension MV3, vanilla JS

---

### Task 1: Vendor Defuddle and Create Update Script

**Files:**
- Create: `vendor/defuddle.js`
- Create: `scripts/update-vendor.sh`

- [ ] **Step 1: Create vendor directory and download Defuddle**

```bash
cd "/mnt/d/APP/Chrome Extensions/Pinboard-Bookmark-Enhanced"
mkdir -p vendor
TMP=$(mktemp -d)
npm pack defuddle --pack-destination "${TMP}"
tar xzf "${TMP}"/defuddle-*.tgz -C "${TMP}"
VERSION=$(node -e "console.log(require('${TMP}/package/package.json').version)")
cp "${TMP}/package/dist/index.js" vendor/defuddle.js
sed -i "1s|^|// defuddle v${VERSION} — https://github.com/kepano/defuddle\n|" vendor/defuddle.js
rm -rf "${TMP}"
echo "Vendored defuddle v${VERSION}"
```

Expected: `vendor/defuddle.js` exists, ~238KB, first line contains version comment.

- [ ] **Step 2: Verify UMD global is `Defuddle`**

```bash
head -2 vendor/defuddle.js
```

Expected: Line 1 is version comment, line 2 starts with `!function(t,e){"object"==typeof exports...t.Defuddle=e()}`

- [ ] **Step 3: Create update-vendor.sh**

Create `scripts/update-vendor.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT=$(git rev-parse --show-toplevel)
VENDOR_DIR="${REPO_ROOT}/vendor"
mkdir -p "${VENDOR_DIR}"

TMP=$(mktemp -d)
npm pack defuddle --pack-destination "${TMP}"
tar xzf "${TMP}"/defuddle-*.tgz -C "${TMP}"

VERSION=$(node -e "console.log(require('${TMP}/package/package.json').version)")
cp "${TMP}/package/dist/index.js" "${VENDOR_DIR}/defuddle.js"
sed -i "1s|^|// defuddle v${VERSION} — https://github.com/kepano/defuddle\n|" "${VENDOR_DIR}/defuddle.js"
rm -rf "${TMP}"

echo "Updated to defuddle v${VERSION}"
echo "  ${VENDOR_DIR}/defuddle.js"
```

```bash
chmod +x scripts/update-vendor.sh
```

- [ ] **Step 4: Commit**

```bash
git add vendor/defuddle.js scripts/update-vendor.sh
git commit -m "chore: vendor defuddle v0.16.0 and add update script"
```

---

### Task 2: Upgrade getPageInfoFromTab() to Use Defuddle

**Files:**
- Modify: `ai.js:6-29`

- [ ] **Step 1: Replace getPageInfoFromTab() with Defuddle-powered version**

Replace the entire `getPageInfoFromTab` function in `ai.js` (lines 6-29) with:

```javascript
async function getPageInfoFromTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
      return { url, title: tab.title || "", selectedText: "", metaDescription: "", referrer: "", pageText: "" };
    }

    // Inject Defuddle library first
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/defuddle.js"] });
    } catch (_) {
      // Defuddle injection failed — fall through to legacy extraction
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const info = { url: location.href, title: document.title, selectedText: "", metaDescription: "", referrer: document.referrer || "", pageText: "" };
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) { const t = sel.toString().trim(); if (t) info.selectedText = t; }
        const md = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
        if (md) info.metaDescription = md.getAttribute("content") || "";

        // Try Defuddle for high-quality content extraction
        if (typeof Defuddle !== "undefined") {
          try {
            const clone = document.cloneNode(true);
            const result = new Defuddle(clone).parse();
            if (result?.textContent && result.textContent.length > 50) {
              info.pageText = result.textContent.substring(0, 8000);
              return info;
            }
          } catch (_) { /* fall through to legacy */ }
        }

        // Fallback: legacy innerText extraction
        const mainEl = document.querySelector("article") || document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
        info.pageText = (mainEl ? mainEl.innerText : "").substring(0, 8000);
        return info;
      }
    });
    if (results?.[0]?.result) return results[0].result;
  } catch (e) { console.warn("getPageInfoFromTab failed:", e.message); }
  return null;
}
```

- [ ] **Step 2: Test manually**

1. Load extension in `chrome://extensions/`
2. Open any article page (e.g. a Wikipedia article or blog post)
3. Open popup, trigger AI tag generation
4. Verify tags are generated (content extraction worked)
5. Check extension console (popup devtools) for no errors

- [ ] **Step 3: Commit**

```bash
git add ai.js
git commit -m "feat: upgrade getPageInfoFromTab to use Defuddle with innerText fallback"
```

---

### Task 3: Rename jina-preview files to md-preview

**Files:**
- Rename: `jina-preview.html` → `md-preview.html`
- Rename: `jina-preview.js` → `md-preview.js`
- Rename: `jina-preview.css` → `md-preview.css`
- Modify: `md-preview.html` (update CSS/JS references)
- Modify: `md-preview.js` (update storage key and comments)
- Modify: `popup.js` (update preview URL and storage key references)

- [ ] **Step 1: Rename the three files**

```bash
cd "/mnt/d/APP/Chrome Extensions/Pinboard-Bookmark-Enhanced"
git mv jina-preview.html md-preview.html
git mv jina-preview.js md-preview.js
git mv jina-preview.css md-preview.css
```

- [ ] **Step 2: Update md-preview.html internal references**

In `md-preview.html`, change:
- `href="jina-preview.css"` → `href="md-preview.css"`
- `src="jina-preview.js"` → `src="md-preview.js"`

- [ ] **Step 3: Update md-preview.js storage key and comments**

In `md-preview.js`:
- Change file header comment from `Jina Reader Markdown Preview Page` to `Markdown Preview Page`
- Change `chrome.storage.local.get("jina_preview_data")` → `chrome.storage.local.get("md_preview_data")`
- Change `data.jina_preview_data` → `data.md_preview_data`
- Change `chrome.storage.local.remove("jina_preview_data")` → `chrome.storage.local.remove("md_preview_data")`
- Update security note comment: remove "from Jina Reader API" reference, use "from Defuddle or Jina Reader API"

- [ ] **Step 4: Update popup.js references**

In `popup.js`:
- Change `jina_preview_data` → `md_preview_data` (in the `chrome.storage.local.set()` call)
- Change `url: "jina-preview.html"` → `url: "md-preview.html"` (in the `chrome.tabs.create()` call)

- [ ] **Step 5: Update popup.html button attributes**

In `popup.html`, the button (line 109):
- Change `title="Convert page to Markdown via Jina Reader"` → `title="Convert page to Markdown"` (since it's no longer Jina-only)
- Keep `id="jina-md-btn"` and `data-i18n` keys unchanged to avoid i18n churn — these are internal identifiers

- [ ] **Step 6: Commit**

```bash
git add md-preview.html md-preview.js md-preview.css popup.js popup.html
git commit -m "refactor: rename jina-preview to md-preview for source-agnostic naming"
```

---

### Task 4: Add Local Markdown Export via Defuddle

**Files:**
- Modify: `popup.js:203-254` (Markdown button handler)

- [ ] **Step 1: Add Defuddle-based local extraction function**

In `popup.js`, add a new function before the Markdown button handler (before line 195). This function extracts Markdown from the current tab using Defuddle:

```javascript
async function extractLocalMarkdown(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/defuddle.js"] });
  } catch (_) {
    return { error: "Cannot access this page" };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (typeof Defuddle === "undefined") return { error: "Defuddle not available" };
        try {
          const clone = document.cloneNode(true);
          const result = new Defuddle(clone, { markdown: true }).parse();
          if (!result?.contentMarkdown) return { error: "No content extracted" };
          return { markdown: result.contentMarkdown, title: result.title || document.title, url: location.href };
        } catch (e) { return { error: e.message }; }
      }
    });
    if (results?.[0]?.result) return results[0].result;
    return { error: "Script execution failed" };
  } catch (e) { return { error: e.message }; }
}
```

- [ ] **Step 2: Modify Markdown button handler to support both modes**

Replace the Markdown button click handler (the `jinaMdBtn.addEventListener("click", async () => { ... })` block) with a version that branches on `settings.aiContentSource`:

```javascript
    jinaMdBtn.addEventListener("click", async () => {
      if (jinaMdBtn.disabled) return;
      const url = document.getElementById("url-input").value;
      if (!url) return;

      const origText = jinaMdBtn.textContent;
      jinaMdBtn.textContent = t("jinaConverting");
      jinaMdBtn.disabled = true;

      let result;
      if (settings.aiContentSource === "jina") {
        // Remote: Jina Reader API
        const jinaKey = settings.jinaApiKey ? deobfuscateKey(settings.jinaApiKey) : "";
        result = await fetchJinaMarkdown(url, {
          apiKey: jinaKey,
          cacheDuration: settings.aiCacheDuration
        });
        if (!result.error) result._hasApiKey = !!jinaKey;
      } else {
        // Local: Defuddle
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        result = await extractLocalMarkdown(tab.id);
        if (!result.error) result._hasApiKey = false;
      }

      if (result.error) {
        jinaMdBtn.textContent = "❌ " + t("jinaFailed");
        jinaMdBtn.title = result.error;
        setTimeout(() => { jinaMdBtn.textContent = origText; jinaMdBtn.disabled = false; jinaMdBtn.title = ""; }, 2000);
        return;
      }

      // Copy to clipboard
      try {
        await navigator.clipboard.writeText(result.markdown);
      } catch (_) {
        jinaMdBtn.textContent = "❌ " + t("jinaFailed");
        setTimeout(() => { jinaMdBtn.textContent = origText; jinaMdBtn.disabled = false; }, 2000);
        return;
      }

      // Show success with View link
      jinaMdBtn.textContent = "✅ " + t("jinaCopied");
      setTimeout(() => {
        jinaMdBtn.textContent = "👁 " + t("jinaViewBtn");
        jinaMdBtn.disabled = false;
        jinaMdBtn.onclick = async () => {
          await chrome.storage.local.set({
            md_preview_data: {
              markdown: result.markdown,
              title: result.title || document.getElementById("title-input")?.value || "",
              url: result.url || url,
              tokens: result.tokens || 0,
              hasApiKey: !!result._hasApiKey
            }
          });
          chrome.tabs.create({ url: "md-preview.html" });
        };
      }, 1500);
    });
```

- [ ] **Step 3: Test both modes manually**

**Test Local mode:**
1. In extension options, set AI Content Source to "Local"
2. Open any article page, open popup
3. Click Markdown button → should show "Converting..." then "Copied!"
4. Paste clipboard — verify clean Markdown with main content only
5. Click "View" → md-preview.html opens, no token badge shown

**Test Jina mode:**
1. In extension options, set AI Content Source to "Jina Reader"
2. Repeat the same steps
3. Verify Jina API is called (slower), token badge shown if API key configured

- [ ] **Step 4: Commit**

```bash
git add popup.js
git commit -m "feat: add local Markdown export via Defuddle, branch on aiContentSource setting"
```

---

### Task 5: Update release.sh

**Files:**
- Modify: `scripts/release.sh:35-43`

- [ ] **Step 1: Update INCLUDE list**

In `scripts/release.sh`, replace the INCLUDE array content:

Change:
```bash
  jina.js jina-preview.html jina-preview.js jina-preview.css
```
To:
```bash
  jina.js md-preview.html md-preview.js md-preview.css
  vendor
```

- [ ] **Step 2: Commit**

```bash
git add scripts/release.sh
git commit -m "chore: update release includes for md-preview rename and vendor directory"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Reload extension and test AI content extraction**

1. Go to `chrome://extensions/`, click reload on the extension
2. Open a complex article page (e.g. a long Wikipedia article with sidebar)
3. Open popup → trigger AI tag generation
4. Verify tags are relevant to the article content (not sidebar/nav noise)
5. Compare quality with a simple page (e.g. a blog post)

- [ ] **Step 2: Test local Markdown export on diverse pages**

Test on at least 3 different page types:
- A news article (e.g. BBC, NYT)
- A GitHub repository README
- A documentation page (e.g. MDN)

For each: click Markdown button → verify clipboard has clean Markdown → verify preview page renders correctly.

- [ ] **Step 3: Test Jina mode still works**

1. Switch to Jina Reader in settings
2. Click Markdown button on any page
3. Verify API call succeeds, preview shows token badge

- [ ] **Step 4: Test fallback behavior**

1. Open a chrome:// page (e.g. chrome://settings)
2. Open popup — Markdown button should be disabled (existing behavior)
3. Open a minimal page with very little content — verify innerText fallback triggers without errors

- [ ] **Step 5: Verify release ZIP**

```bash
bash scripts/release.sh --no-overwrite
```

Verify the ZIP contains:
- `vendor/defuddle.js`
- `md-preview.html`, `md-preview.js`, `md-preview.css`
- No `jina-preview.*` files
