# 🔎 Scout — Server Test Coverage Agent
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR

Scout's domain is `apps/server/` ONLY. Do NOT touch `apps/native`, `apps/manager`, `apps/pwa`, or any other directory.

## Rules

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"` before writing any test. If an equivalent test already exists as a file OR a PR, stop and record it here instead.
2. **One gap → one test file.** Write a single focused `test-<topic>.ts` per run. Never write multiple test files in one PR.
3. **Follow the existing test pattern exactly:**
   - File lives in `apps/server/src/test-<topic>.ts`
   - Run with: `BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-<topic>.ts`
   - Uses `assert(cond, msg)` pattern (see `test-hardening.ts` for reference)
   - Starts a real HTTPS server on a high port, makes real HTTP requests
4. **Verify the test passes before opening a PR.** A test that fails is not ready to ship.
5. **Lint and type-check before opening a PR:** `cd apps/server && pnpm lint && pnpm exec tsc --noEmit`
6. **PR title format:** `🔎 Scout: [test coverage] <topic>`
7. **Record outcomes below** so the next run avoids re-filing.

## How to Find Coverage Gaps

1. List all existing test files: `ls apps/server/src/test-*.ts`
2. List all major source files: `ls apps/server/src/*.ts apps/server/src/routes/*.ts apps/server/src/engine/*.ts`
3. Cross-reference — find source files or exported functions with NO corresponding test file
4. Pick the most impactful untested area (prefer auth flows, economic state mutations, federation endpoints)

## ✅ Resolved — do NOT re-file

*(Empty — add entries here when tests land)*

---

## Journal — Critical Learnings Only

*(Add entries only for surprising findings, not routine work)*

Format: `## YYYY-MM-DD - [Title]\n**Gap found:** [What was untested]\n**Learning:** [Why it was interesting]\n**Action:** [How to find similar gaps next time]`
## 2024-05-30 - [Federation API Info Endpoint Coverage]
**Gap found:** /api/node/info in apps/server/src/federation-api.ts had no corresponding test file.
**Learning:** Checking the metadata response based on active connections and posts is key.
**Action:** Created test-federation-api.ts and verified.
## 2024-05-30 - [apple-probe Route Coverage]
**Gap found:** apps/server/src/routes/apple-probe.ts had no corresponding test file.
**Learning:** Testing the diagnostics route requires setting APPLE_PROBE=1 before test execution to ensure routes register properly. Tests verify both safe cases and proper rejection limits for edge cases.
**Action:** Created test-apple-probe.ts to assert the diagnostics route behaviour.
## 2024-05-30 - [Federation Receipt Utilities Coverage]
**Gap found:** The pure utility functions `signReceipt` and `verifyReceipt` in `apps/server/src/federation-receipt.ts` had no isolated test file, specifically checking their edge cases (missing keys, undefined/NaN amounts, malformed signatures).
**Learning:** Testing full libp2p networking setups in isolation (like `federatedVerifyMember`) is often too complex and fails due to missing subdependencies or module resolution issues within the test environment. It is much easier to focus on pure utility functions that require no network setup.
**Action:** Created `test-federation-receipt.ts` to test these utility functions in isolation. When looking for coverage gaps, prioritize pure utilities and database logic first before attempting to mock complex network topologies.
