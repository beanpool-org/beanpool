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
KEEP=$LANE_SELFTEST_KEEP
unset -m 'LANE_*'   # a run from inside a lane inherits its models, briefs and rules; the defaults are what is under test

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
export LANE_DECIDE_PROBE_TRIES=2 LANE_DECIDE_PROBE_SECS=0 LANE_CI_SECS=0 LANE_IMAGE_SECS=0 LANE_DEPLOY_SETTLE_SECS=0 LANE_GREEN_SECS=0
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
  unset FAKE_AGY_MODE FAKE_AGY_PROBE_FAILS FAKE_CLAUDE_MODE FAKE_CLAUDE_PROBE_FAILS FAKE_GH_DOWN FAKE_GH_COMMENTS_DOWN FAKE_GH_RUNS_DOWN FAKE_GH_PR FAKE_REVIEW_POSTS FAKE_EARLY_POSTS FAKE_SSH_REVISION FAKE_SSH_SYMBOL
  unset LANE_DECIDE_FALLBACK_MODEL LANE_DECIDE_MODEL
  LANE_BUILD_BACKEND=agy; LANE_REVIEW_BACKEND=agy; LANE_DECIDE_BACKEND=claude
  LANE_GREEN_TRIES=6; LANE_GREEN_NONE_TRIES=3
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
FAKE_GH_COMMENTS_DOWN=1 LANE_MERGE=1
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
FAKE_CLAUDE_MODE=fail_fable LANE_DECIDE_FALLBACK_MODEL=claude-sonnet-5-5; print 3 > "$FAKE_STATE/comments"
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

scenario "24. item() on a branch that exists without a PR → the PR stage gets the build timeout, the full brief, the build role"
git -C "$T/repo" push -q origin main:refs/heads/feat/nopr
mkdir -p "$T/briefs"; print "Brief for the no-PR item." > "$T/briefs/nopr.md"
# stage is spied on (one directory per call, one file per argument) and review stubbed: this is about what item()
# passes, not about running agents. A subshell keeps the spies out of every other scenario.
( stage(){ local d="$FAKE_STATE/stage/${1//\//-}"; mkdir -p "$d"; print -r -- $# > "$d/argc"; print -r -- "$2" > "$d/timeout"
           print -r -- "$3" > "$d/brief"; print -r -- "$4" > "$d/role"; STAGE_OK=1; STAGE_IDLEKILL=0; return 0; }
  review(){ print -r -- "$1" > "$FAKE_STATE/reviewed"; }
  item NOPR feat/nopr "$T/briefs/nopr.md" ) >> "$LOG" 2>&1
show
S24=$FAKE_STATE/stage/NOPR-PR
check "the branch was resumed (CONTINUE stage), not rebuilt" eval '[ -d "$FAKE_STATE/stage/NOPR-CONTINUE" ] && [ ! -d "$FAKE_STATE/stage/NOPR" ]'
check "the PR stage ran"                         [ -d "$S24" ]
check "the PR stage got 4 arguments"             [ "$(cat "$S24/argc" 2>/dev/null)" = 4 ]
check "timeout is exactly LANE_BUILD_TIMEOUT ($LANE_BUILD_TIMEOUT)" [ "$(cat "$S24/timeout" 2>/dev/null)" = "$LANE_BUILD_TIMEOUT" ]
check "brief starts with the branch and names the brief file" eval 'grep -q "^Branch feat/nopr exists on origin" "$S24/brief" && grep -qF "$T/briefs/nopr.md" "$S24/brief"'
check "brief carries the full gh pr create line"  grep -qF "gh pr create -R $LANE_GH_REPO --base $LANE_BASE --head feat/nopr with a full description" "$S24/brief"
check "role is build"                            [ "$(cat "$S24/role" 2>/dev/null)" = build ]
check "review ran on the branch afterwards"      [ "$(cat "$FAKE_STATE/reviewed" 2>/dev/null)" = feat/nopr ]

scenario "25. the appended headless rules make the run start from origin/<base>, not the checkout"
hb=$(lane_brief claude "Build the thing on feat/z.")
check "headless brief carries: git fetch origin && git checkout -B <branch> origin/<base>" eval '[[ "$hb" == *"git fetch origin && git checkout -B <branch> origin/<base>"* ]]'
check "headless brief carries the --detach origin/<base> form for verification-only work" eval '[[ "$hb" == *"git checkout --detach origin/<base>"* ]]'
hb_has(){ print -r -- "$hb" | grep -qF -- "$1"; }
check "the -B form is only for a branch that exists neither locally nor on origin" hb_has "exists neither locally nor on origin"
check "a branch that exists locally OR on origin gets a plain fetch + checkout" eval 'hb_has "exists locally OR on origin" && hb_has "\`git fetch origin && git checkout <branch>\`"'
check "headless brief keeps an interrupted run's commits and edits (RETRIES clause)" eval 'hb_has "work: KEEP THEM" && hb_has "\`checkout -B\` an existing branch, stash, or start over"'
check "headless brief never resets a branch onto itself (checkout -B <branch> origin/<branch>)" eval '! hb_has "checkout -B <branch> origin/<branch>"'

