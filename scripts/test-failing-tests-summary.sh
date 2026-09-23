#!/bin/bash
# Does the Failure Details block NAME the tests that failed?
#
# WHY THIS EXISTS. 2026-09-23, PR #1065: CI run 35862281845 failed one of 723 PWA tests, and the failing
# test's name was nowhere in the log — the block prints the last 150 lines of the failing task, and a
# Testing Library failure puts a several-hundred-line DOM dump after the `FAIL <file> > <test>` line. It
# was re-run as a flake because there was nothing else to do with it.
#
# The fixtures under scripts/fixtures/ are CAPTURED output, not hand-written: a real `vitest run` of a
# deliberately failing Testing Library test (its DOM dump abridged at one marked point), and a real
# apps/server/src/test-*.ts suite run with one assertion broken, wrapped in the ━━━ headers that
# run_federation_suites writes around each suite.
#
#   bash scripts/test-failing-tests-summary.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=test-all-lib.sh
. "$ROOT/scripts/test-all-lib.sh"

FIXTURES="$ROOT/scripts/fixtures"
run=0; passed=0

assert_has() {
  run=$((run + 1))
  if printf '%s\n' "$2" | grep -qF "$3"; then
    passed=$((passed + 1)); echo "✓ $1"
  else
    echo "✗ $1 (no line containing: $3)"
  fi
}

assert_lacks() {
  run=$((run + 1))
  if printf '%s\n' "$2" | grep -qF "$3"; then
    echo "✗ $1 (unexpectedly found: $3)"
  else
    passed=$((passed + 1)); echo "✓ $1"
  fi
}

# ── the #1065 shape: a vitest failure whose name is buried under its own DOM dump ──
VITEST_LOG="$FIXTURES/vitest-failure.txt"
VITEST_OUT=$(failing_tests_summary < "$VITEST_LOG")

# The premise. If the tail alone ever starts showing the name, this whole check is about nothing.
TAIL=$(tail -150 "$VITEST_LOG")
assert_lacks "the 150-line tail still hides the first failing test (the #1065 symptom)" \
  "$TAIL" "finds a button that is not there"

echo ""
echo "--- vitest ---"
printf '%s\n' "$VITEST_OUT"
echo "---"

assert_has "names the test the tail hides" \
  "$VITEST_OUT" "Sample capture suite > finds a button that is not there"
assert_has "gives that test its first error line" \
  "$VITEST_OUT" "TestingLibraryElementError: Unable to find an accessible element"
assert_has "names the second failing test too" \
  "$VITEST_OUT" "Sample capture suite > compares two numbers"
assert_has "and its assertion" \
  "$VITEST_OUT" "AssertionError: expected 2 to be 3"
assert_has "says how many failed" "$VITEST_OUT" "Failing tests (2)"
assert_has "keeps the file the test lives in" "$VITEST_OUT" "src/components/SampleCard.test.tsx"

# No line may carry a whole serialised DOM: the list has to stay readable.
LONGEST=$(printf '%s\n' "$VITEST_OUT" | awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }')
run=$((run + 1))
if [ "$LONGEST" -le 320 ]; then
  passed=$((passed + 1)); echo "✓ no line runs away (longest $LONGEST chars)"
else
  echo "✗ a line ran away (longest $LONGEST chars, expected ≤ 320)"
fi

# ── the script-style server suites, which turbo run test never sees ──
FED_LOG="$FIXTURES/federation-failure.txt"
FED_OUT=$(failing_tests_summary < "$FED_LOG")

echo ""
echo "--- server suites ---"
printf '%s\n' "$FED_OUT"
echo "---"

assert_has "names the failing assertion of a script-style suite" \
  "$FED_OUT" "1a. getVersion() returns a non-empty string"
assert_has "tags it with the suite it came from" \
  "$FED_OUT" "test-version-resolution: ✗ 1a."
assert_lacks "does not report a passing check as a failure" \
  "$FED_OUT" "1b. getVersion() returns a valid semver"
assert_lacks "does not report a passing suite as a failure" \
  "$FED_OUT" "schema upgrades from v1"

# One broken assertion is ONE failing test. A script-style suite says so three times — the ✗, its own
# `❌ Test failed: …` catch-all and run_federation_suites' closing `❌ … suites failed: …` — and
# counting all three reported this fixture as "Failing tests (3)" (review of PR #1069). The count is the
# point of the block, so it is asserted here and not only implied by the lines.
assert_has "counts one broken assertion as one failing test" "$FED_OUT" "Failing tests (1)"
assert_lacks "does not count a suite's own catch-all as a second test" \
  "$FED_OUT" "❌ Test failed:"
