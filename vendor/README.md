# Third-Party Libraries

This directory contains third-party JavaScript libraries bundled with the extension. They are shipped verbatim from their published distributions to comply with the Chrome Web Store's "no remote code" policy (extensions cannot fetch executable code at runtime).

For Chrome Web Store reviewers: library payloads are unmodified upstream output. Only `defuddle.js` and `turndown.js` have an added one-line version/source comment; other library headers remain as published. Versions, sources, licenses and SHA-256 hashes are recorded in `vendor-lock.json`. Reproduction instructions are below.

## Inventory

| File | Version | Upstream | License | Purpose |
|------|---------|----------|---------|---------|
| `defuddle.js` | 0.19.4 | https://github.com/kepano/defuddle | MIT | Extracts main article content from arbitrary web pages so AI tag/summary requests can send clean text instead of full HTML. Injected via `chrome.scripting.executeScript` into the active tab on user action only. |
| `turndown.js` | 7.2.4 | https://github.com/mixmark-io/turndown | MIT | Converts captured HTML to canonical Markdown. Loaded in `md-preview.html` and lazily in the popup when conversion is needed. |
| `marked.min.js` | 18.1.0 | https://github.com/markedjs/marked | MIT | Converts canonical Markdown to HTML for the preview render (then sanitized by DOMPurify). Loaded only inside `md-preview.html`. Vendored from the npm UMD build (`lib/marked.umd.js`) under the historical `.min.js` name. |
| `purify.min.js` | 3.4.16 | https://github.com/cure53/DOMPurify | Apache-2.0 / MPL-2.0 | The single sanitize point: cleans all HTML before it enters the preview DOM (both `marked` output and arbitrary web-page Markdown). Loaded only inside `md-preview.html`. Official unminified UMD (`dist/purify.js`) under the historical `.min.js` name; see the performance review below. |
| `highlight.min.js`, `hljs-github*.min.css` | 11.12.0 | https://github.com/highlightjs/highlight.js | BSD-3-Clause | Syntax-highlights fenced/auto-detected code blocks in the Markdown preview. Loaded only inside `md-preview.html`. |
| `katex/` | 0.19.0 | https://github.com/KaTeX/KaTeX | MIT | Renders LaTeX math (`$...$` / `$$...$$`) in the Markdown preview. Lazy-loaded in `md-preview.html` only for content flagged math-bearing (e.g. arXiv abstracts) — never on other pages, so currency `$` is never touched. woff2 fonts only (Chrome supports woff2). |
| `mermaid.min.js` | 12.1.0 | https://github.com/mermaid-js/mermaid | MIT | Renders Mermaid diagram code fences to inline SVG in the Markdown preview. Lazy-loaded by `md-mermaid.js` only when Mermaid-flagged content is present. Official npm single-file IIFE build, byte-identical to jsDelivr — refreshed manually, not covered by `scripts/update-vendor.sh`. |

## Reproduction (for source verification)

### `defuddle.js`
```bash
npm pack defuddle@0.19.4
tar -xzf defuddle-0.19.4.tgz package/dist/index.js
tail -n +2 vendor/defuddle.js | diff package/dist/index.js -
```
The comparison skips the extension's added provenance comment. Compare against the published tarball rather than rebuilding with potentially different dependency versions.

### `turndown.js`
The file ships pre-built from npm. To verify:
```bash
npm pack turndown@7.2.4
tar -xzf turndown-7.2.4.tgz package/lib/turndown.browser.umd.js
tail -n +2 vendor/turndown.js | diff package/lib/turndown.browser.umd.js -
```

### `marked.min.js`
```bash
npm pack marked@18.1.0
tar -xzf marked-18.1.0.tgz package/lib/marked.umd.js
diff package/lib/marked.umd.js vendor/marked.min.js   # UMD build, vendored under the .min.js name
```

### `purify.min.js`
```bash
npm pack dompurify@3.4.16
tar -xzf dompurify-3.4.16.tgz package/dist/purify.js
diff package/dist/purify.js vendor/purify.min.js
```

### `highlight.min.js`
The browser build is not in the npm tarball; it is vendored from cdnjs (the official prebuilt bundle). To verify:
```bash
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/highlight.min.js              | diff - vendor/highlight.min.js
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/styles/github.min.css         | diff - vendor/hljs-github.min.css
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/styles/github-dark.min.css    | diff - vendor/hljs-github-dark.min.css
```

### `katex/`
```bash
npm pack katex@0.19.0
tar -xzf katex-0.19.0.tgz
# vendor/katex/ = package/dist/{katex.min.js, katex.min.css, contrib/auto-render.min.js, fonts/*.woff2}
# (auto-render.min.js flattened out of contrib/; .woff/.ttf fonts dropped — Chrome uses woff2)
diff package/dist/katex.min.js vendor/katex/katex.min.js
diff package/dist/katex.min.css vendor/katex/katex.min.css
diff package/dist/contrib/auto-render.min.js vendor/katex/auto-render.min.js
diff -r --exclude='*.woff' --exclude='*.ttf' package/dist/fonts vendor/katex/fonts
```

