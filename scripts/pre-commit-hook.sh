#!/bin/sh
# Theme-surface drift guard + UI design-language consumer gates. When a theme
# contract/source or generated runtime file is staged, runs the read-only
# factory pipeline plus the complementary source/cascade/hand-edit/UI contract
# gates; when a surface HTML/JS file is staged, runs the fast static
# design-language gates. Blocks on any failure.
#
# Installed as .git/hooks/pre-commit via scripts/setup-hooks.sh
# Trigger groups, from two `git diff --cached` listings (the second one also
# sees deletions). The first two are described here; the registers, doctor, sentinel, rules-lint,
# JS, eslint-baseline, slice-anchor, audit-scope and verify-groups groups are described next
# to their variables below:
#   THEME_RE -- theme-factory sources, pinboard-themes.js and the three
#               generated-region CSS files: the full read-only factory pipeline.
#   UI_*_RE  -- the CONSUMER side of the design language: the four surface HTML
#               files, their JS, shared.js, md-preview.css and the vocabulary
#               registry/baseline. Only sub-second static gates run here
#               (layout-lint inline spacing, ui-vocabulary structural classes),
#               plus ui-contract when HTML / md-preview.css / a surface's own
#               JS changed (ui-contract pins JS-side builders too -- e.g. the
#               Send-to .switch builder in options.js -- which a JS-only commit
#               used to reach only in verify/CI). The dictionary lookup's
#               builders (md-dict.js, dict-*.js) are pinned there as well and
#               ride the same arm (plan Q27=A). Before
#               2026-09-05 an HTML-only commit ran ZERO gates -- 70 such commits
#               since July are how 23 inline styles and 27 ad-hoc wrapper
#               classes reached the settings page.
STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
# The rules and registers groups also care about deletions and rename sources:
# removing a rule file or a register breaks the index without changing a kept file.
STAGED_WITH_DELETES=$(git diff --cached --name-only --no-renames)
THEME_RE='^(docs/theme-surface/(pilots/[^/]+\.tokens\.json|composers/[^/]+\.mjs|tools/[^/]+\.mjs|tools/override-debt-baseline\.json|manifest\.json|tokens\.schema\.json)|pinboard-themes\.js|popup\.css|options\.css|library\.css)$'
UI_HTML_RE='^((popup|options|library|md-preview)\.html|md-preview\.css|(popup|options|library)(-[a-z-]+)?\.js|listbox\.js|md-dict\.js|dict-[a-z-]+\.js)$'
UI_VOCAB_RE='^((popup|options|library|md-preview)\.html|(popup|options|library)(-[a-z-]+)?\.js|listbox\.js|md-[a-z-]+\.js|shared\.js|docs/theme-surface/ui-vocabulary\.json|scripts/ui-vocabulary-baseline\.json|scripts/ui-vocabulary-lint\.mjs)$'
CHANGED=$(printf '%s
' "$STAGED" | grep -E "$THEME_RE")
UI_HTML_CHANGED=$(printf '%s
' "$STAGED" | grep -E "$UI_HTML_RE")
UI_VOCAB_CHANGED=$(printf '%s
' "$STAGED" | grep -E "$UI_VOCAB_RE")
AUDIT_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/(audit[^/]*|ui-render-audit|qa-drive|options-help-render-audit)\.mjs|tests/(audit[^/]*-tests|pinboard-theme-render-tests|render-audit-checklist)\.mjs|scripts/(verify|pre-commit-hook)\.sh)$')
# Registers group: the five registers, the lint and its tests, plus the files
# freshness-ledger.md is checked against (ai.js holds the provider registry,
# shared.js loads before it) and docs-lint.mjs, whose 临时事项 parser the lint imports.
REGISTERS_CHANGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^(\.claude/(decisions|acceptance-debt|flake-ledger|store-ledger|freshness-ledger)\.md|scripts/(registers-lint|docs-lint)\.mjs|tests/registers-lint-tests\.mjs|ai\.js|shared\.js)$')
RULES_CHANGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^(CLAUDE\.md|AGENTS\.md|PRODUCT\.md|\.claude/rules/[^/]+\.md|\.claude/skills/.+|\.claude/expiring-items\.md|scripts/rules-lint(-allow)?\.(mjs|json)|tests/rules-lint-tests\.mjs)$')
JS_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '\.(js|mjs)$' | grep -vE '^vendor/')
JS_ROOT_CHANGED=$(printf '%s\n' "$JS_CHANGED" | grep -E '^[^/]+\.js$')
# Deletions count here too: dropping the baseline and adding it back later would let it grow.
ESLINT_BASELINE_STAGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^scripts/eslint-suppressions\.json$')
ESLINT_RULE_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(eslint\.config\.mjs|scripts/eslint-rules/[^/]+\.mjs|scripts/eslint-suppressions\.json|tests/eslint-silent-catch-tests\.mjs)$')
ESLINT_TOOLS_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/eslint-baseline-check\.mjs|tests/eslint-baseline-tests\.mjs)$')
# Doctor group: the local setup doctor, its self-test and the registers code it imports.
DOCTOR_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/(doctor|registers-lint|docs-lint)\.mjs|tests/doctor-tests\.mjs)$')
# Sentinel group: the weekly sentinel's workflow, its two scripts and their self-tests.
SENTINEL_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/(link-check|sentinel-report)\.mjs|tests/(link-check|sentinel-report)-tests\.mjs|\.github/workflows/sentinel\.yml)$')
VERIFY_GROUPS_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/(verify\.sh|run-html-suites\.mjs|flake-record\.mjs)|tests/verify-groups-tests\.mjs)$')
# Slice-anchor group: any test file, the lint, its self-test or its baseline
# (deletions too: dropping the baseline and adding it back would reset it).
SLICE_CHANGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^(tests/.+\.(html|mjs|js)|scripts/slice-anchor-(lint\.mjs|baseline\.json))$')
SLICE_BASELINE_STAGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^scripts/slice-anchor-baseline\.json$')
SLICE_TOOLS_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/slice-anchor-lint\.mjs|tests/slice-anchor-lint-tests\.mjs)$')
AI_PROVIDERS_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/(ai-providers-source|sync-ai-providers)\.mjs|tests/ai-providers-source-tests\.mjs|ai\.js|shared\.js|popup-ai\.js|options\.html|options\.js|options-connectivity\.js)$')
SETTINGS_SCHEMA_CHANGED=$(printf '%s\n' "$STAGED" | grep -E '^(scripts/(settings-schema|sync-settings-schema|ai-providers-source)\.mjs|tests/settings-schema-tests\.mjs|shared\.js|options-backup\.js|options\.html|options\.js)$')
TYPECHECK_CHANGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^((vocab-store|bookmark-services|export-targets|dict-archive|ask-archive|notes-sync)\.js|scripts/(typecheck-data-layer\.mjs|jsconfig\.data-layer\.json|types/data-layer-globals\.d\.ts)|tests/typecheck-data-layer-tests\.mjs|\.qa-scan/package(-lock)?\.json)$')
RUNTIME_MESSAGES_CHANGED=$(printf '%s\n' "$STAGED_WITH_DELETES" | grep -E '^([^/]+\.js|scripts/(runtime-messages-source|sync-runtime-messages)\.mjs|tests/runtime-messages-tests\.mjs)$')
if [ -z "$CHANGED" ] && [ -z "$SLICE_CHANGED" ] && [ -z "$JS_CHANGED" ] && [ -z "$ESLINT_BASELINE_STAGED" ] && [ -z "$ESLINT_RULE_CHANGED" ] && [ -z "$ESLINT_TOOLS_CHANGED" ] && [ -z "$UI_HTML_CHANGED" ] && [ -z "$UI_VOCAB_CHANGED" ] && [ -z "$AUDIT_CHANGED" ] && [ -z "$REGISTERS_CHANGED" ] && [ -z "$RULES_CHANGED" ] && [ -z "$VERIFY_GROUPS_CHANGED" ] && [ -z "$DOCTOR_CHANGED" ] && [ -z "$SENTINEL_CHANGED" ] && [ -z "$AI_PROVIDERS_CHANGED" ] && [ -z "$SETTINGS_SCHEMA_CHANGED" ] && [ -z "$TYPECHECK_CHANGED" ] && [ -z "$RUNTIME_MESSAGES_CHANGED" ]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[drift-guard] COMMIT BLOCKED — node not found in PATH; install Node.js and rerun the commit" >&2
  exit 1
