#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT=$(git rev-parse --show-toplevel)
VENDOR_DIR="${REPO_ROOT}/vendor"
mkdir -p "${VENDOR_DIR}"

TMP=$(mktemp -d)
npm pack defuddle --pack-destination "${TMP}"
tar xzf "${TMP}"/defuddle-*.tgz -C "${TMP}"

VERSION=$(node -e "console.log(require('${TMP}/package/package.json').version)")
cp "${TMP}/package/dist/index.js" "${VENDOR_DIR}/defuddle.js"
sed -i "1s|^|// defuddle v${VERSION} — https://github.com/kepano/defuddle\n|" "${VENDOR_DIR}/defuddle.js"
rm -rf "${TMP}"

echo "Updated to defuddle v${VERSION}"
echo "  ${VENDOR_DIR}/defuddle.js"
