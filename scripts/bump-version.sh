#!/usr/bin/env bash
set -euo pipefail

# Cumulative version bump.
#
# Scans commits since the latest GitHub release tag, picks the highest
# conventional-commit type, and bumps manifest.json accordingly.
#
# Bump rules (same as the old commit-msg hook):
#   BREAKING CHANGE   → major
#   feat:             → minor
#   fix|refactor|perf → patch
#   chore|docs|test|style|ci → no contribution
#
# Usage:
#   scripts/bump-version.sh            # bump + commit
#   scripts/bump-version.sh --dry-run  # show what would change, no write
#   scripts/bump-version.sh --force-patch  # force patch even if no qualifying commits

REPO_ROOT=$(git rev-parse --show-toplevel)
MANIFEST="${REPO_ROOT}/manifest.json"
cd "${REPO_ROOT}"

DRY_RUN=0
FORCE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force-patch) FORCE="patch" ;;
    --force-minor) FORCE="minor" ;;
    --force-major) FORCE="major" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# The public Release, not the highest Git tag, is the versioning baseline. An
# orphan/draft tag must never hide changes or make the result depend on local refs.
if ! command -v gh >/dev/null 2>&1; then
  echo "  ERROR: gh CLI is required to resolve the latest published Release." >&2
  exit 1
fi
if ! PREV_TAG=$(gh release view --json tagName --jq .tagName 2>/dev/null) || [ -z "${PREV_TAG}" ]; then
  echo "  ERROR: could not resolve the latest published GitHub Release." >&2
  exit 1
fi

# release.sh creates tags remotely; fetch only the authoritative base when it is
# absent locally. Never fall back to an arbitrary tag or a truncated commit list.
if ! git rev-parse -q --verify "${PREV_TAG}^{commit}" >/dev/null 2>&1; then
  if ! git fetch --quiet origin "refs/tags/${PREV_TAG}:refs/tags/${PREV_TAG}"; then
    echo "  ERROR: published Release tag ${PREV_TAG} is not resolvable locally." >&2
    exit 1
  fi
fi
if ! REMOTE_TAG_REFS=$(git ls-remote origin "refs/tags/${PREV_TAG}" "refs/tags/${PREV_TAG}^{}"); then
  echo "  ERROR: could not verify published Release tag ${PREV_TAG} on origin." >&2
  exit 1
fi
REMOTE_TAG_SHA=$(printf '%s\n' "${REMOTE_TAG_REFS}" | awk '
  $2 ~ /\^\{\}$/ { peeled = $1 }
  $2 !~ /\^\{\}$/ { direct = $1 }
  END { print peeled ? peeled : direct }
')
LOCAL_TAG_SHA=$(git rev-parse "${PREV_TAG}^{commit}")
if [ -z "${REMOTE_TAG_SHA}" ] || [ "${LOCAL_TAG_SHA}" != "${REMOTE_TAG_SHA}" ]; then
  echo "  ERROR: local ${PREV_TAG} does not match the immutable origin tag." >&2
  exit 1
fi
if ! git merge-base --is-ancestor "${PREV_TAG}^{commit}" HEAD; then
  echo "  ERROR: published Release tag ${PREV_TAG} is not an ancestor of HEAD." >&2
  exit 1
fi

echo "  Scanning commits since ${PREV_TAG}..HEAD"
RANGE_ARGS=("${PREV_TAG}..HEAD")

BUMP=$(python3 - "${FORCE}" "${RANGE_ARGS[@]}" <<'PYEOF'
import sys, subprocess, re

force = sys.argv[1]
git_args = sys.argv[2:]

result = subprocess.run(
    ["git", "log", "--pretty=format:%B%x1e", "--no-merges", *git_args],
    capture_output=True, text=True, check=False,
)
if result.returncode != 0:
    print(result.stderr.strip() or "git log failed", file=sys.stderr)
    raise SystemExit(result.returncode)

messages = [m.strip() for m in result.stdout.split("\x1e") if m.strip()]

bump = ""
breaking = re.compile(r'(^|\n)BREAKING(?: CHANGE|-CHANGE):')
feat = re.compile(r'^feat(?:\([^)]+\))?:')
patch_kinds = re.compile(r'^(?:fix|refactor|perf)(?:\([^)]+\))?:')
bang = re.compile(r'^\w+(?:\([^)]+\))?!:')

rank = {"": 0, "patch": 1, "minor": 2, "major": 3}

for msg in messages:
    subject = msg.splitlines()[0]
    if breaking.search(msg) or bang.match(subject):
        cand = "major"
    elif feat.match(subject):
        cand = "minor"
    elif patch_kinds.match(subject):
        cand = "patch"
    else:
        continue
    if rank[cand] > rank[bump]:
        bump = cand

if force and rank[force] > rank[bump]:
    bump = force

print(bump)
PYEOF
)

if [ -z "${BUMP}" ]; then
  echo "  No qualifying commits since last release. Nothing to bump."
  echo "  (Use --force-patch to bump anyway.)"
  exit 0
fi

echo "  Bump type: ${BUMP}"

VERSION_RESULT=$(python3 - "${MANIFEST}" "${PREV_TAG}" "${BUMP}" "${DRY_RUN}" <<'PYEOF'
import sys, json

manifest_path, base_tag, bump, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"

with open(manifest_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

current = data.get('version', '0.0')

def parse_version(value, label):
    raw = value[1:] if value.startswith('v') else value
    parts = raw.split('.')
    if len(parts) not in (2, 3) or any(not p.isdigit() for p in parts):
        raise SystemExit(f"ERROR: invalid {label} version: {value}")
    nums = tuple(int(p) for p in parts)
    return nums + (0,) * (3 - len(nums))

current_tuple = parse_version(current, 'manifest')
major, minor, patch = parse_version(base_tag, 'Release tag')

if bump == 'major':
    major += 1; minor = 0; patch = 0
    new_ver = f"{major}.0"
elif bump == 'minor':
    minor += 1; patch = 0
    new_ver = f"{major}.{minor}"
else:
    patch += 1
    new_ver = f"{major}.{minor}.{patch}"

target_tuple = parse_version(new_ver, 'target')
if current_tuple > target_tuple:
    raise SystemExit(
        f"ERROR: manifest {current} is newer than computed target {new_ver}; refusing to downgrade"
    )

if current_tuple == target_tuple:
    print(f"  {current} already matches target from {base_tag}", file=sys.stderr)
else:
    print(f"  {current} → {new_ver} (base {base_tag})", file=sys.stderr)

if not dry and current_tuple < target_tuple:
    data['version'] = new_ver
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')

print(f"{new_ver}|{int(current_tuple < target_tuple)}")
PYEOF
)
NEW_VER=${VERSION_RESULT%%|*}
VERSION_CHANGED=${VERSION_RESULT##*|}

if [ "${VERSION_CHANGED}" = "0" ]; then
  echo "  Manifest already matches the computed target. Nothing to bump."
  exit 0
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "  Dry run; manifest not modified."
  exit 0
fi

git add "${MANIFEST}"
git commit --only -m "chore: bump manifest to ${NEW_VER}" -- "${MANIFEST}"

echo ""
echo "  Bumped to ${NEW_VER}. Next: scripts/release.sh"
