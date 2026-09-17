#!/bin/zsh
# sweep-orphans.sh [--kill] — list (or kill, with --kill) test runners reparented to launchd (PPID 1) that are older
# than an hour. Run it after stopping lanes and whenever the Mac feels slow: one sweep found eight hung suites,
# 13–18 h old, one inside a worktree still in use. LANE_ORPHAN_RE / LANE_ORPHAN_MIN_SECS tune the match.
source "${0:A:h}/lib.sh"
case "$1" in ''|--kill) lane_sweep_orphans "$1";; *) print -u2 "usage: sweep-orphans.sh [--kill]"; exit 2;; esac
