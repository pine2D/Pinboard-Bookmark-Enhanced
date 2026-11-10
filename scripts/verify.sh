#!/bin/sh
set -eu

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# Every gate command below belongs to exactly one group:
#   static    no browser, or only a light one
#   pages     the tests/*-tests.html suites (scripts/run-html-suites.mjs)
#   render    checks that judge real rendering in a browser
#   journeys  real-extension node tests and the qa-drive contracts
# No argument, or only --all, runs every group in the order below (the CI
# gate). --group=<name>[,<name>...] (repeatable) runs only those groups, still
# in this order; it cannot be mixed with other arguments. Any other arguments
# go to scripts/audit.mjs unchanged, as before groups existed.
# PBP_VERIFY_DRY=1 prints each command as "[dry][<group>] <command>" and runs
# nothing (tests/verify-groups-tests.mjs checks the groups with it). Dry only
# applies to the group path: --changed and the other audit.mjs arguments still
# run scripts/audit.mjs for real.
# PBP_RETRY_FLAKY=1 runs a failed pages, render or journeys command once more,
# and makes scripts/run-html-suites.mjs do the same per page. A pass on the second
# try is recorded in $PBP_QA_REPORT_DIR/flakes.jsonl (scripts/flake-record.mjs);
# a second failure fails. static never retries. Unset, nothing is retried.
ALL_GROUPS="static pages render journeys"
SELECTED=""
if [ "$#" -gt 0 ]; then
  has_group=0
  for arg do
    case "$arg" in
      --group=*|--group) has_group=1 ;;
    esac
  done
  if [ "$has_group" -eq 0 ]; then
    # Explicit development scopes; no-argument CI keeps every existing gate below.
    if [ "$#" -eq 1 ] && [ "$1" = "--all" ]; then
      shift
    else
      exec node scripts/audit.mjs "$@"
    fi
  else
    for arg do
      case "$arg" in
        --group=*)
          group_value=${arg#--group=}
          case "$group_value" in
            ''|,*|*,|*,,*)
              echo "[verify] --group=\"$group_value\" needs group names split by single commas (known: $ALL_GROUPS)" >&2
              exit 2
              ;;
          esac
          old_ifs=$IFS
          IFS=,
          set -f
          for group_name in $group_value; do
            case " $ALL_GROUPS " in
              *" $group_name "*) ;;
              *)
                echo "[verify] unknown group \"$group_name\" (known: $ALL_GROUPS)" >&2
                exit 2
                ;;
            esac
            case " $SELECTED " in
              *" $group_name "*) ;;
              *) SELECTED="$SELECTED $group_name" ;;
            esac
          done
          set +f
          IFS=$old_ifs
          ;;
        --group)
          echo "[verify] use --group=<name> (known: $ALL_GROUPS)" >&2
          exit 2
          ;;
        *)
          echo "[verify] --group cannot be mixed with other arguments (got \"$arg\")" >&2
          exit 2
          ;;
      esac
    done
  fi
fi
if [ -z "$SELECTED" ]; then
  SELECTED=$ALL_GROUPS
fi
# Forget git variables the caller handed down (a hook, `git rebase -x`,
# `git bisect run`). Some gates build throwaway repos; with GIT_DIR inherited
# they would write to the real one. ROOT is already resolved, and git finds the
# repo from the working directory from here on.
for git_var in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$git_var"
done
DRY=${PBP_VERIFY_DRY:-}
RETRY=${PBP_RETRY_FLAKY:-}
REPORT_DIR=${PBP_QA_REPORT_DIR:-$HOME/.local/share/pbp-qa-report}