fi

# Run from repo root so relative imports in the .mjs work correctly.
REPO_ROOT=$(git rev-parse --show-toplevel)

if [ -n "$REGISTERS_CHANGED" ]; then
  echo "[registers] checking .claude/ registers and the lint self-tests"
  if ! node "$REPO_ROOT/scripts/registers-lint.mjs" || ! node "$REPO_ROOT/tests/registers-lint-tests.mjs"; then
    echo ""
    echo "[registers] COMMIT BLOCKED — a register file breaks its format or expiry rule (see the message above)" >&2
    exit 1
  fi  # A changed default model must not keep the date that verified the old one.
  # The first commit of the ledger has no HEAD copy to compare with and passes.
  if printf '%s\n' "$STAGED" | grep -qx '\.claude/freshness-ledger\.md' && git cat-file -e HEAD:.claude/freshness-ledger.md 2>/dev/null; then
    FRESH_TMP=$(mktemp -d)
    git show HEAD:.claude/freshness-ledger.md > "$FRESH_TMP/old.md"
    git show :.claude/freshness-ledger.md > "$FRESH_TMP/new.md"
    if ! node "$REPO_ROOT/scripts/registers-lint.mjs" --compare-freshness "$FRESH_TMP/old.md" "$FRESH_TMP/new.md"; then
      rm -rf "$FRESH_TMP"
      echo ""
      echo "[registers] COMMIT BLOCKED — a default model changed but kept its old 最近核实 date (see the message above)" >&2
      exit 1
    fi
    rm -rf "$FRESH_TMP"
  fi
