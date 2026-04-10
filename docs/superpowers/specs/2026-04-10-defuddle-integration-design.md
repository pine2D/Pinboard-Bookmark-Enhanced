# Defuddle Integration — Design Spec

## Goal

Replace the naive `innerText` extraction in `getPageInfoFromTab()` with Defuddle for higher-quality main content extraction. Enable local Markdown export via the existing Markdown button, as an alternative to the Jina Reader API.

## Architecture

Defuddle (`vendor/defuddle.js`, ~238KB UMD) is vendored into the project and injected into page tabs on demand via `chrome.scripting.executeScript`. A thin wrapper in `ai.js` isolates the rest of the codebase from Defuddle's API surface, so future Defuddle version changes only require updating the wrapper.

Settings remain two options: **Local** (now powered by Defuddle) and **Jina Reader** (unchanged). No new UI controls.

## File Changes

| File | Change | Purpose |
|------|--------|---------|
| `vendor/defuddle.js` | Create | Defuddle UMD dist, version noted in file header |
| `scripts/update-vendor.sh` | Create | One-command script to pull latest Defuddle from npm |
| `ai.js` | Modify | `getPageInfoFromTab()` uses Defuddle with innerText fallback |
| `popup.js` | Modify | Markdown button uses Defuddle when `aiContentSource === "local"`; update preview URL to `md-preview.html` |
| `jina-preview.html` → `md-preview.html` | Rename | Preview page serves both Local and Jina sources |
| `jina-preview.js` → `md-preview.js` | Rename | Update internal references |
| `jina-preview.css` → `md-preview.css` | Rename | Stylesheet follows page rename |
| `manifest.json` | Modify | Version bump (auto via hook) |
| `scripts/release.sh` | Modify | Add `vendor/`; rename jina-preview → md-preview in INCLUDE list |

## Content Extraction Pipeline

### Path 1: AI Content Source (`getPageInfoFromTab()`)

Called by popup.js, background.js, and popup-batch.js for AI tag/summary generation.

```
chrome.scripting.executeScript({ files: ["vendor/defuddle.js"] })
  → chrome.scripting.executeScript({ func: extractWithDefuddle })
    → clone = document.cloneNode(true)
    → result = new Defuddle(clone).parse()
    → if result?.textContent?.length > 50:
        pageText = result.textContent.substring(0, 8000)
      else:
        fallback to (article/main/body).innerText.substring(0, 8000)
    → return { url, title, selectedText, metaDescription, referrer, pageText }
```

The return shape of `getPageInfoFromTab()` does not change. All callers remain unmodified.

### Path 2: Markdown Export Button

The popup Markdown button behavior depends on `settings.aiContentSource`:

**When "local":**
```
chrome.scripting.executeScript({ files: ["vendor/defuddle.js"] })
  → chrome.scripting.executeScript({ func: extractMarkdownWithDefuddle })
    → clone = document.cloneNode(true)
    → result = new Defuddle(clone, { markdown: true }).parse()
    → return { markdown: result.contentMarkdown, title: result.title, url }
  → copy markdown to clipboard
  → store in md_preview_data (with hasApiKey: false)
  → open md-preview.html
```

**When "jina":**
Existing Jina API flow, unchanged.

### Defuddle Injection Strategy

Defuddle is injected via `chrome.scripting.executeScript({ files: [...] })`, not via manifest `content_scripts`. This means:
- No performance impact on pages where the extension isn't used
- No permission changes needed (existing `activeTab` + `scripting` suffice)
- Injection is idempotent (re-injecting the UMD is safe — it just reassigns the global)

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Defuddle injection fails (chrome://, edge cases) | Existing early-return logic handles non-http URLs already |
| `Defuddle.parse()` returns null | Fallback to innerText extraction |
| `textContent` too short (< 50 chars) | Fallback to innerText extraction |
| Defuddle throws | catch → fallback to innerText extraction |
| Local Markdown export fails | Show error in button, same UX as Jina failure |

## Preview Page Rename

`jina-preview.*` renamed to `md-preview.*` since the page now serves both Local and Jina sources:
- `jina-preview.html` → `md-preview.html` (update CSS/JS references inside)
- `jina-preview.js` → `md-preview.js` (update storage key `jina_preview_data` → `md_preview_data`)
- `jina-preview.css` → `md-preview.css`
- `popup.js`: update `chrome.tabs.create({ url: "md-preview.html" })` and storage key
- Token badge: hidden when `hasApiKey: false` (already implemented)
- Markdown content: same format regardless of source

## Vendor Management

### File: `vendor/defuddle.js`

- Copied from `npm pack defuddle` → `dist/index.js`
- First line: `// defuddle v0.16.0 — https://github.com/kepano/defuddle`
- UMD format, exposes global `Defuddle`

### File: `scripts/update-vendor.sh`

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

### Update Policy

- Update intentionally, not automatically
- Test after each update: AI tag generation + local Markdown export on 3-5 diverse pages
- The wrapper function in ai.js isolates Defuddle's API — if parse() signature changes, only the wrapper needs updating

## Scope Exclusions

- No new Settings UI controls
- No changes to Jina Reader integration
- No Turndown or Readability (Defuddle replaces both)
- No changes to AI prompt templates
- No changes to jina-preview.css (already modernized)
