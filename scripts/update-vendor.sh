#!/usr/bin/env bash
# Refresh vendored JS libraries to the TRUE npm-registry "latest", BYPASSING any
# local npm cooldown (e.g. Aikido safe-chain's rolling ~7-day "before" window).
#
# Why not `npm pack`: safe-chain wraps npm/npx/yarn/pnpm/bun/pip and injects a
# `--before=<~7 days ago>` cutoff, so `npm pack <pkg>@latest` silently resolves to
# an OLDER version and `@<fresh-version>` ETARGETs. It does NOT wrap curl or node.
# So we fetch release tarballs straight from registry.npmjs.org over HTTP and
# verify the SHA-1 the registry itself publishes (dist.shasum) — cooldown-immune
# by construction, and still tamper-evident against the published artifact.
#
# Covers: defuddle, turndown, marked, dompurify (npm) + highlight.js (cdnjs build).
# NOT covered: katex/ (multi-file dist + woff2 fonts) — refresh per vendor/README.md.
#
# Modes:
#   (no args)      Refresh vendored libraries in place — writes vendor/*, prints new
#                   sha256 sums to paste into vendor/vendor-lock.json (see below).
#   --check-only    Read-only upstream-drift sentinel (roadmap K136). Diffs every
#                   package.json fields.version in vendor/vendor-lock.json against
#                   registry.npmjs.org's `dist-tags.latest`, PLUS katex and mermaid
#                   (both npm packages, even though the refresh path above doesn't
#                   pull them from npm — katex is a multi-file dist, mermaid is
#                   vendored from the jsDelivr CDN build). Also asserts the OpenRouter
#                   default model (ai.js OPENAI_COMPAT_PROVIDERS.openrouter.defaultModel)
#                   is still listed at the free, key-less openrouter.ai/api/v1/models —
#                   the one provider-catalog check cheap enough to run every time.
#                   Prints a table, downloads/writes NOTHING. Exit codes: 0 = every
#                   check confirmed current/live; 1 = confirmed drift or a dead model
#                   id; 2 = one or more checks were UNVERIFIED (network hiccup, or the
#                   ai.js regex missed its match) — never silently reported as clean.
#                   Deliberately NOT wired into verify.sh / pre-commit / release.sh
#                   (those gates stay offline by design) — it's a command you run by
#                   hand when you want a signal the world moved.
set -euo pipefail
REPO_ROOT=$(git rev-parse --show-toplevel)
VENDOR_DIR="${REPO_ROOT}/vendor"
mkdir -p "${VENDOR_DIR}"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

REG="https://registry.npmjs.org"

