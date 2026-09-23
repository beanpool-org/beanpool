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
    test: {
        environment: 'node',
        include: ['utils/__tests__/**/*.test.ts'],
        // CI only. One four-vCPU runner hosts build, lint, test and typecheck at once, and vitest
        // otherwise sizes its pool from the machine's cores — five packages each doing that is what
        // starved the timing-sensitive suites elsewhere in this workspace into failing on a
        // stopwatch. See scripts/test-all.sh. Uncapped locally.
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
    },
});
