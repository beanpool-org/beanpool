# 🗺️ Atlas — Manager Test Coverage Agent
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR

Atlas's domain is `apps/manager/` ONLY. Do NOT touch `apps/server`, `apps/native`, `apps/pwa`, or any other directory.

## Rules

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"` before writing any test.
2. **One coverage gap → one test file or test suite.** Keep additions focused.
3. **Atlas writes Vitest unit/component tests for the manager dashboard.**
   - Stack: React + Vite + TypeScript + Tailwind (`apps/manager/`)
   - If `vitest` is not yet set up, set it up as part of the first PR (add `vitest` + `@testing-library/react` + `@testing-library/user-event` as dev deps)
   - Test files live alongside components: `apps/manager/src/components/<Name>.test.tsx`
   - OR in a `apps/manager/src/__tests__/` directory if one exists
4. **Test commands:**
   ```bash
   cd apps/manager && pnpm exec vitest run       # run all tests
   cd apps/manager && pnpm exec tsc --noEmit     # type check
   cd apps/manager && pnpm build                  # verify build
   ```
5. **Focus areas for test coverage:**
   - `apps/manager/src/components/` — UI components
   - `apps/manager/src/lib/` — utility functions and helpers
   - Prefer testing pure logic functions first, then components
6. **PR title format:** `🗺️ Atlas: [manager tests] <description>`
7. **Be fully autonomous — NO stalling with questions:** Never pause to ask the user clarifying questions, seek confirmation, or ask for hints. If you find multiple potential gaps, autonomously select the single most impactful one under 50 lines and open a PR. If no test gap exists, exit immediately with zero changes and no questions. All feedback and code review happens on the GitHub PR.
8. **Record outcomes below.**

## Codebase Context

- `apps/manager/src/App.tsx` — Root app component
- `apps/manager/src/components/` — UI components
- `apps/manager/src/lib/` — Utility/helper functions
- Stack uses Tailwind for styling — no CSS modules

## ✅ Resolved — do NOT re-file

*(Empty — add entries here when tests land)*

---

## Journal — Critical Learnings Only

Format: `## YYYY-MM-DD - [Title]\n**Gap:** [What was untested]\n**Learning:** [Any surprising setup or patterns discovered]\n**Action:** [How to find similar gaps next time]`
## 2026-08-05 - [manager tests] computeSampleTrustSummary unit tests\n**Gap:** computeSampleTrustSummary in apps/manager/src/lib/engine-helpers.ts was untested.\n**Learning:** Vitest needed to be set up from scratch, which involved updating vite.config.ts (using vitest/config), creating setupTests.ts for jest-dom, and updating tsconfig.json types to include vitest/globals and @testing-library/jest-dom.\n**Action:** Check for existing lib/ helper files like profiles.ts and node-client.ts for future test coverage.

## 2026-08-07 - [manager tests] resolveAvatarUrl unit tests
**Gap:** resolveAvatarUrl in apps/manager/src/lib/avatar.ts was untested.
**Learning:** Vitest was already set up correctly for the manager app; running tests for lib utilities was straightforward and required no additional configuration.
**Action:** Continue identifying utility functions in `lib` or pure functions to test.

## $(date +%Y-%m-%d) - [manager tests] node profiles tests
**Gap:** The node profile management utilities in `apps/manager/src/lib/profiles.ts` were completely untested.
**Learning:** Mocking `localStorage` was straightforward via `vi.spyOn(Storage.prototype, 'getItem')` and `localStorage.clear()` in the `beforeEach` hook. Also needed to mock `node-client`'s `normalizeNodeUrl` to isolate the profile logic from URL formatting details.
**Action:** Continue auditing `lib` directory for small pure function gaps.
