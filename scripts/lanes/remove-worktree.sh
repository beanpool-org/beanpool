#!/bin/zsh
# remove-worktree.sh WORKTREE... — remove FINISHED lane / headless-Claude worktrees. Refuses any with uncommitted
# changes or unpushed commits. Stops fsmonitor--daemon, unlocks, removes — each step's outcome checked.
source "${0:A:h}/lib.sh"
(( $# )) || { print -u2 "usage: remove-worktree.sh WORKTREE..."; exit 2; }
rc=0
for wt in "$@"; do lane_remove_worktree "$wt" || { rc=1; log "⚠ $wt NOT removed"; }; done
exit $rc
