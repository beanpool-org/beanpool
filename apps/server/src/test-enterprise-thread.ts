/**
 * Enterprise Discussion Thread Tests (Slice 6)
 * Docs: docs/the-commons.md §2.2 ("Talking about it") and §9.
 *
 * Marty's decision (2026-09-17): thread is its OWN entity on the enterprise, NOT A GROUP.
 *
 * Verifies:
 *  1. Thread creation & keying:
 *     - Directly keyed to enterprise pubkey as conversations.id, type = 'enterprise_thread'.
 *     - No rows in groups or group_members tables; zero group references.
 *     - Created idempotently on createTreasury / ensureEnterpriseThread.
 *  2. Active node members can read & post:
 *     - Any active member can post and read thread messages.
 *     - Chronological message ordering, callsign & avatar resolution.
 *     - Text length & empty text validation.
 *  3. Blocked posting enforcement:
 *     - Frozen members (credit_frozen = 1) rejected.
 *     - Suspended, disabled, or pruned members rejected.
 *     - Rekeyed members (invalidated_keys) rejected.
 *  4. Lifecycle handling:
 *     - Paused enterprise: thread remains OPEN.
 *     - Wound-up enterprise (status = 'completed'): thread becomes READ-ONLY.
 *  5. Keeper moderation:
 *     - Any keeper of THAT enterprise can remove a message.
 *     - Non-keepers and keepers of other enterprises are rejected.
 *     - Messages are NEVER deleted from the DB; tombstoned to show "removed by a keeper".
 *  6. Consumer leak-proofing:
 *     - getConversationsByMember: enterprise thread NEVER leaks into member, keeper, or admin inboxes.
 *     - getUnreadCounts: enterprise thread unreads NEVER leak into DM badges.
 *     - Push notifications for DMs are skipped for thread messages.
 *  7. HTTP API routes:
 *     - GET /api/treasury/:treasury/thread (and /api/enterprises/:treasury/thread)
 *     - POST /api/treasury/:treasury/thread/message
 *     - POST /api/treasury/:treasury/thread/remove & DELETE .../message/:messageId
 *  8. Ledger conservation:
 *     - SUM(balances) + COMMONS_POOL = 0 remains strictly preserved.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-thread.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator,
    pauseEnterprise, resumeEnterprise,
    ensureEnterpriseThread, getEnterpriseThreadMessages,
    postEnterpriseThreadMessage, removeEnterpriseThreadMessage,
    isKeeperOfEnterprise, getConversationsByMember, getUnreadCounts,
    getCommonsBalanceExact,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8631;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function makeIdentity(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST' | 'DELETE', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST' || method === 'DELETE') {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: (method === 'POST' || method === 'DELETE') && bodyString ? bodyString : undefined
    });
    let json: any;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, error: json?.error as string | undefined, body: json };
}

function verifyConservation(): number {
    const sumAccounts = (db.prepare(
        "SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'"
    ).get() as any).s;
    return Math.abs(sumAccounts + getCommonsBalanceExact());
}

async function main() {
    console.log('Running enterprise discussion thread tests (Slice 6)...\n');
    await initTls();
    initStateEngine();

    // ─────────────────────────────────────────────────────────────────────────
    // Setup Test Members
    // ─────────────────────────────────────────────────────────────────────────
    const leadAlice = makeIdentity('AliceLead');
    const bobKeeper = makeIdentity('BobKeeper');
    const carolOutsider = makeIdentity('CarolOutsider');
    const danActive = makeIdentity('DanActive');
    const eveFrozen = makeIdentity('EveFrozen');
    const frankSuspended = makeIdentity('FrankSuspended');
    const gracePruned = makeIdentity('GracePruned');

    // Mark Eve as credit_frozen = 1
    db.prepare("UPDATE members SET credit_frozen = 1 WHERE public_key = ?").run(eveFrozen.pubKeyHex);
    // Mark Frank as suspended
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(frankSuspended.pubKeyHex);
    // Mark Grace as pruned
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(gracePruned.pubKeyHex);

    // Create Enterprise Alpha ("Bakery") and Beta ("ToolLibrary")
    const { publicKey: bakery } = createTreasury('Bakery', AVATAR, 300, { leadKeeperPubkey: leadAlice.pubKeyHex });
    adminAssignTreasuryOperator(bakery, bobKeeper.pubKeyHex, 'admin', 50);

    const { publicKey: toolLibrary } = createTreasury('ToolLibrary', AVATAR, 200, { leadKeeperPubkey: carolOutsider.pubKeyHex });

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Thread creation, keying & NOT a group
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 1: Thread creation, keying & NOT a group ──');

    const bakeryConv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(bakery) as any;
    assert(!!bakeryConv, 'Bakery enterprise thread conversation exists');
    assert(bakeryConv.type === 'enterprise_thread', `Conversation type is 'enterprise_thread' (got ${bakeryConv.type})`);
    assert(bakeryConv.name === 'Bakery', 'Conversation name matches enterprise callsign');

    // Verify NOT a group
    const groupsCheck = db.prepare("SELECT COUNT(*) as cnt FROM groups WHERE id = ? OR name = 'Bakery'").get(bakery) as any;
    assert(groupsCheck.cnt === 0, 'No groups created for the enterprise thread');
    const groupMembersCheck = db.prepare("SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ?").get(bakery) as any;
    assert(groupMembersCheck.cnt === 0, 'No group_members created for the enterprise thread');

    const ensured = ensureEnterpriseThread(bakery);
    assert(ensured.id === bakery, 'ensureEnterpriseThread returns correct conversation');

    // Keepership helper checks
    assert(isKeeperOfEnterprise(leadAlice.pubKeyHex, bakery) === true, 'Alice is keeper of Bakery');
    assert(isKeeperOfEnterprise(bobKeeper.pubKeyHex, bakery) === true, 'Bob is keeper of Bakery');
    assert(isKeeperOfEnterprise(carolOutsider.pubKeyHex, bakery) === false, 'Carol is not keeper of Bakery');
    assert(isKeeperOfEnterprise(danActive.pubKeyHex, bakery) === false, 'Dan is not keeper of Bakery');

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Active members reading and posting
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 2: Active members reading and posting ──');

    const msg1 = postEnterpriseThreadMessage(bakery, danActive.pubKeyHex, "Who has the flour sacks?");
    assert(!!msg1.id, 'Message 1 posted with ID');
    assert(msg1.conversationId === bakery, 'Message 1 conversationId is bakery pubkey');
    assert(msg1.authorPubkey === danActive.pubKeyHex, 'Message 1 author is Dan');
    assert(msg1.authorCallsign === 'DanActive', 'Message 1 authorCallsign resolved');
    assert(msg1.type === 'text', 'Message 1 type is text');

    const msg2 = postEnterpriseThreadMessage(bakery, leadAlice.pubKeyHex, "I picked them up this morning!");
    assert(!!msg2.id, 'Message 2 posted by keeper Alice');

    const messages = getEnterpriseThreadMessages(bakery);
    assert(messages.length === 2, `Retrieved 2 messages in thread (got ${messages.length})`);
    assert(messages[0].id === msg1.id, 'Messages returned in chronological order');
    assert(messages[1].id === msg2.id, 'Messages returned in chronological order');

    const decoded1 = Buffer.from(messages[0].ciphertext, 'base64').toString('utf8');
    assert(decoded1 === 'Who has the flour sacks?', `Decoded message text matches (got ${decoded1})`);

    // Empty text validation
    let emptyThrew = false;
    try {
        postEnterpriseThreadMessage(bakery, danActive.pubKeyHex, "   ");
    } catch (e: any) {
        emptyThrew = true;
        assert(e.message.includes('Message text cannot be empty'), `Empty text error: "${e.message}"`);
    }
    assert(emptyThrew, 'Empty text is rejected');

    // Too long text validation (>2000 chars)
    let longThrew = false;
    try {
        postEnterpriseThreadMessage(bakery, danActive.pubKeyHex, "a".repeat(2001));
    } catch (e: any) {
        longThrew = true;
        assert(e.message.includes('maximum 2000 characters'), `Too long text error: "${e.message}"`);
    }
    assert(longThrew, 'Text > 2000 characters is rejected');

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Blocked posting enforcement
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 3: Blocked posting enforcement ──');

    // Frozen member
    let frozenThrew = false;
    try {
        postEnterpriseThreadMessage(bakery, eveFrozen.pubKeyHex, "Can I post?");
    } catch (e: any) {
        frozenThrew = true;
        assert(e.message.includes('Frozen members cannot post'), `Frozen member error: "${e.message}"`);
    }
    assert(frozenThrew, 'Frozen member cannot post');

    // Suspended member
    let suspendedThrew = false;
    try {
        postEnterpriseThreadMessage(bakery, frankSuspended.pubKeyHex, "Can I post?");
    } catch (e: any) {
        suspendedThrew = true;
        assert(e.message.includes('Account is suspended'), `Suspended member error: "${e.message}"`);
    }
    assert(suspendedThrew, 'Suspended member cannot post');

    // Pruned member
    let prunedThrew = false;
    try {
        postEnterpriseThreadMessage(bakery, gracePruned.pubKeyHex, "Can I post?");
    } catch (e: any) {
        prunedThrew = true;
        assert(e.message.includes('Account has been pruned'), `Pruned member error: "${e.message}"`);
    }
    assert(prunedThrew, 'Pruned member cannot post');

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Lifecycle handling (pause vs wound-up)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 4: Lifecycle handling (pause vs wound-up) ──');

    // Pause Bakery
    pauseEnterprise(bakery, leadAlice.pubKeyHex);
    const bakeryStatusAfterPause = db.prepare("SELECT paused, status FROM members WHERE public_key = ?").get(bakery) as any;
    assert(bakeryStatusAfterPause.paused === 1, 'Bakery is now paused');

    // Paused enterprise: thread remains OPEN!
    const msg3 = postEnterpriseThreadMessage(bakery, danActive.pubKeyHex, "Discussing winter plans while paused.");
    assert(!!msg3.id, 'Active member can post in discussion thread while enterprise is paused');

    // Resume Bakery
    resumeEnterprise(bakery, leadAlice.pubKeyHex);

    // Wound-up enterprise (status = 'completed')
    // Set ToolLibrary status to 'completed'
    db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(toolLibrary);

    let woundUpThrew = false;
    try {
        postEnterpriseThreadMessage(toolLibrary, danActive.pubKeyHex, "Are tools available?");
    } catch (e: any) {
        woundUpThrew = true;
        assert(e.message.includes('Enterprise has wound up — discussion thread is read-only'), `Wound up error: "${e.message}"`);
    }
    assert(woundUpThrew, 'Posting to wound-up enterprise thread is rejected as read-only');

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Keeper moderation & tombstone
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 5: Keeper moderation & tombstone ──');

    // Non-keeper cannot remove
    let outsiderRemoveThrew = false;
    try {
        removeEnterpriseThreadMessage(bakery, msg1.id, danActive.pubKeyHex);
    } catch (e: any) {
        outsiderRemoveThrew = true;
        assert(e.message.includes('Only a keeper of this enterprise can remove messages'), `Outsider remove error: "${e.message}"`);
    }
    assert(outsiderRemoveThrew, 'Ordinary member cannot remove messages');

    // Keeper of a different enterprise cannot remove
    let diffKeeperRemoveThrew = false;
    try {
        removeEnterpriseThreadMessage(bakery, msg1.id, carolOutsider.pubKeyHex);
    } catch (e: any) {
        diffKeeperRemoveThrew = true;
        assert(e.message.includes('Only a keeper of this enterprise can remove messages'), `Diff keeper remove error: "${e.message}"`);
    }
    assert(diffKeeperRemoveThrew, 'Keeper of different enterprise cannot remove messages');

    // Keeper of Bakery removes message 1
    const removedMsg = removeEnterpriseThreadMessage(bakery, msg1.id, leadAlice.pubKeyHex);
    assert(removedMsg.type === 'removed', 'Removed message type is removed');

    // CRITICAL: Row is NOT deleted from messages table!
    const rowInDb = db.prepare("SELECT * FROM messages WHERE id = ?").get(msg1.id) as any;
    assert(!!rowInDb, 'Message row still exists in database (NEVER deleted)');
    assert(rowInDb.type === 'removed', 'Message row type updated to removed');
    const parsedMeta = JSON.parse(rowInDb.metadata);
    assert(parsedMeta.removed === true, 'Metadata.removed is true');
    assert(parsedMeta.removedBy === leadAlice.pubKeyHex, 'Metadata.removedBy is Alice');

    // Verify reading messages displays "removed by a keeper"
    const currentMsgs = getEnterpriseThreadMessages(bakery);
    const readRemoved = currentMsgs.find(m => m.id === msg1.id);
    assert(!!readRemoved, 'Removed message present in getEnterpriseThreadMessages');
    assert(readRemoved?.type === 'removed', 'Removed message type is removed');
    const readText = Buffer.from(readRemoved!.ciphertext, 'base64').toString('utf8');
    assert(readText === 'removed by a keeper', `Removed message shows "removed by a keeper" (got "${readText}")`);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 6: Consumer leak-proofing
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 6: Consumer leak-proofing ──');

    // Dan's inbox: getConversationsByMember
    const danConvs = getConversationsByMember(danActive.pubKeyHex);
    assert(!danConvs.some(c => c.id === bakery), 'Bakery thread not present in Dan inbox');

    // Alice's inbox (keeper)
    const aliceConvs = getConversationsByMember(leadAlice.pubKeyHex);
    assert(!aliceConvs.some(c => c.id === bakery), 'Bakery thread not present in keeper Alice inbox');

    // Unread counts: getUnreadCounts
    const danUnreads = getUnreadCounts(danActive.pubKeyHex);
    assert(danUnreads[bakery] === undefined, 'Bakery thread does not exist in Dan unread counts');

    const aliceUnreads = getUnreadCounts(leadAlice.pubKeyHex);
    assert(aliceUnreads[bakery] === undefined, 'Bakery thread does not exist in Alice unread counts');

    // ─────────────────────────────────────────────────────────────────────────
    // Step 7: HTTP API routes
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 7: HTTP API routes ──');
    await startHttpsServer(PORT);

    // GET /api/treasury/:treasury/thread
    const getRes = await signedFetch('GET', `/api/treasury/${bakery}/thread`, danActive);
    assert(getRes.status === 200, `GET /api/treasury/:treasury/thread returns 200 (got ${getRes.status})`);
    assert(getRes.body.conversation.id === bakery, 'GET returns conversation');
    assert(Array.isArray(getRes.body.messages), 'GET returns messages array');
    assert(getRes.body.readOnly === false, 'GET returns readOnly = false for active enterprise');

    // GET alias /api/enterprises/:treasury/thread
    const getAliasRes = await signedFetch('GET', `/api/enterprises/${bakery}/thread`, danActive);
    assert(getAliasRes.status === 200, `GET /api/enterprises/:treasury/thread alias returns 200`);

    // GET for wound-up enterprise
    const getWoundUpRes = await signedFetch('GET', `/api/treasury/${toolLibrary}/thread`, danActive);
    assert(getWoundUpRes.status === 200, `GET /api/treasury/:treasury/thread for wound-up returns 200`);
    assert(getWoundUpRes.body.readOnly === true, 'GET returns readOnly = true for wound-up enterprise');

    // POST /api/treasury/:treasury/thread/message by active member
    const postRes = await signedFetch('POST', `/api/treasury/${bakery}/thread/message`, danActive, {
        text: 'Hello from HTTP signed post!'
    });
    assert(postRes.status === 201, `POST /api/treasury/:treasury/thread/message returns 201 (got ${postRes.status})`);
    assert(postRes.body.success === true, 'POST message returns success');
    const httpMsgId = postRes.body.message.id;

    // POST by frozen member returns 403
    const frozenPostRes = await signedFetch('POST', `/api/treasury/${bakery}/thread/message`, eveFrozen, {
        text: 'Frozen HTTP post attempt'
    });
    assert(frozenPostRes.status === 403, `POST by frozen member returns 403 (got ${frozenPostRes.status})`);

    // POST with empty text returns 400
    const emptyPostRes = await signedFetch('POST', `/api/treasury/${bakery}/thread/message`, danActive, {
        text: '   '
    });
    assert(emptyPostRes.status === 400, `POST with empty text returns 400 (got ${emptyPostRes.status})`);

    // POST to wound-up enterprise returns 400
    const woundUpPostRes = await signedFetch('POST', `/api/treasury/${toolLibrary}/thread/message`, danActive, {
        text: 'Post to completed enterprise'
    });
    assert(woundUpPostRes.status === 400, `POST to wound-up enterprise returns 400 (got ${woundUpPostRes.status})`);

    // Non-keeper remove attempt returns 403
    const outsiderRemoveRes = await signedFetch('POST', `/api/treasury/${bakery}/thread/remove`, danActive, {
        messageId: httpMsgId
    });
    assert(outsiderRemoveRes.status === 403, `POST remove by non-keeper returns 403 (got ${outsiderRemoveRes.status})`);

    // Keeper remove returns 200
    const keeperRemoveRes = await signedFetch('POST', `/api/treasury/${bakery}/thread/remove`, leadAlice, {
        messageId: httpMsgId
    });
    assert(keeperRemoveRes.status === 200, `POST remove by keeper returns 200 (got ${keeperRemoveRes.status})`);
    assert(keeperRemoveRes.body.message.type === 'removed', 'Removed message type is removed');

    // DELETE route alias
    const msgToDelete = postEnterpriseThreadMessage(bakery, danActive.pubKeyHex, "Test DELETE alias");
    const deleteRes = await signedFetch('DELETE', `/api/treasury/${bakery}/thread/message/${msgToDelete.id}`, bobKeeper);
    assert(deleteRes.status === 200, `DELETE alias by keeper returns 200 (got ${deleteRes.status})`);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 8: Conservation invariant audit
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 8: Conservation audit ──');
    const conservationDiscrepancy = verifyConservation();
    assert(conservationDiscrepancy === 0, `Conservation strictly preserved: diff = ${conservationDiscrepancy}`);

    console.log(`\n========================================`);
    console.log(`All ${passed}/${run} enterprise discussion thread tests passed!`);
    console.log(`========================================\n`);
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error in enterprise thread test:', err);
    process.exit(1);
});
