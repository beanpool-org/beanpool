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
 *   4. Admin override capabilities succeed for the real genesis pubkey and fail for 'SYSTEM'
 *      and empty string '' (both on a node with no genesis member and on a node with one).
 */

import {
    initStateEngine,
    getAdminPubkey,
    isAdminPubkey,
    seedGenesisMember,
    isNodeOwner,
    isNodeAdmin,
    nodeRoleOf,
    getFirstNodeAdminPubkey,
    canOperate,
    canOperateTreasury,
    canVouch,
    keeperOf,
    hasListedOffer,
    hasLiveOffer,
    liveOfferCount,
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
    console.log('Running test-admin-genesis-pubkey suite with explicit node_roles...\n');

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

    // SYSTEM is never in node_roles
    const systemRole = db.prepare("SELECT * FROM node_roles WHERE member_pubkey = 'SYSTEM'").get();
    assert(!systemRole, 'SYSTEM is NEVER inserted into node_roles');
    assert(isNodeAdmin('SYSTEM') === false, 'SYSTEM does NOT have isNodeAdmin');
    assert(isNodeOwner('SYSTEM') === false, 'SYSTEM does NOT have isNodeOwner');
    assert(nodeRoleOf('SYSTEM') === null, 'SYSTEM has nodeRoleOf = null');

    const firstAdminBeforeHuman = getFirstNodeAdminPubkey();
    assert(firstAdminBeforeHuman === '', 'getFirstNodeAdminPubkey() returns empty string when no human admin exists');

    // Negative assertions for empty actor string on a fresh node (no human genesis member):
    const initialTreasuryRow = db.prepare("SELECT public_key FROM members WHERE is_treasury = 1 LIMIT 1").get() as any;
    const initialTreasury = initialTreasuryRow?.public_key || 'test_initial_treasury';
    assert(canOperate('') === false, "canOperate('') must NOT grant admin override when no active admin exists");
    assert(canOperateTreasury('', initialTreasury) === false, "canOperateTreasury('') must NOT grant admin override when no active admin exists");
    assert(canVouch('') === false, "canVouch('') must NOT grant vouch override when no active admin exists");
    assert(keeperOf('').length === 0, "keeperOf('') must return empty array when no active admin exists");
    assert(hasListedOffer('') === false, "hasListedOffer('') must return false when no active admin exists");
    assert(hasLiveOffer('') === false, "hasLiveOffer('') must return false when no active admin exists");
    assert(liveOfferCount('') === 0, "liveOfferCount('') must return 0 when no active admin exists");
    assert(isAdminPubkey('') === false, "isAdminPubkey('') must return false when no active admin exists");

    // 2. Seed first human genesis member
    const alicePubkey = 'pubkey_alice_genesis_0001';
    seedGenesisMember(alicePubkey, 'Alice');

    const adminAfterAlice = getFirstNodeAdminPubkey();
    assert(adminAfterAlice === alicePubkey, 'getFirstNodeAdminPubkey() returns Alice');
    assert(isNodeOwner(alicePubkey) === true, 'Alice has isNodeOwner = true');
    assert(isNodeAdmin(alicePubkey) === true, 'Alice has isNodeAdmin = true');
    assert(nodeRoleOf(alicePubkey) === 'owner', "Alice has nodeRoleOf = 'owner'");

    // 3. Seed second human genesis member
    const bobPubkey = 'pubkey_bob_genesis_0002';
    seedGenesisMember(bobPubkey, 'Bob');

    assert(isNodeOwner(bobPubkey) === true, 'Bob also receives owner role as genesis member');
    const adminAfterBob = getFirstNodeAdminPubkey();
    assert(adminAfterBob === alicePubkey, 'getFirstNodeAdminPubkey() deterministically picks first-seeded genesis member (Alice)');

    // 4. Admin override checks
    const farmPubkey = createTreasury('CommunityFarm', 'data:image/png;base64,iVBORw0KGgo=', 500).publicKey;

    assert(canOperate(alicePubkey) === true, 'real genesis admin has canOperate override');
    assert(canOperateTreasury(alicePubkey, farmPubkey) === true, 'real genesis admin has canOperateTreasury override');
    assert(canVouch(alicePubkey) === true, 'real genesis admin has canVouch override');
    assert(keeperOf(alicePubkey).includes(farmPubkey), 'real genesis admin has keeperOf override');
    assert(hasListedOffer(alicePubkey) === true, 'real genesis admin has hasListedOffer override');
    assert(hasLiveOffer(alicePubkey) === true, 'real genesis admin has hasLiveOffer override');
    assert(liveOfferCount(alicePubkey) > 0, 'real genesis admin has liveOfferCount override');
    assert(isAdminPubkey(alicePubkey) === true, 'real genesis admin is recognized by isAdminPubkey');

    assert(canOperate('SYSTEM') === false, 'SYSTEM does not hold canOperate override');
    assert(canOperateTreasury('SYSTEM', farmPubkey) === false, 'SYSTEM does not hold canOperateTreasury override');

    const nonAdminPubkey = 'pubkey_plain_member_0003';
    assert(canOperate(nonAdminPubkey) === false, 'regular member does not hold admin canOperate override');
    assert(canOperateTreasury(nonAdminPubkey, farmPubkey) === false, 'regular member does not hold admin canOperateTreasury override');

    // Negative assertions for empty actor string on a node WITH an active genesis member:
    assert(canOperate('') === false, "canOperate('') must NOT grant admin override when an active admin exists");
    assert(canOperateTreasury('', farmPubkey) === false, "canOperateTreasury('') must NOT grant admin override when an active admin exists");
    assert(canVouch('') === false, "canVouch('') must NOT grant vouch override when an active admin exists");
    assert(keeperOf('').length === 0, "keeperOf('') must return empty array when an active admin exists");
    assert(hasListedOffer('') === false, "hasListedOffer('') must return false when an active admin exists");
    assert(hasLiveOffer('') === false, "hasLiveOffer('') must return false when an active admin exists");
    assert(liveOfferCount('') === 0, "liveOfferCount('') must return 0 when an active admin exists");
    assert(isAdminPubkey('') === false, "isAdminPubkey('') must return false when an active admin exists");

    // 5. Admin lifecycle and status rotation (active vs pruned/disabled)
    // When founding admin Alice is disabled, getAdminPubkey() advances to Bob:
    adminSetUserStatus(alicePubkey, 'disabled');
    assert(getAdminPubkey() === bobPubkey, 'getAdminPubkey() advances to Bob when Alice is disabled');

    // When Bob is pruned as well, getAdminPubkey() returns '' (no active genesis member):
    adminSetUserStatus(bobPubkey, 'pruned');
    assert(getAdminPubkey() === '', 'getAdminPubkey() returns empty string when all genesis members are inactive');

    // Negative assertions for empty actor when all genesis members are inactive:
    assert(canOperate('') === false, "canOperate('') must NOT grant admin override when all genesis members are inactive");
    assert(canOperateTreasury('', farmPubkey) === false, "canOperateTreasury('') must NOT grant admin override when all genesis members are inactive");
    assert(canVouch('') === false, "canVouch('') must NOT grant vouch override when all genesis members are inactive");
    assert(keeperOf('').length === 0, "keeperOf('') must return empty array when all genesis members are inactive");
    assert(hasListedOffer('') === false, "hasListedOffer('') must return false when all genesis members are inactive");
    assert(hasLiveOffer('') === false, "hasLiveOffer('') must return false when all genesis members are inactive");
    assert(liveOfferCount('') === 0, "liveOfferCount('') must return 0 when all genesis members are inactive");
    assert(isAdminPubkey('') === false, "isAdminPubkey('') must return false when all genesis members are inactive");

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
