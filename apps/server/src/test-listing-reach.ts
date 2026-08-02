/**
 * Per-listing reach (#143, slice step 4) — what a community chooses to show its trading partners.
 *
 * Spec: docs/federation-connector.md §7. Three tiers: local / named peers / everywhere. The serve side is
 * `listingsForPeer`, which is what the pull will call once the transport half lands.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING. Two things, and they pull in opposite directions:
 *
 *   1. A listing must never travel unless its author said so. Every unrecognised value, every absent column,
 *      every malformed peer list resolves to 'local'. A default that leaked would export listings from
 *      members who have never heard of federation — silently, and with no way to call them back.
 *   2. A listing we PULLED from a peer must never be served onward. Without that, two nodes would trade each
 *      other's copies back and forth and `origin_node` would end up naming the wrong community — which is
 *      the field a buyer's node charges against.
 *
 * Over a real HTTPS server, not the router handlers (the #144 review caught a route that 403'd on every real
 * request while 36 handler-level checks passed).
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-listing-reach.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createPost, updatePost, getPosts } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { listingsForPeer, reachablePeers } from './federation-listings.js';

const PORT = 8553;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdmin123!';

const BYRON = '12D3KooWByronReachTestPeer0000000000';
const BYRON_ADDR = `/ip4/172.18.0.21/tcp/4001/p2p/${BYRON}`;
const BRISBANE = '12D3KooWBrisbaneReachTestPeer0000000';
const BRISBANE_ADDR = `/ip4/172.18.0.22/tcp/4001/p2p/${BRISBANE}`;
const UNCAPPED = '12D3KooWUncappedReachTestPeer0000000';
const UNCAPPED_ADDR = `/ip4/172.18.0.23/tcp/4001/p2p/${UNCAPPED}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}
async function get(path: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`);
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

/**
 * A member who can post: a row, an account, and a profile photo — `assertProfileComplete` refuses a listing
 * from a member without one. Inserted directly rather than through `registerMember` so the fixture does not
 * depend on invite state it has nothing to do with.
 */
function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, avatar_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500, ?)`)
        .run(pk, callsign, TINY_PNG);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)`).run(pk);
    return pk;
}

const titlesFor = (peerId: string): string[] => listingsForPeer(peerId).map(l => l.title);