selected() {
  case " $SELECTED " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# A stage label is printed once, right before the stage's first command that
# runs, so a group run shows only its own stages and a full run prints exactly
# the labels it always did.
STAGE_LABEL=""
STAGE_NAME=""
STAGE_SHOWN=1
STAGE_CMD=0
stage() {
  STAGE_LABEL=$1
  STAGE_NAME=${1#\[}
  STAGE_NAME=${STAGE_NAME%%\]*}
  STAGE_SHOWN=0
  STAGE_CMD=0
}
show_stage() {
  if [ "$STAGE_SHOWN" -eq 0 ]; then
    printf '%s\n' "$STAGE_LABEL"
    STAGE_SHOWN=1
  fi
}

# gate <group> <command...>: run one gate command if its group is selected.
# Never call it inside if/&&/|| (that would switch off set -e in the command).
gate() {
  gate_group=$1
  shift
  selected "$gate_group" || return 0
  show_stage
  STAGE_CMD=$((STAGE_CMD + 1))
  if [ "$DRY" = 1 ]; then
    printf '[dry][%s] %s\n' "$gate_group" "$*"
    return 0
  fi
  case "$gate_group" in
    pages|render|journeys)
      if [ "$RETRY" = 1 ]; then
        retry_once "$@"
        return 0
      fi
      ;;
  esac
  "$@"
}

# attempt <log> <command...>: run it, show and save its output, set ATTEMPT_RC.
attempt() {
  attempt_log=$1
  shift
  { attempt_rc=0; "$@" 2>&1 || attempt_rc=$?; echo "$attempt_rc" > "$attempt_log.rc"; } | tee "$attempt_log"
  ATTEMPT_RC=$(cat "$attempt_log.rc" 2>/dev/null || echo 1)
  rm -f "$attempt_log.rc"
}

retry_once() {
  retry_dir="$REPORT_DIR/verify-logs"
  mkdir -p "$retry_dir"
  retry_log="$retry_dir/$STAGE_NAME-$STAGE_CMD"
  attempt "$retry_log.log" "$@"
  if [ "$ATTEMPT_RC" -eq 0 ]; then
    return 0
  fi
  echo "[$STAGE_NAME] failed (exit $ATTEMPT_RC); running it once more because PBP_RETRY_FLAKY=1: $*"
  attempt "$retry_log.retry.log" "$@"
  if [ "$ATTEMPT_RC" -ne 0 ]; then
    echo "[$STAGE_NAME] failed again (exit $ATTEMPT_RC): $*" >&2
    echo "[$STAGE_NAME] logs: $retry_log.log $retry_log.retry.log" >&2
    exit "$ATTEMPT_RC"
  fi
  node scripts/flake-record.mjs --stage="$STAGE_NAME" --target="$*" --log="$retry_log.log" ||
    echo "[$STAGE_NAME] WARNING: passed on retry, but the flake was not recorded (see the line above)" >&2
}

check_js_syntax() {
  git ls-files -- '*.js' '*.mjs' |
    while IFS= read -r file; do
      node --check "$file"
    done
}

stage "[audit-scope] checking selection, dependencies, matrices and runner plans"
for scope_test in tests/audit*-tests.mjs; do
  gate static node "$scope_test"
done

stage "[verify-groups] checking that the verify groups cover every gate exactly once"
gate static node "tests/verify-groups-tests.mjs"

# The HTML suites: scripts/run-html-suites.mjs prints the [browser] lines,
# runs the large conversion suite first, and handles PBP_VERIFY_DRY,
# PBP_PAGE_JOBS and PBP_RETRY_FLAKY itself.
if selected pages; then
  node scripts/run-html-suites.mjs
fi

stage "[bookmark-services] isolated primary-service UI and personal-library restore"
gate journeys node tests/bookmark-service-runtime-tests.mjs
gate journeys node tests/bookmark-live-preflight-tests.mjs
stage "[ask-history] reader and library Ask history against an isolated archive"
gate journeys node tests/ask-history-tests.mjs
gate journeys node tests/library-ask-history-tests.mjs
stage "[mutate-check] self-test: restore, exactly-once, crash backup"
gate static node tests/mutate-check-tests.mjs
stage "[run-test] self-test: --print-counts waits for the registered count"
gate pages node tests/run-test-print-counts-tests.mjs

