/**
 * Community Pricing Guide & Aggregator Test Suite (#206).
 *
 * Verifies:
 * 1. Seed catalog initialization and category taxonomy
 * 2. Search and category filtering
 * 3. Custom item creation, editing, deletion, and price pinning
 * 4. Price feedback reporting and admin moderation queue
 * 5. Multiplier configuration and clamped math
 * 6. Marketplace auto-pricing feedback loop with outlier filtering & photo matching
 * 7. Admin reset to defaults
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pricing-guide.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { db, initSchema } from './db/db.js';
import {
    seedPricingGuideIfEmpty,
    getPricingGuideItems,
    getPricingGuideItem,
    savePricingGuideItem,
    deletePricingGuideItem,
    pinPricingGuideItem,
    submitPricingReport,
    getPricingReports,
    updatePricingReportStatus,
    getPricingConfig,
    updatePricingConfig,
} from './db/pricing-guide-db.js';
import { runPricingAggregationCycle } from './pricing-aggregator.js';
import { DEFAULT_PRICING_CATALOG } from '@beanpool/core';

let run = 0, passed = 0;
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
    console.log('🧪 Starting Community Beans Pricing Guide Test Suite (#206)...\n');

    initSchema();

    // 1. Seed Catalog Verification
    const allItems = getPricingGuideItems();
    assert(allItems.length >= DEFAULT_PRICING_CATALOG.length, 'Initializes and seeds full default catalog');
    const eggItem = allItems.find(i => i.id === 'fp-001');
    assert(!!eggItem, 'Finds baseline egg item');
    assert(eggItem?.priceBeans === 6 && eggItem?.category === 'food_produce', 'Egg item has expected baseline price and category');

    // 2. Category & Search Filtering
    const foodItems = getPricingGuideItems('food_produce');
    assert(foodItems.length > 0 && foodItems.every(i => i.category === 'food_produce'), 'Filters items strictly by category');

    const searchResults = getPricingGuideItems(undefined, 'Sourdough');
    assert(searchResults.length > 0 && searchResults.some(i => i.name.includes('Sourdough')), 'Searches items by keyword');

    // 3. Custom Item Management & Price Pinning
    const customItem = savePricingGuideItem({
        category: 'food_produce',
        emoji: '🫐',
        name: 'Local Organic Marionberries (500g)',
        description: 'Fresh hand-picked bush marionberries',
        priceBeans: 11,
        unit: 'punnet',
    });
    assert(!!customItem.id && customItem.name === 'Local Organic Marionberries (500g)', 'Creates custom item with generated ID');

    const fetchedCustom = getPricingGuideItem(customItem.id);
    assert(fetchedCustom?.priceBeans === 11, 'Fetches saved custom item');

    // Pin custom item
    pinPricingGuideItem(customItem.id, true);
    const pinnedCustom = getPricingGuideItem(customItem.id);
    assert(pinnedCustom?.isPinned === true, 'Pins item price successfully');

    // 4. Reporting & Moderation
    const reportId = submitPricingReport(customItem.id, 'too_low', 'Berries are rare this season', 'pubkey-test-1');
    assert(!!reportId, 'Submits price feedback report');

    const pendingReports = getPricingReports('pending');
    const foundReport = pendingReports.find(r => r.id === reportId);
    assert(!!foundReport && foundReport.reportType === 'too_low', 'Admin queries pending reports with item metadata');

    const updateStatus = updatePricingReportStatus(reportId, 'accepted');
    assert(updateStatus, 'Updates report status to accepted');
    const pendingAfter = getPricingReports('pending');
    assert(!pendingAfter.some(r => r.id === reportId), 'Report removed from pending queue');

    // 5. Pricing Configuration (Data Source & Seasonality)
    const initialConfig = getPricingConfig();
    assert(initialConfig.dataSource === 'local', 'Default data source is local');
    assert(initialConfig.showSeasonality === true, 'Default seasonality toggle is true');

    const updatedConfig = updatePricingConfig({ dataSource: 'federation', showSeasonality: false });
    assert(updatedConfig.dataSource === 'federation', 'Updates data source to federation');
    assert(updatedConfig.showSeasonality === false, 'Updates seasonality toggle to false');

    // 6. Marketplace Feedback Loop & Outlier Filtering
    // Insert mock marketplace posts matching 'babysitting'
    const insertMember = db.prepare(`
        INSERT OR IGNORE INTO members (public_key, callsign) VALUES ('author-1', 'Alice')
    `);
    insertMember.run();

    const insertPost = db.prepare(`
        INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active)
        VALUES (?, 'offer', 'labour_services', ?, ?, ?, 'author-1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1)
    `);

    insertPost.run('post-mock-1', 'Babysitting and childcare', 'Weekend evening babysitting', 20);
    insertPost.run('post-mock-2', 'Babysitting after school', 'Friendly babysitting', 22);
    insertPost.run('post-mock-3', 'Babysitting per hour', 'High school babysitting', 24);
    insertPost.run('post-mock-4', 'Babysitting joke post', 'Joke post 999 beans', 999); // Outlier (>5x)

    const aggResult = runPricingAggregationCycle();
    assert(aggResult.updatedCount > 0, 'Runs auto-pricing aggregation cycle across catalog');

    const babyItem = getPricingGuideItems('labour_services').find(i => i.id === 'ls-001');
    assert(!!babyItem, 'Finds babysitting guide item');
    assert(babyItem?.confidenceCount === 3, 'Counts 3 valid listings (ignoring 999 outlier)');
    assert(babyItem?.priceBeans === 22, 'Calculates trimmed average price (22 beans)');
    assert(babyItem?.trend === 'up', 'Flags trend as up from baseline 18');

    // Clean up custom item & reset catalog
    deletePricingGuideItem(customItem.id);
    assert(getPricingGuideItem(customItem.id) === null, 'Deletes item from catalog');

    seedPricingGuideIfEmpty(true);
    const resetCount = getPricingGuideItems().length;
    assert(resetCount === DEFAULT_PRICING_CATALOG.length, 'Resets catalog to pristine defaults');

    console.log(`\n🎉 Community Beans Pricing Guide Test Summary: ${passed}/${run} assertions passed.\n`);
    if (passed !== run) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
