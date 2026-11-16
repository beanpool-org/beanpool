#!/bin/bash
# scripts/lanes/ci-wait.sh <PR> — wait for GitHub CI on the PR's CURRENT head, then print the verdict with every red's failing lines.
#
# For lanes (Marty, 16 Nov 2026: "send more checks to GitHub CI, the Mac is overloaded"). A lane runs only the one test file or
# suite it is working on, pushes, and reads every whole-app check here; LANE_ONE_PUSH in lib.sh gives a stage the whole flow.
# One call runs at most ~9 minutes, so a headless lane's foreground Bash call never hits the tool's 10-minute cap: call it again
# while it says PENDING. Read-only: it never comments, re-runs, requeues or boards. A red's lines come from pr-state.mjs.
#
# Exit: 0 GREEN, 1 RED (failing lines printed), 2 PENDING (call again), 3 head moved / unreadable.
#
# Settings: LANE_GH_REPO (default: this checkout's origin, read as lib.sh reads it); LANE_CI_WAIT_SECS (530) and
# LANE_CI_WAIT_POLL_SECS (45), the length of one call and its poll; CI_WAIT_PR_STATE, the reader of a red (default: pr-state.mjs
# beside this file). scripts/lanes/test/ci-wait-slot.test.sh runs it against the fake gh.
HERE=$(cd "$(dirname "$0")" && pwd)
PR=$1; [ -n "$PR" ] || { echo "usage: ci-wait.sh <PR>"; exit 3; }
R=${LANE_GH_REPO:-$(git -C "$HERE" remote get-url origin 2>/dev/null | sed -E 's#^(git@[^:]+:|https?://[^/]+/)##; s#\.git$##')}
case "$R" in */*) ;; *) R=beanpool-org/beanpool;; esac
READER=${CI_WAIT_PR_STATE:-$HERE/pr-state.mjs}
POLL=${LANE_CI_WAIT_POLL_SECS:-45}
END=$(( $(date +%s) + ${LANE_CI_WAIT_SECS:-530} ))
head=$(gh pr view "$PR" -R "$R" --json headRefOid --jq .headRefOid 2>/dev/null)
[ -n "$head" ] || { echo "PR unreadable"; exit 3; }
while :; do
  cur=$(gh pr view "$PR" -R "$R" --json headRefOid --jq .headRefOid 2>/dev/null)
  [ -n "$cur" ] || { echo "PR unreadable (GitHub gave no head): call ci-wait.sh $PR again"; exit 3; }
  [ "$cur" = "$head" ] || { echo "HEAD MOVED to ${cur:0:8} (you pushed again): call ci-wait.sh again"; exit 3; }
  # Buckets are gh's: pass, fail, pending, skipping, cancel. No checks yet reads as empty, which is a wait, never green.
  s=$(gh pr checks "$PR" -R "$R" --json bucket --jq '[.[].bucket]|group_by(.)|map("\(.[0])=\(length)")|join(" ")' 2>/dev/null)
  case "$s" in
    ""|*pending*) [ "$(date +%s)" -ge "$END" ] && { echo "PENDING on ${head:0:8} ($s): call ci-wait.sh $PR again"; exit 2; }; sleep "$POLL" ;;
    *fail*|*cancel*) echo "RED on ${head:0:8} ($s)"
       node "$READER" "$PR" -R "$R" 2>&1 | sed -n '/^checks/,/^SUMMARY/p'
       exit 1 ;;
    *) echo "GREEN on ${head:0:8} ($s)"; exit 0 ;;
  esac
done