stage "[selection] real pointer selection with native popover light-dismiss"
gate journeys node scripts/qa-drive.mjs --headless --surfaces selection --check --label selection-default-contract
gate journeys node scripts/qa-drive.mjs --headless --surfaces selection --click-dismiss --check --label selection-click-contract

stage "[draft] native popup close/reopen preserves unsaved edits"
gate journeys node scripts/qa-drive.mjs --surfaces drafts --check --label popup-draft-contract

stage "[options-save] persistent feedback, retry and translated narrow layouts"
gate journeys node scripts/qa-drive.mjs --headless --surfaces options-save --check --label options-save-contract

stage "[translate-stop] HTTP 429 wait responds to Stop"
gate journeys node scripts/qa-drive.mjs --headless --surfaces translate-stop --fault ai-429 --check --label translate-stop-contract

stage "[layouts] nine locales, narrow settings, Ask width and popup semantics"
gate journeys node scripts/qa-drive.mjs --headless --surfaces layouts --check --label layouts-contract

stage "[journey] note editing, failure retry and clearing combined filters"
gate journeys node scripts/qa-drive.mjs --headless --surfaces journey --check --label notes-edit-clear-contract

stage "[discovery] source controls, AI setup and preset CSS"
gate journeys node scripts/qa-drive.mjs --headless --surfaces discovery --check --label discovery-contract

stage "[reader-save-export] bookmark completion and portable Q&A exports"
gate journeys node scripts/qa-drive.mjs --headless --surfaces reader-bookmark,reader-export --check --label reader-save-export-contract

stage "[syntax] checking JavaScript"
gate static check_js_syntax

stage "[eslint] correctness lint over runtime scripts (config: eslint.config.mjs)"
# ESLint lives in .qa-scan's dev-only node_modules (same precedent as
# playwright); the flat config self-collects this repo's cross-file globals.
# --suppressions-location holds the old silent catches (pbp/no-silent-catch);
# a new one fails here, and a fixed one fails until `--prune-suppressions`.
gate static env ESLINT_USE_FLAT_CONFIG=true npx --prefix .qa-scan eslint . --suppressions-location scripts/eslint-suppressions.json

stage "[eslint-silent-catch] checking the no-silent-catch rule against valid and invalid samples"
gate static node "tests/eslint-silent-catch-tests.mjs"

stage "[eslint-baseline] checking the silent-catch baseline check against growing and shrinking samples"
gate static node "tests/eslint-baseline-tests.mjs"

stage "[script-graph] checking executeScript page functions are closure-free"
# Immediately after eslint, and for the blind spot eslint structurally has:
# no-undef is fed the UNION of every root script's top-level declarations, so a
# function serialized into a tab by executeScript({ func }) can reference a
# bundle symbol that will not exist there and still lint clean.
gate static node "scripts/script-graph-lint.mjs"

stage "[vendor-lock] verifying vendored artifacts against vendor/vendor-lock.json"
gate static node "scripts/vendor-lock-check.mjs"

stage "[network-exits] cross-checking runtime hosts vs docs/network-exits.json vs privacy.md"
gate static node "scripts/network-exits-check.mjs"

stage "[ui-contract] checking static UI contracts"
gate static node "tests/ui-contract-tests.mjs"

stage "[popup-label-fit] checking every popup form label fits its column in every UI locale"
# Launches Chromium and measures the rendered labels, so it is a render gate.
gate render node "tests/popup-label-fit-tests.mjs"

stage "[md-preview-contrast] checking md-preview.css's light-dark token contrast pairs"
# md-preview is the one surface outside the theme factory (no @generated
# regions, no per-preset blocks) -- contrast-audit.mjs never looks at it,
# so this is its only static contrast gate.
gate static node "tests/md-preview-contrast-tests.mjs"

