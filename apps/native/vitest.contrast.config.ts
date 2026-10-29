import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Runs ONLY e2e/button-contrast.check.ts: the whole-tree button/label contrast check (scripts/test-all.sh, `native_dark_contrast`).
 * It is not in vitest.config.ts's include on purpose. While a pair on main reads under 4.5:1 this check is red, and a red
 * pair must show up once, under its own name, not also as a failure of the phone's unit tests. The scanner's own tests
 * (canaries on fixture sources) are utils/__tests__/button-contrast.test.ts and run with the rest.
 * `pnpm --filter beanpool-pillar test:contrast`.
 *
 * It needs no build: the colour library is the only part of @beanpool/core it reads (constants/colors.ts and the contrast
 * maths), so that one source file stands in for the package. test-all can then start it at once and it frees its job slot
 * in seconds, instead of holding one idle until `build` has finished.
 */
export default defineConfig({
    define: {
        __DEV__: 'false',
    },
    resolve: {
        alias: {
            '@beanpool/core': fileURLToPath(new URL('../../packages/beanpool-core/src/brand-colours.ts', import.meta.url).href),
            '@beanpool/signin': fileURLToPath(new URL('../../packages/beanpool-signin/src/index.ts', import.meta.url).href),
        },
    },
    test: {
        environment: 'node',
        include: ['e2e/**/*.check.ts'],
        testTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
        hookTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
    },
});
