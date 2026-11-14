#!/bin/bash
# stress.sh: run the tests main changed in the last day many times each, under CPU load, to find flakes before a PR
# does (Marty, 15 Nov). A red here is SUSPECT, not a flake: the report says SEEN-ON-CI when the flake ledger
# (record.mjs) holds the same test from a real CI run.
#
#   bash scripts/flakes/stress.sh [--runs N] [--budget-min M] [--list]
#
# WHAT IT RUNS. Test files changed on $STRESS_BASE (origin/main) in the last 24 h, and the tests beside changed source
# files (foo.test.ts or __tests__/foo.test.ts next to foo.ts). Files the ledger already holds go first, then the most
# often changed. Each file runs alone, $STRESS_RUNS times (20), one after another, before the next file starts; a file
# gets at most a sixth of the budget (a server suite takes 1-2 minutes a run). It reads the tree it sits in and fetches nothing: the caller checks out, installs
# and builds.
#   vitest package     pnpm exec vitest run <file>, in the package
#   node --test file   node --test <file>
#   server suite       SERVER_SUITES_ONLY=<suite> node scripts/run-server-suites.mjs (never tsx directly)
#
# REFUSES (exit 2) unless the heavy-test lock dir exists and, when its owner file names a pid, that pid is this
# script's caller or an ancestor: it runs INSIDE the caller that holds the lock and never takes or removes it. Refuses to
# start between 03:15 and 03:40 (macOS cleans its temp folders then, and a test that loses its temp dir goes red for
# nothing), and stops starting runs at 03:15 when the budget would cross it.
#
# THE BUDGET ($STRESS_BUDGET_SECS, 1800) is never exceeded: a run still going near the end is stopped (its process
# group, by the pid it was started with) and counted as cut, not red.
#
# THE LOAD. $STRESS_HOGS processes (half the cores) at background priority (taskpolicy -b; nice -n 19 off macOS),
# started here, killed here by the pids recorded when they started, on every exit.
#
# Exit: 0 every file it ran stayed green, 1 at least one SUSPECT, 2 refused or could not start.
#
# Env: STRESS_RUNS, STRESS_BUDGET_SECS, STRESS_FILE_SECS (a file's share), STRESS_HOGS, STRESS_LOCK (default
# ~/.cache/heavy-test.lock), STRESS_BASE, STRESS_SINCE ("24 hours ago"), STRESS_OUT (the run logs; default a new temp
# dir), FLAKE_LEDGER (record.mjs). For the tests: STRESS_ROOT, STRESS_CMD (runs instead of the real runner, with the
# file as its argument), STRESS_HOG_CMD, STRESS_NOW_HHMMSS (the clock the window check reads).
# bash 3.2: no associative arrays, no `timeout`.
set -u
START=$(date +%s)   # the budget counts from here: picking the files is inside it too
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${STRESS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
RUNS="${STRESS_RUNS:-20}"
BUDGET="${STRESS_BUDGET_SECS:-1800}"
LOCK="${STRESS_LOCK:-$HOME/.cache/heavy-test.lock}"
BASE="${STRESS_BASE:-origin/main}"
SINCE="${STRESS_SINCE:-24 hours ago}"
LIST_ONLY=0
GRACE=5     # seconds kept back from the budget to stop a run and the load

while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --budget-min) BUDGET=$(( $2 * 60 )); shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    *) echo "usage: stress.sh [--runs N] [--budget-min M] [--list]"; exit 2 ;;
  esac
done
FILE_SECS="${STRESS_FILE_SECS:-$(( BUDGET / 6 ))}"

refuse() { echo "stress.sh REFUSED: $*"; exit 2; }

