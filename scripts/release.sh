#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    "Usage: scripts/release.sh [options]" \
    "" \
    "Options:" \
    "  --build-only    Build and smoke-test the ZIP without publishing or syncing" \
    "  --overwrite     Replace a local ZIP or release asset only; tags stay immutable" \
    "  --docs-ok       Skip the docs freshness gate" \
    "  --skip-smoke    Skip ZIP install smoke (release-script debugging only)" \
    "  --no-overwrite  Deprecated no-op; immutable-by-default is now enforced" \
    "  -h, --help      Show this help"
}

BUILD_ONLY=0
OVERWRITE=0
DOCS_OK=0
SKIP_SMOKE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only) BUILD_ONLY=1 ;;
    --overwrite) OVERWRITE=1 ;;
    --docs-ok) DOCS_OK=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --no-overwrite)
      echo "  [release] WARN: --no-overwrite is deprecated; releases are immutable by default." >&2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "  [release] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

REPO_ROOT=$(git rev-parse --show-toplevel)
MANIFEST="${REPO_ROOT}/manifest.json"
RELEASE_DIR="${REPO_ROOT}/release"

VERSION=$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['version'])")
TAG="v${VERSION}"
ZIP_NAME="pinboard-bookmark-enhanced-v${VERSION}.zip"
ZIP_PATH="${RELEASE_DIR}/${ZIP_NAME}"

echo "================================================"
echo "  Pinboard Bookmark Enhanced — Release ${TAG}"
echo "================================================"
echo ""
echo "  ZIP : ${ZIP_PATH}"
echo ""

# ---- Step 0: Publish preflight ----
# Build-only deliberately skips this entire networked section.

HEAD_SHA=$(git rev-parse HEAD)
REPO_FULL=""
LOCAL_TAG_EXISTS=0
LOCAL_TAG_SHA=""
REMOTE_TAG_EXISTS=0
REMOTE_TAG_SHA=""
RELEASE_EXISTS=0

remote_tag_commit() {
  local refs
  if ! refs=$(git ls-remote origin "refs/tags/${TAG}" "refs/tags/${TAG}^{}"); then
    return 2
  fi
  if [ -z "${refs}" ]; then
    return 1
  fi
  printf '%s\n' "${refs}" | awk '
    $2 ~ /\^\{\}$/ { peeled = $1 }
    $2 !~ /\^\{\}$/ { direct = $1 }
    END { print peeled ? peeled : direct }
  '
}

