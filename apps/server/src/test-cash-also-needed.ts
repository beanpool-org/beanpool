/**
 * "Cash also needed" listing flag (#108) against the REAL server.
 *
 * Beans work for the spare-time/skills/surplus economy, where the marginal cost is ~zero. Real jobs
 * sometimes carry a genuine cash outlay — fuel to get there, consumables used up doing the work — and
 * until now there was nowhere to say so except paragraph three of a description.
 *
 * The flag is deliberately a BOOLEAN WITH NO AMOUNT. The app can escrow beans; it cannot escrow cash,
 * and a structured figure would imply it holds or settles money it never touches. Terms live in chat.
 *
 * These checks pin the four acceptance criteria:
 *
 *   1. Listings carry the flag and it round-trips through the API.
 *   2. The beans-only filter works (the main thing the flag buys — no ambush).
 *   3. Editing can set and clear it.
 *   4. It is unavailable to cross-node reach: cash cannot travel, so a peer node never sees a
 *      cash-flagged listing.
 *
 * MUST run with ENABLE_PEER_CONNECTORS=true. getPeerOrigins() short-circuits to [] unless peer
 * connectors are enabled, and that flag is a module-level const evaluated at IMPORT time — ES module
 * imports are hoisted above the module body, so assigning process.env here would be too late. Same
 * reason test-messaging-idor.ts takes ENFORCE_READ_AUTH from the environment.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-cash-also-needed.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { addConnector } from './connector-manager.js';

const PORT = 8550;
const BASE = `https://localhost:${PORT}`;
const PEER_ORIGIN = 'https://byron.beanpool.org';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** A member complete enough to post: profile fields + a listed Offer for the need covenant. */
function makeAuthor(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=')`
    ).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any, extraHeaders?: Record<string, string>) {
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
        ...(extraHeaders || {}),
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

const post = (title: string, cashAlsoNeeded: boolean) => ({
    type: 'offer', category: 'general', title, description: 'test listing',
    credits: 20, priceType: 'fixed', cashAlsoNeeded,
});

async function main() {
    console.log('Running "cash also needed" flag tests (#108)...\n');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — the peer-reach checks need getPeerOrigins() live');
    }
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const author = makeAuthor('cashtester');

    // ── 1. The flag round-trips ─────────────────────────────────────────────────
    const cashPost = await signedFetch('POST', '/api/marketplace/posts', author,
        { ...post('Fence repair, bring timber money', true), authorPublicKey: author.pubKeyHex });
    assert(cashPost.status === 200, `a cash-flagged listing is created (got ${cashPost.status} ${cashPost.error ?? ''})`);
    assert(cashPost.body?.post?.cashAlsoNeeded === true, 'the created listing reports cashAlsoNeeded: true');

    const beanPost = await signedFetch('POST', '/api/marketplace/posts', author,
        { ...post('Guitar lessons', false), authorPublicKey: author.pubKeyHex });
    assert(beanPost.status === 200, `a beans-only listing is created (got ${beanPost.status} ${beanPost.error ?? ''})`);
    assert(beanPost.body?.post?.cashAlsoNeeded === false, 'a listing without the flag reports false, not undefined');

    const cashId = cashPost.body.post.id;
    const beanId = beanPost.body.post.id;

    // No amount field is accepted or echoed — the app must not imply it settles money.
    assert(
        !('cashAmount' in (cashPost.body.post || {})) && !('cash_amount' in (cashPost.body.post || {})),
        'no cash AMOUNT is stored or returned — flag only, terms live in chat',
    );

    // ── 2. The beans-only filter — the main thing the flag buys ─────────────────
    const all = await signedFetch('GET', '/api/marketplace/posts', author);
    const allIds = (all.body as any[]).map(p => p.id);
    assert(allIds.includes(cashId) && allIds.includes(beanId), 'unfiltered browse shows both listings');

    const only = await signedFetch('GET', '/api/marketplace/posts?beansOnly=true', author);
    const onlyIds = (only.body as any[]).map(p => p.id);
    assert(!onlyIds.includes(cashId), 'beansOnly=true HIDES the cash-flagged listing');
    assert(onlyIds.includes(beanId), 'beansOnly=true still shows the beans-only listing');

    // ── 3. Editing sets and clears it ───────────────────────────────────────────
    const cleared = await signedFetch('POST', '/api/marketplace/posts/update', author,
        { id: cashId, authorPublicKey: author.pubKeyHex, cashAlsoNeeded: false });
    assert(cleared.status === 200, `the flag can be cleared by edit (got ${cleared.status} ${cleared.error ?? ''})`);
    const afterClear = await signedFetch('GET', `/api/marketplace/posts?id=${cashId}`, author);
    assert((afterClear.body as any[])[0]?.cashAlsoNeeded === false, 'the cleared flag reads back as false');

    const reset = await signedFetch('POST', '/api/marketplace/posts/update', author,
        { id: cashId, authorPublicKey: author.pubKeyHex, cashAlsoNeeded: true });
    assert(reset.status === 200, 'the flag can be set again by edit');
    assert(
        ((await signedFetch('GET', `/api/marketplace/posts?id=${cashId}`, author)).body as any[])[0]?.cashAlsoNeeded === true,
        'the re-set flag reads back as true',
    );

    // A stringified payload must still be able to CLEAR the flag. "false" is truthy in JS, so a
    // naive `updates.cashAlsoNeeded ? 1 : 0` would silently keep it set forever.
    const strCleared = await signedFetch('POST', '/api/marketplace/posts/update', author,
        { id: cashId, authorPublicKey: author.pubKeyHex, cashAlsoNeeded: 'false' });
    assert(strCleared.status === 200, `a stringified update is accepted (got ${strCleared.status})`);
    assert(
        ((await signedFetch('GET', `/api/marketplace/posts?id=${cashId}`, author)).body as any[])[0]?.cashAlsoNeeded === false,
        'the string "false" CLEARS the flag — not treated as truthy',
    );
    // Put it back for the cross-node checks below.
    await signedFetch('POST', '/api/marketplace/posts/update', author,
        { id: cashId, authorPublicKey: author.pubKeyHex, cashAlsoNeeded: 'true' });
    assert(
        ((await signedFetch('GET', `/api/marketplace/posts?id=${cashId}`, author)).body as any[])[0]?.cashAlsoNeeded === true,
        'the string "true" SETS the flag',
    );

    // ── 4. Cash cannot travel: a peer node never sees a cash-flagged listing ────
    // Remote browsing hits this same public endpoint, so the peer Origin is the signal.
    addConnector('byron.beanpool.org', 'peer', 'Byron', PEER_ORIGIN);

    const asPeer = await fetch(`${BASE}/api/marketplace/posts`, { headers: { Origin: PEER_ORIGIN } });
    const peerIds = ((await asPeer.json()) as any[]).map(p => p.id);
    assert(!peerIds.includes(cashId), 'a PEER node does not see the cash-flagged listing');
    assert(peerIds.includes(beanId), 'a peer node still sees the beans-only listing');

    // A peer cannot opt back in — the exclusion is server-side, not a client preference.
    const peerOptOut = await fetch(`${BASE}/api/marketplace/posts?beansOnly=false`, { headers: { Origin: PEER_ORIGIN } });
    assert(
        !((await peerOptOut.json()) as any[]).map(p => p.id).includes(cashId),
        'beansOnly=false does not let a peer opt back in to cash listings',
    );

    // An unknown origin is treated as local — this is a discovery filter, not access control
    // (docs/federation-economics.md Rule 9), so it must not pretend to be a security boundary.
    const stranger = await fetch(`${BASE}/api/marketplace/posts`, { headers: { Origin: 'https://not-a-peer.example' } });
    assert(
        ((await stranger.json()) as any[]).map(p => p.id).includes(cashId),
        'a non-peer origin is not filtered — the flag is a discovery filter, not access control',
    );

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ "Cash also needed" flag checks PASSED (#108).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
