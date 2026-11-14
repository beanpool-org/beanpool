#!/bin/bash
# preflight.sh — run from a lane's worktree before it opens or pushes a PR: CI's quick guards plus the suites the changed
# files call for, so a PR stops going red on a check the lane could have run in minutes (Marty, 15 Nov 2026).
#
#   bash scripts/lanes/preflight.sh               plan against origin/main and run every step
#   bash scripts/lanes/preflight.sh --plan        print the steps and their estimates, and run nothing
#   bash scripts/lanes/preflight.sh --base <ref>  plan against another base branch
#
# The steps come from scripts/lanes/preflight-plan.mjs (which says what each rule is and why): CI's "checks" shard, its
# list read from .github/workflows/ci.yml, through TEST_ALL_ONLY scripts/test-all.sh; words lint + check; then the targeted
# suites, each run alone, never the full suite. They run one at a time, in the foreground. Before each step it WAITS while
# the heavy-test lock is held (a full run, a native build): it never takes or removes that lock. It prints one
# PASS/FAIL line per step, then the end of each red step's log, and exits:
#   0   every step passed
#   1   a step was red (every step it reached still ran, so one run names every red)
#   2   no plan (ci.yml has no "checks" shard, git could not diff, bad arguments)
#   75  not finished: the heavy-test lock stayed held past its wait, or the next step would have ended past the hard
#       limit; the steps not run are named. Run it again; a second 75 goes in the PR body (CI runs every step)
#
# Time (Opus review of #3180, 15 Nov: the slowest plans overran a lane's 600 s Bash call). Each plan line carries the
# planner's estimate in seconds; the planner keeps the plan under 330 s (PREFLIGHT_PLAN_SECS). Replayed over the last 120
# merges (15 Nov): estimates p50 203 s, p90 270 s, max 331 s. The lock gets what is left of an 8-minute budget (at least
# 60 s), and a step whose estimate would end past 570 s is not started. A lane's Bash call is capped at 600 s: give this
# call that whole timeout.
#
# Environment (tests and odd cases): PREFLIGHT_PLAN_FILE (a plan to run instead of planning: name TAB est-seconds TAB why
# TAB command per line), PREFLIGHT_LOCK (the lock dir, default ~/.cache/heavy-test.lock), PREFLIGHT_BUDGET_SECS (the
# whole run, lock wait included, default 480), PREFLIGHT_LOCK_WAIT_SECS (the lock's wait; default what the budget leaves
# after the plan's estimate, at least 60), PREFLIGHT_HARD_SECS (no step starts that its estimate says ends later; default
# 570), PREFLIGHT_LOCK_POLL_SECS (default 3). macOS /bin/bash is 3.2: no associative arrays, no mapfile.
set -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
cd "$ROOT" || exit 2

PLAN_ONLY=0
BASE=origin/main
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN_ONLY=1 ;;
    --base) shift; BASE="${1:-}"; [ -n "$BASE" ] || { echo "preflight: --base needs a ref"; exit 2; } ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "preflight: unknown argument $1 (--plan, --base <ref>)"; exit 2 ;;
  esac
  shift
done

LOCK="${PREFLIGHT_LOCK:-$HOME/.cache/heavy-test.lock}"
BUDGET="${PREFLIGHT_BUDGET_SECS:-480}"
HARD="${PREFLIGHT_HARD_SECS:-570}"
LOCK_POLL="${PREFLIGHT_LOCK_POLL_SECS:-3}"

LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/preflight.XXXXXX") || exit 2
PLAN="$LOGDIR/plan.tsv"
if [ -n "${PREFLIGHT_PLAN_FILE:-}" ]; then
  cp "$PREFLIGHT_PLAN_FILE" "$PLAN" || { echo "preflight: cannot read $PREFLIGHT_PLAN_FILE"; rm -rf "$LOGDIR"; exit 2; }
elif ! node scripts/lanes/preflight-plan.mjs --base "$BASE" > "$PLAN"; then
  echo "preflight: no plan (above). Nothing was run."
  rm -rf "$LOGDIR"
  exit 2
