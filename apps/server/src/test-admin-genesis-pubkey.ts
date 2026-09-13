/**
 * Regression test for getAdminPubkey() SYSTEM exclusion and deterministic resolution.
 *
 * Background:
 *   initStateEngine() seeds ('SYSTEM', 'System', 'genesis', 'genesis') into the members table
 *   on initial node boot. Previously, getAdminPubkey() ran:
 *     SELECT public_key FROM members WHERE invited_by = 'genesis' LIMIT 1
 *   without an ORDER BY clause. Because members(invited_by) is not indexed, SQLite performed
 *   a table scan and returned rowid 2 ('SYSTEM') even after real human genesis members were
 *   seeded. Consequently, every `publicKey === getAdminPubkey()` override check silently failed.
 *
 * This suite verifies:
 *   1. On a fresh node before any human member exists, getAdminPubkey() does NOT return 'SYSTEM'.
 *   2. Once a human genesis member is seeded, getAdminPubkey() returns their public key.
 *   3. When multiple genesis members exist, getAdminPubkey() deterministically returns the
 *      first-seeded genesis member (ORDER BY rowid ASC).
 *   4. Admin override capabilities (canOperate, canOperateTreasury) succeed for the real genesis
 *      pubkey and fail for 'SYSTEM'.
 */

import {
    initStateEngine,
    getAdminPubkey,
    seedGenesisMember,
    canOperate,
    canOperateTreasury,
    createTreasury,
} from './state-engine.js';
import { db } from './db/db.js';

let total = 0;
let passed = 0;

function assert(cond: boolean, msg: string) {
    total++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

async function main() {
    console.log('Running test-admin-genesis-pubkey suite...\n');

    initStateEngine();

    // 1. Fresh node state immediately after initStateEngine()
    const systemRow = db.prepare("SELECT rowid, public_key, invited_by FROM members WHERE public_key = 'SYSTEM'").get() as any;
    assert(!!systemRow, 'SYSTEM member exists in members table');
    assert(systemRow.invited_by === 'genesis', 'SYSTEM member has invited_by = genesis');

    const adminBeforeHuman = getAdminPubkey();
    assert(adminBeforeHuman !== 'SYSTEM', 'getAdminPubkey() must NEVER return SYSTEM placeholder');
    assert(adminBeforeHuman === 'system', 'getAdminPubkey() returns fallback system when no human genesis member exists');

    // 2. Seed first human genesis member
    const alicePubkey = 'pubkey_alice_genesis_0001';
    seedGenesisMember(alicePubkey, 'Alice');

    const adminAfterAlice = getAdminPubkey();
    assert(adminAfterAlice === alicePubkey, 'getAdminPubkey() returns the first human genesis member (Alice)');
    assert(adminAfterAlice !== 'SYSTEM', 'getAdminPubkey() does not return SYSTEM after seeding Alice');

    // 3. Seed second human genesis member
    const bobPubkey = 'pubkey_bob_genesis_0002';
    seedGenesisMember(bobPubkey, 'Bob');

    const adminAfterBob = getAdminPubkey();
    assert(adminAfterBob === alicePubkey, 'getAdminPubkey() deterministically picks first-seeded genesis member (Alice) via ORDER BY rowid ASC');

    // 4. Admin override checks
    createTreasury('treasury_community_farm', 'Community Farm', 'pubkey_random_creator', 500);

    assert(canOperate(alicePubkey) === true, 'real genesis admin has canOperate override');
    assert(canOperateTreasury(alicePubkey, 'treasury_community_farm') === true, 'real genesis admin has canOperateTreasury override');

    assert(canOperate('SYSTEM') === false, 'SYSTEM does not hold canOperate override');
    assert(canOperateTreasury('SYSTEM', 'treasury_community_farm') === false, 'SYSTEM does not hold canOperateTreasury override');

    const nonAdminPubkey = 'pubkey_plain_member_0003';
    assert(canOperate(nonAdminPubkey) === false, 'regular member does not hold admin canOperate override');
    assert(canOperateTreasury(nonAdminPubkey, 'treasury_community_farm') === false, 'regular member does not hold admin canOperateTreasury override');

    // 5. Query plan check
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT public_key FROM members WHERE invited_by = 'genesis' AND public_key != 'SYSTEM' ORDER BY rowid ASC LIMIT 1").all();
    assert(plan.length > 0, 'EXPLAIN QUERY PLAN succeeds for the deterministic query');

    console.log(`\nResults: ${passed}/${total} assertions passed.`);
    if (passed !== total) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test threw unexpected exception:', err);
    process.exit(1);
});
