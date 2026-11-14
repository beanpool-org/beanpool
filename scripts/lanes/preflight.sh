#!/bin/bash
# preflight.sh — run from a lane's worktree before it opens or pushes a PR: CI's quick guards plus the suites the changed
# files call for, so a PR stops going red on a check the lane could have run in minutes (Marty, 15 Nov 2026).
#
#   bash scripts/lanes/preflight.sh               plan against origin/main and run every step
#   bash scripts/lanes/preflight.sh --plan        print the steps and run nothing
#   bash scripts/lanes/preflight.sh --base <ref>  plan against another base branch
#
# The steps come from scripts/lanes/preflight-plan.mjs (which says what each rule is and why): CI's "checks" shard, its
# list read from .github/workflows/ci.yml, through TEST_ALL_ONLY scripts/test-all.sh; words lint + check; then the targeted
# suites, each run alone, never the full suite. They run one at a time, in the foreground. Before each step it WAITS while
# the heavy-test lock is held (a full run, a native build): it never takes or removes that lock. It prints one
# PASS/FAIL line per step, then the end of each red step's log, and exits:
#   0   every step passed
#   1   a step was red (every step still ran, so one run names every red)
#   2   no plan (ci.yml has no "checks" shard, git could not diff, bad arguments)
#   75  the heavy-test lock stayed held past the wait budget: run it again when the lock is gone
# Measured on the Mac (15 Nov 2026): checks 1m54s; with every targeted rule firing about 4m45s. A lane's Bash call is
# capped at 600 s: give this call that whole timeout.
#
# Environment (tests and odd cases): PREFLIGHT_PLAN_FILE (a plan to run instead of planning: name TAB why TAB command per
# line), PREFLIGHT_LOCK (the lock dir, default ~/.cache/heavy-test.lock), PREFLIGHT_LOCK_WAIT_SECS (the whole run's wait
# budget, default 240), PREFLIGHT_LOCK_POLL_SECS (default 3). macOS /bin/bash is 3.2: no associative arrays, no mapfile.
set -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
cd "$ROOT" || exit 2

PLAN_ONLY=0
BASE=origin/main
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN_ONLY=1 ;;
    --base) shift; BASE="${1:-}"; [ -n "$BASE" ] || { echo "preflight: --base needs a ref"; exit 2; } ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "preflight: unknown argument $1 (--plan, --base <ref>)"; exit 2 ;;
  esac
  shift
done

LOCK="${PREFLIGHT_LOCK:-$HOME/.cache/heavy-test.lock}"
LOCK_BUDGET="${PREFLIGHT_LOCK_WAIT_SECS:-240}"
LOCK_POLL="${PREFLIGHT_LOCK_POLL_SECS:-3}"

LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/preflight.XXXXXX") || exit 2
PLAN="$LOGDIR/plan.tsv"
if [ -n "${PREFLIGHT_PLAN_FILE:-}" ]; then
  cp "$PREFLIGHT_PLAN_FILE" "$PLAN" || { echo "preflight: cannot read $PREFLIGHT_PLAN_FILE"; exit 2; }
elif ! node scripts/lanes/preflight-plan.mjs --base "$BASE" > "$PLAN"; then
  echo "preflight: no plan (above). Nothing was run."
  exit 2
fi
if ! [ -s "$PLAN" ]; then echo "preflight: the plan is empty. Nothing was run."; exit 2; fi

if [ $PLAN_ONLY -eq 1 ]; then
  while IFS=$'\t' read -r name why cmd; do
    printf '%-28s %s\n' "$name" "$why"
    printf '%-28s   $ %s\n' "" "$cmd"
  done < "$PLAN"
  rm -rf "$LOGDIR"
  exit 0
fi

# Waits while the lock is held, within what is left of the run's budget. Never creates, touches or removes it.
WAITED=0
wait_for_lock() {
  while [ -d "$LOCK" ]; do
    if [ "$WAITED" -ge "$LOCK_BUDGET" ]; then return 1; fi
    [ "$WAITED" -eq 0 ] && echo "…  waiting: the heavy-test lock is held ($LOCK); preflight never takes it"
    sleep "$LOCK_POLL"
    WAITED=$((WAITED + LOCK_POLL))
  done
  return 0
}

fmt() { if [ "$1" -ge 60 ]; then printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi; }

START=$(date +%s)
RED=0
RED_LOGS=""
N=0
STOPPED=""
TOTAL=$(grep -c . "$PLAN")
echo "preflight: $TOTAL steps (against $BASE; logs in $LOGDIR)"
while IFS=$'\t' read -r name why cmd <&3; do
  [ -n "$name" ] || continue
  if ! wait_for_lock; then
    STOPPED="$name"
    echo "WAIT  the heavy-test lock is still held after ${WAITED}s: stopped before step $((N + 1)) of $TOTAL ($name)."
    break
  fi
  N=$((N + 1))
  log="$LOGDIR/$N-$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '_').log"
  s=$(date +%s)
  bash -c "$cmd" > "$log" 2>&1 < /dev/null
  rc=$?
  d=$(( $(date +%s) - s ))
  if [ $rc -eq 0 ]; then
    printf 'PASS  %-28s %6s  %s\n' "$name" "$(fmt $d)" "$why"
  else
    printf 'FAIL  %-28s %6s  %s (exit %s)\n' "$name" "$(fmt $d)" "$why" "$rc"
    RED=$((RED + 1))
    RED_LOGS="$RED_LOGS $log"
  fi
done 3< "$PLAN"

WALL=$(( $(date +%s) - START ))
for log in $RED_LOGS; do
  echo ""
  echo "━━━ $(basename "$log" .log) (last 40 lines; whole log: $log) ━━━"
  tail -40 "$log"
done
echo ""
if [ $RED -gt 0 ]; then
  echo "preflight: $RED of $N steps RED in $(fmt $WALL)${STOPPED:+ (and $((TOTAL - N)) not run: the lock)}. Fix every red this branch caused, then run it again; logs kept in $LOGDIR"
  exit 1
fi
rm -rf "$LOGDIR"
if [ -n "$STOPPED" ]; then
  echo "preflight: $N of $TOTAL steps passed, $((TOTAL - N)) NOT RUN (the heavy-test lock). Not a pass: run preflight.sh again once the lock is gone."
  exit 75
fi
echo "preflight: all $N steps passed in $(fmt $WALL)"
exit 0