fi

if [ -n "$DOCTOR_CHANGED" ]; then
  echo "[doctor] checking the local setup doctor in throwaway repos"
  if ! node "$REPO_ROOT/tests/doctor-tests.mjs"; then
    echo ""
    echo "[doctor] COMMIT BLOCKED — the doctor self-test failed (see the message above)" >&2
    exit 1
  fi
fi

if [ -n "$SENTINEL_CHANGED" ]; then
  echo "[sentinel] checking the link check and the report against local fixtures"
  if ! node "$REPO_ROOT/tests/link-check-tests.mjs" || ! node "$REPO_ROOT/tests/sentinel-report-tests.mjs"; then
    echo ""
    echo "[sentinel] COMMIT BLOCKED — a sentinel self-test failed (see the message above)" >&2
    exit 1
  fi
fi

if [ -n "$RULES_CHANGED" ]; then
  echo "[rules-lint] checking the CLAUDE.md index, rule files, references and number claims"
  if ! node "$REPO_ROOT/scripts/rules-lint.mjs" || ! node "$REPO_ROOT/tests/rules-lint-tests.mjs"; then
    echo ""
    echo "[rules-lint] COMMIT BLOCKED — a rule file, the index or a number claim is out of step (see the message above)" >&2
    exit 1
  fi
fi