if [ "${BUILD_ONLY}" -eq 0 ]; then
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "  ABORT: working tree is not clean (including untracked, non-ignored files)." >&2
    exit 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "  ABORT: gh CLI is required for publication." >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "  ABORT: gh is not authenticated. Run: gh auth login" >&2
    exit 1
  fi

  CURRENT_BRANCH=$(git branch --show-current)
  UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  if [ "${CURRENT_BRANCH}" != "main" ] || [ "${UPSTREAM}" != "origin/main" ]; then
    echo "  ABORT: publication requires main tracking origin/main." >&2
    echo "         current branch: ${CURRENT_BRANCH:-<detached>}; upstream: ${UPSTREAM:-<none>}" >&2
    exit 1
  fi

  if ! REMOTE_MAIN_REFS=$(git ls-remote origin refs/heads/main); then
    echo "  ABORT: could not verify origin/main." >&2
    exit 1
  fi
  REMOTE_MAIN_SHA=$(printf '%s\n' "${REMOTE_MAIN_REFS}" | awk '$2 == "refs/heads/main" { print $1; exit }')
  if [ -z "${REMOTE_MAIN_SHA}" ] || [ "${REMOTE_MAIN_SHA}" != "${HEAD_SHA}" ]; then
    echo "  ABORT: current HEAD is not published at origin/main." >&2
    echo "         HEAD: ${HEAD_SHA}" >&2
    echo "  origin/main: ${REMOTE_MAIN_SHA:-<missing>}" >&2
    exit 1
  fi

  if ! REPO_FULL=$(gh repo view --json nameWithOwner --jq .nameWithOwner); then
    echo "  ABORT: could not resolve the GitHub repository." >&2
    exit 1
  fi

  if git show-ref --verify --quiet "refs/tags/${TAG}"; then
    LOCAL_TAG_EXISTS=1
    LOCAL_TAG_SHA=$(git rev-parse "${TAG}^{commit}")
  fi

  if REMOTE_TAG_SHA=$(remote_tag_commit); then
    REMOTE_TAG_EXISTS=1
  else
    REMOTE_TAG_STATUS=$?
    if [ "${REMOTE_TAG_STATUS}" -eq 2 ]; then
      echo "  ABORT: could not verify remote tag ${TAG}." >&2
      exit 1
    fi
    REMOTE_TAG_SHA=""
  fi

  if RELEASE_STATE=$(gh api "repos/${REPO_FULL}/releases/tags/${TAG}" \
    --jq 'if .draft then "draft" elif .prerelease then "prerelease" else "published" end' 2>&1); then
    RELEASE_EXISTS=1
    if [ "${RELEASE_STATE}" != "published" ]; then
      echo "  ABORT: Release ${TAG} is ${RELEASE_STATE}; draft/prerelease overwrite is not supported." >&2
      exit 1
    fi
  elif ! printf '%s\n' "${RELEASE_STATE}" | grep -q 'HTTP 404'; then
    echo "  ABORT: could not verify GitHub Release ${TAG}." >&2
    printf '%s\n' "${RELEASE_STATE}" >&2
    exit 1
  fi

  if [ "${LOCAL_TAG_EXISTS}" -eq 1 ] || [ "${REMOTE_TAG_EXISTS}" -eq 1 ] || [ "${RELEASE_EXISTS}" -eq 1 ]; then
    if [ "${OVERWRITE}" -eq 0 ]; then
      echo "  ABORT: ${TAG} already exists as a local tag, remote tag, or GitHub Release." >&2
      echo "         Bump the version, or use --overwrite only to replace same-commit assets." >&2
      exit 1
    fi
    if [ "${LOCAL_TAG_EXISTS}" -eq 1 ] && [ "${LOCAL_TAG_SHA}" != "${HEAD_SHA}" ]; then
      echo "  ABORT: local tag ${TAG} points to ${LOCAL_TAG_SHA}, not HEAD ${HEAD_SHA}." >&2
      echo "         Tags are immutable; bump the version." >&2
      exit 1
    fi
    if [ "${REMOTE_TAG_EXISTS}" -eq 1 ] && [ "${REMOTE_TAG_SHA}" != "${HEAD_SHA}" ]; then
      echo "  ABORT: remote tag ${TAG} points to ${REMOTE_TAG_SHA}, not HEAD ${HEAD_SHA}." >&2
      echo "         Tags are immutable; bump the version." >&2
      exit 1
    fi
    if [ "${RELEASE_EXISTS}" -eq 1 ] && [ "${REMOTE_TAG_EXISTS}" -eq 0 ]; then
      echo "  ABORT: Release ${TAG} has no verifiable remote tag." >&2
      echo "         Refusing to overwrite an ambiguous release." >&2
      exit 1
    fi
  fi
fi

# ---- Step 0: Docs freshness gate ----
#
# A release that ships features must not leave user-facing docs behind.
# If the range since the previous tag contains feat commits while README.md,
# CLAUDE.md, and docs/privacy.md are ALL untouched, abort. After verifying
# the docs are genuinely current, re-run with --docs-ok to proceed.
if [ "${BUILD_ONLY}" -eq 1 ]; then
  echo "  --build-only: skipping publication docs gate"
elif [ "${DOCS_OK}" -eq 1 ]; then
  echo "  --docs-ok: skipping docs freshness gate"
else
  # gh release create tags the REMOTE only -- sync local tags first or this
  # gate (and the changelog's PREV_TAG below) would measure from a stale tag.
  if ! git fetch --tags --quiet origin; then
    echo "  ABORT: could not refresh release tags for the docs gate." >&2
    exit 1
  fi
  DOCS_PREV_TAG=$(git tag --sort=-version:refname | grep -v "^${TAG}$" | head -1) || true
  if [ -n "${DOCS_PREV_TAG}" ]; then
    FEAT_COUNT=$(git log "${DOCS_PREV_TAG}..HEAD" --pretty=format:%s --no-merges | grep -c "^feat" || true)
    DOCS_TOUCHED=$(git diff --name-only "${DOCS_PREV_TAG}..HEAD" -- README.md CLAUDE.md docs/privacy.md | wc -l)
    if [ "${FEAT_COUNT}" -gt 0 ] && [ "${DOCS_TOUCHED}" -eq 0 ]; then
      echo "  ABORT: docs freshness gate."
      echo "  ${FEAT_COUNT} feat commit(s) since ${DOCS_PREV_TAG}, but README.md, CLAUDE.md and"
      echo "  docs/privacy.md are all untouched in that range. Update user-facing docs"
      echo "  (README x9 locales / CLAUDE.md / privacy policy for new data flows),"
      echo "  or re-run with --docs-ok if they are genuinely current."
      exit 1
    fi
    echo "  Docs gate OK (${FEAT_COUNT} feat commit(s); docs files touched: ${DOCS_TOUCHED})"
  fi
fi

# Note: README version badge is dynamic (shields.io reads GitHub release tag),
# so no manual sync step is required here.

# ---- Step 1: Build ZIP ----
#
# Auto-scan + exclude pattern (replaces former hardcoded INCLUDE list, which
# silently dropped new extension files added between releases).
#
# Top-level extension files are auto-included by glob pattern (*.html, *.js,
# *.css, manifest.json). Recursive directories vendor/, icons/, _locales/
# are always included. Everything else at root (README, LICENSE, perf data,
# test pages, hidden files/dirs, scripts/, docs/, release/, etc.) is excluded.
#
# A post-build sanity check parses manifest.json + included HTML files to
# extract every <script src> / <link href> / SW / content_script reference,
# then asserts every referenced file is in the ZIP. This catches the bug
# class where a new JS file is added to the codebase but forgotten in the
# release manifest.

mkdir -p "${RELEASE_DIR}"

if [ -f "${ZIP_PATH}" ]; then
  if [ "${OVERWRITE}" -eq 0 ]; then
    echo "  ABORT: local artifact already exists: ${ZIP_PATH}" >&2
    echo "         Use --overwrite to delete and rebuild this ZIP explicitly." >&2
    exit 1
  fi
  echo "  --overwrite: removing existing ${ZIP_NAME}"
  rm -- "${ZIP_PATH}"
fi

cd "${REPO_ROOT}"
python3 - "${ZIP_PATH}" "${VERSION}" <<'PYEOF'
import sys, zipfile, pathlib, fnmatch, re, json

zip_path = sys.argv[1]
version  = sys.argv[2]
prefix   = f"pinboard-bookmark-enhanced-v{version}/"

REPO = pathlib.Path('.')

# Top-level extension files (whitelist by pattern)
TOP_LEVEL_PATTERNS = ['*.html', '*.js', '*.css', 'manifest.json']

# Directories included recursively
INCLUDE_DIRS = ['vendor', 'icons', '_locales']

# Top-level files to exclude even if matching a pattern
EXCLUDE_FILES = set()  # dev test pages now live in tests/ (auto-excluded: not in INCLUDE_DIRS)

# Top-level patterns to exclude
EXCLUDE_PATTERNS = ['perf-baseline.json', 'perf-after-*.json', '.*', '*.md', 'LICENSE']

def included_at_root(name: str) -> bool:
    if name in EXCLUDE_FILES:
        return False
    for pat in EXCLUDE_PATTERNS:
        if fnmatch.fnmatch(name, pat):
            return False
    return any(fnmatch.fnmatch(name, pat) for pat in TOP_LEVEL_PATTERNS)

included = []
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    # Top-level files
    for entry in sorted(REPO.iterdir()):
        if entry.is_file() and included_at_root(entry.name):
            zf.write(entry, prefix + entry.name)
            included.append(entry.name)
    # Recursive directories
    for d in INCLUDE_DIRS:
        p = REPO / d
        if not p.exists():
            print(f"  Warning: dir {d}/ not found, skipping")
            continue
        for f in sorted(p.rglob('*')):
            if f.is_file() and '.DS_Store' not in f.name:
                rel = str(f.relative_to(REPO))
                zf.write(f, prefix + rel)
                included.append(rel)

# Sanity check: every file referenced by manifest + included HTML must be present
referenced = set()
manifest = json.load(open('manifest.json'))
if 'background' in manifest and 'service_worker' in manifest['background']:
    referenced.add(manifest['background']['service_worker'])
for cs in manifest.get('content_scripts', []):
    referenced.update(cs.get('js', []))
    referenced.update(cs.get('css', []))
if 'action' in manifest and 'default_popup' in manifest['action']:
    referenced.add(manifest['action']['default_popup'])
if 'options_page' in manifest:
    referenced.add(manifest['options_page'])

