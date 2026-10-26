/**
 * Deals S3a: home-answer and transaction read tests.
 *
 * Verifies:
 * - A Need's author is alerted for a request, the helper is not.
 * - A lender is alerted for a borrow request, the borrower is not.
 * - A payee is not "waiting on you" (only the payer can release).
 * - The transaction read carries postType, postAuthorPublicKey, postRepeatable, postLendable.
 * - ETag changes when transaction listing fields change.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-home-deal-step.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let PORT = 0;
let BASE = '';
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

function makeMember(callsign: string, initialBalance = 100) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, status)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')`
    ).run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pubKeyHex, initialBalance);

    const totalSum = (db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`).get() as any).s;
    db.prepare(`UPDATE node_config SET value = ? WHERE key = 'ledger_audit_baseline'`).run(String(totalSum));
    reconcileLedgerFromDb();

    return { pubKeyHex, privateKey, callsign };
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
    let json: any;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, headers: res.headers, json };
}

async function main() {
    console.log('=== Deals S3a: Home answer and transaction read tests ===');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const alice = makeMember('DealAlice', 100);
    const bob = makeMember('DealBob', 100);
    const carol = makeMember('DealCarol', 100);

    // ── Case 1: Need request — author alerted, helper not ──────────────────────
    console.log('\n── Case 1: Need request ──');
    const needId = 'post-need-s3a';
    db.prepare(`
        INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, repeatable, lendable)
        VALUES (?, 'need', 'general', 'Garden help needed', 'Need weeding help', 15, ?, 1, 'active', 0, 0)
    `).run(needId, alice.pubKeyHex);

    // On a Need: buyer is author (Alice, payer of beans), seller is helper (Bob, payee)
    const needTxId = 'tx-need-s3a';
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES (?, ?, ?, ?, 15, 'requested', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(needTxId, needId, alice.pubKeyHex, bob.pubKeyHex);

    const aliceHome1 = await signedFetch('GET', '/api/home?cards=needs,deals', alice);
    const bobHome1 = await signedFetch('GET', '/api/home?cards=needs,deals', bob);

    const aliceNeedItem = aliceHome1.json?.cards?.needs?.items?.find((i: any) => i.kind === 'deal');
    assert(!!aliceNeedItem, "Need's author (Alice) receives a deal alert in Needs you");
    assert(aliceHome1.json?.cards?.deals?.waiting >= 1, "Need's author sees waiting deal count >= 1");
    const aliceNeedDealRow = aliceHome1.json?.cards?.deals?.items?.find((d: any) => d.txId === needTxId);
    assert(aliceNeedDealRow?.waitsOnMe === true, "Need's author has waitsOnMe === true");

    const bobNeedItem = bobHome1.json?.cards?.needs?.items?.find((i: any) => i.kind === 'deal');
    assert(!bobNeedItem, 'Helper (Bob) does NOT receive a deal alert in Needs you');
    const bobNeedDealRow = bobHome1.json?.cards?.deals?.items?.find((d: any) => d.txId === needTxId);
    assert(bobNeedDealRow?.waitsOnMe === false, 'Helper has waitsOnMe === false');

    // ── Case 2: Lendable Offer request — lender alerted, borrower not ───────────
    console.log('\n── Case 2: Lendable Offer request ──');
    const lendId = 'post-lend-s3a';
    db.prepare(`
        INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, repeatable, lendable)
        VALUES (?, 'offer', 'tools', 'Lawn mower to lend', 'Electric mower', 5, ?, 1, 'active', 1, 1)
    `).run(lendId, alice.pubKeyHex);

    // On a lendable Offer: buyer is borrower (Bob, payer), seller is lender (Alice, payee/author)
    const lendTxId = 'tx-lend-s3a';
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES (?, ?, ?, ?, 5, 'requested', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(lendTxId, lendId, bob.pubKeyHex, alice.pubKeyHex);

    const aliceHome2 = await signedFetch('GET', '/api/home?cards=needs,deals', alice);
    const bobHome2 = await signedFetch('GET', '/api/home?cards=needs,deals', bob);

    const aliceLendDealRow = aliceHome2.json?.cards?.deals?.items?.find((d: any) => d.txId === lendTxId);
    assert(aliceLendDealRow?.waitsOnMe === true, 'Lender (Alice) has waitsOnMe === true for borrow request');

    const bobLendDealRow = bobHome2.json?.cards?.deals?.items?.find((d: any) => d.txId === lendTxId);
    assert(bobLendDealRow?.waitsOnMe === false, 'Borrower (Bob) has waitsOnMe === false for borrow request');
    assert(bobHome2.json?.cards?.deals?.waiting === 0, 'Borrower has 0 waiting deals');

    // ── Case 3: Payee is not "waiting on you" ──────────────────────────────────
    console.log('\n── Case 3: Payee is not waiting on you ──');
    const offerId = 'post-offer-s3a';
    db.prepare(`
        INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, repeatable, lendable)
        VALUES (?, 'offer', 'food', 'Sourdough bread', 'Fresh loaf', 4, ?, 1, 'active', 0, 0)
    `).run(offerId, carol.pubKeyHex);

    // Pending deal: Alice is buyer/payer, Carol is seller/payee
    const pendTxId = 'tx-pend-s3a';
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES (?, ?, ?, ?, 4, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(pendTxId, offerId, alice.pubKeyHex, carol.pubKeyHex);

    const carolHome3 = await signedFetch('GET', '/api/home?cards=needs,deals', carol);
    const aliceHome3 = await signedFetch('GET', '/api/home?cards=needs,deals', alice);

    const carolPendRow = carolHome3.json?.cards?.deals?.items?.find((d: any) => d.txId === pendTxId);
    assert(carolPendRow?.waitsOnMe === false, 'Payee (Carol) has waitsOnMe === false for pending deal');
    assert(carolHome3.json?.cards?.deals?.waiting === 0, 'Payee has waiting === 0');
    assert(!carolHome3.json?.cards?.needs?.items?.some((i: any) => i.kind === 'deal'), 'Payee has no deal in Needs you');

    const alicePendRow = aliceHome3.json?.cards?.deals?.items?.find((d: any) => d.txId === pendTxId);
    assert(alicePendRow?.waitsOnMe === true, 'Payer (Alice) has waitsOnMe === true for pending deal');

    // ── Case 4: Transaction read fields and ETag ──────────────────────────────
    console.log('\n── Case 4: Transaction read fields and ETag ──');
    const txRes1 = await signedFetch('GET', `/api/marketplace/transactions?publicKey=${alice.pubKeyHex}`, alice);
    assert(txRes1.status === 200, `Transactions read status 200 (got ${txRes1.status})`);
    const txList1 = txRes1.json as any[];
    assert(Array.isArray(txList1) && txList1.length >= 3, 'Transactions list returned');

    const lendTxRead = txList1.find(t => t.id === lendTxId);
    assert(!!lendTxRead, 'Lend transaction found in transactions read');
    assert(lendTxRead?.postType === 'offer', `Transaction has postType 'offer' (got ${lendTxRead?.postType})`);
    assert(lendTxRead?.postAuthorPublicKey === alice.pubKeyHex, `Transaction has postAuthorPublicKey (got ${lendTxRead?.postAuthorPublicKey})`);
    assert(lendTxRead?.postRepeatable === true, `Transaction has postRepeatable true (got ${lendTxRead?.postRepeatable})`);
    assert(lendTxRead?.postLendable === true, `Transaction has postLendable true (got ${lendTxRead?.postLendable})`);

    const needTxRead = txList1.find(t => t.id === needTxId);
    assert(needTxRead?.postType === 'need', `Need transaction has postType 'need' (got ${needTxRead?.postType})`);
    assert(needTxRead?.postAuthorPublicKey === alice.pubKeyHex, `Need transaction has postAuthorPublicKey (got ${needTxRead?.postAuthorPublicKey})`);

    const etag1 = txRes1.headers.get('etag');
    assert(!!etag1, `Transaction read returns ETag (got ${etag1})`);

    // Changing a post's lendable property changes the ETag
    db.prepare('UPDATE posts SET lendable = 0 WHERE id = ?').run(lendId);
    const txRes2 = await signedFetch('GET', `/api/marketplace/transactions?publicKey=${alice.pubKeyHex}`, alice);
    const etag2 = txRes2.headers.get('etag');
    assert(etag1 !== etag2, `ETag changes when post listing property changes (${etag1} !== ${etag2})`);
    const lendTxReadAfter = (txRes2.json as any[]).find(t => t.id === lendTxId);
    assert(lendTxReadAfter?.postLendable === false, 'Updated postLendable reflects in transaction read');

    console.log(`\nResults: ${passed}/${run} checks passed.`);
    if (passed === run) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal in test-home-deal-step:', err);
    process.exit(1);
});
