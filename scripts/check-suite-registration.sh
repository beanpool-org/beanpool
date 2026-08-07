#!/bin/bash
# check-suite-registration.sh — fail when a server test suite exists that CI never runs.
#
# WHY THIS EXISTS
#
# apps/server/src/test-*.ts suites are script-style, not vitest, so `turbo run test` cannot see
# them. The only thing that runs them is a hand-maintained list inside test-all.sh, and adding a
# file does not add it to that list. On 2026-08-08 an audit found TWENTY-ONE suites — roughly 250
# assertions covering wash/Sybil defence, DoS caps, request auth, messaging IDOR, logger
# sanitization and treasury economics — that no CI path had ever executed. Every one of them
# passed. They were not failing; they were simply invisible, and a suite nobody runs is a suite
# that silently stops being true.
#
# Two of them could only ever have failed for anyone who tried them casually, because they refuse
# to run without an env flag rather than passing vacuously. That is good suite design and it is
# exactly why they never got wired in.
#
# So: registration is now enforced rather than remembered.
#
# HOW IT DECIDES
#
# "Registered" means a name appears in a real INVOCATION, never in prose. Comments in test-all.sh
# mention suite names freely (there is a `test-x hangs` example in one), so a naive grep over the
# file reports false positives. Only two shapes actually run a suite:
#
#     for t in a b c; do ... tsx "src/$t.ts"     ← the batch loops
#     tsx src/test-name.ts                       ← the env-flag variants
#
# Both are matched below. Prose is not.
#
# It also flags the reverse — a registered name with no file — which is how a typo in the list
# turns into a suite that quietly never runs.

set -o pipefail
cd "$(dirname "$0")/.." || exit 1

RUNNER="scripts/test-all.sh"
SUITE_DIR="apps/server/src"

# ── Deliberate exclusions ────────────────────────────────────────────────────
# Add a name here ONLY with a reason. An empty allowlist is the goal; every entry is a suite
# whose invariants nothing is checking, so treat this list as debt rather than configuration.
ALLOW=(
  # (none — every suite on disk is currently registered)
)

on_disk=$(find "$SUITE_DIR" -maxdepth 1 -name 'test-*.ts' -exec basename {} .ts \; | sort)

# Names reached by a batch loop: pull each `for t in ...; do` list and split it.
loop_names=$(grep -oE '^[[:space:]]*for t in [a-z0-9 _-]+;' "$RUNNER" \
             | sed -E 's/^[[:space:]]*for t in //; s/;$//' | tr ' ' '\n')
# Names invoked directly, with or without quotes.
direct_names=$(grep -oE 'tsx "?src/test-[a-z0-9-]+\.ts' "$RUNNER" \
               | sed -E 's|.*src/||; s|\.ts$||')

registered=$(printf '%s\n%s\n' "$loop_names" "$direct_names" \
             | grep -E '^test-[a-z0-9-]+$' | sort -u)

allowed=$(printf '%s\n' "${ALLOW[@]}" | grep -E '^test-' | sort -u)

unregistered=$(comm -23 <(echo "$on_disk") <(echo "$registered"))
[ -n "$allowed" ] && unregistered=$(comm -23 <(echo "$unregistered") <(echo "$allowed"))
missing=$(comm -13 <(echo "$on_disk") <(echo "$registered"))

rc=0

if [ -n "$unregistered" ]; then
  echo "❌ Test suites exist that CI never runs:"
  echo "$unregistered" | sed 's/^/     /'
  echo ""
  echo "   Add each to a batch loop in $RUNNER — or, if it needs an env flag, to its own"
  echo "   invocation beside the other flag variants. If a suite genuinely should not run in"
  echo "   CI, add it to ALLOW in $0 with a reason."
  rc=1
fi

if [ -n "$missing" ]; then
  echo "❌ Registered in $RUNNER but no such file in $SUITE_DIR:"
  echo "$missing" | sed 's/^/     /'
  echo ""
  echo "   A name that does not resolve is a suite that never runs. Fix the spelling, or drop"
  echo "   the entry if the suite was deleted on purpose."
  rc=1
fi

if [ $rc -eq 0 ]; then
  echo "✓ all $(echo "$on_disk" | wc -l | tr -d ' ') server suites in $SUITE_DIR are registered in $RUNNER"
fi

exit $rc
