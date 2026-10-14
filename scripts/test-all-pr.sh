#!/bin/bash
# test-all-pr.sh — tests a PR the way it would land, and on green says so on the PR.
#
#   bash scripts/test-all-pr.sh <PR number or URL> [--no-status] [--keep]
#
# Makes a scratch worktree at origin/<base>, merges the PR head into it, installs, and runs `test-all.sh --all` there.
# A green run records the merged commit in <git common dir>/test-all-green (shared by every worktree, so
# scripts/test-all-merge-check.sh sees it from any of them), and this then posts a commit status on the PR head:
# context "local test-all --all", with main's commit, the tested tree and the wall time. A failing run posts nothing.
#
#   --no-status   run and record, but post nothing to GitHub
#   --keep        leave the scratch worktree in place (it is removed otherwise, pass or fail)
#
# It works on the repository of the current directory, and never touches that directory's own checkout. The merge is
# committed under your git identity. A PR that does not merge cleanly with main is refused: resolve that on its branch.
# The test-all.sh that runs is the one in the merged tree, so a PR that changes it is tested by its own version.

set -o pipefail

usage() { echo "usage: $0 <PR number or URL> [--no-status] [--keep]" >&2; exit 2; }
PR=""; POST=1; KEEP=0
for arg in "$@"; do
  case "$arg" in
    --no-status) POST=0 ;;
    --keep) KEEP=1 ;;
    -*) usage ;;
    *) [ -z "$PR" ] || usage; PR="$arg" ;;
  esac
done
[ -n "$PR" ] || usage
git rev-parse --git-dir >/dev/null 2>&1 || { echo "❌ not inside a git repository." >&2; exit 2; }

if ! INFO=$(gh pr view "$PR" --json number,headRefOid,baseRefName,url --jq '"\(.number) \(.headRefOid) \(.baseRefName) \(.url)"' 2>&1); then
  echo "❌ could not look up PR $PR: $INFO"
  exit 1
fi
read -r NUM HEAD_SHA BASE URL <<< "$INFO"
# https://github.com/<owner>/<repo>/pull/<n>
REPO=$(echo "$URL" | sed -E 's|^https?://[^/]+/([^/]+/[^/]+)/pull/.*$|\1|')

echo "PR #$NUM: head $(echo "$HEAD_SHA" | cut -c1-9), base $BASE"
if ! git fetch --quiet origin "$BASE" "pull/$NUM/head"; then
  echo "❌ could not fetch origin/$BASE and the PR head"
  exit 1
fi
git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || { echo "❌ the PR head $HEAD_SHA is not in this repository after fetching"; exit 1; }
MAIN_SHA=$(git rev-parse "origin/$BASE")

ORIG_DIR=$(pwd)
WT=$(mktemp -d "${TMPDIR:-/tmp}/test-all-pr-$NUM.XXXXXX") || exit 1
cleanup() {
  cd "$ORIG_DIR" || return
  if [ $KEEP -eq 1 ]; then
    echo "Scratch worktree kept: $WT"
  else
    git worktree remove --force "$WT" >/dev/null 2>&1
    rm -rf "$WT"
    git worktree prune >/dev/null 2>&1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

git worktree add --quiet --detach "$WT" "$MAIN_SHA" || { echo "❌ could not make a scratch worktree at $WT"; exit 1; }
cd "$WT" || exit 1
if ! git merge --quiet --no-edit -m "test-all-pr: PR #$NUM ($(echo "$HEAD_SHA" | cut -c1-9)) merged with origin/$BASE ($(echo "$MAIN_SHA" | cut -c1-9))" "$HEAD_SHA" >/dev/null 2>&1; then
  git merge --abort >/dev/null 2>&1
  echo "❌ PR #$NUM does not merge cleanly with origin/$BASE ($(echo "$MAIN_SHA" | cut -c1-9)). Resolve that on the PR branch first."
  exit 1
fi
TESTED=$(git rev-parse HEAD)
echo "Testing $(git rev-parse --short HEAD): origin/$BASE $(echo "$MAIN_SHA" | cut -c1-9) + PR #$NUM, in $WT"

if [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile --reporter=silent || { echo "❌ pnpm install failed in the scratch worktree"; exit 1; }
fi

bash scripts/test-all.sh --all
RC=$?
if [ $RC -ne 0 ]; then
  echo ""
  echo "❌ test-all --all failed on PR #$NUM merged with origin/$BASE. Nothing posted."
  exit $RC
fi

GATE_LOG="$(git rev-parse --path-format=absolute --git-common-dir)/test-all-green"
RECORD=$(awk -v c="$TESTED" '$2 == c { line = $0 } END { print line }' "$GATE_LOG" 2>/dev/null)
if [ -z "$RECORD" ]; then
  echo "❌ test-all passed but recorded no green run for $TESTED (see its last lines above). Nothing posted."
  exit 1
fi
read -r _ts _commit TREE WALL <<< "$RECORD"
DESC="green: origin/$BASE $(echo "$MAIN_SHA" | cut -c1-9) + this head, tree $(echo "$TREE" | cut -c1-9), ${WALL:-?}s"

if [ $POST -eq 0 ]; then
  echo "✅ green; --no-status, so nothing posted ($DESC)"
  exit 0
fi
if gh api --silent "repos/$REPO/statuses/$HEAD_SHA" -f state=success -f context="local test-all --all" -f description="$DESC"; then
  echo "✅ green; posted \"local test-all --all\" on PR #$NUM's head $(echo "$HEAD_SHA" | cut -c1-9): $DESC"
else
  echo "⚠️  green and recorded, but posting the status on $REPO@$HEAD_SHA failed."
  exit 1
fi
