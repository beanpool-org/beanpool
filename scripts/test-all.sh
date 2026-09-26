#!/bin/bash
# test-all.sh — BeanPool automated check runner with concurrency capping & scope auto-detection.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# failing_tests_summary, which names the failing tests in the report below. Kept in its own file so
# scripts/test-failing-tests-summary.sh can run it against captured output without running this script.
# shellcheck source=test-all-lib.sh
. "$SCRIPT_DIR/test-all-lib.sh"

FAST=0
FORCE_ALL=0
BYPASS=0

for arg in "$@"; do
  if [ "$arg" = "--fast" ] || [ "$arg" = "--quick" ]; then
    FAST=1
  elif [ "$arg" = "--all" ]; then
    FORCE_ALL=1
  elif [ "$arg" = "--bypass-review" ]; then
    BYPASS=1
  fi
done

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
      echo "$CHANGED_FILES" | grep -q "^apps/server/" || HAS_SERVER_CHANGES=0
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
  (
    CHECK_START=$(date +%s)
    "$@" > "$LOGDIR/$name.log" 2>&1
    CHECK_RC=$?
    CHECK_END=$(date +%s)
    echo "$((CHECK_START - RUN_START)) $((CHECK_END - CHECK_START))" > "$LOGDIR/$name.dur"
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
# federation waits on build and then IS the rest of the run, so `build` is deliberately NOT
# capped: every second build spends sharing the runner is a second on the whole job.
#
# lint (1m52s), test (3m48s) and typecheck (2m32s) all finish ~11 minutes before the run does.
# That slack is the budget being spent here — they are capped, they get slower, and the job does
# not, while the timing-sensitive suites inside `test` stop being run four-abreast.
#
# Local runs are untouched. A developer machine has the cores, and a cap there would only make
# `pnpm test-all` slower for no one benefit.
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

# Core Monorepo Checks. The *_ARGS expansions are deliberately unquoted: empty off-CI, they must
# disappear rather than become an empty argument that turbo would reject.
run_check "build"         pnpm turbo run build
run_check "lint"          pnpm turbo run lint $TURBO_AUX_ARGS
run_check "test"          pnpm turbo run test $TURBO_TEST_ARGS

# Typecheck. `build` is what typechecks most of this repo — server, pwa, core and engine all run
# `tsc` as their build — but apps/native has NO build script (an Expo app is built by EAS, not by
# turbo), so nothing in CI has ever typechecked it. Its 'lint' is eslint, which does not read types.
#
# That is the package where an unchecked type error is most expensive: native changes are verified
# on a standalone build, not a dev client, so the feedback loop is a full rebuild rather than a
# reload. This is a separate task from 'build' precisely so it does not imply an artifact.
run_check "typecheck"     pnpm turbo run typecheck $TURBO_AUX_ARGS

# Every apps/server/src/test-*.ts must be reachable from a run below. The suites are script-style,
# so `turbo run test` cannot see them and only the hand-maintained lists in this file run them —
# which is how 21 suites came to exist that CI had never once executed. Cheap, and it is the only
# check here that fails for something NOT being tested.
run_check "suite_registration" bash scripts/check-suite-registration.sh

# deploy.sh wipes each node's project directory on every run and moves data/ and .env aside first.
# When that move nested instead of replacing, the live ledger was buried at data/data/ and the node
# booted on a stale backup's community.key — silently, because both moves were `|| true`. Pure
# shell against a temp dir, so it costs nothing to keep honest.
run_check "deploy_preserve" bash scripts/test-deploy-preserve.sh

# deploy.sh called a crash-looping node "✅ deployed" and let tagged images fill qld's disk (2026-09-19).
# Its health wait and disk preflight live in scripts/deploy-lib.sh; this runs them against a URL nothing
# answers and stubbed container/disk state. Local only, a few seconds.
run_check "deploy_health" bash scripts/test-deploy-health.sh

# The report below has to NAME what failed. On PR #1065 it did not: the Failure Details block prints the
# last 150 lines of the failing task, and a Testing Library failure buries the `FAIL <file> > <test>` line
# under its own DOM dump, so a run that failed 1 of 723 tests never said which one and was re-run as a
# flake. This runs scripts/test-all-lib.sh against captured vitest and server-suite output. Pure shell,
# instant, and it is the only check here that tests this script rather than the product.
run_check "fail_summary" bash scripts/test-failing-tests-summary.sh

# Undeclared imports & dependency boundary guard. Ensures every bare module import in each package the
# Dockerfile builds — core, engine, PWA, manager and the server (its src/test-*.ts included, because the
# server's tsc compiles them) — is declared in that package's own package.json. Our .npmrc sets
# node-linker=hoisted, so an undeclared import still resolves here from the root node_modules and this
# suite goes green; the Docker build copies no .npmrc and fails instead. That is #1075: a server test file
# imported multiformats, nothing here noticed, and no image built for main across seven merges.
run_check "undeclared_imports" node scripts/check-undeclared-imports.mjs

# Node Settings on a phone. Owners open /settings from the app's Manage button, in the phone's own browser, so every
# screen has to work at 320px wide with large text. apps/manager/e2e/phone-width.mjs builds Settings into a temp
# folder, answers the node API from fixtures (no node is contacted), and fails if any screen, the menu, the manual,
# a modal or the app's sign-in hand-off scrolls the page sideways, or a modal cannot be reached with the keyboard up.
# The browser is downloaded once and cached; in CI --with-deps also installs its system libraries (the runner has sudo).
run_check "settings_phone" bash -c 'pnpm --filter @beanpool/manager exec playwright install --only-shell ${CI:+--with-deps} chromium && pnpm --filter @beanpool/manager test:phone-width'

# Federation settlement suites (#104). These are script-style checks under apps/server/src, not vitest,
# so `turbo run test` does not see them — they were only ever run by hand. Wired in here because the
# invariants they pin (beans never minted unbacked, a peer's reach bounded by its cap) are exactly the
# kind that must not depend on someone remembering.
#
# Each needs its OWN data dir: they share the module-level sqlite singleton, so a reused dir would let one
# suite's rows leak into the next. ENABLE_PEER_CONNECTORS=true because connector reads short-circuit
# without it, which would make the checks pass vacuously rather than fail.
#
# Triggered by SERVER **or** CORE changes. The suites exercise @beanpool/core's ledger and fee behaviour,
# so a core-only change could otherwise break settlement conservation with nothing running these (review
# finding) — and `turbo run test` still does not see them.
#
# Runs AFTER build rather than alongside it. `tsx` resolves @beanpool/core to its dist, and `turbo run build`
# rewrites that dist — running both concurrently gives non-deterministic module resolution. This is the same
# stale/half-written core-dist hazard that has bitten us before, in CI form.
if [ $HAS_SERVER_CHANGES -eq 1 ] || [ $HAS_CORE_CHANGES -eq 1 ]; then
  FEDERATION_QUEUED=1
else
  FEDERATION_QUEUED=0
  skip_check "federation"
fi

# Per-suite wall clock. A suite that never exits — one that leaves the engine's timers open and
# returns normally instead of calling process.exit — otherwise blocks every suite queued behind it,
# and the whole job with them. Runs on this repo have been cancelled at 14, 17, 22 and 360 minutes
# for exactly that reason, and a hang is indistinguishable from a slow day until someone gives up.
#
# The timeout does not fix a hang; it converts one into a named failure with the suite's name
# attached, which is the difference between "CI is flaky" and "test-x hangs". 300s is roughly 100x
# the whole suite's healthy runtime, so it cannot fire on a merely slow machine.
#
# `timeout` is GNU coreutils; macOS has it as `gtimeout` via brew, or not at all. Absent, suites run
# unguarded exactly as before — a local convenience should never change what CI verifies.
if command -v timeout >/dev/null 2>&1; then
  SUITE_TIMEOUT="timeout --kill-after=10s 300s"
elif command -v gtimeout >/dev/null 2>&1; then
  SUITE_TIMEOUT="gtimeout --kill-after=10s 300s"
else
  SUITE_TIMEOUT=""
  echo "⚠️  no timeout(1) — suites run unguarded; a hanging suite will block this run"
fi
export SUITE_TIMEOUT

run_federation_suites() {
  bash -c '
    cd apps/server
    # NO `set -e`, and every suite runs even after one fails (review finding). Aborting on the first failure
    # left the remaining suites unexecuted, so a single break masked every other one and each fix-and-rerun
    # cycle only revealed the next problem. Statuses are collected and all failures reported together.
    FAILED=""
    # ONE SUITE PER LINE. Add a new suite as its own line beside a related one rather than at the
    # bottom: two PRs that each append after the same last line conflict, while insertions at
    # different points merge cleanly. Order does not matter, since every suite gets a fresh data dir.
    # scripts/check-suite-registration.sh reads this array, so keep one name per line.
    SUITES=(
      test-schema-upgrade
      test-creator-channels
      test-pulse-resolver
      test-ssrf-fetch-timeout
      test-pulse-submit
      test-pulse-oauth
      test-oauth-ingest-bounds
      test-pulse-curated
      test-pulse-admin-channels
      test-pulse-report-takedown
      test-pulse-thumbnail
      test-pulse-thumbnail-recovery
      test-pulse-cache-eviction
      test-callsign-predicates
      test-message-tombstone
      test-recovery-shares
      test-sso
      test-sso-unavailable
      test-github-device
      test-github-poll-limit
      test-daily-pulse
      test-pairing-relay
      test-pairing-routes
      test-pricing-guide
      test-pricing-aggregator-lifecycle
      test-activity-feed
      test-member-purge
      test-keeper-deposit
      test-keeper-routes
      test-keeper-release
      test-recovery-collect
      test-sso-recovery-roundtrip
      test-recovery-seal
      test-keeper-http
      test-open-join
      test-web-door
      test-global-moderation
      test-community-me
      test-distance-search
      test-guest-view
      test-distance-search-perf
      test-global-directory
      test-knock
      test-commons-conservation
      test-ledger-rollback
      test-treasury-keepership
      test-treasury-eggs
      test-enterprise-credit-rules
      test-derived-enterprise-floor
      test-demurrage-window
      test-crowdfund-delete-refund
      test-admin-password-query
      test-cors-policy
      test-gateway-config
      test-gateway-real-client
      test-limiter-ipv6-and-password-brake
      test-password-brake-no-lockout
      test-password-brake-fairness
      test-csrf-protection
      test-totp-admin-2fa
      test-2fa-covers-admin-routes
      test-2fa-reenrol-needs-code
      test-totp-helpers
      test-moderation-admin
      test-report-dedup-and-sync
      test-ledger-export
      test-ledger-audit-startup
      test-mirror-sync-audit-log
      test-federation-bridge
      test-connector-credit-cap
      test-connector-handshake-errors
      test-connector-public-url
      test-federation-link
      test-listing-reach
      test-listing-pull
      test-settlement-state
      test-settlement-exchange
      test-settlement-orchestration
      test-federation-purchase-route
      test-federation-commission
      test-p2p-announce
      test-federation-settlement
      test-admin-actor-name
      test-admin-queue
      test-admin-auth
      test-admin-key-auth
      test-app-admin-handoff
      test-settings-qr-signin
      test-challenge-token-leak
      test-moderator-routes
      test-backend-monitors
      test-backup-hardening
      test-backup-identity-bundle
      test-sealed-backups
      test-takeover-envelope
      test-owner-words-check
      test-backup-topology
      test-standby-token-only
      test-standby-envelopes
      test-takeover-by-code
      test-takeover-crash-resume
      test-takeover-by-phone
      test-takeover-split-brain
      test-profile-takeover
      test-open-join-failover
      test-place-watch-failover
      test-unlock-cancel
      test-cash-also-needed
      test-posts-ignore-archetypes
      test-crowdfund-ledger-sync
      test-detached-pwa
      test-dos-caps
      test-economic-hardening
      test-federation-api
      test-federation-receipt
      test-genesis
      test-hardening
      test-logger-sanitization
      test-manager-build
      test-onboarding-funnel
      test-funnel-cohort
      test-request-auth
      test-api-path-auth
      test-read-auth-default
      test-activity-feed-members-only
      test-members-contact-visibility
      test-contact-trade-partners
      test-sync-signature
      test-trust-value-curve
      test-trust-tiers-one-source
      test-vouch-covenant
      test-wash-sybil-defense
      test-apple-probe
      test-apple-return
      test-recovery-backup-durability
      test-public-address
      test-node-config-public
      test-registrar-contract
      test-invite-trampoline
      test-request-body
      test-admin-thresholds
      test-manager-backups
      test-push-preferences
      test-push-token-own-rows
      test-settings
      test-srv20-ledger-reset
      test-harvester
      test-membership-probe
      test-friends-routes
      test-message-attachment
      test-social-ratings
      test-app-store-versions
      test-node-profile
      test-profile-feature-gate
      test-global-no-beans
      test-open-door-hardening
      test-funnel-event
      test-handshake
      test-post-pause-resume
      test-cancel-post-request
      test-non-members-cant-act
      test-marketplace-auth
      test-escrow-fail-closed
      test-escrow-floor
      test-escrow-write-off
      test-version-resolution
      test-avatar-endpoint
      test-etag-short-circuit
      test-api-headers-and-feed-etag
      test-directory-publisher
      test-members-holiday
      test-admin-seed-invite
      test-admin-genesis-pubkey
      test-admin-empty-sentinel
      test-node-roles
      test-suspended-owner-bootstrap
      test-federation-link-binding
      test-ws-pong-watchdog
      test-ws-http-port
      test-ws-auth-default
      test-ws-feed-parties
      test-live-post-payloads
      test-moderation-notifications
      test-polls
      test-poll-voters-members-only
      test-events
      test-enterprise-event-http
      test-event-chat
      test-event-notify
      test-event-reminders
      test-event-reminders-http
      test-posts-fts-same-ms
      test-event-scrub
      test-migration-projects-enterprises
      test-commons-reject-project
      test-commons-projects-update-delete
      test-decisions-engine
      test-decisions-client-api
      test-decisions-voting-answers
      test-decisions-tick-route-gone
      test-rip-out-legacy-voting
      test-escrow-disputes
      test-process-handlers
      test-shutdown-recovery
      test-storage-health
      test-image-store
      test-image-store-s3
      test-image-store-s3-http
      test-image-evacuation
      test-photo-metadata
      test-snapshot-completeness
      test-groups-isolation
      test-groups-routes
      test-groups-invite-only-hidden
      test-group-existence-leaks
      test-groups-patch-http
      test-groups-sync-and-removal
      test-groups-chat
      test-chat-parity
      test-keeper-read-cursor
      test-groups-chat-sync
      test-groups-succession
      test-groups-lead-convenor
      test-member-wizards
      test-enterprise-pause
      test-enterprise-season-lifecycle
      test-enterprise-keepers-slice6
      test-enterprise-keeper-answers
      test-succession-broadcast-after-commit
      test-enterprise-location
      test-enterprise-thread
      test-enterprise-closed-states
      test-slice6-review-findings
      test-security-followups-0919
    )
    for t in "${SUITES[@]}"; do
      echo "━━━ $t ━━━"
      TMP_DIR=$(mktemp -d)
      ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" $SUITE_TIMEOUT pnpm exec tsx "src/$t.ts"
      RC=$?
      # 124 is timeout(1) reporting the wall clock expired. Named separately so a hang reads as a
      # hang in the summary rather than as an ordinary failure.
      if [ $RC -eq 124 ]; then FAILED="$FAILED $t(TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED $t"; fi
      rm -rf "$TMP_DIR"
    done

    # The two settlement ROUTES again with settlement ENABLED. FEDERATION_SETTLEMENT_ENABLED is a module const
    # read at import, so a single process only ever sees one value — the loop above covers the shipped state
    # (off, the kill switch refusing everything) and this covers the full matrix behind it. Running either one
    # once would leave half the route untested, and it is the half that moves value: the purchase route can
    # debit a member, and the commission route can draw on the Commons pot.
    #
    # NO APOSTROPHES ANYWHERE IN THIS FUNCTION. The whole block is one single-quoted bash -c string, so one
    # in a comment closes the string and the file fails to parse 100 lines later with "unexpected end of file".
    SETTLEMENT_ON_SUITES=(
      test-federation-purchase-route
      test-federation-commission
    )
    for t in "${SETTLEMENT_ON_SUITES[@]}"; do
      echo "━━━ $t (settlement ON) ━━━"
      TMP_DIR=$(mktemp -d)
      ENABLE_PEER_CONNECTORS=true FEDERATION_SETTLEMENT=true BEANPOOL_DATA_DIR="$TMP_DIR" \
        $SUITE_TIMEOUT pnpm exec tsx "src/$t.ts"
      RC=$?
      if [ $RC -eq 124 ]; then FAILED="$FAILED $t(on,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED $t(on)"; fi
      rm -rf "$TMP_DIR"
    done

    # The keeper HTTP reachability suite again with read enforcement switched OFF by the operator opt-out.
    # Read auth is ON by default, so the loop above already runs the pass that matters (the public-read
    # allowlist under enforcement); this covers a node whose operator set ENFORCE_READ_AUTH=false. Same
    # const-at-import problem as above: the flag is read once per process, and imports hoist.
    echo "━━━ test-keeper-http (read auth opted out) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_READ_AUTH=false ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-keeper-http.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-keeper-http(readauth-off,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-keeper-http(readauth-off)"; fi
    rm -rf "$TMP_DIR"

    # Messaging IDOR (A2-2/A2-3/A2-15) — asserts one member cannot read another members conversations.
    # Needs ENFORCE_READ_AUTH for the same const-at-import reason, and refuses to run without it rather
    # than passing vacuously, which is why it sat unregistered.
    echo "━━━ test-messaging-idor (read auth ON) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_READ_AUTH=true ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-messaging-idor.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-messaging-idor(TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-messaging-idor"; fi
    rm -rf "$TMP_DIR"

    # Member-read IDOR (A2-16 family) - asserts one member cannot read another members invites
    # or notification preferences. Read auth is ON by default, so the loop above runs those 403
    # assertions; this SECOND run covers the operator opt-out (ENFORCE_READ_AUTH=false), where they
    # are skipped and the push-token and preference round-trips must still work.
    echo "━━━ test-push-preferences (read auth opted out) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_READ_AUTH=false ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-push-preferences.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-push-preferences(readauth-off,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-push-preferences(readauth-off)"; fi
    rm -rf "$TMP_DIR"

    # Distance search (G4) again with read enforcement opted out. The loop above runs it as a node ships; here
    # nothing stands in front of the People list, so its own refusal of a distance to an unsigned caller or a
    # key that is not a member is what holds.
    echo "━━━ test-distance-search (read auth opted out) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_READ_AUTH=false ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-distance-search.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-distance-search(readauth-off,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-distance-search(readauth-off)"; fi
    rm -rf "$TMP_DIR"

    # Consolidated/legacy conversation-id resolution: a send to a legacy id remaps to the active DM,
    # preserves metadata.originalConversationId (the E2EE AAD fallback), and survives a malformed-metadata row.
    echo "━━━ test-messaging-consolidation ━━━"
    TMP_DIR=$(mktemp -d)
    BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-messaging-consolidation.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-messaging-consolidation(TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-messaging-consolidation"; fi
    rm -rf "$TMP_DIR"

    # WebSocket upgrades on the plain HTTP port, which is the Cloudflare tunnel origin, again with ws
    # auth ON (strict). ENFORCE_WS_AUTH is read once at import, and the pass above only proves the default
    # (strangers get public doorbells); this one proves an unsigned /ws is refused on 8080 exactly as on 8443.
    echo "━━━ test-ws-http-port (ws auth ON) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_WS_AUTH=true ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-ws-http-port.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-ws-http-port(wsauth,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-ws-http-port(wsauth)"; fi
    rm -rf "$TMP_DIR"

    # The same upgrade paths with the operator escape hatch ENFORCE_WS_AUTH=false: an unsigned /ws on the
    # tunnel port gets the old open feed, exactly as on 8443. Same const-at-import reason.
    echo "━━━ test-ws-http-port (ws auth OFF, open feed) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_WS_AUTH=false ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-ws-http-port.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-ws-http-port(open,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-ws-http-port(open)"; fi
    rm -rf "$TMP_DIR"

    # The /ws feed with the operator escape hatch ENFORCE_WS_AUTH=false: the old open feed, where an
    # unsigned socket gets every community-wide event but still never a scoped one. The loop above
    # covers the default (strangers get public doorbells only); same const-at-import reason.
    echo "━━━ test-ws-auth-default (ws auth OFF, open feed) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_WS_AUTH=false ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-ws-auth-default.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-ws-auth-default(open,TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-ws-auth-default(open)"; fi
    rm -rf "$TMP_DIR"

    # The recovery WebSocket suite, which asserts the ws path REFUSES an unauthenticated subscriber.
    # Both flags are mandatory — the suite itself exits nonzero without them rather than passing
    # vacuously, which is why it can only ever have been run by hand. Same const-at-import reason as
    # the two blocks above.
    echo "━━━ test-recovery-ws (read + ws auth ON) ━━━"
    TMP_DIR=$(mktemp -d)
    ENFORCE_READ_AUTH=true ENFORCE_WS_AUTH=true ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" \
      $SUITE_TIMEOUT pnpm exec tsx src/test-recovery-ws.ts
    RC=$?
    if [ $RC -eq 124 ]; then FAILED="$FAILED test-recovery-ws(TIMEOUT)"; elif [ $RC -ne 0 ]; then FAILED="$FAILED test-recovery-ws"; fi
    rm -rf "$TMP_DIR"

    if [ -n "$FAILED" ]; then
      echo ""
      echo "❌ Federation suites failed:$FAILED"
      exit 1
    fi
  '
}

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

# The federation suites need @beanpool/core's dist to be settled, so they start only once `build` has
# finished. Waiting on that one PID keeps lint/test/secrets_guard running in parallel meanwhile.
BUILD_STATUS=""
if [ $FEDERATION_QUEUED -eq 1 ]; then
  wait "${PIDS[0]}"
  # CACHED, because the collection loop below waits on every PID again and waiting twice on one child is
  # not portable — POSIX leaves it undefined once the child has been reaped. bash 3.2 happens to return the
  # real status, so this is a latent portability trap rather than an observed failure, and a TEST GATE that
  # can silently invert its own verdict is the last place to rely on shell-version behaviour.
  BUILD_STATUS=$?
  run_check "federation" run_federation_suites
fi

# Wait for parallel checks and collect results
PASS=0
FAIL=0
FAILED_NAMES=()

for i in "${!PIDS[@]}"; do
  if [ $i -eq 0 ] && [ -n "$BUILD_STATUS" ]; then
    EXIT_CODE=$BUILD_STATUS      # already reaped above; reuse its real status
  else
    wait "${PIDS[$i]}"
    EXIT_CODE=$?
  fi
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

echo "╠══════════════════════════════════════════╣"
printf "║  Total: %d passed, %d failed, %d skipped\n" "$PASS" "$FAIL" "${#SKIPPED_NAMES[@]}"
printf "║  Wall clock: %s (max %d parallel jobs)\n" "$(fmt_secs $(($(date +%s) - RUN_START)))" "$MAX_CONCURRENT_JOBS"
echo "╚══════════════════════════════════════════╝"

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
    # Same for a check turbo did not run — the federation suites above all land here, and their whole
    # log is the one to read the names out of.
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

# Exit with failure if anything failed
[ $FAIL -eq 0 ]
