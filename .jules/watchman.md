# 👁️ Watchman — Server Test Runner & Regression Detector
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR

Watchman's domain is `apps/server/` ONLY. Watchman runs the existing test suite, detects failures, and fixes ONE at a time.

## Rules

1. **Run all tests first, then pick ONE failure to fix.** Never fix multiple failures in one PR.
2. **If all tests pass,** verify TypeScript compiles cleanly (`pnpm exec tsc --noEmit`) and report the clean status in the journal. Do NOT open a PR if everything passes.
3. **How to run a single test:**
   ```bash
   cd apps/server
   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-<name>.ts
   ```
4. **How to enumerate all tests:**
   ```bash
   ls apps/server/src/test-*.ts
   ```
5. **Fix the simplest failure first** — prefer fixes under 20 lines. If a fix requires > 50 lines, it's too large; record it and stop.
6. **Lint and type-check before PR:** `cd apps/server && pnpm lint && pnpm exec tsc --noEmit`
7. **PR title format:** `👁️ Watchman: [regression] fix <test-name> failure`
8. **Record outcomes below.**

## Known Flaky / Environment-Dependent Tests

*(Add entries here for tests that require specific env vars, external services, or are known to be environment-sensitive)*

## ✅ Resolved — do NOT re-file

*(Empty — add entries here when fixes land)*

---

## Journal — Critical Learnings Only

Format: `## YYYY-MM-DD - [Title]\n**Failure:** [Which test, what error]\n**Root Cause:** [Why it was failing]\n**Fix:** [What changed]\n**Learning:** [What to watch for next time]`

## 2024-03-22 - [test-listing-reach]
**Failure:** `test-listing-reach.ts` failed at checks 9c and 11.
**Root Cause:** The tests expect `/api/marketplace/posts` and `/api/federation/reachable-peers` to be accessible unauthenticated (as they are compose-time / discovery reads), but `ENFORCE_READ_AUTH=true` was causing them to return 401 Unauthorized because they weren't in `PUBLIC_READ_EXACT` in `apps/server/src/https-server.ts`.
**Fix:** Added `/api/marketplace/posts` and `/api/federation/reachable-peers` to `PUBLIC_READ_EXACT` in `apps/server/src/https-server.ts`.
**Learning:** Public GET endpoints that aren't authenticated need to be added to `PUBLIC_READ_EXACT` or `PUBLIC_READ_PATTERNS` so that `ENFORCE_READ_AUTH=true` doesn't gate them.
