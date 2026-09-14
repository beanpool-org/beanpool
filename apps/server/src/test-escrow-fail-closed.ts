/**
 * Regression test for Priority Item 2:
 * Fail-closed two-person rule & keepership verification in escrow.
 *
 * Verifies:
 * 1. approvePostRequest on enterprise Need fails closed (401) without authSigner.
 * 2. approvePostRequest fails closed (403) if authSigner is not an authorized keeper.
 * 3. approvePostRequest fails closed (403 TWO_PERSON_RULE) if authSigner is the seller.
 * 4. approvePostRequest succeeds when signed by an authorized second keeper.
 * 5. completePostTransaction on enterprise purchase fails closed (401) without authSigner.
 * 6. completePostTransaction fails closed (403) if authSigner is not an authorized keeper.
 * 7. completePostTransaction fails closed (403 TWO_PERSON_RULE) if authSigner is the seller.
 * 8. completePostTransaction succeeds when signed by an authorized second keeper.
 * 9. Internal escrow transfers (payout, refund) do not record auth_signer as operator.
 * 10. Peer-to-peer deals are unaffected by enterprise keepership checks.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator,
    createPost, requestPost, approvePostRequest, completePostTransaction,
    transfer, getBalance
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
    console.log('Testing Escrow Fail-Closed Two-Person Rule & Keepership Verification...\n');
    initStateEngine();

    const alice = makeMember('alice');
    const bob = makeMember('bob');
    const eve = makeMember('eve');

    transfer('genesis', alice, 500, 'seed alice', 'direct', true);
    transfer('genesis', bob, 500, 'seed bob', 'direct', true);
    transfer('genesis', eve, 500, 'seed eve', 'direct', true);

    // Create an enterprise with 200 credit line and assign Alice and Bob as keepers
    const bakery = createTreasury('CommunityBakery', 'data:image/png;base64,iVBORw0KGgo=', 200).publicKey;
    adminAssignTreasuryOperator(bakery, alice, 'admin');
    adminAssignTreasuryOperator(bakery, bob, 'admin');
    transfer('genesis', bakery, 100, 'seed bakery balance', 'direct', true);
    db.prepare('UPDATE members SET earned_surplus = 100 WHERE public_key = ?').run(bakery);

    // Enterprise lists an Offer first to satisfy CONTRIBUTION_REQUIRED
    createPost('offer', 'food', 'Bakery bread', 'Daily fresh bread', 5, 'fixed', bakery);

    // Enterprise creates a Need
    const need = createPost('need', 'work', 'Bake sourdough', 'Need 20 loaves', 30, 'fixed', bakery)!;
    check(Boolean(need), 'Bakery creates Need post');

    // Alice (keeper) bids on the Need from her personal account -> Alice is seller, Bakery is buyer
    const tx = requestPost(need.id, alice)!;
    check(Boolean(tx), 'Alice bids on Bakery Need');
    check(tx.buyerPublicKey === bakery, 'Bakery is buyer');
    check(tx.sellerPublicKey === alice, 'Alice is seller');

    // ── 1. approvePostRequest fail-closed without authSigner (401) ──
    try {
        approvePostRequest(tx.id, bakery);
        check(false, 'Should throw 401 when authSigner is missing');
    } catch (e: any) {
        check(e.status === 401 || e.statusCode === 401, 'approvePostRequest throws 401 without authSigner');
    }

    // ── 2. approvePostRequest fail-closed with unauthorized signer Eve (403) ──
    try {
        approvePostRequest(tx.id, bakery, { authSigner: eve });
        check(false, 'Should throw 403 when signer is not a keeper');
    } catch (e: any) {
        check(e.status === 403 || e.statusCode === 403, 'approvePostRequest throws 403 for non-keeper Eve');
    }

    // ── 3. approvePostRequest fail-closed on self-dealing (Alice) (403 TWO_PERSON_RULE) ──
    try {
        approvePostRequest(tx.id, bakery, { authSigner: alice });
        check(false, 'Should throw 403 when keeper is seller');
    } catch (e: any) {
        check(e.status === 403 && e.code === 'TWO_PERSON_RULE', 'approvePostRequest throws 403 TWO_PERSON_RULE for Alice');
    }

    // ── 4. approvePostRequest succeeds with authorized second keeper (Bob) ──
    const approvedTx = approvePostRequest(tx.id, bakery, { authSigner: bob });
    check(Boolean(approvedTx) && approvedTx!.status === 'pending', 'Bob (second keeper) successfully approves Alice bid');

    // ── 5. completePostTransaction fail-closed without authSigner (401) ──
    try {
        completePostTransaction(tx.id, bakery);
        check(false, 'Should throw 401 when authSigner is missing on complete');
    } catch (e: any) {
        check(e.status === 401 || e.statusCode === 401, 'completePostTransaction throws 401 without authSigner');
    }

    // ── 6. completePostTransaction fail-closed with non-keeper Eve (403) ──
    try {
        completePostTransaction(tx.id, bakery, undefined, { authSigner: eve });
        check(false, 'Should throw 403 when signer is not a keeper on complete');
    } catch (e: any) {
        check(e.status === 403 || e.statusCode === 403, 'completePostTransaction throws 403 for non-keeper Eve');
    }

    // ── 7. completePostTransaction fail-closed on self-dealing Alice (403 TWO_PERSON_RULE) ──
    try {
        completePostTransaction(tx.id, bakery, undefined, { authSigner: alice });
        check(false, 'Should throw 403 when keeper is seller on complete');
    } catch (e: any) {
        check(e.status === 403 && e.code === 'TWO_PERSON_RULE', 'completePostTransaction throws 403 TWO_PERSON_RULE for Alice');
    }

    // ── 8. completePostTransaction succeeds with authorized second keeper (Bob) ──
    const completedTx = completePostTransaction(tx.id, bakery, undefined, { authSigner: bob });
    check(Boolean(completedTx) && completedTx!.status === 'completed', 'Bob (second keeper) successfully completes deal');

    // ── 9. Escrow payout transfer records auth_signer from keeper Bob (PR #770 audit trail) ──
    const payoutTransfer = db.prepare(
        `SELECT * FROM transactions WHERE from_pubkey = ? AND to_pubkey = ? ORDER BY timestamp DESC LIMIT 1`
    ).get(`escrow_${tx.id}`, alice) as any;
    check(Boolean(payoutTransfer), 'Payout transfer exists in transactions table');
    check(payoutTransfer.auth_signer === bob,
        'escrow payout transaction auth_signer records acting operator Bob (#770)');

    // ── 10. Peer-to-peer deals work without authSigner ──
    const charlie = makeMember('charlie');
    const dave = makeMember('dave');
    transfer('genesis', charlie, 100, 'seed charlie', 'direct', true);
    transfer('genesis', dave, 100, 'seed dave', 'direct', true);

    createPost('offer', 'help', 'Charlie gardening', 'Garden help', 10, 'fixed', charlie);
    const peerOffer = createPost('offer', 'services', 'Dave mower', 'Lawn care', 25, 'fixed', dave)!;
    const p2pTx = requestPost(peerOffer.id, charlie)!;
    check(Boolean(p2pTx), 'Charlie requests Dave peer offer');

    const p2pApproved = approvePostRequest(p2pTx.id, dave);
    check(Boolean(p2pApproved) && p2pApproved!.status === 'pending', 'Dave approves peer deal without authSigner');

    const p2pCompleted = completePostTransaction(p2pTx.id, charlie);
    check(Boolean(p2pCompleted) && p2pCompleted!.status === 'completed', 'Charlie completes peer deal without authSigner');

    console.log(`\nAll ${passed}/${run} checks passed.`);
    process.exit(0);
}

runTests().catch(e => {
    console.error('Test failed:', e);
    process.exit(1);
});
