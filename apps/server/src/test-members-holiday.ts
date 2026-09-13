/**
 * Integration test for Members Holiday Mode route (#143):
 *   POST /api/members/holiday
 *
 * Verifies authentication, enabling/disabling holiday mode when no open trades exist,
 * and rejection when open trades are in progress.
 *
 * Run with:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-members-holiday.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createPost, requestPost, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8552;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function makeMember(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url, status)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=', 'active')`
    ).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(
    method: 'GET' | 'POST',
    path: string,
    id?: { pubKeyHex: string; privateKey: crypto.KeyObject },
    body?: any
) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};

    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signPath = path.split('?')[0];
        const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }

    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: method === 'POST' ? bodyString : undefined,
    });
    let json: any;
    try {
        json = await res.json();
    } catch {
        /* ignore */
    }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main() {
    console.log('Running Members Holiday Mode integration tests...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const alice = makeMember('alice_hol');
    const bob = makeMember('bob_hol');
    reconcileLedgerFromDb();

    // ── 1. Unsigned Request Rejection ──────────────────────────────────────────
    const unsignedRes = await signedFetch('POST', '/api/members/holiday', undefined, { enabled: true });
    assert(unsignedRes.status === 401, 'unsigned POST /api/members/holiday is rejected with 401');

    // ── 2. Enable Holiday Mode (No Open Trades) ───────────────────────────────
    const enableRes = await signedFetch('POST', '/api/members/holiday', alice, { enabled: true });
    assert(enableRes.status === 200, 'signed POST /api/members/holiday { enabled: true } returns 200');
    assert(enableRes.body?.success === true, 'response indicates success === true');
    assert(enableRes.body?.enabled === true, 'response indicates enabled === true');
    assert(enableRes.body?.openTrades === 0, 'response indicates openTrades === 0');

    // ── 3. Disable Holiday Mode ────────────────────────────────────────────────
    const disableRes = await signedFetch('POST', '/api/members/holiday', alice, { enabled: false });
    assert(disableRes.status === 200, 'signed POST /api/members/holiday { enabled: false } returns 200');
    assert(disableRes.body?.enabled === false, 'response indicates enabled === false');

    // ── 4. Block Holiday Mode when Open Trades Exist ───────────────────────────
    // Create an offer as Bob (satisfying Gate 1 requirement for Bob)
    const bobPost = createPost(
        'offer',
        'general',
        'Lawn Mowing',
        'Mow your lawn',
        15,
        'fixed',
        bob.pubKeyHex
    );
    assert(!!bobPost, 'bob offer created successfully');

    // Create an offer as Alice and request it as Bob to create an in-flight trade
    const alicePost = createPost(
        'offer',
        'general',
        'Garden Help',
        'Help in the garden',
        10,
        'fixed',
        alice.pubKeyHex
    );
    assert(!!alicePost, 'alice offer created successfully');

    if (alicePost) {
        requestPost(alicePost.id, bob.pubKeyHex);
    }

    const blockedRes = await signedFetch('POST', '/api/members/holiday', alice, { enabled: true });
    assert(blockedRes.status === 400, 'POST /api/members/holiday with open trade returns 400');
    assert(blockedRes.body?.openTrades === 1, 'response includes openTrades === 1');
    assert(typeof blockedRes.error === 'string' && blockedRes.error.includes('active trade'), 'error message describes open trade requirement');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Members Holiday Mode integration tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