# ---- JS group: syntax, baseline, eslint and script-graph on staged scripts ----
if [ -n "$JS_CHANGED" ] || [ -n "$ESLINT_BASELINE_STAGED" ] || [ -n "$ESLINT_TOOLS_CHANGED" ]; then
  if [ -n "$JS_CHANGED" ]; then
    echo "[js-syntax] node --check on staged .js/.mjs"
    # One name per line, so a file name with a space stays whole. The loop runs
    # in a pipeline subshell, so its exit status is what the `if` tests.
    if ! printf '%s\n' "$JS_CHANGED" | while IFS= read -r f; do
      if ! node --check "$REPO_ROOT/$f"; then
        echo ""
        echo "[js-syntax] COMMIT BLOCKED — syntax error in $f (fix it, then stage again)" >&2
        exit 1
      fi
    done; then
      exit 1
    fi
  fi

  # The silent-catch baseline only shrinks: compare the staged copy with HEAD.
  # A baseline that is new at HEAD has nothing to compare with and passes.
  if [ -n "$ESLINT_BASELINE_STAGED" ] && git cat-file -e HEAD:scripts/eslint-suppressions.json 2>/dev/null; then
    if ! git cat-file -e :scripts/eslint-suppressions.json 2>/dev/null; then
      echo ""
      echo "[eslint-baseline] COMMIT BLOCKED — scripts/eslint-suppressions.json cannot be deleted or renamed." >&2
      echo "  Restore it: git restore --staged --worktree scripts/eslint-suppressions.json" >&2
      echo "  To shrink it, fix an old silent catch and run eslint with --prune-suppressions." >&2
      exit 1
    fi
    BASELINE_TMP=$(mktemp -d)
    git show HEAD:scripts/eslint-suppressions.json > "$BASELINE_TMP/old.json"
    git show :scripts/eslint-suppressions.json > "$BASELINE_TMP/new.json"
    if ! node "$REPO_ROOT/scripts/eslint-baseline-check.mjs" "$BASELINE_TMP/old.json" "$BASELINE_TMP/new.json"; then
      rm -rf "$BASELINE_TMP"
      echo ""
      echo "[eslint-baseline] COMMIT BLOCKED — the baseline only shrinks (see the message above)" >&2
      exit 1
    fi
    rm -rf "$BASELINE_TMP"
  fi
  if [ -n "$ESLINT_TOOLS_CHANGED" ]; then
    echo "[eslint-baseline] checking the baseline check against its samples"
    if ! node "$REPO_ROOT/tests/eslint-baseline-tests.mjs"; then
      echo ""
      echo "[eslint-baseline] COMMIT BLOCKED — the baseline check self-test failed" >&2
      exit 1
    fi
  fi

  # eslint, the rule self-test and script-graph-lint all need .qa-scan/node_modules.
  if [ -n "$JS_ROOT_CHANGED" ] || [ -n "$ESLINT_RULE_CHANGED" ]; then
    if [ -d "$REPO_ROOT/.qa-scan/node_modules/eslint" ] && [ -d "$REPO_ROOT/.qa-scan/node_modules/espree" ]; then
      if [ -n "$ESLINT_RULE_CHANGED" ]; then
        echo "[eslint-silent-catch] checking the no-silent-catch rule against its samples"
        if ! node "$REPO_ROOT/tests/eslint-silent-catch-tests.mjs"; then
          echo ""
          echo "[eslint-silent-catch] COMMIT BLOCKED — the rule self-test failed (see the message above)" >&2
          exit 1
        fi
      fi
      if [ -n "$JS_ROOT_CHANGED" ]; then
        echo "[eslint] linting staged root scripts"
        if ! (cd "$REPO_ROOT" && printf '%s\n' "$JS_ROOT_CHANGED" | tr '\n' '\0' | ESLINT_USE_FLAT_CONFIG=true xargs -0 npx --prefix .qa-scan eslint --suppressions-location scripts/eslint-suppressions.json); then
          ESLINT_FILES=$(printf '%s' "$JS_ROOT_CHANGED" | tr '\n' ' ')
          echo ""
          echo "[eslint] COMMIT BLOCKED — read the messages above, then pick the case that matches." >&2
          echo "  1. A silent catch needs a console.warn, a throw, a read of the error, or a '// swallow-ok: <reason>' comment inside it." >&2
          echo "  2. A long list for one file means the file is over its baseline count and eslint lists ALL its silent catches." >&2
          echo "     The new one is in the lines you changed: git diff --cached -U0 -- <file>" >&2
          echo "  3. 'suppressions left that do not occur anymore' means you fixed an old silent catch. Prune the baseline and stage it:" >&2
          echo "       ESLINT_USE_FLAT_CONFIG=true npx --prefix .qa-scan eslint --suppressions-location scripts/eslint-suppressions.json --prune-suppressions ${ESLINT_FILES}" >&2
          echo "       git add scripts/eslint-suppressions.json" >&2
          echo "  4. Anything else (no-undef, a config error): fix what eslint reports above. Do not add other rules to the baseline." >&2
          exit 1
        fi
        echo "[script-graph] checking executeScript page functions are closure-free"
        if ! node "$REPO_ROOT/scripts/script-graph-lint.mjs"; then
          echo ""
          echo "[script-graph] COMMIT BLOCKED — an executeScript page function reaches outside its own body (see the message above)" >&2
          exit 1
        fi
      fi
    else
      echo "[eslint] WARNING: .qa-scan/node_modules (eslint, espree) not found, so eslint, the rule self-test and script-graph-lint were skipped (run CI or verify.sh to cover them)" >&2
    fi
  fi
