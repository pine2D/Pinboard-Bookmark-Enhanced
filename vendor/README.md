# Third-Party Libraries

This directory contains third-party JavaScript libraries bundled with the extension. They are shipped verbatim from their published distributions to comply with the Chrome Web Store's "no remote code" policy (extensions cannot fetch executable code at runtime).

For Chrome Web Store reviewers: every file in this directory is unmodified upstream output. The first line of each file records the version and upstream URL. Reproduction instructions are below.

## Inventory

| File | Version | Upstream | License | Purpose |
|------|---------|----------|---------|---------|
| `defuddle.js` | 0.18.1 | https://github.com/kepano/defuddle | MIT | Extracts main article content from arbitrary web pages so AI tag/summary requests can send clean text instead of full HTML. Injected via `chrome.scripting.executeScript` into the active tab on user action only. |
| `turndown.js` | 7.2.4 | https://github.com/mixmark-io/turndown | MIT | Converts captured HTML to Markdown for the in-extension preview tab. Loaded only inside `md-preview.html`. |

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

## Update Policy

Vendor files are pinned to specific versions and updated only when needed (security fix, breaking compatibility). Run `scripts/update-vendor.sh` to refresh; the script downloads the upstream artifact and verifies the version banner before committing.

## Why Bundled Instead of npm-installed

This extension has no build step (vanilla JS, no bundler). Chrome Web Store policy forbids loading scripts from a remote origin at runtime, so the dependencies must be on disk inside the package. Inlining via `<script src="vendor/...">` is the simplest compliant pattern.
