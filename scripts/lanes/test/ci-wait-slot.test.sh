#!/bin/zsh
# ci-wait-slot.test.sh — ci-wait.sh's exit codes against the fake gh (test/fake/gh, `pr checks` and `pr view`), and tsc-slot.sh's
# slot limit, takeover, wait limit and exit code. Touches no real GitHub and no real slot: everything sits in a temp dir.
#
#   zsh scripts/lanes/test/ci-wait-slot.test.sh        (about 15 seconds; LANE_SELFTEST_KEEP=1 keeps the temp dir)
HERE=${0:A:h}; LANES=${HERE:h}
T=$(mktemp -d "${TMPDIR:-/tmp}/lanes-ci-wait-slot.XXXXXX") || exit 1
T=${T:A}
unset -m 'LANE_*' 'BP_SLOT*' CI_WAIT_PR_STATE   # a run from inside a lane inherits its settings; the defaults are what is under test
export PATH="$HERE/fake:$PATH" FAKE_STATE=$T/fake LANE_GH_REPO=example/fake

PASS=0; FAILS=0
check(){ # DESCRIPTION COMMAND...
  local d=$1; shift
  if "$@"; then print -r -- "    ✓ $d"; PASS=$((PASS+1)); else print -r -- "    ✗ $d"; FAILS=$((FAILS+1)); fi; }
case_(){ # TITLE — resets the fake's state; every gh call so far is kept in $T/all-calls
  print; print -r -- "━━ $1"; cat "$FAKE_STATE/gh.calls" >> "$T/all-calls" 2>/dev/null; rm -rf "$FAKE_STATE"; mkdir -p "$FAKE_STATE"; }
out_has(){ grep -qF -- "$1" "$T/out"; }
calls(){ local c; c=$(grep -c -- "$1" "$FAKE_STATE/gh.calls" 2>/dev/null); print ${c:-0}; }

# A red's lines come from pr-state.mjs; this stand-in records its arguments and prints noise around the block ci-wait.sh keeps.
print -r -- 'const fs = require("fs");
fs.writeFileSync(process.env.FAKE_STATE + "/reader.args", process.argv.slice(2).join(" "));
console.log("head        before the block: must not be shown");
console.log("checks      2 on this head: 1 success, 1 red, 0 pending");
console.log("  RED   Test-All shard server-3: test-thing.ts:12 AssertionError");
console.log("SUMMARY: CLEAN+RED (1 reds)");
console.log("after the block: must not be shown");' > "$T/reader.cjs"
wait_ci(){ # ci-wait.sh ARGS... → $T/out, $RC
  CI_WAIT_PR_STATE=$T/reader.cjs LANE_CI_WAIT_POLL_SECS=0 "$LANES/ci-wait.sh" "$@" > "$T/out" 2>&1; RC=$?
  sed 's/^/    │ /' "$T/out"; }

# ── ci-wait.sh ──────────────────────────────────────────────────────────────────────────────────────────────────
case_ "1. no PR named → usage, exit 3"
wait_ci
check "exit 3"                                    [ "$RC" = 3 ]
check "says how to call it"                       out_has "usage: ci-wait.sh <PR>"

case_ "2. GitHub gives no head → unreadable, exit 3, no checks read"
: > "$FAKE_STATE/head"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 3"                                    [ "$RC" = 3 ]
check "says the PR is unreadable"                 out_has "PR unreadable"
check "never read the checks"                     [ "$(calls 'pr checks')" = 0 ]

case_ "3. every check passed or skipped → GREEN, exit 0, on the head it read"
print aaa11111bbb > "$FAKE_STATE/head"; print "pass pass skipping" > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 0"                                    [ "$RC" = 0 ]
check "names the head and the counts"             out_has "GREEN on aaa11111 (pass=2 skipping=1)"
check "asked the named repo about the named PR"   grep -qxF "gh pr checks 42 -R example/fake --json bucket --jq [.[].bucket]|group_by(.)|map(\"\(.[0])=\(length)\")|join(\" \")" "$FAKE_STATE/gh.calls"