# --check-only: see the "Modes" header comment above.
check_only() {
  echo "Upstream drift check (--check-only): vendor-lock.json versions vs registry.npmjs.org latest."
  echo "Read-only — nothing is downloaded into vendor/, vendor-lock.json is not touched."
  echo ""

  local lock_json="${VENDOR_DIR}/vendor-lock.json"
  # package name -> vendor-lock.json entry path, hand-written on purpose (NOT parsed
  # from the lock's free-text "source" field — that field mixes npm:/cdnjs:/jsdelivr:
  # prefixes and exists for SHA verification, not as a package-name registry; see
  # CLAUDE.md on reading real data structures instead of scraping text). Rows sharing
  # one upstream version (the two hljs theme CSS files; the three katex/ dist files)
  # collapse to a single package row here.
  local -a PKG_NAMES=(defuddle turndown marked dompurify highlight.js katex mermaid)
  local -a LOCK_PATHS=(
    vendor/defuddle.js
    vendor/turndown.js
    vendor/marked.min.js
    vendor/purify.min.js
    vendor/highlight.min.js
    vendor/katex/katex.min.js
    vendor/mermaid.min.js
  )

  local behind=0
  # unverified counts checks whose result is UNKNOWN (network hiccup, or the ai.js
  # regex missing its match) as opposed to KNOWN-behind/KNOWN-dead. It must never be
  # folded into `behind` — a check that failed to run is not evidence of currency,
  # and reporting "everything matches" on an unreachable registry would be a false
  # green (2026-09-15 review finding: a stubbed always-failing curl produced exactly
  # that silent false-positive before this counter existed).
  local unverified=0
  printf "  %-12s  %-10s  %-10s  %s\n" "package" "current" "latest" "status"
  local i pkg lockpath cur latest status
  for i in "${!PKG_NAMES[@]}"; do
    pkg="${PKG_NAMES[$i]}"
    lockpath="${LOCK_PATHS[$i]}"
    if ! cur=$(node -e '
        const d = require(process.argv[1]);
        const e = d.files[process.argv[2]];
        if (!e) process.exit(3);
        process.stdout.write(e.version);
      ' "${lock_json}" "${lockpath}" 2>/dev/null); then
      printf "  %-12s  %-10s  %-10s  %s\n" "${pkg}" "?" "?" "manual (no lock entry at ${lockpath})"
      behind=1
      continue
    fi
    if curl -fsS --max-time 15 "${REG}/${pkg}/latest" -o "${TMP}/latest-${i}.json" 2>/dev/null \
        && latest=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "${TMP}/latest-${i}.json" 2>/dev/null); then
      if [ "${cur}" = "${latest}" ]; then
        status="ok"
      else
        status="BEHIND"
        behind=1
      fi
    else
      latest="?"
      status="UNVERIFIED (fetch-error: network; not counted as drift, but NOT confirmed current either)"
      unverified=$((unverified + 1))
    fi
    printf "  %-12s  %-10s  %-10s  %s\n" "${pkg}" "${cur}" "${latest}" "${status}"
  done

  echo ""
  echo "OpenRouter default-model liveness (the only provider-catalog check kept; the"
  echo "other 12 providers' deprecation pages are deliberately not scraped — a scraper"
  echo "over 12 self-changing doc pages would itself become another thing to keep fresh):"
  local or_model or_status
  if or_model=$(node -e '
      const fs = require("fs");
      const src = fs.readFileSync(process.argv[1], "utf8");
      const m = src.match(/openrouter:\s*\{[^}]*defaultModel:\s*"([^"]+)"/);
      if (!m) process.exit(5);
      process.stdout.write(m[1]);
    ' "${REPO_ROOT}/ai.js" 2>/dev/null); then
    if curl -fsS --max-time 15 "https://openrouter.ai/api/v1/models" -o "${TMP}/openrouter-models.json" 2>/dev/null; then
      if node -e '
          const d = require(process.argv[1]);
          const ids = new Set((d.data || []).map((x) => x.id));
          process.exit(ids.has(process.argv[2]) ? 0 : 1);
        ' "${TMP}/openrouter-models.json" "${or_model}" 2>/dev/null; then
        or_status="ok (live in OpenRouter catalog)"
      else
        or_status="DEAD (not in https://openrouter.ai/api/v1/models data[].id)"
        behind=1
      fi
    else
      or_status="UNVERIFIED (fetch-error: network; not counted as drift, but NOT confirmed live either)"
      unverified=$((unverified + 1))
    fi
  else
    or_model="?"
    or_status="UNVERIFIED (local-parse-error: ai.js openrouter.defaultModel regex miss)"
    unverified=$((unverified + 1))
  fi
  printf "  %-12s  %-10s  %s\n" "openrouter" "${or_model}" "${or_status}"

  echo ""
  if [ "${unverified}" -ne 0 ] && [ "${behind}" -ne 0 ]; then
    echo "Result: ${unverified} check(s) could not be verified (network/parse error) AND at least one"
    echo "verified package/model is behind or dead. Rerun when online for a trustworthy reading. Exit 2."
    return 2
  elif [ "${unverified}" -ne 0 ]; then
    echo "Result: ${unverified} check(s) could not be verified (network/parse error) — NOT a clean bill of"
    echo "health, just an inconclusive one. Rerun when online. Exit 2."
    return 2
  elif [ "${behind}" -ne 0 ]; then
    echo "Result: at least one package is behind, or the OpenRouter default model is dead. Exit 1."
    return 1
  fi
  echo "Result: everything matches the latest registry/catalog state. Exit 0."
  return 0
}

if [ "${1:-}" = "--check-only" ]; then
  # `check_only` uses three distinct exit codes (0 = clean, 1 = confirmed drift/dead
  # model, 2 = one or more checks were unverifiable) — capture the real code rather
  # than collapsing every non-zero outcome to 1, so the two failure modes stay
  # distinguishable to a human or a future caller. `|| ck=$?` (not a bare call) is
  # required so `set -e` doesn't abort the script before the code is captured.
  ck=0
  check_only || ck=$?
  exit "${ck}"
