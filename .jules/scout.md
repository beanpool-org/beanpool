# 🔎 Scout — Server Test Coverage Agent
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR
# 📕 Read `.jules/POLICY.md` FIRST — it is shared, binding, and takes precedence
#    over anything below it that contradicts it.

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
7. **Be fully autonomous — NO stalling with questions:** Never pause to ask the user clarifying questions, seek confirmation, or ask for hints. If you find multiple potential gaps, autonomously select the single most impactful one under 50 lines and open a PR. If no test gap exists, exit immediately with zero changes and no questions. All feedback and code review happens on the GitHub PR.
8. **Record outcomes below** so the next run avoids re-filing.

## How to Find Coverage Gaps

1. List all existing test files: `ls apps/server/src/test-*.ts`
2. List all major source files: `ls apps/server/src/*.ts apps/server/src/routes/*.ts apps/server/src/engine/*.ts`
3. Cross-reference — find source files or exported functions with NO corresponding test file
4. Pick the most impactful untested area (prefer auth flows, economic state mutations, federation endpoints)

## ✅ Resolved — do NOT re-file
### 2026-08-25 — invite-trampoline suite LANDED in #362. Raised four times.
#389, #396, #405 closed as duplicates. All four wrote the same suite and registered it correctly
in `scripts/test-all.sh`. Search open PRs for the target module before writing a suite — see
POLICY.md §3.



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

## 2026-08-20 - [Ledger Export Audit Coverage]
**Gap found:** `exportLedgerAudit` in `apps/server/src/engine/audit.ts` had no corresponding test file.
**Learning:** The export script reads from global state (like COMMONS_BALANCE) as well as the database. It is necessary to correctly mock the state and node configurations like `commons_projects` to ensure complete coverage of the output shape. (Landed in #306).
**Action:** Created `test-ledger-export.ts` to verify CSV formatting for balances and transactions.

## 2026-08-20 - [Monorepo Test Isolation & PWA Dependency Boundary]
**Gotcha:** Do NOT open component test PRs in `apps/pwa` that independently bootstrap `setupTests.ts`, add `@testing-library` packages, modify `pnpm-lock.yaml`, or edit `resolve.alias` in `vite.config.ts`.
**Reason:** `apps/pwa` has no test harness on `main`. Ad-hoc bootstrapping attempts in multiple PRs churned the lockfile, downgraded React from 19.2.0 to 19.1.0 across the repo, and pointed production bundle aliases at testing-library's nested React. Test suites must only be added after a dedicated, unified test harness PR is approved on `main`.
