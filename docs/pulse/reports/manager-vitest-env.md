# Manager vitest env — manager-vitest-env

PR: #545
Status: complete

## Built
- Diagnosed the root cause of the local vitest failure in `apps/manager/src/lib/ai-client.test.ts` across four hypotheses using parallel sub-agents.
- Fixed `apps/manager/src/setupTests.ts` by bridging real JSDOM `window.localStorage` and `window.sessionStorage` instances onto `globalThis`. This resolves the shadowing caused by Node 22's experimental native `globalThis.localStorage` accessor when Vitest 3.x's `populateGlobal` filters out global properties already defined in `globalThis` that are not listed in its static `KEYS` table.
- All 86 tests across 10 suites in `apps/manager` now pass cleanly without warnings or mock shims.

## Verified

### 1. `apps/manager` test suite (`pnpm test` in `apps/manager`)
```
> @beanpool/manager@1.2.0 test /Users/marty/.gemini/antigravity/worktrees/beanpool/hollow_wave_fires_20h33/apps/manager
> vitest run


 RUN  v3.2.7 /Users/marty/.gemini/antigravity/worktrees/beanpool/hollow_wave_fires_20h33/apps/manager

 ✓ src/lib/ai-client.test.ts (9 tests) 4ms
 ✓ src/lib/engine-helpers.test.ts (7 tests) 1ms
 ✓ src/lib/avatar.test.ts (14 tests) 2ms
 ✓ src/lib/active-profile.test.ts (3 tests) 2ms
 ✓ src/lib/node-client.test.ts (23 tests) 4ms
 ✓ src/lib/profiles.test.ts (4 tests) 2ms
 ✓ src/components/modules/MembersModule.test.ts (7 tests) 3ms
 ✓ src/components/layout/TopHeader.test.tsx (5 tests) 86ms
 ✓ src/components/nodes/TotpModal.test.tsx (6 tests) 119ms
 ✓ src/components/layout/FleetSidebar.test.tsx (8 tests) 138ms

 Test Files  10 passed (10)
      Tests  86 passed (86)
   Start at  20:40:43
   Duration  922ms (transform 337ms, setup 922ms, collect 664ms, tests 361ms, environment 3.86s, prepare 450ms)
```

### 2. Full test suite (`bash scripts/test-all.sh`)
```
🚀 Running BeanPool checks (max 4 parallel jobs)...

⚠️  no timeout(1) — suites run unguarded; a hanging suite will block this run

╔══════════════════════════════════════════╗
║          BEANPOOL TEST-ALL REPORT        ║
╠══════════════════════════════════════════╣
║  build            ✅ PASS
║  lint             ✅ PASS
║  test             ✅ PASS
║  typecheck        ✅ PASS
║  suite_registration ✅ PASS
║  deploy_preserve  ✅ PASS
║  secrets_guard    ✅ PASS
║  federation       ⚪ SKIPPED
╠══════════════════════════════════════════╣
║  Total: 7 passed, 0 failed, 1 skipped
╚══════════════════════════════════════════╝
```

### 3. Full test suite with federation (`bash scripts/test-all.sh --all`)
```
🚀 Running BeanPool checks (max 4 parallel jobs)...

⚠️  no timeout(1) — suites run unguarded; a hanging suite will block this run

╔══════════════════════════════════════════╗
║          BEANPOOL TEST-ALL REPORT        ║
╠══════════════════════════════════════════╣
║  build            ✅ PASS
║  lint             ✅ PASS
║  test             ✅ PASS
║  typecheck        ✅ PASS
║  suite_registration ✅ PASS
║  deploy_preserve  ✅ PASS
║  secrets_guard    ✅ PASS
║  federation       ✅ PASS
╠══════════════════════════════════════════╣
║  Total: 8 passed, 0 failed, 0 skipped
╚══════════════════════════════════════════╝
```

### 4. Typecheck across apps (`pnpm --filter @beanpool/server exec tsc --noEmit && pnpm --filter beanpool-pillar exec tsc --noEmit && pnpm --filter @beanpool/manager exec tsc --noEmit`)
Exited cleanly with code 0.

## Not done
None. All package requirements and verifications are complete.

## Assumptions a reviewer must confirm
- None.

## Found but out of scope
- `apps/manager/src/lib/active-profile.test.ts` and `apps/manager/src/lib/profiles.test.ts` contain redundant manual `localStorage` mocks which were added to work around this issue before the global JSDOM storage bridge was in place. They remain functional and untouched.
