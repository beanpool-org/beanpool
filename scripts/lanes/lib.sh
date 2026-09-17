#!/bin/zsh
# scripts/lanes/lib.sh — the lane (pipeline) library. Source it from a run script:
#
#     #!/bin/zsh
#     source /path/to/checkout/scripts/lanes/lib.sh
#     item S7 feat/s7-thing S7-thing.md
#     decide_pass "$PR" feat/s7-thing
#
# Specification: ~/.claude/playbook/delegation-and-pipelines.md ("Pipeline scripts (lanes)" and "Headless Claude
# builds"). Every rule there is encoded below; the comments say which incident each one came from so nobody
# "simplifies" one away. README.md next to this file covers running a lane and the zsh gotchas.
#
# Fix THIS copy. Never fork a libN+1.sh while lanes run: functions load at source time, so a running lane keeps
# the copy it started with and only a restart picks up a fix.
#
# Nothing here names a session path. Everything is an env var with a default derived from the checkout.

# ── Configuration ────────────────────────────────────────────────────────────────────────────────────────────
LANE_DIR=${${(%):-%x}:A:h}
: ${LANE_REPO:=$(git -C "$LANE_DIR" rev-parse --show-toplevel)}
if [ -z "$LANE_NAME" ]; then
  LANE_NAME=${${ZSH_ARGZERO:t:r}#run-}
  case "$LANE_NAME" in ''|zsh|-zsh|lib|start|stop|stop-at-boundary|watch|sweep-orphans|remove-worktree|selftest) LANE_NAME=lane;; esac
