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
# could get its old red back and push again). Given the sha, a head that does not show it yet is a wait, never a verdict, and
# every verdict names that sha. The checks are read before the head each time round, so a verdict is only given when the head was
# the same on both sides of the read.
#
# No checks: is a run coming? A PR that conflicts with its base starts no pull_request run until the branch is synced (lib.sh's
# pr_conflicting, #3201), so no checks there is exit 4, never a wait (#3257 round 3). UNKNOWN (still being worked out after a
# push), MERGEABLE and no answer stay a wait, and the PENDING line says which one it saw.
#
# A DRAFT gets ci.yml's fast check ("Draft check <part>") and the full run waits for ready (Marty, 17 Nov 2026), so what is green
# depends on it, read on every poll: a draft is GREEN once its checks passed and a "Draft check" (or the required check) is among
# them; a READY PR only once the required check "Run BeanPool Test-All Pipeline" itself passed. A ready PR's "Draft check" rows
# are the draft's run, which the full run replaces, so they are left out: neither its green nor its red speaks for the full run.
# A ready PR whose required check has not reported and that has nothing pending is a wait (ready_for_review's run has not listed
# its checks yet), never green: its draft run's skipped jobs would otherwise read as a pass.
#
# Every exit is bounded (one call, ~9 minutes) and its line says what it saw and what to do next. Exit:
# 0 GREEN; 1 RED (failing lines printed); 2 PENDING: checks still running, no checks yet (with the PR's mergeable state), or GitHub
# not showing the sha yet (call again with the same sha; the line says when a second one in a row means no run is coming);
# 3 head moved / unreadable / bad call; 4 CONFLICTING with the base: git fetch origin, merge origin/<base>, push, and wait once more with the new sha.
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
[ -e "$READER" ] || READER=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)/scripts/lanes/pr-state.mjs   # a copy outside scripts/lanes
REQ=${LANE_CI_CHECK:-Run BeanPool Test-All Pipeline}
FAST='Draft check'
POLL=${LANE_CI_WAIT_POLL_SECS:-45}
HEAD_POLL=${LANE_CI_WAIT_HEAD_POLL_SECS:-10}
END=$(( $(date +%s) + ${LANE_CI_WAIT_SECS:-530} ))
pr_head(){ gh pr view "$PR" -R "$R" --json headRefOid --jq .headRefOid 2>/dev/null; }
pr_merge(){ gh pr view "$PR" -R "$R" --json mergeable,baseRefName --jq '.mergeable + "|" + .baseRefName' 2>/dev/null; }
again="call ci-wait.sh $PR${WANT:+ $WANT} again"
head=$(pr_head)
[ -n "$head" ] || { echo "PR unreadable (GitHub gave no head for #$PR on $R): check the PR number, then $again"; exit 3; }
if [ -n "$WANT" ]; then
  # The PR shows the sha once its head is that commit; a short sha matches the head it starts.
  while [ "${head#"$WANT"}" = "$head" ]; do
    [ "$(date +%s)" -ge "$END" ] && {
      echo "PENDING: the PR doesn't show ${WANT:0:8} yet (head ${head:0:8}): check your push landed (git ls-remote origin <branch>), then $again. If the next call says this too, your push is not the PR's head (it did not land, or a later push replaced it): stop and say so in the PR"; exit 2; }
    sleep "$HEAD_POLL"; head=$(pr_head)
    [ -n "$head" ] || { echo "PR unreadable (GitHub gave no head): $again"; exit 3; }
  done
fi
while :; do
  # Draft or ready, read before the checks each time round. No answer reads as ready, the stricter: green needs the required check.
  draft=$(gh pr view "$PR" -R "$R" --json isDraft --jq .isDraft 2>/dev/null)
  [ "$draft" = true ] || draft=false
  # Buckets are gh's: pass, fail, pending, skipping, cancel. No checks yet reads as empty, which is never green: a wait, or exit 4
  # when the PR conflicts with its base. "|ok" after the counts: the check that makes it green has passed (see the header).
  q="$draft as \$d | [.[] | select(\$d or (.name | startswith(\"$FAST\") | not))] as \$c"
  q="$q | (\$c | map(.bucket) | group_by(.) | map(\"\\(.[0])=\\(length)\") | join(\" \")) + \"|\""
  q="$q + (if any(\$c[]; .bucket == \"pass\" and (.name == \"$REQ\" or (\$d and (.name | startswith(\"$FAST\"))))) then \"ok\" else \"\" end)"
  raw=$(gh pr checks "$PR" -R "$R" --json name,bucket --jq "$q" 2>/dev/null)
  IFS='|' read -r s ok <<< "$raw"
  # No checks: read whether the PR merges with its base, and which base (no answer leaves both empty; "|" keeps an empty field
  # in its place, where a space would shift the base into the mergeable state).
  m=; base=
  [ -n "$s" ] || IFS='|' read -r m base <<< "$(pr_merge)"
  # The head AFTER those reads: unchanged means what was just read was that head's, so the verdict below is about it.
  cur=$(pr_head)
  [ -n "$cur" ] || { echo "PR unreadable (GitHub gave no head): $again"; exit 3; }
  [ "$cur" = "$head" ] || { echo "HEAD MOVED to ${cur:0:8} (you pushed again): call ci-wait.sh $PR <the sha you pushed> again"; exit 3; }
  case "$s" in
    "") base=${base:-<its base>}
        [ "$m" = CONFLICTING ] && {
          echo "CONFLICTING with $base on ${head:0:8}: no pull_request run starts until the branch is synced. Run git fetch origin && git merge origin/$base, push, and call ci-wait.sh $PR \$(git rev-parse HEAD) once more; if it conflicts again, stop and say so in the PR"; exit 4; }
        case "$m" in
          MERGEABLE) why="it merges with $base, but no run has listed a check yet";;
          UNKNOWN)   why="GitHub is still working out whether it merges with $base";;
          *)         why="GitHub did not say whether it merges with $base";;
        esac
        [ "$(date +%s)" -ge "$END" ] && {
          echo "PENDING on ${head:0:8} (no checks yet: $why): $again. If the next call says no checks yet too, no run is coming: stop and say so in the PR"; exit 2; }
        sleep "$POLL" ;;
    *pending*) [ "$(date +%s)" -ge "$END" ] && { echo "PENDING on ${head:0:8} ($s): $again"; exit 2; }; sleep "$POLL" ;;
    *fail*|*cancel*) echo "RED on ${head:0:8} ($s)"
       node "$READER" "$PR" -R "$R" 2>&1 | sed -n '/^checks/,/^SUMMARY/p'
       exit 1 ;;
    *) if [ "$ok" = ok ]; then
         if [ "$draft" = true ]; then echo "GREEN on ${head:0:8} ($s; a draft: its fast check passed, the full run starts when it is marked ready)"
         else echo "GREEN on ${head:0:8} ($s)"; fi
         exit 0
       fi
       if [ "$draft" = true ]; then why="a draft, and no \"$FAST\" has reported"
       else why="the required check \"$REQ\" has not reported: the full run starts when the PR is marked ready, and lists it last"; fi
       [ "$(date +%s)" -ge "$END" ] && {
         echo "PENDING on ${head:0:8} ($s; $why): $again. If the next call says this too and the PR is ready, no full run is coming: stop and say so in the PR"; exit 2; }
       sleep "$POLL" ;;
  esac
done
