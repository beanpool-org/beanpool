#!/bin/zsh
# selftest.sh — prove lib.sh's stages, watchdog and gates against fake agy / claude / gh / ssh.
#
# Touches no real model, PR, GitHub repo or node: the fakes in test/fake/ are first on PATH (and named explicitly
# via LANE_AGY_BIN / LANE_CLAUDE_BIN), the git "origin" is a bare repo in a temp dir, and deploy.sh is a fake
# committed to that temp repo. Timings are shrunk so the whole run takes about two minutes.
#
#   zsh scripts/lanes/test/selftest.sh          (LANE_SELFTEST_KEEP=1 keeps the temp dir for inspection)
HERE=${0:A:h}
LIB=${HERE:h}/lib.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/lanes-selftest.XXXXXX") || exit 1
T=${T:A}

export PATH="$HERE/fake:$PATH"
export FAKE_STATE=$T/fake; mkdir -p "$FAKE_STATE"
export GIT_AUTHOR_NAME=selftest GIT_AUTHOR_EMAIL=selftest@example.invalid GIT_COMMITTER_NAME=selftest GIT_COMMITTER_EMAIL=selftest@example.invalid

# ── a throwaway repo with a bare "origin" ──
git init -q --bare "$T/origin.git"
git init -q -b main "$T/repo"
print -l '.claude/' 'scratch/' '.env' > "$T/repo/.gitignore"
print -l '#!/bin/bash' 'echo "fake deploy.sh args=$* DEPLOY_TAG=$DEPLOY_TAG DEPLOY_PULL=$DEPLOY_PULL" >> "$FAKE_STATE/deploy.calls"' > "$T/repo/deploy.sh"
print -l '10:mullum:192.0.2.10:mullum.example:root:BeanPool-Mullum' '11:test:192.0.2.11:test.example:root:BeanPool-Test' > "$T/repo/deploy-targets.conf"
git -C "$T/repo" add .gitignore deploy.sh deploy-targets.conf
git -C "$T/repo" commit -qm "selftest base"
git -C "$T/repo" remote add origin "$T/origin.git"
git -C "$T/repo" push -q origin main

export LANE_REPO=$T/repo LANE_NAME=selftest LANE_STATE=$T/state LANE_LOCK_DIR=$T/locks LANE_GH_REPO=example/fake
export LANE_AGY_BIN=$HERE/fake/agy LANE_CLAUDE_BIN=$HERE/fake/claude
export LANE_POLL_SECS=1 LANE_IDLE_OUTPUT_SECS=4 LANE_IDLE_WT_SECS=3 LANE_WAIT_SECS=1 LANE_WAIT_TRIES=3
export LANE_CAPACITY_WAIT_SECS=1 LANE_GH_BACKOFF_SECS=0 LANE_KILL_GRACE_SECS=1 LANE_LOCK_POLL_SECS=1
export LANE_DECIDE_PROBE_TRIES=2 LANE_DECIDE_PROBE_SECS=0 LANE_CI_SECS=0 LANE_IMAGE_SECS=0 LANE_DEPLOY_SETTLE_SECS=0
source "$LIB"
setopt allexport   # FAKE_* and LANE_* assignments below must reach the fake binaries

PASS=0; FAILS=0; LOG=
check(){ # DESCRIPTION COMMAND...
  local d=$1; shift
  if "$@"; then print -r -- "    ✓ $d"; PASS=$((PASS+1)); else print -r -- "    ✗ $d"; FAILS=$((FAILS+1)); fi; }