fi
: ${LANE_BASE:=main}
# Logs, stage output and model markers live in the git-ignored scratch/ of THIS checkout. Markers are per
# checkout on purpose: a shared ~/.agy-model once moved every other session's lanes onto a different model.
: ${LANE_STATE:=$LANE_REPO/scratch/lanes}
: ${LANE_LOGS:=$LANE_STATE/$LANE_NAME}
: ${LANE_BRIEFS:=$LANE_STATE/briefs}
# One worktree per lane, never the maintainer's checkout. .claude/worktrees/ is where `claude --worktree` puts
# its worktrees, so both backends share one location (and one .gitignore entry).
: ${LANE_WT:=$LANE_REPO/.claude/worktrees/lane-$LANE_NAME}
: ${LANE_DEPLOY_WT:=$LANE_REPO/.claude/worktrees/lane-deploy}
# Locks serialise things that collide ACROSS checkouts (deploys to one VM, the strong model's quota), so they are
# machine-wide, not under scratch/.
: ${LANE_LOCK_DIR:=${TMPDIR:-/tmp}/beanpool-lanes-locks-$(id -u)}
if [ -z "$LANE_GH_REPO" ]; then
  LANE_GH_REPO=$(git -C "$LANE_REPO" remote get-url origin 2>/dev/null | sed -E 's#^(git@[^:]+:|https?://[^/]+/)##; s#\.git$##')
  [[ "$LANE_GH_REPO" == */* ]] || LANE_GH_REPO=beanpool-org/beanpool
fi

# Backends per role. build = the builder; review = early CCR passes; decide = the pass that gates a merge.
# Routing (which model does which job) is the playbook's call — operating-model.md — not this file's.
: ${LANE_BUILD_BACKEND:=agy}      # agy | claude
: ${LANE_REVIEW_BACKEND:=agy}     # agy | claude
: ${LANE_DECIDE_BACKEND:=claude}  # agy | claude | director (hold the PR for the in-session deciding review)
: ${LANE_AGY_BIN:=$HOME/.local/bin/agy}
: ${LANE_AGY_FORMAT:=stream-json} # stream-json | text
: ${LANE_BUILD_TIMEOUT:=60m}      # agy --print-timeout for anything that edits code or runs tests
: ${LANE_REVIEW_TIMEOUT:=40m}     # agy --print-timeout for review-only passes
: ${LANE_AGY_RULES:=$LANE_DIR/agy-brief-rules.md}
: ${LANE_CLAUDE_RULES:=$LANE_DIR/headless-brief-rules.md}
# LANE_HEADER_FILE (optional): lane-specific context appended to every brief, before the rules.
# LANE_DECIDE_FALLBACK_MODEL (optional): lets a deciding pass retry on another model. A pass that ran on it is
# marked DOWNGRADED and no gate counts it as clean.

# Timings. Defaults are the battle-tested values; the self-test shrinks them.
: ${LANE_POLL_SECS:=15}              # watchdog poll; also how often a stage's process tree is recorded
: ${LANE_IDLE_OUTPUT_SECS:=2700}     # 45 min of no output growth ...
: ${LANE_IDLE_WT_SECS:=1800}         # ... AND 30 min with no worktree file change, before an idle-kill
: ${LANE_WAIT_SECS:=600}             # quota wait: probe every 10 min ...
: ${LANE_WAIT_TRIES:=36}             # ... for up to 6 h
: ${LANE_CAPACITY_WAIT_SECS:=300}    # 503 no-capacity: pause before re-reading the model marker
: ${LANE_STAGE_TRIES:=3}
: ${LANE_GH_BACKOFF_SECS:=10}
: ${LANE_KILL_GRACE_SECS:=3}
: ${LANE_LOCK_POLL_SECS:=30}
: ${LANE_DECIDE_PROBE_TRIES:=24}
: ${LANE_DECIDE_PROBE_SECS:=900}
: ${LANE_CI_TRIES:=90}
: ${LANE_CI_SECS:=60}
: ${LANE_CI_CHECK_RE:=Test-All}
: ${LANE_IMAGE_WORKFLOW:=Build and Push Docker Image}
: ${LANE_IMAGE_TRIES:=40}
: ${LANE_IMAGE_SECS:=60}
: ${LANE_DEPLOY_SETTLE_SECS:=45}
: ${LANE_DEPLOY_GREP_PATHS:=/app/apps/server/dist /app/apps/server/public /app/packages}
# Nodes with real members. deploy_main refuses them unless LANE_ALLOW_LIVE_DEPLOY names that exact node.
: ${LANE_LIVE_NODES:=mullum castlemaine bindarrabi}
: ${LANE_MERGE:=0}                   # 1 lets land() merge; otherwise a green, clean PR is HELD for the maintainer
: ${LANE_ORPHAN_MIN_SECS:=3600}
: ${LANE_ORPHAN_RE:=(^|[ /])(tsx|vitest|jest)( |$)|test-all\.sh|turbo run test|node --test|src/test-[a-z0-9-]+\.ts}

# Failure banners. Matched only against the head/tail of the output, stderr, and (stream-json) the result event
# minus its response text — scanning the whole body false-positived on reports that merely DISCUSS rate limiting
# or contain "429" in a number, and burned three settings runs.
LANE_FAIL_RE='^error:|permission denied|timeout waiting for response|quota exceeded|quota exhausted|rate limit exceeded|RESOURCE_EXHAUSTED|HTTP 429|status 429|too many requests|No capacity available'
LANE_QUOTA_RE='quota|RESOURCE_EXHAUSTED|429|too many requests|rate.?limit|usage limit|credit balance'
# 503 is NOT quota. Waiting does not help; a different model does. It killed three review attempts in one night
# while a wrapper sat in a quota wait.
LANE_CAPACITY_RE='No capacity available|UNAVAILABLE \(code 503\)'
# A headless Claude run exits when the model stops replying. If its last words promise a later report, there is
# no later — whatever it backgrounded is killed below and the gates judge what actually landed.
LANE_PROMISE_RE="(I'll|I will|will) (send|post|report|update|share)|still running|when it finishes|once it finishes|in the background"

typeset -ga LANE_HELD_LOCKS
typeset -gA LANE_SEEN_PIDS
MERGED=${MERGED:-0}

# ── Basics ───────────────────────────────────────────────────────────────────────────────────────────────────
log(){ print -r -- "[$(date +%H:%M)] $*"; }
lane_is_count(){ [[ "$1" == <-> ]]; }   # a non-negative integer; -1 ("GitHub did not answer") is NOT a count
lane_mtime(){ stat -f %m "$1" 2>/dev/null || print 0; }
lane_brief_path(){ [[ "$1" == /* ]] && print -r -- "$1" || print -r -- "$LANE_BRIEFS/$1"; }

gh_try(){ # every GitHub read goes through here: 4 tries, backing off, so a blip never reaches a gate.
  # A single unlucky call at 23:19 is what made #824 read as clean. Retrying first, refusing second.
  local i out
  for i in 1 2 3 4; do
    out=$("$@" 2>/dev/null) && [ -n "$out" ] && { print -r -- "$out"; return 0; }
    sleep $((i*LANE_GH_BACKOFF_SECS))
  done
  return 1; }
count(){ # PR → inline review comment count. -1 means THE QUESTION WAS NOT ANSWERED — never 0, which reads as
  # "no findings" and therefore clean. Every gate refuses -1.
  local out
  lane_is_count "$1" || { print -- -1; return; }
  out=$(gh_try gh api "repos/$LANE_GH_REPO/pulls/$1/comments" --paginate --jq 'length') || { print -- -1; return; }
  print -r -- "$out" | awk '{s+=$1} END{print s+0}'; }
prnum(){ local n; n=$(gh_try gh pr list -R "$LANE_GH_REPO" --head "$1" --json number --jq '.[0].number') || return 0
  lane_is_count "$n" && print -r -- "$n"; return 0; }
exists(){ git -C "$LANE_REPO" ls-remote --heads origin "$1" | grep -q .; }

# ── Locks (mkdir-atomic, machine-wide, stale-safe) ───────────────────────────────────────────────────────────
# Released by lane_unlock or by the top-level traps below. NOT by a trap set inside a function: in zsh an EXIT
# trap set in a function fires when that FUNCTION returns, so the old opus_begin() released its lock the moment
# it was taken and deciding passes were never actually serialised.
lane_lock(){ # NAME MAX_WAIT_SECS → 0 when held
  local d="$LANE_LOCK_DIR/$1.lock" waited=0 owner
  mkdir -p "$LANE_LOCK_DIR"
  while ! mkdir "$d" 2>/dev/null; do
    owner=$(cat "$d/pid" 2>/dev/null)
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      log "lock $1 was held by pid $owner, which is gone — breaking it"; rm -rf "$d"; continue
    fi
    [ "$waited" -ge "$2" ] && return 1
    [ $((waited % 300)) -eq 0 ] && log "waiting for the $1 lock (held by pid ${owner:-?})…"
    sleep "$LANE_LOCK_POLL_SECS"; waited=$((waited+LANE_LOCK_POLL_SECS))
  done
  print $$ > "$d/pid"; LANE_HELD_LOCKS+=("$d"); return 0; }
lane_unlock(){ local d="$LANE_LOCK_DIR/$1.lock"; rm -rf "$d"; LANE_HELD_LOCKS=(${LANE_HELD_LOCKS:#$d}); }
lane_release_locks(){ local d; for d in $LANE_HELD_LOCKS; do rm -rf "$d"; done; LANE_HELD_LOCKS=(); }
trap 'lane_release_locks' EXIT
trap 'lane_release_locks; exit 130' INT
trap 'lane_release_locks; exit 143' TERM

# ── Process trees ────────────────────────────────────────────────────────────────────────────────────────────
# Stopping a lane means stopping its WHOLE tree. Killing only the chain script orphans what it started — test
# suites, tsx runs, dev servers — which get reparented to launchd and run for hours. One cleanup found eight hung
# suites, 13–18 h old. So: walk the tree first (children, then grandchildren, every level), then kill it all.
lane_descendants(){ # PID... → those PIDs and every descendant, parents first, deduplicated
  local -a queue out; local p
  queue=("$@")
  while (( ${#queue} )); do
    p=${queue[1]}; shift queue
    [[ -n "$p" && -z "${out[(r)$p]}" ]] || continue
    out+=("$p"); queue+=($(pgrep -P "$p" 2>/dev/null))
  done
  print -l -- $out; }
lane_kill_tree(){ # PID... → TERM the whole tree (leaves first), then KILL whatever ignored it
  local -a pids left; local p
  pids=($(lane_descendants "$@"))
  (( ${#pids} )) || return 0
  kill -TERM ${(Oa)pids} 2>/dev/null
  sleep "$LANE_KILL_GRACE_SECS"
  for p in $pids; do kill -0 "$p" 2>/dev/null && left+=("$p"); done
  (( ${#left} )) && kill -KILL $left 2>/dev/null
  print -r -- "${#pids}"; }
lane_record_tree(){ # PID — remember every descendant with its start time (so a reused PID is never killed)
  local p
  for p in $(lane_descendants "$1"); do
    [ "$p" = "$1" ] && continue
    [ -n "${LANE_SEEN_PIDS[$p]}" ] || LANE_SEEN_PIDS[$p]="$(ps -o lstart= -p "$p" 2>/dev/null)"
  done; }
lane_reap_leftovers(){ # STAGE — kill anything the stage started that outlived it
  local p n=0
  for p in ${(k)LANE_SEEN_PIDS}; do
    [ -n "${LANE_SEEN_PIDS[$p]}" ] || continue
    [ "$(ps -o lstart= -p "$p" 2>/dev/null)" = "${LANE_SEEN_PIDS[$p]}" ] || continue
    lane_kill_tree "$p" >/dev/null; n=$((n+1))
  done
  LANE_SEEN_PIDS=()
  (( n )) && log "⚠ $1 left $n process(es) running after it exited (backgrounded commands) — killed them"
  return 0; }
lane_pids(){ pgrep -f "(^|[ /])run-${1}[.]sh" 2>/dev/null; }   # brace before [ — "$l[.]" is a subscript in zsh
lane_stop(){ # LANE — stop a lane now: the run script and everything under it
  local -a pids; local n
  pids=($(lane_pids "$1"))
  (( ${#pids} )) || { log "lane $1 is not running"; return 0; }
  n=$(lane_kill_tree $pids)
  if (( ${#$(lane_pids "$1")} )); then log "⚠ lane $1 still has processes after killing $n"; return 1; fi
  log "lane $1 stopped — killed $n process(es)"; }
lane_etime_secs(){ # ps etime ([[dd-]hh:]mm:ss) → seconds
  local t=$1 d=0 h=0 m=0 s=0; local -a p
  [[ "$t" == *-* ]] && { d=${t%%-*}; t=${t#*-}; }
  p=(${(s.:.)t})
  case ${#p} in 3) h=$p[1]; m=$p[2]; s=$p[3];; 2) m=$p[1]; s=$p[2];; 1) s=$p[1];; esac
  print $(( 10#$d*86400 + 10#$h*3600 + 10#$m*60 + 10#$s )); }
lane_sweep_orphans(){ # [--kill] — test runners reparented to launchd (PPID 1) and older than an hour
  local pid ppid et cmd n=0
  ps -axo pid=,ppid=,etime=,command= | while read -r pid ppid et cmd; do
    [ "$ppid" = 1 ] || continue
    print -r -- "$cmd" | grep -qE "$LANE_ORPHAN_RE" || continue
    [ "$(lane_etime_secs "$et")" -ge "$LANE_ORPHAN_MIN_SECS" ] || continue
    n=$((n+1)); print -r -- "orphan pid=$pid age=$et  ${cmd[1,160]}"
    [ "$1" = --kill ] && print -r -- "  killed $(lane_kill_tree "$pid") process(es)"
  done
  (( n )) || print "no orphaned test runners older than $((LANE_ORPHAN_MIN_SECS/60)) min"; }

# ── Worktrees ────────────────────────────────────────────────────────────────────────────────────────────────
lane_fresh(){ # put the lane worktree on current origin/<base> (creating it if needed)
  if [ ! -d "$LANE_WT" ]; then
    git -C "$LANE_REPO" fetch -q origin && git -C "$LANE_REPO" worktree add -q --detach "$LANE_WT" "origin/$LANE_BASE" \
      || { log "⚠ could not create the lane worktree $LANE_WT"; return 1; }
    log "created lane worktree $LANE_WT"; return 0
  fi
  ( cd "$LANE_WT" && git fetch -q origin && git checkout -q --detach "origin/$LANE_BASE" ) \
    || log "⚠ could not move $LANE_WT to origin/$LANE_BASE (uncommitted work from an earlier stage?) — it stays as it is"; }
fresh(){ lane_fresh "$@"; }
lane_worktree_locked(){ # WT
  git -C "$1" worktree list --porcelain 2>/dev/null | awk -v a="$1" -v b="${1:A}" '
    /^worktree /{ w = substr($0, 10); cur = (w == a || w == b) } cur && /^locked/{ found = 1 } END{ exit !found }'; }
lane_remove_worktree(){ # WT — for a FINISHED worktree that is clean and pushed. Claude Code LOCKS the worktrees it
  # creates and git's fsmonitor--daemon keeps each one open after the run exits, so removal is three steps, each
  # outcome checked. Never pipe these through tail: that once printed "removed" for three removals that all failed.
  local wt=${1:A} out rc common
  [ -d "$wt" ] || { log "no worktree at $wt"; return 1; }
  out=$(git -C "$wt" status --porcelain 2>&1) || { log "git status failed in $wt: $out"; return 1; }
  [ -z "$out" ] || { log "$wt has uncommitted changes — refusing to remove it:"; print -r -- "$out" | head -20; return 1; }
  out=$(git -C "$wt" log --oneline HEAD --not --remotes 2>&1) || { log "could not check $wt for unpushed commits: $out"; return 1; }
  [ -z "$out" ] || { log "$wt has commits that are on no remote — refusing to remove it:"; print -r -- "$out" | head -20; return 1; }
  common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir) || return 1
  out=$(git -C "$wt" fsmonitor--daemon stop 2>&1); rc=$?
  if [ $rc -eq 0 ]; then log "fsmonitor--daemon: stopped"
  elif git -C "$wt" fsmonitor--daemon status 2>&1 | grep -qiE "not watching|not running"; then log "fsmonitor--daemon: was not running"
  else log "fsmonitor--daemon stop FAILED (rc=$rc): $out"; return 1; fi
  if lane_worktree_locked "$wt"; then
    out=$(git -C "$wt" worktree unlock "$wt" 2>&1) || { log "worktree unlock FAILED: $out"; return 1; }
    lane_worktree_locked "$wt" && { log "worktree unlock reported success but $wt is still locked"; return 1; }
    log "worktree: unlocked"
  else log "worktree: was not locked"; fi
  out=$(git -C "${common:h}" worktree remove "$wt" 2>&1); rc=$?
  [ $rc -eq 0 ] || { log "worktree remove FAILED (rc=$rc): $out"; return 1; }
  [ -e "$wt" ] && { log "worktree remove reported success but $wt still exists"; return 1; }
  git -C "${common:h}" worktree list --porcelain | grep -qxF "worktree $wt" && { log "$wt is still registered after remove"; return 1; }
  log "removed worktree $wt"; }

# ── Models ───────────────────────────────────────────────────────────────────────────────────────────────────
lane_role_for(){ case "$1" in CCR-*-3|CCR-*-sync|DECIDE-*) print decide;; CCR-*|REVIEW-*) print review;; *) print build;; esac; }
lane_backend(){ case "$1" in build) print -r -- "$LANE_BUILD_BACKEND";; review) print -r -- "$LANE_REVIEW_BACKEND";; decide) print -r -- "$LANE_DECIDE_BACKEND";; esac; }
lane_marker(){ print -r -- "$LANE_STATE/model-$1-$2"; }   # ROLE BACKEND, e.g. scratch/lanes/model-build-agy
lane_model(){ # ROLE BACKEND → model id. Per-run env override first, then this checkout's marker (re-read by every
  # attempt, so switching a lane is one echo), then the default. Resolved HERE, not by appending --model, because
  # other flags derive from the model (Claude ids in AGY reject --effort).
  local role=$1 be=$2 v mf
  case "$role" in build) v=$LANE_BUILD_MODEL;; review) v=$LANE_REVIEW_MODEL;; decide) v=$LANE_DECIDE_MODEL;; esac
  mf=$(lane_marker "$role" "$be")
  [ -z "$v" ] && [ -s "$mf" ] && v=$(cat "$mf")
  v=${v//[[:space:]]/}
  if [ -z "$v" ]; then
    case "$be:$role" in
      agy:build|agy:review) v=gemini-3.8-flash-high;;
      claude:build)         v=claude-opus-5;;
      claude:review)        v=claude-sonnet-5;;
      claude:decide)        v=claude-fable-5-1;;
      agy:decide) log "⚠ no deciding model for agy — set LANE_DECIDE_MODEL or $mf; refusing to guess" >&2; return 1;;
    esac
  fi
  if [ "$be" = claude ] && [[ "$v" != claude-* ]]; then log "⚠ '$v' is not a Claude model id (backend claude, role $role) — refusing" >&2; return 1; fi
  print -r -- "$v"; }
lane_claude_bin(){ # the NEWEST IDE-bundled binary — it was ~90 releases ahead of Homebrew's
  [ -n "$LANE_CLAUDE_BIN" ] && { print -r -- "$LANE_CLAUDE_BIN"; return; }
  local b; b=$(print -l -- $HOME/.antigravity-ide/extensions/anthropic.claude-code-*/resources/native-binary/claude(N) | sort -V | tail -1)
  [ -n "$b" ] || b=$(command -v claude)
  print -r -- "$b"; }
