/**
 * Connector URL editing & listings retention / identity separation.
 *
 * SPEC / REQUIREMENTS:
 * 1. A node admin links to another node (a connector / federation peer).
 * 2. Editing a connector's URL (changing the address of an existing link) must allow that peer's
 *    listings to carry on under the new address on the next pull, instead of disappearing.
 * 3. Listings must be keyed to the peer, not to its address.
 * 4. A peer whose identity CHANGED with the new address must NOT inherit the old one's listings
 *    (the new address could be someone else).
 *
 * Run:
 *   BEANPOOL_SUITE_ENV_PASSWORD=1 ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-connector-url-listings.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import * as cm from './connector-manager.js';
import { cacheRemoteListings, pullAllPeerListings, REMOTE_ID_PREFIX } from './federation-listings.js';

let PORT = 0;
let BASE = '';
const PW = 'TestAdmin123!';
let tfa: ReturnType<typeof turnOn2faForTests> | null = null;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const sent = tfa && 'password' in body ? { ...body, totpCode: tfa.code() } : body;
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sent),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

const randomKey = (): string => crypto.randomBytes(32).toString('hex');

const listing = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    type: 'offer',
    category: 'other',
    title: 'Peer tutoring',
    description: 'Maths, over video',
    credits: 10,
    priceType: 'fixed',
    authorPublicKey: randomKey(),
    authorCallsign: 'PeerAuthor',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ...over,
});

const cachedFor = (originNode: string): any[] =>
    db.prepare('SELECT * FROM posts WHERE origin_node = ?').all(originNode) as any[];

function makeFakeNode(listingsByPeer: Map<string, any[]>) {
    return {
        dialProtocol: async (targetPeerId: any) => {
            const peerIdStr = targetPeerId.toString();
            const listings = listingsByPeer.get(peerIdStr) ?? [];
            const data = new TextEncoder().encode(JSON.stringify({ listings }));
            return {
                async *[Symbol.asyncIterator]() {
                    yield data;
                },
                send: () => true,
                close: async () => {},
                abort: () => {},
            };
        },
    } as any;
}

async function main() {
    console.log('Running connector URL listings test...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    tfa = turnOn2faForTests(PW);

    const peerA = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const addrA = `/ip4/172.18.0.31/tcp/4001/p2p/${peerA}`;
    const urlA1 = 'https://peer-a.beanpool.org';
    const urlA2 = 'https://peer-a-updated.beanpool.org';

    // ── 1. Setup connector A ────────────────────────────────────────────────────────────────────────
    const addA = await post('/api/local/connectors', {
        password: PW, address: addrA, trustLevel: 'peer', callsign: 'peer-a', publicUrl: urlA1, enabled: true,
    });
    const capA = await post('/api/local/connectors/credit-cap', {
        password: PW, address: addrA, cap: 500,
    });
    assert(addA.status === 200 && capA.status === 200, `1a. Peer A connector configured and capped (got ${addA.status}, ${capA.status})`);

    const item1 = listing({ title: 'Peer A organic apples', credits: 4 });
    const item2 = listing({ title: 'Peer A honey', credits: 8 });
    const listingsByPeer = new Map<string, any[]>();
    listingsByPeer.set(peerA, [item1, item2]);

    const fakeNode = makeFakeNode(listingsByPeer);

    // ── 2. First pull: listings cached under urlA1 ────────────────────────────────────────────────────
    const pull1 = await pullAllPeerListings(fakeNode);
    const peerRes1 = pull1.find(r => r.peerId === peerA);
    assert(peerRes1?.ok === true && peerRes1?.cached === 2 && peerRes1?.dropped === 0,
        `2a. First pull caches 2 listings for Peer A (cached=${peerRes1?.cached}, dropped=${peerRes1?.dropped})`);
    assert(cachedFor(urlA1).length === 2, `2b. Both listings stored under urlA1 (${cachedFor(urlA1).length})`);
    assert(cachedFor(urlA2).length === 0, '2c. No listings under urlA2 yet');

    // ── 3. Edit ONLY the URL of connector A ─────────────────────────────────────────────────────────
    const editA = await post('/api/local/connectors', {
        password: PW, address: addrA, trustLevel: 'peer', callsign: 'peer-a', publicUrl: urlA2, enabled: true,
    });
    assert(editA.status === 200 && editA.json?.connector?.publicUrl === urlA2,
        `3a. Connector URL successfully edited to ${urlA2} (got ${editA.json?.connector?.publicUrl})`);
    assert(cm.getConnectorByAddress(addrA)?.publicUrl === urlA2, '3b. Connector manager reflects new publicUrl');

    // ── 4. Second pull: listings must carry on under the new address urlA2 ───────────────────────────
    const pull2 = await pullAllPeerListings(fakeNode);
    const peerRes2 = pull2.find(r => r.peerId === peerA);
    assert(peerRes2?.ok === true && peerRes2?.cached === 2 && peerRes2?.dropped === 0,
        `4a. Second pull after URL edit caches 2 listings without dropping (cached=${peerRes2?.cached}, dropped=${peerRes2?.dropped})`);
    const listingsAtNewUrl = cachedFor(urlA2);
    assert(listingsAtNewUrl.length === 2,
        `4b. Listings carried on under the new address urlA2 (expected 2, got ${listingsAtNewUrl.length})`);
    assert(listingsAtNewUrl.every(p => p.origin_node === urlA2),
        '4c. All listings for Peer A now have origin_node set to urlA2');
    assert(cachedFor(urlA1).length === 0,
        '4d. Old address urlA1 no longer holds orphaned listings');
    assert(listingsAtNewUrl.some(p => p.title === 'Peer A organic apples') && listingsAtNewUrl.some(p => p.title === 'Peer A honey'),
        '4e. Listing titles preserved under new address');

    // ── 5. Identity change: a peer whose identity CHANGED must not inherit the old one's listings ────
    const peerB = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const addrB = `/ip4/172.18.0.32/tcp/4001/p2p/${peerB}`;
    const urlB = 'https://peer-b.beanpool.org';

    await post('/api/local/connectors', {
        password: PW, address: addrB, trustLevel: 'peer', callsign: 'peer-b', publicUrl: urlB, enabled: true,
    });
    await post('/api/local/connectors/credit-cap', {
        password: PW, address: addrB, cap: 500,
    });

    const itemB1 = listing({ title: 'Peer B old carpentry', credits: 15 });
    listingsByPeer.set(peerB, [itemB1]);

    const pullB1 = await pullAllPeerListings(fakeNode);
    const peerBRes = pullB1.find(r => r.peerId === peerB);
    assert(peerBRes?.ok === true && peerBRes?.cached === 1, `5a. Peer B cached 1 listing initially (${peerBRes?.cached})`);
    assert(cachedFor(urlB).length === 1, '5b. 1 listing under urlB');

    // Now peer at urlB changes identity to Peer C (e.g. node replaced / new peer identity at this address)
    const peerC = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const addrC = `/ip4/172.18.0.33/tcp/4001/p2p/${peerC}`;

    // Remove old connector B and configure connector C at urlB
    await post('/api/local/connectors/remove', { password: PW, address: addrB });
    await post('/api/local/connectors', {
        password: PW, address: addrC, trustLevel: 'peer', callsign: 'peer-c', publicUrl: urlB, enabled: true,
    });
    await post('/api/local/connectors/credit-cap', {
        password: PW, address: addrC, cap: 500,
    });

    const itemC1 = listing({ title: 'Peer C pottery', credits: 20 });
    listingsByPeer.set(peerC, [itemC1]);

    const pullC1 = await pullAllPeerListings(fakeNode);
    const peerCRes = pullC1.find(r => r.peerId === peerC);
    assert(peerCRes?.ok === true && peerCRes?.cached === 1 && peerCRes?.dropped === 0,
        `5c. Peer C pulls its own listing (${peerCRes?.cached} cached)`);

    const listingsUnderUrlB = cachedFor(urlB);
    assert(!listingsUnderUrlB.some(p => p.title === 'Peer B old carpentry'),
        '5d. THE CRITICAL CHECK: Peer C did NOT inherit Peer B\'s old listings ("Peer B old carpentry" is gone)');
    assert(listingsUnderUrlB.length === 1 && listingsUnderUrlB[0].title === 'Peer C pottery',
        `5e. Only Peer C's own listing is present under urlB (got ${listingsUnderUrlB.map(p => p.title).join(', ')})`);

    // 6. Two peers whose ids end in the same letters but in a different case are two peers: one's pull never touches the
    //    other's listings (SQLite's LIKE ignores case; peer ids do not).
    // The cache keys a listing by the peer id's last 12 letters: these two differ there only in case.
    const lower = '12D3KooWcasefoldxxabcdefghijkm';
    const upper = '12D3KooWcasefoldyyABCDEFGHIJKM';
    const lowerOrigin = 'https://lower.example', upperOrigin = 'https://upper.example';
    cacheRemoteListings(lower, lowerOrigin, [listing({ title: 'Lower-case peer listing' })]);
    cacheRemoteListings(upper, upperOrigin, [listing({ title: 'Upper-case peer listing' })]);
    assert(cachedFor(lowerOrigin).length === 1 && cachedFor(upperOrigin).length === 1,
        `6. A peer whose id differs only in case keeps its own listings (${cachedFor(lowerOrigin).length}, ${cachedFor(upperOrigin).length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Connector URL listings & identity tests passed.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });
