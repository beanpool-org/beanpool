#!/bin/bash
# test-all.sh — BeanPool automated check runner with concurrency capping & scope auto-detection.
#
# `bash scripts/test-all.sh --all` is the gate before anything merges to main (Marty, 2026-09-30): it runs every
# check with no diff-scoping, and a run that passes every check on a clean, committed tree appends a record to
# <git common dir>/test-all-green that scripts/test-all-merge-check.sh reads. scripts/test-all-pr.sh runs it on a PR
# merged with current main.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1
# failing_tests_summary, which names the failing tests in the report below, and the green record. Kept in its own
# file so scripts/test-failing-tests-summary.sh can run the first against captured output without running this script.
# shellcheck source=test-all-lib.sh
. "$SCRIPT_DIR/test-all-lib.sh"

FAST=0
FORCE_ALL=0
ALL_REQUESTED=0   # --all itself; FORCE_ALL is also set when there is no base to diff against
BYPASS=0

for arg in "$@"; do
  if [ "$arg" = "--fast" ] || [ "$arg" = "--quick" ]; then
    FAST=1
  elif [ "$arg" = "--all" ]; then
    FORCE_ALL=1
    ALL_REQUESTED=1
  elif [ "$arg" = "--bypass-review" ]; then
    BYPASS=1
  fi
done

# No check sees a real admin password or Cloudflare credential from this shell (test-all-lib.sh says why).
scrub_test_env

# --all is the merge gate's run, and it records green, so it runs every server suite. SERVER_SUITES_ONLY (a
# run-server-suites.mjs knob for reproducing one suite) would narrow it to those and still record a full green, so --all
# drops it rather than refusing to record: the run then is what its name and its record say. Run without --all to narrow.
if [ $ALL_REQUESTED -eq 1 ] && [ -n "${SERVER_SUITES_ONLY:-}" ]; then
  echo "ℹ️  --all runs every server suite: ignoring SERVER_SUITES_ONLY=$SERVER_SUITES_ONLY (leave out --all to run only those)."
fi
[ $ALL_REQUESTED -eq 1 ] && unset SERVER_SUITES_ONLY

# Stop before anything else if the install is older than a package.json. A missing dependency surfaces as "Cannot
# find module ..." from tsc, vitest and the server suites, which reads like broken code; this names the real problem.
node scripts/check-deps-installed.mjs || exit 1

# The commit under test, and whether the tree is exactly that commit, for the green record at the end.
[ $ALL_REQUESTED -eq 1 ] && green_run_start

# Scope auto-detection via git diff (unless FORCE_ALL=1)
HAS_CORE_CHANGES=1
HAS_ENGINE_CHANGES=1
HAS_SERVER_CHANGES=1
HAS_NATIVE_CHANGES=1