lane_probe(){ # BACKEND MODEL → 0 when the model answers
  case "$1" in
    agy)    ( cd "${TMPDIR:-/tmp}" && "$LANE_AGY_BIN" -p="Reply with exactly: PROBE-OK" --print-timeout 4m --model "$2" < /dev/null 2>&1 | grep -q "PROBE-OK" ) ;;
    claude) ( cd "${TMPDIR:-/tmp}" && "$(lane_claude_bin)" -p "Reply with exactly: PROBE-OK" --model "$2" --output-format text < /dev/null 2>&1 | grep -q "PROBE-OK" ) ;;
    *) return 1 ;;
  esac; }
wait_for_model(){ # BACKEND MODEL — quota exhausted or CLI failing: probe every LANE_WAIT_SECS until it answers
  local i
  for i in $(seq 1 "$LANE_WAIT_TRIES"); do
    sleep "$LANE_WAIT_SECS"
    lane_probe "$1" "$2" && { log "$1 probe OK ($2) — resuming"; return 0; }
    log "$1 still unavailable ($2, probe $i/$LANE_WAIT_TRIES)"
  done
  return 1; }
wait_for_agy(){ wait_for_model agy "$(lane_model build agy)"; }

# ── Stages ───────────────────────────────────────────────────────────────────────────────────────────────────
lane_wt_recent(){ # WT SECS → 0 if any file (outside node_modules/.git/.turbo) changed in the last SECS
  [ -d "$1" ] || return 1
  find "$1" \( -name node_modules -o -name .git -o -name .turbo \) -prune -o -type f -mtime "-${2}s" -print 2>/dev/null | head -1 | grep -q .; }