scenario "26. the rules' command for an EXISTING branch keeps unpushed commits (clean, untracked dirt, diverged, local-only)"
# The command is lifted from the rules file, so wording that resets the branch fails here: on a throwaway repo
# `git checkout -B <branch> origin/<branch>` silently dropped the unpushed commit in the clean, untracked and diverged
# cases. That is the idle-kill → CONTINUE path, where committed-but-unpushed work sits.
rules=$(tr -s '\n ' '  ' < "$LANE_CLAUDE_RULES")
cmd=$(print -r -- "$rules" | sed -n 's/.*(a CONTINUE\/FIX\/SYNC stage[^`]*`\([^`]*\)`.*/\1/p')
merges=0; print -r -- "$rules" | grep -qF 'git merge origin/<branch>' && merges=1
print -r -- "existing-branch command from the rules: ${cmd:-<none found>} (then merge origin/<branch>: $merges)" >> "$LOG"
keep_case(){ # CASE — push feat/keep-CASE, commit once more WITHOUT pushing, dirty or diverge per CASE, apply the rule
  local c=$1 d=$T/keep-$1 b=feat/keep-$1 kept
  git clone -q -b main "$T/origin.git" "$d" && git -C "$d" checkout -qb "$b" || return 1
  [ "$c" = local-only ] || git -C "$d" push -q origin "$b"
  print unpushed > "$d/unpushed.txt"; git -C "$d" add unpushed.txt; git -C "$d" commit -qm "unpushed work ($c)"
  kept=$(git -C "$d" rev-parse HEAD)
  case $c in
    untracked) print scratch > "$d/untracked.txt" ;;
    diverged)  git clone -q -b "$b" "$T/origin.git" "$d-other" && print other > "$d-other/other.txt" \
                 && git -C "$d-other" add other.txt && git -C "$d-other" commit -qm "pushed from elsewhere" \
                 && git -C "$d-other" push -q origin "$b" || return 1 ;;
  esac
  ( cd "$d" && eval "${cmd//"<branch>"/$b}" ) >> "$LOG" 2>&1
  if (( merges )) && git -C "$d" rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null; then
    git -C "$d" merge -q --no-edit "origin/$b" >> "$LOG" 2>&1
  fi
  [ "$(git -C "$d" branch --show-current)" = "$b" ] && git -C "$d" merge-base --is-ancestor "$kept" HEAD; }
check "found the rules' command for an existing branch"          [ -n "$cmd" ]
check "clean tree: the unpushed commit survives"                 keep_case clean
check "untracked-only dirt: the unpushed commit survives"        keep_case untracked
check "origin moved (diverged): the unpushed commit survives"    keep_case diverged
check "local-only branch, never pushed: the commit survives"     keep_case local-only
show

# ── The deciding pass waits for GitHub (Marty, 31 Oct 2026). Below, a claude run is the deciding pass and an agy run a fix stage.
head_is(){ print -r -- "$1" > "$FAKE_STATE/head"; print 3 > "$FAKE_STATE/comments"; }
ci(){ print -rl -- "${@:2}" > "$FAKE_STATE/ci-$1"; }   # SHA STATE... — that commit's required check, read by read
decide(){ { decide_review 42 feat/x 3 1; } >> "$LOG" 2>&1; show; }
reviews(){ calls claude.calls '^run'; }
fixes(){ calls agy.calls '^run'; }
reads(){ calls gh.calls "commits/$1/check-runs?check_name"; }
brief_has(){ grep -qF -- "$2" "$FAKE_STATE/$1"; }
line_of(){ grep -nF -- "$1" "$LOG" | head -1 | cut -d: -f1; }

scenario "27. GitHub green on the head → the deciding pass runs, and its brief says so"
head_is aaa1
decide
check "CLEAN=1"                                  [ "$CLEAN" = 1 ]
check "one deciding pass, no fix stage"          [ "$(reviews):$(fixes)" = 1:0 ]
check "the required check was read on that exact commit" grep -qF 'commits/aaa1/check-runs?check_name=Run%20BeanPool%20Test-All%20Pipeline&filter=latest' "$FAKE_STATE/gh.calls"
check "the brief says GitHub is green on that head" brief_has claude.prompt-1 "\"Run BeanPool Test-All Pipeline\" is GREEN on this PR's head aaa1"
check "the deciding brief itself is still there" brief_has claude.prompt-1 "DECIDING pass"
check "decide lock released"                     [ ! -e "$LANE_LOCK_DIR/decide.lock" ]

