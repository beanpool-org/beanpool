/**
 * Integration & unit tests for engine/social.ts (addRating, getRatings, addFriend, removeFriend, setGuardian).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-social-ratings.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initStateEngine, seedGenesisMember, addRating, addFriend, removeFriend, getRatings } from './state-engine.js';
import { db } from './db/db.js';
import { createCommunityRoutes } from './routes/community.js';
import { bootInto, indexes, tmp } from './schema-upgrade-test-harness.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running social ratings and friend graph tests...\n');

    initStateEngine();

    const alice = 'pubkey_alice_social_1';
    const bob = 'pubkey_bob_social_2';
    const charlie = 'pubkey_charlie_social_3';

    seedGenesisMember(alice, 'alice');
    seedGenesisMember(bob, 'bob');
    seedGenesisMember(charlie, 'charlie');

    // 1. addRating tests
    // Edge case: invalid star values (< 1 or > 5)
    assert(addRating(alice, bob, 0, 'Bad stars', 'tx1') === null, 'addRating rejects stars < 1');
    assert(addRating(alice, bob, 6, 'Bad stars', 'tx1') === null, 'addRating rejects stars > 5');

    // Edge case: rating oneself
    assert(addRating(alice, alice, 5, 'Self rating', 'tx1') === null, 'addRating rejects self-rating');

    // Edge case: transaction not completed or non-existent
    assert(addRating(alice, bob, 5, 'No tx', 'tx_nonexistent') === null, 'addRating rejects missing transaction');

    // Seed marketplace transaction and post (type: offer)
    const txIdOffer = 'tx_offer_100';
    const postIdOffer = 'post_offer_100';
    db.prepare(`INSERT INTO posts (id, author_pubkey, title, description, type, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        postIdOffer, alice, 'Selling goods', 'Offer post description', 'offer', 'goods', new Date().toISOString()
    );
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        txIdOffer, postIdOffer, bob, alice, 50, 'completed', new Date().toISOString()
    );

    // Bob (buyer) rates Alice (seller). For 'offer', seller is provider, buyer is receiver. Target Alice role = 'provider'.
    const rating1 = addRating(bob, alice, 5, 'Great seller!', txIdOffer);
    assert(rating1 !== null, 'addRating succeeds for valid completed transaction');
    assert(rating1?.stars === 5, 'Rating stars matched');
    assert(rating1?.role === 'provider', 'Target role determined correctly as provider for offer post');

    // Rating UPSERT: Bob updates rating for txIdOffer
    const rating1Updated = addRating(bob, alice, 4, 'Updated comment', txIdOffer);
    assert(rating1Updated !== null && rating1Updated.id === rating1?.id, 'addRating upserts existing rating row');
    assert(rating1Updated?.stars === 4, 'Rating updated stars matched');
    assert(rating1Updated?.comment === 'Updated comment', 'Rating updated comment matched');

    // Seed marketplace transaction and post (type: seek)
    const txIdSeek = 'tx_seek_200';
    const postIdSeek = 'post_seek_200';
    db.prepare(`INSERT INTO posts (id, author_pubkey, title, description, type, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        postIdSeek, alice, 'Seeking help', 'Seek post description', 'seek', 'services', new Date().toISOString()
    );
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        txIdSeek, postIdSeek, alice, bob, 30, 'completed', new Date().toISOString()
    );

    // Alice (buyer/poster seeking help) rates Bob (seller/fulfiller). For 'seek', seller is receiver, buyer is provider. Target Bob role = 'receiver'.
    const rating2 = addRating(alice, bob, 5, 'Great help!', txIdSeek);
    assert(rating2 !== null && rating2.role === 'receiver', 'Target role determined correctly as receiver for seek post');

    // 2. addFriend and removeFriend graph tests
    const friendRes = addFriend(alice, bob);
    assert(friendRes !== null && friendRes.publicKey === bob, 'addFriend establishes connection');

    const removeRes = removeFriend(alice, bob);
    assert(removeRes === true, 'removeFriend deletes friend connection');

    const tombstone = db.prepare("SELECT * FROM tombstones WHERE table_name='friends' AND row_key=?").get(`${alice}|${bob}`) as { table_name: string; row_key: string } | undefined;
    assert(tombstone !== undefined, 'removeFriend writes tombstone for deleted connection');

    // 3. HTTP route authorization tests for POST /api/ratings
    const router = createCommunityRoutes({
        checkAdminAuth: async () => true,
        rateLimit: () => true,
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    });

    const dispatch = async (method: string, path: string, ctx: any) => {
        ctx.method = method;
        ctx.path = path;
        ctx.url = path;
        ctx.request = ctx.request || {};
        ctx.state = ctx.state || {};
        const middleware = router.routes();
        await middleware(ctx, async () => {});
        return ctx;
    };

    // Unsigned request returns 401
    const unauthCtx: any = { requestBody: { targetPubkey: alice, stars: 5, transactionId: txIdOffer } };
    await dispatch('POST', '/api/ratings', unauthCtx);
    assert(unauthCtx.status === 401, 'POST /api/ratings without ctx.state.actor returns 401');

    // Mismatched raterPubkey returns 403
    const spoofCtx: any = {
        state: { actor: bob },
        requestBody: { raterPubkey: charlie, targetPubkey: alice, stars: 5, transactionId: txIdOffer }
    };
    await dispatch('POST', '/api/ratings', spoofCtx);
    assert(spoofCtx.status === 403, 'POST /api/ratings with mismatched raterPubkey returns 403');

    // Signed request with active actor succeeds
    const validCtx: any = {
        state: { actor: bob },
        requestBody: { raterPubkey: bob, targetPubkey: alice, stars: 5, comment: 'Route test', transactionId: txIdOffer }
    };
    await dispatch('POST', '/api/ratings', validCtx);
    assert(validCtx.body?.success === true, 'POST /api/ratings with valid actor succeeds');

    // 4. Every trust floor reads a member's ratings by target_pubkey (trust.ts), and so do getRatings and
    // getAverageRating (social.ts). Without an index each read scanned the whole table: 0.60 ms of a 0.71 ms floor at
    // 17,585 ratings (#1793's review, finding 1).
    const floorRead = 'SELECT AVG(stars) as avg, COUNT(*) as cnt FROM ratings WHERE target_pubkey = ?';
    const plan = (conn: Database.Database) =>
        (conn.prepare(`EXPLAIN QUERY PLAN ${floorRead}`).all('x') as { detail: string }[]).map(r => r.detail).join(' | ');
    assert(indexes(db, 'ratings').includes('idx_ratings_target_pubkey'), 'a fresh database has idx_ratings_target_pubkey');
    assert(/SEARCH ratings USING (COVERING )?INDEX idx_ratings_target_pubkey/.test(plan(db)) && !/SCAN ratings/.test(plan(db)),
        `a floor's ratings read searches by index, not a scan (${plan(db)})`);

    // 5. getRatings lists the newest first, and ratings stamped in the same millisecond newest row first. With the
    // index above the planner sorts after a search by target_pubkey, so an untied ORDER BY created_at DESC gave ties
    // oldest row first, where walking idx_ratings_created_at backwards had given newest first (#1813's review, finding 1).
    const dave = 'pubkey_dave_social_4';
    seedGenesisMember(dave, 'dave');
    const tie = '2026-10-12T09:00:00.000Z';
    const insertRating = db.prepare(`INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars, created_at) VALUES (?, ?, ?, 'provider', 5, ?)`);
    insertRating.run('tie-c', dave, alice, tie);
    insertRating.run('tie-a', dave, bob, tie);
    insertRating.run('tie-b', dave, charlie, tie);
    insertRating.run('earlier', dave, bob, '2026-10-12T08:59:59.999Z');
    const order = getRatings(dave).map(r => r.id).join(',');
    assert(order === 'tie-b,tie-a,tie-c,earlier', `same-millisecond ratings come newest row first (${order})`);

    // An old node: its database as the last boot left it, without the index, with ratings in it. The next boot builds it.
    const dir = tmp('ratings-index');
    try {
        const first = bootInto(dir);
        assert(first.ok, `a fresh data dir boots${first.ok ? '' : `: ${first.output.slice(-400)}`}`);
        const old = new Database(path.join(dir, 'state.db'));
        old.pragma('foreign_keys = OFF'); // two rating rows; their members needn't exist for a query plan and an average
        old.exec('DROP INDEX IF EXISTS idx_ratings_target_pubkey');
        old.prepare(`INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars) VALUES ('r1', 'm1', 'm2', 'provider', 4), ('r2', 'm1', 'm3', 'provider', 5)`).run();
        const before = plan(old);
        old.close();
        assert(/SCAN ratings/.test(before), `the old database scans ratings (${before})`);
        const again = bootInto(dir);
        assert(again.ok, `the old database boots${again.ok ? '' : `: ${again.output.slice(-400)}`}`);
        const upgraded = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(indexes(upgraded, 'ratings').includes('idx_ratings_target_pubkey'), 'the boot built idx_ratings_target_pubkey on the old database');
        assert(/SEARCH ratings USING (COVERING )?INDEX idx_ratings_target_pubkey/.test(plan(upgraded)), `the old database now searches by index (${plan(upgraded)})`);
        const row = upgraded.prepare(floorRead).get('m1') as { avg: number; cnt: number };
        assert(row.cnt === 2 && row.avg === 4.5, `its ratings are intact (${row.cnt} at ${row.avg})`);
        upgraded.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Social ratings and graph tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
