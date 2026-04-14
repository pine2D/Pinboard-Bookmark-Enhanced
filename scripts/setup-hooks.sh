#!/bin/sh
# Install git hooks for this repo.
# Run once after cloning: sh scripts/setup-hooks.sh

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts"

install_hook() {
  src="$1"
  dst="$HOOKS_DIR/$2"
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "Installed: .git/hooks/$2"
}

install_hook "$SCRIPTS_DIR/commit-msg-hook.sh" "commit-msg"
install_hook "$SCRIPTS_DIR/pre-commit-hook.sh" "pre-commit"

echo "Done. Version auto-bump + theme-surface drift guard are active."
echo ""
echo "commit-msg (version bump):"
echo "  feat:             → minor bump  (2.4 → 2.5)"
echo "  fix|refactor|perf → patch bump  (2.4 → 2.4.1)"
echo "  BREAKING CHANGE   → major bump  (2.4 → 3.0)"
echo "  chore|docs|test   → no bump"
echo ""
echo "pre-commit (drift guard):"
echo "  Blocks commit when any docs/theme-surface tokens/composer/tool change"
echo "  leaves a theme with missing decls vs shipped CSS."
echo "  Fix:    node docs/theme-surface/tools/generate-overrides.mjs <slug> --inject"
echo "  Bypass: git commit --no-verify"
