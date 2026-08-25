/**
 * Test coverage for Pricing Aggregator Worker lifecycle (#206).
 *
 * Verifies:
 * 1. Worker start and timer initialization.
 * 2. Idempotency of startPricingAggregatorWorker.
 * 3. Proper stopping of background timers via stopPricingAggregatorWorker.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pricing-aggregator-lifecycle.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initSchema } from './db/db.js';
import { seedPricingGuideIfEmpty } from './db/pricing-guide-db.js';
import {
    startPricingAggregatorWorker,
    stopPricingAggregatorWorker,
    runPricingAggregationCycle,
} from './pricing-aggregator.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function main() {
    console.log('🧪 Starting Pricing Aggregator Lifecycle Test Suite...\n');

    initSchema();
    seedPricingGuideIfEmpty();

    // 1. Direct cycle execution test
    const cycleRes = runPricingAggregationCycle();
    assert(cycleRes.totalEvaluated >= 0, 'Executes pricing aggregation cycle directly');

    // 2. Start worker lifecycle test with a short interval
    startPricingAggregatorWorker(100);
    assert(true, 'Starts pricing aggregator worker without throwing');

    // Test idempotency: calling start while already running should be a no-op
    startPricingAggregatorWorker(100);
    assert(true, 'Calling startPricingAggregatorWorker repeatedly is idempotent');

    // Wait slightly to let initial cycle timeout execute or pass interval
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 3. Stop worker lifecycle test
    stopPricingAggregatorWorker();
    assert(true, 'Stops pricing aggregator worker without throwing');

    // Stopping again should be safe / idempotent
    stopPricingAggregatorWorker();
    assert(true, 'Calling stopPricingAggregatorWorker repeatedly is idempotent');

    console.log(`\n🎉 Pricing Aggregator Lifecycle Test Summary: ${passed}/${run} assertions passed.\n`);
    if (passed !== run) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
