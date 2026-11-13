#!/bin/sh
# Enforces Conventional Commits message formatting (CLAUDE.md:60) so
# scripts/bump-version.sh and scripts/changelog.py can reliably classify every
# commit. Auto-bumping manifest.json per commit remains DISABLED (cumulative
# release mode: run scripts/bump-version.sh + scripts/release.sh when shipping).

MSG_FILE="${1:-}"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

if command -v node >/dev/null 2>&1 && [ -f "$REPO_ROOT/scripts/commit-msg-lint.mjs" ]; then
  exec node "$REPO_ROOT/scripts/commit-msg-lint.mjs" "$MSG_FILE"
fi

# Fallback POSIX check when node or commit-msg-lint.mjs is absent (e.g. minimal
# throwaway git sandboxes in doctor-tests.mjs).
SUBJECT=$(sed '/^# -\{1,\} >8 -\{1,\}[[:space:]]*$/,$d; /^#/d' "$MSG_FILE" | sed '/^[[:space:]]*$/d' | head -n 1)
if [ -z "$SUBJECT" ]; then
  echo "[commit-msg] COMMIT BLOCKED — commit message is empty" >&2
  exit 1
fi
printf '%s\n' "$SUBJECT" | grep -Eq '^((feat|fix|refactor|perf|docs|style|chore|test|ci|build|i18n|a11y|revert)(\([a-zA-Z0-9_./-]+\))?!?: [^[:space:]].*|Revert ".+"|Merge (branch|pull request|remote-tracking branch|tag) .+)$' || {
  echo "[commit-msg] COMMIT BLOCKED — subject must follow Conventional Commits (<type>[scope]: <summary>)" >&2
  exit 1
}
exit 0
