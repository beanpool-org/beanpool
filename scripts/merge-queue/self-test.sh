#!/bin/bash
# self-test.sh [--run]: proves the merge gate says red, on the real queue, with throwaway PRs (docs/merge-gate.md).
#
# With no argument it prints the walk and touches nothing. --run walks it, in the foreground, about 2 h and 9 full CI runs:
#
#   1. A PR with a failing test (the marker selftest-red.marker, which selftest.test.mjs refuses) goes red, the board leaves it
#      out, `gh pr merge` does not merge it and `gh pr merge --admin` is refused.
#   2. Two PRs, each green alone, red together (selftest-a.marker and selftest-b.marker). Boarded a then b: a lands, b is taken out
#      of the queue, and a rerun of b's failed jobs stays red and does not put it back.
#   3. A PR takes a's marker off main again, through the queue.
#
# It refuses to start unless the ruleset is applied with no bypass (or --admin would land the red PR) and the queue is empty (the
# two PRs must be next to each other). Everything it opened is closed on the way out. Exit 0 only when every step above was seen.
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BOARD_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$ROOT" || exit 1
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

BOARD="$SCRIPT_DIR/board.sh"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
FAILED=0; PRS=(); BRANCHES=()
step() { echo ""; echo "── $*"; }
ok() { echo "✅ $*"; }
bad() { echo "❌ $*"; FAILED=1; }
refuse() { echo "self-test not started: $*" >&2; exit 2; }

case "${1:-}" in
  "") sed -n '/^# With no argument/,/was seen\.$/p' "$0" | sed 's/^# \{0,1\}//'; echo "Run it with --run, after the ruleset is applied."; exit 0 ;;
  --run) ;;
  *) echo "usage: self-test.sh [--run]" >&2; exit 2 ;;
esac

ruleset=$(gh api "repos/$REPO/rulesets/$RULESET_ID" --jq '"\(.bypass_actors | length) \([.rules[].type] | join(","))"') || refuse "the ruleset is unreadable"
read -r bypass types <<< "$ruleset"
[ "$bypass" = 0 ] || refuse "the ruleset still has a bypass actor: --admin would land the red PR"
case ",$types," in *,merge_queue,*) ;; *) refuse "the ruleset has no merge queue: apply .github/rulesets/protect-main.json first" ;; esac
queued=$(gh api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" \
  -f query='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries{totalCount}}}}' \
  --jq '.data.repository.mergeQueue.entries.totalCount // 0') || refuse "the queue is unreadable"
[ "$queued" = 0 ] || refuse "the queue holds ${queued:-an unknown number of} PRs: wait until it is empty"

cleanup() {
  local p b
  for p in ${PRS[@]+"${PRS[@]}"}; do
    [ "$(pr_state "$p" | cut -d' ' -f1)" = OPEN ] && gh pr close "$p" -R "$REPO" --comment "Gate self-test: finished." > /dev/null 2>&1
  done
  for b in ${BRANCHES[@]+"${BRANCHES[@]}"}; do gh api -X DELETE "repos/$REPO/git/refs/heads/$b" --silent > /dev/null 2>&1; done
}
trap cleanup EXIT

# open_pr <name> <PUT|DELETE> <marker>: a branch off main that adds or removes the marker, and its PR. Sets PR and HEAD_SHA.
open_pr() {
  local branch="gate-selftest/$1-$STAMP" path="scripts/merge-queue/$3" main url
  main=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha) || return 1
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$branch" -f sha="$main" --silent || return 1
  BRANCHES+=("$branch")
  if [ "$2" = PUT ]; then
    gh api -X PUT "repos/$REPO/contents/$path" -f message="Gate self-test: $1" -f branch="$branch" -f content="$(printf 'gate self-test\n' | base64)" --silent || return 1
  else
    gh api -X DELETE "repos/$REPO/contents/$path" -f message="Gate self-test: $1" -f branch="$branch" \
      -f sha="$(gh api "repos/$REPO/contents/$path?ref=main" --jq .sha)" --silent || return 1
  fi
  url=$(gh pr create -R "$REPO" --base main --head "$branch" --title "Gate self-test: $1 (do not merge by hand)" \
    --body "Opened by scripts/merge-queue/self-test.sh. It closes this itself.") || return 1
  PR=${url##*/}; PRS+=("$PR")
  HEAD_SHA=$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq .headRefOid)
  [ -n "$HEAD_SHA" ]
}

step "1. A PR with a failing test cannot merge"
open_pr red PUT selftest-red.marker || { bad "could not open the red PR"; exit 1; }
RED=$PR; RED_HEAD=$HEAD_SHA
why=$(wait_green "$RED_HEAD")
if [ $? -eq 0 ]; then bad "#$RED went green: the failing test did not fail it"
elif [ "$why" = red ]; then ok "#$RED is red on GitHub"
else bad "#$RED ended $why, not red: this proves nothing"; fi
out=$(bash "$BOARD" "$RED@$RED_HEAD" 2>&1); rc=$?
printf '%s\n' "$out" | tail -1
[ "$rc" = 1 ] && ok "the board left it out" || bad "the board exited $rc, wanted 1"
gh pr merge "$RED" -R "$REPO" > /dev/null 2>&1
gh pr merge "$RED" -R "$REPO" --disable-auto > /dev/null 2>&1
if gh pr merge "$RED" -R "$REPO" --squash --admin --match-head-commit "$RED_HEAD" > /dev/null 2>&1; then bad "gh pr merge --admin was accepted"
else ok "gh pr merge --admin was refused"; fi
read -r state inq _ <<< "$(pr_state "$RED")"
[ "$state $inq" = "OPEN false" ] && ok "#$RED is still open and out of the queue" || bad "#$RED is $state, in the queue: $inq"
[ "$state" = MERGED ] && { bad "#$RED MERGED: selftest-red.marker is on main. Stop the queue and take it off."; exit 1; }

step "2. Green alone, red with the PR ahead: taken out"
open_pr a PUT selftest-a.marker || { bad "could not open PR a"; exit 1; }
A=$PR; A_HEAD=$HEAD_SHA
open_pr b PUT selftest-b.marker || { bad "could not open PR b"; exit 1; }
B=$PR; B_HEAD=$HEAD_SHA
for pair in "$A $A_HEAD" "$B $B_HEAD"; do
  read -r p h <<< "$pair"
  if why=$(wait_green "$h"); then ok "#$p is green alone"; else bad "#$p is $why alone: this proves nothing"; exit 1; fi
done
out=$(bash "$BOARD" "$A@$A_HEAD" "$B@$B_HEAD" 2>&1); rc=$?
printf '%s\n' "$out" | tail -3
[ "$rc" = 1 ] && ok "the board says not every PR merged" || bad "the board exited $rc, wanted 1"
read -r state _ <<< "$(pr_state "$A")"
[ "$state" = MERGED ] && ok "#$A landed" || bad "#$A is $state, wanted MERGED"
read -r state inq _ <<< "$(pr_state "$B")"
[ "$state" = MERGED ] && { bad "#$B MERGED: both markers are on main. Main is red: take selftest-a.marker off."; exit 1; }
[ "$state $inq" = "OPEN false" ] && ok "#$B was taken out and is still open" || bad "#$B is $state, in the queue: $inq"
read -r run conclusion <<< "$(group_run "$B")"
[ "$conclusion" = failure ] && ok "#$B's queue run $run is red" || bad "#$B's queue run ${run:-not found} is ${conclusion:-unread}, not red"

if [ -n "$run" ]; then
  if gh run rerun "$run" -R "$REPO" --failed > /dev/null 2>&1; then
    now=""
    for _ in $(seq 1 "${MERGE_QUEUE_WAIT_TRIES:-90}"); do
      sleep "${MERGE_QUEUE_WAIT_SECS:-60}"
      now=$(gh run view "$run" -R "$REPO" --json status,conclusion,attempt --jq '"\(.status) \(.conclusion) \(.attempt)"' 2>/dev/null)
      case "$now" in "completed "*" 2") break ;; esac
    done
    case "$now" in "completed failure 2") ok "a rerun of its failed jobs stays red" ;; *) bad "the rerun ended: ${now:-unread}" ;; esac
  else
    echo "⚪ GitHub would not rerun a dead group's jobs: requeue.sh then uses a whole new queue run as the one rerun."
  fi
  read -r state inq _ <<< "$(pr_state "$B")"
  [ "$state $inq" = "OPEN false" ] && ok "#$B stayed out" || bad "#$B is $state, in the queue: $inq, after a rerun"
fi

step "3. Taking a's marker off main"
gh pr close "$B" -R "$REPO" --comment "Gate self-test: the queue took this out, as it should." > /dev/null 2>&1
if open_pr clean DELETE selftest-a.marker; then
  bash "$BOARD" "$PR@$HEAD_SHA" | tail -1
  [ "${PIPESTATUS[0]}" = 0 ] && ok "main is as it was" || bad "#$PR did not land: selftest-a.marker is still on main (harmless alone)"
else bad "could not open the clean-up PR: selftest-a.marker is still on main (harmless alone)"; fi

echo ""
if [ "$FAILED" = 0 ]; then
  echo "PROVED: the gate said red, and the queue took out the PR that broke with the one ahead."
  journal gate-selftest "SELFTEST proved"
else
  echo "NOT PROVED: read the ❌ lines above."
  journal gate-selftest "SELFTEST failed"
fi
exit "$FAILED"