lane_agy_verdict(){ # OUT ERR RC → ok | capacity | quota | fail
  # (not "status": that is a read-only special parameter in zsh, and assigning it silently empties the verdict)
  local out=$1 err=$2 rc=$3 size rstatus res banner
  size=$(( $(wc -c < "$out") ))
  if [ "$LANE_AGY_FORMAT" = text ]; then
    rstatus=SUCCESS
    banner=$({ head -c 400 "$out"; echo; tail -c 400 "$out"; echo; head -c 400 "$err"; echo; tail -c 400 "$err"; } 2>/dev/null)
  else
    res=$(grep '"event":"result"' "$out" | tail -1)
    rstatus=$(print -r -- "$res" | jq -r '.result.status // empty' 2>/dev/null)
    banner=$({ grep -v '^{' "$out" | head -c 400; echo; grep -v '^{' "$out" | tail -c 400; echo
               head -c 400 "$err"; echo; tail -c 400 "$err"; echo
               print -r -- "$res" | jq -c 'del(.result.response)'; } 2>/dev/null)
  fi
  if print -r -- "$banner" | grep -qiE "$LANE_CAPACITY_RE"; then print capacity
  elif [ "$rc" = 0 ] && [ "$size" -ge 500 ] && [ "$rstatus" = SUCCESS ] && ! print -r -- "$banner" | grep -qiE "$LANE_FAIL_RE"; then print ok
  elif print -r -- "$banner" | grep -qiE "$LANE_QUOTA_RE"; then print quota
  else print fail; fi; }
