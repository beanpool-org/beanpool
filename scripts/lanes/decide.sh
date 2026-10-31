#!/bin/zsh
# scripts/lanes/decide.sh — DECIDING reviews, one at a time. Sourced by lib.sh; not run directly.
#
# One strong-model deciding pass at a time: AGY's Opus quota died after ~45 min of use, and two concurrent passes
# risk exhausting the quota mid-review and silently downgrading one of them. The lock is machine-wide
# (LANE_LOCK_DIR) because lanes from different checkouts share that quota. Every deciding pass — review()'s final
# pass, land()'s post-sync pass and decide_pass — goes through decide_review below, which first waits for GitHub's
# required check on the PR's head (ci_gate). Early passes do not wait.

# A run script may set its own LANE_DECIDE_BRIEF before sourcing lib.sh; this default applies only when it didn't (an
# unconditional assignment here once overwrote a director's brief without anyone noticing, 2026-09-27).
: ${LANE_DECIDE_BRIEF:="DECIDING pass — the code merges if you find nothing new. Earlier fast-model passes on this PR have missed
real authorization and data-leak defects that a stronger model found on first look, so do not assume their coverage.
Order: data loss and privacy leaks, then authorization, then money conservation, then performance on hot paths,
then everything else. Every authorization decision must act on the same row it decided about; anything moving
beans belongs inside conservingTransaction with SUM(balances)+COMMONS_POOL unchanged.
Read the existing comments first and do not repeat them. Post only NEW real defects, with file and line.
Whatever you find, ALSO post exactly one summary issue comment (gh pr comment), CLEAN or NOT CLEAN in its first line,
saying what you verified: a pass with inline findings and no summary leaves the rest of the PR unreviewed."}

ci_hold(){ log "⚠ PR #$1 LEFT FOR THE DIRECTOR, no deciding pass: $2"; }   # watch.sh wakes on this line

ci_fix(){ # PR BRANCH SHA — one fix stage on the lane's build backend, with the failing checks and how to read their logs
  # Only an Actions job has a /job/ URL. Cloudflare Pages reports on every head with .../runs/<id>, and GitHub allows a null
  # URL, which would stop this jq and lose every check. Any check run can be read by its id.
  local failing
  failing=$(gh_try gh api "repos/$LANE_GH_REPO/commits/$3/check-runs?filter=latest&per_page=100" --paginate \
    --jq '.check_runs[] | select(.conclusion | IN("failure", "timed_out", "startup_failure")) | "- \(.name): " +
      if ((.html_url // "") | test("/job/")) then "gh run view --job \(.html_url | sub(".*/job/"; "")) -R '"$LANE_GH_REPO"' --log-failed"
      else "gh api repos/'"$LANE_GH_REPO"'/check-runs/\(.id) --jq .output" end')
  [ -n "$failing" ] || failing="- $LANE_CI_CHECK: gh pr checks $1 -R $LANE_GH_REPO"
  stage "FIX-CI-$2-$CI_FIXES" "$LANE_BUILD_TIMEOUT" "STAGE FIX-CI — PR #$1 (branch $2; fetch and check it out in the lane worktree). GitHub's required check \"$LANE_CI_CHECK\" is RED on the head $3, so the deciding review has not run. The failing checks, each with the command that prints its log:
$failing

Read the logs, find the cause and fix it on the branch. Run the suites you touched, commit and push: the review runs once that push is green. Never delete or weaken a test assertion. If this PR did not cause the failure, change nothing and say so: the director decides." build; }

ci_gate(){ # PR BRANCH — 0 once a deciding pass may run on the PR's head; sets CI_HEAD and CI_NOTE for the brief. (Marty, 31 Oct
  # 2026: 8 of the last 18 reviewed PRs failed their first deciding review, on what GitHub then found or had already shown.)
  # Green: pass. Red: up to LANE_GREEN_FIXES fix stages. Anything else goes to the director unreviewed; a red the PR did
  # not cause is still red here. The head is re-read around every verdict, because a verdict is about one push: ci.yml's
  # concurrency group cancels a superseded run, and that says nothing about the push that replaced it. A new head starts the wait again.
  local pr=$1 br=$2 was= sha s n=0 none=0
  while :; do
    sha=$(pr_head "$pr")
    [ -n "$sha" ] || { ci_hold "$pr" "GitHub did not give its head commit"; return 1; }
    if [ "$sha" != "$was" ]; then
      [ -z "$was" ] || log "#$pr has a new head ${sha[1,8]} — the wait starts again on that one"
      was=$sha; n=0; none=0
    fi
    s=$(ci_head_state "$sha")
    if [ "$s" != pending ] && [ "$s" != unknown ]; then [ "$(pr_head "$pr")" = "$sha" ] || continue; fi
    case "$s" in
      green)
        CI_HEAD=$sha; CI_NOTE="GitHub's required check \"$LANE_CI_CHECK\" is GREEN on this PR's head $sha. Review that commit."
        log "#$pr is green on ${sha[1,8]}"; return 0;;
      red)
        (( CI_FIXES < LANE_GREEN_FIXES )) || { ci_hold "$pr" "still red on ${sha[1,8]} after $CI_FIXES fix stage(s)"; return 1; }
        CI_FIXES=$((CI_FIXES+1))
        log "#$pr is red on ${sha[1,8]} — no review yet, fix stage $CI_FIXES of $LANE_GREEN_FIXES"
        ci_fix "$pr" "$br" "$sha"
        # A stage that pushed nothing leaves the same red to read: another one would cost a stage to learn nothing.
        [ "$(pr_head "$pr")" != "$sha" ] || { ci_hold "$pr" "fix stage $CI_FIXES pushed nothing, still red on ${sha[1,8]}"; return 1; }
        continue;;
      cancelled) ci_hold "$pr" "the run on ${sha[1,8]} was cancelled"; return 1;;
      unknown)   ci_hold "$pr" "GitHub did not answer about ${sha[1,8]}"; return 1;;
      none)
        if pr_only_md "$pr"; then
          CI_HEAD=$sha; CI_NOTE="This PR changes only .md files, so ci.yml started no run on its head $sha. Review that commit."
          log "#$pr changes only .md files — no run to wait for"; return 0
        fi
        none=$((none+1))
        (( none < LANE_GREEN_NONE_TRIES )) || { ci_hold "$pr" "no run started on ${sha[1,8]} after $none polls"; return 1; };;
    esac
    n=$((n+1))
    (( n < LANE_GREEN_TRIES )) || { ci_hold "$pr" "\"$LANE_CI_CHECK\" still pending on ${sha[1,8]} after $n polls"; return 1; }
    (( n % 10 == 1 )) && log "waiting for GitHub on #$pr, head ${sha[1,8]}: $s (poll $n of $LANE_GREEN_TRIES)"
    sleep "$LANE_GREEN_SECS"
  done; }

decide_review(){ # PR BRANCH [SUFFIX] [ALLOWANCE] [BRIEF] — one deciding pass; sets CLEAN. Never merges.
  # SUFFIX names the stage CCR-<branch>-<SUFFIX> (3 or sync). ALLOWANCE is how many new comments still count as
  # clean (1 = the single summary comment a clean pass posts).
  local PRN=$1 BR=$2 sfx=${3:-3} allow=${4:-1} extra=${5:-$LANE_DECIDE_BRIEF} be model i B0 B1
  CLEAN=0; CI_FIXES=0
  be=$LANE_DECIDE_BACKEND
  if [ "$be" != director ]; then
    model=$(lane_model decide "$be") || { log "no deciding model — #$PRN left open for the maintainer"; return; }
  fi
  while :; do
    # Outside the slot: this wait can take an hour, and a held slot would starve every other lane's finished build.
    ci_gate "$PRN" "$BR" || return
    if [ "$be" = director ]; then log "PR #$PRN ready for the in-session deciding review"; return; fi
    lane_lock decide 4800 || { log "waited 80 min for the deciding-review slot — giving up; #$PRN left open"; return; }
    # Do not START a deciding pass the strong model cannot answer. A retry that falls back to the build model only
    # logs a warning, and a warning does not stop a merge — #824 reached a Flash-only deciding pass that way at
    # 05:54. Probe first, wait for the quota instead, and never merge on a fallback.
    for i in $(seq 1 "$LANE_DECIDE_PROBE_TRIES"); do
      lane_probe "$be" "$model" && break
      log "$model has not come back (probe $i/$LANE_DECIDE_PROBE_TRIES) — holding #$PRN rather than deciding it on a cheaper model"
      [ "$i" -eq "$LANE_DECIDE_PROBE_TRIES" ] && { log "gave up waiting for $model — #$PRN left open for the maintainer"; lane_unlock decide; return; }
      sleep "$LANE_DECIDE_PROBE_SECS"
    done
    # The slot and the probe can take hours. Green is about the head it was read on.
    [ "$(pr_head "$PRN")" = "$CI_HEAD" ] && break
    log "#$PRN moved past ${CI_HEAD[1,8]} while it queued for the slot — back to the wait"; lane_unlock decide
  done
  B0=$(count "$PRN"); log "#$PRN comments before the deciding pass: $B0"
  lane_is_count "$B0" || { log "could not read #$PRN's comments — refusing to decide blind"; lane_unlock decide; return; }
  stage "CCR-$BR-$sfx" "$LANE_REVIEW_TIMEOUT" "$(lane_review_brief decide "$PRN" "$CI_NOTE

$extra")" decide
  lane_unlock decide
  lane_gate_ran "#$PRN deciding review" || return
  B1=$(count "$PRN"); log "#$PRN comments after the deciding pass: $B1"
  if lane_is_count "$B1" && [ "$B1" -le $((B0+allow)) ]; then CLEAN=1
  else log "#$PRN deciding pass found new defects, or the count was unavailable — NOT clean"; fi; }

decide_pass(){ # PR BRANCH — deciding pass on an open PR, then land it if clean (land holds unless LANE_MERGE=1)
  local PRN=$1 BR=$2 st
  CLEAN=0
  st=$(gh_try gh pr view "$PRN" -R "$LANE_GH_REPO" --json state --jq .state)
  [ "$st" = OPEN ] || { log "#$PRN is not open (state=${st:-unknown}) — skipping"; return; }
  [ "$(gh_try gh pr view "$PRN" -R "$LANE_GH_REPO" --json isDraft --jq .isDraft)" = "true" ] \
    && { gh pr ready "$PRN" -R "$LANE_GH_REPO" >/dev/null 2>&1; log "#$PRN taken out of draft"; }
  decide_review "$PRN" "$BR" 3 1
  merge_if_clean "$PRN"; }