logged(){ grep -qF -- "$1" "$LOG"; }
not_logged(){ ! grep -qF -- "$1" "$LOG"; }
calls(){ local c; c=$(grep -c -- "$2" "$FAKE_STATE/$1" 2>/dev/null); print ${c:-0}; }
dead(){ ! kill -0 "$1" 2>/dev/null; }
scenario(){ # TITLE — resets the fakes' state; the scenario's lane log goes to $LOG
  print; print -r -- "━━ $1"
  rm -rf "$FAKE_STATE"; mkdir -p "$FAKE_STATE"
  LOG=$T/scenario-$((++SCEN)).log; : > "$LOG"
  unset FAKE_AGY_MODE FAKE_AGY_PROBE_FAILS FAKE_CLAUDE_MODE FAKE_CLAUDE_PROBE_FAILS FAKE_GH_DOWN FAKE_GH_PR FAKE_REVIEW_POSTS FAKE_SSH_REVISION FAKE_SSH_SYMBOL
  unset LANE_DECIDE_FALLBACK_MODEL
  LANE_BUILD_BACKEND=agy; LANE_REVIEW_BACKEND=agy; LANE_DECIDE_BACKEND=claude
  LANE_WT=$T/repo/.claude/worktrees/lane-selftest; CLEAN=; PR=; }
show(){ sed 's/^/    │ /' "$LOG"; }
SCEN=0

# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
scenario "1. agy stage succeeds (report mentions '429' and 'rate limit' — must not read as a failure)"
{ stage BUILD-1 60m "Build the thing on branch feat/x." ; rc=$?; } >> "$LOG" 2>&1
show
check "stage returned 0"                         [ "$rc" = 0 ]
check "STAGE_OK=1, STAGE_IDLEKILL=0"             [ "$STAGE_OK:$STAGE_IDLEKILL" = 1:0 ]
check "agy ran once"                             [ "$(calls agy.calls '^run')" = 1 ]
check "explicit model gemini-3.8-flash-high, --print-timeout 60m, stream-json" grep -q "model=gemini-3.8-flash-high timeout=60m format=stream-json" "$FAKE_STATE/agy.calls"
check "ran inside the lane worktree with the agy rules and WT_INT appended" grep -q "cwd=$LANE_WT rules=yes wtint=yes" "$FAKE_STATE/agy.calls"
check "no quota wait"                            not_logged "waiting for agy"

scenario "2. agy idle-hang: banner, quiet output AND quiet worktree → kill the whole tree, never retry"
FAKE_AGY_MODE=idlehang
{ stage BUILD-2 60m "Build the thing." ; rc=$?; } >> "$LOG" 2>&1
show
check "STAGE_IDLEKILL=1"                          [ "$STAGE_IDLEKILL" = 1 ]
check "STAGE_OK=1 (an idle-kill is not a failure; the gates decide)" [ "$STAGE_OK" = 1 ]
check "the agy run's child process was killed too" dead "$(cat "$FAKE_STATE/agy.child")"
check "the brief was NOT retried"                 [ "$(calls agy.calls '^run')" = 1 ]
check "no quota wait after an idle-kill"          not_logged "waiting for agy"

scenario "3. agy idle banner with quiet output but a BUSY worktree → left alone"
FAKE_AGY_MODE=idlebusy
{ stage BUILD-3 60m "Build the thing." ; rc=$?; } >> "$LOG" 2>&1
show
check "not killed"                               [ "$STAGE_IDLEKILL:$STAGE_OK" = 0:1 ]
check "watchdog said it was leaving it alone"    logged "leaving it alone"

scenario "4. agy quota failure → probe until the model answers → retry succeeds"
FAKE_AGY_MODE=quota_once FAKE_AGY_PROBE_FAILS=1
{ stage BUILD-4 60m "Build the thing." ; rc=$?; } >> "$LOG" 2>&1
show
check "stage ended OK on attempt 2"              [ "$rc:$STAGE_OK" = 0:1 ]
check "logged the failure verdict as quota"      logged "verdict=quota"
check "waited for agy"                           logged "waiting for agy (quota reset"
check "a failed probe was reported"              logged "agy still unavailable"
check "resumed after a successful probe"         logged "agy probe OK"
check "two real runs, two probes"                [ "$(calls agy.calls '^run'):$(calls agy.calls '^probe')" = 2:2 ]