fi

# ---- slice-anchor group: tests cut runtime source by a marker; the count only shrinks ----
if [ -n "$SLICE_CHANGED" ]; then
  if [ -n "$SLICE_BASELINE_STAGED" ] && git cat-file -e HEAD:scripts/slice-anchor-baseline.json 2>/dev/null; then
    if ! git cat-file -e :scripts/slice-anchor-baseline.json 2>/dev/null; then
      echo ""
      echo "[slice-anchor] COMMIT BLOCKED — scripts/slice-anchor-baseline.json cannot be deleted or renamed." >&2
      echo "  Restore it: git restore --staged --worktree scripts/slice-anchor-baseline.json" >&2
      echo "  To shrink it, remove slice anchors from the tests and run: node scripts/slice-anchor-lint.mjs --update" >&2
      exit 1
    fi
    SLICE_TMP=$(mktemp -d)
    git show HEAD:scripts/slice-anchor-baseline.json > "$SLICE_TMP/old.json"
    git show :scripts/slice-anchor-baseline.json > "$SLICE_TMP/new.json"
    if ! node "$REPO_ROOT/scripts/slice-anchor-lint.mjs" --compare "$SLICE_TMP/old.json" "$SLICE_TMP/new.json"; then
      rm -rf "$SLICE_TMP"
      echo ""
      echo "[slice-anchor] COMMIT BLOCKED — the baseline only shrinks; a rise needs --update --allow-growth \"<reason>\" (see the message above)" >&2
      exit 1
    fi
    rm -rf "$SLICE_TMP"
  fi
  # The count reads the working tree, like every other group in this hook
  # (node --check, eslint): a new anchor staged while the refreshed baseline
  # is left unstaged passes here. CI runs the same lint on the pushed tree
  # against the committed baseline and catches that.
  if [ -d "$REPO_ROOT/.qa-scan/node_modules/espree" ] && [ -d "$REPO_ROOT/.qa-scan/node_modules/eslint-scope" ]; then
    echo "[slice-anchor] counting slice anchors in tests/ against scripts/slice-anchor-baseline.json"
    if ! node "$REPO_ROOT/scripts/slice-anchor-lint.mjs"; then
      echo ""
      echo "[slice-anchor] COMMIT BLOCKED — a test cuts more runtime source by a marker than the baseline allows (see the message above)" >&2
      exit 1
    fi
    if [ -n "$SLICE_TOOLS_CHANGED" ]; then
      echo "[slice-anchor] checking the lint against its samples"
      if ! node "$REPO_ROOT/tests/slice-anchor-lint-tests.mjs"; then
        echo ""
        echo "[slice-anchor] COMMIT BLOCKED — the slice-anchor lint self-test failed" >&2
        exit 1
      fi
    fi
  else
    echo "[slice-anchor] WARNING: .qa-scan/node_modules (espree, eslint-scope) not found, so the slice-anchor lint was skipped (run CI or verify.sh to cover it)" >&2
  fi
fi

if [ -n "$AUDIT_CHANGED" ]; then
  echo "[audit-scope] checking scenario routing (no product browser matrix)"
  for scope_test in "$REPO_ROOT"/tests/audit*-tests.mjs; do
    node "$scope_test" || exit 1
  done
fi

if [ -n "$VERIFY_GROUPS_CHANGED" ]; then
  echo "[verify-groups] checking that the verify groups still cover every gate exactly once"
  if ! node "$REPO_ROOT/tests/verify-groups-tests.mjs"; then
    echo ""
    echo "[verify-groups] COMMIT BLOCKED — verify.sh, the page runner or the flake recorder no longer match tests/verify-groups-tests.mjs (see the message above)" >&2
    exit 1
  fi
fi

