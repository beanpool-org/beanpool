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
#            `✗ <assertion>` / `✗ FAIL: <assertion>` per check, under a `━━━ <suite> ━━━` header — so each
#            of those lines is tagged with the suite it came from.
# A `✓` pass line matches neither.
#
# THE THREE LEVELS OF ❌, and why the count would otherwise lie. A script-style suite that fails one
# assertion prints THREE ❌-ish lines, not one: the `✗` for the check, its own `❌ Test failed: Error: N
# check(s) failed` catch-all, and run_federation_suites' closing `❌ <group> suites failed: <names>`.
# Counting all three reported one broken assertion as "Failing tests (3)" and scaled with the number of
# failing suites — the opposite of naming precisely what failed (review of PR #1069).
# So only `✗` and `FAIL` are failing TESTS. The two ❌ summaries are kept as FALLBACKS, because each is
# sometimes the only evidence there is:
#   suite-level  `❌ Test failed: <err>` is all a suite prints when it throws before reaching a check,
#                and `❌ Error: …` is the whole output of the secrets_guard check, which has no checks.
#                Named only when its suite produced no `✗` of its own.
#   run-level    `❌ <group> suites failed: <names>` is all that is left of a suite killed by the
#                timeout, which prints neither. Named only when a suite it lists has nothing else.
#
# TWO NAMES FOR ONE SUITE. A suite re-run under a flag is announced by a header carrying a descriptive
# suffix (`━━━ test-keeper-http (read auth opted out) ━━━`) but listed in the closing roll-up under a
# terser tag of its own (`test-keeper-http(readauth-off)`), or under none at all. So the roll-up is
# matched on the BARE suite id (coveredId), while the suite-level fallback stays keyed on the full
# header text (covered) — two variant runs of one suite are separate runs, and each keeps its own
# catch-all when that is all it printed.
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

      # A real failing test. These, and only these, are counted.
      if (t ~ /^FAIL[[:space:]]/) { cover(suite); record(trim(substr(t, 5))); want_err = 1; look = 0; next }
      if (t ~ /^✗/)              { cover(suite); record(tag(t)); want_err = 0; next }

      # A summary. Held back, and printed at the end only if nothing better turned up — see the header.
      if (t ~ /^❌/) {
        if (t ~ /suites failed:/) { rollup[++nr] = t }
        else if (!(suite in candline)) { cand[++nc] = suite; candline[suite] = tag(t) }
        next
      }

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
    # The bare suite id behind either name for it. NO APOSTROPHES IN THIS AWK BLOCK: it is one
    # single-quoted string, and one apostrophe closes it and breaks the file (same trap as
    # run_federation_suites). A descriptive header suffix ` (settlement ON)` and a terser roll-up tag
    # `(on)` / `(TIMEOUT)` are both a trailing parenthetical, so one cut matches the two to each other.
    function suite_id(s) { sub(/[[:space:]]*\(.*\)$/, "", s); return trim(s) }
    # Records that this suite accounted for itself, under both names it may be listed by.
    function cover(s,   id) { covered[s] = 1; id = suite_id(s); if (id != "") coveredId[id] = 1 }
    # Does the run-level roll-up name a suite that nothing else accounted for? That suite left no
    # trace but this line — a timeout kills it mid-check — so the line is worth printing.
    function rollup_adds(t,   names, parts, i, k, name) {
      names = t
      sub(/^.*suites failed:[[:space:]]*/, "", names)
      k = split(names, parts, " ")
      if (k == 0) return 1
      for (i = 1; i <= k; i++) {
        name = suite_id(parts[i])   # test-x(TIMEOUT) and test-x(on) are both test-x
        if (name != "" && !(name in coveredId)) return 1
      }
      return 0
    }
    END {
      # Suites that printed no ✗ of their own: their catch-all line is the only name they have.
      for (i = 1; i <= nc; i++) {
        if (!(cand[i] in covered)) { cover(cand[i]); record(candline[cand[i]]) }
      }
      for (i = 1; i <= nr; i++) if (rollup_adds(rollup[i])) record(rollup[i])

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
