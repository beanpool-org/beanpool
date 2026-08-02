/**
 * The listing pull (#143, slice step 4, second half) — caching a peer's board locally.
 *
 * Spec: docs/federation-connector.md §7. A partner's listings arrive by periodic PULL and are cached with
 * `origin_node` set, because off-grid and solar nodes sleep and a board that empties whenever a peer naps is
 * not a board. Accepted cost: a listing can be up to one interval stale.
 *
 * WHAT THIS SUITE IS DEFENDING. The cache writes rows on a peer's word, so every check here is about what a
 * peer can and cannot make this node do:
 *
 *   1. THE ACCOUNT-FREEZE VECTOR. Caching needs a member row for each author, so this path calls
 *      `registerVisitor` — which stamps `home_node_url` onto an existing row that has none, converting one of
 *      OUR members into a visitor. `assertLocalSettlement` (#102) then refuses that member's own local
 *      spending. So a peer that knows a local member's public key could freeze their account by naming them
 *      as a listing author. The A2-28 impersonation shape, arriving through a new door.
 *   2. A failed pull must LEAVE THE CACHE ALONE. Clearing it would empty the board every time a solar node
 *      napped — the exact failure pull-and-cache was chosen to avoid.
 *   3. A cached listing must never be re-served, and must never overwrite or be confused with a local one.
 *
 * Run with a throwaway data dir (self-signed TLS):
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-listing-pull.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, getMember, getPosts, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import {
    cacheRemoteListings, listingsForPeer, REMOTE_ID_PREFIX, LISTING_PULL_INTERVAL_MS,
} from './federation-listings.js';

const PORT = 8554;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestAdmin123!';

const BYRON = '12D3KooWByronPullTestPeer00000000000';
const BYRON_ADDR = `/ip4/172.18.0.31/tcp/4001/p2p/${BYRON}`;
const BYRON_URL = 'https://byron.beanpool.org';
const BRISBANE = '12D3KooWBrisbanePullTestPeer0000000';
const BRISBANE_ADDR = `/ip4/172.18.0.32/tcp/4001/p2p/${BRISBANE}`;
const BRISBANE_URL = 'https://brisbane.beanpool.org';

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

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

function makeLocalMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, avatar_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500, ?)`).run(pk, callsign, TINY_PNG);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)`).run(pk);
    return pk;
}

const remoteAuthor = (): string => crypto.randomBytes(32).toString('hex');

/** One listing in the shape a peer sends. */
const listing = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    type: 'offer',
    category: 'other',
    title: 'Remote tutoring',
    description: 'Maths, over video',
    credits: 12,
    priceType: 'fixed',
    authorPublicKey: remoteAuthor(),
    authorCallsign: 'ByronMember',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: null,
    ...over,
});

const cachedFor = (originNode: string): any[] =>
    db.prepare('SELECT * FROM posts WHERE origin_node = ?').all(originNode) as any[];

const nodeTotal = (): number =>
    (db.prepare('SELECT COALESCE(SUM(balance),0) AS t FROM accounts').get() as any).t;

