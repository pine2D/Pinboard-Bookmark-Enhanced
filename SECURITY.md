# Security Policy

## Supported versions

Bookmark Enhanced ships cumulative updates on `main` through the Chrome Web Store and GitHub Releases. Security fixes land on the latest `3.x` release only.

| Version | Supported |
|---------|-----------|
| Latest `3.x` release | Yes |
| Older `3.x` and `2.x` releases | No (upgrade to the latest release) |

## Reporting a vulnerability

Do not report security vulnerabilities in public GitHub issues or pull requests.

Use [GitHub Private Vulnerability Reporting](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/security/advisories/new) to submit a private advisory directly to the maintainer. Include:

1. Affected extension version (`manifest.json` or **Settings > Backup & Diagnostics > Support Diagnostics**).
2. Browser name and version.
3. Minimal reproduction steps or proof-of-concept HTML/payload (redact any personal tokens, API keys, or private URLs).
4. Which security boundary is affected (for example, account isolation, host-permission enforcement, Content Security Policy, DOM sanitization in reader/highlights, credential storage routing, or backup secret stripping).

You can expect an acknowledgment within 7 days and status updates as a fix and regression test are prepared.

## Security model scope

Bookmark Enhanced runs locally in your browser with bring-your-own API keys and has no developer-operated backend servers:

- **In scope**: XSS or HTML/SVG sanitizer bypasses in `md-preview.html`, `library.html`, `popup.html`, `options.html`, or content scripts; unauthorized network requests outside granted host permissions; cross-account data leakage during account or service switches; unintended credential exposure in `chrome.storage.sync`, `chrome.runtime` messages, offline queues, restore points, or unopted backups; insecure HTTP communication to non-loopback hosts.
- **Out of scope**: Compromised local OS user accounts or malicious extensions sharing the same browser profile; rate limits or service outages on third-party providers (Pinboard, Karakeep, linkding, AI providers, Google Drive, Jina, Wayback); self-XSS requiring the user to paste attacker-supplied CSS or JavaScript into developer tools.