if [ $FORCE_ALL -eq 0 ] && [ $FAST -eq 0 ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    BASE_REF="origin/main"
    if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
      if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
        BASE_REF="HEAD~1"
      else
        FORCE_ALL=1
      fi
    fi
    CHANGED_FILES=$(git diff --name-only "$BASE_REF"... 2>/dev/null; git status --porcelain 2>/dev/null | awk '{print $2}')
    
    if [ -n "$CHANGED_FILES" ]; then
      echo "$CHANGED_FILES" | grep -q "^packages/beanpool-core/" || HAS_CORE_CHANGES=0
      echo "$CHANGED_FILES" | grep -q "^packages/beanpool-engine/" || HAS_ENGINE_CHANGES=0
      # The sign-in checks in packages/beanpool-signin are the server's: its sso and keeper suites cover them. So is a
      # change to the list of server suites or the runner that runs them.
      echo "$CHANGED_FILES" | grep -q -E "^(apps/server|packages/beanpool-signin)/|^scripts/(run-)?server-suites\.mjs$" || HAS_SERVER_CHANGES=0
      echo "$CHANGED_FILES" | grep -q "^apps/native/" || HAS_NATIVE_CHANGES=0
    fi
  fi
fi

if [ $FAST -eq 1 ]; then
  HAS_CORE_CHANGES=0
  HAS_ENGINE_CHANGES=0
  HAS_SERVER_CHANGES=0
  HAS_NATIVE_CHANGES=0
  echo "⚡ FAST MODE: Skipping package-specific sub-checks."
fi

LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT INT TERM
PIDS=()
NAMES=()
SKIPPED_NAMES=()

RUN_START=$(date +%s)

MAX_CONCURRENT_JOBS=4

run_check() {
  local name="$1"
  shift

  while [ $(jobs -rp | wc -l) -ge $MAX_CONCURRENT_JOBS ]; do
    sleep 0.2
  done

  # Each check times ITSELF, in a subshell, and writes "<start offset> <duration>" to $name.dur.
  # The collection loop below reaps in launch order, so timing there would credit a check that
  # finished early with all the time it then sat waiting to be reaped — which is precisely the
  # number you must not get wrong when the question is what is overlapping with what.
  # $name.rc, written last, is how another check waits for this one (the server suites wait for build).
  (
    CHECK_START=$(date +%s)
    "$@" > "$LOGDIR/$name.log" 2>&1
    CHECK_RC=$?
    CHECK_END=$(date +%s)
    echo "$((CHECK_START - RUN_START)) $((CHECK_END - CHECK_START))" > "$LOGDIR/$name.dur"
    echo "$CHECK_RC" > "$LOGDIR/$name.rc"
    exit $CHECK_RC
  ) &
  PIDS+=($!)
  NAMES+=("$name")
}

# "185" -> "3m05s"; "47" -> "47s". Durations only, so no hour case.
fmt_secs() {
  if [ "$1" -ge 60 ]; then
    printf '%dm%02ds' $(($1 / 60)) $(($1 % 60))
  else
    printf '%ds' "$1"
  fi
}

skip_check() {
  local name="$1"
  SKIPPED_NAMES+=("$name")
}

# Turbo fan-out caps, CI only.
#
# A public-repo `ubuntu-latest` runner has FOUR vCPUs. The four turbo checks below all start at
# +0s, each is its own `pnpm turbo run` fanning out across the workspace at turbo's default
# concurrency of 10, and five of the eight `test` tasks are vitest, which sizes its worker pool
# from the machine's cores. That is comfortably thirty-odd processes competing for four cores, and
# it is why five PRs failed in one night on timing-sensitive tests that passed on re-run: the
# manager polling tests, a pwa chat test, the registrar clock-skew check — all inside `test`, all
# running in that window.
#
# Measured on this PR (#1073), the run is 14m41s and its critical path is:
#     build 2m40s (+0s)  ->  federation 12m01s (+2m40s)  ->  end
# (federation is the server_suites check now, run several at a time; it still starts after build.)
# federation waits on build and then IS the rest of the run, so `build` is deliberately NOT
# capped: every second build spends sharing the runner is a second on the whole job.
#
# lint (1m52s), test (3m48s) and typecheck (2m32s) all finish ~11 minutes before the run does.
# That slack is the budget being spent here — they are capped, they get slower, and the job does
# not, while the timing-sensitive suites inside `test` stop being run four-abreast.
#
# Local runs are untouched. A developer machine has the cores, and a cap there would only make
# `pnpm test-all` slower for no one benefit.
# The native vitest suite reads this (apps/native/vitest.config.ts) as its test and hook timeout: the
# 5 s default fails on a busy shared Mac. Passed through turbo by turbo.json. Generous, not tight: a
# real hang still fails, just at 30 s.
export TEST_ALL_TIMEOUT_MS="${TEST_ALL_TIMEOUT_MS:-30000}"

if [ -n "${CI:-}" ]; then
  TURBO_TEST_ARGS="--concurrency=2"   # at most 2 vitest processes at a time
  TURBO_AUX_ARGS="--concurrency=1"    # lint and typecheck have the most slack of all
else
  TURBO_TEST_ARGS=""
  TURBO_AUX_ARGS=""
fi

echo "🚀 Running BeanPool checks (max $MAX_CONCURRENT_JOBS parallel jobs)..."
if [ -n "${CI:-}" ]; then
  echo "   CI: turbo capped — test $TURBO_TEST_ARGS, lint/typecheck $TURBO_AUX_ARGS, build uncapped (critical path)"
fi
echo ""

# Server suites. Every apps/server/src/test-*.ts run listed in scripts/server-suites.mjs. These are script-style checks,
# not vitest, so `turbo run test` does not see them; scripts/run-server-suites.mjs runs them several at a time, each in
# its own process with its own data dir and temp dir and a 300 s limit, longest first, then a short serial tail. The
# invariants they pin (beans never minted unbacked, a peer's reach bounded by its cap, one member never reading
# another's messages) are exactly the kind that must not depend on someone remembering to run them.
#
# Triggered by SERVER, CORE or ENGINE changes. The suites exercise @beanpool/core's ledger and fee behaviour and the
# engine the server imports, so a change there could otherwise break settlement conservation with nothing running them.
#
# They start once `build` has FINISHED, not beside it: `tsx` resolves @beanpool/core to its dist, and `turbo run build`
# rewrites that dist, so running both at once gives non-deterministic module resolution. The check is launched right
# after build and waits for build's .rc, so it starts the moment build is done rather than queueing for a free slot
# behind the checks launched after it. A failed build is reported by its own check; the suites still run.
run_server_suites() {
  while [ ! -f "$LOGDIR/build.rc" ]; do sleep 1; done
  [ "$(cat "$LOGDIR/build.rc")" = "0" ] || echo "⚠️  build failed; these suites ran against whatever dist it left."
  SERVER_SUITES_SUMMARY="$LOGDIR/server_suites.summary" node scripts/run-server-suites.mjs
}

# Core Monorepo Checks. The *_ARGS expansions are deliberately unquoted: empty off-CI, they must
# disappear rather than become an empty argument that turbo would reject. Launch order is start order under the
# slot cap: the long ones (build, then the server suites behind it, test, settings_phone) go first.
run_check "build"         pnpm turbo run build
if [ $HAS_SERVER_CHANGES -eq 1 ] || [ $HAS_CORE_CHANGES -eq 1 ] || [ $HAS_ENGINE_CHANGES -eq 1 ]; then
  run_check "server_suites" run_server_suites
else
  skip_check "server_suites"
fi
run_check "test"          pnpm turbo run test $TURBO_TEST_ARGS

# Node Settings on a phone. Owners open /settings from the app's Manage button, in the phone's own browser, so every
# screen has to work at 320px wide with large text. apps/manager/e2e/phone-width.mjs builds Settings into a temp
# folder, answers the node API from fixtures (no node is contacted), and fails if any screen, the menu, the manual,
# a modal or the app's sign-in hand-off scrolls the page sideways, or a modal cannot be reached with the keyboard up.
# The browser is downloaded once and cached; in CI --with-deps also installs its system libraries (the runner has sudo).
run_check "settings_phone" bash -c 'pnpm --filter @beanpool/manager exec playwright install --only-shell ${CI:+--with-deps} chromium && pnpm --filter @beanpool/manager test:phone-width'

run_check "lint"          pnpm turbo run lint $TURBO_AUX_ARGS

# Typecheck. `build` is what typechecks most of this repo — server, pwa, core and engine all run
# `tsc` as their build — but apps/native has NO build script (an Expo app is built by EAS, not by
# turbo), so nothing in CI has ever typechecked it. Its 'lint' is eslint, which does not read types.
#
# That is the package where an unchecked type error is most expensive: native changes are verified
# on a standalone build, not a dev client, so the feedback loop is a full rebuild rather than a
# reload. This is a separate task from 'build' precisely so it does not imply an artifact.
run_check "typecheck"     pnpm turbo run typecheck $TURBO_AUX_ARGS

# Every apps/server/src/test-*.ts must be listed in scripts/server-suites.mjs. The suites are script-style,
# so `turbo run test` cannot see them and only that list runs them — which is how 21 suites came to exist
# that CI had never once executed. Cheap, and it is the only check here that fails for something NOT being tested.
run_check "suite_registration" bash scripts/check-suite-registration.sh

# deploy.sh wipes each node's project directory on every run and moves data/ and .env aside first.
# When that move nested instead of replacing, the live ledger was buried at data/data/ and the node
# booted on a stale backup's community.key — silently, because both moves were `|| true`. Pure
# shell against a temp dir, so it costs nothing to keep honest.
run_check "deploy_preserve" bash scripts/test-deploy-preserve.sh

# deploy.sh used to hand every server the fleet secrets: a Cloudflare token for the whole beanpool.org zone, the one admin
# password all our servers shared, and the fleet tunnel token in data/tunnel-token (sensitive-data report A8, 2026-09-28).
# This reads deploy.sh, runs it against a stubbed server with sentinel values in its .env, and fails if any of them would
# reach a server. Pure shell against a temp dir; no server is contacted.
run_check "deploy_no_fleet_secrets" bash scripts/test-deploy-no-fleet-secrets.sh

# deploy.sh called a crash-looping node "✅ deployed" and let tagged images fill qld's disk (2026-09-19).
# Its health wait and disk preflight live in scripts/deploy-lib.sh; this runs them against a URL nothing
# answers and stubbed container/disk state. Local only, a few seconds.
run_check "deploy_health" bash scripts/test-deploy-health.sh

# deploy.sh packed the whole folder it ran from minus a deny-list, so .claude/ (board answers, settings) and scratchpad/
# went to every server (scratch/reviews/FABLE-sec-infra.md M2). It now packs only what git tracks. This runs it in a temp
# git checkout with untracked files beside the tracked ones and no node to deploy to, and reads .dockerignore, which keeps
# a node's data/ and .env out of a build node's Docker build. Pure shell; nothing is contacted.
run_check "deploy_package" bash scripts/test-deploy-package.sh

# The report below has to NAME what failed. On PR #1065 it did not: the Failure Details block prints the
# last 150 lines of the failing task, and a Testing Library failure buries the `FAIL <file> > <test>` line
# under its own DOM dump, so a run that failed 1 of 723 tests never said which one and was re-run as a
# flake. This runs scripts/test-all-lib.sh against captured vitest and server-suite output. Pure shell,
# instant, and it is the only check here that tests this script rather than the product.
run_check "fail_summary" bash scripts/test-failing-tests-summary.sh

# The merge gate rests on this script's green record, scripts/test-all-merge-check.sh and scripts/test-all-pr.sh, and
# on check-deps-installed.mjs telling a stale install from broken code. This runs all four against a throwaway
# repository with a stub `gh` (no GitHub, no network). A few seconds.
run_check "merge_gate" bash scripts/test-merge-gate.sh

# Undeclared imports & dependency boundary guard. Ensures every bare module import in each package the
# Dockerfile builds — core, engine, PWA, manager and the server (its src/test-*.ts included, because the
# server's tsc compiles them) — is declared in that package's own package.json. Our .npmrc sets
# node-linker=hoisted, so an undeclared import still resolves here from the root node_modules and this
# suite goes green; the Docker build copies no .npmrc and fails instead. That is #1075: a server test file
# imported multiformats, nothing here noticed, and no image built for main across seven merges.
run_check "undeclared_imports" node scripts/check-undeclared-imports.mjs

# No new raw SQL writes to accounts.balance: beans move through the ledger functions, which pair every debit with its
# credit. The places that write one today are a per-file baseline in the script; a new one fails until a PR raises
# that baseline and says why. Instant.
run_check "balance_writes" node scripts/check-balance-writes.mjs

# A migration file that is on origin/main has run on the live registrar and will never run there again, so an edit
# to it reaches only new databases. New numbered files only. Instant; skipped where there is no origin/main.
run_check "migration_steps" bash scripts/check-migrations-unchanged.sh

# Every GitHub workflow pins its actions to a full commit SHA, says what its token may do, and gates the job that moves
# the image's :latest or makes a Release on the `release` environment (Marty approves each release). The tests check
# the repository's workflows and each edit the check exists to catch. Instant.
run_check "workflows" node --test scripts/check-workflows.test.mjs

# setup-backup.mjs against a stand-in primary on localhost: a password refused for needing two-factor sign-in (step 7c)
# prints the primary's words and the way out. Instant.
run_check "setup_backup" node --test scripts/setup-backup.test.mjs

# Security / Secrets Guard
run_check "secrets_guard" bash -c '
  # Check 1: Stripe / payment tokens
  if grep -rE "sk_test_|sk_live_|pk_live_" apps/ packages/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.build --exclude-dir=.expo 2>/dev/null; then
    echo "❌ Error: Hardcoded secret keys found in codebase" && exit 1
  fi

  # Check 2: Tracked secret or environment files
  TRACKED_SECRETS=$(git ls-files | grep -iE "(^|/)\.env(\..+)?$|community\.key$|tunnel-token$|pc-api-key\.json$|\.p8$|\.pem$|\.keystore$" | grep -v "\.env\.example$" || true)
  if [ -n "$TRACKED_SECRETS" ]; then
    echo "❌ Error: Tracked secret file(s) found in git: $TRACKED_SECRETS" && exit 1
  fi

  # Check 3: Inventoried secret keys assigned hardcoded values in tracked files
  INVENTORIED_KEYS="ADMIN_PASSWORD|BACKUP_ADMIN_PASSWORD|ADMIN_SECRET|CF_API_TOKEN|CF_TUNNEL_TOKEN|CLOUDFLARE_API_KEY|CLOUDFLARE_API_TOKEN|TIKTOK_CLIENT_SECRET|INSTAGRAM_APP_SECRET|INSTAGRAM_CLIENT_SECRET|BACKUP_REPLICATION_TOKEN"
  LEAKS=$(git grep -nE "^[[:space:]]*(-[[:space:]]+)?(export[[:space:]]+)?($INVENTORIED_KEYS)=" 2>/dev/null | grep -vE "=['\''\"]?\\$\\{[A-Za-z0-9_]+(:-)?\\}['\''\"]?$" | grep -vE "(\.env\.example|apps/server/README\.md|deploy\.sh|docs/|apps/registrar/\.dev\.vars|scripts/bootstrap-community-eggs\.mjs|scripts/grant-operator\.mjs)" || true)
  if [ -n "$LEAKS" ]; then
    echo "❌ Error: Hardcoded assignment to inventoried secret key found in tracked file:" && echo "$LEAKS" && exit 1
  fi

  # Check 4: Container log caps on every compose file
  node scripts/check-compose-log-caps.mjs || exit 1
'

# Wait for parallel checks and collect results
PASS=0
FAIL=0
FAILED_NAMES=()

for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}"
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("${NAMES[$i]}")
  fi
