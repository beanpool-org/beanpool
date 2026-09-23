#!/bin/bash
# Helpers for scripts/test-all.sh. Sourced, never run directly.
#
# WHY THIS EXISTS. 2026-09-23, PR #1065: CI run 35862281845 failed one of 723 PWA tests. The Failure
# Details block prints only the LAST 150 lines of the failing task, and a Testing Library failure puts
# a several-hundred-line jsdom DOM dump between the `FAIL <file> > <test>` line and the end of the
# output — so the failing test's NAME appeared nowhere in the log. The suite passed locally and on main,
# so it was re-run as a flake with no way to know which test had failed. The same shape would hide the
# next real failure too.
#
# failing_tests_summary reads a failing task's FULL output and lists what actually failed, so the name
# survives however long the dump that follows it is. It only ADDS a block to the report: it never runs a
# test, never inspects a status and never feeds an exit code, so test-all.sh reaches byte-for-byte the
# same verdict with it as without it.
#
# bash 3.2 / BSD awk compatible, like the rest of test-all.sh.

# How many failing tests to name before collapsing the rest into "… and N more". A broken shared helper
# can fail hundreds of tests at once; the first 40 names are enough to see the shape of it.
FAILING_TESTS_CAP=${FAILING_TESTS_CAP:-40}
# Longest line printed. A Testing Library message can carry an entire serialised DOM on ONE line, which
# would bury the list it is meant to annotate.
FAILING_TESTS_WIDTH=${FAILING_TESTS_WIDTH:-300}
# How far past a FAIL line to keep looking for its error. Vitest prints the error on the very next line;
# this only stops an entry with no error of its own from adopting one from far below.
FAILING_TESTS_LOOKAHEAD=${FAILING_TESTS_LOOKAHEAD:-20}

# Reads a task log on stdin, writes a "Failing tests" block on stdout. Prints NOTHING when it recognises
# no failure, so an unfamiliar log looks exactly as it did before.
#
# Two formats are read, because this repo runs tests two ways:
#   vitest   ` FAIL  src/x.test.tsx > Suite > test name`, then its first error line (AssertionError,
#            TestingLibraryElementError, Error:, expected …).
#   apps/server/src/test-*.ts  script-style suites that `turbo run test` cannot see. They print their own
#            `✗ <assertion>` / `✗ FAIL: <assertion>` per check and `❌ Test failed: …` at the end, under a
#            `━━━ <suite> ━━━` header — so each of those lines is tagged with the suite it came from.
# A `✓` pass line matches neither.
failing_tests_summary() {
  awk -v esc="$(printf '\033')" \
      -v cap="$FAILING_TESTS_CAP" \
      -v width="$FAILING_TESTS_WIDTH" \
      -v lookahead="$FAILING_TESTS_LOOKAHEAD" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    function clip(s) { return length(s) > width ? substr(s, 1, width) " …" : s }
    # Records one failure. Duplicates are dropped: vitest names a test once per reporter section, and a
    # suite re-run under a second env prints its assertions again.
    function record(label) {
      pending = 0
      if (label == "" || (label in seen)) return
      seen[label] = 1
      n++
      if (n <= cap) { entry[n] = label; pending = n }
    }
    {
      line = $0
      gsub(esc "\\[[0-9;]*[A-Za-z]", "", line)   # colour codes first, or every pattern below misses
      gsub(/\r/, "", line)
      t = trim(line)

      # Which script-style suite the following lines belong to.
      if (t ~ /^━━━ /) {
        s = t
        sub(/^━━━[[:space:]]*/, "", s)
        sub(/[[:space:]]*━━━$/, "", s)
        suite = s
        next
      }

      if (t ~ /^FAIL[[:space:]]/) { record(trim(substr(t, 5))); want_err = 1; look = 0; next }
      if (t ~ /^❌/)              { record(tag(t)); want_err = 1; look = 0; next }
      if (t ~ /^✗/)              { record(tag(t)); want_err = 0; next }

      # The first error line under a failure it belongs to.
      if (pending && want_err) {
        if (++look > lookahead) { pending = 0; next }
        if (t ~ /AssertionError|TestingLibraryElementError|Error:|^expected |[[:space:]]expected /) {
          err[pending] = t
          pending = 0
        }
      }
    }
    # Which suite a script-style line came from. Skipped when the line already names it, so the
    # closing roll-up ("❌ Federation suites failed: test-x") does not repeat itself.
    function tag(t) { return (suite == "" || index(t, suite) > 0) ? t : suite ": " t }
    END {
      if (n == 0) exit 0
      printf "── Failing tests (%d) ──\n", n
      for (i = 1; i <= n && i <= cap; i++) {
        print "  " clip(entry[i])
        if (err[i] != "") print "      " clip(err[i])
      }
      if (n > cap) printf "  … and %d more\n", n - cap
    }
  '
}