script_re = re.compile(r'<script[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE)
link_re   = re.compile(r'<link[^>]+href=["\']([^"\']+)["\']', re.IGNORECASE)
for html_name in [f for f in included if f.endswith('.html')]:
    text = open(html_name, encoding='utf-8').read()
    for m in script_re.finditer(text):
        ref = m.group(1)
        if not ref.startswith(('http:', 'https:', '//')):
            referenced.add(ref)
    for m in link_re.finditer(text):
        ref = m.group(1)
        if not ref.startswith(('http:', 'https:', '//')):
            referenced.add(ref)

included_set = set(included)
missing = sorted(r for r in referenced if r not in included_set)
if missing:
    print(f"  ERROR: referenced by manifest/HTML but missing from ZIP:", file=sys.stderr)
    for m in missing:
        print(f"    - {m}", file=sys.stderr)
    print(f"  Fix release.sh INCLUDE_DIRS / TOP_LEVEL_PATTERNS / EXCLUDE_* rules.", file=sys.stderr)
    sys.exit(1)

print(f"  ZIP created — {len(included)} files (all manifest + HTML references resolved).")
PYEOF

echo ""

# ---- Step 1.5: ZIP install smoke test ----
# Real Chromium install + SW + popup + options smoke. Catches the bug class
# where ZIP packaging silently dropped a referenced file. Run BEFORE gh
# release create so a broken ZIP never reaches users.
#
# Skip with --skip-smoke (e.g. when iterating on the release script itself).

if [ "${SKIP_SMOKE}" -eq 1 ]; then
  echo "  --skip-smoke: skipping zip-install-smoke test"
else
  echo "  Smoke-testing ZIP..."
  if ! node "${REPO_ROOT}/scripts/zip-install-smoke.mjs" --zip "${ZIP_PATH}"; then
    echo "" >&2
    echo "  [release] ZIP smoke test FAILED — aborting before publish." >&2
    echo "  ZIP retained at: ${ZIP_PATH}" >&2
    echo "  Rerun manually:  node scripts/zip-install-smoke.mjs --zip ${ZIP_PATH}" >&2
    exit 1
  fi
  echo ""
fi

if [ "${BUILD_ONLY}" -eq 1 ]; then
  echo "  Build-only complete: ZIP validated; 未发布、未同步。"
  exit 0
fi

# ---- Step 3: Generate changelog ----

# Try local tags first, then fall back to GitHub release tags
PREV_TAG=""
PREV_TAG=$(git tag --sort=-version:refname | grep -v "^${TAG}$" | head -1) || true

if [ -z "${PREV_TAG}" ]; then
  # No local tags — fetch the latest release tag from GitHub
  PREV_TAG=$(gh release list --repo "${REPO_FULL}" --limit 5 --json tagName --jq '.[].tagName' 2>/dev/null \
    | grep -v "^${TAG}$" | head -1) || true
fi

if [ -n "${PREV_TAG}" ]; then
  echo "  Changelog: ${PREV_TAG}..${TAG}"
else
  echo "  Changelog: last 20 commits (no previous tag found)"
fi

CHANGELOG=$(python3 - "${PREV_TAG}" <<'PYEOF'
import sys, subprocess, re

prev_tag = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else ""

if prev_tag:
    result = subprocess.run(
        ["git", "log", f"{prev_tag}..HEAD", "--pretty=format:%s", "--no-merges"],
        capture_output=True, text=True
    )
    # If the tag doesn't exist locally, fall back to recent commits
    if result.returncode != 0:
        result = subprocess.run(
            ["git", "log", "--pretty=format:%s", "--no-merges", "-20"],
            capture_output=True, text=True
        )
else:
    result = subprocess.run(
        ["git", "log", "--pretty=format:%s", "--no-merges", "-20"],
        capture_output=True, text=True
    )

commits = [line.strip() for line in result.stdout.splitlines() if line.strip()]

# Skip release-infrastructure bookkeeping commits (auto-generated noise)
skip_patterns = [
    re.compile(r'^docs:\s*update version badge'),
    re.compile(r'^chore:\s*sync manifest version'),
]
commits = [c for c in commits if not any(p.match(c) for p in skip_patterns)]

groups = {
    "feat":     {"label": "New Features",   "items": []},
    "fix":      {"label": "Bug Fixes",      "items": []},
    "perf":     {"label": "Performance",    "items": []},
    "style":    {"label": "Styling",        "items": []},
    "refactor": {"label": "Improvements",   "items": []},
    "chore":    {"label": "Maintenance",    "items": []},
    "docs":     {"label": "Documentation",  "items": []},
}
order = ["feat", "fix", "perf", "style", "refactor", "chore", "docs"]

pattern = re.compile(r'^(\w+)(?:\([^)]+\))?!?:\s*(.+)$')

for msg in commits:
    m = pattern.match(msg)
    if not m:
        continue
    ctype, subject = m.group(1).lower(), m.group(2)
    if ctype in groups:
        groups[ctype]["items"].append(subject)

output = []
for key in order:
    items = groups[key]["items"]
    if not items:
        continue
    output.append(f"### {groups[key]['label']}")
    for item in items:
        output.append(f"- {item}")
    output.append("")

if not output:
    output = ["No significant changes."]

print("\n".join(output))
PYEOF
)

echo ""

# ---- Step 4: Publish or update GitHub release ----

NOTES="## What's Changed

${CHANGELOG}
---

### Installation
1. Download \`${ZIP_NAME}\` below
2. Unzip to a local folder
3. Open \`chrome://extensions/\`, enable **Developer mode**
4. Click **Load unpacked**, select the unzipped folder"

if [ "${RELEASE_EXISTS}" -eq 1 ]; then
  echo "  Updating same-commit Release ${TAG} without changing its tag..."
  gh release upload "${TAG}" "${ZIP_PATH}" --clobber --repo "${REPO_FULL}"
  gh release edit "${TAG}" \
    --repo "${REPO_FULL}" \
    --title "${TAG}" \
    --notes "${NOTES}" \
    --latest
elif [ "${REMOTE_TAG_EXISTS}" -eq 1 ]; then
  echo "  Creating Release ${TAG} from the existing verified tag..."
  gh release create "${TAG}" \
    "${ZIP_PATH}" \
    --repo "${REPO_FULL}" \
    --verify-tag \
    --title "${TAG}" \
    --notes "${NOTES}" \
    --latest
else
  gh release create "${TAG}" \
    "${ZIP_PATH}" \
    --repo "${REPO_FULL}" \
    --target "${HEAD_SHA}" \
    --title "${TAG}" \
    --notes "${NOTES}" \
    --latest
fi

if ! PUBLISHED_TAG_SHA=$(remote_tag_commit); then
  echo "  ABORT: release command completed, but remote tag ${TAG} could not be verified." >&2
  exit 1
fi
if [ "${PUBLISHED_TAG_SHA}" != "${HEAD_SHA}" ]; then
  echo "  ABORT: published tag ${TAG} resolves to ${PUBLISHED_TAG_SHA}, expected ${HEAD_SHA}." >&2
  echo "         Runtime sync was not performed." >&2
  exit 1
fi

echo ""
echo "  Release published: ${TAG}"
echo "  https://github.com/${REPO_FULL}/releases/tag/${TAG}"
echo "  Remote tag verified: ${PUBLISHED_TAG_SHA}"
echo ""

# ---- Step 5: Mirror the verified public release into the local runtime ----

if [ -f "${REPO_ROOT}/scripts/sync-runtime.sh" ]; then
  echo "  Syncing verified release to local extension folder..."
  bash "${REPO_ROOT}/scripts/sync-runtime.sh" --zip "${ZIP_PATH}" \
    || echo "  [release] WARN: runtime sync failed (public release remains valid)"
  echo ""
fi

# ---- Step 6: Purge GitHub camo cache so README shields.io badge updates immediately ----
README_URL="https://github.com/${REPO_FULL}"
if README_HTML=$(curl -fsSL "${README_URL}"); then
  CAMO_URL=$(printf '%s\n' "${README_HTML}" \
    | grep -oE 'https://camo\.githubusercontent\.com/[^"]*' \
    | grep -E 'release%2F|release/' \
    | head -1 || true)
  if [ -z "${CAMO_URL}" ]; then
    echo "  (no camo URL detected for version badge — skipping purge)"
  elif STATUS=$(curl -sS -X PURGE -o /dev/null -w "%{http_code}" "${CAMO_URL}"); then
    case "${STATUS}" in
      2??) echo "  Camo cache PURGE → HTTP ${STATUS} (badge refreshes within seconds)" ;;
      *) echo "  [release] WARN: camo PURGE returned HTTP ${STATUS}; release remains published." >&2 ;;
    esac
  else
    echo "  [release] WARN: camo PURGE request failed; release remains published." >&2
  fi
else
  echo "  [release] WARN: could not read GitHub README for camo lookup; skipping purge." >&2
fi
