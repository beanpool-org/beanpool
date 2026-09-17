#!/bin/zsh
# stop.sh LANE... — stop lanes NOW: the run script and its whole process tree (children, grandchildren, every
# level). Killing only the chain script orphans its test suites and agent runs for hours.
# To stop at the next stage boundary instead, use stop-at-boundary.sh.
source "${0:A:h}/lib.sh"
(( $# )) || { print -u2 "usage: stop.sh LANE..."; exit 2; }
rc=0
for l in "$@"; do lane_stop "$l" || rc=1; done
exit $rc