stage "[ui-vocabulary] checking structural class tokens against the registry and the legacy baseline"
gate static node "scripts/ui-vocabulary-lint.mjs"
gate static node "tests/ui-vocabulary-tests.mjs"

stage "[render-audit] checking hand-written render oracle (contrast + geometry + media preferences)"
# This single gate was ~80% of this script's wall clock (440s of ~550s; 4
# shards bring it to 154s and this script to 264s): 3 surfaces x 15 themes of
# real getComputedStyle/geometry in a headed Chromium, ~9s per (surface,
# theme) trip. The active theme lives in the extension's service-worker
# storage, so one browser holds exactly one theme at a time and the split
# has to be process-level: each shard loads its own unpacked
# extension (~3s), replays the identical fixture seeding and judges its own
# slice of THEMES against known-failures, so ANY shard's non-zero exit fails
# this gate. Shard 0 also runs the single sweep pass (families 4-11 + the
# spacingScale ledger). Capped at 4 because every shard is a whole headed
# Chromium and the per-shard fixed cost (launch + shard 0's sweep) stops
# paying past that; 1 shard means no --shard flag at all, i.e. exactly the
# invocation this line used to be.
# PBP_RENDER_SHARDS lets CI override the shard count (e.g. a constrained
# runner) without editing this script; it must be a positive integer or the
# computed default below is used instead.
# Shard logs go to $PBP_QA_REPORT_DIR/render-audit/ and stay there, so CI can
# upload them when a shard fails. With PBP_RETRY_FLAKY=1 a failed shard runs
# once more on its own after all shards finish.
render_audit_gate() {
  selected render || return 0
  show_stage
  RENDER_SHARDS_DEFAULT=$(node -e 'const n=(require("node:os").cpus()||[]).length||1;process.stdout.write(String(Math.max(1,Math.min(4,n))))')
  case "${PBP_RENDER_SHARDS:-}" in
    '')
      RENDER_SHARDS="$RENDER_SHARDS_DEFAULT"
      ;;
    *[!0-9]*|0)
      echo "[render-audit] ignoring invalid PBP_RENDER_SHARDS=\"$PBP_RENDER_SHARDS\" (must be a positive integer); using $RENDER_SHARDS_DEFAULT" >&2
      RENDER_SHARDS="$RENDER_SHARDS_DEFAULT"
      ;;
    *)
      RENDER_SHARDS="$PBP_RENDER_SHARDS"
      ;;
  esac
  if [ "$RENDER_SHARDS" -le 1 ]; then
    gate render node "scripts/ui-render-audit.mjs"
    return 0
  fi
  shard=0
  if [ "$DRY" = 1 ]; then
    while [ "$shard" -lt "$RENDER_SHARDS" ]; do
      printf '[dry][render] node scripts/ui-render-audit.mjs --shard=%s/%s\n' "$shard" "$RENDER_SHARDS"
      shard=$((shard + 1))
    done
    return 0
  fi
  echo "[render-audit] running $RENDER_SHARDS shards in parallel"
  RENDER_DIR="$REPORT_DIR/render-audit"
  mkdir -p "$RENDER_DIR"
  rm -f "$RENDER_DIR"/shard-*.log
  render_pids=""
  while [ "$shard" -lt "$RENDER_SHARDS" ]; do
    node "scripts/ui-render-audit.mjs" --shard="$shard/$RENDER_SHARDS" > "$RENDER_DIR/shard-$shard.log" 2>&1 &
    render_pids="$render_pids $!"
    shard=$((shard + 1))
  done
  render_failed=""
  shard=0
  for pid in $render_pids; do
    if ! wait "$pid"; then
      render_failed="$render_failed $shard"
    fi
    shard=$((shard + 1))
  done
  # Printed after the join, one shard at a time: interleaved live output from
  # four processes is unreadable, and nothing here reports progress anyway.
  shard=0
  while [ "$shard" -lt "$RENDER_SHARDS" ]; do
    cat "$RENDER_DIR/shard-$shard.log"
    shard=$((shard + 1))
  done
  render_failures=0
  for shard in $render_failed; do
    if [ "$RETRY" = 1 ]; then
      echo "[render-audit] shard $shard/$RENDER_SHARDS failed; running it once more because PBP_RETRY_FLAKY=1"
      if node "scripts/ui-render-audit.mjs" --shard="$shard/$RENDER_SHARDS" > "$RENDER_DIR/shard-$shard.retry.log" 2>&1; then
        cat "$RENDER_DIR/shard-$shard.retry.log"
        node scripts/flake-record.mjs --stage=render-audit --target="node scripts/ui-render-audit.mjs --shard=$shard/$RENDER_SHARDS" --log="$RENDER_DIR/shard-$shard.log" ||
          echo "[render-audit] WARNING: shard $shard passed on retry, but the flake was not recorded (see the line above)" >&2
        continue
      fi
      cat "$RENDER_DIR/shard-$shard.retry.log"
    fi
    render_failures=$((render_failures + 1))
  done
  if [ "$render_failures" -ne 0 ]; then
    echo "[render-audit] $render_failures of $RENDER_SHARDS shard(s) failed (logs: $RENDER_DIR)" >&2
    exit 1
  fi
}
render_audit_gate