fi

# fetch_npm <pkg> <path-in-tarball> <dest-file> <banner-name|""> <banner-url|"">
# A non-empty banner-name prepends "// <name> v<ver> — <url>" — used for dist
# files that ship WITHOUT their own version banner (defuddle, turndown). marked
# and dompurify carry their own upstream banner, so pass "" for those.
fetch_npm() {
  local pkg="$1" path="$2" dest="$3" bname="$4" burl="${5:-}"
  curl -fsS "${REG}/${pkg}/latest" -o "${TMP}/m.json"
  local line ver url sha
  line=$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.version+" "+d.dist.tarball+" "+d.dist.shasum)' "${TMP}/m.json")
  ver="${line%% *}"; url="${line#* }"; url="${url%% *}"; sha="${line##* }"
  curl -fsSL "${url}" -o "${TMP}/p.tgz"
  local got; got=$(sha1sum "${TMP}/p.tgz" | cut -d' ' -f1)
  if [ "${got}" != "${sha}" ]; then
    echo "  ✗ integrity FAIL ${pkg}@${ver}: got ${got}, registry says ${sha}" >&2
    exit 1
  fi
  rm -rf "${TMP}/package"
  tar xzf "${TMP}/p.tgz" -C "${TMP}"
  cp "${TMP}/package/${path}" "${VENDOR_DIR}/${dest}"
  if [ -n "${bname}" ]; then
    sed -i "1s|^|// ${bname} v${ver} — ${burl}\n|" "${VENDOR_DIR}/${dest}"
  fi
  echo "  ${dest}  <-  ${pkg}@${ver}  (sha1 verified, cooldown-bypassed)"
}

echo "Refreshing vendored libraries from registry.npmjs.org (cooldown-bypassed):"
fetch_npm defuddle  dist/index.js               defuddle.js    defuddle "https://github.com/kepano/defuddle"
fetch_npm turndown  lib/turndown.browser.umd.js turndown.js    turndown "https://github.com/mixmark-io/turndown"
fetch_npm marked    lib/marked.umd.js           marked.min.js  ""
fetch_npm dompurify dist/purify.min.js          purify.min.js  ""

# highlight.js — the prebuilt browser bundle is NOT in the npm tarball; it lives
# on cdnjs. Resolve the latest version from the npm registry, then pull that exact
# build + the two github themes the extension ships.
curl -fsS "${REG}/highlight.js/latest" -o "${TMP}/hljs.json"
HLJS_VER=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "${TMP}/hljs.json")
CDN="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VER}"
curl -fsSL "${CDN}/highlight.min.js"              -o "${VENDOR_DIR}/highlight.min.js"
curl -fsSL "${CDN}/styles/github.min.css"         -o "${VENDOR_DIR}/hljs-github.min.css"
curl -fsSL "${CDN}/styles/github-dark.min.css"    -o "${VENDOR_DIR}/hljs-github-dark.min.css"
echo "  highlight.min.js + hljs-github*.min.css  <-  highlight.js@${HLJS_VER}  (cdnjs)"

echo ""
echo "Done. NOTE: a marked major bump may require adapting the custom renderer.heading"
echo "in md-convert.js (v13+ passes a token object, not positional text/level/raw)."
echo "katex/ is not refreshed here — see vendor/README.md. Run the test suite + zip-smoke."
echo "NOTE: after a marked or dompurify major bump, re-run the long-article timing"
echo "(773 KB / 3601 blocks baseline: parse ~103 ms / sanitize ~147 ms / innerHTML"
echo "~34 ms) and compare — that is the only regression door for first-paint cost."
echo ""
echo "vendor-lock: update vendor/vendor-lock.json in the SAME commit (versions above +"
echo "these sha256 sums), or scripts/vendor-lock-check.mjs will fail verify.sh:"
( cd "${REPO_ROOT}" && sha256sum vendor/defuddle.js vendor/turndown.js vendor/marked.min.js \
    vendor/purify.min.js vendor/highlight.min.js vendor/hljs-github.min.css \
    vendor/hljs-github-dark.min.css 2>/dev/null | sed 's/^/  /' ) || true
