#!/usr/bin/env bash
# Refresh vendored JS libraries from registry.npmjs.org (and cdnjs for the
# prebuilt highlight.js browser bundle), bypassing local npm wrapper cutoffs
# while enforcing a 3-day release age gate (`UPDATE_MIN_AGE_DAYS`, default 3).
#
# Why not `npm pack`: safe-chain wraps npm/npx/yarn/pnpm/bun/pip and injects a
# rolling `--before` cutoff without per-package visibility. Fetching packuments
# directly from registry.npmjs.org lets us verify `dist.shasum` (SHA-1) AND
# evaluate `time[version]` explicitly against `UPDATE_MIN_AGE_DAYS=3` (72h).
#
# Covers: turndown, marked, dompurify, mermaid, highlight.js (+ defuddle when
# `--include-pinned` is explicitly passed).
# NOT covered automatically: katex/ (multi-file dist + 20 woff2 fonts) — refresh
# per vendor/README.md.
#
# Modes:
#   (no args)                 Refresh non-pinned vendored libraries aged >= 3d.
#   [--include-pinned] [pkg…] Refresh only the named package(s); `--include-pinned`
#                             unlocks `defuddle` (pinned at 0.19.4 pending lazy-image
#                             corpus parity — see vendor/README.md).
#   --check-only              Read-only upstream-drift sentinel (roadmap K136).
#                             Diffs vendor/vendor-lock.json against npm `latest`
#                             across all 7 packages + checks OpenRouter defaultModel
#                             liveness. Downloads/writes NOTHING.
#                             Exit codes: 0 = current/live; 1 = drift/dead model;
#                             2 = one or more checks UNVERIFIED (network/parse).
#   --help | -h               Print usage and exit 0.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/update-vendor.sh --check-only
  scripts/update-vendor.sh [--include-pinned] [turndown|marked|dompurify|mermaid|highlight.js|defuddle ...]

Environment:
  UPDATE_MIN_AGE_DAYS   Minimum upstream release age in days before adopting a new
                        version in write mode (default: 3; set 0 only with explicit
                        review sign-off).
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
VENDOR_DIR="${REPO_ROOT}/vendor"
LOCK_JSON="${VENDOR_DIR}/vendor-lock.json"
REG="https://registry.npmjs.org"
MIN_AGE_DAYS="${UPDATE_MIN_AGE_DAYS:-3}"