async function main() {
    console.log('Running listing pull tests (#143 step 4, second half)...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    for (const [addr, callsign, url] of [[BYRON_ADDR, 'byron', BYRON_URL], [BRISBANE_ADDR, 'brisbane', BRISBANE_URL]] as const) {
        await post('/api/local/connectors', { password: PW, address: addr, trustLevel: 'peer', callsign, publicUrl: url, enabled: true });
        await post('/api/local/connectors/credit-cap', { password: PW, address: addr, cap: 500 });
    }
    // EVERY local member seeded BEFORE the baseline. `makeLocalMember` mints — a fixture's privilege, not the
    // code's — so one created later reads as a conservation failure at check 8. The purchase-route suite
    // documents having been caught by this three times; now four.
    const ours = makeLocalMember('Local Alice');
    const localAuthor = makeLocalMember('Local Bob');
    makeLocalMember('Sam');
    const baseline = nodeTotal();

    // ── 1. The happy path. ───────────────────────────────────────────────────────────────────────────────
    const first = listing({ title: 'Byron bread' });
    let res = cacheRemoteListings(BYRON, BYRON_URL, [first, listing({ title: 'Byron bike repair' })]);
    assert(res.cached === 2 && res.dropped === 0, `1a. two listings cached (${res.cached} cached, ${res.dropped} dropped)`);
    assert(cachedFor(BYRON_URL).length === 2, '1b. and they are readable back by origin_node');
    assert(cachedFor(BYRON_URL).every(r => r.origin_node === BYRON_URL),
        '1c. stamped with the peer\'s public URL — the value a buyer hands the purchase route as nodeUrl');
    assert(cachedFor(BYRON_URL).every(r => String(r.id).startsWith(REMOTE_ID_PREFIX)),
        '1d. under namespaced ids, so two peers cannot collide and a remote listing cannot overwrite a local one');
    assert(getMember(first.authorPublicKey)?.homeNodeUrl === BYRON_URL,
        '1e. the author exists as a VISITOR with their home node recorded — a purchase has to charge home');
    assert(nodeTotal() === baseline,
        `1f. and caching minted nothing (${baseline} → ${nodeTotal()}) — a visitor's account starts at zero`);

    // ── 2. THE ACCOUNT-FREEZE VECTOR. A peer naming one of OUR members as an author. ─────────────────────
    assert(getMember(ours)?.homeNodeUrl == null, '2a. setup: a local member has no home node, which is what makes them local');
    res = cacheRemoteListings(BYRON, BYRON_URL, [listing({ authorPublicKey: ours, title: 'Impersonated' })]);
    assert(res.cached === 0 && res.dropped === 1,
        `2b. a listing claiming a LOCAL member as its author is dropped (${res.cached} cached, ${res.dropped} dropped)`);
    assert(getMember(ours)?.homeNodeUrl == null,
        '2c. THE POINT: our member is STILL LOCAL. registerVisitor would have stamped a home_node_url onto them, and #102 then refuses their own local spending — so a peer knowing a public key could freeze that account');
    assert(!getPosts({}).some(p => p.title === 'Impersonated'), '2d. and the listing is nowhere');

    // A visitor from ANOTHER peer is a different case: they already have a home node, so nothing is being
    // converted, and refusing would stop two communities that both know someone from listing their work.
    const shared = remoteAuthor();
    cacheRemoteListings(BRISBANE, BRISBANE_URL, [listing({ authorPublicKey: shared, title: 'Brisbane job' })]);
    res = cacheRemoteListings(BYRON, BYRON_URL, [listing({ authorPublicKey: shared, title: 'Byron job' })]);
    assert(res.cached === 1,
        '2e. but an author who is already a VISITOR is accepted — they have a home node, so no local member is being converted');

    // ── 3. Malformed input is dropped, never stored half-formed. ────────────────────────────────────────
    const junk: Array<[string, any]> = [
        ['no id', listing({ id: '' })],
        ['no title', listing({ title: '' })],
        ['no author', listing({ authorPublicKey: '' })],
        ['a bad type', listing({ type: 'rant' })],
        ['credits that are not a number', listing({ credits: 'lots' })],
        ['a synthetic author', listing({ authorPublicKey: 'COMMONS_POOL' })],
        ['a bridge account as author', listing({ authorPublicKey: `bridge_${BRISBANE}` })],
        ['null', null],
        ['a string', 'not a listing'],
    ];
    res = cacheRemoteListings(BYRON, BYRON_URL, junk.map(j => j[1]));
    assert(res.cached === 0 && res.dropped === junk.length,
        `3a. all ${junk.length} malformed listings dropped, none cached (${res.cached}/${res.dropped})`);
    assert(cachedFor(BYRON_URL).length === 0, '3b. and the round left nothing behind');
    assert(!getMember('COMMONS_POOL')?.homeNodeUrl,
        '3c. in particular a synthetic author never became a member row — registerVisitor would have tried to create one for a ledger account');

    // Credits: NEGATIVE refused, ZERO kept. The compose form's own rule is `< 0` → invalid, so a local member
    // may post at zero (a gift, or "ask me") and holding a peer's members to a stricter rule than our own
    // would silently hide their free offers.
    res = cacheRemoteListings(BYRON, BYRON_URL, [listing({ credits: -50, title: 'Negative price' })]);
    assert(res.cached === 0 && res.dropped === 1, `3d. a NEGATIVE price is refused (${res.cached}/${res.dropped}) — nonsense in either community`);
    res = cacheRemoteListings(BYRON, BYRON_URL, [listing({ credits: 0, title: 'A gift' })]);
    assert(res.cached === 1,
        `3e. but ZERO is kept (${res.cached} cached) — the local form allows it, so a peer's free offer is not held to a stricter rule than ours`);

    // ── 3.5. CALLSIGN COLLISIONS. Unique per node (#83); a remote name was only unique at home. ──────────
    // This threw `UNIQUE constraint failed: idx_members_callsign_unique` on the first run of this suite, and
    // because the round is one transaction, ONE unlucky name meant the peer's entire board never cached.
    const remoteSam = remoteAuthor();
    res = cacheRemoteListings(BYRON, BYRON_URL, [listing({ authorPublicKey: remoteSam, authorCallsign: 'Sam', title: 'Byron Sam offer' })]);
    assert(res.cached === 1,
        `3.5a. a remote author whose name is TAKEN by one of ours still caches (${res.cached} cached, ${res.dropped} dropped) — a worse name beats a missing board`);
    assert(getMember(remoteSam)?.callsign !== 'Sam' && getMember(remoteSam)?.callsign?.startsWith('Visitor-') === true,
        `3.5b. under a generated name (got "${getMember(remoteSam)?.callsign}") — the callsign a peer sends was never authoritative anyway`);
    assert(getMember(remoteSam)?.homeNodeUrl === BYRON_URL, '3.5c. and still with their home node recorded, which is what a purchase needs');

    // Two authors on two different peers, each called "Ash" at home. Both must survive.
    const ashA = remoteAuthor(), ashB = remoteAuthor();
    const a = cacheRemoteListings(BYRON, BYRON_URL, [listing({ authorPublicKey: ashA, authorCallsign: 'Ash', title: 'Byron Ash' })]);
    const b = cacheRemoteListings(BRISBANE, BRISBANE_URL, [listing({ authorPublicKey: ashB, authorCallsign: 'Ash', title: 'Brisbane Ash' })]);
    assert(a.cached === 1 && b.cached === 1,
        `3.5d. two peers each with an "Ash" both cache (${a.cached}/${b.cached}) — each name was unique on its own node, never across the federation`);

    // And one bad row must not take the round with it.
    res = cacheRemoteListings(BYRON, BYRON_URL, [
        listing({ title: 'Good one' }),
        listing({ id: '' }),
        listing({ title: 'Good two' }),
    ]);
    assert(res.cached === 2 && res.dropped === 1,
        `3.5e. a bad row costs one listing, not the board (${res.cached} cached, ${res.dropped} dropped)`);

    // ── 4. REPLACE, not merge. A withdrawn listing has no retraction message. ───────────────────────────
    cacheRemoteListings(BYRON, BYRON_URL, [listing({ title: 'Still offered' }), listing({ title: 'Withdrawn later' })]);
    assert(cachedFor(BYRON_URL).length === 2, '4a. setup: two cached');
    cacheRemoteListings(BYRON, BYRON_URL, [listing({ title: 'Still offered' })]);
    const titles = cachedFor(BYRON_URL).map(r => r.title);
    assert(titles.length === 1 && titles[0] === 'Still offered',
        `4b. the peer's answer IS the truth: what it stopped sending is gone (${JSON.stringify(titles)}) — there is no "deleted" message, and inventing one would be a whole retraction protocol`);

    // ── 5. One peer's cache is not another's, and neither is a local listing. ──────────────────────────
    const brisbaneBefore = cachedFor(BRISBANE_URL).length;
    const localPost = createPost('offer', 'other', 'Local loaf', 'd', 5, 'fixed', localAuthor);
    cacheRemoteListings(BYRON, BYRON_URL, [listing({ title: 'Fresh byron' })]);
    assert(cachedFor(BRISBANE_URL).length === brisbaneBefore,
        '5a. re-caching byron did not touch brisbane\'s cache — the delete is scoped by origin_node');
    assert(getPosts({ id: localPost!.id }).length === 1,
        '5b. and it did not touch a LOCAL listing, which is the one that would really hurt');

    // ── 6. A cached listing is never re-served. Two independent reasons. ──────────────────────────────
    assert(!listingsForPeer(BRISBANE).some(l => l.title === 'Fresh byron'),
        '6a. byron\'s listing is not offered onward to brisbane — otherwise two nodes trade copies and origin_node names the wrong community');
    assert(cachedFor(BYRON_URL).every(r => r.reach === 'local'),
        '6b. and it is stored with reach=local as well, so it takes BOTH the origin_node guard and the reach filter failing before a copy could travel');

    // ── 7. The interval is the one §7 signed up for. ──────────────────────────────────────────────────
    assert(LISTING_PULL_INTERVAL_MS === 5 * 60_000,
        `7. the pull interval is 5 minutes (${LISTING_PULL_INTERVAL_MS}ms) — the accepted staleness, long enough to be nothing on a 1 CPU or solar node`);

    // ── 8. Nothing about any of this minted a bean. ───────────────────────────────────────────────────
    assert(nodeTotal() === baseline,
        `8. FINALLY: across every cache round the ledger is unchanged (${baseline} → ${nodeTotal()}) — a cached listing is a copy of an advert, not value`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #143 step 4 (pull): a peer\'s board is cached, a sleeping peer keeps its board, and no peer can freeze a local member.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });
