# Third-Party Libraries

This directory contains third-party JavaScript libraries bundled with the extension. They are shipped verbatim from their published distributions to comply with the Chrome Web Store's "no remote code" policy (extensions cannot fetch executable code at runtime).

For Chrome Web Store reviewers: library payloads are unmodified upstream output. Only `defuddle.js` and `turndown.js` have an added one-line version/source comment; other library headers remain as published. Versions, sources, licenses and SHA-256 hashes are recorded in `vendor-lock.json`. Reproduction instructions are below.

## Inventory

| File | Version | Upstream | License | Purpose |
|------|---------|----------|---------|---------|
| `defuddle.js` | 0.19.4 | https://github.com/kepano/defuddle | MIT | Extracts main article content from arbitrary web pages so AI tag/summary requests can send clean text instead of full HTML. Injected via `chrome.scripting.executeScript` into the active tab on user action only. |
| `turndown.js` | 7.2.5 | https://github.com/mixmark-io/turndown | MIT | Converts captured HTML to canonical Markdown. Loaded in `md-preview.html` and lazily in the popup when conversion is needed. |
| `marked.min.js` | 18.2.1 | https://github.com/markedjs/marked | MIT | Converts canonical Markdown to HTML for the preview render (then sanitized by DOMPurify). Loaded only inside `md-preview.html`. Vendored from the npm UMD build (`lib/marked.umd.js`) under the historical `.min.js` name. |
| `purify.min.js` | 3.4.18 | https://github.com/cure53/DOMPurify | Apache-2.0 / MPL-2.0 | The single sanitize point: cleans all HTML before it enters the preview DOM (both `marked` output and arbitrary web-page Markdown). Loaded only inside `md-preview.html`. Official unminified UMD (`dist/purify.js`) under the historical `.min.js` name; see the performance review below. |
| `highlight.min.js`, `hljs-github*.min.css` | 11.12.0 | https://github.com/highlightjs/highlight.js | BSD-3-Clause | Syntax-highlights fenced/auto-detected code blocks in the Markdown preview. Loaded only inside `md-preview.html`. |
| `katex/` | 0.19.1 | https://github.com/KaTeX/KaTeX | MIT | Renders LaTeX math (`$...$` / `$$...$$`) in the Markdown preview. Lazy-loaded in `md-preview.html` only for content flagged math-bearing (e.g. arXiv abstracts) — never on other pages, so currency `$` is never touched. woff2 fonts only (Chrome supports woff2). |
| `mermaid.min.js` | 12.3.0 | https://github.com/mermaid-js/mermaid | MIT | Renders Mermaid diagram code fences to inline SVG in the Markdown preview. Lazy-loaded by `md-mermaid.js` only when Mermaid-flagged content is present. Official npm single-file IIFE build, byte-identical to jsDelivr. |

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
npm pack turndown@7.2.5
tar -xzf turndown-7.2.5.tgz package/lib/turndown.browser.umd.js
tail -n +2 vendor/turndown.js | diff package/lib/turndown.browser.umd.js -
```

### `marked.min.js`
```bash
npm pack marked@18.2.1
tar -xzf marked-18.2.1.tgz package/lib/marked.umd.js
diff package/lib/marked.umd.js vendor/marked.min.js   # UMD build, vendored under the .min.js name
```

### `purify.min.js`
```bash
npm pack dompurify@3.4.18
tar -xzf dompurify-3.4.18.tgz package/dist/purify.js
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
npm pack katex@0.19.1
tar -xzf katex-0.19.1.tgz
# vendor/katex/ = package/dist/{katex.min.js, katex.min.css, contrib/auto-render.min.js, fonts/*.woff2}
# (auto-render.min.js flattened out of contrib/; .woff/.ttf fonts dropped — Chrome uses woff2)
diff package/dist/katex.min.js vendor/katex/katex.min.js
diff package/dist/katex.min.css vendor/katex/katex.min.css
diff package/dist/contrib/auto-render.min.js vendor/katex/auto-render.min.js
diff -r --exclude='*.woff' --exclude='*.ttf' package/dist/fonts vendor/katex/fonts
```

### `mermaid.min.js`
```bash
npm pack mermaid@12.3.0
tar -xzf mermaid-12.3.0.tgz package/dist/mermaid.min.js
diff package/dist/mermaid.min.js vendor/mermaid.min.js
# Optional cross-check against the CDN's copy of the same published file:
curl -fsSL https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js | diff - vendor/mermaid.min.js
```
The npm package includes this single-file IIFE build. It requires no remote chunks or runtime npm installation.

## Update Policy

Vendor files are pinned to reviewed official stable releases. When refreshing, check all seven packages against the registry's `latest`, review upstream changes, then validate compatibility before updating the lock and committing. `scripts/update-vendor.sh` refreshes **`turndown.js`, `marked.min.js`, `purify.min.js`, `mermaid.min.js`, and `highlight.min.js` (+ its github theme CSS)** from `registry.npmjs.org` (and cdnjs for the highlight.js browser bundle), enforces a default 3-day (`UPDATE_MIN_AGE_DAYS=3`) minimum release age against `time[version]`, stages downloads atomically after verifying the registry SHA-1 (`dist.shasum`), and skips pinned `defuddle.js` unless `--include-pinned` is explicitly passed. That direct HTTP path bypasses local npm wrappers (such as Aikido safe-chain's ~7-day cutoff) while still holding freshly-published releases for 72 hours. `katex/` is refreshed manually (multi-file dist + woff2 fonts) per the Reproduction steps above. Note: a `marked` major bump requires reviewing the custom renderers and source-range mappers in `md-convert.js` and `md-ask.js`.

## Compatibility Review (2026-11-22)

Six of the seven vendored libraries match reviewed upstream stable releases (`defuddle.js` remains intentionally pinned at `0.19.4`; see below). All 11 locked artifacts and all 20 woff2 fonts were verified byte-for-byte against published tarballs.

- [Turndown 7.2.5](https://github.com/mixmark-io/turndown/releases/tag/v7.2.5) strips line breaks inside link destinations while leaving custom highlight, complex-table, math, and media rules untouched.
- [marked 18.2.1](https://github.com/markedjs/marked/releases/tag/v18.2.1) aligns CommonMark 0.31.2 edge cases (`TextRenderer.image` recursive inline rendering, tab-indented blockquote markers, Setext autolink headings). `md-convert.js` and `md-ask.js` were updated in lockstep for nested-image `pbpMark` flattening, container tab-stop source mapping, and Setext `buildToc` slug parity.
- [DOMPurify 3.4.18](https://github.com/cure53/DOMPurify/releases/tag/3.4.18) updates attribute and namespace sanitization hardening while preserving the extension's single sanitize point, hooks, and reject-by-default class/id policy. Re-measured in Chromium on a 734,604-byte / 3,601-block Chinese HTML article: the official unminified `dist/purify.js` sanitized in 62.9–74.9 ms (faster than 3.4.16's 75.1–87.1 ms), whereas minified `dist/purify.min.js` took 162.5–198.5 ms. The extension continues to ship verbatim `dist/purify.js` under `vendor/purify.min.js`.
- [KaTeX 0.19.1](https://github.com/KaTeX/KaTeX/releases/tag/v0.19.1) refreshes math rendering and `katex.min.css`; `auto-render.min.js` and all 20 `.woff2` fonts remain byte-identical to 0.19.0.
- [Mermaid 12.3.0](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.3.0) updates diagram parsers and layout fixes while keeping `md-mermaid.js`'s explicit `securityLevel: "strict"`, `layout: "dagre"`, `look: "classic"`, and post-render DOMPurify SVG sanitization intact under MV3 CSP (`script-src 'self'; object-src 'none'`).

`scripts/update-vendor.sh --check-only` is a separate, read-only mode: it diffs every `vendor-lock.json` version (all 7 packages, including `katex` and `mermaid` which the refresh above doesn't fetch from npm) against `registry.npmjs.org` `latest`, plus a liveness check of the OpenRouter default model against its free `/api/v1/models` catalog, and exits non-zero if anything is behind or dead. It downloads and writes nothing, and is deliberately not wired into `verify.sh` / pre-commit / `release.sh` — run it by hand when you want a signal the world moved.

## Defuddle 0.19.5–0.19.13 - evaluated 2026-10-29 & re-checked 2026-11-22, deferred

`defuddle.js` stays at 0.19.4. `update-vendor.sh --check-only` will keep reporting it as behind; default `update-vendor.sh` refreshes skip `defuddle` unless `--include-pinned` is passed, which is intentional until the bar below is met. Re-testing `0.19.13` (published 2026-11-20 after six rapid `0.19.8`–`0.19.13` releases in 48 hours) against `tests/md-convert-tests.html` still fails 12 of 22 lazy-image assertions (`data-echo`/`actualsrc`/`lazyload`, extensionless and non-URL `data-src`, `data-original` on non-lazy `<img>`, `lazy-placeholder.png`, and `data:`/`loading.gif` + `data-url`).

- **Upstream changes.** 0.19.5 rewrites lazy-image handling: `data-src` / `data-original` now override the real `src` unconditionally (extensionless variants and non-image values included), and image URLs are no longer guessed from arbitrary attributes, so obscure loader attributes (`data-echo`, `actualsrc`, `lazyload`, `url`, ...) are lost. Screen-reader-only text is kept (Wikipedia fractions, NHS headings), which changes article text, re-anchors highlights and misses the AI cache. Parsing retries more and no longer throws, so the bare `"Defuddle"` console.error form (already present in 0.19.4) fires more often. 0.19.6 strips XHTML iframe `data:` content and touches YouTube / Markdown-only paths. Result fields are unchanged: still content HTML, no `textContent`.
- **Why deferred.** Two compat-patch rounds in `site-rules.js` each introduced new regressions found by adversarial probes. Approximating 0.19.4's semantics with word lists of attributes and placeholder names does not converge, and the benefit of 0.19.5/0.19.6 for this extension is small.
- **Bar for the next attempt.** A differential run of old vs new on the archived corpus plus adversarial probes must show no image or content outcome worse than 0.19.4.
- **Suggested approach.** Wait for an upstream fix (consider filing an issue with the minimal repros), or port 0.19.4's lazy-image routine verbatim as a pre-hook on the cloned document and strip the lazy attributes so the newer rules have nothing to act on, which gives parity by construction.
- **Evidence.** Harness, corpus and probes are local only (gitignored) in `docs/superpowers/research/2026-10-29-defuddle-0.19.6/`. The 0.19.6 vendored `defuddle.js` (with banner) had sha256 `415a0ae4d8b6638fca02352e7c033ece7ef983d074298417b9bea02011741e37`.
- **Kept from the attempt.** The `/^Defuddle(?::|$)/` console filter, the caller-derived `result.*` field lock in `tests/ai-tags-tests.html`, and the lazy-image outcome rows in `tests/md-convert-tests.html` (green on 0.19.4) are the regression net for the next upgrade.

## Why Bundled Instead of npm-installed

This extension has no build step (vanilla JS, no bundler). Chrome Web Store policy forbids loading scripts from a remote origin at runtime, so the dependencies must be on disk inside the package. Inlining via `<script src="vendor/...">` is the simplest compliant pattern.