scenario "28. red → no review, one fix stage on the build backend, then the review on the pushed head once it is green"
head_is aaa1; ci aaa1 failure; print failure > "$FAKE_STATE/run-aaa1"; ci aaa2 pending success; print aaa2 > "$FAKE_STATE/pushes"
decide
check "CLEAN=1"                                  [ "$CLEAN" = 1 ]
check "one fix stage, one deciding pass"         [ "$(fixes):$(reviews)" = 1:1 ]
check "the fix stage ran before the review"      [ "$(line_of 'FIX-CI-feat/x-1 started')" -lt "$(line_of 'CCR-feat/x-3 started')" ]
check "a build stage: agy, build role, build timeout" logged "FIX-CI-feat/x-1 started (agy role build timeout 60m"
check "the fix brief names the failed check and its log command" brief_has agy.prompt-1 '- Test-All shard server-3: gh run view --job 31 -R example/fake --log-failed'
check "... and the timed-out one"                brief_has agy.prompt-1 '- Test-All shard vitest-pwa-1: gh run view --job 32 -R example/fake --log-failed'
check "... and not the passed or running ones"   eval '! brief_has agy.prompt-1 "shard checks" && ! brief_has agy.prompt-1 "shard server-1"'
check "... a check that is no Actions job gets a command that reads it" brief_has agy.prompt-1 '- Cloudflare Pages: gh api repos/example/fake/check-runs/41 --jq .output'
check "... and so does one with no URL, which costs the others nothing" brief_has agy.prompt-1 '- Some other app: gh api repos/example/fake/check-runs/42 --jq .output'
check "the fix brief names the red head"         brief_has agy.prompt-1 "is RED on the head aaa1"
check "the review brief names the pushed head, not the red one" eval 'brief_has claude.prompt-1 "head aaa2" && ! brief_has claude.prompt-1 "aaa1"'

scenario "29. a headless Claude build backend with an AGY deciding backend: same flow, each stage on its own backend"
LANE_BUILD_BACKEND=claude LANE_DECIDE_BACKEND=agy LANE_DECIDE_MODEL=gemini-decide
LANE_WT=$T/repo/.claude/worktrees/lane-mix; mkdir -p "$LANE_WT"
head_is aaa1; ci aaa1 failure; print aaa2 > "$FAKE_STATE/pushes"
decide
check "CLEAN=1"                                  [ "$CLEAN" = 1 ]
check "the fix stage ran on claude, the deciding pass on agy" [ "$(reviews):$(fixes)" = 1:1 ]
check "the fix stage is the claude run"          brief_has claude.prompt-1 "STAGE FIX-CI"
check "the agy deciding brief says green on the pushed head" brief_has agy.prompt-1 "is GREEN on this PR's head aaa2"

scenario "30. director deciding backend: 'ready' only once green; a held PR never reads as ready"
LANE_DECIDE_BACKEND=director
head_is aaa1; ci aaa1 failure; print aaa2 > "$FAKE_STATE/pushes"
decide
check "ready after the fix made it green"        logged "PR #42 ready for the in-session deciding review"
check "the director stage still ran no review"   [ "$CLEAN:$(reviews)" = 0:0 ]
n=$(( $(fixes) ))
check "one fix stage"                            [ "$n" = 1 ]
: > "$LOG"; head_is bbb1; ci bbb1 cancelled
decide
check "cancelled: not ready, left for the director" eval 'not_logged "ready for the in-session" && logged "LEFT FOR THE DIRECTOR"'

scenario "31. still red after both fix stages → stops, no review, PR left for the director"
head_is aaa1; ci aaa1 failure; ci aaa2 failure; ci aaa3 failure; print -l aaa2 aaa3 aaa4 > "$FAKE_STATE/pushes"
decide
check "CLEAN=0"                                  [ "$CLEAN" = 0 ]
check "exactly two fix stages, no review"        [ "$(fixes):$(reviews)" = 2:0 ]
check "a clear log line"                         logged "⚠ PR #42 LEFT FOR THE DIRECTOR, no deciding pass: still red on aaa3 after 2 fix stage(s)"
check "the deciding slot was never taken"        [ ! -e "$FAKE_STATE/claude.calls" ]

scenario "32. a fix stage that pushes nothing → the same red is not sent to a second stage"
head_is aaa1; ci aaa1 failure
decide
check "CLEAN=0, one fix stage, no review"        [ "$CLEAN:$(fixes):$(reviews)" = 0:1:0 ]
check "says so"                                  logged "LEFT FOR THE DIRECTOR, no deciding pass: fix stage 1 pushed nothing"

scenario "33. a fix stage in a quota wait waits like any stage, and counts once"
FAKE_AGY_MODE=quota_once
head_is aaa1; ci aaa1 failure; print aaa2 > "$FAKE_STATE/pushes"
decide
check "CLEAN=1"                                  [ "$CLEAN" = 1 ]
check "waited for agy"                           logged "waiting for agy (quota reset"
check "the fix stage ran twice, as one fix"      eval '[ "$(fixes)" = 2 ] && logged "fix stage 1 of 2" && not_logged "fix stage 2 of 2"'

