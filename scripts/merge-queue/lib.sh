#!/bin/bash
# scripts/merge-queue/lib.sh: what board.sh, requeue.sh, self-test.sh and tripwire.sh share. docs/merge-gate.md has the rules.
# The green rules came from the Mac queue's gates (scratch/lanes/bin/queue-gates.sh), with one taken away: a PR of only .md
# files used to pass with no run. Every PR has a run now (ci.yml), so no run is never green.

CHECK_NAME="Run BeanPool Test-All Pipeline"
REPO="${MERGE_QUEUE_REPO:-beanpool-org/beanpool}"
RULESET_ID=19976145

# journal <PR> <text>: one line in the journal the director reads every heartbeat, in the format it always had.
journal_file() { echo "$(git rev-parse --path-format=absolute --git-common-dir)/test-all-queue/journal.log"; }
journal() {
  local file
  file=$(journal_file) || return 0
  mkdir -p "$(dirname "$file")" && printf '%s pr=%s %s\n' "$(date '+%F %T')" "$1" "$2" >> "$file"
}

# journalled <text>: how many journal lines hold the text; 0 with no journal yet. Always a number: the guards compare it.
journalled() {
  local n
  n=$(grep -cF "$1" "$(journal_file)" 2>/dev/null)
  echo "${n:-0}"
}

# ci_head_state <sha>: the head's latest required check. green | red | pending | cancelled | none (no run) | unknown (GitHub
# unreadable). A conclusion this does not name, skipped or neutral among them, is pending: it never reads as green.
ci_head_state() {
  local out i
  for i in 1 2 3; do
    if out=$(gh api "repos/$REPO/commits/$1/check-runs?check_name=$(echo "$CHECK_NAME" | sed 's/ /%20/g')&filter=latest" \
      --jq '.check_runs[] | (.conclusion // "pending")' 2>/dev/null); then
      # Unquoted: two runs on one head (the same commit on two branches) must both read.
      # shellcheck disable=SC2086
      case " $(echo $out) " in
        "  ") echo none ;;
        *" failure "*|*" timed_out "*|*" startup_failure "*) echo red ;;
        *" pending "*) echo pending ;;
        *" cancelled "*) echo cancelled ;;
        *" success "*) echo green ;;
        *) echo pending ;;
      esac
      return
    fi
    [ "$i" -lt 3 ] && sleep "${MERGE_QUEUE_RETRY_SECS:-20}"
  done
  echo unknown
}

# wait_green <sha>: returns 0 once the head is green; otherwise prints why and returns 1. Red, cancelled and unreadable hold at
# once. No check yet is waited for as long as pending: the summary check appears only after the shards.
wait_green() {
  local s="" n
  for n in $(seq 1 "${MERGE_QUEUE_WAIT_TRIES:-90}"); do
    s=$(ci_head_state "$1")
    case "$s" in
      green) return 0 ;;
      red|cancelled|unknown) echo "$s"; return 1 ;;
    esac
    [ "$n" -lt "${MERGE_QUEUE_WAIT_TRIES:-90}" ] && sleep "${MERGE_QUEUE_WAIT_SECS:-60}"
  done
  echo "still ${s:-unread}"; return 1
}

# pr_state <PR>: "<STATE> <in the queue: true|false> <head> <merge commit or none>", or nothing when GitHub is unreadable.
pr_state() {
  gh api graphql -f owner="${REPO%%/*}" -f name="${REPO##*/}" -F number="$1" \
    -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state isInMergeQueue headRefOid mergeCommit{oid}}}}' \
    --jq '.data.repository.pullRequest | "\(.state) \(.isInMergeQueue) \(.headRefOid) \(.mergeCommit.oid // "none")"' 2>/dev/null
}

# enqueue <node id> <head>: into the queue only if the head is still <head>; prints the position, or GitHub's refusal and returns 1.
# Not `gh pr merge`: that goes through auto-merge, which this repository has off (allow_auto_merge), and an armed auto-merge
# outlives a later push, which would land a head nobody cleared. This either queues this head now or refuses.
enqueue() {
  gh api graphql -f id="$1" -f head="$2" \
    -f query='mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}' \
    --jq '.data.enqueuePullRequest.mergeQueueEntry.position' 2>&1
}

# group_run <PR>: "<run id> <conclusion>" of the PR's latest merge queue run, or nothing. A queue branch is
# gh-readonly-queue/main/pr-<n>-<base sha>.
group_run() {
  gh run list -R "$REPO" --workflow ci.yml --event merge_group --limit 40 --json databaseId,headBranch,conclusion \
    --jq "[.[] | select(.headBranch | contains(\"/pr-$1-\"))][0] | select(. != null) | \"\(.databaseId) \(.conclusion)\"" 2>/dev/null
}
