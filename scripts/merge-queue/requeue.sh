#!/bin/bash
# requeue.sh <PR> --run <merge queue run id> --why "<the failing test, and the log line that shows it was no assertion>"
# requeue.sh <PR> --no-run --why "<why the queue took it out with nothing red: a timeout, a removal by hand>"
#
# The director's one way back into the queue after a red it has read and judged a flake (docs/merge-gate.md). It waives nothing:
# the failed jobs of that run get their one rerun, and if they pass the PR goes back on the board, where only a whole new queue
# run can land it. If GitHub will not rerun a dead group's jobs, that new queue run is the one rerun. An assertion failure is
# never sent here: fix it. Refused when the run is not this PR's red queue run, when that run has had its rerun, or when this
# head has had one before: the second red of a head is real. --no-run is for a PR with no red run, and is refused when it has
# one. It spends the same one rerun. Each step is journalled and put on the PR.
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BOARD_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$ROOT" || exit 1
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { echo "usage: requeue.sh <PR> (--run <run id> | --no-run) --why \"<the failing test and the log line>\"" >&2; exit 2; }
PR=""; RUN=""; WHY=""; NO_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run) [ $# -ge 2 ] || usage; RUN="$2"; shift 2 ;;
    --no-run) NO_RUN=1; shift ;;
    --why) [ $# -ge 2 ] || usage; WHY="$2"; shift 2 ;;
    -*) usage ;;
    *) [ -z "$PR" ] || usage; PR="$1"; shift ;;
  esac
done
case "$PR" in ''|*[!0-9]*) usage ;; esac
if [ -n "$NO_RUN" ]; then [ -z "$RUN" ] || usage; else case "$RUN" in ''|*[!0-9]*) usage ;; esac; fi
[ -n "$WHY" ] || usage

read -r state inq head _ <<< "$(pr_state "$PR")"
[ "$state" = OPEN ] && [ "$inq" = false ] || { echo "#$PR is ${state:-unreadable}, in the queue: ${inq:-unread}: not a PR out of the queue"; exit 1; }
short=$(echo "$head" | cut -c1-9)
if [ "$(journalled "pr=$PR RERUN head=$short")" -gt 0 ]; then
  echo "#$PR head $short has had its rerun. A second red is real: fix it, or take it to Marty."; exit 1
fi
note() { journal "$PR" "$1"; gh pr comment "$PR" -R "$REPO" --body "Merge gate: $1" > /dev/null 2>&1 || echo "could not comment on #$PR"; }

if [ -n "$NO_RUN" ]; then
  read -r last conclusion <<< "$(group_run "$PR")"
  [ "$conclusion" != failure ] || { echo "#$PR's queue run $last is red: read it, and use --run $last"; exit 1; }
  note "RERUN head=$short no red run, decided by the director: $WHY"
  note "REQUEUED head=$short: a whole new queue run decides"
  exec bash "$SCRIPT_DIR/board.sh" "$PR@$head"
fi

info=$(gh run view "$RUN" -R "$REPO" --json event,headBranch,conclusion,attempt --jq '"\(.event) \(.headBranch) \(.conclusion) \(.attempt)"') || { echo "run $RUN unreadable"; exit 1; }
read -r event branch conclusion attempt <<< "$info"
[ "$event" = merge_group ] || { echo "run $RUN is a $event run, not a merge queue run"; exit 1; }
case "$branch" in *"/pr-$PR-"*) ;; *) echo "run $RUN is $branch, not #$PR's"; exit 1 ;; esac
[ "$conclusion" = failure ] || { echo "run $RUN is $conclusion, not a failure"; exit 1; }
[ "$attempt" = 1 ] || { echo "run $RUN is on attempt $attempt: it has had its rerun"; exit 1; }

note "RERUN head=$short run=$RUN decided by the director: $WHY"
if ! gh run rerun "$RUN" -R "$REPO" --failed; then
  note "REQUEUED head=$short run=$RUN: GitHub would not rerun the jobs, so a whole new queue run is the one rerun"
  exec bash "$SCRIPT_DIR/board.sh" "$PR@$head"
fi

now=""
for _ in $(seq 1 "${MERGE_QUEUE_WAIT_TRIES:-90}"); do
  sleep "${MERGE_QUEUE_WAIT_SECS:-60}"
  now=$(gh run view "$RUN" -R "$REPO" --json status,conclusion,attempt --jq '"\(.status) \(.conclusion) \(.attempt)"' 2>/dev/null)
  case "$now" in "completed "*" 2") break ;; esac
done
read -r status conclusion attempt <<< "$now"
if [ "$status $attempt" != "completed 2" ]; then note "RERUN-UNFINISHED run=$RUN: not finished, so it stays out"; exit 1; fi
if [ "$conclusion" != success ]; then note "RED run=$RUN failed its rerun ($conclusion): it stays out, fix it"; exit 1; fi
note "REQUEUED head=$short run=$RUN passed its rerun: a whole new queue run decides"
exec bash "$SCRIPT_DIR/board.sh" "$PR@$head"