stage "[options-help-render] checking semantic roles and raster alignment"
gate render node "scripts/options-help-render-audit.mjs"

stage "[docs-lint] checking README x9 mirror + prose contracts + .claude/expiring-items.md 临时事项 expiry dates"
gate static node "scripts/docs-lint.mjs"

stage "[registers] checking .claude/ registers (decisions, acceptance debt, flake ledger) + lint self-tests"
gate static node "scripts/registers-lint.mjs"
gate static node "tests/registers-lint-tests.mjs"

stage "[rules-lint] checking CLAUDE.md index, rule files, skills, backticked references and number claims + lint self-tests"
gate static node "scripts/rules-lint.mjs"
gate static node "tests/rules-lint-tests.mjs"

stage "[store-descriptions] checking CWS store copy is regenerated from the READMEs"
gate static node "scripts/sync-store-descriptions.mjs" --check

stage "[hooks] checking installed git hooks still delegate to the tracked scripts"
gate static sh "scripts/setup-hooks.sh" --check

stage "[theme] checking generated theme integrity"
gate static node "docs/theme-surface/tools/validate-contracts.mjs"
gate static node "tests/theme-contract-tests.mjs"
gate static node "tests/theme-css-syntax-tests.mjs"
gate static node "tests/theme-tooling-tests.mjs"
gate static node "tests/theme-ui-derive-tests.mjs"
gate static node "tests/theme-media-audit-tests.mjs"
# Renders every site theme in Chromium, so it is a render gate.
gate render node "tests/pinboard-theme-render-tests.mjs"
gate static node "tests/theme-override-debt-tests.mjs"
gate static node "tests/theme-sync-check-tests.mjs"
gate static node "docs/theme-surface/tools/diff-all.mjs" --strict
gate static node "docs/theme-surface/tools/token-coverage.mjs"
gate static node "docs/theme-surface/tools/cascade-lint.mjs"
gate static node "docs/theme-surface/tools/override-drift.mjs"
gate static node "docs/theme-surface/tools/override-debt.mjs"
gate static node "docs/theme-surface/tools/handedit-audit.mjs"
gate static node "docs/theme-surface/tools/css-region-audit.mjs"
gate static node "docs/theme-surface/tools/ui-token-coverage.mjs"
gate static node "docs/theme-surface/tools/contrast-audit.mjs"
gate static node "docs/theme-surface/tools/recipe-lint.mjs"

if [ "$DRY" = 1 ]; then
  echo "[verify] dry run: nothing was run"
elif [ "$SELECTED" = "$ALL_GROUPS" ]; then
  echo "[verify] all checks passed"
else
  echo "[verify] all checks passed for group(s):$SELECTED"
fi