async function main() {
    console.log('Running per-listing reach tests (#143 step 4)...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Two capped peers we settle with, and one configured-but-capless peer.
    for (const [addr, callsign] of [[BYRON_ADDR, 'byron'], [BRISBANE_ADDR, 'brisbane'], [UNCAPPED_ADDR, 'sleepy']] as const) {
        await post('/api/local/connectors', { password: PW, address: addr, trustLevel: 'peer', callsign, enabled: true });
    }
    await post('/api/local/connectors/credit-cap', { password: PW, address: BYRON_ADDR, cap: 500 });
    await post('/api/local/connectors/credit-cap', { password: PW, address: BRISBANE_ADDR, cap: 500 });

    const author = makeMember('Reacher');

    // ── 1. THE DEFAULT. A listing posted with no mention of reach stays home. ────────────────────────────
    const plain = createPost('offer', 'other', 'Local only', 'd', 10, 'fixed', author);
    assert(plain !== null, '1a. setup: a listing posts with no reach given');
    assert(getPosts({ id: plain!.id })[0]?.reach === 'local',
        `1b. THE DEFAULT IS 'local' (got ${getPosts({ id: plain!.id })[0]?.reach}) — a member who has never heard of federation has not agreed to their listing travelling`);
    assert(!titlesFor(BYRON).includes('Local only'), '1c. and it is not offered to any peer');

    // ── 2. everywhere — any community we settle with. ────────────────────────────────────────────────────
    createPost('offer', 'other', 'Travels anywhere', 'd', 10, 'fixed', author, undefined, undefined, undefined, false, undefined, false,
        { reach: 'everywhere' });
    assert(titlesFor(BYRON).includes('Travels anywhere'), '2a. an "everywhere" listing is offered to byron');
    assert(titlesFor(BRISBANE).includes('Travels anywhere'), '2b. and to brisbane — one choice, every partner');

    // ── 3. peers — only the named ones. ─────────────────────────────────────────────────────────────────
    createPost('offer', 'other', 'Byron only', 'd', 10, 'fixed', author, undefined, undefined, undefined, false, undefined, false,
        { reach: 'peers', reachPeers: [BYRON] });
    assert(titlesFor(BYRON).includes('Byron only'), '3a. a named peer sees it');
    assert(!titlesFor(BRISBANE).includes('Byron only'),
        '3b. and an unnamed peer does NOT — this is the whole point of the middle tier');

    // ── 4. FAIL-CLOSED. Everything we do not understand stays home. ─────────────────────────────────────
    const nonsense: Array<[string, unknown, unknown]> = [
        ['a typo', 'Everywhere', undefined],
        ['an invented tier', 'global', undefined],
        ['a number', 1, undefined],
        ['an object', { all: true }, undefined],
        ['peers with no list', 'peers', undefined],
        ['peers with an empty list', 'peers', []],
        ['peers with junk entries', 'peers', [42, null, '']],
    ];
    for (const [label, reach, reachPeers] of nonsense) {
        const p = createPost('offer', 'other', `Nonsense ${label}`, 'd', 10, 'fixed', author,
            undefined, undefined, undefined, false, undefined, false, { reach, reachPeers });
        const stored = getPosts({ id: p!.id })[0];
        assert(stored?.reach === 'local' && !titlesFor(BYRON).includes(`Nonsense ${label}`),
            `4. ${label} → 'local' and reaches nobody (stored "${stored?.reach}") — a client bug must not export a member's listing`);
    }

    // ── 5. 'peers' with nothing usable COLLAPSES to 'local' in the column. ──────────────────────────────
    // Both behave the same today; the collapsed form cannot later be misread as "named peers, names lost",
    // and it keeps the partial index free of rows that can never be served.
    const collapsed = createPost('offer', 'other', 'Collapsed', 'd', 10, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false, { reach: 'peers', reachPeers: [] });
    const collapsedRow = db.prepare('SELECT reach, reach_peers FROM posts WHERE id = ?').get(collapsed!.id) as any;
    assert(collapsedRow?.reach === 'local' && collapsedRow?.reach_peers === null,
        `5. an empty peer list stores 'local' with a null list, not an empty 'peers' row (got ${collapsedRow?.reach}/${collapsedRow?.reach_peers})`);

    // ── 6. LOOP PREVENTION. A listing pulled FROM a peer is never served onward. ────────────────────────
    const cached = createPost('offer', 'other', 'Someone elses listing', 'd', 10, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false, { reach: 'everywhere' });
    db.prepare("UPDATE posts SET origin_node = 'https://byron.example' WHERE id = ?").run(cached!.id);
    assert(!titlesFor(BRISBANE).includes('Someone elses listing'),
        '6. THE OTHER HALF: a cached remote listing is NOT re-served, even at reach "everywhere" — otherwise two nodes trade copies back and forth and origin_node ends up naming the wrong community, which is what a buyer is charged against');

    // ── 7. Editing reach. Both columns move together, through the same normaliser. ──────────────────────
    const edited = createPost('offer', 'other', 'Editable', 'd', 10, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false, { reach: 'peers', reachPeers: [BYRON] });
    updatePost(edited!.id, author, { reach: 'everywhere' } as any);
    const afterWiden = db.prepare('SELECT reach, reach_peers FROM posts WHERE id = ?').get(edited!.id) as any;
    assert(afterWiden?.reach === 'everywhere' && afterWiden?.reach_peers === null,
        `7a. widening to "everywhere" CLEARS the stale peer list (got ${afterWiden?.reach}/${afterWiden?.reach_peers}) — otherwise a narrowing edit later would silently restore names the member had moved on from`);
    updatePost(edited!.id, author, { reach: 'peers', reachPeers: [BRISBANE] } as any);
    assert(titlesFor(BRISBANE).includes('Editable') && !titlesFor(BYRON).includes('Editable'),
        '7b. and narrowing to a different peer takes effect on the next serve');
    updatePost(edited!.id, author, { reachPeers: [BYRON, BRISBANE] } as any);
    assert(titlesFor(BYRON).includes('Editable') && titlesFor(BRISBANE).includes('Editable'),
        '7c. the peer list can be edited WITHOUT restating the reach — otherwise adding one community means re-sending the whole choice');

    // ── 8. Status still governs. Reach widens who sees a listing, never what counts as on offer. ────────
    const withdrawn = createPost('offer', 'other', 'Withdrawn', 'd', 10, 'fixed', author,
        undefined, undefined, undefined, false, undefined, false, { reach: 'everywhere' });
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(withdrawn!.id);
    assert(!titlesFor(BYRON).includes('Withdrawn'), '8. a completed listing is offered to nobody, whatever its reach');

    // ── 9. The compose-time peer list: only peers we actually settle with. ─────────────────────────────
    const reachable = reachablePeers().map(p => p.peerId);
    assert(reachable.includes(BYRON) && reachable.includes(BRISBANE), '9a. capped peers are offerable as reach targets');
    assert(!reachable.includes(UNCAPPED),
        '9b. a CAPLESS peer is not — naming it would promise discovery into a community no purchase could complete from');
    const viaHttp = await get('/api/federation/reachable-peers');
    assert(viaHttp.status === 200 && (viaHttp.json?.peers ?? []).length === 2,
        `9c. and the route serves it without a password, because it is a compose-time read (got ${viaHttp.status}, ${(viaHttp.json?.peers ?? []).length} peers)`);
    assert((viaHttp.json?.peers ?? []).every((p: any) => !('address' in p) && !('creditCap' in p)),
        '9d. carrying no address and no cap — a member needs the name, not the operator configuration');

    // Two connectors, ONE peer — an operator who added a peer by hostname and again by container IP, or who
    // kept an old address while migrating a host. Rendered with key={peerId}, so a duplicate is both a React
    // key collision and the same community offered twice (review finding).
    await post('/api/local/connectors', {
        password: PW, address: `/dns4/byron.example/tcp/4001/p2p/${BYRON}`, trustLevel: 'peer', callsign: 'byron-again', enabled: false,
    });
    await post('/api/local/connectors/credit-cap', { password: PW, address: `/dns4/byron.example/tcp/4001/p2p/${BYRON}`, cap: 500 });
    const ids = reachablePeers().map(p => p.peerId);
    assert(ids.filter(id => id === BYRON).length === 1,
        `9e. two connectors for the SAME peer id yield ONE entry (got ${ids.filter(id => id === BYRON).length}) — the compose form keys on peer id`);
    assert(new Set(ids).size === ids.length, '9f. and the list has no duplicates at all');

    // ── 10. What crosses the wire is narrower than a post. ─────────────────────────────────────────────
    const wire = listingsForPeer(BYRON)[0];
    assert(wire !== undefined && typeof wire.authorPublicKey === 'string' && typeof wire.authorCallsign === 'string',
        '10a. a served listing carries the seller and their name — the purchase route needs sellerPublicKey');
    for (const leaked of ['authorAvatarUrl', 'authorEnergyCycled', 'photos', 'pendingTransactionId', 'acceptedBy', 'lat', 'lng', 'reachPeers']) {
        assert(!(leaked in (wire as any)),
            `10b. and NOT ${leaked} — the receiving node writes what it is sent, so every field omitted here is one that cannot leak later`);
    }

    // ── 11. The route a peer reads is unchanged by all this. ───────────────────────────────────────────
    const local = await get('/api/marketplace/posts');
    assert(local.status === 200 && Array.isArray(local.json),
        '11. the ordinary marketplace read still works — reach is a federation concern and must not disturb the local board');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #143 step 4 (reach): a listing travels only where its author said, and a borrowed one never travels on.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });
