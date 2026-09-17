#!/bin/zsh
# scripts/lanes/decide.sh — DECIDING reviews, one at a time. Sourced by lib.sh; not run directly.
#
# One strong-model deciding pass at a time: AGY's Opus quota died after ~45 min of use, and two concurrent passes
# risk exhausting the quota mid-review and silently downgrading one of them. The lock is machine-wide
# (LANE_LOCK_DIR) because lanes from different checkouts share that quota. Every deciding pass — review()'s final
# pass, land()'s post-sync pass and decide_pass — goes through decide_review below.

LANE_DECIDE_BRIEF="DECIDING pass — the code merges if you find nothing new. Earlier fast-model passes on this PR have missed
real authorization and data-leak defects that a stronger model found on first look, so do not assume their coverage.
Order: data loss and privacy leaks, then authorization, then money conservation, then performance on hot paths,
then everything else. Every authorization decision must act on the same row it decided about; anything moving
beans belongs inside conservingTransaction with SUM(balances)+COMMONS_POOL unchanged.
Read the existing comments first and do not repeat them. Post only NEW real defects, with file and line.
If you find nothing new, post exactly one summary comment saying so."

decide_review(){ # PR BRANCH [SUFFIX] [ALLOWANCE] [BRIEF] — one deciding pass; sets CLEAN. Never merges.
  # SUFFIX names the stage CCR-<branch>-<SUFFIX> (3 or sync). ALLOWANCE is how many new comments still count as
  # clean (1 = the single summary comment a clean pass posts).
  local PRN=$1 BR=$2 sfx=${3:-3} allow=${4:-1} extra=${5:-$LANE_DECIDE_BRIEF} be model i B0 B1
  CLEAN=0
  be=$LANE_DECIDE_BACKEND
  if [ "$be" = director ]; then log "PR #$PRN ready for the in-session deciding review"; return; fi
  model=$(lane_model decide "$be") || { log "no deciding model — #$PRN left open for the maintainer"; return; }
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
  B0=$(count "$PRN"); log "#$PRN comments before the deciding pass: $B0"
  lane_is_count "$B0" || { log "could not read #$PRN's comments — refusing to decide blind"; lane_unlock decide; return; }
  stage "CCR-$BR-$sfx" "$LANE_REVIEW_TIMEOUT" "$(lane_review_brief decide "$PRN" "$extra")" decide
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
