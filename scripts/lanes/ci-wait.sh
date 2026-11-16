#!/bin/bash
# scripts/lanes/ci-wait.sh <PR> [<sha you pushed>] — wait for GitHub CI on that commit (with no sha: the PR's head at call time),
# then print the verdict with every red's failing lines.
#
# For lanes (Marty, 16 Nov 2026: "send more checks to GitHub CI, the Mac is overloaded"). A lane runs only the one test file or
# suite it is working on, pushes, and reads every whole-app check here; LANE_ONE_PUSH in lib.sh gives a stage the whole flow.
# One call runs at most ~9 minutes, so a headless lane's foreground Bash call never hits the tool's 10-minute cap: call it again
# while it says PENDING. Read-only: it never comments, re-runs, requeues or boards. A red's lines come from pr-state.mjs.
#
# ALWAYS pass the sha you pushed: `ci-wait.sh <PR> $(git rev-parse HEAD)`. GitHub moves a PR's head a little after a push lands,
# so a call right after `git push` can still read the OLD head and hand back that head's verdict (#3257 round 2: a FIX-CI round
# got its old red back and pushed again). Given the sha, a head that does not show it yet is a wait, never a verdict, and every
# verdict names that sha. The checks are read before the head each time round, so a verdict is only given when the head was the
# same on both sides of the read.
#
# Exit: 0 GREEN, 1 RED (failing lines printed), 2 PENDING (call again, with the same sha), 3 head moved / unreadable / bad call.
#
# Settings: LANE_GH_REPO (default: this checkout's origin, read as lib.sh reads it); LANE_CI_WAIT_SECS (530), the length of one
# call; LANE_CI_WAIT_POLL_SECS (45), the poll of the checks; LANE_CI_WAIT_HEAD_POLL_SECS (10), the poll while GitHub has not shown
# the sha yet; CI_WAIT_PR_STATE, the reader of a red (default: pr-state.mjs beside this file).
# scripts/lanes/test/ci-wait-slot.test.sh runs it against the fake gh.
HERE=$(cd "$(dirname "$0")" && pwd)
USAGE='usage: ci-wait.sh <PR> [<sha you pushed>]   (always pass it: ci-wait.sh <PR> $(git rev-parse HEAD))'
PR=$1; WANT=$2
[ -n "$PR" ] || { echo "$USAGE"; exit 3; }
[ -z "$WANT" ] || [[ "$WANT" =~ ^[0-9a-f]{7,40}$ ]] || { echo "not a commit id: '$WANT'"; echo "$USAGE"; exit 3; }
R=${LANE_GH_REPO:-$(git -C "$HERE" remote get-url origin 2>/dev/null | sed -E 's#^(git@[^:]+:|https?://[^/]+/)##; s#\.git$##')}
case "$R" in */*) ;; *) R=beanpool-org/beanpool;; esac
READER=${CI_WAIT_PR_STATE:-$HERE/pr-state.mjs}
POLL=${LANE_CI_WAIT_POLL_SECS:-45}
HEAD_POLL=${LANE_CI_WAIT_HEAD_POLL_SECS:-10}
END=$(( $(date +%s) + ${LANE_CI_WAIT_SECS:-530} ))
pr_head(){ gh pr view "$PR" -R "$R" --json headRefOid --jq .headRefOid 2>/dev/null; }
again="call ci-wait.sh $PR${WANT:+ $WANT} again"
head=$(pr_head)
[ -n "$head" ] || { echo "PR unreadable"; exit 3; }
if [ -n "$WANT" ]; then
  # The PR shows the sha once its head is that commit; a short sha matches the head it starts.
  while [ "${head#"$WANT"}" = "$head" ]; do
    [ "$(date +%s)" -ge "$END" ] && {
      echo "PENDING: the PR doesn't show ${WANT:0:8} yet (head ${head:0:8}): check your push landed (git ls-remote origin <branch>), then $again"; exit 2; }
    sleep "$HEAD_POLL"; head=$(pr_head)
    [ -n "$head" ] || { echo "PR unreadable (GitHub gave no head): $again"; exit 3; }
  done
fi
while :; do
  # Buckets are gh's: pass, fail, pending, skipping, cancel. No checks yet reads as empty, which is a wait, never green.
  s=$(gh pr checks "$PR" -R "$R" --json bucket --jq '[.[].bucket]|group_by(.)|map("\(.[0])=\(length)")|join(" ")' 2>/dev/null)
  # The head AFTER the checks: unchanged means the checks just read were that head's, so the verdict below is about it.
  cur=$(pr_head)
  [ -n "$cur" ] || { echo "PR unreadable (GitHub gave no head): $again"; exit 3; }
  [ "$cur" = "$head" ] || { echo "HEAD MOVED to ${cur:0:8} (you pushed again): call ci-wait.sh $PR <the sha you pushed> again"; exit 3; }
  case "$s" in
    ""|*pending*) [ "$(date +%s)" -ge "$END" ] && { echo "PENDING on ${head:0:8} ($s): $again"; exit 2; }; sleep "$POLL" ;;
    *fail*|*cancel*) echo "RED on ${head:0:8} ($s)"
       node "$READER" "$PR" -R "$R" 2>&1 | sed -n '/^checks/,/^SUMMARY/p'
       exit 1 ;;
    *) echo "GREEN on ${head:0:8} ($s)"; exit 0 ;;
  esac
done
