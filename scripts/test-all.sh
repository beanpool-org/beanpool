#!/bin/bash
# test-all.sh — BeanPool automated check runner with concurrency capping & scope auto-detection.

set -o pipefail

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

MAX_CONCURRENT_JOBS=4

run_check() {
  local name="$1"
  shift

  while [ $(jobs -rp | wc -l) -ge $MAX_CONCURRENT_JOBS ]; do
    sleep 0.2
  done

  "$@" > "$LOGDIR/$name.log" 2>&1 &
  PIDS+=($!)
  NAMES+=("$name")
}

skip_check() {
  local name="$1"
  SKIPPED_NAMES+=("$name")
}

echo "🚀 Running BeanPool checks (max $MAX_CONCURRENT_JOBS parallel jobs)..."
echo ""

# Core Monorepo Checks
run_check "build"         pnpm turbo run build
run_check "lint"          pnpm turbo run lint
run_check "test"          pnpm turbo run test

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

run_federation_suites() {
  bash -c '
    cd apps/server
    # NO `set -e`, and every suite runs even after one fails (review finding). Aborting on the first failure
    # left the remaining suites unexecuted, so a single break masked every other one and each fix-and-rerun
    # cycle only revealed the next problem. Statuses are collected and all failures reported together.
    FAILED=""
    for t in test-schema-upgrade test-commons-conservation test-demurrage-window test-crowdfund-delete-refund test-admin-password-query test-cors-policy test-gateway-config test-federation-bridge test-connector-credit-cap test-connector-public-url test-federation-link test-listing-reach test-listing-pull test-settlement-state test-settlement-exchange test-settlement-orchestration test-federation-purchase-route test-federation-commission test-federation-settlement; do
      echo "━━━ $t ━━━"
      TMP_DIR=$(mktemp -d)
      ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR="$TMP_DIR" pnpm exec tsx "src/$t.ts"
      if [ $? -ne 0 ]; then FAILED="$FAILED $t"; fi
      rm -rf "$TMP_DIR"
    done

    # The two settlement ROUTES again with settlement ENABLED. FEDERATION_SETTLEMENT_ENABLED is a module const
    # read at import, so a single process only ever sees one value — the loop above covers the shipped state
    # (off, the kill switch refusing everything) and this covers the full matrix behind it. Running either one
    # once would leave half the route untested, and it is the half that moves value: the purchase route can
    # debit a member, and the commission route can draw on the Commons pot.
    #
    # NO APOSTROPHES ANYWHERE IN THIS FUNCTION. The whole block is inside `bash -c '...'`, so one in a
    # comment closes the string and the file fails to parse 100 lines later with "unexpected end of file".
    for t in test-federation-purchase-route test-federation-commission; do
      echo "━━━ $t (settlement ON) ━━━"
      TMP_DIR=$(mktemp -d)
      ENABLE_PEER_CONNECTORS=true FEDERATION_SETTLEMENT=true BEANPOOL_DATA_DIR="$TMP_DIR" \
        pnpm exec tsx "src/$t.ts"
      if [ $? -ne 0 ]; then FAILED="$FAILED $t(on)"; fi
      rm -rf "$TMP_DIR"
    done
    if [ -n "$FAILED" ]; then
      echo ""
      echo "❌ Federation suites failed:$FAILED"
      exit 1
    fi
  '
}

# Security / Secrets Guard
run_check "secrets_guard" bash -c '
  if grep -rE "sk_test_|sk_live_|pk_live_" apps/ packages/ --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null; then
    echo "❌ Error: Hardcoded secret keys found in codebase" && exit 1
  fi
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
  printf "║  %-16s %s\n" "$NAME" "$STATUS"
done

for sn in "${SKIPPED_NAMES[@]}"; do
  printf "║  %-16s ⚪ SKIPPED\n" "$sn"
done

echo "╠══════════════════════════════════════════╣"
printf "║  Total: %d passed, %d failed, %d skipped\n" "$PASS" "$FAIL" "${#SKIPPED_NAMES[@]}"
echo "╚══════════════════════════════════════════╝"

# Show failure logs
if [ $FAIL -gt 0 ]; then
  echo ""
  echo "──── Failure Details ────"
  for fn in "${FAILED_NAMES[@]}"; do
    echo ""
    echo "━━━ $fn ━━━"
    tail -40 "$LOGDIR/$fn.log"
  done
  echo ""
fi

# Cleanup
rm -rf "$LOGDIR"

# Exit with failure if anything failed
[ $FAIL -eq 0 ]