if [ -n "$AI_PROVIDERS_CHANGED" ]; then
  if [ -d "$REPO_ROOT/.qa-scan/node_modules/espree" ]; then
    echo "[ai-providers] checking AI provider single-source sync and AST no-second-copy gate"
    if ! node "$REPO_ROOT/scripts/sync-ai-providers.mjs" --check || ! node "$REPO_ROOT/tests/ai-providers-source-tests.mjs"; then
      echo ""
      echo "[ai-providers] COMMIT BLOCKED — AI provider definitions drifted or a hand-written second copy exists (run: node scripts/sync-ai-providers.mjs --write)" >&2
      exit 1
    fi
  else
    echo "[ai-providers] WARNING: .qa-scan/node_modules/espree not found, so the AST sync gate was skipped (run CI or verify.sh to cover it)" >&2
  fi
fi

if [ -n "$SETTINGS_SCHEMA_CHANGED" ]; then
  if [ -d "$REPO_ROOT/.qa-scan/node_modules/espree" ]; then
    echo "[settings-schema] checking settings schema single-source sync, DOM coverage and AST gate"
    if ! node "$REPO_ROOT/scripts/sync-settings-schema.mjs" --check || ! node "$REPO_ROOT/tests/settings-schema-tests.mjs"; then
      echo ""
      echo "[settings-schema] COMMIT BLOCKED — settings schema drifted, DOM coverage is incomplete, or an unschema'd setting exists (run: node scripts/sync-settings-schema.mjs --write)" >&2
      exit 1
    fi
  else
    echo "[settings-schema] WARNING: .qa-scan/node_modules/espree not found, so the settings-schema sync gate was skipped (run CI or verify.sh to cover it)" >&2
  fi
fi

if [ -n "$TYPECHECK_CHANGED" ]; then
  if [ -d "$REPO_ROOT/.qa-scan/node_modules/typescript" ] && [ -d "$REPO_ROOT/.qa-scan/node_modules/@types/chrome" ]; then
    echo "[typecheck] checking JSDoc and null-safety types on the pure data-layer modules"
    if ! node "$REPO_ROOT/scripts/typecheck-data-layer.mjs" || ! node "$REPO_ROOT/tests/typecheck-data-layer-tests.mjs"; then
      echo ""
      echo "[typecheck] COMMIT BLOCKED — pure data-layer typecheck or its self-tests failed (see the message above)" >&2
      exit 1
    fi
  else
    echo "[typecheck] WARNING: .qa-scan/node_modules (typescript, @types/chrome) not found, so the data-layer typecheck gate was skipped (run: npm ci --prefix .qa-scan)" >&2
  fi
fi

if [ -n "$RUNTIME_MESSAGES_CHANGED" ]; then
  if [ -d "$REPO_ROOT/.qa-scan/node_modules/espree" ]; then
    echo "[runtime-messages] checking runtime message single-source sync, MV3 onMessage channel rules and AST parity"
    if ! node "$REPO_ROOT/scripts/sync-runtime-messages.mjs" --check || ! node "$REPO_ROOT/tests/runtime-messages-tests.mjs"; then
      echo ""
      echo "[runtime-messages] COMMIT BLOCKED — runtime messages drifted, an unregistered sender/listener exists, or MV3 onMessage channel rules failed (run: node scripts/sync-runtime-messages.mjs --write)" >&2
      exit 1
    fi
  else
    echo "[runtime-messages] WARNING: .qa-scan/node_modules/espree not found, so the runtime-messages AST gate was skipped (run CI or verify.sh to cover it)" >&2
  fi
fi

if [ -n "$CHANGED" ]; then
echo "[drift-guard] theme-surface files changed — running read-only factory gates"
echo "$CHANGED" | sed 's/^/  /'
cd "$REPO_ROOT/docs/theme-surface" || exit 1

echo "[css-syntax] checking complex selector/declaration parsing contracts"
if ! node "$REPO_ROOT/tests/theme-css-syntax-tests.mjs"; then
  echo ""
  echo "[css-syntax] COMMIT BLOCKED — shared CSS scanner regressed on nested syntax or at-rule context" >&2
  exit 1
fi

echo "[ui-derive] checking shared post-override role derivation"
if ! node "$REPO_ROOT/tests/theme-ui-derive-tests.mjs"; then
  echo ""
  echo "[ui-derive] COMMIT BLOCKED — shared UI control derivation contract regressed" >&2
  exit 1
fi

