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
    adminSetUserStatus,
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
    // '' rather than a placeholder: every override site compares `publicKey === getAdminPubkey()`,
    // so any non-empty sentinel grants admin to whoever presents that same literal as their actor.
    assert(adminBeforeHuman === '', 'getAdminPubkey() returns an empty string — not a self-matching sentinel — when no human genesis member exists');

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
    // createTreasury(name, avatar, creditLine) — the callsign is NOT the account id. It returns a
    // freshly generated pubkey, and canOperateTreasury() is keyed on that. Asserting against the
    // callsign string made the two negative cases vacuous: they would have passed against any
    // treasury that did not exist.
    const farmPubkey = createTreasury('CommunityFarm', 'data:image/png;base64,iVBORw0KGgo=', 500).publicKey;

    assert(canOperate(alicePubkey) === true, 'real genesis admin has canOperate override');
    assert(canOperateTreasury(alicePubkey, farmPubkey) === true, 'real genesis admin has canOperateTreasury override');

    assert(canOperate('SYSTEM') === false, 'SYSTEM does not hold canOperate override');
    assert(canOperateTreasury('SYSTEM', farmPubkey) === false, 'SYSTEM does not hold canOperateTreasury override');

    const nonAdminPubkey = 'pubkey_plain_member_0003';
    assert(canOperate(nonAdminPubkey) === false, 'regular member does not hold admin canOperate override');
    assert(canOperateTreasury(nonAdminPubkey, farmPubkey) === false, 'regular member does not hold admin canOperateTreasury override');

    // 5. Admin lifecycle and status rotation (active vs pruned/disabled)
    // When founding admin Alice is disabled, getAdminPubkey() advances to Bob:
    adminSetUserStatus(alicePubkey, 'disabled');
    assert(getAdminPubkey() === bobPubkey, 'getAdminPubkey() advances to Bob when Alice is disabled');

    // When Bob is pruned as well, getAdminPubkey() returns '' (no active genesis member):
    adminSetUserStatus(bobPubkey, 'pruned');
    assert(getAdminPubkey() === '', 'getAdminPubkey() returns empty string when all genesis members are inactive');

    // When Bob is re-activated, getAdminPubkey() returns Bob:
    adminSetUserStatus(bobPubkey, 'active');
    assert(getAdminPubkey() === bobPubkey, 'getAdminPubkey() returns Bob when reactivated');

    // When Alice is also re-activated, Alice becomes admin again (deterministic rowid ordering):
    adminSetUserStatus(alicePubkey, 'active');
    assert(getAdminPubkey() === alicePubkey, 'getAdminPubkey() returns Alice again after reactivation due to rowid ordering');

    // 6. Query plan check
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT public_key FROM members WHERE invited_by = 'genesis' AND UPPER(public_key) != 'SYSTEM' AND status = 'active' ORDER BY rowid ASC LIMIT 1").all() as any[];
    assert(plan.length > 0, 'EXPLAIN QUERY PLAN succeeds for the deterministic query');
    assert(plan.some(p => (p.detail || '').includes('members')), 'EXPLAIN QUERY PLAN confirms scan across members table');

    console.log(`\nResults: ${passed}/${total} assertions passed.`);
    if (passed !== total) {
        process.exit(1);
    }
}

// Explicit exit: initStateEngine() installs periodic timers, and a suite that merely stops asserting
// still holds the event loop open — which the CI harness records as a TIMEOUT rather than a pass.
main().then(() => process.exit(process.exitCode ?? 0)).catch(err => {
    console.error('Test threw unexpected exception:', err);
    process.exit(1);
});