scenario "34. pending past the limit → no review, no fix stage, left for the director"
LANE_GREEN_TRIES=3
head_is aaa1; ci aaa1 pending
decide
check "CLEAN=0, no stage ran"                    [ "$CLEAN:$(fixes):$(reviews)" = 0:0:0 ]
check "polled up to the limit and stopped"       [ "$(reads aaa1)" = 3 ]
check "says what it waited for"                  logged 'LEFT FOR THE DIRECTOR, no deciding pass: "Run BeanPool Test-All Pipeline" still pending on aaa1 after 3 polls'
check "the wait shows in the log"                logged "waiting for GitHub on #42, head aaa1: pending (poll 1 of 3)"
check "the defaults are queue-gates.sh's: 70 polls, 15 with no run, 60 s" eval 'grep -q "LANE_GREEN_TRIES:=70}" "$LIB" && grep -q "LANE_GREEN_NONE_TRIES:=15}" "$LIB" && grep -q "LANE_GREEN_SECS:=60}" "$LIB" && grep -q "LANE_GREEN_FIXES:=2}" "$LIB"'

scenario "35. pending, then green → the review runs, and the wait never held the deciding slot"
head_is aaa1; ci aaa1 pending pending success
decide
check "CLEAN=1, one review"                      [ "$CLEAN:$(reviews)" = 1:1 ]
check "read the head three times"                [ "$(reads aaa1)" = 3 ]
check "no CI read happened inside the slot"      [ ! -e "$FAKE_STATE/ci-read-in-the-slot" ]

scenario "36. shards running, required check not created yet (needs: shard) → still a wait, not 'no run'"
LANE_GREEN_NONE_TRIES=2
head_is aaa1; ci aaa1 none none none none success; print in_progress > "$FAKE_STATE/run-aaa1"
decide
check "CLEAN=1, one review, past the no-run limit" [ "$CLEAN:$(reviews):$(reads aaa1)" = 1:1:5 ]
check "not held"                                 not_logged "LEFT FOR THE DIRECTOR"

scenario "37. cancelled → no review and no fix stage: before the required check existed, and the way a real one reads (if: always())"
head_is aaa1; ci aaa1 cancelled
decide
check "CLEAN=0, no stage ran, one read"          [ "$CLEAN:$(fixes):$(reviews):$(reads aaa1)" = 0:0:0:1 ]
check "says so"                                  logged "LEFT FOR THE DIRECTOR, no deciding pass: the run on aaa1 was cancelled"
head_is bbb1; ci bbb1 none; print cancelled > "$FAKE_STATE/run-bbb1"
{ decide_review 42 feat/x 3 1; } >> "$LOG" 2>&1
check "no required check, run cancelled: same"   eval '[ "$CLEAN:$(reviews)" = 0:0 ] && logged "the run on bbb1 was cancelled"'
: > "$LOG"; head_is ccc1; ci ccc1 failure; print cancelled > "$FAKE_STATE/run-ccc1"
decide
check "required check failed, run cancelled → cancelled, no fix stage" eval '[ "$CLEAN:$(fixes):$(reviews):$(reads ccc1)" = 0:0:0:1 ] && logged "the run on ccc1 was cancelled"'
: > "$LOG"; head_is ddd1; ci ddd1 failure; print -l in_progress cancelled > "$FAKE_STATE/run-ddd1"
decide
check "... and with that run still finishing: a wait, then cancelled, no fix stage" eval '[ "$CLEAN:$(fixes):$(reviews):$(reads ddd1)" = 0:0:0:2 ] && logged "the run on ddd1 was cancelled"'
: > "$LOG"; head_is eee1; ci eee1 failure; print -l in_progress failure > "$FAKE_STATE/run-eee1"; print eee2 > "$FAKE_STATE/pushes"
decide
check "a real red waits for its run too, then gets its fix stage" eval '[ "$CLEAN:$(fixes):$(reviews):$(reads eee1)" = 1:1:1:2 ]'

scenario "37b. a second run on the head (a reopened PR, a workflow_dispatch; a re-run stays one row): the newest run is the one that counts"
head_is aaa1; ci aaa1 failure failure success; print in_progress,failure > "$FAKE_STATE/run-aaa1"
decide
check "an earlier red under a run still going is a wait: no fix stage, then the review" [ "$CLEAN:$(fixes):$(reviews):$(reads aaa1)" = 1:0:1:3 ]
: > "$LOG"; head_is bbb1; ci bbb1 failure; print failure,success > "$FAKE_STATE/run-bbb1"; print bbb2 > "$FAKE_STATE/pushes"
decide
check "the newest run failing is still red: its fix stage" eval '[ "$CLEAN" = 1 ] && logged "#42 is red on bbb1"'
: > "$LOG"; head_is ccc1; ci ccc1 failure; print success,failure > "$FAKE_STATE/run-ccc1"; print ccc2 > "$FAKE_STATE/pushes"
decide
check "a finished run still never overrules the required check: red, its fix stage" eval '[ "$CLEAN" = 1 ] && logged "#42 is red on ccc1"'

