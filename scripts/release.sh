#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
MANIFEST="${REPO_ROOT}/manifest.json"
RELEASE_DIR="${REPO_ROOT}/release"

VERSION=$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['version'])")
ZIP_NAME="pinboard-bookmark-enhanced-v${VERSION}.zip"
ZIP_PATH="${RELEASE_DIR}/${ZIP_NAME}"

echo "Version: ${VERSION}"
echo "Output : ${ZIP_PATH}"
echo ""

# Extension source files to include in the ZIP
INCLUDE=(
  manifest.json
  popup.html
  popup.js
  popup.css
  popup-ai.js
  popup-batch.js
  popup-tags.js
  options.html
  options.js
  options.css
  options-theme-early.js
  background.js
  shared.js
  ai.js
  i18n.js
  pinboard-style.js
  pinboard-themes.js
  _locales
  icons
)

mkdir -p "${RELEASE_DIR}"

if [ -f "${ZIP_PATH}" ]; then
  echo "Removing existing ${ZIP_NAME}"
  rm "${ZIP_PATH}"
fi

cd "${REPO_ROOT}"
python3 - "${ZIP_PATH}" "${INCLUDE[@]}" <<'PYEOF'
import sys, zipfile, os, pathlib

zip_path = sys.argv[1]
targets = sys.argv[2:]

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for target in targets:
        p = pathlib.Path(target)
        if not p.exists():
            print(f"  Warning: {target} not found, skipping")
            continue
        if p.is_dir():
            for file in sorted(p.rglob('*')):
                if file.is_file() and '.DS_Store' not in file.name:
                    zf.write(file)
        else:
            zf.write(p)
PYEOF

echo ""
echo "Created: ${ZIP_PATH}"
echo ""

# Check gh CLI available
if ! command -v gh &>/dev/null; then
  echo "gh CLI not found. Skipping GitHub Release creation."
  echo "Install: https://cli.github.com"
  exit 0
fi

TAG="v${VERSION}"

# Check if tag/release already exists
if gh release view "${TAG}" &>/dev/null; then
  echo "Release ${TAG} already exists."
  read -r -p "Overwrite? (y/N) " CONFIRM
  if [ "${CONFIRM}" != "y" ] && [ "${CONFIRM}" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
  gh release delete "${TAG}" --yes --cleanup-tag
fi

gh release create "${TAG}" \
  "${ZIP_PATH}" \
  --title "v${VERSION}" \
  --notes "## Pinboard Bookmark Enhanced v${VERSION}

### Installation
1. Download \`${ZIP_NAME}\` below
2. Unzip to a local folder
3. Open \`chrome://extensions/\`, enable **Developer mode**
4. Click **Load unpacked**, select the unzipped folder" \
  --latest

echo ""
echo "GitHub Release created: ${TAG}"
