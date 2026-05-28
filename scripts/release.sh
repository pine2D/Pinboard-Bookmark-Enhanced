#!/usr/bin/env bash
set -euo pipefail

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
  echo "  Removing existing ${ZIP_NAME}"
  rm "${ZIP_PATH}"
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
EXCLUDE_FILES = {'url-strip-tests.html'}

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

if [[ " $* " == *" --skip-smoke "* ]]; then
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

# ---- Step 2: Check gh CLI ----

if ! command -v gh &>/dev/null; then
  echo "  gh CLI not found. ZIP is ready at:"
  echo "    ${ZIP_PATH}"
  echo ""
  echo "  Install gh: https://cli.github.com"
  exit 0
fi

if ! gh auth status &>/dev/null; then
  echo "  gh not authenticated. ZIP is ready at:"
  echo "    ${ZIP_PATH}"
  echo ""
  echo "  Run: gh auth login"
  exit 0
fi

# ---- Step 3: Generate changelog ----

# Try local tags first, then fall back to GitHub release tags
PREV_TAG=""
PREV_TAG=$(git tag --sort=-version:refname | grep -v "^${TAG}$" | head -1) || true

if [ -z "${PREV_TAG}" ]; then
  # No local tags — fetch the latest release tag from GitHub
  PREV_TAG=$(gh release list --limit 5 --json tagName --jq '.[].tagName' 2>/dev/null \
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

# ---- Step 4: Handle existing release ----

if gh release view "${TAG}" &>/dev/null; then
  echo "  Release ${TAG} already exists."
  # Non-interactive: auto-overwrite. Use --no-overwrite flag to prevent.
  if [ "${1:-}" = "--no-overwrite" ]; then
    echo "  --no-overwrite specified. Aborted."
    exit 0
  fi
  # Interactive terminal: ask for confirmation
  if [ -t 0 ]; then
    read -r -p "  Overwrite? (y/N) " CONFIRM
    if [ "${CONFIRM}" != "y" ] && [ "${CONFIRM}" != "Y" ]; then
      echo "  Aborted."
      exit 0
    fi
  else
    echo "  Non-interactive mode: overwriting."
  fi
  gh release delete "${TAG}" --yes --cleanup-tag
  echo "  Old release deleted."
fi

# ---- Step 5: Create GitHub release ----

NOTES="## What's Changed

${CHANGELOG}
---

### Installation
1. Download \`${ZIP_NAME}\` below
2. Unzip to a local folder
3. Open \`chrome://extensions/\`, enable **Developer mode**
4. Click **Load unpacked**, select the unzipped folder"

gh release create "${TAG}" \
  "${ZIP_PATH}" \
  --title "${TAG}" \
  --notes "${NOTES}" \
  --latest

echo ""
echo "  Release published: ${TAG}"
echo "  https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${TAG}"
echo ""

# ---- Step 4: Purge GitHub camo cache so README shields.io badge updates immediately ----
REPO_FULL=$(gh repo view --json nameWithOwner -q .nameWithOwner)
README_URL="https://github.com/${REPO_FULL}"
CAMO_URL=$(curl -sL "${README_URL}" | grep -oE 'https://camo\.githubusercontent\.com/[^"]*' \
  | grep -E 'release%2F|release/' | head -1)
if [ -n "${CAMO_URL}" ]; then
  STATUS=$(curl -s -X PURGE -o /dev/null -w "%{http_code}" "${CAMO_URL}")
  echo "  Camo cache PURGE → HTTP ${STATUS} (badge refreshes within seconds)"
else
  echo "  (no camo URL detected for version badge — skipping purge)"
fi
