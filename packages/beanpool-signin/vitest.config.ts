import { defineConfig } from 'vitest/config';

/** The same CI worker cap as packages/beanpool-core (see its vitest.config.ts for why). */
export default defineConfig({
    test: {
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
        // A full local run's per-test limit (scripts/test-all.sh), as core and engine take it.
        testTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
        hookTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
    },
});
