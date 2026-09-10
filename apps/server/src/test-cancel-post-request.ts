/**
 * Integration test for Marketplace Cancel Post Request route:
 *   POST /api/marketplace/transactions/cancel-request
 *
 * Verifies parameter validation, requester authorization (for offer & need posts),
 * state transition to 'cancelled', completed_at timestamp, and error conditions.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-cancel-post-request.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8552;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeMember(callsign: string, initialBalance = 100) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url, status)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=', 'active')`
    ).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pubKeyHex, initialBalance);

    // Update audit baseline sum for ledger
    const totalSum = (db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`).get() as any).s;
    db.prepare(`UPDATE node_config SET value = ? WHERE key = 'ledger_audit_baseline'`).run(String(totalSum));
    reconcileLedgerFromDb();

    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signPath = path.split('?')[0];
    const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main() {
    console.log('Running Marketplace Cancel Post Request tests...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const offerAuthor = makeMember('OfferAuthor');
    const offerRequester = makeMember('OfferRequester');
    const needAuthor = makeMember('NeedAuthor');
    const needRequester = makeMember('NeedRequester');
    const stranger = makeMember('Stranger');

    // Make sure members who request offers or create needs have listed an offer post first
    await signedFetch('POST', '/api/marketplace/posts', offerRequester, {
        type: 'offer', category: 'general', title: 'OfferRequester Offer', description: 'Sample offer',
        credits: 5, priceType: 'fixed', authorPublicKey: offerRequester.pubKeyHex,
    });
    await signedFetch('POST', '/api/marketplace/posts', needAuthor, {
        type: 'offer', category: 'general', title: 'NeedAuthor Offer', description: 'Sample offer',
        credits: 5, priceType: 'fixed', authorPublicKey: needAuthor.pubKeyHex,
    });

    // Create an Offer post (OfferAuthor creates, OfferRequester requests -> OfferRequester is buyer)
    const offerPostRes = await signedFetch('POST', '/api/marketplace/posts', offerAuthor, {
        type: 'offer', category: 'general', title: 'Lawn Mowing', description: 'Mow front yard',
        credits: 15, priceType: 'fixed', authorPublicKey: offerAuthor.pubKeyHex,
    });
    assert(offerPostRes.status === 200, 'offer author created a post successfully');
    const offerPostId = offerPostRes.body?.post?.id;
    assert(!!offerPostId, 'offer post ID was returned');

    // Create a Need post (NeedAuthor creates, NeedRequester requests -> NeedAuthor is buyer, NeedRequester is seller)
    const needPostRes = await signedFetch('POST', '/api/marketplace/posts', needAuthor, {
        type: 'need', category: 'general', title: 'Need Math Tutor', description: 'Algebra tutoring',
        credits: 20, priceType: 'fixed', authorPublicKey: needAuthor.pubKeyHex,
    });
    assert(needPostRes.status === 200, 'need author created a post successfully');
    const needPostId = needPostRes.body?.post?.id;
    assert(!!needPostId, 'need post ID was returned');

    // ── 1. Parameter Validation ─────────────────────────────────────────────────
    const missingTxId = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', offerRequester, {
        buyerPublicKey: offerRequester.pubKeyHex,
    });
    assert(missingTxId.status === 400, 'rejects missing transactionId with 400');

    const missingBuyerKey = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', offerRequester, {
        transactionId: 'some-uuid',
    });
    assert(missingBuyerKey.status === 400, 'rejects missing buyerPublicKey with 400');

    // ── 2. Request Offer Post ───────────────────────────────────────────────────
    const reqOfferRes = await signedFetch('POST', '/api/marketplace/posts/request', offerRequester, {
        postId: offerPostId, buyerPublicKey: offerRequester.pubKeyHex,
    });
    assert(reqOfferRes.status === 200 && reqOfferRes.body?.success === true, 'offer requester requested post');
    const offerTxId = reqOfferRes.body?.transaction?.id;
    assert(!!offerTxId, 'offer transaction ID returned');

    // Attempt cancellation by stranger / non-requester (OfferAuthor)
    const strangerCancelOffer = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', stranger, {
        transactionId: offerTxId, buyerPublicKey: stranger.pubKeyHex,
    });
    assert(strangerCancelOffer.status === 400, 'non-requester stranger cannot cancel offer request');

    const authorCancelOffer = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', offerAuthor, {
        transactionId: offerTxId, buyerPublicKey: offerAuthor.pubKeyHex,
    });
    assert(authorCancelOffer.status === 400, 'non-requester post author cannot cancel offer request');

    // Requester cancels request
    const cancelOfferRes = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', offerRequester, {
        transactionId: offerTxId, buyerPublicKey: offerRequester.pubKeyHex,
    });
    assert(cancelOfferRes.status === 200 && cancelOfferRes.body?.success === true, 'offer requester cancelled request');
    assert(cancelOfferRes.body?.transaction?.status === 'cancelled', 'transaction status is cancelled');
    assert(!!cancelOfferRes.body?.transaction?.completedAt, 'completedAt timestamp set');

    // Attempting to cancel already-cancelled request fails
    const reCancelOffer = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', offerRequester, {
        transactionId: offerTxId, buyerPublicKey: offerRequester.pubKeyHex,
    });
    assert(reCancelOffer.status === 400, 'cancelling an already cancelled request fails');

    // ── 3. Request Need Post (Requester is Seller) ─────────────────────────────
    const reqNeedRes = await signedFetch('POST', '/api/marketplace/posts/request', needRequester, {
        postId: needPostId, buyerPublicKey: needRequester.pubKeyHex,
    });
    assert(reqNeedRes.status === 200 && reqNeedRes.body?.success === true, 'need requester requested post');
    const needTxId = reqNeedRes.body?.transaction?.id;
    assert(!!needTxId, 'need transaction ID returned');

    // NeedAuthor (buyer) attempting to cancel request fails because NeedRequester is the seller/requester
    const needAuthorCancel = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', needAuthor, {
        transactionId: needTxId, buyerPublicKey: needAuthor.pubKeyHex,
    });
    assert(needAuthorCancel.status === 400, 'non-requester need author cannot cancel need request');

    // NeedRequester (seller/requester) cancels request
    const cancelNeedRes = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', needRequester, {
        transactionId: needTxId, buyerPublicKey: needRequester.pubKeyHex,
    });
    assert(cancelNeedRes.status === 200 && cancelNeedRes.body?.success === true, 'need requester cancelled request');
    assert(cancelNeedRes.body?.transaction?.status === 'cancelled', 'need transaction status is cancelled');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Marketplace Cancel Post Request tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
