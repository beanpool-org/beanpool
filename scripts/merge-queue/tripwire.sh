#!/bin/bash
# tripwire.sh: the once-a-day full run on main on the Mac (docs/merge-gate.md; launchd:
# scripts/launchd/com.marty.beanpool-test-all-tripwire.plist.example). It catches what only macOS, Node 26 or one unsharded run
# shows. It holds no merge and touches no PR: a red is a line in the journal, and the director opens a fix.
#
# Waits for the machine's heavy-test lock and holds it for the run, as every full run here does. A scratch worktree at
# origin/main, so the checkout it is called from is never touched. After the full run it runs the web app's pseudo-locale
# checks on every screen (below). Exit: test-all's, else the pseudo-locale run's, or 1 when it could not start.
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
WLOG=""
cleanup() {
  [ -z "$WT" ] || { git -C "$ROOT" worktree remove --force "$WT" > /dev/null 2>&1; rm -rf "$WT"; git -C "$ROOT" worktree prune > /dev/null 2>&1; }
  [ -z "$WLOG" ] || rm -f "$WLOG"
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

# The web app in the pseudo-locale on every screen (translation tooling design §2.5, slice T4): the daily hook for
# apps/pwa/e2e/words-screens-all.mjs, which no pull-request run carries (the PR gate runs test-all's checks only). It runs
# whatever the full run said and has its own journal line, so neither hides the other. Core is built first (the checks
# read its dist), then the Chromium the browser checks use. TRIPWIRE_WORDS_RUN stands in for it in tests and rehearsals.
# Its journal line names the checks that failed (the runner's last line), so a new red shows while others are still red.
words_screens_run() {
  pnpm turbo run build --filter=@beanpool/core \
    && pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium \
    && pnpm --filter @beanpool/pwa words-screens-all
}
# The run's output goes to the log as before; a copy is kept so the journal line can carry the runner's last line, for example
# `words-screens-all: FAILED w1, w2 (passed w4)`. Checks that are red on main stay red for days, so a bare "red" would read the
# same every night and hide a check that turned red later: naming the checks makes each one a signal again.
WLOG=$(mktemp "${TMPDIR:-/tmp}/tripwire-words.XXXXXX") || WLOG=""
${TRIPWIRE_WORDS_RUN:-words_screens_run} | tee "${WLOG:-/dev/null}"
WRC=${PIPESTATUS[0]}
WSUM=$([ -z "$WLOG" ] || grep '^words-screens-all:' "$WLOG" 2>/dev/null | tail -n 1)
WSUM=${WSUM#words-screens-all: }
if [ "$WRC" = 0 ]; then journal tripwire "TRIPWIRE words-screens green sha=$(echo "$SHA" | cut -c1-9)${WSUM:+ ($WSUM)}"
elif [ -n "$WSUM" ]; then journal tripwire "TRIPWIRE words-screens red sha=$(echo "$SHA" | cut -c1-9): $WSUM; read the run; this holds no merge"
else journal tripwire "TRIPWIRE words-screens red sha=$(echo "$SHA" | cut -c1-9): read the run; this holds no merge (it printed no summary line: it stopped before the checks finished)"; fi
[ "$RC" = 0 ] && exit "$WRC"
exit "$RC"
