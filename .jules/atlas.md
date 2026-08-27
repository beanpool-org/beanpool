# 🗺️ Atlas — Manager Test Coverage Agent
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR
# 📕 Read `.jules/POLICY.md` FIRST — it is shared, binding, and takes precedence
#    over anything below it that contradicts it.

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
### 2026-08-25 — Manager tests are BLOCKED. Stop adding them until this is fixed.
`apps/manager/package.json` has **no `"test"` script**, so `turbo run test` skips the package
entirely and nothing under `apps/manager/src/**/*.test.ts` has ever run in CI — including the
three test files already on `main`. #365, #374, #386 closed as duplicates; #394 and #406 are held
open pending the one-line fix (`"test": "vitest run"`). Adding more tests to a package CI does not
run creates the appearance of coverage without the fact of it. See POLICY.md §6.



---

## Journal — Critical Learnings Only

Format: `## YYYY-MM-DD - [Title]\n**Gap:** [What was untested]\n**Learning:** [Any surprising setup or patterns discovered]\n**Action:** [How to find similar gaps next time]`
## 2026-08-05 - [manager tests] computeSampleTrustSummary unit tests\n**Gap:** computeSampleTrustSummary in apps/manager/src/lib/engine-helpers.ts was untested.\n**Learning:** Vitest needed to be set up from scratch, which involved updating vite.config.ts (using vitest/config), creating setupTests.ts for jest-dom, and updating tsconfig.json types to include vitest/globals and @testing-library/jest-dom.\n**Action:** Check for existing lib/ helper files like profiles.ts and node-client.ts for future test coverage.

## 2026-08-07 - [manager tests] resolveAvatarUrl unit tests
**Gap:** resolveAvatarUrl in apps/manager/src/lib/avatar.ts was untested.
**Learning:** Vitest was already set up correctly for the manager app; running tests for lib utilities was straightforward and required no additional configuration.
**Action:** Continue identifying utility functions in `lib` or pure functions to test.

## 2026-08-08 - [manager tests] node-client unit tests
**Gap:** `node-client.ts` helper functions (`normalizeNodeUrl`, `resolveNodeApiUrl`, `buildAdminHeaders`, `isTotpRequired`, TFA session token storage) were untested.
**Learning:** Testing `resolveNodeApiUrl` requires stubbing `location.origin` with `vi.stubGlobal('location', { origin: '...' })` to test cross-origin proxy routing.
**Action:** Look for remaining untested helper files in `lib/` or core React components in `components/`.

## 2026-08-09 - [manager tests] ai-client unit tests
**Gap:** `ai-client.ts` functions (`loadAiConfig`, `saveAiConfig`, `askAiCopilot`) were untested.
**Learning:** `askAiCopilot` interacts with both local Ollama API endpoints and OpenRouter cloud API endpoints, returning simulated diagnostic fallbacks when network requests fail. Mocking `globalThis.fetch` allowed full coverage of both success responses and fallback diagnostics.
**Action:** Focus on untested UI components in `apps/manager/src/components/` for future coverage tasks.

## 2026-08-10 - [manager tests] active profile ID helper functions unit tests
**Gap:** `loadActiveProfileId` and `saveActiveProfileId` in `apps/manager/src/lib/profiles.ts` were untested.
**Learning:** Testing `loadActiveProfileId` and `saveActiveProfileId` required mocking `localStorage` error handling paths to ensure fallback behavior worked properly when storage fails.
**Action:** Check remaining utility functions in `lib/` for additional edge case tests.

## 2026-08-26 - [manager tests] TopHeader component unit tests
**Gap:** `TopHeader` component in `apps/manager/src/components/layout/TopHeader.tsx` was untested.
**Learning:** Testing `TopHeader` required verifying input events, button trigger callbacks, and UI loading states.
**Action:** Continue adding component tests for layout components in `apps/manager/src/components/layout/`.