scenario "38. no run at all on a code PR → no review after the no-run limit"
head_is aaa1; ci aaa1 none
decide
check "CLEAN=0, no stage ran"                    [ "$CLEAN:$(fixes):$(reviews)" = 0:0:0 ]
check "stopped at the no-run limit"              eval '[ "$(reads aaa1)" = 3 ] && logged "no run started on aaa1 after 3 polls"'
: > "$LOG"; head_is bbb1; ci bbb1 none; print -l README.md src/a.ts > "$FAKE_STATE/files"
decide
check "Markdown plus code still needs a run"     eval '[ "$CLEAN:$(reviews)" = 0:0 ] && logged "no run started on bbb1"'

scenario "39. a finished run with no required check never reads as green; GitHub silent is not 'no run'"
LANE_GREEN_TRIES=2
head_is aaa1; ci aaa1 none; print success > "$FAKE_STATE/run-aaa1"
decide
check "CLEAN=0, no review"                       [ "$CLEAN:$(reviews)" = 0:0 ]
: > "$LOG"; FAKE_GH_RUNS_DOWN=1; head_is bbb1; ci bbb1 none
decide
check "the run list does not answer → held, once" eval '[ "$CLEAN:$(reviews):$(reads bbb1)" = 0:0:1 ] && logged "GitHub did not answer about bbb1"'
: > "$LOG"; head_is ddd1; ci ddd1 failure
decide
check "... on a red too: held, no fix stage"     eval '[ "$CLEAN:$(fixes):$(reviews)" = 0:0:0 ] && logged "GitHub did not answer about ddd1"'
unset FAKE_GH_RUNS_DOWN
: > "$LOG"; FAKE_GH_DOWN=1; head_is ccc1
decide
check "the check does not answer → held"         eval '[ "$CLEAN:$(reviews)" = 0:0 ] && logged "GitHub did not answer about ccc1"'
unset FAKE_GH_DOWN
: > "$LOG"; : > "$FAKE_STATE/head"
decide
check "the head does not answer → held"          eval '[ "$CLEAN:$(reviews)" = 0:0 ] && logged "GitHub did not give its head commit"'

scenario "40. a PR of only .md files gets no run → straight to review; guide pages do get one, so they wait"
head_is aaa1; ci aaa1 none; print -l README.md docs/notes.md > "$FAKE_STATE/files"
decide
check "CLEAN=1, one review, one read"            [ "$CLEAN:$(reviews):$(reads aaa1)" = 1:1:1 ]
check "the brief says no run, and does not claim green" eval 'brief_has claude.prompt-1 "changes only .md files" && ! brief_has claude.prompt-1 "GREEN"'
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs"; LANE_GREEN_NONE_TRIES=5
head_is bbb1; ci bbb1 none none success; print -l README.md packages/beanpool-guide/content/x.md > "$FAKE_STATE/files"
decide
check "guide pages: waited for the run"          eval '[ "$CLEAN:$(reviews):$(reads bbb1)" = 1:1:3 ] && brief_has claude.prompt-1 "is GREEN"'

scenario "41. a new head after the wait is judged on the new head"
head_is aaa1; ci aaa1 success+push; ci aaa2 pending success; print aaa2 > "$FAKE_STATE/pushes"
decide
check "CLEAN=1, one review"                      [ "$CLEAN:$(reviews)" = 1:1 ]
check "reviewed as green on the new head, not the old" eval 'brief_has claude.prompt-1 "head aaa2" && ! brief_has claude.prompt-1 "aaa1"'
check "waited for the new head's own run"        [ "$(reads aaa2)" = 2 ]
check "said so"                                  logged "#42 has a new head aaa2"
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs"
head_is bbb1; ci bbb1 cancelled+push; print bbb2 > "$FAKE_STATE/pushes"
decide
check "a run cancelled by the next push is not a hold" eval '[ "$CLEAN:$(reviews)" = 1:1 ] && not_logged "LEFT FOR THE DIRECTOR"'
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs"
head_is ccc1; ci ccc1 failure+push; print ccc2 > "$FAKE_STATE/pushes"
decide
check "red on a head already replaced costs no fix stage" [ "$CLEAN:$(fixes):$(reviews)" = 1:0:1 ]
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs"
head_is eee1; ci eee1 failure+push; print cancelled > "$FAKE_STATE/run-eee1"; print eee2 > "$FAKE_STATE/pushes"
decide
check "a superseded run as it really reads (check failed, run cancelled): no hold, no fix" eval '[ "$CLEAN:$(fixes):$(reviews)" = 1:0:1 ] && not_logged "LEFT FOR THE DIRECTOR"'
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs"
LANE_GREEN_TRIES=2; head_is ddd1; ci ddd1 pending pending+push; ci ddd2 pending pending success; print ddd2 > "$FAKE_STATE/pushes"; LANE_GREEN_TRIES=3
decide
check "the poll limit starts again on a new head" [ "$CLEAN:$(reviews):$(reads ddd2)" = 1:1:3 ]

