/**
 * Living Activity Waterfall Test Suite (#208).
 *
 * Verifies:
 * 1. Activity feed schema creation
 * 2. Recording events (member_joined, post_created, trade_completed, rating_given)
 * 3. Querying feed with actor & target callsign joins
 * 4. Pagination and metadata extraction
 * 5. Retention pruning
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-activity-feed.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { db, initSchema } from './db/db.js';
import {
    recordActivity,
    getActivityFeed,
    pruneOldActivity,
} from './db/activity-feed-db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg}`);
        process.exit(1);
    }
}

async function main() {
    console.log('🧪 Starting Living Activity Waterfall Test Suite (#208)...\n');

    initSchema();

    // 1. Setup mock members
    db.prepare(`
        INSERT OR IGNORE INTO members (public_key, callsign) 
        VALUES ('pubkey-alice', 'Alice'), ('pubkey-bob', 'Bob')
    `).run();

    // 2. Initial empty feed
    const initialFeed = getActivityFeed();
    assert(Array.isArray(initialFeed), 'Feed is an array');

    // 3. Record member_joined event
    const id1 = recordActivity('member_joined', 'pubkey-alice', null, { callsign: 'Alice' });
    assert(id1 > 0, 'Records member_joined event and returns row ID');

    // 4. Record post_created event
    const id2 = recordActivity('post_created', 'pubkey-alice', null, {
        postId: 'post-1',
        title: 'Fresh Organic Eggs',
        type: 'offer',
        category: 'food_produce',
        credits: 6
    });
    assert(id2 > id1, 'Records post_created event with metadata');

    // 5. Record trade_completed event
    const id3 = recordActivity('trade_completed', 'pubkey-alice', 'pubkey-bob', {
        postId: 'post-1',
        postTitle: 'Fresh Organic Eggs',
        credits: 6,
        transactionId: 'tx-1'
    });
    assert(id3 > id2, 'Records trade_completed event between actor and target');

    // 6. Record rating_given event
    const id4 = recordActivity('rating_given', 'pubkey-bob', 'pubkey-alice', {
        stars: 5,
        comment: 'Delicious eggs!',
        transactionId: 'tx-1'
    });
    assert(id4 > id3, 'Records rating_given event');

    // 7. Query feed and verify joins
    const feed = getActivityFeed(10, 0);
    assert(feed.length >= 4, 'Retrieves all recorded events');

    // Latest event should be rating_given by Bob to Alice
    const latest = feed[0];
    assert(latest.eventType === 'rating_given', 'Latest event is rating_given');
    assert(latest.actorCallsign === 'Bob', 'Actor callsign joined as Bob');
    assert(latest.targetCallsign === 'Alice', 'Target callsign joined as Alice');
    assert(latest.metadata?.stars === 5, 'Metadata JSON parsed correctly');

    // Second latest should be trade_completed
    const tradeEvent = feed.find(e => e.eventType === 'trade_completed');
    assert(!!tradeEvent, 'Finds trade_completed event');
    assert(tradeEvent?.actorCallsign === 'Alice', 'Trade actor is Alice');
    assert(tradeEvent?.targetCallsign === 'Bob', 'Trade target is Bob');
    assert(tradeEvent?.metadata?.credits === 6, 'Trade metadata credits is 6');

    // Third latest should be post_created
    const postEvent = feed.find(e => e.eventType === 'post_created');
    assert(!!postEvent, 'Finds post_created event');
    assert(postEvent?.metadata?.title === 'Fresh Organic Eggs', 'Post title preserved');

    // Fourth latest should be member_joined
    const joinEvent = feed.find(e => e.eventType === 'member_joined');
    assert(!!joinEvent, 'Finds member_joined event');
    assert(joinEvent?.actorCallsign === 'Alice', 'Join actor is Alice');

    // 8. Pagination
    const page1 = getActivityFeed(2, 0);
    const page2 = getActivityFeed(2, 2);
    assert(page1.length === 2, 'Page 1 limit 2 returns 2 items');
    assert(page2.length >= 2, 'Page 2 offset 2 returns next items');
    assert(page1[0].id !== page2[0].id, 'Page 1 and Page 2 contain distinct items');

    // 9. Pruning old records
    // Insert an artificially aged event (60 days old)
    db.prepare(`
        INSERT INTO activity_feed (event_type, actor_pubkey, created_at)
        VALUES ('member_joined', 'pubkey-old', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days'))
    `).run();

    const pruned = pruneOldActivity(30);
    assert(pruned === 1, 'Prunes 1 event older than 30 days');

    console.log(`\n🎉 Living Activity Waterfall Test Summary: ${passed}/${run} assertions passed.\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed with uncaught exception:', err);
    process.exit(1);
});
