import { defineConfig } from 'vitest/config';

/**
 * A worker cap, and nothing else.
 *
 * This package ran `vitest run` with no config file at all, and everything here other than the two
 * options below is still vitest's default — the same 4 files and 32 tests run as before.
 *
 * The cap exists because of what runs AROUND these tests on CI: one four-vCPU runner hosting
 * build, lint, test and typecheck at once, with `turbo run test` fanning out across eight packages
 * and each vitest sizing its worker pool from the machine's cores. See packages/beanpool-core/
 * vitest.config.ts and scripts/test-all.sh for the full reasoning and the measurements.
 *
 * Local runs are uncapped.
 */
export default defineConfig({
    test: {
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
        // A full local run (scripts/test-all.sh) gives every test 30 s, as native and core take it: the default 5 s timed out
        // statements.test.ts in three runs at load 30+ on 24 Oct, and the failure then stopped every other package mid-run.
        testTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
        hookTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
    },
});