scenario "5. agy 503 no-capacity → loud, NOT a quota wait, marker re-read, retry"
FAKE_AGY_MODE=capacity_once
{ stage BUILD-5 60m "Build the thing." ; rc=$?; } >> "$LOG" 2>&1
show
check "stage ended OK"                           [ "$rc:$STAGE_OK" = 0:1 ]
check "NO CAPACITY logged"                       logged "NO CAPACITY"
check "no quota probe"                           [ "$(calls agy.calls '^probe')" = 0 ]

scenario "6. count() when GitHub does not answer → -1 after 4 tries"
FAKE_GH_DOWN=1
n=$(count 42)
print -r -- "    │ count 42 → $n"
check "count returned -1 (not 0)"                [ "$n" = -1 ]
check "gh api was tried 4 times"                 [ "$(calls gh.calls '^gh api')" = 4 ]
check "count of a non-number is -1 without calling GitHub" [ "$(count '')" = -1 ]

scenario "7. review gate refuses -1: the review ran, but the comment count is unavailable → NOT clean"
FAKE_GH_DOWN=1 FAKE_GH_PR=42
{ review feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=0"                                  [ "$CLEAN" = 0 ]
check "refused on the unavailable count"         logged "comment count unavailable (GitHub API) — NOT clean"
check "no deciding pass started"                 [ "$(calls claude.calls '^run')" = 0 ]

scenario "8. review gate refuses an idle-killed review even with good counts → NOT clean"
FAKE_AGY_MODE=idlehang FAKE_GH_PR=42; print 3 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=0"                                  [ "$CLEAN" = 0 ]
check "refused because the review did not run cleanly" logged "DID NOT RUN cleanly (ok=1 idlekill=1"

scenario "9. positive control: early pass clean → deciding pass (headless Claude, Fable) clean → CLEAN=1"
FAKE_GH_PR=42; print 3 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=1"                                  [ "$CLEAN" = 1 ]
check "deciding model was probed first"          grep -q "probe 1 model=claude-fable-5-1" "$FAKE_STATE/claude.calls"
check "deciding pass ran on claude-fable-5-1, permission-mode auto, stream-json --verbose" grep -q "^run 1 model=claude-fable-5-1 .*perm=auto format=stream-json verbose=yes" "$FAKE_STATE/claude.calls"
check "decide lock released"                     [ ! -e "$LANE_LOCK_DIR/decide.lock" ]

scenario "10. deciding pass that finds new defects → NOT clean, nothing merged"
FAKE_GH_PR=42 FAKE_REVIEW_POSTS=2 LANE_MERGE=1; print 3 > "$FAKE_STATE/comments"
{ decide_pass 42 feat/x; } >> "$LOG" 2>&1
show
LANE_MERGE=0
check "CLEAN=0"                                  [ "$CLEAN" = 0 ]
check "no merge attempted"                       [ ! -e "$FAKE_STATE/merges" ]

scenario "11. decide_pass refuses -1 before deciding → no stage, no merge"
FAKE_GH_DOWN=1 LANE_MERGE=1
{ decide_pass 42 feat/x; } >> "$LOG" 2>&1
show
LANE_MERGE=0
check "CLEAN=0"                                  [ "$CLEAN" = 0 ]
check "refused to decide blind"                  logged "refusing to decide blind"
check "no deciding stage ran"                    [ "$(calls claude.calls '^run')" = 0 ]
check "no merge attempted"                       [ ! -e "$FAKE_STATE/merges" ]
check "decide lock released"                     [ ! -e "$LANE_LOCK_DIR/decide.lock" ]

scenario "12. deciding model never answers the probe → PR held, not decided on anything cheaper"
FAKE_CLAUDE_PROBE_FAILS=99; print 3 > "$FAKE_STATE/comments"
{ decide_pass 42 feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=0 and no stage ran"                 [ "$CLEAN:$(calls claude.calls '^run')" = 0:0 ]
check "held for the maintainer"                  logged "left open for the maintainer"
check "decide lock released"                     [ ! -e "$LANE_LOCK_DIR/decide.lock" ]

scenario "13. deciding pass that only succeeded on the FALLBACK model → DOWNGRADED, NOT clean"
FAKE_CLAUDE_MODE=fail_fable LANE_DECIDE_FALLBACK_MODEL=claude-sonnet-5; print 3 > "$FAKE_STATE/comments"
{ decide_pass 42 feat/x; } >> "$LOG" 2>&1
show
check "STAGE_DOWNGRADED=1, CLEAN=0"               [ "$STAGE_DOWNGRADED:$CLEAN" = 1:0 ]
check "logged VERIFY THIS PR BY HAND (watch.sh wakes on it)" logged "VERIFY THIS PR BY HAND"

scenario "14. headless Claude build: --worktree, exits when the model stops, promised report, orphan killed"
LANE_BUILD_BACKEND=claude LANE_WT=$T/repo/.claude/worktrees/lane-claude
FAKE_CLAUDE_MODE=promise
{ stage BUILD-14 60m "Build the thing on feat/y." ; rc=$?; } >> "$LOG" 2>&1
show
check "stage OK, not treated as a hang"          [ "$rc:$STAGE_OK:$STAGE_IDLEKILL" = 0:1:0 ]
check "invoked with --worktree lane-claude, claude-opus-5, auto, stream-json, --verbose, from the repo root" grep -q "^run 1 model=claude-opus-5 worktree=lane-claude perm=auto format=stream-json verbose=yes cwd=$T/repo rules=yes" "$FAKE_STATE/claude.calls"
check "warned about the promised report"         logged "promising a later report"
check "the backgrounded process it left was killed" dead "$(cat "$FAKE_STATE/claude.orphan")"
check "logged the leftover kill"                 logged "left 1 process(es) running after it exited"
{ stage BUILD-14-CONTINUE 60m "Continue." ; } >> "$LOG" 2>&1
check "a second stage reuses the existing worktree (cwd, no --worktree)" grep -q "^run 2 .*worktree=none .*cwd=$LANE_WT " "$FAKE_STATE/claude.calls"

scenario "15. headless Claude usage limit → probe → retry"
LANE_BUILD_BACKEND=claude LANE_WT=$T/repo/.claude/worktrees/lane-claude
FAKE_CLAUDE_MODE=quota_once FAKE_CLAUDE_PROBE_FAILS=1
{ stage BUILD-15 60m "Build." ; rc=$?; } >> "$LOG" 2>&1
show
check "stage OK on retry"                        [ "$rc:$STAGE_OK" = 0:1 ]
check "waited for claude"                        logged "waiting for claude (quota reset"

scenario "16. stopping a lane kills its whole process tree"
print -l '#!/bin/zsh' 'sleep 600 &' '( sleep 600 & wait ) &' 'wait' > "$T/run-selftestlane.sh"
zsh "$T/run-selftestlane.sh" &
sleep 2
tree=($(lane_descendants $(lane_pids selftestlane)))
print -r -- "    │ tree before stop: ${#tree} process(es): $tree"
{ lane_stop selftestlane; } >> "$LOG" 2>&1
show
alive=0; for p in $tree; do kill -0 "$p" 2>/dev/null && alive=$((alive+1)); done
check "tree had script + children + grandchildren (>=4)" [ "${#tree}" -ge 4 ]
check "every process in the tree is gone"        [ "$alive" = 0 ]
wait 2>/dev/null

scenario "17. deploy_main refusals: no node, no symbol, live node, missing .env"
{ deploy_main "" someSymbol; r1=$?; deploy_main 11 ""; r2=$?; deploy_main 10 someSymbol; r3=$?; deploy_main 11 someSymbol; r4=$?; } >> "$LOG" 2>&1
show
check "no node number → refused"                 eval '[ "$r1" = 1 ] && logged "there is no default node"'
check "no symbol → refused"                      eval '[ "$r2" = 1 ] && logged "needs a SYMBOL"'
check "live node (10 = mullum) → refused"        eval '[ "$r3" = 1 ] && logged "a LIVE community"'
check "no .env in the deploy worktree → refused" eval '[ "$r4" = 1 ] && logged "no .env in the deploy worktree"'
check "deploy.sh never ran"                      [ ! -e "$FAKE_STATE/deploy.calls" ]

scenario "18. deploy_main to the test node: revision label AND symbol both verified"
print "FAKE=1" > "$LANE_DEPLOY_WT/.env"
full=$(git -C "$T/repo" rev-parse origin/main)
FAKE_SSH_REVISION=$full FAKE_SSH_SYMBOL=found
{ deploy_main 11 renderEnterpriseMap selftest-ok; rc=$?; } >> "$LOG" 2>&1
show
check "DEPLOY_OK=1"                              [ "$rc:$DEPLOY_OK" = 0:1 ]
check "deploy.sh got node 11 only, DEPLOY_TAG=<7-char sha>, DEPLOY_PULL=1" grep -qx "fake deploy.sh args=11 DEPLOY_TAG=${full[1,7]} DEPLOY_PULL=1" "$FAKE_STATE/deploy.calls"
check "deploy lock released"                     [ ! -e "$LANE_LOCK_DIR/deploy.lock" ]

scenario "19. deploy_main: wrong revision label → NOT verified; right label but symbol missing → NOT verified"
FAKE_SSH_REVISION=0000000000000000000000000000000000000000 FAKE_SSH_SYMBOL=found
{ deploy_main 11 renderEnterpriseMap selftest-badrev; r1=$?; } >> "$LOG" 2>&1
r1ok=$DEPLOY_OK
FAKE_SSH_REVISION=$full FAKE_SSH_SYMBOL=
{ deploy_main 11 renderEnterpriseMap selftest-nosym; r2=$?; } >> "$LOG" 2>&1
show
check "wrong label → DEPLOY_OK=0"                [ "$r1:$r1ok" = 1:0 ]
check "missing symbol → DEPLOY_OK=0"             [ "$r2:$DEPLOY_OK" = 1:0 ]

scenario "20. locks: a lock left by a dead process is broken; a live holder is respected"
mkdir -p "$LANE_LOCK_DIR/deploy.lock"; sleep 0 & deadpid=$!; wait $deadpid; print $deadpid > "$LANE_LOCK_DIR/deploy.lock/pid"
{ lane_lock deploy 0; r1=$?; lane_unlock deploy
  mkdir -p "$LANE_LOCK_DIR/deploy.lock"; print $$ > "$LANE_LOCK_DIR/deploy.lock/pid"
  lane_lock deploy 2; r2=$?; rm -rf "$LANE_LOCK_DIR/deploy.lock"; } >> "$LOG" 2>&1
show
check "stale lock broken and taken"              eval '[ "$r1" = 0 ] && logged "which is gone — breaking it"'
check "live holder respected (gave up after the wait)" [ "$r2" = 1 ]

scenario "21. removing a finished, LOCKED worktree (fsmonitor stop, unlock, remove — each checked); dirty refused"
git -C "$T/repo" worktree add -q --lock -b finished "$T/repo/.claude/worktrees/finished" origin/main
git -C "$T/repo" worktree add -q -b dirty "$T/repo/.claude/worktrees/dirty" origin/main
print "uncommitted" > "$T/repo/.claude/worktrees/dirty/new-file.txt"
{ lane_remove_worktree "$T/repo/.claude/worktrees/finished"; r1=$?; lane_remove_worktree "$T/repo/.claude/worktrees/dirty"; r2=$?; } >> "$LOG" 2>&1
show
check "locked, clean worktree removed"           eval '[ "$r1" = 0 ] && [ ! -e "$T/repo/.claude/worktrees/finished" ]'
check "it was unlocked first"                    logged "worktree: unlocked"
check "dirty worktree refused and still there"   eval '[ "$r2" = 1 ] && [ -d "$T/repo/.claude/worktrees/dirty" ]'

scenario "22. orphan sweep helpers"
check "etime 1-02:03:04 = 93784 s"               [ "$(lane_etime_secs 1-02:03:04)" = 93784 ]
check "etime 12:00:00 = 43200 s"                 [ "$(lane_etime_secs 12:00:00)" = 43200 ]
check "etime 05:09 = 309 s"                      [ "$(lane_etime_secs 05:09)" = 309 ]
check "orphan pattern matches a tsx suite"       eval 'print -r -- "node /x/node_modules/.bin/tsx src/test-ledger.ts" | grep -qE "$LANE_ORPHAN_RE"'
check "orphan pattern ignores an editor"         eval '! print -r -- "/Applications/Antigravity.app/Contents/MacOS/Electron" | grep -qE "$LANE_ORPHAN_RE"'
out=$(lane_sweep_orphans); print -r -- "    │ $out" | head -5
check "sweep runs (list mode)"                   [ -n "$out" ]

scenario "23. start.sh → stop-at-boundary.sh, and watch.sh (event once, then all-lanes-stopped)"
LANES_DIR=${HERE:h}
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'log "════ CCR-feat/x-1 started (agy role review)"' 'sleep 3' 'log "════ FIX-feat/x-1 started (agy role build)"' 'sleep 600' > "$T/run-selftestfix.sh"
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'log "PR #42 is green and clean — HELD for the maintainer"' 'sleep 600' > "$T/run-selftestheld.sh"
zsh "$LANES_DIR/start.sh" "$T/run-selftestfix.sh" > /dev/null 2>&1 &
zsh "$LANES_DIR/start.sh" "$T/run-selftestheld.sh" > /dev/null 2>&1 &
sleep 2
dup=$(zsh "$LANES_DIR/start.sh" "$T/run-selftestheld.sh" 2>&1)
{ LANE_BOUNDARY_POLL_SECS=1 zsh "$LANES_DIR/stop-at-boundary.sh" selftestfix; r1=$?; } >> "$LOG" 2>&1
fixlog=$(cat "$LANE_STATE/log-selftestfix.txt")
{ LANE_WATCH_SECS=1 zsh "$LANES_DIR/watch.sh"; r2=$?; } >> "$LOG" 2>&1
LANE_WATCH_SECS=1 zsh "$LANES_DIR/watch.sh" > "$T/watch2.out" 2>&1 &
w2=$!
sleep 3
{ zsh "$LANES_DIR/stop.sh" selftestheld; } >> "$LOG" 2>&1
for i in {1..20}; do kill -0 $w2 2>/dev/null || break; sleep 1; done
cat "$T/watch2.out" >> "$LOG"
show
print -r -- "$fixlog" | sed 's/^/    │ log-selftestfix.txt: /'
check "start.sh refuses a lane that is already running" eval '[[ "$dup" == *"already running"* ]]'
check "start.sh logged to scratch/lanes/log-<lane>.txt" eval 'grep -q "FIX-feat/x-1 started" "$LANE_STATE/log-selftestfix.txt"'
check "stop-at-boundary let the review stage pass, stopped at the FIX stage" eval '[ "$r1" = 0 ] && logged "selftestfix stopped at the stage boundary — next stage was:" && logged "FIX-feat/x-1 started"'
check "selftestfix has no processes left"        eval '! (( ${#$(lane_pids selftestfix)} ))'
check "watch.sh woke on the HELD PR"             eval '[ "$r2" = 0 ] && logged "PR HELD FOR THE MAINTAINER on lane selftestheld"'
check "a restarted watch.sh did not re-fire on the same line, and reported all lanes stopped" eval '! kill -0 $w2 2>/dev/null && ! grep -q "PR HELD" "$T/watch2.out" && grep -q "ALL LANES STOPPED" "$T/watch2.out"'
check "watch.sh printed no shell errors"         eval '! grep -qE "bad option|command not found|parse error|read-only" "$T/watch2.out" "$LOG"'
wait 2>/dev/null

print
print "selftest: $PASS passed, $FAILS failed"
if [ "$LANE_SELFTEST_KEEP" = 1 ]; then print "kept $T"; else
  git -C "$T/repo" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r w; do
    [ "$w" = "$T/repo" ] || git -C "$T/repo" worktree remove --force --force "$w" >/dev/null 2>&1
  done
  rm -rf "$T"
fi
(( FAILS == 0 ))