scenario "42. a push while the lane queued for the deciding slot → slot released, the new head goes through the wait"
head_is aaa1; print aaa2 > "$FAKE_STATE/probe-push"; ci aaa2 failure; print aaa3 > "$FAKE_STATE/pushes"
decide
check "CLEAN=1, one fix stage, one review"       [ "$CLEAN:$(fixes):$(reviews)" = 1:1:1 ]
check "the red head was never reviewed"          eval '! brief_has claude.prompt-1 "aaa2" && brief_has claude.prompt-1 "head aaa3"'
check "logged it"                                logged "#42 moved past aaa1 while it queued for the slot"
check "no CI read happened inside the slot"      [ ! -e "$FAKE_STATE/ci-read-in-the-slot" ]
check "decide lock released"                     [ ! -e "$LANE_LOCK_DIR/decide.lock" ]

scenario "43. the verdict reading is unchanged after a fix: new defects are NOT clean, the comment count still decides"
FAKE_REVIEW_POSTS=2
head_is aaa1; ci aaa1 failure; print aaa2 > "$FAKE_STATE/pushes"
{ decide_pass 42 feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=0, nothing merged"                  eval '[ "$CLEAN" = 0 ] && [ ! -e "$FAKE_STATE/merges" ]'
check "said why"                                 logged "deciding pass found new defects"

scenario "44. land reads the required check on the head, not the first shard"
FAKE_GH_PR=42 LANE_MERGE=1
head_is aaa1; ci aaa1 failure
{ land 42; } >> "$LOG" 2>&1
check "a red required check → left open, no merge" eval 'logged "PR #42 CI=FAILURE — left open" && [ ! -e "$FAKE_STATE/merges" ]'
: > "$LOG"; head_is ddd1; ci ddd1 failure; print cancelled > "$FAKE_STATE/run-ddd1"
{ land 42; } >> "$LOG" 2>&1
check "a cancelled run reads CANCELLED, not FAILURE: left open, no merge" eval 'logged "PR #42 CI=CANCELLED — left open" && [ ! -e "$FAKE_STATE/merges" ]'
: > "$LOG"; head_is bbb1; ci bbb1 none pending success; print in_progress > "$FAKE_STATE/run-bbb1"
{ land 42 hold; } >> "$LOG" 2>&1
LANE_MERGE=0
show
check "shards running is a wait, not a reason to sync" eval 'not_logged "syncing with" && logged "HELD for the maintainer"'
: > "$LOG"; rm -f "$FAKE_STATE/agy.calls" "$FAKE_STATE/agy.runs"; head_is ccc1; ci ccc1 none
{ land 42 hold; } >> "$LOG" 2>&1
check "no run at all still syncs, then the gate holds the sync's review" eval 'logged "syncing with main" && logged "LEFT FOR THE DIRECTOR" && logged "leaving it open"'

scenario "45. watch.sh wakes on a PR left for the director; a lane waiting for GitHub is not stuck on quota"
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'log "⚠ PR #42 LEFT FOR THE DIRECTOR, no deciding pass: still red on aaa3 after 2 fix stage(s)"' > "$T/run-selftestgate.sh"
print -l '#!/bin/zsh' 'sleep 600' > "$T/run-selftestother.sh"
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'log "waiting for GitHub on #43, head aaa1: pending (poll 1 of 70)"' 'sleep 600' > "$T/run-selftestwait.sh"
# The lane logs the hold and exits at once, as a run script does, while another lane keeps running.
zsh "${HERE:h}/start.sh" "$T/run-selftestother.sh" > /dev/null 2>&1 &
zsh "${HERE:h}/start.sh" "$T/run-selftestgate.sh" > /dev/null 2>&1 &
sleep 2
LANE_WATCH_SECS=1 zsh "${HERE:h}/watch.sh" >> "$LOG" 2>&1 &
w4=$!
for i in {1..5}; do kill -0 $w4 2>/dev/null || break; sleep 1; done
{ zsh "${HERE:h}/stop.sh" selftestother; } >> "$LOG" 2>&1
for i in {1..5}; do kill -0 $w4 2>/dev/null || break; sleep 1; done
zsh "${HERE:h}/start.sh" "$T/run-selftestwait.sh" > /dev/null 2>&1 &
sleep 2
touch -t 202001010000 "$LANE_STATE/log-selftestwait.txt"
LANE_WATCH_SECS=1 zsh "${HERE:h}/watch.sh" > "$T/watch3.out" 2>&1 &
w3=$!
sleep 3
{ zsh "${HERE:h}/stop.sh" selftestwait; } >> "$LOG" 2>&1
for i in {1..20}; do kill -0 $w3 2>/dev/null || break; sleep 1; done
cat "$T/watch3.out" >> "$LOG"
show
check "woke on the held PR"                      logged "NOT REVIEWED on lane selftestgate"
check "a long wait for GitHub is not reported as a quota stall" eval '! grep -q "STUCK ON QUOTA" "$T/watch3.out" && grep -q "ALL LANES STOPPED" "$T/watch3.out"'
wait 2>/dev/null

scenario "46. watch.sh wakes on a lane's last line while another lane keeps running, once; a hold just above that line keeps its own headline"
done_line='log "LANE $LANE_NAME DONE (clean=$CLEAN pr=$PR) — HELD for the director"'
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'CLEAN=0 PR=42' "$done_line" > "$T/run-selftestdone.sh"
# As a real lane ends after a hold: ci_hold's line and the run script's last line land in the same second.
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'log "⚠ PR #44 LEFT FOR THE DIRECTOR, no deciding pass: the run on aaa1 was cancelled"' 'CLEAN=0 PR=44' "$done_line" > "$T/run-selftestleft.sh"
print -l '#!/bin/zsh' "source ${(qq)LIB}" 'CLEAN=0 PR=' "$done_line" > "$T/run-selftestnopr.sh"
print -l '#!/bin/zsh' 'sleep 600' > "$T/run-selftestother.sh"
watch_now(){ # OUT — starts a watcher; WOKE=1 if it exits within 5 s. One still asleep is stopped, or it would take the next lane's event.
  LANE_WATCH_SECS=1 zsh "${HERE:h}/watch.sh" > "$1" 2>&1 &
  local w=$! i
  WOKE=1
  for i in {1..5}; do kill -0 $w 2>/dev/null || return 0; sleep 1; done
  WOKE=0; kill $w 2>/dev/null; wait $w 2>/dev/null; }
zsh "${HERE:h}/start.sh" "$T/run-selftestother.sh" > /dev/null 2>&1 &
sleep 1
zsh "${HERE:h}/start.sh" "$T/run-selftestdone.sh" > /dev/null 2>&1 &
sleep 2
watch_now "$T/w-done.out"; woke_done=$WOKE
watch_now "$T/w-done2.out"; woke_done2=$WOKE
zsh "${HERE:h}/start.sh" "$T/run-selftestleft.sh" > /dev/null 2>&1 &
sleep 2
watch_now "$T/w-left.out"; woke_left=$WOKE
watch_now "$T/w-left2.out"; woke_left2=$WOKE
zsh "${HERE:h}/start.sh" "$T/run-selftestnopr.sh" > /dev/null 2>&1 &
sleep 2
watch_now "$T/w-nopr.out"; woke_nopr=$WOKE
{ zsh "${HERE:h}/stop.sh" selftestother; } >> "$LOG" 2>&1
wait 2>/dev/null
for o in done done2 left left2 nopr; do print -r -- "--- w-$o.out"; cat "$T/w-$o.out"; done >> "$LOG"
show
check "woke while the other lane still ran"      [ "$woke_done" = 1 ]
check "printed the lane, clean and the PR"       grep -qF "LANE DONE on lane selftestdone" "$T/w-done.out"
check "... clean=0 and PR #42"                   grep -qE "selftestdone at [0-9:]+ — clean=0, PR #42, held for the director" "$T/w-done.out"
check "a restarted watcher stays asleep: once stops the repeat" [ "$woke_done2" = 0 ]
check "the hold above the last line wakes it, once" [ "$woke_left:$woke_left2" = 1:0 ]
check "the hold keeps its own headline"          grep -qF "NOT REVIEWED on lane selftestleft" "$T/w-left.out"
check "... and the same wake says the lane finished" grep -qE "selftestleft at [0-9:]+ — clean=0, PR #44, held for the director" "$T/w-left.out"
check "a lane that ended with no PR wakes it too, and says so" eval '[ "$woke_nopr" = 1 ] && grep -qE "selftestnopr at [0-9:]+ — clean=0, no PR, held for the director" "$T/w-nopr.out"'
check "watch.sh printed no shell errors"         eval '! grep -qE "bad option|bad pattern|command not found|parse error|read-only" "$T"/w-*.out'

scenario "47. the AGY rules in the repo carry the pre-flight and the heavy-test wait, and send no stage to the full suite"
ab=$(lane_brief agy "Build the thing on feat/z.")
ab_has(){ print -r -- "$ab" | grep -qF -- "$1"; }
check "AGY brief carries PRE-FLIGHT"             ab_has "PRE-FLIGHT (Marty, 1 Nov)"
check "AGY brief carries the heavy-test wait"    ab_has 'while [ -d /Users/marty/.cache/heavy-test.lock ]; do sleep 30; done'
check "no stage is told to run the full suite"   eval '! ab_has "test-all.sh LAST" && ab_has "Do NOT run scripts/test-all.sh"'

# Below, an agy run is an early pass or a FIX stage on an AGY-built lane, and a claude run the deciding pass or a FIX stage on a Claude-built one.
scenario "48. a Claude-built lane: one early pass, no FIX stage, no second pass; its comments are not defects, and the deciding pass weighs them"
LANE_BUILD_BACKEND=claude LANE_WT=$T/repo/.claude/worktrees/lane-opus; mkdir -p "$LANE_WT"
FAKE_GH_PR=42 FAKE_EARLY_POSTS=3; print 5 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=1: three early comments and none from the deciding pass" [ "$CLEAN" = 1 ]
check "one early pass, one deciding pass, no other stage" [ "$(fixes):$(reviews)" = 1:1 ]
check "the early comments were counted"          logged "review feat/x pass 1: comments 5 → 8"
check "no FIX stage, no second pass"             eval 'not_logged "FIX-feat/x" && not_logged "CCR-feat/x-2"'
check "the log says who weighs them"             logged "3 early comment(s) left for the deciding pass to weigh"
check "the gate's count starts after the early comments" logged "#42 comments before the deciding pass: 8"
check "the brief tells it to weigh them, and from when" eval 'brief_has claude.prompt-1 "WEIGH each one" && grep -qE "created after [0-9]{4}-[0-9]{2}-[0-9]{2}T" "$FAKE_STATE/claude.prompt-1"'
check "... a real one is posted as a new comment, whatever the brief below says about repeating" eval 'brief_has claude.prompt-1 "post it as your own new inline comment" && brief_has claude.prompt-1 "overrides any line below"'
check "... a false one gets no reply, which would read as a defect" brief_has claude.prompt-1 "not even a reply"
check "... the summary says which are real"      brief_has claude.prompt-1 "as REAL or NOT REAL"
check "the lane's own deciding brief still follows" brief_has claude.prompt-1 "DECIDING pass — the code merges"
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs" "$FAKE_STATE/agy.calls" "$FAKE_STATE/agy.runs"
FAKE_EARLY_POSTS=; print 5 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
check "an early pass with no comments goes straight on too" eval '[ "$CLEAN:$(fixes):$(reviews)" = 1:1:1 ] && not_logged "left for the deciding pass"'

scenario "49. a Claude-built lane: an early comment the deciding pass finds real counts, because it posts it again"
LANE_BUILD_BACKEND=claude LANE_WT=$T/repo/.claude/worktrees/lane-opus
FAKE_GH_PR=42 FAKE_EARLY_POSTS=3 FAKE_REVIEW_POSTS=1; print 5 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=0"                                  [ "$CLEAN" = 0 ]
check "said why"                                 logged "deciding pass found new defects"

scenario "50. an AGY-built lane keeps both early passes and both FIX stages, and its deciding pass checks the fixes"
FAKE_GH_PR=42 FAKE_EARLY_POSTS=2; print 5 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
show
check "CLEAN=1"                                  [ "$CLEAN" = 1 ]
check "two passes and two FIX stages on agy, then one deciding pass" [ "$(fixes):$(reviews)" = 4:1 ]
check "in order"                                 eval '(( $(line_of "CCR-feat/x-1 started") < $(line_of "FIX-feat/x-1 started") && $(line_of "FIX-feat/x-1 started") < $(line_of "CCR-feat/x-2 started") && $(line_of "CCR-feat/x-2 started") < $(line_of "FIX-feat/x-2 started") && $(line_of "FIX-feat/x-2 started") < $(line_of "CCR-feat/x-3 started") ))'
check "the deciding brief checks the fixes"      brief_has claude.prompt-1 "verify earlier findings are genuinely fixed"
check "... and has nothing to weigh"             eval '! brief_has claude.prompt-1 "WEIGH"'
: > "$LOG"; rm -f "$FAKE_STATE/claude.calls" "$FAKE_STATE/claude.runs" "$FAKE_STATE/agy.calls" "$FAKE_STATE/agy.runs"
FAKE_EARLY_POSTS=; print 5 > "$FAKE_STATE/comments"
{ review feat/x; } >> "$LOG" 2>&1
check "a first pass with no comments still ends the early passes" eval '[ "$CLEAN:$(fixes):$(reviews)" = 1:1:1 ] && not_logged "CCR-feat/x-2"'

print
print "selftest: $PASS passed, $FAILS failed"
if [ "$KEEP" = 1 ]; then print "kept $T"; else
  git -C "$T/repo" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r w; do
    [ "$w" = "$T/repo" ] || git -C "$T/repo" worktree remove --force --force "$w" >/dev/null 2>&1
  done
  rm -rf "$T"
fi
(( FAILS == 0 ))