lane_claude_verdict(){ # OUT ERR RC → ok | quota | fail
  local out=$1 err=$2 rc=$3 res iserr banner
  res=$(grep '"type":"result"' "$out" | tail -1)
  iserr=$(print -r -- "$res" | jq -r '.is_error' 2>/dev/null)
  if [ "$rc" = 0 ] && [ "$iserr" = false ]; then print ok; return; fi
  banner=$({ head -c 400 "$err"; echo; tail -c 400 "$err"; echo; print -r -- "$res" | jq -r '[.subtype, .result] | map(tostring) | join(" ")'; } 2>/dev/null)
  if print -r -- "$banner" | grep -qiE "$LANE_QUOTA_RE"; then print quota; else print fail; fi; }
lane_brief(){ # BACKEND BRIEF → the brief with the header and the backend's rules appended
  local be=$1 rules
  [ "$be" = claude ] && rules=$LANE_CLAUDE_RULES || rules=$LANE_AGY_RULES
  print -r -- "$2"
  [ -n "$LANE_HEADER_FILE" ] && [ -s "$LANE_HEADER_FILE" ] && { print; cat "$LANE_HEADER_FILE"; }
  [ -s "$rules" ] && { print; cat "$rules"; }
  [ "$be" = agy ] && { print; print -r -- "WT_INT=$LANE_WT"; }
  return 0; }

stage(){ # NAME TIMEOUT BRIEF [ROLE] — run one agent stage to completion. Sets STAGE_OK STAGE_IDLEKILL
  # STAGE_DOWNGRADED STAGE_RC STAGE_MODEL STAGE_OUT. Returns 1 only when the stage never ran properly.
  local name=$1 timeout=$2 role=${4:-$(lane_role_for "$1")} n=${1//\//-} attempt=1
  local be model brief out err ap verdict age mo me bin wtname res
  local -a eff
  be=$(lane_backend "$role")
  mkdir -p "$LANE_LOGS"
  STAGE_OK=0; STAGE_IDLEKILL=0; STAGE_DOWNGRADED=0; STAGE_RC=; STAGE_MODEL=
  while :; do
    if [ "$STAGE_DOWNGRADED" != 1 ]; then model=$(lane_model "$role" "$be") || { log "⚠ stage $name has no usable model — not run"; return 1; }; fi
    STAGE_MODEL=$model; brief=$(lane_brief "$be" "$3")
    out="$LANE_LOGS/out-$n.jsonl"; [ "$be" = agy ] && [ "$LANE_AGY_FORMAT" = text ] && out="$LANE_LOGS/out-$n.md"
    err="$LANE_LOGS/out-$n.stderr"; STAGE_OUT=$out
    : > "$out"; : > "$err"; STAGE_IDLEKILL=0; LANE_SEEN_PIDS=()
    case "$be" in
      agy)
        eff=(--effort high); [[ "$model" == claude-* ]] && eff=()
        log "════ $name started (agy role $role timeout $timeout model $model attempt $attempt)"
        [ -d "$LANE_WT" ] || lane_fresh || return 1
        ( cd "$LANE_WT" && exec "$LANE_AGY_BIN" -p="$brief" $eff --print-timeout "$timeout" --model "$model" \
            --output-format "$LANE_AGY_FORMAT" > "$out" 2> "$err" < /dev/null ) &
        ;;
      claude)
        bin=$(lane_claude_bin)
        [ -x "$bin" ] || { log "⚠ no claude binary found — stage $name not run"; return 1; }
        log "════ $name started (claude role $role model $model attempt $attempt; no print-timeout — the run ends when the model stops)"
        if [ -d "$LANE_WT" ]; then
          # CONTINUE / review stages reuse the lane's worktree: run inside it, no --worktree.
          ( cd "$LANE_WT" && exec "$bin" -p "$brief" --model "$model" --permission-mode auto \
              --output-format stream-json --verbose > "$out" 2> "$err" < /dev/null ) &
        else
          wtname=${LANE_WT:t}
          if [ "${LANE_WT:h}" != "$LANE_REPO/.claude/worktrees" ]; then
            log "⚠ LANE_WT=$LANE_WT is not under $LANE_REPO/.claude/worktrees, where claude --worktree creates it — not run"; return 1
          fi
          git -C "$LANE_REPO" check-ignore -q ".claude/worktrees/$wtname" \
            || { log "⚠ .claude/worktrees is not git-ignored in $LANE_REPO — refusing to create a worktree there"; return 1; }
          ( cd "$LANE_REPO" && exec "$bin" -p "$brief" --worktree "$wtname" --model "$model" --permission-mode auto \
              --output-format stream-json --verbose > "$out" 2> "$err" < /dev/null ) &
        fi
        ;;
      *) log "⚠ unknown backend '$be' for role $role — stage $name not run"; return 1;;
    esac
    ap=$!
    # WATCHDOG. agy can finish, push all its work, print "root agent idle; waiting for N background task(s)" and
    # then block until --print-timeout (G1 sat like that for 1h43m with its branch already pushed). But the banner
    # also appears EARLY while a subagent is genuinely working (G1 pushed 27 min after it showed), and a 10-minute
    # quiet-output rule killed G1-tests mid-flight so it committed nothing. So kill only when the output has not
    # grown for 45 min AND no worktree file changed for 30 min. A false kill destroys work; a late kill costs time.
    # Claude runs have no banner and no print-timeout, so for them the quiet rule alone applies — their normal
    # exit when the model stops is NOT a hang; we simply wait on the process.
    while kill -0 "$ap" 2>/dev/null; do
      sleep "$LANE_POLL_SECS"
      lane_record_tree "$ap"
      if [ "$be" = agy ]; then grep -q "root agent idle; waiting for" "$out" "$err" 2>/dev/null || continue; fi
      mo=$(lane_mtime "$out"); me=$(lane_mtime "$err"); (( me > mo )) && mo=$me
      age=$(( $(date +%s) - mo ))
      [ "$age" -ge "$LANE_IDLE_OUTPUT_SECS" ] || continue
      if lane_wt_recent "$LANE_WT" "$LANE_IDLE_WT_SECS"; then
        log "$name output quiet ${age}s but the worktree changed in the last ${LANE_IDLE_WT_SECS}s — leaving it alone"; continue
      fi
      log "⚠ $name idle-hung ${age}s with a quiet worktree — killing its process tree; the reality checks decide"
      lane_kill_tree "$ap" >/dev/null; STAGE_IDLEKILL=1; break
    done
    wait "$ap" 2>/dev/null; STAGE_RC=$?
    lane_reap_leftovers "$name"
    log "════ $name exit=$STAGE_RC size=$(( $(wc -c < "$out") )) idlekill=$STAGE_IDLEKILL"
    # An idle-kill is NOT a failure: the root agent had finished. Never retry the brief (that re-does finished,
    # usually pushed, work) — follow with a CONTINUE stage. Gates still refuse it: an idle-killed REVIEW is not a
    # clean review.
    [ "$STAGE_IDLEKILL" = 1 ] && { STAGE_OK=1; return 0; }
    if [ "$be" = agy ]; then verdict=$(lane_agy_verdict "$out" "$err" "$STAGE_RC"); else verdict=$(lane_claude_verdict "$out" "$err" "$STAGE_RC"); fi
    if [ "$verdict" = ok ]; then
      STAGE_OK=1
      if [ "$be" = claude ]; then
        res=$(grep '"type":"result"' "$out" | tail -1 | jq -r '.result // empty' 2>/dev/null)
        print -r -- "${res[-600,-1]}" | grep -qiE "$LANE_PROMISE_RE" \
          && log "⚠ $name ended promising a later report — there is no later; judge what landed from git and GitHub"
      fi
      return 0
    fi
    STAGE_OK=0
    log "⚠ stage $name DID NOT RUN properly (verdict=$verdict rc=$STAGE_RC): $({ head -c 160 "$err"; head -c 160 "$out"; } | tr '\n' ' ')"
    [ "$attempt" -ge "$LANE_STAGE_TRIES" ] && { log "⚠ stage $name failed $attempt times — giving up on it"; return 1; }
    attempt=$((attempt+1))
    if [ "$role" = decide ] && [ -n "$LANE_DECIDE_FALLBACK_MODEL" ] && [ "$STAGE_DOWNGRADED" != 1 ]; then
      model=$LANE_DECIDE_FALLBACK_MODEL; STAGE_DOWNGRADED=1
      log "⚠ $name is a DECIDING review and $STAGE_MODEL did not answer — retrying on $model. It will NOT count as clean. VERIFY THIS PR BY HAND."
      continue
    fi
    if [ "$verdict" = capacity ]; then
      log "⚠ NO CAPACITY for $model on $name (503, not quota) — waiting will not help; switch the model in $(lane_marker "$role" "$be"). Re-reading it in ${LANE_CAPACITY_WAIT_SECS}s."
      sleep "$LANE_CAPACITY_WAIT_SECS"; continue
    fi
    log "waiting for $be (quota reset / CLI recovery) before retrying $name…"
    wait_for_model "$be" "$model" || { log "$be never came back — giving up on $name"; return 1; }
  done; }

