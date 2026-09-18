/**
 * Regression test for Priority Item 3:
 * Refuse admin privileges when getAdminPubkey() is empty string sentinel.
 *
 * Verifies that when no genesis member exists (getAdminPubkey() returns ''):
 * 1. hasListedOffer('') is false (not exempt).
 * 2. hasLiveOffer('') is false.
 * 3. liveOfferCount('') is 0 (not granted max band).
 * 4. canVouch('') is false (cannot vouch or mint floors).
 * 5. canOperate('') is false (cannot operate treasuries).
 * 6. canAdministerTreasury('', treasury) is false.
 * 7. unvouchMember('', target) refuses with not-admin error.
 * 9. adminSendMessage(target, body) throws no genesis admin error.
 * 10. resolveVouchedInBy(target) with invited_by = '' returns null (not admin).
 * 11. When genesis admin is seeded, real admin succeeds and '' is still rejected.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, getAdminPubkey, hasListedOffer, hasLiveOffer, liveOfferCount,
    canVouch, canOperate, canAdministerTreasury, unvouchMember,
    adminSendMessage, resolveVouchedInBy, createTreasury, seedGenesisMember,
    vouchMember, adminSetVoucher, transfer
} from './state-engine.js';

let passed = 0;
let run = 0;
function check(cond: boolean, msg: string) {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function makeMember(callsign: string): string {
    const pubkey = crypto.randomBytes(16).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=')`
    ).run(pubkey, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(pubkey);
    return pubkey;
}

async function runTests() {
    console.log('Testing Admin Empty String Sentinel Hardening...\n');
    initStateEngine();

    // Ensure database has NO genesis member
    db.prepare("DELETE FROM members WHERE invited_by = 'genesis' AND public_key != 'SYSTEM'").run();

    check(getAdminPubkey() === '', 'getAdminPubkey() returns empty string when no genesis member exists');

    const treasury = createTreasury('TestTreasury', 'data:image/png;base64,iVBORw0KGgo=', 100).publicKey;
    const alice = makeMember('alice');

    // ── 1. Empty string identity does not get offer exemptions or max bands ──
    check(hasListedOffer('') === false, "hasListedOffer('') is false");
    check(hasLiveOffer('') === false, "hasLiveOffer('') is false");
    check(liveOfferCount('') === 0, "liveOfferCount('') is 0");

    // ── 2. Empty string identity does not get vouch or operate capabilities ──
    check(canVouch('') === false, "canVouch('') is false");
    check(canOperate('') === false, "canOperate('') is false");
    check(canAdministerTreasury('', treasury) === false, "canAdministerTreasury('', treasury) is false");

    // ── 3. Empty string identity cannot unvouch as admin ──
    // Vouch alice via an appointed voucher
    const voucher = makeMember('voucher');
    adminSetVoucher(voucher, true);
    vouchMember(voucher, alice);

    try {
        unvouchMember('', alice);
        check(false, "unvouchMember('', alice) should have thrown");
    } catch (e: any) {
        check(e.message === 'Only the voucher who vouched, or an admin, can withdraw a vouch',
            "unvouchMember('', alice) refuses with not-admin error");
    }

    // ── 5. adminSendMessage throws when no admin exists ──
    try {
        adminSendMessage(alice, 'hello');
        check(false, "adminSendMessage should fail when no admin exists");
    } catch (e: any) {
        check(e.message === 'No genesis admin configured', "adminSendMessage throws 'No genesis admin configured'");
    }

    // ── 6. resolveVouchedInBy with invited_by = '' does not resolve as admin ──
    const orphan = makeMember('orphan');
    db.prepare("UPDATE members SET invited_by = '' WHERE public_key = ?").run(orphan);
    const resolved = resolveVouchedInBy(orphan);
    check(resolved === null, "resolveVouchedInBy on empty invited_by returns null, not admin");

    // ── 7. Seed genesis admin: verify admin has privileges and '' remains rejected ──
    const adminPubkey = crypto.randomBytes(16).toString('hex');
    seedGenesisMember(adminPubkey, 'AdminMember');
    check(getAdminPubkey() === adminPubkey, 'getAdminPubkey() returns seeded admin pubkey');

    // Admin has privileges:
    check(hasListedOffer(adminPubkey) === true, 'Admin has listed offer exemption');
    check(hasLiveOffer(adminPubkey) === true, 'Admin has live offer exemption');
    check(liveOfferCount(adminPubkey) > 0, 'Admin has max offer count');
    check(canVouch(adminPubkey) === true, 'Admin can vouch');
    check(canOperate(adminPubkey) === true, 'Admin coarse canOperate is true');
    check(canAdministerTreasury(adminPubkey, treasury) === true, 'Admin can administer treasury');

    // Empty string is STILL rejected:
    check(hasListedOffer('') === false, "hasListedOffer('') remains false even when admin exists");
    check(hasLiveOffer('') === false, "hasLiveOffer('') remains false even when admin exists");
    check(canVouch('') === false, "canVouch('') remains false even when admin exists");
    check(canOperate('') === false, "canOperate('') remains false even when admin exists");
    check(canAdministerTreasury('', treasury) === false, "canAdministerTreasury('', treasury) remains false even when admin exists");

    console.log(`\nAll ${passed}/${run} checks passed.`);
    process.exit(0);
}

runTests().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