case_ "4. pending, then green within one call → it keeps reading (gh's exit 8 while pending is not an answer), exit 0"
print -l "pending pass" "pending pending" "pass pass" > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 0"                                    [ "$RC" = 0 ]
check "three reads of the checks"                 [ "$(calls 'pr checks')" = 3 ]
check "GREEN"                                     out_has "GREEN on fakehead (pass=2)"

case_ "5. still pending when the call's time is up → PENDING, exit 2, call again"
print pending > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=0 wait_ci 42
check "exit 2"                                    [ "$RC" = 2 ]
check "says to call it again, with the counts"    out_has "PENDING on fakehead (pending=1): call ci-wait.sh 42 again"
case_ "5b. ... and it does wait out the call first (2 s at a 0.2 s poll)"
print pending > "$FAKE_STATE/checks"
s0=$(date +%s)
CI_WAIT_PR_STATE=$T/reader.cjs LANE_CI_WAIT_POLL_SECS=0.2 LANE_CI_WAIT_SECS=2 "$LANES/ci-wait.sh" 42 > "$T/out" 2>&1; RC=$?
check "exit 2 after at least 2 s and more than one read" eval '[ "$RC" = 2 ] && [ $(( $(date +%s) - s0 )) -ge 2 ] && [ "$(calls "pr checks")" -gt 1 ]'

case_ "6. no checks yet (gh says so on stderr) → a wait, never green"
print none > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=0 wait_ci 42
check "exit 2, not 0"                             [ "$RC" = 2 ]
check "PENDING with nothing counted"              out_has "PENDING on fakehead (): call ci-wait.sh 42 again"
check "gh's stderr is not shown"                  eval '! out_has "no checks reported"'

case_ "7. a red while others still run → waits for them; then RED, exit 1, with only the reader's failing block"
print -l "fail pending pass" "fail pass pass" > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 1"                                    [ "$RC" = 1 ]
check "read twice: a pending check is waited for even beside a red" [ "$(calls 'pr checks')" = 2 ]
check "names the head and the counts"             out_has "RED on fakehead (fail=1 pass=2)"
check "prints the failing lines, from checks to SUMMARY" eval 'out_has "test-thing.ts:12 AssertionError" && out_has "SUMMARY: CLEAN+RED (1 reds)"'
check "and nothing outside that block"            eval '! out_has "must not be shown"'
check "the reader got the PR and the repo"        [ "$(cat "$FAKE_STATE/reader.args")" = "42 -R example/fake" ]

case_ "8. a cancelled check → RED, exit 1"
print "cancel pass" > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 1"                                    [ "$RC" = 1 ]
check "RED with the cancel counted"               out_has "RED on fakehead (cancel=1 pass=1)"

case_ "9. a push while it waits → HEAD MOVED, exit 3: the verdict in hand is about the old head"
print aaa11111 > "$FAKE_STATE/head"; print bbb22222 > "$FAKE_STATE/pushes"; print -l "pending+push" "pass" > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 3"                                    [ "$RC" = 3 ]
check "names the new head"                        out_has "HEAD MOVED to bbb22222"
check "never read the new head's checks as the old head's verdict" eval '! out_has "GREEN"'

case_ "10. the head becomes unreadable mid-wait → exit 3 that says so, not 'HEAD MOVED to '"
print aaa11111 > "$FAKE_STATE/head"; print "" > "$FAKE_STATE/pushes"; print "pending+push" > "$FAKE_STATE/checks"
LANE_CI_WAIT_SECS=30 wait_ci 42
check "exit 3"                                    [ "$RC" = 3 ]
check "says GitHub gave no head"                  out_has "PR unreadable (GitHub gave no head): call ci-wait.sh 42 again"

case_ "11. read-only: every gh call ci-wait.sh made in this file was a pr view or pr checks"
check "calls were recorded, and none was another gh command" eval '[ -s "$T/all-calls" ] && ! grep -vqE "^gh pr (view|checks) " "$T/all-calls"'

# ── tsc-slot.sh ─────────────────────────────────────────────────────────────────────────────────────────────────
export BP_SLOT_BASE=$T/slot BP_SLOT_POLL_SECS=0.2
print -l '#!/bin/bash' 'mkdir -p "$1/running"; touch "$1/running/$$"' 'ls "$1/running" | wc -l | tr -d " " >> "$1/seen"' \
  'sleep 1; rm -f "$1/running/$$"' > "$T/probe.sh"; chmod +x "$T/probe.sh"

case_ "12. five heavy runs, two slots → never more than two at once, all five run, every slot freed"
typeset -a pids; pids=()
for i in 1 2 3 4 5; do BP_SLOTS=2 "$LANES/tsc-slot.sh" "$T/probe.sh" "$T" & pids+=($!); done
for j in $pids; do wait "$j"; done
max=$(sort -n "$T/seen" | tail -1)
print -r -- "    │ seen at once: $(tr '\n' ' ' < "$T/seen")"
check "all five ran"                              [ "$(wc -l < "$T/seen" | tr -d ' ')" = 5 ]
check "at most two at once"                       [ "$max" -le 2 ]
check "two did run together (the limit is two, not one)" [ "$max" = 2 ]
check "no slot left behind"                       eval '[ -z "$(print -l -- $T/slot-*(N))" ]'

case_ "13. the command's exit code and arguments come through, and the slot is freed after a failure"
BP_SLOTS=1 "$LANES/tsc-slot.sh" sh -c 'exit 7'; rc=$?
check "exit 7 passed through"                     [ "$rc" = 7 ]
check "slot freed after it"                       [ ! -e "$T/slot-1" ]
check "arguments with spaces arrive whole"        [ "$(BP_SLOTS=1 "$LANES/tsc-slot.sh" printf '%s|' 'a b' c)" = "a b|c|" ]

case_ "14. a slot whose owner died is taken over at once"
mkdir -p "$T/slot-1"; print 99999999 > "$T/slot-1/pid"
s0=$(date +%s)
BP_SLOTS=1 BP_SLOT_WAIT_SECS=60 "$LANES/tsc-slot.sh" true 2> "$T/err"; rc=$?
check "ran, exit 0, within 3 s"                   eval '[ "$rc" = 0 ] && [ $(( $(date +%s) - s0 )) -le 3 ]'
check "did not wait out the limit"                eval '! grep -q "running anyway" "$T/err"'
check "and freed the slot after"                  [ ! -e "$T/slot-1" ]

case_ "15. a live owner's slot is respected until the wait limit, then it runs anyway and leaves that slot alone"
mkdir -p "$T/slot-1"; print $$ > "$T/slot-1/pid"
s0=$(date +%s)
out=$(BP_SLOTS=1 BP_SLOT_WAIT_SECS=1 "$LANES/tsc-slot.sh" echo ran 2> "$T/err"); rc=$?
check "waited at least the limit, then ran"       eval '[ "$out:$rc" = ran:0 ] && [ $(( $(date +%s) - s0 )) -ge 1 ]'
check "said it was running anyway"                grep -q "tsc-slot: waited 0 min, running anyway" "$T/err"
check "the live owner's slot is untouched"        [ "$(cat "$T/slot-1/pid")" = $$ ]

case_ "16. TERM during the wait stops it (exit 143) and the command never runs"
BP_SLOTS=1 BP_SLOT_WAIT_SECS=60 "$LANES/tsc-slot.sh" touch "$T/ran-after-term" & p=$!
sleep 1; kill -TERM "$p"; wait "$p"; rc=$?
check "exit 143"                                  [ "$rc" = 143 ]
check "the command did not run"                   [ ! -e "$T/ran-after-term" ]
check "the live owner's slot is still untouched"  [ "$(cat "$T/slot-1/pid")" = $$ ]
rm -rf "$T/slot-1"

case_ "17. a machine with no ~/.cache yet: the slot's parent is made, no 45-minute wait"
s0=$(date +%s)
BP_SLOT_BASE=$T/fresh/cache/bp-tsc-slot BP_SLOTS=1 BP_SLOT_WAIT_SECS=60 "$LANES/tsc-slot.sh" true 2> "$T/err"; rc=$?
check "ran at once"                               eval '[ "$rc" = 0 ] && [ $(( $(date +%s) - s0 )) -le 3 ] && ! grep -q "running anyway" "$T/err"'

print
print "ci-wait-slot: $PASS passed, $FAILS failed"
[ "$LANE_SELFTEST_KEEP" = 1 ] && print "kept $T" || rm -rf "$T"
(( FAILS == 0 ))