lane_gate_ran(){ # STAGE-LABEL → 0 only if the last stage genuinely ran to completion on its intended model
  if [ "$STAGE_OK" != 1 ] || [ "$STAGE_IDLEKILL" = 1 ] || [ "$STAGE_DOWNGRADED" = 1 ]; then
    log "$1 DID NOT RUN cleanly (ok=$STAGE_OK idlekill=$STAGE_IDLEKILL downgraded=$STAGE_DOWNGRADED) — NOT clean"; return 1
  fi; }
lane_review_brief(){ # ROLE PR TEXT
  local be url="https://github.com/$LANE_GH_REPO/pull/$2"
  be=$(lane_backend "$1")
  if [ "$be" = agy ]; then
    # Always the FULL URL: a bare number once resolved to another repo and posted comments there.
    print -r -- "/pr-codereview-comprehensive $url

Review THAT URL: $LANE_GH_REPO pull request $2. Confirm repo and title before posting. $3"
  else
    print -r -- "Review pull request $url ($LANE_GH_REPO #$2). Read it with gh pr view and gh pr diff; confirm the repo and
title first. Post each real defect as an inline review comment with file and line (gh api
repos/$LANE_GH_REPO/pulls/$2/comments). Do not edit, commit or push anything. $3"
  fi; }

