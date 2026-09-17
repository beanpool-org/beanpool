#!/bin/zsh
# stop-at-boundary.sh LANE... — let each lane finish the stage it is in, and stop it (whole process tree) the
# moment its log shows a boundary stage starting.
#
# Written for the 2026-09-17 routing change: running lanes were on the old rules, where the next FIX stage said
# "address EVERY comment" and the deciding pass ran on AGY. The stage in flight was allowed to finish; the lane was
# stopped as it began either of those. An agy command line holds the brief text, not the stage name, so the run
# cannot be found by name — lane_stop walks the tree from the run script's PIDs instead.
#
# LANE_BOUNDARY_RE (extended regex, matched against the last log line) picks the boundary. Default: a FIX, SYNC,
# deciding (-3) or post-sync review stage starting.
source "${0:A:h}/lib.sh"
: ${LANE_BOUNDARY_RE:=════ (FIX-|SYNC-|CCR-[^ ]*-3 |CCR-[^ ]*-sync )[^ ]* ?started}
(( $# )) || { print -u2 "usage: stop-at-boundary.sh LANE..."; exit 2; }
LANES=("$@")
typeset -A DONE
while :; do
  for l in $LANES; do
    [ -n "${DONE[$l]}" ] && continue
    if ! (( ${#$(lane_pids "$l")} )); then DONE[$l]=exited; log "$l already stopped"; continue; fi
    last=$(tail -1 "$LANE_STATE/log-$l.txt" 2>/dev/null)
    if print -r -- "$last" | grep -qE "$LANE_BOUNDARY_RE"; then
      lane_stop "$l"
      DONE[$l]=stopped
      log "$l stopped at the stage boundary — next stage was: $last"
    fi
  done
  (( ${#DONE} == ${#LANES} )) && { log "all ${#LANES} lane(s) stopped"; exit 0; }
  sleep "${LANE_BOUNDARY_POLL_SECS:-30}"
done
