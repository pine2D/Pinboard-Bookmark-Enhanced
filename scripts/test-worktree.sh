#!/usr/bin/env bash
# Dev-time helper (not part of verify.sh or CI): run a test against an OLDER
# commit without touching this working tree or the shared stash list.
#
#   scripts/test-worktree.sh add <commit> [dir]   create a detached worktree at
#       <commit> (default dir: a fresh mktemp -d under $TMPDIR or /tmp), link
#       this checkout's .qa-scan/node_modules into it so run-test.mjs and the
#       Node tests find playwright, and print the directory on stdout.
#   scripts/test-worktree.sh remove <dir>         remove that worktree (even if
#       dirty) and prune. Refuses a directory git does not list as a worktree
#       of this repository, and the main working tree itself.
#
# Typical "does the new test fail on the old implementation" loop:
#   old=$(scripts/test-worktree.sh add <commit-before-the-fix>)
#   cp tests/<page>.html "$old/tests/"          # the new test over the old code
#   (cd "$old" && env -u FONTCONFIG_FILE xvfb-run -a node .qa-scan/run-test.mjs tests/<page>.html)
#   scripts/test-worktree.sh remove "$old"
#
# Never uses git stash. Run it from any directory inside the repository.
set -euo pipefail

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

main_tree=$(git rev-parse --show-toplevel)
cmd=${1:-}
case "$cmd" in
  add)
    commit=${2:-}; [ -n "$commit" ] || usage
    git rev-parse --verify --quiet "$commit^{commit}" >/dev/null || { echo "not a commit: $commit" >&2; exit 2; }
    if [ -n "${3:-}" ]; then
      dir=$3
      [ ! -e "$dir" ] || [ -z "$(ls -A "$dir" 2>/dev/null)" ] || { echo "not empty: $dir" >&2; exit 2; }
    else
      dir=$(mktemp -d "${TMPDIR:-/tmp}/pbp-test-worktree.XXXXXX")
    fi
    git worktree add --detach "$dir" "$commit" >&2
    if [ -d "$main_tree/.qa-scan/node_modules" ]; then
      mkdir -p "$dir/.qa-scan"
      ln -sfn "$main_tree/.qa-scan/node_modules" "$dir/.qa-scan/node_modules"
    else
      echo "warning: $main_tree/.qa-scan/node_modules is missing; browser tests will not run" >&2
    fi
    echo "$dir"
    ;;
  remove)
    dir=${2:-}; [ -n "$dir" ] || usage
    dir=$(cd "$dir" 2>/dev/null && pwd -P) || { echo "no such directory: $2" >&2; exit 2; }
    [ "$dir" != "$(cd "$main_tree" && pwd -P)" ] || { echo "refusing to remove the main working tree" >&2; exit 2; }
    git worktree list --porcelain | grep -Fxq "worktree $dir" || { echo "not a worktree of this repository: $dir" >&2; exit 2; }
    # Drop the node_modules link first so --force can never follow it.
    [ ! -L "$dir/.qa-scan/node_modules" ] || rm "$dir/.qa-scan/node_modules"
    git worktree remove --force "$dir"
    git worktree prune
    ;;
  *) usage ;;
esac