echo "[override-debt-test] checking structural ratchet behavior"
if ! node "$REPO_ROOT/tests/theme-override-debt-tests.mjs"; then
  echo ""
  echo "[override-debt-test] COMMIT BLOCKED — override debt ratchet no longer detects identity swaps" >&2
  exit 1
fi

echo "[theme-sync] verifying the complete factory pipeline without writing files"
if ! node tools/sync-all.mjs --check; then
  echo ""
  echo "[theme-sync] COMMIT BLOCKED — generated artifacts drifted or a factory gate failed" >&2
  echo "  Fix: node docs/theme-surface/tools/sync-all.mjs" >&2
  exit 1
fi

echo "[token-coverage] checking composer v() references against resolved tokens"
if ! node tools/token-coverage.mjs; then
  echo ""
  echo "[token-coverage] COMMIT BLOCKED — composer references a token no theme defines" >&2
  echo "  Fix: define the token in palette/typo/space/radius/border, add a fallback" >&2
  echo "       in composers/_util.mjs#expandPalette, or correct the typo in the composer" >&2
  exit 1
fi

echo "[cascade-lint] checking pattern cascade resolution"
if ! node tools/cascade-lint.mjs; then
  echo ""
  echo "[cascade-lint] COMMIT BLOCKED — cascade conflict detected" >&2
  echo "  Diagnose: node docs/theme-surface/tools/cascade-lint.mjs --verbose" >&2
  exit 1
fi

echo "[override-drift] checking per-theme overrides for unscoped duplicates"
if ! node tools/override-drift.mjs; then
  echo ""
  echo "[override-drift] COMMIT BLOCKED — override re-broadens composer-narrowed selector" >&2
  echo "  Fix: add the composer's :not(...) exclusions to the override selector" >&2
  exit 1
fi

echo "[handedit-audit] checking pinboard-themes.js for rules not produced by composer"
if ! node tools/handedit-audit.mjs; then
  echo ""
  echo "[handedit-audit] COMMIT BLOCKED — hand-edited rule detected in pinboard-themes.js" >&2
  echo "  Diagnose: node docs/theme-surface/tools/handedit-audit.mjs --verbose" >&2
  echo "  Fix: migrate the rule to composers/ or pilots/<slug>.tokens.json overrides.css, then re-run sync-all" >&2
  exit 1
fi

echo "[ui-contract] checking static UI contracts (hex/rgba ratchet, var-fallback consistency, chip geometry)"
if ! node "$REPO_ROOT/tests/ui-contract-tests.mjs"; then
  echo ""
  echo "[ui-contract] COMMIT BLOCKED — a hand-maintained popup.css/options.css/library.css contract regressed" >&2
  exit 1
fi
fi

# ---- UI consumer group: fast static gates on the markup/JS side ----
cd "$REPO_ROOT" || exit 1
if [ -n "$UI_HTML_CHANGED" ] && [ -z "$CHANGED" ]; then
  echo "[ui-consumer] surface HTML / reader CSS / surface JS changed — running the static design-language gates"
  echo "$UI_HTML_CHANGED" | sed 's/^/  /'
  echo "[layout-lint] checking inline spacing on the four UI surfaces"
  if ! node "$REPO_ROOT/docs/theme-surface/tools/layout-lint.mjs"; then
    echo ""
    echo "[layout-lint] COMMIT BLOCKED — inline spacing or a layout blocker (move it to a relationship rule / spacing token in the surface CSS)" >&2
    exit 1
  fi
  echo "[ui-contract] checking static UI contracts (HTML semantics, ids, hidden/aria, reader CSS roles)"
  if ! node "$REPO_ROOT/tests/ui-contract-tests.mjs"; then
    echo ""
    echo "[ui-contract] COMMIT BLOCKED — a hand-maintained HTML/CSS contract regressed" >&2
    exit 1
  fi
fi
if [ -n "$UI_VOCAB_CHANGED" ]; then
  echo "[ui-vocabulary] checking structural class tokens against the registry and the legacy baseline"
  if ! node "$REPO_ROOT/scripts/ui-vocabulary-lint.mjs"; then
    echo ""
    echo "[ui-vocabulary] COMMIT BLOCKED — a new structural class token; reuse a registered primitive or register it (docs/theme-surface/ui-vocabulary.json + COMPONENTS.md §10)" >&2
    exit 1
  fi
fi
