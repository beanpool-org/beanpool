#!/bin/bash
# board.sh <PR>[@<cleared head>] [<PR>…]: the one way to send cleared PRs to main (GitHub merge queue, Marty 1 Nov 2026;
# docs/merge-gate.md). Run it with run_in_background: it stays until each PR has landed or been taken out.
#
#   tier-A and money PRs go first, in the order given, then the rest in the order given. Each is one PR to a group, so "alone"
#   sets the order and nothing else: the ruleset's max_entries_to_merge 1 is what keeps them alone, and
#   scripts/check-ci-shards.test.mjs fails if that changes.
#   Left out, with a line: not open, a draft, not based on main, labels or diff unreadable, a head that is not the cleared one, a
#   conflict with main, or GitHub not green on the head. The others still go.
#   Queued with the head that was read here, so a push since is refused. Each landing is verified by --stat, not by the label.
#   A PR the queue takes out stays out: this names its run and stops there, and refuses that head until
#   scripts/merge-queue/requeue.sh has sent it back. A new head is a new PR to this.
#
#   BOARD_PLAN_ONLY=1 prints the plan and queues nothing. Ends with one line per PR (MERGED / NOT merged). Exit 0 when every PR
#   merged, 1 otherwise: read the lines. 2 usage, or the money list unreadable.
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BOARD_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$ROOT" || exit 1
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { echo "usage: board.sh <PR>[@<cleared head>] [<PR>…]" >&2; exit 2; }
[ $# -ge 1 ] || usage
PLAN="${BOARD_PLAN_ONLY:-}"

# The money list is main's, read from main: this checkout may be behind it. No list, no board: an empty one would pass every PR.
git fetch -q origin main || { echo "could not fetch origin/main"; exit 1; }
TRAIN=$(git show origin/main:scripts/test-all-train.sh 2>/dev/null)
MONEY_PATHS=$(printf '%s\n' "$TRAIN" | sed -n "s/^MONEY_PATHS='\(.*\)'$/\1/p")
MONEY_LINE=$(printf '%s\n' "$TRAIN" | sed -n "s/^MONEY_LINE='\(.*\)'$/\1/p")
[ -n "$MONEY_PATHS" ] && [ -n "$MONEY_LINE" ] || { echo "the money list is unreadable on origin/main (scripts/test-all-train.sh): nothing boarded" >&2; exit 2; }

NUM=(); ID=(); HEAD=(); FATE=(); MISS=(); ALONE=(); REST=(); SEEN=" "
say_fate() { FATE[$1]="$2"; echo "#${NUM[$1]} $2"; [ -n "$PLAN" ] || journal "${NUM[$1]}" "${3:-HELD} $2"; }
leave() { say_fate "$1" "left out: $2"; }

# why_alone <i> <labels>: prints why the PR goes ahead of the rest, or nothing. Returns 1 when its changes cannot be read.
why_alone() {
  local p=${NUM[$1]} patch names
  case ",$(printf '%s' "$2" | tr 'A-Z\n' 'a-z,')," in *",tier-a,"*|*",tier a,"*|*",tier:a,"*) echo "tier-A"; return 0 ;; esac
  names=$(gh pr diff "$p" -R "$REPO" --name-only 2>/dev/null) || return 1
  [ -n "$names" ] || return 1
  if printf '%s\n' "$names" | grep -qE "$MONEY_PATHS"; then echo "money path"; return 0; fi
  patch=$(gh pr diff "$p" -R "$REPO" 2>/dev/null) || return 1
  if printf '%s\n' "$patch" | grep -E '^[-+]' | grep -vE '^(\+\+\+|---) ' | sed 's/^[-+]//' | grep -qE "$MONEY_LINE"; then echo "money line"; fi
  return 0
}

for arg in "$@"; do
  p=${arg%%@*}; cleared=""; [ "$p" = "$arg" ] || cleared=${arg#*@}
  p=${p%/}; p=${p##*/}
  case "$p" in ''|*[!0-9]*) usage ;; esac
  case "$SEEN" in *" $p "*) echo "#$p is given twice" >&2; exit 2 ;; esac
  SEEN="$SEEN$p "
  i=${#NUM[@]}; NUM[$i]=$p; ID[$i]=""; HEAD[$i]=""; FATE[$i]=""; MISS[$i]=0
  if ! info=$(gh pr view "$p" -R "$REPO" --json id,state,isDraft,baseRefName,headRefOid,mergeable \
    --jq '"\(.id) \(.state) \(.isDraft) \(.baseRefName) \(.headRefOid) \(.mergeable)"' 2>/dev/null) || [ -z "$info" ]; then
    leave "$i" "PR unreadable"; continue
  fi
  read -r id state draft base head mergeable <<< "$info"
  ID[$i]=$id; HEAD[$i]=$head
  short=$(echo "$head" | cut -c1-9)
  if [ "$state" = MERGED ]; then FATE[$i]=MERGED; echo "#$p already merged"; continue; fi
  if [ "$state" != OPEN ]; then leave "$i" "it is $state"; continue; fi
  if [ "$draft" = true ]; then leave "$i" "a draft"; continue; fi
  if [ "$base" != main ]; then leave "$i" "based on $base, not main"; continue; fi
  case "$head" in "$cleared"*) ;; *) leave "$i" "head moved: cleared ${cleared}, now $short"; continue ;; esac
  if [ "$(journalled "pr=$p OUT head=$short")" -gt "$(journalled "pr=$p REQUEUED head=$short")" ]; then
    leave "$i" "the queue took this head out: read its run, then scripts/merge-queue/requeue.sh or a fix"; continue
  fi
  if [ "$mergeable" = CONFLICTING ]; then leave "$i" "conflicts with main: sync the branch (word catalogs: scripts/words-merge-3way.mjs), then board it again"; continue; fi
  if ! labels=$(gh pr view "$p" -R "$REPO" --json labels --jq '.labels[].name' 2>/dev/null); then leave "$i" "labels unreadable"; continue; fi
  if ! why=$(why_alone "$i" "$labels"); then leave "$i" "changes unreadable"; continue; fi
  if [ -n "$why" ]; then ALONE+=("$i"); [ -n "$PLAN" ] && echo "queue $p first ($why)"
  else REST+=("$i"); [ -n "$PLAN" ] && echo "queue $p"; fi