if ! [[ "${MIN_AGE_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "[update-vendor] invalid UPDATE_MIN_AGE_DAYS='${MIN_AGE_DAYS}' (expected non-negative integer)" >&2
  exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

# --check-only: see the "Modes" header comment above.
check_only() {
  echo "Upstream drift check (--check-only): vendor-lock.json versions vs registry.npmjs.org latest."
  echo "Read-only — nothing is downloaded into vendor/, vendor-lock.json is not touched."
  echo ""

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
      ' "${LOCK_JSON}" "${lockpath}" 2>/dev/null); then
      printf "  %-12s  %-10s  %-10s  %s\n" "${pkg}" "?" "?" "manual (no lock entry at ${lockpath})"
      behind=1
      continue
    fi
    if curl -fsS --max-time 15 "${REG}/${pkg}/latest" -o "${TMP}/latest-${i}.json" 2>/dev/null \
        && latest=$(node -e '
          const d = require(process.argv[1]);
          if (!d || typeof d.version !== "string" || !d.version) process.exit(4);
          process.stdout.write(d.version);
        ' "${TMP}/latest-${i}.json" 2>/dev/null); then
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
  local or_model or_status or_rc
  if or_model=$(node -e '
      const fs = require("fs");
      const src = fs.readFileSync(process.argv[1], "utf8");
      const m = src.match(/openrouter:\s*\{[^}]*defaultModel:\s*"([^"]+)"/);
      if (!m) process.exit(5);
      process.stdout.write(m[1]);
    ' "${REPO_ROOT}/ai.js" 2>/dev/null); then
    if curl -fsS --max-time 15 "https://openrouter.ai/api/v1/models" -o "${TMP}/openrouter-models.json" 2>/dev/null; then
      or_rc=0
      node -e '
        const fs = require("fs");
        let d;
        try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (_) { process.exit(2); }
        if (!d || !Array.isArray(d.data)) process.exit(2);
        const ids = new Set(d.data.map((x) => x && x.id).filter(Boolean));
        process.exit(ids.has(process.argv[2]) ? 0 : 1);
      ' "${TMP}/openrouter-models.json" "${or_model}" 2>/dev/null || or_rc=$?
      if [ "${or_rc}" -eq 0 ]; then
        or_status="ok (live in OpenRouter catalog)"
      elif [ "${or_rc}" -eq 1 ]; then
        or_status="DEAD (not in https://openrouter.ai/api/v1/models data[].id)"
        behind=1
      else
        or_status="UNVERIFIED (parse-error: https://openrouter.ai/api/v1/models did not return data[])"
        unverified=$((unverified + 1))
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
  if [ "$#" -gt 1 ]; then
    echo "[update-vendor] --check-only does not take additional arguments" >&2
    exit 2
  fi
  ck=0
  check_only || ck=$?
  exit "${ck}"
fi

INCLUDE_PINNED=0
declare -a SELECTED=()
for arg in "$@"; do
  case "${arg}" in
    --include-pinned)
      INCLUDE_PINNED=1
      ;;
    --*)
      echo "[update-vendor] unknown option: ${arg}" >&2
      usage >&2
      exit 2
      ;;
    defuddle|turndown|marked|dompurify|mermaid|highlight.js)
      SELECTED+=("${arg}")
      ;;
    katex)
      echo "[update-vendor] katex/ is a multi-file + 20-woff2 bundle; refresh manually per vendor/README.md" >&2
      exit 2
      ;;
    *)
      echo "[update-vendor] unknown package: ${arg}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "${#SELECTED[@]}" -gt 0 ]; then
  for p in "${SELECTED[@]}"; do
    if [ "${p}" = "defuddle" ] && [ "${INCLUDE_PINNED}" -ne 1 ]; then
      echo "[update-vendor] defuddle is pinned at 0.19.4 (see vendor/README.md); pass --include-pinned only after lazy-image corpus verification" >&2
      exit 2
    fi
  done
else
  if [ "${INCLUDE_PINNED}" -eq 1 ]; then
    SELECTED=(defuddle turndown marked dompurify mermaid highlight.js)
  else
    SELECTED=(turndown marked dompurify mermaid highlight.js)
  fi
fi

wants_pkg() {
  local needle="$1" p
  for p in "${SELECTED[@]}"; do
    [ "${p}" = "${needle}" ] && return 0
  done
  return 1
}

mkdir -p "${VENDOR_DIR}" "${TMP}/staged"

# Resolve latest version, tarball, shasum, and age check from full packument.
# Prints tab-separated: status \t cur \t latest \t tarball \t shasum \t ageDays
resolve_release() {
  local pkg="$1" lockpath="$2" meta_json="$3"
  curl -fsS --max-time 20 "${REG}/${pkg}" -o "${meta_json}"
  node -e '
    const fs = require("fs");
    const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const cur = (lock.files && lock.files[process.argv[2]] && lock.files[process.argv[2]].version) || "";
    const meta = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const minDays = Number(process.argv[4]);
    const ver = meta && meta["dist-tags"] && meta["dist-tags"].latest;
    const entry = ver && meta.versions && meta.versions[ver];
    const published = ver && meta.time && meta.time[ver];
    if (!ver || !entry || !entry.dist || !entry.dist.tarball || !entry.dist.shasum || !published) {
      process.exit(4);
    }
    const ageDays = (Date.now() - Date.parse(published)) / 86400000;
    if (!Number.isFinite(ageDays)) process.exit(4);
    let state = "update";
    if (cur === ver) state = "current";
    else if (ageDays < minDays) state = "too-new";
    process.stdout.write([state, cur || "?", ver, entry.dist.tarball, entry.dist.shasum, ageDays.toFixed(1)].join("\t"));
  ' "${LOCK_JSON}" "${lockpath}" "${meta_json}" "${MIN_AGE_DAYS}"
}

# fetch_npm <pkg> <lock-path> <path-in-tarball> <dest-file> <banner-name|""> <banner-url|"">
fetch_npm() {
  local pkg="$1" lockpath="$2" path="$3" dest="$4" bname="$5" burl="${6:-}"
  local info state cur ver url sha age
  info=$(resolve_release "${pkg}" "${lockpath}" "${TMP}/meta-${pkg}.json")
  IFS=$'\t' read -r state cur ver url sha age <<< "${info}"
  if [ "${state}" = "current" ]; then
    echo "  ${dest}  up-to-date (${pkg}@${ver})"
    return 0
  fi
  if [ "${state}" = "too-new" ]; then
    echo "  ${dest}  held at ${cur} (${pkg}@${ver} is ${age}d old < UPDATE_MIN_AGE_DAYS=${MIN_AGE_DAYS})"
    return 0
  fi
  curl -fsSL --max-time 60 "${url}" -o "${TMP}/p.tgz"
  local got
  got=$(sha1sum "${TMP}/p.tgz" | cut -d' ' -f1)
  if [ "${got}" != "${sha}" ]; then
    echo "  ✗ integrity FAIL ${pkg}@${ver}: got ${got}, registry says ${sha}" >&2
    exit 1
  fi
  rm -rf "${TMP}/package"
  tar xzf "${TMP}/p.tgz" -C "${TMP}"
  local staged="${TMP}/staged/${dest}"
  mkdir -p "$(dirname "${staged}")"
  if [ -n "${bname}" ]; then
    {
      printf '// %s v%s — %s\n' "${bname}" "${ver}" "${burl}"
      cat "${TMP}/package/${path}"
    } > "${staged}"
  else
    cp "${TMP}/package/${path}" "${staged}"
  fi
  mv "${staged}" "${VENDOR_DIR}/${dest}"
  echo "  ${dest}  <-  ${pkg}@${ver}  (sha1 verified, age ${age}d >= ${MIN_AGE_DAYS}d)"
}

echo "Refreshing vendored libraries from registry.npmjs.org (UPDATE_MIN_AGE_DAYS=${MIN_AGE_DAYS}):"
if wants_pkg defuddle; then
  fetch_npm defuddle "vendor/defuddle.js" dist/index.js defuddle.js defuddle "https://github.com/kepano/defuddle"
elif [ "$#" -eq 0 ]; then
  echo "  defuddle.js  skipped (pinned at 0.19.4; pass --include-pinned after corpus review)"
fi
wants_pkg turndown && fetch_npm turndown  "vendor/turndown.js"    lib/turndown.browser.umd.js turndown.js    turndown "https://github.com/mixmark-io/turndown"
wants_pkg marked   && fetch_npm marked    "vendor/marked.min.js"  lib/marked.umd.js           marked.min.js  ""
# Keep the official unminified UMD under the historical filename: DOMPurify's
# minified distribution roughly doubles long-article sanitize time in Chromium,
# while dist/purify.js keeps identical API/security behavior at ~2.5x lower cost.
wants_pkg dompurify && fetch_npm dompurify "vendor/purify.min.js" dist/purify.js              purify.min.js  ""
wants_pkg mermaid   && fetch_npm mermaid   "vendor/mermaid.min.js" dist/mermaid.min.js        mermaid.min.js ""

if wants_pkg "highlight.js"; then
  hljs_info=$(resolve_release "highlight.js" "vendor/highlight.min.js" "${TMP}/meta-hljs.json")
  IFS=$'\t' read -r hljs_state hljs_cur HLJS_VER _ _ hljs_age <<< "${hljs_info}"
  if [ "${hljs_state}" = "current" ]; then
    echo "  highlight.min.js + hljs-github*.min.css  up-to-date (highlight.js@${HLJS_VER})"
  elif [ "${hljs_state}" = "too-new" ]; then
    echo "  highlight.min.js + hljs-github*.min.css  held at ${hljs_cur} (highlight.js@${HLJS_VER} is ${hljs_age}d old < UPDATE_MIN_AGE_DAYS=${MIN_AGE_DAYS})"
  else
    CDN="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VER}"
    curl -fsSL --max-time 30 "${CDN}/highlight.min.js"           -o "${TMP}/staged/highlight.min.js"
    curl -fsSL --max-time 30 "${CDN}/styles/github.min.css"      -o "${TMP}/staged/hljs-github.min.css"
    curl -fsSL --max-time 30 "${CDN}/styles/github-dark.min.css" -o "${TMP}/staged/hljs-github-dark.min.css"
    for f in highlight.min.js hljs-github.min.css hljs-github-dark.min.css; do
      if [ ! -s "${TMP}/staged/${f}" ]; then
        echo "  ✗ empty download from cdnjs for ${f}" >&2
        exit 1
      fi
    done
    for f in highlight.min.js hljs-github.min.css hljs-github-dark.min.css; do
      mv "${TMP}/staged/${f}" "${VENDOR_DIR}/${f}"
    done
    echo "  highlight.min.js + hljs-github*.min.css  <-  highlight.js@${HLJS_VER}  (cdnjs, age ${hljs_age}d >= ${MIN_AGE_DAYS}d)"
  fi
fi

echo ""
echo "Done. katex/ is refreshed manually per vendor/README.md. Run the test suite + zip-smoke."
echo "vendor-lock: update vendor/vendor-lock.json in the SAME commit (versions + sha256 sums):"
( cd "${REPO_ROOT}" && sha256sum vendor/defuddle.js vendor/turndown.js vendor/marked.min.js \
    vendor/purify.min.js vendor/highlight.min.js vendor/hljs-github.min.css \
    vendor/hljs-github-dark.min.css vendor/mermaid.min.js 2>/dev/null | sed 's/^/  /' ) || true
