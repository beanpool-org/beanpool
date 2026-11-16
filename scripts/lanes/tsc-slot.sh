#!/bin/bash
# scripts/lanes/tsc-slot.sh <command...> — run a memory-heavy check (a whole-app `tsc --noEmit`, a whole-app vitest run) only when
# one of BP_SLOTS (default 3) slots is free, so a dozen lanes don't run a dozen type-checks at 1.5-3 GB each at once (16 Nov 2026:
# 13 lanes did, the Mac ran out of memory, swap 15/16 GB, about 47% of CPU spent shuffling memory).
#
# A slot is a directory holding the owner's PID. A slot whose PID is dead is taken over. Waits at most 45 minutes, then runs
# anyway. The heavy-test lock still comes first (wait for it in the same shell before calling this); this only limits how many
# run beside each other. The command's exit code is this script's exit code, and the slot is freed when it ends.
#
# Settings: BP_SLOTS (3); BP_SLOT_BASE (~/.cache/bp-tsc-slot: slot i is "$BP_SLOT_BASE-i", shared with every other copy of
# this script on the machine, so keep the default); BP_SLOT_WAIT_SECS (2700) and BP_SLOT_POLL_SECS (15).
# scripts/lanes/test/ci-wait-slot.test.sh proves the limit, the takeover and the exit code.
SLOTS=${BP_SLOTS:-3}; BASE=${BP_SLOT_BASE:-$HOME/.cache/bp-tsc-slot}; MINE=""
WAIT=${BP_SLOT_WAIT_SECS:-2700}; POLL=${BP_SLOT_POLL_SECS:-15}
release(){ [ -n "$MINE" ] && rm -rf "$MINE"; }
trap release EXIT
# A signal frees the slot AND stops the wait. With a bare `trap release INT TERM` the wait loop ran on after Ctrl-C or a TERM.
trap 'release; exit 130' INT
trap 'release; exit 143' TERM
mkdir -p "$(dirname "$BASE")"   # a fresh machine has no ~/.cache: without it every mkdir below fails and the wait runs to its end
deadline=$(( $(date +%s) + WAIT ))
while [ -z "$MINE" ]; do
  for i in $(seq 1 "$SLOTS"); do
    d="$BASE-$i"
    if mkdir "$d" 2>/dev/null; then echo $$ > "$d/pid"; MINE=$d; break; fi
    p=$(cat "$d/pid" 2>/dev/null)
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then rm -rf "$d"; fi   # its owner died: free it
  done
  [ -n "$MINE" ] && break
  [ "$(date +%s)" -ge "$deadline" ] && { echo "tsc-slot: waited $((WAIT / 60)) min, running anyway" >&2; break; }
  sleep "$POLL"
done
"$@"
