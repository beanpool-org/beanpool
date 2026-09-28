import { defineConfig } from 'vitest/config';

/** The same CI worker cap as packages/beanpool-core (see its vitest.config.ts for why). */
export default defineConfig({
    test: {
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
    },
});
