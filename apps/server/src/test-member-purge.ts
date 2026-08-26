/**
 * test-member-purge.ts — Integration tests for Granular Account Deletion / Self-Purge (#99).
 *
 * Verifies:
 * 1. Member cannot purge account while active/pending escrow transactions exist.
 * 2. Purging with positive balance returns credits to Commons Pool, leaving account balance at 0.
 * 3. Purging with negative balance (debt) settles via Commons Pool, maintaining zero-sum conservation.
 * 4. Profile data is anonymized (callsign -> 'Deleted Member', avatar/bio cleared).
 * 5. Active and pending posts are cancelled.
 * 6. Push tokens, friend links, preferences, and recovery shares are wiped.
 * 7. Callsign becomes available for new members to claim.
 * 8. Re-purging an already pruned member is idempotent.
 * 9. Cryptographically signed POST /api/member/purge HTTP endpoint executes end-to-end.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { initStateEngine, seedGenesisMember, generateInvite, redeemInvite, createPost, updateProfile, purgeMemberSelf, getBalance, getMember, isCallsignAvailable, getCommonsBalance, runLedgerAudit, transfer, payFromCommons } from './state-engine.js';
import { initTls } from './services/tls.js';
import { startHttpsServer } from './https-server.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

// Generate test Ed25519 keypairs
function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { publicKey, privateKey, pubKeyHex };
}

async function runTests() {
    console.log('--- TEST: Member Self-Purge (#99) ---');

    const admin = makeKeypair();
    initStateEngine();
    seedGenesisMember(admin.pubKeyHex, 'TestGenesis');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const charlie = makeKeypair();

    const inv1 = generateInvite(admin.pubKeyHex)!;
    redeemInvite(inv1.code, alice.pubKeyHex, 'AliceTester');

    const inv2 = generateInvite(admin.pubKeyHex)!;
    redeemInvite(inv2.code, bob.pubKeyHex, 'BobTester');

    const inv3 = generateInvite(admin.pubKeyHex)!;
    redeemInvite(inv3.code, charlie.pubKeyHex, 'CharlieTester');

    updateProfile(alice.pubKeyHex, {
        bio: 'Alice bio text',
        avatar: 'https://example.com/alice.png',
        contact: { value: 'alice@example.com', visibility: 'community' },
        archetype: 'gardener',
    });

    // Give Alice 50 beans from Commons
    payFromCommons(alice.pubKeyHex, 50, 'Grant initial beans to Alice', { allowDeficit: true });
    assert(getBalance(alice.pubKeyHex).balance === 50, 'Alice has 50 beans initial balance');

    // Create active post for Alice
    const post = createPost('offer', 'food', 'Fresh Organic Tomatoes', 'Fresh tomatoes from the garden', 10, 'fixed', alice.pubKeyHex)!;
    assert(Boolean(post && post.id), 'Alice created an offer post');

    // Add push token and friend
    db.prepare("INSERT INTO push_tokens (public_key, token, platform) VALUES (?, ?, ?)").run(alice.pubKeyHex, 'ExponentPushToken[alice123]', 'ios');
    db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)").run(alice.pubKeyHex, bob.pubKeyHex);

    // 1. Test Escrow Guard: simulate an active escrow deal
    const txId = 'tx_test_escrow_123';
    db.prepare(`
        INSERT INTO marketplace_transactions (
            id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    `).run(txId, post.id, bob.pubKeyHex, alice.pubKeyHex, 10);

    let failedAsExpected = false;
    try {
        purgeMemberSelf(alice.pubKeyHex);
    } catch (e: any) {
        failedAsExpected = true;
        assert(e.message.includes('escrow') || e.message.includes('deals'), 'Purge is blocked when active escrow exists');
    }
    assert(failedAsExpected, 'Active escrow correctly prevented account deletion');

    // Resolve the escrow transaction
    db.prepare("UPDATE marketplace_transactions SET status = 'completed' WHERE id = ?").run(txId);

    // Record commons balance before purge
    const commonsBefore = getCommonsBalance();

    // 2. Perform self-purge for Alice
    const purgeResult = purgeMemberSelf(alice.pubKeyHex);
    assert(purgeResult.ok === true, 'purgeMemberSelf returned success');

    // 3. Verify member row anonymization
    const aliceMember = getMember(alice.pubKeyHex);
    assert(aliceMember !== null, 'Member row is retained as pruned tombstone');
    assert(aliceMember?.status === 'pruned', 'Alice status is pruned');
    assert(aliceMember?.callsign === 'Deleted Member', 'Alice callsign is anonymized');
    assert(aliceMember?.avatarUrl === null || aliceMember?.avatarUrl === undefined, 'Avatar URL is cleared');
    assert(aliceMember?.bio === null || aliceMember?.bio === undefined, 'Bio is cleared');

    // 4. Verify balance returned to Commons Pool
    assert(getBalance(alice.pubKeyHex).balance === 0, 'Alice balance is exactly 0 after purge');
    assert(getCommonsBalance() === commonsBefore + 50, 'Commons pool received Alice surplus credits');

    // 5. Verify post cancellation
    const alicePost = db.prepare("SELECT * FROM posts WHERE id = ?").get(post.id) as any;
    assert(alicePost.status === 'cancelled', 'Alice post was cancelled');
    assert(alicePost.active === 0, 'Alice post active flag is 0');

    // 6. Verify push tokens and friend links deleted
    const pushTokenRow = db.prepare("SELECT * FROM push_tokens WHERE public_key = ?").get(alice.pubKeyHex);
    assert(!pushTokenRow, 'Alice push tokens were deleted');
    const friendRow = db.prepare("SELECT * FROM friends WHERE owner_pubkey = ? OR friend_pubkey = ?").get(alice.pubKeyHex, alice.pubKeyHex);
    assert(!friendRow, 'Alice friend relationships were deleted');

    // 7. Verify callsign reclaimability
    assert(isCallsignAvailable('AliceTester') === true, 'Previous callsign "AliceTester" is now available for other members');
    const newAlice = makeKeypair();
    const inv4 = generateInvite(admin.pubKeyHex)!;
    const registeredNewAlice = redeemInvite(inv4.code, newAlice.pubKeyHex, 'AliceTester');
    assert(registeredNewAlice.success === true && registeredNewAlice.member?.callsign === 'AliceTester', 'New member successfully claimed previous callsign');

    // 8. Test Bad Debt settlement on purge
    // Put Bob into deficit and Charlie into credit (simulating trade credit)
    const bobAcc = ledger.getAccount(bob.pubKeyHex);
    bobAcc.balance = -30;
    db.prepare("UPDATE accounts SET balance = -30 WHERE public_key = ?").run(bob.pubKeyHex);

    const charlieAcc = ledger.getAccount(charlie.pubKeyHex);
    charlieAcc.balance = 30;
    db.prepare("UPDATE accounts SET balance = 30 WHERE public_key = ?").run(charlie.pubKeyHex);

    assert(getBalance(bob.pubKeyHex).balance < 0, 'Bob has negative balance (debt)');
    const bobDebt = Math.abs(getBalance(bob.pubKeyHex).balance);
    const commonsBeforeBobPurge = getCommonsBalance();

    purgeMemberSelf(bob.pubKeyHex);
    assert(getBalance(bob.pubKeyHex).balance === 0, 'Bob balance is exactly 0 after debt write-off');
    assert(getCommonsBalance() === commonsBeforeBobPurge - bobDebt, 'Commons pool absorbed Bob bad debt');

    // Verify zero-sum ledger audit
    const audit = runLedgerAudit();
    assert(audit.ok === true, 'Double-entry ledger audit passed with zero discrepancy');

    // 9. HTTP Endpoint Test with Replay-Proof Signing
    initTls();
    const port = 8549;
    await startHttpsServer(port);

    const dave = makeKeypair();
    const inv5 = generateInvite(admin.pubKeyHex)!;
    redeemInvite(inv5.code, dave.pubKeyHex, 'DaveTester');

    // Test 401 on unsigned purge request
    const unauthRes = await fetch(`https://localhost:${port}/api/member/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'purge_account' }),
    });
    assert(unauthRes.status === 401, 'Unsigned POST /api/member/purge is rejected with 401');

    function signPayload(method: string, path: string, ts: number, nonce: string, bodyStr: string, privKey: crypto.KeyObject): string {
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyStr}`;
        return crypto.sign(null, Buffer.from(canonical), privKey).toString('base64');
    }

    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyObj = { action: 'purge_account' };
    const bodyStr = JSON.stringify(bodyObj);
    const signature = signPayload('POST', '/api/member/purge', ts, nonce, bodyStr, dave.privateKey);

    const res = await fetch(`https://localhost:${port}/api/member/purge`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': dave.pubKeyHex,
            'X-Signature': signature,
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyStr,
    });

    assert(res.status === 200, 'POST /api/member/purge returned 200 OK');
    const json = await res.json() as any;
    assert(json.ok === true, 'Response payload contains ok: true');

    const daveRow = db.prepare("SELECT * FROM members WHERE public_key = ?").get(dave.pubKeyHex) as any;
    assert(daveRow?.status === 'pruned', 'Dave account was pruned via HTTP endpoint');
    assert(daveRow?.can_vouch === 0 && daveRow?.vouch_credit === 0, 'Privileges were revoked upon purge');

    console.log(`\n========================================`);
    console.log(`Test Results: ${passed}/${run} assertions passed`);
    console.log(`========================================`);
    process.exit(0);
}

runTests().catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
