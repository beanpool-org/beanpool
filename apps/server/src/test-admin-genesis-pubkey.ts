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
    seedGenesisMember,
    isNodeOwner,
    isNodeAdmin,
    nodeRoleOf,
    getFirstNodeAdminPubkey,
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
    console.log('Running test-admin-genesis-pubkey suite with explicit node_roles...\n');

    initStateEngine();

    // 1. Fresh node state immediately after initStateEngine()
    const systemRow = db.prepare("SELECT rowid, public_key, invited_by FROM members WHERE public_key = 'SYSTEM'").get() as any;
    assert(!!systemRow, 'SYSTEM member exists in members table');
    assert(systemRow.invited_by === 'genesis', 'SYSTEM member has invited_by = genesis');

    // SYSTEM is never in node_roles
    const systemRole = db.prepare("SELECT * FROM node_roles WHERE member_pubkey = 'SYSTEM'").get();
    assert(!systemRole, 'SYSTEM is NEVER inserted into node_roles');
    assert(isNodeAdmin('SYSTEM') === false, 'SYSTEM does NOT have isNodeAdmin');
    assert(isNodeOwner('SYSTEM') === false, 'SYSTEM does NOT have isNodeOwner');
    assert(nodeRoleOf('SYSTEM') === null, 'SYSTEM has nodeRoleOf = null');

    const adminBeforeHuman = getFirstNodeAdminPubkey();
    assert(adminBeforeHuman === '', 'getFirstNodeAdminPubkey() returns empty string when no human admin exists');

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

    assert(canOperate('SYSTEM') === false, 'SYSTEM does not hold canOperate override');
    assert(canOperateTreasury('SYSTEM', farmPubkey) === false, 'SYSTEM does not hold canOperateTreasury override');

    const nonAdminPubkey = 'pubkey_plain_member_0003';
    assert(canOperate(nonAdminPubkey) === false, 'regular member does not hold admin canOperate override');
    assert(canOperateTreasury(nonAdminPubkey, farmPubkey) === false, 'regular member does not hold admin canOperateTreasury override');

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
