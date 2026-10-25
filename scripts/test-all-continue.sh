#!/bin/bash
# test-all-continue.sh — verifies that test-all.sh runs every package to its own result
# under --continue (a failure in one package never hides the others), names every failing
# package and file in the failure summary, and marks stages in the report from their .rc files.
#
# Run: bash scripts/test-all-continue.sh

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

run=0; passed=0
ok()   { run=$((run + 1)); passed=$((passed + 1)); echo "✓ $1"; }
bad()  { run=$((run + 1)); echo "✗ $1"; }

assert_has() {
  local desc="$1" text="$2" pattern="$3"
  run=$((run + 1))
  if printf '%s\n' "$text" | grep -qF -- "$pattern"; then
    passed=$((passed + 1)); echo "✓ $desc"
  else
    echo "✗ $desc (output lacks: $pattern)"
  fi
}

assert_lacks() {
  local desc="$1" text="$2" pattern="$3"
  run=$((run + 1))
  if printf '%s\n' "$text" | grep -qF -- "$pattern"; then
    echo "✗ $desc (unexpectedly found: $pattern)"
  else
    passed=$((passed + 1)); echo "✓ $desc"
  fi
}

# ── Harness Setup ──────────────────────────────────────────────────────────────────
H="$T/harness"
mkdir -p "$H/scripts" "$H/bin" "$H/apps/native/e2e" "$H/logs"

# Copy the real scripts under test
cp "$ROOT/scripts/test-all.sh" "$ROOT/scripts/test-all-lib.sh" "$H/scripts/"

# Stub dependencies and helper scripts called by test-all.sh
for s in \
  check-deps-installed.mjs \
  check-suite-registration.sh \
  check-undeclared-imports.mjs \
  check-balance-writes.mjs \
  check-migrations-unchanged.sh \
  check-workflows.test.mjs \
  no-google-fonts.test.mjs \
  website-colours.test.mjs \
  website-contrast.mjs \
  website-status.test.mjs \
  website-global-link.test.mjs \
  website-lang.test.mjs \
  setup-backup.test.mjs \
  automation-token.test.mjs \
  bootstrap-community-eggs.test.mjs \
  grant-operator.test.mjs \
  credential-redirects.test.mjs \
  rotate-node-env.test.mjs \
  reddit-inbox.test.mjs \
  check-compose-log-caps.mjs \
  test-deploy-preserve.sh \
  test-deploy-no-fleet-secrets.sh \
  test-deploy-health.sh \
  test-deploy-package.sh \
  test-failing-tests-summary.sh \
  test-merge-gate.sh; do
  case "$s" in
    *.sh)
      cat > "$H/scripts/$s" << 'EOF'
#!/bin/bash
exit 0
EOF
      chmod +x "$H/scripts/$s"
      ;;
    *.mjs|*.js)
      echo 'process.exit(0)' > "$H/scripts/$s"
      ;;
  esac
done

mkdir -p "$H/scripts/tools" "$H/scripts/words"
for s in check-tool-budgets.mjs check-tool-budgets.test.mjs scaffold.test.mjs fence.test.mjs; do
  echo 'process.exit(0)' > "$H/scripts/tools/$s"
done
echo 'process.exit(0)' > "$H/scripts/words/words.test.mjs"
echo 'process.exit(0)' > "$H/apps/native/e2e/locked-history-320.mjs"

# Stub pnpm that checks for --continue when running turbo run test
cat > "$H/bin/pnpm" << 'STUB'
#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')

if (args.startsWith('turbo run test')) {
  // If --continue is passed, simulate turbo continuing across packages:
  // @beanpool/core fails, but @beanpool/pwa still runs and reports.
  if (args.includes('--continue')) {
    console.log('@beanpool/core:test: FAIL packages/beanpool-core/src/index.test.ts > core test')
    console.log('@beanpool/core:test: AssertionError: expected 1 to be 2')
    console.log('@beanpool/core:test: command finished with error, but continuing...')
    console.log('@beanpool/pwa:test: FAIL apps/pwa/src/App.test.tsx > pwa test')
    console.log('@beanpool/pwa:test: AssertionError: expected 3 to be 4')
    console.log('@beanpool/pwa:test: command finished with error, but continuing...')
    console.log(' Tasks:    0 successful, 2 total')
    console.log('Failed:    @beanpool/core#test, @beanpool/pwa#test')
    process.exit(1)
  } else {
    // Without --continue: the first failing package stops turbo immediately.
    // Package 2 never runs and prints no totals.
    console.log('@beanpool/core:test: FAIL packages/beanpool-core/src/index.test.ts > core test')
    console.log('@beanpool/core:test: AssertionError: expected 1 to be 2')
    console.log(' Tasks:    0 successful, 1 total')
    console.log('Failed:    @beanpool/core#test')
    process.exit(1)
  }
}

// build, lint, typecheck, playwright stubs succeed
process.exit(0)
STUB
chmod +x "$H/bin/pnpm"

# Initialise empty git repo in harness so git/diff checks succeed
( cd "$H" && git init -q && git config user.name "Test" && git config user.email "test@test.invalid" && git commit -q --allow-empty -m "init" )

# ── Run test-all.sh --fast ──────────────────────────────────────────────────────────
OUT=""
RC=0
OUT=$(cd "$H" && env PATH="$H/bin:$PATH" TEST_ALL_LOG_DIR="$H/logs" bash "$H/scripts/test-all.sh" --fast 2>&1) || RC=$?
TEST_LOG="$H/logs/test.log"

# 1. Exit code: stage and overall run must fail (be red)
if [ "$RC" -ne 0 ]; then
  ok "test stage is red (exit $RC)"
else
  bad "test stage is red (unexpectedly exited 0)"
fi

# 2. Both packages run and report (first fails, second still runs and reports)
assert_has "first package ran and reported in test log" "$(cat "$TEST_LOG" 2>/dev/null)" "@beanpool/core:test:"
assert_has "second package ran and reported despite first package failure" "$(cat "$TEST_LOG" 2>/dev/null)" "@beanpool/pwa:test:"
assert_has "turbo totals show both packages ran (2 total)" "$(cat "$TEST_LOG" 2>/dev/null)" "Tasks:    0 successful, 2 total"

# 3. Report box marks exactly the failed stage
assert_has "report marks test as FAIL" "$OUT" "test             ❌ FAIL"
assert_has "report marks build as PASS (build.rc was 0)" "$OUT" "build            ✅ PASS"
assert_lacks "report does not mark build as FAIL" "$OUT" "build            ❌ FAIL"
assert_has "report marks lint as PASS (lint.rc was 0)" "$OUT" "lint             ✅ PASS"
assert_has "report marks typecheck as PASS (typecheck.rc was 0)" "$OUT" "typecheck        ✅ PASS"
assert_has "report totals count exactly 1 failed" "$OUT" "1 failed"

# 4. Failure details names EVERY failing package and file
assert_has "failure summary names first failing package" "$OUT" "── @beanpool/core#test ──"
assert_has "failure summary names first failing file" "$OUT" "packages/beanpool-core/src/index.test.ts"
assert_has "failure summary names second failing package" "$OUT" "── @beanpool/pwa#test ──"
assert_has "failure summary names second failing file" "$OUT" "apps/pwa/src/App.test.tsx"

echo ""
echo "$passed/$run checks passed."
[ "$passed" -eq "$run" ]
