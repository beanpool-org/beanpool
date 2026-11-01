import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the native app's logic — not its screens.
 *
 * There was no runner here at all until now, which meant every piece of client logic shipped on
 * a typecheck and a hope. Screens still need a device; the decisions underneath them do not, and
 * those are where the recovery model can go quietly wrong.
 *
 * Node environment on purpose. React Native and Expo modules do not load outside a device, so
 * tests mock them at the boundary rather than dragging in a transform pipeline to pretend
 * otherwise. That keeps the runner fast and honest about what it covers: the logic, with I/O
 * stubbed — never a claim that the code ran on a phone.
 */
export default defineConfig({
    define: {
        __DEV__: 'false',
    },
    resolve: {
        alias: {
            // The app never imports it. utils/__tests__/vault-real.test.ts runs BeanPool's key vault itself
            // (apps/vault's harness, from source), whose API imports the sign-in checks: from their source here, so the
            // test never waits on a build of a package the app doesn't depend on.
            '@beanpool/signin': fileURLToPath(new URL('../../packages/beanpool-signin/src/index.ts', import.meta.url).href),
            // A native view that doesn't load outside a device. Every door screen imports the check's sheet, so every test
            // that renders one would have to mock it; door-check-sheet-render.test.ts mocks it for what it checks.
            'react-native-webview': fileURLToPath(new URL('./utils/__tests__/webview-stub.ts', import.meta.url).href),
        },
    },
    test: {
        environment: 'node',
        // A tool's own tests sit in its folder (tools/<id>/__tests__, DESIGN-tool-template-fable.md §1.5); the template's
        // generic ones are utils/__tests__/tools-template.test.ts.
        include: ['utils/__tests__/**/*.test.ts', 'tools/**/__tests__/**/*.test.ts'],
        // CI only. One four-vCPU runner hosts build, lint, test and typecheck at once, and vitest
        // otherwise sizes its pool from the machine's cores — five packages each doing that is what
        // starved the timing-sensitive suites elsewhere in this workspace into failing on a
        // stopwatch. See scripts/test-all.sh. Uncapped locally.
        minWorkers: process.env.CI ? 1 : undefined,
        // Two, not one: "Timeout calling onTaskUpdate" after every test passed was never the worker count — a worker whose
        // file never yields its event loop for 60 s (members-on-demand, posts-nearby on a starved runner) tripped vitest's
        // fixed RPC timer. patches/vitest@3.2.7.patch removes that timer, as vitest 4 does (vitest-dev/vitest#8297).
        maxWorkers: process.env.CI ? 2 : undefined,
        // Set by scripts/test-all.sh, which runs on a machine shared with build lanes. Vitest's 5 s
        // default timed out 52 tests at load average ~60 that pass in 3.5 s alone. Unset for a
        // developer running `npx vitest` directly: the default stays.
        testTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
        hookTimeout: process.env.TEST_ALL_TIMEOUT_MS ? Number(process.env.TEST_ALL_TIMEOUT_MS) : undefined,
    },
});