cont(){ # NAME BRANCH BRIEF-FILE — finish whatever an earlier stage on this brief left undone
  stage "$1-CONTINUE" "$LANE_BUILD_TIMEOUT" "CONTINUE STAGE for branch $2 (fetch it and check it out in the lane worktree). A previous run worked on this brief and may have hit its time limit or been stopped. Start from git status, git diff and git log origin/$LANE_BASE..HEAD, and FINISH whatever is not yet done; if it is already complete, say ALREADY COMPLETE and stop. Commit and push per step.

$(cat "$(lane_brief_path "$3")")" build; }

review(){ # BRANCH — two early passes (fixing between), then the deciding pass. Sets CLEAN and PR.
  local i B0 B1 T
  PR=$(prnum "$1"); [ -n "$PR" ] || { log "no PR for $1 — skipping review"; CLEAN=0; return; }
  for i in 1 2; do
    B0=$(count "$PR"); T=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    stage "CCR-$1-$i" "$LANE_REVIEW_TIMEOUT" "$(lane_review_brief review "$PR" "Pass $i. Read existing comments first and do not repeat them; post only what is new or still broken, with file and line; if clean, one summary comment and no inline comments.")" review
    lane_gate_ran "review $1 pass $i" || { CLEAN=0; return; }
    B1=$(count "$PR"); log "review $1 pass $i: comments $B0 → $B1"
    { lane_is_count "$B0" && lane_is_count "$B1"; } || { log "comment count unavailable (GitHub API) — NOT clean"; CLEAN=0; return; }
    [ "$B1" -le "$B0" ] && break
    stage "FIX-$1-$i" "$LANE_BUILD_TIMEOUT" "STAGE FIX — PR #$PR (branch $1; fetch and check it out in the lane worktree). Read the inline review comments created after $T: gh api repos/$LANE_GH_REPO/pulls/$PR/comments --paginate. Fix the BLOCKING ones (correctness, security, money, authorization, data loss). For OPTIONAL suggestions, reply briefly and leave them for a human — do not implement them. If a finding needs a DESIGN decision not in the docs, reply that it is parked for the maintainer. Never delete or weaken a test assertion. Commit and push per fix; run the suites you touched." build
  done
  # A clean early pass is corroboration, not proof: the merge is decided by the deciding pass on the strong model.
  decide_review "$PR" "$1" 3 0 "Final, DECIDING pass: verify earlier findings are genuinely fixed; post only what is still broken or new, with file and line.

$LANE_DECIDE_BRIEF"; }

item(){ # NAME BRANCH BRIEF-FILE [BRIEF-FILE-2] — build, continue, open the PR, review. Resumes if the branch exists.
  [ "$LANE_BUILD_BACKEND" = agy ] && lane_fresh
  if exists "$2"; then log "branch $2 exists — resuming"; cont "$1" "$2" "$3"
  else stage "$1" "$LANE_BUILD_TIMEOUT" "$(cat "$(lane_brief_path "$3")")" build; cont "$1" "$2" "$3"; fi
  [ -n "$4" ] && stage "$1-b" "$LANE_BUILD_TIMEOUT" "CONTINUE on branch $2 (fetch and check it out in the lane worktree): now do the SECOND brief below; skip what is already done. Commit and push per step.

$(cat "$(lane_brief_path "$4")")" build
  [ -n "$(prnum "$2")" ] || stage "$1-PR" "$LANE_BUILD_TIMEOUT" "Branch $2 exists on origin (fetch and check it out in the lane worktree). If its work is complete per the brief(s) $(lane_brief_path "$3")${4:+ and $(lane_brief_path "$4")}, open the PR now: gh pr create -R $LANE_GH_REPO --base $LANE_BASE --head $2 with a full description. Otherwise finish it first, commit, push, then open the PR." build
  review "$2"; }

sync_main(){ # BRANCH — merge origin/<base> into the branch so GitHub can build the merge ref and CI runs
  stage "SYNC-${1//\//-}" "$LANE_BUILD_TIMEOUT" "SYNC STAGE. Branch $1 (git fetch origin && git checkout $1 in the lane worktree). origin/$LANE_BASE has moved since this branch was created and GitHub cannot build the PR's merge ref, so CI has not run on it. MERGE origin/$LANE_BASE INTO the branch (git merge origin/$LANE_BASE — do NOT rebase; review comments reference these commits). Resolve every conflict so BOTH sides' intent survives: $LANE_BASE carries recent fixes and bot merges, the branch carries its feature — keep both. Then pnpm exec tsc --noEmit in apps/server, run the suites the branch touches, commit the merge, PUSH. Report each conflict and how you resolved it." build; }
ci_state(){ gh_try gh pr checks "$1" -R "$LANE_GH_REPO" --json name,state --jq ".[]|select(.name|test(\"$LANE_CI_CHECK_RE\"))|.state" | head -1 || true; }

land(){ # PR [hold] — sync if needed, re-review the sync, wait for CI, merge only when LANE_MERGE=1 and not held
  local pr=$1 hold=$2 br m s b0 b1 n t
  br=$(gh_try gh pr view "$pr" -R "$LANE_GH_REPO" --json headRefName --jq .headRefName)
  [ -n "$br" ] || { log "could not read PR #$pr's branch from GitHub — leaving it open rather than guessing"; return; }
  m=$(gh_try gh pr view "$pr" -R "$LANE_GH_REPO" --json mergeable --jq .mergeable)
  [ -n "$m" ] || { log "could not read PR #$pr's mergeable state — leaving it open"; return; }
  s=$(ci_state "$pr")
  if [ "$m" = CONFLICTING ] || [ -z "$s" ]; then
    log "PR #$pr mergeable=$m ci=${s:-none} — syncing with $LANE_BASE"; sync_main "$br"
    decide_review "$pr" "$br" sync 0 "The branch was just synced with $LANE_BASE (a merge commit resolving conflicts). Read the existing comments; review ONLY the merge commit and anything still broken; post only new real defects with file and line, or one summary comment if clean."
    [ "$CLEAN" = 1 ] || { log "post-sync review of #$pr did not come back clean — leaving it open"; return; }
  fi
  for n in $(seq 1 "$LANE_CI_TRIES"); do s=$(ci_state "$pr"); case "$s" in SUCCESS|FAILURE|ERROR|CANCELLED) break;; esac; sleep "$LANE_CI_SECS"; done
  [ "$s" = SUCCESS ] || { log "PR #$pr CI=${s:-none} — left open"; return; }
  if [ "$hold" = hold ] || [ "$LANE_MERGE" != 1 ]; then log "PR #$pr is green and clean — HELD for the maintainer"; return; fi
  t=$(gh_try gh pr view "$pr" -R "$LANE_GH_REPO" --json title --jq .title)
  gh pr merge "$pr" -R "$LANE_GH_REPO" --squash --admin --subject "$t (#$pr)" >/dev/null 2>&1
  # Verify the merge LANDED on the base branch, not the MERGED label.
  git -C "$LANE_REPO" fetch -q origin "$LANE_BASE"
  if [ -n "$(git -C "$LANE_REPO" log "origin/$LANE_BASE" -50 --format=%H --grep="(#$pr)" --fixed-strings | head -1)" ]; then
    log "PR #$pr merged — on origin/$LANE_BASE:"; git -C "$LANE_REPO" log "origin/$LANE_BASE" -1 --stat --format='%h %s' --grep="(#$pr)" --fixed-strings; MERGED=1
  else log "⚠ PR #$pr merge did not land on origin/$LANE_BASE"; fi; }
merge_if_clean(){ [ "$CLEAN" = 1 ] || { log "PR #$1 NOT clean — left open"; return; }; land "$1"; }

# ── Deploy ───────────────────────────────────────────────────────────────────────────────────────────────────
deploy_main(){ # NODE SYMBOL [LABEL] — deploy origin/<base> to ONE explicitly numbered node, then verify it.
  # There is NO default node: plain `bash deploy.sh` deploys to every node in deploy-targets.conf.
  # SYMBOL is a string only the new code has; it must be found in the RUNNING container. Sets DEPLOY_OK.
  local node=$1 symbol=$2 label=${3:-$LANE_NAME} wt=$LANE_DEPLOY_WT line num name ip dns user dir l full sha r n rc
  local target proj cid rev state hits dlog
  local -a sshopts
  DEPLOY_OK=0
  lane_is_count "$node" || { log "deploy_main needs an explicit node NUMBER (got '${node}') — there is no default node; refusing"; return 1; }
  [ -n "$symbol" ] || { log "deploy_main needs a SYMBOL that only the new code has, to find in the running container — refusing"; return 1; }
  if [ ! -d "$wt" ]; then
    git -C "$LANE_REPO" fetch -q origin && git -C "$LANE_REPO" worktree add -q --detach "$wt" "origin/$LANE_BASE" || { log "could not create the deploy worktree $wt"; return 1; }
  fi
  # Deploy from a dedicated worktree: stashing the maintainer's deploy.sh edit once left their checkout conflicted.
  line=$(grep -E "^${node}:" "$wt/deploy-targets.conf" 2>/dev/null | head -1)
  [ -n "$line" ] || { log "node $node is not in $wt/deploy-targets.conf — refusing"; return 1; }
  IFS=: read -r num name ip dns user dir <<< "$line"
  for l in ${=LANE_LIVE_NODES}; do
    if [ "$name" = "$l" ] && [ "$LANE_ALLOW_LIVE_DEPLOY" != "$name" ]; then
      log "node $node is $name, a LIVE community — lanes never deploy there (LANE_ALLOW_LIVE_DEPLOY=$name overrides); refusing"; return 1
    fi
  done
  # deploy.sh exports CF/admin secrets from its own .env; without one it would push EMPTY values to the node.
  [ -s "$wt/.env" ] || { log "no .env in the deploy worktree $wt — deploy.sh would send empty secrets. Copy the deploy .env there (never print it); refusing"; return 1; }
  # Serialise: two lanes deploying to one VM at once killed both ssh sessions (2026-09-16).
  lane_lock deploy 1800 || { log "deploy lock held for 30 min — skipping deploy"; return 1; }
  if ! { git -C "$wt" fetch -q origin && git -C "$wt" checkout -q --detach "origin/$LANE_BASE"; }; then
    log "could not move $wt to origin/$LANE_BASE — not deploying"; lane_unlock deploy; return 1
  fi
  # Stale manual image pins in deploy.sh / docker-compose.yml have shipped old images while looking normal.
  if [ -n "$(git -C "$wt" status --porcelain --untracked-files=no)" ]; then
    log "deploy worktree $wt has local edits to tracked files — not deploying:"; git -C "$wt" status --short --untracked-files=no; lane_unlock deploy; return 1
  fi
  full=$(git -C "$wt" rev-parse HEAD); sha=${full[1,7]}
  log "deploying $LANE_BASE $sha to node $node ($name)"
  r=
  for n in $(seq 1 "$LANE_IMAGE_TRIES"); do
    r=$(gh_try gh run list -R "$LANE_GH_REPO" --branch "$LANE_BASE" --limit 20 --json headSha,name,status,conclusion \
          --jq ".[]|select(.name==\"$LANE_IMAGE_WORKFLOW\" and .headSha==\"$full\")|\"\(.status) \(.conclusion // \"\")\"" | head -1)
    case "$r" in "completed success"*) break;; completed*) log "image build for $sha finished '$r' — not deploying"; lane_unlock deploy; return 1;; esac
    sleep "$LANE_IMAGE_SECS"
  done
  [[ "$r" == "completed success"* ]] || { log "image build for $sha not finished after $LANE_IMAGE_TRIES polls — not deploying"; lane_unlock deploy; return 1; }
  dlog="$LANE_LOGS/deploy-$label.log"; mkdir -p "$LANE_LOGS"
  ( cd "$wt" && DEPLOY_TAG=$sha DEPLOY_PULL=1 bash deploy.sh "$node" > "$dlog" 2>&1 ); rc=$?
  log "deploy.sh exit=$rc (log $dlog)"
  # A failed pull silently degrades to a source build on the node — the label check below catches it.
  grep -q "Building" "$dlog" && log "⚠ deploy log shows a source BUILD — the image pull may have failed"
  sleep "$LANE_DEPLOY_SETTLE_SECS"
  target=${LANE_DEPLOY_SSH:-$user@$ip}; proj=${(L)dir}
  sshopts=(-o BatchMode=yes -o ConnectTimeout=10)
  cid=$(ssh $sshopts "$target" "sudo docker ps -q --filter label=com.docker.compose.project=$proj --filter label=com.docker.compose.service=beanpool-node | head -1" 2>/dev/null)
  if [ -n "$cid" ]; then
    rev=$(ssh $sshopts "$target" "sudo docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' $cid" 2>/dev/null)
    state=$(ssh $sshopts "$target" "sudo docker inspect --format 'restarts={{.RestartCount}} status={{.State.Status}}' $cid" 2>/dev/null)
    hits=$(ssh $sshopts "$target" "sudo docker exec $cid grep -rlF -- ${(qq)symbol} $LANE_DEPLOY_GREP_PATHS 2>/dev/null | head -3" 2>/dev/null)
  fi
  log "node $node container=${cid:-NONE} revision=${rev:-?} expected=$full $state"
  log "symbol ${(qq)symbol} found in: ${hits:-NOWHERE}"
  lane_unlock deploy
  if [ -n "$cid" ] && [ "$rev" = "$full" ] && [ -n "$hits" ]; then DEPLOY_OK=1; log "deploy to node $node VERIFIED ($sha)"; return 0; fi
  log "⚠ DEPLOY NOT VERIFIED on node $node — revision label and/or symbol check failed"; return 1; }

source "$LANE_DIR/decide.sh"
