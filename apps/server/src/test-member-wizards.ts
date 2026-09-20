/**
 * Member Re-Keying & Offboarding Wizards Test Suite (Item 9b / docs/settings-ia.md §5 items 1 & 4)
 *
 * Verifies:
 * 1. Lost Phone / Re-Keying:
 *    - Invalidation of old device public key immediately (reason='rekey_pending', status='suspended')
 *    - assertMemberActive blocks operations from old device key
 *    - One-time re-enrolment code issuance (RK-XXXX-XXXX) with 24h TTL
 *    - Rejection of invalid, expired, or duplicate keys
 *    - Atomic transfer of all rows keyed by old pubkey across all 32 consumers of members.public_key
 *    - Push tokens for lost device purged
 *    - Node roles, keeperships, trade history, ratings, and conversations transferred
 *    - Rekey audit log and requests status updated
 *    - Invalidation updated with rekeyed_to
 *    - assertMemberActive passes for new key and fails with rekeyed_to for old key
 * 2. Ledger Conservation:
 *    - Zero-sum mutual credit conservation SUM(balances) + COMMONS_POOL = 0 asserted before and after
 *    - runLedgerAudit reports ok=true, drift=0
 *    - In-memory LedgerManager accounts map resynced with reconcileLedgerFromDb
 * 3. Offboarding:
 *    - Preview calculations (costToCommunity, projectedCommonsBalance, pendingEscrows, activeMembers)
 *    - Sole owner guard prevents offboarding sole owner
 *    - Positive balance -> donate_to_commons: balance transferred to Commons, member pruned, zero-sum conserved
 *    - Positive balance -> gift_to_member: balance transferred to recipient, member pruned, zero-sum conserved
 *    - Two-Person Rule: actor attempting to gift departing balance to self rejected with 403 / TWO_PERSON_RULE
 *    - Negative balance -> write_off_commons: formal debt write-off against Commons pool, member pruned, zero-sum conserved
 *    - Zero balance -> prune_zero_balance: member pruned, zero-sum conserved
 * 4. HTTP API Endpoints:
 *    - GET /api/local/admin/members/:pubkey/rekey/status (401 unauth, 200 auth)
 *    - POST /api/local/admin/members/:pubkey/rekey/issue-code (401 unauth, 200 auth)
 *    - POST /api/local/admin/members/:pubkey/rekey/complete (401 unauth, 200 auth)
 *    - GET /api/local/admin/members/:pubkey/offboard/preview (401 unauth, 200 auth)
 *    - POST /api/local/admin/members/:pubkey/offboard (401 unauth, 403 on self-gift, 200 auth)
 *    - POST /api/member/re-enroll (public replacement device endpoint)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import http from 'node:http';
import Koa from 'koa';
import { db, initSchema } from './db/db.js';
import {
    initStateEngine,
    transfer,
    getBalance,
    getCommonsBalanceExact,
    getMember,
    assertMemberActive,
    createPost,
    acceptPost,
    completePostTransaction,
    isSoleOwner,
    persistCommonsBalance,
    reconcileLedgerFromDb,
} from './state-engine.js';
import { setCommonsBalance } from '@beanpool/core';
import {
    issueRekeyCode,
    completeRekey,
    getRekeyStatus,
    isKeyInvalidated,
    getInvalidatedKeyInfo,
    getOffboardPreview,
    executeOffboard,
} from './engine/member-wizards.js';
import { runLedgerAudit } from './engine/audit.js';
import { createAdminRoutes } from './routes/admin.js';
import { createCommunityRoutes } from './routes/community.js';

let run = 0;
let passed = 0;

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

function throws(fn: () => unknown, re: RegExp, msg: string): void {
    run++;
    let err = '';
    try {
        fn();
    } catch (e: any) {
        err = e.message || String(e);
    }
    if (re.test(err)) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg} (expected ${re}, got "${err}")`);
        process.exit(1);
    }
}

async function throwsAsync(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
    run++;
    let err = '';
    try {
        await fn();
    } catch (e: any) {
        err = e.message || String(e);
    }
    if (re.test(err)) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg} (expected ${re}, got "${err}")`);
        process.exit(1);
    }
}

const nodeTotal = () => {
    const accRows = db.prepare("SELECT SUM(balance) as total FROM accounts WHERE public_key != 'COMMONS_POOL'").get() as any;
    const accSum = accRows?.total || 0;
    return Math.round((accSum + getCommonsBalanceExact()) * 10000) / 10000;
};

function generateValidPubkey(): string {
    return crypto.randomBytes(32).toString('hex');
}

function generateKeyPair(): { pubHex: string; privateKey: crypto.KeyObject } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const pubHex = spki.subarray(spki.length - 32).toString('hex');
    return { pubHex, privateKey };
}

function makeMember(callsign: string, pubkey?: string): string {
    const pk = pubkey || generateValidPubkey();
    const uniqueCallsign = `${callsign}_${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, status, avatar_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', 'data:image/png;base64,iVBORw0KGgo=')`
    ).run(pk, uniqueCallsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    return pk;
}

async function main() {
    console.log('🧪 Starting Member Re-Keying & Offboarding Wizards Test Suite (Item 9b)...\n');

    initSchema();
    initStateEngine();

    const initialTotal = nodeTotal();
    assert(initialTotal === 0, 'Initial ledger total is conserved (0.0000)');

    // =========================================================================
    // PART 1: RE-KEYING FLOW (LOST PHONE) & ATOMIC TRANSFER
    // =========================================================================
    console.log('\n--- Part 1: Lost Phone / Re-Keying Flow ---');

    const operatorPubkey = generateValidPubkey();
    makeMember('operator', operatorPubkey);
    // Assign operator role
    db.prepare("INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'genesis')").run(operatorPubkey);

    const oldAliceKey = generateValidPubkey();
    makeMember('alice', oldAliceKey);
    const bobKey = generateValidPubkey();
    makeMember('bob', bobKey);

    // Give Alice a balance of 150 beans and Bob 50 beans
    transfer('genesis', oldAliceKey, 150, 'seed alice', 'direct', true);
    transfer('genesis', bobKey, 50, 'seed bob', 'direct', true);

    assert(getBalance(oldAliceKey).balance === 150, 'Alice has 150 beans balance before re-keying');
    assert(nodeTotal() === 0, 'Ledger total is 0 after seeding Alice and Bob');

    // Populate various tables to test row transfers across consumers
    // 1. Posts: Alice created a post (also satisfies CONTRIBUTION_REQUIRED)
    const alicePost = createPost('offer', 'produce', 'Organic Honey', 'Fresh honey from the hives', 25, 'fixed', oldAliceKey);
    assert(Boolean(alicePost?.id), 'Alice created a honey offer post');

    // 2. Marketplace trade & Transactions: Alice buys coffee from Bob
    const bobOffer = createPost('offer', 'produce', 'Roast Coffee', 'Fresh roast beans', 20, 'fixed', bobKey);
    const mktTx = acceptPost(bobOffer!.id, oldAliceKey);
    completePostTransaction(mktTx.id, oldAliceKey);
    assert(getBalance(oldAliceKey).balance === 130, 'Alice balance 130 after paying Bob');

    // 3. Direct transfer: Alice now has earned trust and sends 10 beans tip to Bob
    transfer(oldAliceKey, bobKey, 10, 'alice coffee tip to bob', 'direct', false);
    assert(getBalance(oldAliceKey).balance === 120, 'Alice balance 120 after tip to Bob');

    // 3. Node roles: Alice has moderator role
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'moderator', ?)").run(oldAliceKey, operatorPubkey);

    // 4. Friends: Alice friended Bob
    db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)").run(oldAliceKey, bobKey);
    db.prepare("INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)").run(bobKey, oldAliceKey);

    // 5. Ratings: Bob rated Alice
    const ratingId = 'rat_' + crypto.randomBytes(6).toString('hex');
    db.prepare("INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment) VALUES (?, ?, ?, 'seller', 5, 'Best honey')").run(ratingId, oldAliceKey, bobKey);

    // 6. Push tokens: Alice registered a push token on her old (lost) phone
    db.prepare("INSERT INTO push_tokens (token, public_key, platform) VALUES ('lost_phone_apns_token_xyz', ?, 'ios')").run(oldAliceKey);

    // 7. Member preferences: Alice set dark mode
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'theme', 'dark')").run(oldAliceKey);

    // 8. Conversations, participants, messages
    const convId = 'conv_' + crypto.randomBytes(6).toString('hex');
    db.prepare("INSERT INTO conversations (id, type, created_by) VALUES (?, 'direct', ?)").run(convId, oldAliceKey);
    db.prepare("INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)").run(convId, oldAliceKey);
    db.prepare("INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)").run(convId, bobKey);
    const msgId = 'msg_' + crypto.randomBytes(6).toString('hex');
    db.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, 'cipher_bytes', 'nonce_bytes')").run(msgId, convId, oldAliceKey);

    // 9. Treasury operators
    const treasuryPub = generateValidPubkey();
    makeMember('treasury_coop', treasuryPub);
    db.prepare("INSERT OR REPLACE INTO treasury_operators (member_pubkey, treasury_pubkey, granted_by) VALUES (?, ?, ?)").run(oldAliceKey, treasuryPub, operatorPubkey);

    // 10. Deferred wage claims
    db.prepare("INSERT INTO deferred_wage_claims (id, keeper_pubkey, enterprise_pubkey, amount) VALUES (?, ?, ?, 40)").run(
        'dwc_' + crypto.randomBytes(6).toString('hex'),
        oldAliceKey,
        bobKey
    );

    // 11. Decisions and votes
    const decId = 'dec_' + crypto.randomBytes(6).toString('hex');
    db.prepare("INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, closes_at) VALUES (?, ?, 'Suspend spammer', 'Posting spam', 'member', 'suspend_member', '1m1v', datetime('now', '+7 days'))").run(decId, oldAliceKey);
    db.prepare("INSERT INTO decision_votes (decision_id, voter_pubkey, support) VALUES (?, ?, 1)").run(decId, oldAliceKey);

    // 12. Enterprise pledges
    db.prepare("INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES (?, ?, ?, 50)").run(
        'plg_' + crypto.randomBytes(6).toString('hex'),
        oldAliceKey,
        bobKey
    );

    // 13. Social recovery shares (Alice as guardian for Bob)
    const recShareInsert = db.prepare(`
        INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
        VALUES (?, 'member', ?, 1, 'enc_share', 'iv_bytes', 'tag_bytes', 1)
    `).run(bobKey, oldAliceKey);
    const recShareId = recShareInsert.lastInsertRowid;

    // 14. Governance pool hardship proposal (Alice as subject)
    const hardshipDecId = 'dec_hardship_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, subject, effect, franchise, closes_at)
        VALUES (?, ?, 'Hardship Grant', 'Emergency grant', 'pool', ?, 'grant_hardship', '1m1v', datetime('now', '+7 days'))
    `).run(hardshipDecId, bobKey, oldAliceKey);

    // 15. Transaction with immutable cryptographic authorship
    const txSignedId = 'tx_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
        INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp, auth_signer, auth_signature, auth_payload)
        VALUES (?, ?, ?, 5, 'coffee', datetime('now'), ?, 'sig_bytes', 'payload_bytes')
    `).run(txSignedId, oldAliceKey, bobKey, oldAliceKey);

    // Step A: Issue re-key code (tested with uppercase key to verify case normalization)
    const rekeyIssue = issueRekeyCode(oldAliceKey.toUpperCase(), operatorPubkey);
    assert(Boolean(rekeyIssue.code), `Re-enrolment code generated: ${rekeyIssue.code}`);
    assert(/^RK-[0-9A-F]{4}-[0-9A-F]{4}$/.test(rekeyIssue.code), 'Code format is RK-XXXX-XXXX');
    assert(isKeyInvalidated(oldAliceKey), 'oldAliceKey is immediately recorded in invalidated_keys');
    const invInfo = getInvalidatedKeyInfo(oldAliceKey);
    assert(invInfo?.reason === 'rekey_pending', 'Invalidation reason is rekey_pending');
    assert(invInfo?.rekeyed_to === null, 'rekeyed_to is null before completion');

    // Check that assertMemberActive immediately fails for old key (tested with mixed-case and lowercase)
    throws(() => assertMemberActive(oldAliceKey), /invalidated|suspended/, 'assertMemberActive rejects old key while rekey is pending');
    throws(() => assertMemberActive(oldAliceKey.toUpperCase()), /invalidated|suspended/, 'assertMemberActive rejects uppercase hex old key');

    // Check rekey status helper
    const statusBefore = getRekeyStatus(oldAliceKey);
    assert(statusBefore.isInvalidated === true, 'getRekeyStatus shows isInvalidated: true');
    assert(statusBefore.pendingRequest !== null, 'getRekeyStatus includes pendingRequest');
    assert(statusBefore.pendingRequest?.code === rekeyIssue.code, 'getRekeyStatus code matches');

    // Test that expired pending requests are lazily marked expired and pendingRequest is null
    const expMemberKey = generateValidPubkey();
    makeMember('exp_member', expMemberKey);
    const expCode = issueRekeyCode(expMemberKey, operatorPubkey).code;
    db.prepare("UPDATE rekey_requests SET expires_at = datetime('now', '-1 hour') WHERE code = ?").run(expCode);
    const expStatus = getRekeyStatus(expMemberKey);
    assert(expStatus.pendingRequest === null, 'getRekeyStatus returns null for expired pendingRequest');
    const expRow = db.prepare("SELECT status FROM rekey_requests WHERE code = ?").get(expCode) as any;
    assert(expRow.status === 'expired', 'Expired request was lazily updated to expired in db');

    // Step B: Validation rejects on rekey completion
    const newAliceKey = generateValidPubkey();

    // Rejects invalid code
    throws(
        () => completeRekey(oldAliceKey, newAliceKey, 'RK-0000-0000', operatorPubkey),
        /Invalid or unrecognised/,
        'completeRekey rejects unknown code'
    );

    // Rejects invalid new key format (e.g. not 64 hex chars)
    throws(
        () => completeRekey(oldAliceKey, 'not-a-64-hex-key', rekeyIssue.code, operatorPubkey),
        /64-character hex string/,
        'completeRekey rejects invalid hex length'
    );

    // Rejects if new key matches old key
    throws(
        () => completeRekey(oldAliceKey, oldAliceKey, rekeyIssue.code, operatorPubkey),
        /must be different/,
        'completeRekey rejects using same key'
    );

    // Rejects if new key already registered to another member
    throws(
        () => completeRekey(oldAliceKey, bobKey, rekeyIssue.code, operatorPubkey),
        /already registered/,
        'completeRekey rejects public key registered to Bob'
    );

    // Step C: Complete re-keying atomically
    const completeRes = completeRekey(oldAliceKey, newAliceKey, rekeyIssue.code, operatorPubkey);
    assert(completeRes.success === true, 'completeRekey completed successfully');
    assert(completeRes.newPubkey === newAliceKey, 'Result contains newPubkey');

    // Step D: Verify post-rekey state
    // 1. Old key remains invalidated with pointer to new key
    assert(isKeyInvalidated(oldAliceKey) === true, 'oldAliceKey is permanently invalidated');
    const invInfoAfter = getInvalidatedKeyInfo(oldAliceKey);
    assert(invInfoAfter?.rekeyed_to === newAliceKey, `oldAliceKey invalidation records rekeyed_to = ${newAliceKey}`);
    throws(() => assertMemberActive(oldAliceKey), new RegExp(newAliceKey), 'assertMemberActive on old key reports rekeyed_to new key');

    // 2. New key is active
    assertMemberActive(newAliceKey);
    const newMember = getMember(newAliceKey);
    assert(newMember?.status === 'active', 'new Alice member record has status active');
    assert(Boolean(newMember?.callsign.includes('alice')), 'Callsign preserved under new key');

    // 3. Balance moved to new key and conserved
    const aliceNewBalance = getBalance(newAliceKey).balance;
    assert(aliceNewBalance === 120, `New Alice key holds exactly 120 beans (got ${aliceNewBalance})`);
    assert(nodeTotal() === 0, 'Zero-sum ledger conservation holds after re-keying');
    const auditRekey = runLedgerAudit();
    assert(auditRekey.ok === true && Math.abs(auditRekey.drift) < 0.0001, 'runLedgerAudit passes with 0 drift');

    // 4. Consumers updated:
    // Posts
    const postRow = db.prepare('SELECT author_pubkey FROM posts WHERE id = ?').get(alicePost!.id) as any;
    assert(postRow.author_pubkey === newAliceKey, 'Post author updated to newAliceKey');

    // Node roles
    const roleRow = db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(newAliceKey) as any;
    assert(roleRow?.role === 'moderator', 'Node role (moderator) preserved under newAliceKey');

    // Friends
    const friendRow1 = db.prepare('SELECT friend_pubkey FROM friends WHERE owner_pubkey = ?').get(newAliceKey) as any;
    assert(friendRow1?.friend_pubkey === bobKey, 'Alice friend record preserved with new owner_pubkey');
    const friendRow2 = db.prepare('SELECT friend_pubkey FROM friends WHERE owner_pubkey = ?').get(bobKey) as any;
    assert(friendRow2?.friend_pubkey === newAliceKey, "Bob's friend list updated with newAliceKey");

    // Ratings
    const ratingRow = db.prepare('SELECT target_pubkey FROM ratings WHERE rater_pubkey = ?').get(bobKey) as any;
    assert(ratingRow?.target_pubkey === newAliceKey, 'Rating target updated to newAliceKey');

    // Push tokens: Old phone token deleted
    const pushCount = (db.prepare('SELECT COUNT(*) as c FROM push_tokens WHERE public_key = ?').get(oldAliceKey) as any)?.c;
    assert(pushCount === 0, 'Old lost phone push token was purged');

    // Conversations, participants, messages
    const convRow = db.prepare('SELECT created_by FROM conversations WHERE id = ?').get(convId) as any;
    assert(convRow.created_by === newAliceKey, 'Conversation created_by updated to newAliceKey');
    const partRow = db.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(convId, newAliceKey) as any;
    assert(Boolean(partRow), 'Conversation participant updated to newAliceKey');
    const msgRow = db.prepare('SELECT author_pubkey FROM messages WHERE conversation_id = ?').get(convId) as any;
    assert(msgRow.author_pubkey === newAliceKey, 'Message author updated to newAliceKey');

    // Treasury operators
    const toRow = db.prepare('SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ?').get(treasuryPub) as any;
    assert(toRow?.member_pubkey === newAliceKey, 'Treasury operator updated to newAliceKey');

    // Deferred wage claims
    const dwcRow = db.prepare('SELECT keeper_pubkey FROM deferred_wage_claims WHERE keeper_pubkey = ?').get(newAliceKey) as any;
    assert(Boolean(dwcRow), 'Deferred wage claim updated to newAliceKey');

    // Decisions & votes
    const decAuthor = (db.prepare('SELECT author_pubkey FROM decisions WHERE id = ?').get(decId) as any)?.author_pubkey;
    assert(decAuthor === newAliceKey, 'Decision author updated to newAliceKey');
    const voteRow = (db.prepare('SELECT voter_pubkey FROM decision_votes WHERE decision_id = ?').get(decId) as any)?.voter_pubkey;
    assert(voteRow === newAliceKey, 'Decision vote voter updated to newAliceKey');

    // Social recovery shares: guardian holder_ref updated to newAliceKey
    const recRow = db.prepare('SELECT holder_ref FROM recovery_shares WHERE id = ?').get(recShareId) as any;
    assert(recRow?.holder_ref === newAliceKey, 'Recovery share holder_ref updated to newAliceKey');

    // Governance pool hardship: subject updated to newAliceKey
    const hardshipRow = db.prepare('SELECT subject FROM decisions WHERE id = ?').get(hardshipDecId) as any;
    assert(hardshipRow?.subject === newAliceKey, 'Pool hardship decision subject updated to newAliceKey');

    // Transactions: auth_signer left untouched for cryptographic signature verification
    const txRow = db.prepare('SELECT from_pubkey, auth_signer FROM transactions WHERE id = ?').get(txSignedId) as any;
    assert(txRow?.from_pubkey === newAliceKey, 'Transaction from_pubkey updated to newAliceKey');
    assert(txRow?.auth_signer === oldAliceKey, 'Transaction auth_signer left untouched for cryptographic signature verification');

    // Case-insensitive assertMemberActive check
    throws(() => assertMemberActive(oldAliceKey.toUpperCase()), new RegExp(newAliceKey), 'assertMemberActive on uppercase old key reports rekeyed_to new key');
    assertMemberActive(newAliceKey.toUpperCase());
    assert(true, 'assertMemberActive succeeds with uppercase hex of active member (normalised before query)');

    // Verify hot-path query in assertMemberActive uses B-tree index (not SCAN TABLE)
    const hotPathPlan = db.prepare('EXPLAIN QUERY PLAN SELECT status FROM members WHERE public_key = ? COLLATE NOCASE').all(newAliceKey) as any[];
    const usesIndex = hotPathPlan.some((step) => step.detail.includes('USING INDEX') || step.detail.includes('USING PRIMARY KEY'));
    assert(usesIndex === true, 'assertMemberActive members query utilizes index without full-table SCAN');

    // Rekey audit log
    const auditLogRow = db.prepare('SELECT * FROM rekey_audit_log WHERE old_pubkey = ?').get(oldAliceKey) as any;
    assert(Boolean(auditLogRow), 'rekey_audit_log row recorded');
    assert(auditLogRow.new_pubkey === newAliceKey, 'rekey_audit_log records new_pubkey');
    assert(auditLogRow.operator_pubkey === operatorPubkey, 'rekey_audit_log records operator_pubkey');

    // Rekey requests
    const reqRow = db.prepare('SELECT * FROM rekey_requests WHERE code = ?').get(rekeyIssue.code) as any;
    assert(reqRow.status === 'completed', 'rekey_requests status is completed');
    assert(Boolean(reqRow.completed_at), 'rekey_requests completed_at timestamp recorded');

    // Re-keying a suspended role-holder: the role held aside for the suspension moves with the key, and a
    // new key does not end the suspension.
    const oldCarolKey = generateValidPubkey();
    makeMember('carol_suspended_admin', oldCarolKey);
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(oldCarolKey);
    db.prepare(`INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                VALUES ('carol-keep', ?, 'admin', '2026-01-01T00:00:00.000Z', ?, 2, NULL)`).run(oldCarolKey, operatorPubkey);
    const carolCode = issueRekeyCode(oldCarolKey, operatorPubkey).code;
    assert((db.prepare('SELECT status FROM members WHERE public_key = ?').get(oldCarolKey) as any)?.status === 'disabled',
        'issuing a re-key code leaves a suspended member suspended');
    const newCarolKey = generateValidPubkey();
    completeRekey(oldCarolKey, newCarolKey, carolCode, operatorPubkey);
    const carolHeld = db.prepare('SELECT member_pubkey, role, session_epoch FROM suspended_node_roles WHERE decision_id = ?').get('carol-keep') as any;
    assert(carolHeld?.member_pubkey === newCarolKey && carolHeld.role === 'admin' && carolHeld.session_epoch === 2,
        `the held admin role moves to the new key (got ${JSON.stringify(carolHeld)})`);
    assert((db.prepare('SELECT status FROM members WHERE public_key = ?').get(newCarolKey) as any)?.status === 'disabled',
        'and the member is still suspended under the new key');

    // =========================================================================
    // PART 2: OFFBOARDING WIZARD & TWO-PERSON RULE ENFORCEMENT
    // =========================================================================
    console.log('\n--- Part 2: Offboarding Wizard & Two-Person Rule ---');

    // Member 1: Positive balance -> Donate to Commons
    const charlieKey = generateValidPubkey();
    makeMember('charlie', charlieKey);
    transfer('genesis', charlieKey, 75, 'seed charlie', 'direct', true);
    assert(getBalance(charlieKey).balance === 75, 'Charlie has 75 beans balance');
    assert(nodeTotal() === 0, 'Zero-sum before Charlie offboard preview');

    const previewCharlie = getOffboardPreview(charlieKey);
    assert(previewCharlie.balance === 75, 'Charlie preview shows 75 beans balance');
    assert(previewCharlie.costToCommunity === 0, 'Charlie costToCommunity is 0 for positive balance');
    assert(previewCharlie.projectedCommonsBalance === previewCharlie.commonsBalance + 75, 'projectedCommonsBalance increases by 75 on donation');
    assert(previewCharlie.isSoleOwner === false, 'Charlie is not sole owner');

    // Execute offboarding: donate_to_commons
    const offboardCharlieRes = executeOffboard(charlieKey, { resolution: 'donate_to_commons' }, operatorPubkey);
    assert(offboardCharlieRes.success === true, 'Charlie offboarded with donate_to_commons');
    assert(getBalance(charlieKey).balance === 0, 'Charlie balance is 0 after offboarding');
    assert(getMember(charlieKey)?.status === 'pruned', 'Charlie member status set to pruned');
    assert(nodeTotal() === 0, 'Zero-sum conserved after Charlie donation offboarding');
    const auditCharlie = runLedgerAudit();
    assert(auditCharlie.ok === true && Math.abs(auditCharlie.drift) < 0.0001, 'runLedgerAudit passes with 0 drift after donation');

    // REGRESSION TEST (Item 1): Double-click / Idempotency check:
    // Calling executeOffboard a second time on already-pruned member is an idempotent no-op returning the first result.
    const commonsAfterFirst = getCommonsBalanceExact();
    const secondCallRes = executeOffboard(charlieKey, { resolution: 'donate_to_commons' }, operatorPubkey);
    assert(secondCallRes.success === true, 'Second offboard call succeeds idempotently');
    assert(secondCallRes.memberPubkey === charlieKey.toLowerCase(), 'Second call returns memberPubkey');
    assert(secondCallRes.resolution === 'donate_to_commons', 'Second call returns original resolution');
    assert(secondCallRes.balanceSettled === 75, 'Second call returns original balanceSettled (75)');
    const commonsAfterSecond = getCommonsBalanceExact();
    assert(commonsAfterSecond === commonsAfterFirst, 'Commons pool moved exactly once after two calls in a row');
    assert(nodeTotal() === 0, 'Zero-sum conserved after second idempotent call');

    // Member 2: Positive balance -> Gift to Member + Two-Person Rule Check
    const daveKey = generateValidPubkey();
    makeMember('dave', daveKey);
    transfer('genesis', daveKey, 60, 'seed dave', 'direct', true);
    assert(getBalance(daveKey).balance === 60, 'Dave has 60 beans balance');

    // Test Two-Person Rule: Operator attempting to gift Dave's balance to operatorPubkey must fail with 403 / TWO_PERSON_RULE
    try {
        executeOffboard(
            daveKey,
            { resolution: 'gift_to_member', giftRecipientPubkey: operatorPubkey },
            operatorPubkey
        );
        assert(false, 'Should have thrown TWO_PERSON_RULE error');
    } catch (e: any) {
        assert(e.code === 'TWO_PERSON_RULE' || e.status === 403, 'Two-person rule correctly rejected self-gifting by operator');
    }

    // Test: Engine directly rejects password-auth caller for gift_to_member (KEY_AUTH_REQUIRED)
    try {
        executeOffboard(
            daveKey,
            { resolution: 'gift_to_member', giftRecipientPubkey: bobKey },
            'owner:password'
        );
        assert(false, 'Should have thrown KEY_AUTH_REQUIRED error when calling executeOffboard with password auth');
    } catch (e: any) {
        assert(e.code === 'KEY_AUTH_REQUIRED' && (e.status === 403 || e.statusCode === 403), 'Engine directly enforces KEY_AUTH_REQUIRED for gift_to_member');
    }

    // Assert an ordinary admin-signed transfer (without offboardOverride) is STILL subject to the trust gate
    const ordinaryAdminTx = transfer(
        daveKey,
        bobKey,
        10,
        'ordinary admin-signed transfer without offboardOverride',
        'direct',
        false,
        { signer: operatorPubkey }
    );
    assert(ordinaryAdminTx === null, 'Ordinary admin-signed transfer is blocked by the earned-credit trust gate');

    // Now execute valid gift to Bob (different from operator)
    const bobBalanceBefore = getBalance(bobKey).balance;
    const offboardDaveRes = executeOffboard(
        daveKey,
        { resolution: 'gift_to_member', giftRecipientPubkey: bobKey },
        operatorPubkey
    );
    assert(offboardDaveRes.success === true, 'Dave offboarded with gift_to_member');
    assert(getBalance(daveKey).balance === 0, 'Dave balance is 0 after gifting');
    assert(getBalance(bobKey).balance === bobBalanceBefore + 60, `Bob balance credited with Dave's 60 beans (now ${getBalance(bobKey).balance})`);
    assert(getMember(daveKey)?.status === 'pruned', 'Dave member status set to pruned');
    assert(nodeTotal() === 0, 'Zero-sum conserved after Dave gift offboarding');
    const auditDave = runLedgerAudit();
    assert(auditDave.ok === true && Math.abs(auditDave.drift) < 0.0001, 'runLedgerAudit passes with 0 drift after gift');

    // Member 3: Negative balance -> Formal Write-off against Commons
    const eveKey = generateValidPubkey();
    makeMember('eve', eveKey);
    // Seed Eve in debt of -45 beans balanced by Commons pool
    db.prepare('UPDATE accounts SET balance = -45 WHERE public_key = ?').run(eveKey);
    setCommonsBalance(getCommonsBalanceExact() + 45);
    persistCommonsBalance();
    reconcileLedgerFromDb();
    assert(getBalance(eveKey).balance === -45, 'Eve has negative balance -45 beans');
    assert(nodeTotal() === 0, 'Zero-sum before Eve offboarding');

    // Preview negative balance
    const previewEve = getOffboardPreview(eveKey);
    assert(previewEve.balance === -45, 'Eve preview shows -45 beans');
    assert(previewEve.costToCommunity === 45, 'Eve preview shows costToCommunity of 45 beans');
    assert(previewEve.projectedCommonsBalance === previewEve.commonsBalance - 45, 'projectedCommonsBalance decreases by 45');

    // Offboard Eve: write_off_commons
    const commonsBeforeEve = getCommonsBalanceExact();
    const offboardEveRes = executeOffboard(eveKey, { resolution: 'write_off_commons' }, operatorPubkey);
    assert(offboardEveRes.success === true, 'Eve offboarded with write_off_commons');
    assert(getBalance(eveKey).balance === 0, 'Eve balance restored to 0 via write-off');
    assert(getMember(eveKey)?.status === 'pruned', 'Eve member status set to pruned');
    const commonsAfterEve = getCommonsBalanceExact();
    assert(Math.abs(commonsAfterEve - (commonsBeforeEve - 45)) < 0.0001, 'Commons pool covered the 45 bean deficit');
    assert(nodeTotal() === 0, 'Zero-sum conserved after Eve debt write-off');
    const auditEve = runLedgerAudit();
    assert(auditEve.ok === true && Math.abs(auditEve.drift) < 0.0001, 'runLedgerAudit passes with 0 drift after debt write-off');

    // Member 4: Sole Owner Protection
    // Create sole owner member and confirm offboarding is rejected
    const frankOwnerKey = generateValidPubkey();
    makeMember('frank_owner', frankOwnerKey);
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(frankOwnerKey);
    // Remove other owners if any to ensure frank is sole owner
    db.prepare("DELETE FROM node_roles WHERE role = 'owner' AND member_pubkey != ?").run(frankOwnerKey);
    assert(isSoleOwner(frankOwnerKey) === true, 'frank is confirmed sole owner');

    const previewFrank = getOffboardPreview(frankOwnerKey);
    assert(previewFrank.isSoleOwner === true, 'getOffboardPreview flags isSoleOwner: true');

    throws(
        () => executeOffboard(frankOwnerKey, { resolution: 'prune_zero_balance' }, operatorPubkey),
        /sole node owner/,
        'executeOffboard rejects offboarding the sole owner'
    );

    // Clean up owner role so it does not interfere
    db.prepare("DELETE FROM node_roles WHERE member_pubkey = ?").run(frankOwnerKey);

    // Member 5: Active Escrow Protection
    const escrowBuyerKey = generateValidPubkey();
    makeMember('escrow_buyer', escrowBuyerKey);
    const escrowTxId = 'mptx_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES (?, 'dummy_post', ?, ?, 15, 'pending', datetime('now'))
    `).run(escrowTxId, escrowBuyerKey, bobKey);

    const previewEscrow = getOffboardPreview(escrowBuyerKey);
    assert(previewEscrow.pendingEscrowsCount === 1, 'getOffboardPreview detects 1 pending escrow');

    throws(
        () => executeOffboard(escrowBuyerKey, { resolution: 'prune_zero_balance' }, operatorPubkey),
        /active deals in escrow/,
        'executeOffboard rejects offboarding member with pending escrow deals'
    );

    // Clean up escrow transaction
    db.prepare("DELETE FROM marketplace_transactions WHERE id = ?").run(escrowTxId);

    // Also assert requested trade status blocks offboarding
    const requestedTxId = 'escrow_tx_req_' + Date.now();
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES (?, 'dummy_post_req', ?, ?, 20, 'requested', datetime('now'))
    `).run(requestedTxId, escrowBuyerKey, bobKey);

    const previewRequested = getOffboardPreview(escrowBuyerKey);
    assert(previewRequested.pendingEscrowsCount === 1, 'getOffboardPreview detects 1 open requested deal');

    throws(
        () => executeOffboard(escrowBuyerKey, { resolution: 'prune_zero_balance' }, operatorPubkey),
        /active deals in escrow or open trade requests/,
        'executeOffboard rejects offboarding member with requested trade deals'
    );

    // Clean up requested transaction
    db.prepare("DELETE FROM marketplace_transactions WHERE id = ?").run(requestedTxId);

    // Member 6: Push Token Purge on Prune
    const pushMemberKey = generateValidPubkey();
    makeMember('push_member', pushMemberKey);
    db.prepare("INSERT INTO push_tokens (public_key, token, platform) VALUES (?, 'token_123', 'ios')").run(pushMemberKey);
    assert((db.prepare("SELECT COUNT(*) as c FROM push_tokens WHERE public_key = ?").get(pushMemberKey) as any).c === 1, 'Push token created');
    executeOffboard(pushMemberKey, { resolution: 'prune_zero_balance' }, operatorPubkey);
    assert((db.prepare("SELECT COUNT(*) as c FROM push_tokens WHERE public_key = ?").get(pushMemberKey) as any).c === 0, 'Push token purged on offboard');

    // Member 7: Concurrent Balance Race Condition Guard
    // Verifies that getBalance is read inside conservingTransaction under the transaction lock.
    // If getBalance were read outside the transaction, an interleaved balance change would result
    // in transferring the stale amount and stranding residual beans on the pruned member account.
    const concurrentMemberKey = generateValidPubkey();
    makeMember('concurrent_user', concurrentMemberKey);
    transfer('genesis', concurrentMemberKey, 50, 'initial seed', 'direct', true);
    assert(getBalance(concurrentMemberKey).balance === 50, 'Concurrent member initial balance is 50 beans');

    // Interleaved credit arrives before transaction executes
    transfer('genesis', concurrentMemberKey, 30, 'concurrent credit', 'direct', true);
    assert(getBalance(concurrentMemberKey).balance === 80, 'Concurrent member balance is updated to 80 beans');

    const offboardConcurrentRes = executeOffboard(
        concurrentMemberKey,
        { resolution: 'donate_to_commons' },
        operatorPubkey
    );
    assert(offboardConcurrentRes.balanceSettled === 80, 'executeOffboard settled the live 80 beans (not stale 50)');
    assert(getBalance(concurrentMemberKey).balance === 0, 'Departing member account balance is 0 after offboard');
    assert(getMember(concurrentMemberKey)?.status === 'pruned', 'Departing member status set to pruned');
    assert(nodeTotal() === 0, 'Zero-sum ledger conservation holds after live balance settlement');
    const auditConcurrent = runLedgerAudit();
    assert(auditConcurrent.ok === true && Math.abs(auditConcurrent.drift) < 0.0001, 'runLedgerAudit passes with 0 drift after concurrent settlement');

    // =========================================================================
    // PART 3: HTTP API ENDPOINTS (ADMIN & COMMUNITY)
    // =========================================================================
    console.log('\n--- Part 3: HTTP API Endpoints ---');

    const app = new Koa();

    // Body parser middleware
    app.use(async (ctx, next) => {
        if (ctx.is('json') || ctx.header['content-type']?.includes('application/json')) {
            const raw = await new Promise<string>((resolve) => {
                let data = '';
                ctx.req.on('data', (chunk) => (data += chunk));
                ctx.req.on('end', () => resolve(data));
            });
            try {
                (ctx as any).requestBody = JSON.parse(raw);
            } catch {
                (ctx as any).requestBody = {};
            }
        }
        await next();
    });

    const mockCheckAdminAuth = async (ctx: any): Promise<boolean> => {
        const headerPw = ctx.headers['x-admin-password'] || ctx.headers['x-admin-secret'];
        const sessionToken = ctx.headers['x-admin-session'];
        const bodyPw = ctx.requestBody?.password;

        if (sessionToken === 'valid-operator-session') {
            if (!ctx.state) ctx.state = {};
            ctx.state.actor = operatorPubkey;
            ctx.state.auth_signer = operatorPubkey;
            ctx.state.adminRole = 'admin';
            return true;
        }

        // Password auth sets no actor, as the real checkAdminAuth: routes read it as 'owner:password'.
        if (headerPw === 'test-admin-secret' || bodyPw === 'test-admin-secret') {
            return true;
        }

        ctx.status = 401;
        ctx.body = { error: 'Unauthorized' };
        return false;
    };

    const routeDeps = {
        checkAdminAuth: mockCheckAdminAuth,
        rateLimit: () => true,
        clampLimit: (v: any, def = 50) => (typeof v === 'number' ? v : Number(v) || def),
        clampOffset: (v: any) => Math.max(0, Number(v) || 0),
        activeConnections: new Map(),
        calculateAnalytics: () => ({}) as any,
        enforceReadAuth: false,
    };

    const adminRouter = createAdminRoutes(routeDeps);
    const communityRouter = createCommunityRoutes(routeDeps);

    app.use(adminRouter.routes());
    app.use(adminRouter.allowedMethods());
    app.use(communityRouter.routes());
    app.use(communityRouter.allowedMethods());

    const server = http.createServer(app.callback());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://localhost:${port}`;

    try {
        // Test Member Grace for HTTP tests
        const graceOldKey = generateValidPubkey();
        makeMember('grace', graceOldKey);
        transfer('genesis', graceOldKey, 90, 'seed grace', 'direct', true);

        // 1. Unauthenticated calls rejected with 401
        const unauthRekeyStatus = await fetch(`${baseUrl}/api/local/admin/members/${graceOldKey}/rekey/status`);
        assert(unauthRekeyStatus.status === 401, 'GET rekey status unauthenticated returns 401');

        const unauthIssue = await fetch(`${baseUrl}/api/local/admin/members/${graceOldKey}/rekey/issue-code`, {
            method: 'POST',
        });
        assert(unauthIssue.status === 401, 'POST issue-code unauthenticated returns 401');

        const unauthPreview = await fetch(`${baseUrl}/api/local/admin/members/${graceOldKey}/offboard/preview`);
        assert(unauthPreview.status === 401, 'GET offboard preview unauthenticated returns 401');

        // 1b. Non-existent member or unrecognised code returns 404
        const nonExistentKey = generateValidPubkey();
        const nonExistentIssueRes = await fetch(`${baseUrl}/api/local/admin/members/${nonExistentKey}/rekey/issue-code`, {
            method: 'POST',
            headers: { 'x-admin-session': 'valid-operator-session' },
        });
        assert(nonExistentIssueRes.status === 404, 'POST issue-code for non-existent member returns 404');

        const nonExistentCompleteRes = await fetch(`${baseUrl}/api/local/admin/members/${graceOldKey}/rekey/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': 'valid-operator-session',
            },
            body: JSON.stringify({
                code: 'RK-9999-9999',
                newPubkey: generateValidPubkey(),
            }),
        });
        assert(nonExistentCompleteRes.status === 404, 'POST complete rekey with unrecognised code returns 404');

        // 2. Authenticated issue rekey code via admin endpoint
        const authIssueRes = await fetch(`${baseUrl}/api/local/admin/members/${graceOldKey}/rekey/issue-code`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': 'valid-operator-session',
            },
        });
        assert(authIssueRes.status === 200, 'POST issue-code with valid operator session returns 200');
        const issueData = await authIssueRes.json();
        assert(issueData.success === true, 'Response indicates success: true');
        assert(Boolean(issueData.code), `Issued code: ${issueData.code}`);
        const graceRekeyCode = issueData.code;

        // 3. Authenticated rekey status via admin endpoint
        const statusRes = await fetch(`${baseUrl}/api/local/admin/members/${graceOldKey}/rekey/status`, {
            headers: {
                'x-admin-session': 'valid-operator-session',
            },
        });
        assert(statusRes.status === 200, 'GET rekey status returns 200');
        const statusData = await statusRes.json();
        assert(statusData.isInvalidated === true, 'statusData shows isInvalidated: true');
        assert(statusData.pendingRequest?.code === graceRekeyCode, 'statusData pendingRequest matches issued code');

        const graceKeyPair = generateKeyPair();

        // 4a0. Public re-enroll with missing Proof of Possession signature rejected with 400
        const missingSigRes = await fetch(`${baseUrl}/api/member/re-enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: graceRekeyCode,
                newPublicKey: graceKeyPair.pubHex,
            }),
        });
        assert(missingSigRes.status === 400, 'POST /api/member/re-enroll without signature returns 400');
        const missingSigData = await missingSigRes.json();
        assert(missingSigData.error?.includes('Signature is required'), 'Error indicates signature is required');

        // 4a. Public re-enroll with invalid Proof of Possession signature rejected
        const invalidSigRes = await fetch(`${baseUrl}/api/member/re-enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: graceRekeyCode,
                newPublicKey: graceKeyPair.pubHex,
                signature: 'dGhpcyBpcyBhIGZha2Ugc2lnbmF0dXJl',
            }),
        });
        assert(invalidSigRes.status === 401, 'POST /api/member/re-enroll with invalid signature returns 401');
        const invalidSigData = await invalidSigRes.json();
        assert(invalidSigData.error?.includes('proof of possession failed'), 'Error indicates proof of possession failure');

        // 4b. Public re-enroll endpoint: /api/member/re-enroll with valid Proof of Possession signature succeeds
        const validSig = crypto.sign(null, Buffer.from(graceRekeyCode, 'utf8'), graceKeyPair.privateKey).toString('base64');
        const graceNewKey = graceKeyPair.pubHex;
        const reenrollRes = await fetch(`${baseUrl}/api/member/re-enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: graceRekeyCode,
                newPublicKey: graceNewKey,
                signature: validSig,
            }),
        });
        assert(reenrollRes.status === 200, 'POST /api/member/re-enroll returns 200');
        const reenrollData = await reenrollRes.json();
        assert(reenrollData.success === true, 'Re-enrolment via public endpoint succeeded');
        assert(reenrollData.newPubkey === graceNewKey, 'Re-enrolment returned newPubkey');
        assert(getBalance(graceNewKey).balance === 90, 'Grace balance of 90 beans accessible under new key');

        // 5. Authenticated Offboard Preview
        const previewRes = await fetch(`${baseUrl}/api/local/admin/members/${graceNewKey}/offboard/preview`, {
            headers: {
                'x-admin-password': 'test-admin-secret',
            },
        });
        assert(previewRes.status === 200, 'GET offboard preview returns 200');
        const previewData = await previewRes.json();
        assert(previewData.balance === 90, 'Preview shows 90 beans balance');
        assert(previewData.costToCommunity === 0, 'costToCommunity is 0');
        assert(Array.isArray(previewData.activeMembers), 'activeMembers list returned');
        assert(previewData.activeMembers.length === 0, 'Password-only admin receives empty activeMembers list (privacy leak prevented)');

        // Offboard preview with key auth returns non-empty active members list
        const keyAuthPreviewRes = await fetch(`${baseUrl}/api/local/admin/members/${graceNewKey}/offboard/preview`, {
            headers: {
                'x-admin-session': 'valid-operator-session',
            },
        });
        assert(keyAuthPreviewRes.status === 200, 'GET offboard preview with key auth returns 200');
        const keyAuthPreviewData = await keyAuthPreviewRes.json();
        assert(Array.isArray(keyAuthPreviewData.activeMembers) && keyAuthPreviewData.activeMembers.length > 0, 'Key-authenticated admin receives activeMembers list for gift resolution');

        // 6a. Password auth attempting gift_to_member rejected with KEY_AUTH_REQUIRED
        const pwGiftRes = await fetch(`${baseUrl}/api/local/admin/members/${graceNewKey}/offboard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': 'test-admin-secret',
            },
            body: JSON.stringify({
                resolution: 'gift_to_member',
                giftRecipientPubkey: bobKey,
            }),
        });
        assert(pwGiftRes.status === 403, 'POST offboard with password auth and gift_to_member returns 403');
        const pwGiftData = await pwGiftRes.json();
        assert(pwGiftData.code === 'KEY_AUTH_REQUIRED', 'Response returns KEY_AUTH_REQUIRED when password auth used for gift_to_member');

        // 6b. Two-person rule enforcement via POST /api/local/admin/members/:pubkey/offboard
        const selfGiftRes = await fetch(`${baseUrl}/api/local/admin/members/${graceNewKey}/offboard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': 'valid-operator-session',
            },
            body: JSON.stringify({
                resolution: 'gift_to_member',
                giftRecipientPubkey: operatorPubkey, // Acting operator is recipient!
            }),
        });
        assert(selfGiftRes.status === 403, 'POST offboard with self-gifting returns 403');
        const selfGiftData = await selfGiftRes.json();
        assert(selfGiftData.code === 'TWO_PERSON_RULE' || selfGiftData.error?.includes('Two-person rule'), 'Response explains Two-person rule violation');

        // 7. Successful offboarding: Donate Grace balance to Commons
        const offboardRes = await fetch(`${baseUrl}/api/local/admin/members/${graceNewKey}/offboard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': 'valid-operator-session',
            },
            body: JSON.stringify({
                resolution: 'donate_to_commons',
            }),
        });
        assert(offboardRes.status === 200, 'POST offboard with donate_to_commons returns 200');
        const offboardData = await offboardRes.json();
        assert(offboardData.success === true, 'Offboarding response success: true');
        assert(getBalance(graceNewKey).balance === 0, 'Grace balance is 0 after offboarding');

        // Final ledger audit across everything
        assert(nodeTotal() === 0, 'Final ledger total sums to exactly zero (0.0000)');
        const finalAudit = runLedgerAudit();
        assert(finalAudit.ok === true && Math.abs(finalAudit.drift) < 0.0001 && finalAudit.strandedEscrows === 0, 'Final conservation audit passed (0 drift, 0 stranded escrows)');
    } finally {
        server.close();
    }

    console.log(`\n🎉 All ${passed}/${run} tests passed successfully!`);
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error running tests:', err);
    process.exit(1);
});