### `mermaid.min.js`
```bash
npm pack mermaid@12.1.0
tar -xzf mermaid-12.1.0.tgz package/dist/mermaid.min.js
diff package/dist/mermaid.min.js vendor/mermaid.min.js
# Optional cross-check against the CDN's copy of the same published file:
curl -fsSL https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js | diff - vendor/mermaid.min.js
```
The npm package includes this single-file IIFE build. It requires no remote chunks or runtime npm installation.

## Update Policy

Vendor files are pinned to reviewed official stable releases. When refreshing, check all seven packages against the registry's `latest`, review upstream changes, then validate compatibility before updating the lock and committing. `scripts/update-vendor.sh` refreshes **`defuddle.js`, `turndown.js`, `marked.min.js`, `purify.min.js`, and `highlight.min.js` (+ its github theme CSS)** to the true npm-registry `latest`. It fetches release tarballs straight from `registry.npmjs.org` (and cdnjs for the highlight.js browser bundle) and verifies the SHA-1 the registry publishes — which deliberately **bypasses any local npm cooldown** (e.g. Aikido safe-chain's rolling ~7-day `before` window, which otherwise resolves `@latest` to an older version and hides freshly-published releases; safe-chain wraps `npm`/`npx`, not `curl`). `katex/` is refreshed manually (multi-file dist + woff2 fonts) per the Reproduction steps above. `mermaid.min.js` is likewise refreshed manually from its npm tarball per its Reproduction step above. For manual refreshes, also verify the registry's `dist.integrity` / `dist.shasum` before copying files. Note: a `marked` major bump requires reviewing the custom renderers in `md-convert.js` — v13+ passes token objects instead of positional arguments.

## Compatibility Review (2026-10-07)

All seven versions above match official stable releases on the review date. All 11 locked artifacts and all 20 woff2 fonts were compared against upstream bytes; the KaTeX auto-render script and fonts are unchanged between 0.18.4 and 0.19.0.

- [Defuddle 0.19.4](https://github.com/kepano/defuddle/releases/tag/0.19.4) improves extraction, code/inline serialization, MathML tables, declarative shadow DOM and sanitization. The extension's synchronous `parse()`/HTML-to-Markdown path is unchanged. This release does not change its AI conversation extractors; bespoke AI chat adapters remain outside this update.
- [marked 18.1.0](https://github.com/markedjs/marked/releases/tag/v18.1.0) and the intervening patches fix Markdown edge cases and expensive link-parser backtracking. Existing token-based heading/table renderers remain compatible.
- [DOMPurify 3.4.15](https://github.com/cure53/DOMPurify/releases/tag/3.4.15) and [3.4.16](https://github.com/cure53/DOMPurify/releases/tag/3.4.16) add hardening and hook/root fixes. The existing single sanitize point, hooks and reject-by-default class/id policy remain in place. A 758,507-byte / 3,601-block synthetic article exposed a performance difference between the official 3.4.16 builds in Chromium: the minified UMD took about 169–172 ms to sanitize, versus 75–81 ms for the unminified UMD and 63–67 ms for 3.4.14/3.4.15. These are local fixture measurements, not user-device cold-start guarantees. The extension therefore ships the official `dist/purify.js` verbatim and the updater keeps that choice; no sanitizer checks are disabled. Recompare both upstream builds on later updates.
- [KaTeX 0.19.0](https://github.com/KaTeX/KaTeX/releases/tag/v0.19.0) changes missing-character reporting through `strict`. The extension uses default warning behavior and `throwOnError: false`, with no strict callback, so no consumer change is needed.
- [Mermaid 12](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0) changes default layout and appearance. `md-mermaid.js` explicitly sets `layout: "dagre"` and `look: "classic"` to preserve existing diagrams while allowing source front matter to override them. The IIFE grows from about 3.4 MiB to 5.2 MiB because ELK is bundled; it remains lazy-loaded only for diagram-bearing content. Version 12.1.0 also updates parser dependencies and fixes rendering issues. Mermaid now targets ES2024; keep the extension's supported Chrome version compatible when upgrading further.

`scripts/update-vendor.sh --check-only` is a separate, read-only mode: it diffs every `vendor-lock.json` version (all 7 packages, including `katex` and `mermaid` which the refresh above doesn't fetch from npm) against `registry.npmjs.org` `latest`, plus a liveness check of the OpenRouter default model against its free `/api/v1/models` catalog, and exits non-zero if anything is behind or dead. It downloads and writes nothing, and is deliberately not wired into `verify.sh` / pre-commit / `release.sh` — run it by hand when you want a signal the world moved.

## Why Bundled Instead of npm-installed

This extension has no build step (vanilla JS, no bundler). Chrome Web Store policy forbids loading scripts from a remote origin at runtime, so the dependencies must be on disk inside the package. Inlining via `<script src="vendor/...">` is the simplest compliant pattern.