assert_lacks "does not count the closing roll-up as a third test" \
  "$FED_OUT" "Federation suites failed:"

# Two suites, one broken check each: still two, not five.
TWO=$(printf '━━━ test-a ━━━\n✗ check one\n\n❌ Test failed: Error: 1 check(s) failed\n━━━ test-b ━━━\n✗ check two\n\n❌ Test failed: Error: 1 check(s) failed\n\n❌ Federation suites failed: test-a test-b\n' | failing_tests_summary)
assert_has "does not scale the count with the number of failing suites" "$TWO" "Failing tests (2)"
assert_has "names both suites' checks" "$TWO" "test-b: ✗ check two"

# … but each summary is the ONLY evidence in some shape of failure, so neither may just be dropped.

# A suite that throws before it reaches a check prints no ✗ at all.
THREW=$(printf '━━━ test-c ━━━\nRunning…\n❌ Test failed: Error: connect ECONNREFUSED\n\n❌ Federation suites failed: test-c\n' | failing_tests_summary)
assert_has "falls back to the catch-all for a suite that printed no check" \
  "$THREW" "test-c: ❌ Test failed: Error: connect ECONNREFUSED"
assert_has "and counts that as the one failure it is" "$THREW" "Failing tests (1)"

# secrets_guard has no checks and no ━━━ header: one ❌ line is its entire failing output.
GUARD=$(printf '❌ Error: Hardcoded secret keys found in codebase\n' | failing_tests_summary)
assert_has "still names a check whose whole output is one ❌ line" \
  "$GUARD" "❌ Error: Hardcoded secret keys found in codebase"

# The timeout kills a suite mid-check, so it prints neither ✗ nor its catch-all. The roll-up is the
# only place its name survives, and it has to be kept even though another suite did report checks.
KILLED=$(printf '━━━ test-a ━━━\n✗ check one\n\n❌ Test failed: Error: 1 check(s) failed\n━━━ test-d ━━━\nRunning…\n\n❌ Federation suites failed: test-a test-d(TIMEOUT)\n' | failing_tests_summary)
assert_has "keeps the roll-up when it names a suite that left no other trace" \
  "$KILLED" "test-d(TIMEOUT)"
assert_has "names the check that did report too" "$KILLED" "test-a: ✗ check one"

# ── quiet on anything it does not recognise, so an unfamiliar log reads exactly as before ──
CLEAN_OUT=$(printf 'Everything is fine\n✓ one\n✓ two\n2/2 checks passed.\n' | failing_tests_summary)
run=$((run + 1))
if [ -z "$CLEAN_OUT" ]; then
  passed=$((passed + 1)); echo "✓ prints nothing when it recognises no failure"
else
  echo "✗ printed something for a log with no failures: $CLEAN_OUT"
fi

# ── the cap, so one broken shared helper cannot print a thousand lines ──
MANY=$(awk 'BEGIN { for (i = 1; i <= 57; i++) printf " FAIL  src/a.test.ts > suite > case %d\n", i }' \
  | failing_tests_summary)
assert_has "caps the list" "$MANY" "… and 17 more"
assert_has "counts every failure even past the cap" "$MANY" "Failing tests (57)"
NAMED=$(printf '%s\n' "$MANY" | grep -c "suite > case")
run=$((run + 1))
if [ "$NAMED" -eq 40 ]; then
  passed=$((passed + 1)); echo "✓ names exactly the first 40"
else
  echo "✗ named $NAMED tests, expected 40"
fi

# ── colour codes, which CI leaves in the log ──
COLOURED=$(printf '\033[31m FAIL \033[39m src/b.test.ts > red > case\n\033[31mAssertionError: expected 1 to be 2\033[39m\n' \
  | failing_tests_summary)
assert_has "reads a coloured FAIL line" "$COLOURED" "src/b.test.ts > red > case"
assert_lacks "strips the colour codes" "$COLOURED" "[31m"

# ── the same test named twice (vitest repeats it across reporter sections) ──
DUPED=$(printf ' FAIL  src/c.test.ts > dup > case\nAssertionError: boom\n FAIL  src/c.test.ts > dup > case\n' \
  | failing_tests_summary)
assert_has "counts a repeated test once" "$DUPED" "Failing tests (1)"

echo ""
echo "$passed/$run checks passed."
[ "$passed" -eq "$run" ]