fi
if ! [ -s "$PLAN" ]; then echo "preflight: the plan is empty. Nothing was run."; rm -rf "$LOGDIR"; exit 2; fi

# The plan's estimate: a missing or non-numeric estimate counts as the hard limit, so it can never look cheap.
is_secs() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
EST_TOTAL=0
while IFS=$'\t' read -r name est why cmd; do
  [ -n "$name" ] || continue
  if is_secs "$est"; then EST_TOTAL=$((EST_TOTAL + est)); else EST_TOTAL=$((EST_TOTAL + HARD)); fi
done < "$PLAN"
LOCK_BUDGET="${PREFLIGHT_LOCK_WAIT_SECS:-$((BUDGET - EST_TOTAL))}"
[ -n "${PREFLIGHT_LOCK_WAIT_SECS:-}" ] || [ "$LOCK_BUDGET" -ge 60 ] || LOCK_BUDGET=60

if [ $PLAN_ONLY -eq 1 ]; then
  while IFS=$'\t' read -r name est why cmd; do
    printf '%-28s %5ss  %s\n' "$name" "$est" "$why"
    printf '%-28s %6s    $ %s\n' "" "" "$cmd"
  done < "$PLAN"
  echo "estimate: ${EST_TOTAL}s of steps; the lock may take ${LOCK_BUDGET}s more; no step starts past ${HARD}s"
  rm -rf "$LOGDIR"
  exit 0
fi

# Waits while the lock is held, within what is left of the run's lock budget. Never creates, touches or removes it.
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
echo "preflight: $TOTAL steps, about $(fmt $EST_TOTAL) (against $BASE; logs in $LOGDIR)"
while IFS=$'\t' read -r name est why cmd <&3; do
  [ -n "$name" ] || continue
  if ! wait_for_lock; then
    STOPPED="the heavy-test lock is still held after ${WAITED}s"
    echo "WAIT  $STOPPED: stopped before step $((N + 1)) of $TOTAL ($name)."
    break
  fi
  step_est=$est; is_secs "$step_est" || step_est=$HARD
  elapsed=$(( $(date +%s) - START ))
  if [ $((elapsed + step_est)) -gt "$HARD" ]; then
    STOPPED="step $((N + 1)) ($name, about ${step_est}s) would end past ${HARD}s at ${elapsed}s in"
    echo "TIME  $STOPPED: stopped before it."
    break
  fi
  N=$((N + 1))
  log="$LOGDIR/$N-$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '_').log"
  s=$(date +%s)
  if [ -z "$cmd" ] || ! is_secs "$est"; then
    # A line with no command (or no why: read folds an empty field) would run nothing and read as a pass.
    echo "plan line $N is not name TAB est-seconds TAB why TAB command" > "$log"
    rc=2
  else
    bash -c "$cmd" > "$log" 2>&1 < /dev/null
    rc=$?
  fi
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
  echo "━━━ $(basename "$log" .log) (whole log: $log) ━━━"
  # What failed first: test-all's report rows (❌), vitest's FAIL lines, node --test's ✖ lines. The tail alone often holds
  # only the last failure's stack and not which check it was.
  marks=$(grep -E '❌|✖|^ *FAIL ' "$log" | head -20)
  if [ -n "$marks" ]; then echo "failed:"; printf '%s\n' "$marks"; echo "last 40 lines:"; fi
  tail -40 "$log"
done
echo ""
if [ $RED -gt 0 ]; then
  echo "preflight: $RED of $N steps RED in $(fmt $WALL)${STOPPED:+ (and $((TOTAL - N)) not run: $STOPPED)}. Fix every red this branch caused, then run it again; logs kept in $LOGDIR"
  exit 1
fi
rm -rf "$LOGDIR"
if [ -n "$STOPPED" ]; then
  echo "preflight: $N of $TOTAL steps passed in $(fmt $WALL), $((TOTAL - N)) NOT RUN ($STOPPED). Not a pass: run preflight.sh again; if it stops again, say so in the PR body (CI runs every step)."
  exit 75
fi
echo "preflight: all $N steps passed in $(fmt $WALL)"
exit 0
