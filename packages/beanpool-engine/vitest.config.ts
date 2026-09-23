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
    },
});
