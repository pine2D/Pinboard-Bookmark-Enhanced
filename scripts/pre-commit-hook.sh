#!/bin/sh
# Theme-surface drift guard. When any docs/theme-surface/pilots/*.tokens.json
# or composers/*.mjs file is staged, runs diff-all --strict and blocks the
# commit if any theme regressed to having missing declarations against the
# currently shipped CSS in pinboard-themes.js.
#
# Installed as .git/hooks/pre-commit via scripts/setup-hooks.sh
#
# Bypass (rare): git commit --no-verify

CHANGED=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^docs/theme-surface/(pilots/[^/]+\.tokens\.json|composers/[^/]+\.mjs|tools/[^/]+\.mjs)$')

if [ -z "$CHANGED" ]; then
  exit 0
fi

echo "[drift-guard] theme-surface files changed — running diff-all --strict"
echo "$CHANGED" | sed 's/^/  /'

if ! command -v node >/dev/null 2>&1; then
  echo "[drift-guard] node not found in PATH — skipping (install node or use --no-verify)" >&2
  exit 0
fi

# Run from repo root so relative imports in the .mjs work correctly.
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT/docs/theme-surface" || exit 0

if ! node tools/diff-all.mjs --strict; then
  echo ""
  echo "[drift-guard] COMMIT BLOCKED — a theme has missing decls vs shipped CSS." >&2
  echo "  Fix: node docs/theme-surface/tools/generate-overrides.mjs <slug> --inject" >&2
  echo "  Bypass (not recommended): git commit --no-verify" >&2
  exit 1
fi