done

# ── Report ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          BEANPOOL TEST-ALL REPORT        ║"
echo "╠══════════════════════════════════════════╣"

for i in "${!NAMES[@]}"; do
  NAME="${NAMES[$i]}"
  STATUS="✅ PASS"
  for fn in "${FAILED_NAMES[@]}"; do
    if [ "$fn" = "$NAME" ]; then
      STATUS="❌ FAIL"
      break
    fi
  done
  # Wall clock, and the offset from the start of the run at which this check began. The pair is
  # what makes the load legible: which checks were actually running at the same time, and which
  # one is the long pole everything else is hiding behind. A check killed before it could write
  # its own .dur simply prints no timing rather than a wrong one.
  TIMING=""
  if [ -f "$LOGDIR/$NAME.dur" ]; then
    read -r CHECK_AT CHECK_FOR < "$LOGDIR/$NAME.dur"
    TIMING="$(fmt_secs "$CHECK_FOR")  (started +$(fmt_secs "$CHECK_AT"))"
  fi
  printf "║  %-16s %s  %s\n" "$NAME" "$STATUS" "$TIMING"
done

for sn in "${SKIPPED_NAMES[@]}"; do
  printf "║  %-16s ⚪ SKIPPED\n" "$sn"
done

WALL=$(($(date +%s) - RUN_START))
echo "╠══════════════════════════════════════════╣"
printf "║  Total: %d passed, %d failed, %d skipped\n" "$PASS" "$FAIL" "${#SKIPPED_NAMES[@]}"
printf "║  Wall clock: %s (max %d parallel jobs)\n" "$(fmt_secs $WALL)" "$MAX_CONCURRENT_JOBS"
echo "╚══════════════════════════════════════════╝"

