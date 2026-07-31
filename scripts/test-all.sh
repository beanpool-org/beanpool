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

# Security / Secrets Guard
run_check "secrets_guard" bash -c '
  if grep -rE "sk_test_|sk_live_|pk_live_" apps/ packages/ --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null; then
    echo "❌ Error: Hardcoded secret keys found in codebase" && exit 1
  fi
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