# ── the lock: held by my caller, never by me ──
is_ancestor() {
  local want="$1" p=$$ n=0
  while [ -n "$p" ] && [ "$p" -gt 1 ] && [ $n -lt 64 ]; do
    [ "$p" = "$want" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    n=$((n + 1))
  done
  return 1
}
[ -d "$LOCK" ] || refuse "the heavy-test lock ($LOCK) is not held. Run me inside the caller that holds it; I never take it."
OWNER_PID=$(sed -n 's/^pid=\([0-9][0-9]*\).*/\1/p' "$LOCK/owner" 2>/dev/null | head -1)
if [ -n "$OWNER_PID" ] && ! is_ancestor "$OWNER_PID"; then
  refuse "the heavy-test lock is held by pid $OWNER_PID, which is not my caller: another run has the machine."
fi

# ── the clock: not in macOS's temp clean-up, and not across it ──
HMS="${STRESS_NOW_HHMMSS:-$(date +%H%M%S)}"
TOD=$(( 10#${HMS:0:2} * 3600 + 10#${HMS:2:2} * 60 + 10#${HMS:4:2} ))
CLEAN_FROM=$(( 3 * 3600 + 15 * 60 )); CLEAN_TO=$(( 3 * 3600 + 40 * 60 ))
if [ $TOD -ge $CLEAN_FROM ] && [ $TOD -lt $CLEAN_TO ]; then
  refuse "it is ${HMS:0:2}:${HMS:2:2}, inside 03:15-03:40 when macOS cleans its temp folders."
fi
WINDOW=$BUDGET; WHY_END="the ${BUDGET}s budget"
TO_CLEAN=$(( (CLEAN_FROM - TOD + 86400) % 86400 ))
if [ $TO_CLEAN -lt $WINDOW ]; then WINDOW=$TO_CLEAN; WHY_END="03:15 (macOS temp clean-up)"; fi

# ── what to run ──
cd "$ROOT" || refuse "no tree at $ROOT"
git rev-parse --verify --quiet "$BASE" > /dev/null || refuse "$BASE is not a ref here (the caller fetches)."
is_test() {
  case "$1" in
    node_modules/*|*/node_modules/*|e2e/*|*/e2e/*|dist/*|*/dist/*) return 1 ;;   # browser e2e runs are not a lane's
    apps/server/src/test-*.ts) return 0 ;;
    *.test.ts|*.test.tsx|*.test.js|*.test.mjs|*.test.cjs|*.test.jsx|*.spec.ts|*.spec.tsx) return 0 ;;
  esac
  return 1
}
# "count path" for every changed path, most often changed first.
CHANGED=$(git log "$BASE" --since="$SINCE" --name-only --diff-filter=AMR --pretty=format: | grep -v '^$' | sort | uniq -c | sort -k1,1nr -k2)
PICK=""
add_pick() { case "$PICK" in *"|$2|"*) return 1 ;; esac; PICK="$PICK$1|$2|"$'\n'; }
N_CHANGED=0; N_BESIDE=0
while read -r count f; do
  [ -n "${f:-}" ] || continue
  if is_test "$f"; then
    [ -f "$f" ] && add_pick "$count" "$f" && N_CHANGED=$((N_CHANGED + 1))
    continue
  fi
  case "$f" in *.ts|*.tsx|*.js|*.mjs|*.jsx) ;; *) continue ;; esac
  dir=$(dirname "$f"); base=$(basename "$f"); stem="${base%.*}"
  for cand in "$dir/$stem".test.{ts,tsx,js,mjs} "$dir/__tests__/$stem".test.{ts,tsx,js,mjs}; do
    [ -f "$cand" ] && add_pick "$count" "$cand" && N_BESIDE=$((N_BESIDE + 1))
  done
done <<< "$CHANGED"
# Files the ledger holds go first (it is JSON lines, each with a "file" key), then the most often changed.
LEDGER="${FLAKE_LEDGER:-/Users/marty/projects/beanpool/scratch/lanes/flakes.jsonl}"
ORDER=$(printf '%s' "$PICK" | awk -v L="$LEDGER" '
  BEGIN { while ((getline line < L) > 0) if (match(line, /"file":"[^"]+"/)) inl[substr(line, RSTART + 8, RLENGTH - 9)] = 1 }
  { split($0, a, "|"); c = a[1] + 0; f = a[2]; if (f == "") next; print ((f in inl) ? 0 : 1) "\t" c "\t" f }
' | sort -t$'\t' -k1,1n -k2,2nr -k3 | cut -f3)
N_FILES=$(printf '%s\n' "$ORDER" | grep -c .)

TREE=$(git rev-parse --short HEAD); BASE_SHA=$(git rev-parse --short "$BASE")
echo "━━━ flake stress (scripts/flakes/stress.sh) ━━━"
echo "tree $TREE ($BASE $BASE_SHA); changed since \"$SINCE\": $N_FILES test file(s) ($N_CHANGED changed, $N_BESIDE beside changed source)"
if [ $LIST_ONLY -eq 1 ]; then printf '%s\n' "$ORDER" | grep .; exit 0; fi
[ "$N_FILES" -gt 0 ] || { echo "nothing to stress"; exit 0; }

# The command for one file, in CMD (an array) and CMD_DIR. Returns 1 when no runner is known for it.
runner_for() {
  local f="$1" d
  CMD_DIR="$ROOT"
  if [ -n "${STRESS_CMD:-}" ]; then CMD=($STRESS_CMD "$f"); return 0; fi
  case "$f" in
    apps/server/src/test-*.ts)
      local id; id=$(basename "$f" .ts)
      CMD=(env "SERVER_SUITES_ONLY=$id" "TEST_ALL_JOBS=1" node scripts/run-server-suites.mjs); return 0 ;;
  esac
  d=$(dirname "$f")
  while [ "$d" != "." ] && [ "$d" != "/" ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done
  if [ "$d" != "." ] && [ -f "$d/package.json" ] && grep -q '"test": *"vitest' "$d/package.json"; then
    CMD_DIR="$ROOT/$d"; CMD=(pnpm exec vitest run "${f#"$d"/}"); return 0
  fi
  case "$f" in
    *.test.mjs|*.test.js|*.test.cjs)
      if [ "$d" != "." ]; then CMD_DIR="$ROOT/$d"; CMD=(node --test "${f#"$d"/}"); else CMD=(node --test "$f"); fi
      return 0 ;;
  esac
  return 1
}

# ── the load, and the clean-up that always runs ──
OUT="${STRESS_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/flake-stress.XXXXXX")}"
mkdir -p "$OUT" || refuse "cannot write $OUT"
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
HOGS="${STRESS_HOGS:-$(( NCPU / 2 > 0 ? NCPU / 2 : 1 ))}"
if [ -n "${STRESS_HOG_CMD:-}" ]; then HOG_CMD="$STRESS_HOG_CMD"
elif command -v taskpolicy > /dev/null 2>&1; then HOG_CMD="taskpolicy -b yes"
else HOG_CMD="nice -n 19 yes"; fi
HOG_PIDS=""
RUN_PID=""
stop_run() {
  [ -n "$RUN_PID" ] || return 0
  kill -TERM -- "-$RUN_PID" 2>/dev/null || kill -TERM "$RUN_PID" 2>/dev/null
  local i=0
  while kill -0 "$RUN_PID" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
  kill -KILL -- "-$RUN_PID" 2>/dev/null; kill -KILL "$RUN_PID" 2>/dev/null
  wait "$RUN_PID" 2>/dev/null
  RUN_PID=""
}
cleanup() {
  stop_run
  for p in $HOG_PIDS; do kill "$p" 2>/dev/null; done
  for p in $HOG_PIDS; do wait "$p" 2>/dev/null; done
  HOG_PIDS=""
}
trap cleanup EXIT
trap 'echo "stress.sh: stopped by a signal"; exit 130' INT TERM

DEADLINE=$(( START + WINDOW - GRACE ))
i=0
while [ $i -lt "$HOGS" ]; do
  $HOG_CMD > /dev/null 2>&1 &
  HOG_PIDS="$HOG_PIDS $!"
  i=$((i + 1))
done
export STRESS_HOG_PIDS="$HOG_PIDS"
echo "load: $HOGS process(es) ($HOG_CMD), pids$HOG_PIDS; $RUNS runs a file; ends by $WHY_END; logs in $OUT"

# One run of CMD in CMD_DIR, in a process group of its own, stopped at $1 (epoch seconds). 124 = cut.
run_once() {
  local until="$1" log="$2"
  if command -v perl > /dev/null 2>&1; then
    ( cd "$CMD_DIR" && exec perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' -- "${CMD[@]}" ) > "$log" 2>&1 &
  else
    ( cd "$CMD_DIR" && exec "${CMD[@]}" ) > "$log" 2>&1 &
  fi
  RUN_PID=$!
  while kill -0 "$RUN_PID" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$until" ]; then stop_run; return 124; fi
    sleep 0.2
  done
  wait "$RUN_PID"; local rc=$?
  RUN_PID=""
  return $rc
}

SUSPECTS=0; DONE_FILES=0
REPORT=""
NOT_REACHED=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  now=$(date +%s)
  if [ "$now" -ge "$DEADLINE" ]; then NOT_REACHED="$NOT_REACHED $f"; continue; fi
  if ! runner_for "$f"; then REPORT="$REPORT"$'\n'"skipped $f (no runner known for it)"; continue; fi
  file_until=$(( now + FILE_SECS )); [ $file_until -gt $DEADLINE ] && file_until=$DEADLINE
  slug=$(printf '%s' "$f" | tr '/' '_')
  runs=0; reds=0; red_logs=""
  while [ $runs -lt "$RUNS" ] && [ "$(date +%s)" -lt $file_until ]; do
    log="$OUT/$slug.$((runs + 1)).log"
    run_once "$file_until" "$log"; rc=$?
    if [ $rc -eq 124 ]; then rm -f "$log"; break; fi
    runs=$((runs + 1))
    if [ $rc -ne 0 ]; then reds=$((reds + 1)); red_logs="$red_logs $log"; else rm -f "$log"; fi
  done
  DONE_FILES=$((DONE_FILES + 1))
  short=""; [ $runs -lt "$RUNS" ] && short=" (stopped by the clock after $runs)"
  if [ $reds -gt 0 ]; then
    SUSPECTS=$((SUSPECTS + 1))
    every=""; [ $reds -eq $runs ] && every=" (every run: broken here, not flaky)"
    REPORT="$REPORT"$'\n'"SUSPECT $f red $reds/$runs$short$every  logs:$red_logs"
    cat $red_logs > "$OUT/$slug.reds.log"
    SEEN=$(node "$SCRIPT_DIR/record.mjs" --seen "$f" --log "$OUT/$slug.reds.log" 2>&1 | sed 's/^/  /')
    [ -n "$SEEN" ] && REPORT="$REPORT"$'\n'"$SEEN"
  elif [ $runs -eq 0 ]; then
    REPORT="$REPORT"$'\n'"cut     $f: its first run was stopped by the clock (its share or the budget) before it finished"
  else
    REPORT="$REPORT"$'\n'"clean   $f $runs/$runs$short"
  fi
done <<< "$ORDER"

ELAPSED=$(( $(date +%s) - START ))
printf '%s\n' "$REPORT" | grep .
if [ -n "$NOT_REACHED" ]; then
  set -- $NOT_REACHED
  echo "not reached ($WHY_END): $# file(s): $*"
fi
echo "stress: $DONE_FILES of $N_FILES file(s) run in ${ELAPSED}s; $SUSPECTS SUSPECT(s)"
[ $SUSPECTS -eq 0 ] || exit 1
exit 0
