/**
 * Test: A removed connector's cached listings are deleted (#2067).
 *
 * SPEC / REQUIREMENTS:
 * 1. When a node admin removes a link to another node (a "connector"), the listings cached from
 *    that peer (posts rows whose id starts with REMOTE_ID_PREFIX + peer id's last 12 chars + ':'
 *    or origin_node = connector.publicUrl) must be deleted in the same step.
 * 2. When anything was deleted, ring `post_updated` (ringListingDoorbell) so open boards refresh.
 * 3. Local listings and other peers' caches must never be touched.
 * 4. Disabling a connector (enabled: false, making it a passive listener rather than active dialer)
 *    leaves cached listings in place.
 *
 * Run:
 *   BEANPOOL_SUITE_ENV_PASSWORD=1 ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-removed-connector-listings.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { initTls } from './services/tls.js';
import { initStateEngine, createPost, addWsClient } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { pullAllPeerListings, REMOTE_ID_PREFIX } from './federation-listings.js';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

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

function makeLocalMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500)`).run(pk, callsign);
    setMemberPhoto(db, pk, TINY_PNG);
    return pk;
}

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
    console.log('Running removed connector listings test (#2067)...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    tfa = turnOn2faForTests(PW);

    const peerA = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const addrA = `/ip4/172.18.0.31/tcp/4001/p2p/${peerA}`;
    const urlA = 'https://peer-a.beanpool.org';

    const peerB = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const addrB = `/ip4/172.18.0.32/tcp/4001/p2p/${peerB}`;
    const urlB = 'https://peer-b.beanpool.org';

    // ── 1. Setup two connectors and a local post ────────────────────────────────────────────────────
    const addA = await post('/api/local/connectors', {
        password: PW, address: addrA, trustLevel: 'peer', callsign: 'peer-a', publicUrl: urlA, enabled: true,
    });
    const capA = await post('/api/local/connectors/credit-cap', {
        password: PW, address: addrA, cap: 500,
    });
    assert(addA.status === 200 && capA.status === 200, `1a. Peer A connector configured and capped (${addA.status}, ${capA.status})`);

    const addB = await post('/api/local/connectors', {
        password: PW, address: addrB, trustLevel: 'peer', callsign: 'peer-b', publicUrl: urlB, enabled: true,
    });
    const capB = await post('/api/local/connectors/credit-cap', {
        password: PW, address: addrB, cap: 500,
    });
    assert(addB.status === 200 && capB.status === 200, `1b. Peer B connector configured and capped (${addB.status}, ${capB.status})`);

    const localMember = makeLocalMember('local-alice');
    const localPost = createPost('offer', 'other', 'Local organic bread', 'Freshly baked', 5, 'fixed', localMember);
    assert(localPost !== null, '1c. Local listing created');

    // ── 2. Pull listings from both peers ────────────────────────────────────────────────────────────
    const itemA1 = listing({ title: 'Peer A apples', credits: 4 });
    const itemA2 = listing({ title: 'Peer A honey', credits: 8 });
    const itemB1 = listing({ title: 'Peer B bread', credits: 6 });

    const listingsByPeer = new Map<string, any[]>();
    listingsByPeer.set(peerA, [itemA1, itemA2]);
    listingsByPeer.set(peerB, [itemB1]);

    const fakeNode = makeFakeNode(listingsByPeer);
    const pull = await pullAllPeerListings(fakeNode);
    const resA = pull.find(r => r.peerId === peerA);
    const resB = pull.find(r => r.peerId === peerB);
    assert(resA?.ok === true && resA?.cached === 2, `2a. Pull caches 2 listings for Peer A (${resA?.cached})`);
    assert(resB?.ok === true && resB?.cached === 1, `2b. Pull caches 1 listing for Peer B (${resB?.cached})`);
    assert(cachedFor(urlA).length === 2, `2c. 2 listings cached under urlA`);
    assert(cachedFor(urlB).length === 1, `2d. 1 listing cached under urlB`);

    // ── 3. Connect fake WebSocket client and remove connector A ─────────────────────────────────────
    const heard: string[] = [];
    addWsClient({ _memberPubkey: 'f'.repeat(64), readyState: 1, send: (m: string) => heard.push(m) });
    const tick = () => new Promise(r => setImmediate(r));
    // Let any doorbells from the initial pull settle before testing connector removal
    await tick();
    heard.length = 0;
    const doorbells = () => heard.filter(m => {
        try { return JSON.parse(m).type === 'post_updated'; } catch { return false; }
    }).length;

    const remA = await post('/api/local/connectors/remove', { password: PW, address: addrA });
    assert(remA.status === 200 && remA.json?.success === true, `3a. Peer A connector removed (${remA.status})`);
    await tick();

    // Peer A listings must be deleted
    const prefixA = `${REMOTE_ID_PREFIX}${peerA.slice(-12)}:`;
    const listingsA = db.prepare('SELECT * FROM posts WHERE origin_node = ? OR substr(id, 1, ?) = ?')
        .all(urlA, prefixA.length, prefixA) as any[];
    assert(listingsA.length === 0, `3b. Peer A listings are gone after connector removal (got ${listingsA.length})`);

    // Peer B listings must remain
    const listingsB = db.prepare('SELECT * FROM posts WHERE origin_node = ?').all(urlB) as any[];
    assert(listingsB.length === 1 && listingsB[0].title === 'Peer B bread',
        `3c. Peer B listings remain untouched (${listingsB.length})`);

    // Local listing must remain
    const localRows = db.prepare('SELECT * FROM posts WHERE id = ?').all(localPost!.id) as any[];
    assert(localRows.length === 1 && localRows[0].title === 'Local organic bread',
        `3d. Local listing remains untouched (${localRows.length})`);

    // Fake socket heard post_updated once
    assert(doorbells() === 1, `3e. Fake socket heard post_updated once (got ${doorbells()})`);

    // ── 4. Removing non-existent connector does not ring doorbell ───────────────────────────────────
    await post('/api/local/connectors/remove', { password: PW, address: addrA });
    await tick();
    assert(doorbells() === 1, `4a. Removing already-removed connector rings nobody (still ${doorbells()})`);

    // ── 5. Disabling a connector leaves its cached listings intact ──────────────────────────────────
    const disableB = await post('/api/local/connectors', {
        password: PW, address: addrB, trustLevel: 'peer', callsign: 'peer-b', publicUrl: urlB, enabled: false,
    });
    assert(disableB.status === 200, `5a. Peer B disabled (${disableB.status})`);
    await tick();
    const listingsBAfterDisable = db.prepare('SELECT * FROM posts WHERE origin_node = ?').all(urlB) as any[];
    assert(listingsBAfterDisable.length === 1, `5b. Disabling Peer B leaves its cached listings intact (${listingsBAfterDisable.length})`);
    assert(doorbells() === 1, `5c. Disabling Peer B does not ring post_updated (still ${doorbells()})`);

    // ── 6. Removing connector B deletes its listings and rings post_updated a 2nd time ─────────────
    const remB = await post('/api/local/connectors/remove', { password: PW, address: addrB });
    assert(remB.status === 200 && remB.json?.success === true, `6a. Peer B connector removed (${remB.status})`);
    await tick();
    const listingsBFinal = db.prepare('SELECT * FROM posts WHERE origin_node = ?').all(urlB) as any[];
    assert(listingsBFinal.length === 0, `6b. Peer B listings are gone after removal (${listingsBFinal.length})`);
    assert(doorbells() === 2, `6c. Fake socket heard post_updated a second time (got ${doorbells()})`);

    // ── 7. A peer that moved host keeps its listings when its OLD connector is removed ────────────────
    const peerE = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const addrE1 = `/ip4/172.18.0.41/tcp/4001/p2p/${peerE}`;
    const addrE2 = `/ip4/172.18.0.42/tcp/4001/p2p/${peerE}`;
    const urlE = 'https://peer-e.beanpool.org';
    for (const address of [addrE1, addrE2]) {
        await post('/api/local/connectors', { password: PW, address, trustLevel: 'peer', callsign: 'peer-e', publicUrl: urlE, enabled: true });
        await post('/api/local/connectors/credit-cap', { password: PW, address, cap: 500 });
    }
    listingsByPeer.set(peerE, [listing({ title: 'Peer E eggs', credits: 3 }), listing({ title: 'Peer E jam', credits: 5 })]);
    await pullAllPeerListings(fakeNode);
    await tick();
    const bellsBeforeE = doorbells();
    assert(cachedFor(urlE).length === 2, `7a. Peer E's 2 listings cached (${cachedFor(urlE).length})`);
    const remE1 = await post('/api/local/connectors/remove', { password: PW, address: addrE1 });
    await tick();
    assert(remE1.status === 200 && cachedFor(urlE).length === 2,
        `7b. Removing E's old address keeps its listings: its other connector still names it (${remE1.status}, ${cachedFor(urlE).length})`);
    assert(doorbells() === bellsBeforeE, `7c. and rings nobody (post_updated ×${doorbells() - bellsBeforeE})`);
    const remE2 = await post('/api/local/connectors/remove', { password: PW, address: addrE2 });
    await tick();
    assert(remE2.status === 200 && cachedFor(urlE).length === 0, `7d. Removing E's last connector deletes them (${cachedFor(urlE).length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Removed connector listings tests passed.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });
