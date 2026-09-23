import { defineConfig } from 'vitest/config';

/**
 * A worker cap, and nothing else.
 *
 * This package ran `vitest run` with no config file at all, and everything here other than the two
 * options below is still vitest's default — the same 21 files and 398 tests run as before.
 *
 * The cap exists because of what runs AROUND these tests on CI. One public-repo `ubuntu-latest`
 * runner has four vCPUs, and scripts/test-all.sh starts build, lint, test and typecheck on it at
 * once; `turbo run test` then fans out across eight packages, five of which are vitest, and vitest
 * sizes its worker pool from the machine's cores. Every vitest package doing that simultaneously
 * is what starved the timing-sensitive suites into failing on a stopwatch and passing on re-run.
 *
 * Local runs are uncapped: a developer machine has the cores and nothing else is competing for
 * them. See scripts/test-all.sh for the measurements this number came from.
 */
export default defineConfig({
    test: {
        minWorkers: process.env.CI ? 1 : undefined,
        maxWorkers: process.env.CI ? 2 : undefined,
    },
});