done
[ -n "$PLAN" ] && exit 0

QUEUED=()
for i in ${ALONE[@]+"${ALONE[@]}"} ${REST[@]+"${REST[@]}"}; do
  p=${NUM[$i]}; short=$(echo "${HEAD[$i]}" | cut -c1-9)
  if ! why=$(wait_green "${HEAD[$i]}"); then leave "$i" "GitHub Test-All on $short is $why"; continue; fi
  if ! out=$(enqueue "${ID[$i]}" "${HEAD[$i]}") || ! [ "$out" -ge 0 ] 2>/dev/null; then
    read -r _ inq _ <<< "$(pr_state "$p")"
    if [ "$inq" != true ]; then leave "$i" "the queue refused it: $(echo "$out" | tail -1 | sed 's/.*gh: //' | cut -c1-200)"; continue; fi
    out=unknown
  fi
  echo "#$p queued at position $out, head $short"
  journal "$p" "QUEUED head=$short position=$out"
  QUEUED+=("$i")
done

# landed <i> <merge commit> <head at merge>: the commit is on main, and it carries the files the PR changed.
landed() {
  local p=${NUM[$1]} oid=$2 got want
  [ "$3" = "${HEAD[$1]}" ] || { echo "the head that merged is $3, not the one queued"; return 1; }
  git fetch -q origin main || { echo "could not fetch origin/main to verify it"; return 1; }
  git merge-base --is-ancestor "$oid" origin/main 2>/dev/null || { echo "$oid is not on origin/main"; return 1; }
  got=$(git show --name-only --format= "$oid" | sort)
  want=$(gh api --paginate "repos/$REPO/pulls/$p/files" --jq '.[].filename' 2>/dev/null | sort)
  [ -n "$got" ] && [ "$got" = "$want" ] || { echo "the files on main are not the PR's ($(printf '%s\n' "$got" | wc -l | tr -d ' ') against $(printf '%s\n' "$want" | wc -l | tr -d ' '))"; return 1; }
  git show --stat --format='%h %s' "$oid"
}

# Until each queued PR has landed or been taken out. Two reads in a row, so a read just after queuing cannot call it out.
DEADLINE=$(( $(date +%s) + ${BOARD_WAIT_MINS:-240} * 60 ))
while [ ${#QUEUED[@]} -gt 0 ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STILL=()
  for i in "${QUEUED[@]}"; do
    p=${NUM[$i]}
    read -r state inq head oid <<< "$(pr_state "$p")"
    if [ -z "$state" ] || [ "$inq" = true ]; then STILL+=("$i"); MISS[$i]=0; continue; fi
    if [ "$state" = MERGED ]; then
      if out=$(landed "$i" "$oid" "$head"); then
        printf '%s\n' "$out"; FATE[$i]="MERGED"; journal "$p" "LANDED sha=$(echo "$oid" | cut -c1-9)"
      else say_fate "$i" "NOT VERIFIED: $out" "NOT-LANDED"; fi
      continue
    fi
    MISS[$i]=$(( MISS[$i] + 1 ))
    if [ "${MISS[$i]}" -lt 2 ]; then STILL+=("$i"); continue; fi
    run=$(group_run "$p")
    say_fate "$i" "taken out of the queue (state $state, run ${run:-not found}): read it, then scripts/merge-queue/requeue.sh or a fix" "OUT head=$(echo "${HEAD[$i]}" | cut -c1-9)"
  done
  QUEUED=(${STILL[@]+"${STILL[@]}"})
  [ ${#QUEUED[@]} -eq 0 ] || sleep "${BOARD_POLL_SECS:-60}"
done
for i in ${QUEUED[@]+"${QUEUED[@]}"}; do say_fate "$i" "still in the queue after ${BOARD_WAIT_MINS:-240} min: nothing was done to it" "WAITING"; done

rc=0
echo ""
for i in "${!NUM[@]}"; do
  if [ "${FATE[$i]}" = MERGED ]; then echo "#${NUM[$i]} MERGED"; else echo "#${NUM[$i]} NOT merged: ${FATE[$i]}"; rc=1; fi
done
exit $rc