# The server suites' own timing: their wall clock, the pool and the slowest runs (scripts/run-server-suites.mjs).
if [ -f "$LOGDIR/server_suites.summary" ]; then
  echo ""
  cat "$LOGDIR/server_suites.summary"
fi

# Failure details. A plain tail of each log is not enough for the turbo checks: `turbo run test`
# writes every package into one log, so when one package fails and others finish after it, its
# error scrolls out of the tail — a failing PWA test once had to be diagnosed by re-running it.
# So for a turbo check, print the failing TASK'S own output, found by the `Failed:` summary line.
#
# Turbo writes two layouts and both must be read. Locally every line is prefixed `pkg:task: `.
# Under GitHub Actions it groups instead: each task is one unprefixed block, a passing one wrapped
# in ::group::pkg:task … ::endgroup::, a failing one under a bare (coloured) `pkg:task` line.
# Anything not recognised falls back to the old tail, so this can never show less than before.
FAILED_TASK_LINES=150

turbo_failed_tasks() {
  # "Failed:    @beanpool/pwa#test, @beanpool/core#test"  ->  one pkg#task per line
  sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g" "$1" | sed -n 's/^Failed:[[:space:]]*//p' | tr ', ' '\n\n' | grep '#'
}

turbo_task_output() {
  local log="$1" want="$2" headers="$3"
  awk -v esc="$(printf '\033')" -v want="$want" -v headers="$headers" '
    BEGIN { n = split(headers, h, " "); for (i = 1; i <= n; i++) failed[h[i]] = 1 }
    { line = $0; gsub(esc "\\[[0-9;]*[A-Za-z]", "", line) }
    index(line, want ": ") == 1 { print substr(line, length(want) + 3); next }
    line == want || line == "::group::" want { inside = 1; next }
    inside && (line ~ /^::(end)?group::/ || line ~ /^ Tasks: / || (line in failed)) { inside = 0 }
    inside && line !~ /^::/ { print line }
  ' "$log"
}

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "──── Failure Details ────"
  for fn in "${FAILED_NAMES[@]}"; do
    echo ""
    echo "━━━ $fn ━━━"
    # The server suites print one section per failing run after this marker (its log, or its ✗ lines and last 200
    # lines), ending with the roll-up. A plain tail would show only the last run and the per-run time table.
    if [ "$fn" = "server_suites" ] && grep -q '^──── Failing server suites' "$LOGDIR/$fn.log"; then
      failing_tests_summary < "$LOGDIR/$fn.log"
      sed -n '/^──── Failing server suites/,$p' "$LOGDIR/$fn.log" | tail -n 400
      continue
    fi
    shown=0
    unread=0
    tasks=$(turbo_failed_tasks "$LOGDIR/$fn.log")
    if [ -n "$tasks" ]; then
      headers=$(echo $tasks | tr '#' ':')   # space-separated: BSD awk refuses a newline in -v
      for task in $tasks; do
        out=$(turbo_task_output "$LOGDIR/$fn.log" "$(echo "$task" | tr '#' ':')" "$headers")
        if [ -z "$out" ]; then unread=1; continue; fi
        total=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
        if [ "$total" -gt $FAILED_TASK_LINES ]; then
          echo "── $task (last $FAILED_TASK_LINES of its $total lines) ──"
        else
          echo "── $task ──"
        fi
        # The names FIRST, from the task's FULL output, because the tail below may not contain them:
        # a failure whose error carries a long dump pushes its own `FAIL <file> > <test>` line out.
        printf '%s\n' "$out" | failing_tests_summary
        printf '%s\n' "$out" | tail -n $FAILED_TASK_LINES
        shown=1
      done
    fi
    # Same for a check turbo did not run: its whole log is the one to read the names out of.
    if [ $shown -eq 0 ] || [ $unread -eq 1 ]; then
      failing_tests_summary < "$LOGDIR/$fn.log"
      tail -40 "$LOGDIR/$fn.log"
    fi
  done
  echo ""

  # Keep every log of a failing run. CI sets TEST_ALL_LOG_DIR and uploads that directory as a
  # workflow artifact; run locally, the temp dir is simply left in place. Passing runs keep nothing.
  if [ -n "${TEST_ALL_LOG_DIR:-}" ] && mkdir -p "$TEST_ALL_LOG_DIR" && cp "$LOGDIR"/*.log "$TEST_ALL_LOG_DIR"/; then
    echo "Full logs of every check copied to $TEST_ALL_LOG_DIR"
  else
    trap - EXIT INT TERM
    echo "Full logs of every check kept in $LOGDIR"
    LOGDIR=""
  fi
fi

# Cleanup
[ -n "$LOGDIR" ] && rm -rf "$LOGDIR"

# The merge gate's record (scripts/test-all-lib.sh): only an --all run, not --fast, in which every check ran and passed.
if [ $FAIL -eq 0 ] && [ $ALL_REQUESTED -eq 1 ] && [ $FAST -eq 0 ] && [ ${#SKIPPED_NAMES[@]} -eq 0 ]; then
  echo ""
  record_green_run "$WALL"
fi

# Exit with failure if anything failed
[ $FAIL -eq 0 ]
