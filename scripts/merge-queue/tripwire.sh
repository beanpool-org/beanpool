#!/bin/bash
# tripwire.sh: the once-a-day full run on main on the Mac (docs/merge-gate.md; launchd:
# scripts/launchd/com.marty.beanpool-test-all-tripwire.plist.example). It catches what only macOS, Node 26 or one unsharded run
# shows. It holds no merge and touches no PR: a red is a line in the journal, and the director opens a fix.
#
# Waits for the machine's heavy-test lock and holds it for the run, as every full run here does. A scratch worktree at
# origin/main, so the checkout it is called from is never touched. Exit: test-all's, or 1 when it could not start.
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${BOARD_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$ROOT" || exit 1
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

LOCK="${TRIPWIRE_LOCK:-$HOME/.cache/heavy-test.lock}"
for _ in $(seq 1 "${TRIPWIRE_LOCK_TRIES:-180}"); do
  if mkdir "$LOCK" 2>/dev/null; then echo "pid=$$ since=$(date +%s) beanpool tripwire" > "$LOCK/owner"; break; fi
  sleep "${TRIPWIRE_LOCK_SECS:-60}"
done
[ "$(cat "$LOCK/owner" 2>/dev/null | cut -d' ' -f1)" = "pid=$$" ] || { journal tripwire "TRIPWIRE not run: the heavy-test lock stayed held"; exit 1; }

WT=""
cleanup() {
  [ -z "$WT" ] || { git -C "$ROOT" worktree remove --force "$WT" > /dev/null 2>&1; rm -rf "$WT"; git -C "$ROOT" worktree prune > /dev/null 2>&1; }
  rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT TERM

git fetch -q origin main || { journal tripwire "TRIPWIRE not run: could not fetch origin/main"; exit 1; }
SHA=$(git rev-parse origin/main)
WT=$(mktemp -d "${TMPDIR:-/tmp}/test-all-tripwire.XXXXXX") || exit 1
git worktree add --quiet --detach "$WT" "$SHA" || { journal tripwire "TRIPWIRE not run: no worktree at $SHA"; exit 1; }
cd "$WT" || exit 1
pnpm install --frozen-lockfile --reporter=silent || { journal tripwire "TRIPWIRE not run: pnpm install failed at $SHA"; exit 1; }
${TRIPWIRE_RUN:-bash scripts/test-all.sh --all}
RC=$?
if [ "$RC" = 0 ]; then journal tripwire "TRIPWIRE green sha=$(echo "$SHA" | cut -c1-9)"
else journal tripwire "TRIPWIRE red sha=$(echo "$SHA" | cut -c1-9): read the run; this holds no merge"; fi
exit "$RC"
