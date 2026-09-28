import { defineConfig } from 'vitest/config';

/**
 * The same CI worker cap as packages/beanpool-core (see its vitest.config.ts for why). Each suite starts its own
 * keyholder and API on a temp directory, a Unix socket and a free port, so the files run in parallel safely.
 */
export default defineConfig({
    test: {
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
});
