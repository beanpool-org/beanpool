#!/bin/bash
# test-all-merge-check.sh — exits 0 only if a green `test-all.sh --all` run covers merging this PR into current main.
#
#   bash scripts/test-all-merge-check.sh <PR number or URL>
#   bash scripts/test-all-merge-check.sh --head <sha> [--base <branch>]    (no GitHub lookup; its own test uses this)
#
# Merges into main rest on a local test-all run (Marty, 2026-09-30); this is the check a merge hook calls. test-all.sh
# --all appends "<epoch> <commit> <tree> <wall-seconds>" to <git common dir>/test-all-green after a run that passed
# every check on a clean, committed tree (scripts/test-all-lib.sh). A PR is covered by a green commit G when:
#
#   - G contains the PR head,
#   - every non-merge commit on origin/<base> is also in G, and
#   - G's tree is exactly the tree that merging the PR head into origin/<base> gives (`git merge-tree --write-tree`).
#
# Together those say G was the PR merged with main as main stands now: since G was tested, main has gained nothing G
# lacks, and G holds nothing beyond the PR and main. The tree check is what refuses a superset: a green run of a branch
# stacked on this PR contains the PR head and all of main, but it tested the stacked branch's changes too, which may
# mask something this PR breaks on its own. A squash merge lands as one new non-merge commit, so every merge moves main
# past every green record and the next PR needs a run on the new main — which is the point. scripts/test-all-pr.sh
# makes such a G and runs it.
#
# It works on the repository of the current directory. It fetches origin/<base> first and fails closed if it cannot:
# a stale origin/main would let a PR through that nothing tested against the main it lands on. Prints why when it fails.

set -o pipefail

usage() { echo "usage: $0 <PR number or URL> | --head <sha> [--base <branch>]" >&2; exit 2; }

PR=""; HEAD_SHA=""; BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --head) HEAD_SHA="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$PR" ] || usage; PR="$1"; shift ;;
  esac
done
[ -n "$PR" ] || [ -n "$HEAD_SHA" ] || usage
[ -n "$PR" ] && [ -n "$HEAD_SHA" ] && usage

git rev-parse --git-dir >/dev/null 2>&1 || { echo "❌ test-all merge check: not inside a git repository." >&2; exit 2; }

LABEL=""
if [ -n "$PR" ]; then
  if ! INFO=$(gh pr view "$PR" --json number,headRefOid,baseRefName --jq '"\(.number) \(.headRefOid) \(.baseRefName)"' 2>&1); then
    echo "❌ test-all merge check: could not look up PR $PR: $INFO"
    exit 1
  fi
  read -r NUM HEAD_SHA PR_BASE <<< "$INFO"
  BASE="${BASE:-$PR_BASE}"
  LABEL="PR #$NUM into $BASE"
else
  LABEL="$(echo "$HEAD_SHA" | cut -c1-9) into ${BASE:-main}"
fi
BASE="${BASE:-main}"
BASE_REF="origin/$BASE"

if ! git fetch --quiet origin "$BASE" 2>/dev/null; then
  echo "❌ test-all merge check: $LABEL: could not fetch $BASE_REF, so what main is now cannot be known. Not covered."
  exit 1
fi
if ! git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null && [ -n "$PR" ]; then
  git fetch --quiet origin "pull/$NUM/head" 2>/dev/null
fi
if ! git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null; then
  echo "❌ test-all merge check: $LABEL: head $HEAD_SHA is not in this repository. Not covered."
  exit 1
fi
HEAD_SHA=$(git rev-parse "$HEAD_SHA^{commit}")

GATE_LOG="$(git rev-parse --path-format=absolute --git-common-dir)/test-all-green"

# The tree that landing the PR on current main produces. Empty when it does not merge cleanly (merge-tree exits 1 and
# its first line is then a tree with conflict markers), so nothing can match it.
LAND_TREE=$(git merge-tree --write-tree "$BASE_REF" "$HEAD_SHA" 2>/dev/null | head -n 1) || LAND_TREE=""

age() {
  local mins=$(( ($(date +%s) - $1) / 60 ))
  if [ $mins -lt 120 ]; then echo "$mins min"; else echo "$((mins / 60)) h"; fi
}

# Newest first. A line is "<epoch> <commit> <tree> [<wall-seconds>]"; one whose commit is gone, or whose commit does
# not have the tree it names, is skipped.
NEWEST=""
if [ -f "$GATE_LOG" ]; then
  while read -r ts commit tree wall; do
    [ -n "$commit" ] || continue
    git cat-file -e "$commit^{commit}" 2>/dev/null || continue
    [ "$(git rev-parse "$commit^{tree}")" = "$tree" ] || continue
    [ -n "$NEWEST" ] || NEWEST="$ts $commit"
    git merge-base --is-ancestor "$HEAD_SHA" "$commit" 2>/dev/null || continue
    [ -z "$(git rev-list --no-merges --max-count=1 "$BASE_REF" "^$commit")" ] || continue
    [ -n "$LAND_TREE" ] && [ "$tree" = "$LAND_TREE" ] || continue
    echo "✅ test-all merge check: $LABEL is covered by green run $(git rev-parse --short "$commit") ($(age "$ts") ago${wall:+, ${wall}s})."
    exit 0
  done < <(tail -n 500 "$GATE_LOG" | awk '{ line[NR] = $0 } END { for (i = NR; i >= 1; i--) print line[i] }')
fi

if [ -z "$LAND_TREE" ]; then
  WHY="the PR head $(git rev-parse --short "$HEAD_SHA") does not merge cleanly with $BASE_REF, so no run can have tested it as it would land"
elif [ -z "$NEWEST" ]; then
  WHY="no green \`test-all.sh --all\` run is recorded in this checkout ($GATE_LOG)"
else
  read -r ts commit <<< "$NEWEST"
  MISSING=$(git rev-list --no-merges --count "$BASE_REF" "^$commit")
  if ! git merge-base --is-ancestor "$HEAD_SHA" "$commit" 2>/dev/null; then
    WHY="the newest green run, $(git rev-parse --short "$commit") ($(age "$ts") ago), does not contain the PR head $(git rev-parse --short "$HEAD_SHA"), and no older one covers it"
  elif [ "$MISSING" != "0" ]; then
    WHY="the newest green run, $(git rev-parse --short "$commit") ($(age "$ts") ago), is missing $MISSING commit(s) that have landed on $BASE_REF since, and no older one covers it"
  else
    WHY="the newest green run, $(git rev-parse --short "$commit") ($(age "$ts") ago), tested a different tree than this PR merged with main ($(git rev-parse --short "$(git rev-parse "$commit^{tree}")") there, $(git rev-parse --short "$LAND_TREE") here: a branch stacked on the PR, say), and no older one covers it"
  fi
fi
echo "❌ test-all merge check: $LABEL is not covered: $WHY."
echo "   Test it as it would land: bash scripts/test-all-pr.sh ${NUM:-<PR>} (current $BASE_REF merged with the PR head, test-all --all)."
exit 1
