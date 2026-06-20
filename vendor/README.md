# Third-Party Libraries

This directory contains third-party JavaScript libraries bundled with the extension. They are shipped verbatim from their published distributions to comply with the Chrome Web Store's "no remote code" policy (extensions cannot fetch executable code at runtime).

For Chrome Web Store reviewers: every file in this directory is unmodified upstream output. The first line of each file records the version and upstream URL. Reproduction instructions are below.

## Inventory

| File | Version | Upstream | License | Purpose |
|------|---------|----------|---------|---------|
| `defuddle.js` | 0.18.1 | https://github.com/kepano/defuddle | MIT | Extracts main article content from arbitrary web pages so AI tag/summary requests can send clean text instead of full HTML. Injected via `chrome.scripting.executeScript` into the active tab on user action only. |
| `turndown.js` | 7.2.4 | https://github.com/mixmark-io/turndown | MIT | Converts captured HTML to Markdown for the in-extension preview tab. Loaded only inside `md-preview.html`. |
| `marked.min.js` | 18.0.5 | https://github.com/markedjs/marked | MIT | Converts canonical Markdown to HTML for the preview render (then sanitized by DOMPurify). Loaded only inside `md-preview.html`. Vendored from the npm UMD build (`lib/marked.umd.js`) under the historical `.min.js` name. |
| `purify.min.js` | 3.4.10 | https://github.com/cure53/DOMPurify | Apache-2.0 / MPL-2.0 | The single sanitize point: cleans all HTML before it enters the preview DOM (both `marked` output and arbitrary web-page Markdown). Loaded only inside `md-preview.html`. |
| `highlight.min.js`, `hljs-github*.min.css` | 11.11.1 | https://github.com/highlightjs/highlight.js | BSD-3-Clause | Syntax-highlights fenced/auto-detected code blocks in the Markdown preview. Loaded only inside `md-preview.html`. |
| `katex/` | 0.17.0 | https://github.com/KaTeX/KaTeX | MIT | Renders LaTeX math (`$...$` / `$$...$$`) in the Markdown preview. Lazy-loaded in `md-preview.html` only for content flagged math-bearing (e.g. arXiv abstracts) — never on other pages, so currency `$` is never touched. woff2 fonts only (Chrome supports woff2). |

## Reproduction (for source verification)

### `defuddle.js`
```bash
npm pack defuddle@0.18.1
tar -xzf defuddle-0.18.1.tgz package/dist/index.js
diff package/dist/index.js vendor/defuddle.js
```
Or build from source:
```bash
git clone https://github.com/kepano/defuddle.git
cd defuddle
git checkout 0.18.1
npm install
npm run build
# Output: dist/index.js (matches vendor/defuddle.js byte-for-byte)
```

### `turndown.js`
The file ships pre-built from npm. To verify:
```bash
npm pack turndown@7.2.4
tar -xzf turndown-7.2.4.tgz package/dist/turndown.js
diff package/dist/turndown.js vendor/turndown.js
```

### `marked.min.js`
```bash
npm pack marked@18.0.5
tar -xzf marked-18.0.5.tgz package/lib/marked.umd.js
diff package/lib/marked.umd.js vendor/marked.min.js   # UMD build, vendored under the .min.js name
```

### `purify.min.js`
```bash
npm pack dompurify@3.4.10
tar -xzf dompurify-3.4.10.tgz package/dist/purify.min.js
diff package/dist/purify.min.js vendor/purify.min.js
```

### `highlight.min.js`
The browser build is not in the npm tarball; it is vendored from cdnjs (the official prebuilt bundle). To verify:
```bash
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js              | diff - vendor/highlight.min.js
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css         | diff - vendor/hljs-github.min.css
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css    | diff - vendor/hljs-github-dark.min.css
```

### `katex/`
```bash
npm pack katex@0.17.0
tar -xzf katex-0.17.0.tgz
# vendor/katex/ = package/dist/{katex.min.js, katex.min.css, contrib/auto-render.min.js, fonts/*.woff2}
# (auto-render.min.js flattened out of contrib/; .woff/.ttf fonts dropped — Chrome uses woff2)
```

## Update Policy

Vendor files are pinned to specific versions and updated only when needed (security fix, breaking compatibility). `scripts/update-vendor.sh` refreshes **`defuddle.js` and `turndown.js`** (it pulls npm `latest` for both — unpinned — and re-stamps the version banner). The remaining libraries (`marked.min.js`, `purify.min.js`, `highlight.min.js`, `katex/`) are refreshed manually per the Reproduction steps above. Note: a `marked` upgrade requires adapting the custom `renderer.heading` in `md-convert.js` — v13+ passes a token object instead of positional `(text, level, raw)`.

## Why Bundled Instead of npm-installed

This extension has no build step (vanilla JS, no bundler). Chrome Web Store policy forbids loading scripts from a remote origin at runtime, so the dependencies must be on disk inside the package. Inlining via `<script src="vendor/...">` is the simplest compliant pattern.
