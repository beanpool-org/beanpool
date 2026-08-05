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
7. **Record outcomes below.**

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
