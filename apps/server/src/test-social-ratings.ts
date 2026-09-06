/**
 * Integration & unit tests for engine/social.ts (addRating, addFriend, removeFriend, setGuardian).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-social-ratings.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initStateEngine, seedGenesisMember, addRating, addFriend, removeFriend, setGuardian } from './state-engine.js';
import { db } from './db/db.js';

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

    // 2. addFriend, setGuardian, and removeFriend graph tests
    const friendRes = addFriend(alice, bob);
    assert(friendRes !== null && friendRes.publicKey === bob, 'addFriend establishes connection');

    const setGuardRes = setGuardian(alice, bob, true);
    assert(setGuardRes === true, 'setGuardian promotes friend to guardian');

    const guardRow = db.prepare("SELECT is_guardian FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(alice, bob) as { is_guardian: number } | undefined;
    assert(guardRow?.is_guardian === 1, 'is_guardian set to 1 in DB');

    const removeRes = removeFriend(alice, bob);
    assert(removeRes === true, 'removeFriend deletes friend connection');

    const tombstone = db.prepare("SELECT * FROM tombstones WHERE table_name='friends' AND row_key=?").get(`${alice}|${bob}`) as { table_name: string; row_key: string } | undefined;
    assert(tombstone !== undefined, 'removeFriend writes tombstone for deleted connection');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Social ratings and graph tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
