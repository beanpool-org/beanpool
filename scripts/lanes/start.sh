#!/bin/zsh
# start.sh RUN-SCRIPT — run a lane in the FOREGROUND, logging to scratch/lanes/log-<lane>.txt.
#
# The director launches this with the Bash tool's run_in_background: true. Do NOT add `nohup … &` or a trailing
# `&`: inside a backgrounded call the task "completes" instantly while the lane runs on unwatched.
# caffeinate -i keeps the Mac awake — lanes die when it sleeps.
#
# RUN-SCRIPT must be named run-<lane>.sh; stop.sh, stop-at-boundary.sh and watch.sh find lanes by that name.
source "${0:A:h}/lib.sh"
script=${1:A}
[ -f "$script" ] || { print -u2 "usage: start.sh path/to/run-<lane>.sh"; exit 2; }
[[ "${script:t}" == run-*.sh ]] || { print -u2 "lane scripts must be named run-<lane>.sh (got ${script:t})"; exit 2; }
lane=${${script:t:r}#run-}
# Not lane_pids: this script's own command line (and its $(…) subshells) contain run-<lane>.sh too.
if ps -axo command= | grep -E "(^|[ /])run-${lane}[.]sh" | grep -vq "start[.]sh"; then print -u2 "lane $lane is already running"; exit 1; fi
mkdir -p "$LANE_STATE"
logf="$LANE_STATE/log-$lane.txt"
print -r -- "[$(date +%H:%M)] ──── start.sh: lane $lane from $script (repo $LANE_REPO)" >> "$logf"
LANE_NAME=$lane caffeinate -i zsh "$script" >> "$logf" 2>&1
rc=$?
print -r -- "[$(date +%H:%M)] ──── lane $lane exited rc=$rc" >> "$logf"
exit $rc
