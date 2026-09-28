/**
 * Community Pricing Guide & Aggregator Test Suite (#206).
 *
 * Verifies:
 * 1. Seed catalog initialization and category taxonomy
 * 2. Search and category filtering
 * 3. Custom item creation, editing, deletion, and price pinning
 * 4. Price feedback reporting and admin moderation queue
 * 4b. What reports may add in a day (PRICE_REPORT_RULES, #1295 review 4126894855): a member's 20, the rest (anonymous, or
 *     a key that isn't a member's) 20 an address and 200 the node; the rest pruned after a month with no tombstone; only
 *     a member's travel to a standby
 * 5. Multiplier configuration and clamped math
 * 6. Marketplace auto-pricing feedback loop with outlier filtering & photo matching
 * 7. Admin reset to defaults: a tombstone for each member's report, none for the rest
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
    PRICE_REPORT_RULES,
} from './db/pricing-guide-db.js';
import { travellingRows } from './engine/replication-manifest.js';
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
    assert(eggItem?.priceBeans === 6 && eggItem?.category === 'food', 'Egg item has expected baseline price and category');

    // 2. Category & Search Filtering
    const foodItems = getPricingGuideItems('food');
    assert(foodItems.length > 0 && foodItems.every(i => i.category === 'food'), 'Filters items strictly by category');

    const searchResults = getPricingGuideItems(undefined, 'Sourdough');
    assert(searchResults.length > 0 && searchResults.some(i => i.name.includes('Sourdough')), 'Searches items by keyword');

    // 3. Custom Item Management & Price Pinning
    const customItem = savePricingGuideItem({
        category: 'food',
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
    const submitted = submitPricingReport(customItem.id, 'too_low', 'Berries are rare this season', 'pubkey-test-1');
    assert('id' in submitted && !!submitted.id, 'Submits price feedback report');
    const reportId = 'id' in submitted ? submitted.id : '';

    const pendingReports = getPricingReports('pending');
    const foundReport = pendingReports.find(r => r.id === reportId);
    assert(!!foundReport && foundReport.reportType === 'too_low', 'Admin queries pending reports with item metadata');

    const updateStatus = updatePricingReportStatus(reportId, 'accepted');
    assert(updateStatus, 'Updates report status to accepted');
    const pendingAfter = getPricingReports('pending');
    assert(!pendingAfter.some(r => r.id === reportId), 'Report removed from pending queue');

    // 4b. What reports may add in a day
    const { memberPerDay, otherPerAddressPerDay, otherPerNodePerDay, otherKeptDays } = PRICE_REPORT_RULES;
    db.prepare(`INSERT INTO members (public_key, callsign, status, is_visitor) VALUES ('pubkey-member', 'Mia', 'active', 0),
        ('pubkey-visitor', 'Vic', 'active', 1)`).run();
    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const report = (reporter?: string, address?: string) => submitPricingReport(customItem.id, 'too_high', 'Cheaper at the market', reporter, address ? () => address : null);
    const refusedAs = (r: ReturnType<typeof report>) => ('refused' in r ? r.refused : 'taken');
    const mia: string[] = [];
    for (let i = 0; i < memberPerDay; i++) mia.push(refusedAs(report('pubkey-member', 'addr-mia')));
    assert(mia.every((r) => r === 'taken'), `a member sends ${memberPerDay} reports in a day (${[...new Set(mia)].join(', ')})`);
    assert(refusedAs(report('pubkey-member', 'addr-mia')) === 'member_rate_limited', `the member's ${memberPerDay + 1}st that day is refused, member_rate_limited`);
    assert(count(`SELECT COUNT(*) AS n FROM writes_by_address WHERE ip_hash = 'addr-mia'`) === 0, "a member's reports are counted by their key, never by address");
    const reporterPlan = (db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM pricing_reports WHERE reporter_pubkey = ?
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`).all('pubkey-member') as { detail: string }[]).map((r) => r.detail).join('; ');
    assert(/USING (COVERING )?INDEX idx_pricing_reports_reporter/.test(reporterPlan), `the member's day is a search on idx_pricing_reports_reporter (${reporterPlan})`);
    const fromA: string[] = [];
    for (let i = 0; i < otherPerAddressPerDay; i++) fromA.push(refusedAs(report(i % 3 === 0 ? undefined : i % 3 === 1 ? 'pubkey-visitor' : `stranger-${i}`, 'addr-a')));
    assert(fromA.every((r) => r === 'taken'), `${otherPerAddressPerDay} reports from one address with no member's key (anonymous, a visitor's, strangers') are taken (${[...new Set(fromA)].join(', ')})`);
    assert(refusedAs(report(undefined, 'addr-a')) === 'rate_limited' && refusedAs(report('pubkey-visitor', 'addr-a')) === 'rate_limited',
        "the address's next is refused, rate_limited, anonymous or signed by a key that isn't a member's");
    assert(refusedAs(report(undefined, 'addr-b')) === 'taken' && refusedAs(report('pubkey-member', 'addr-a')) === 'member_rate_limited',
        "another address still sends one; the member's are counted as theirs, not the address's");
    // The node's day: every address together. An address costs nothing (an IPv6 /48 is 65,536 /64s).
    let filled = count(`SELECT COUNT(*) AS n FROM writes_by_address WHERE kind = 'price_report'`);
    for (let i = 0; filled < otherPerNodePerDay; i++, filled++) {
        const r = refusedAs(report(undefined, `addr-far-${i}`));
        if (r !== 'taken') throw new Error(`the node's day filled early, at ${filled}: ${r}`);
    }
    assert(refusedAs(report(undefined, 'addr-new')) === 'busy', `past ${otherPerNodePerDay} reports with no member's key on the node today, from any address, one more is refused, busy`);
    const newMember = 'pubkey-member-2';
    db.prepare(`INSERT INTO members (public_key, callsign, status) VALUES (?, 'Nel', 'active')`).run(newMember);
    assert(refusedAs(report(newMember, 'addr-new')) === 'taken', "and a member's report is still taken");
    // Which travel: a member's only (engine/replication-manifest.ts MEMBERS_REPORTS), never NULL for an anonymous one.
    const rule = travellingRows('pricing_reports');
    const travelling = count(`SELECT COUNT(*) AS n FROM pricing_reports WHERE ${rule}`);
    const staying = count(`SELECT COUNT(*) AS n FROM pricing_reports WHERE NOT (${rule})`);
    const all = count('SELECT COUNT(*) AS n FROM pricing_reports');
    assert(travelling === memberPerDay + 1 && travelling + staying === all,
        `only members' reports travel to a standby (${travelling} of ${all}); the anonymous, visitors' and strangers' ones stay here (${staying})`);
    // A month on, the reports with no member's key go as the next such report comes, with no tombstone; a member's stay.
    db.prepare(`UPDATE pricing_reports SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).run(`-${otherKeptDays + 1} days`);
    db.prepare(`DELETE FROM writes_by_address`).run();
    const tombstonesBefore = count(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'pricing_reports'`);
    assert(refusedAs(report(undefined, 'addr-c')) === 'taken', 'an anonymous report a month later');
    assert(count(`SELECT COUNT(*) AS n FROM pricing_reports WHERE NOT (${rule})`) === 1 && count(`SELECT COUNT(*) AS n FROM pricing_reports WHERE ${rule}`) === travelling,
        `prunes the ${staying} month-old reports with no member's key, and keeps the members' however old`);
    assert(count(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'pricing_reports'`) === tombstonesBefore, 'with no tombstone: they never travelled');
    const prunePlan = (db.prepare(`EXPLAIN QUERY PLAN DELETE FROM pricing_reports WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AND NOT (${rule})`)
        .all() as { detail: string }[]).map((r) => r.detail).join('; ');
    assert(/SEARCH pricing_reports USING INDEX idx_pricing_reports_created/.test(prunePlan) && !/SCAN pricing_reports/.test(prunePlan),
        `the prune runs at each such report, so it searches idx_pricing_reports_created, never scans the table (${prunePlan})`);

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
        VALUES (?, 'offer', 'care', ?, ?, ?, 'author-1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1)
    `);

    insertPost.run('post-mock-1', 'Babysitting and childcare', 'Weekend evening babysitting', 20);
    insertPost.run('post-mock-2', 'Babysitting after school', 'Friendly babysitting', 22);
    insertPost.run('post-mock-3', 'Babysitting per hour', 'High school babysitting', 24);
    insertPost.run('post-mock-4', 'Babysitting joke post', 'Joke post 999 beans', 999); // Outlier (>5x)

    const aggResult = runPricingAggregationCycle();
    assert(aggResult.updatedCount > 0, 'Runs auto-pricing aggregation cycle across catalog');

    const babyItem = getPricingGuideItems('care').find(i => i.id === 'ls-001');
    assert(!!babyItem, 'Finds babysitting guide item');
    assert(babyItem?.confidenceCount === 3, 'Counts 3 valid listings (ignoring 999 outlier)');
    assert(babyItem?.priceBeans === 22, 'Calculates trimmed average price (22 beans)');
    assert(babyItem?.trend === 'up', 'Flags trend as up from baseline 18');

    // Clean up custom item & reset catalog
    deletePricingGuideItem(customItem.id);
    assert(getPricingGuideItem(customItem.id) === null, 'Deletes item from catalog');

    // The custom item's delete took its reports: a tombstone for each member's, none for the rest.
    const reportTombstones = count(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'pricing_reports'`);
    assert(reportTombstones === tombstonesBefore + travelling, `deleting an item writes a tombstone for each member's report on it and none for the rest (${reportTombstones - tombstonesBefore} of ${travelling + 1})`);
    report(); // one more anonymous report, on an item the reset keeps
    db.prepare(`UPDATE pricing_reports SET item_id = 'fp-001'`).run();
    seedPricingGuideIfEmpty(true);
    const resetCount = getPricingGuideItems().length;
    assert(resetCount === DEFAULT_PRICING_CATALOG.length, 'Resets catalog to pristine defaults');
    assert(count('SELECT COUNT(*) AS n FROM pricing_reports') === 0
        && count(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'pricing_reports'`) === reportTombstones,
        "the reset deletes every report, and writes no tombstone for one with no member's key");

    console.log(`\n🎉 Community Beans Pricing Guide Test Summary: ${passed}/${run} assertions passed.\n`);
    if (passed !== run) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
