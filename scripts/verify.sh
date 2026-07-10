#!/bin/sh
set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

echo "[syntax] checking JavaScript"
git ls-files -- '*.js' '*.mjs' |
  while IFS= read -r file; do
    node --check "$file"
  done

set -- tests/*-tests.html
if [ ! -f "$1" ]; then
  echo "[browser] no tests/*-tests.html suites found" >&2
  exit 1
fi

if [ ! -d ".qa-scan/node_modules/playwright" ]; then
  echo "[browser] Playwright is not installed; run: npm ci --prefix .qa-scan" >&2
  exit 1
fi

echo "[browser] running $# HTML suites"
browser_failures=0
for suite do
  echo "[browser] $suite"
  if ! node ".qa-scan/run-test.mjs" "$suite"; then
    browser_failures=$((browser_failures + 1))
  fi
done
if [ "$browser_failures" -ne 0 ]; then
  echo "[browser] $browser_failures suite(s) failed" >&2
  exit 1
fi

echo "[ui-contract] checking static UI contracts"
node "tests/ui-contract-tests.mjs"

echo "[theme] checking generated theme integrity"
node "docs/theme-surface/tools/diff-all.mjs" --strict
node "docs/theme-surface/tools/token-coverage.mjs"
node "docs/theme-surface/tools/cascade-lint.mjs"
node "docs/theme-surface/tools/override-drift.mjs"
node "docs/theme-surface/tools/handedit-audit.mjs"

echo "[verify] all checks passed"
