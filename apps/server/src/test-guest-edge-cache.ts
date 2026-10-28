/**
 * Slice L0, free capacity (scratch/fable-design/DESIGN-global-lounge-fable.md §5.2 items 1, 3 and 5, §6 L0): the global
 * node's visitors' reads say an edge in front may keep them for a minute, and nothing else ever does.
 *
 * Boots the real server on the global profile and reads through the real middleware over plain HTTP, as the tunnel
 * hands requests to it:
 *   1. the board and the map: an unsigned read is `public, max-age=0, s-maxage=60` and varies on the signature's headers.
 *      The same URL signed by a member is `private`, its body and view a member's; signed by a key that is no member,
 *      `private` though its body is the visitors'; with one signature header alone, an admin's credential, an admin's
 *      session cookie or another web origin's request, `private`. A sync and a delta are `private`; a refusal (403, 400)
 *      is never public; an unsigned 304 keeps the header
 *   2. the visitors' Home and the global directory's two reads: the same split
 *   3. members' reads and per-member answers: the conversation list, /api/community/me and /api/community/info signed,
 *      and a route that marks itself public (a listing photo) read signed: nothing a shared cache may keep
 *   4. ETags: the conversation list and /api/community/info are a 304 while unchanged, a 200 with a new tag when changed
 *   5. a node without the visitors' view (`guestListingsOnly` off, as a local community's listings are): the board is
 *      members', a member's read of it is `private`, an unsigned one refused and never public
 *   6. Beans off: the 5-minute demurrage tick and the pricing aggregator write nothing; Beans on: both write, as before
 *   7. the guard's rewrite (guest-cache.ts privateOnly) on its own
 *
 * On origin/main sections 1-4 and 6 fail (every board and Home read is private, nothing has an ETag here, both jobs
 * write); 7 has nothing to test there.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-guest-edge-cache.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { localFetch } from './keepalive-test-fetch.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// What the slice says, written out here rather than imported, so this suite runs on origin/main too and fails there.
const GUEST = 'public, max-age=0, s-maxage=60';
/** A shared cache may keep an answer that says any of these. */
const sharable = (cc: string | null) => !!cc && /(^|,)\s*(public|s-maxage(=\d+)?|proxy-revalidate)\s*(,|$)/i.test(cc);

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(id: Id, method: string, path: string, body = ''): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}

async function main() {
    console.log("Slice L0: only an unsigned visitor's read may be kept by a shared cache...\n");
    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { setSwitchOverride, getProfileSwitches } = await import('./config/node-profile.js');
    const pricing: any = await import('./pricing-aggregator.js');
    const { ADMIN_SESSION_COOKIE } = await import('./admin-key-auth.js');
    const { db } = await import('./db/db.js');
    const guestCache: any = await import('./guest-cache.js').catch(() => null);

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    const BASE = `http://127.0.0.1:${httpPort}`;
    // Every read below from one address: the gateway's visitor limit is another suite's.
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    // ── the seed: two members, their listings near Mullumbimby, a photo, a conversation ─────────────────────────────
    const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
    const alice = keypair(), bob = keypair(), stranger = keypair();
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', ?, 'seed', 'seed')`);
    const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)');
    for (const [id, name] of [[alice, 'AliceEdge'], [bob, 'BobEdge']] as const) {
        insertMember.run(id.pubKeyHex, name, iso(-30 * 86_400_000));
        insertAccount.run(id.pubKeyHex);
    }
    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, active, status, lat, lng)
                VALUES (?, ?, 'food', ?, 'A listing for the edge cache suite.', 0, ?, ?, ?, 1, 'active', ?, ?)`);
    for (let i = 0; i < 6; i++) {
        insertPost.run(`gec-post-${i}`, i % 2 ? 'need' : 'offer', `Lemons ${i}`, (i % 2 ? bob : alice).pubKeyHex, iso(-i * 60_000), iso(-i * 60_000),
            -28.55 + i * 0.01, 153.5 + i * 0.01);
    }
    db.prepare('INSERT INTO post_photos (post_id, order_num, photo_data) VALUES (?, 0, ?)').run('gec-post-0', 'data:image/jpeg;base64,/9j/AAAA');
    const conv = se.createConversation('dm', [alice.pubKeyHex, bob.pubKeyHex], alice.pubKeyHex);
    if (!conv) throw new Error('setup: no conversation');
    // A line as both apps seal one (engine/messaging.ts isEncryptedDmPayload): the node keeps nothing else in a DM.
    const sealed = () => [crypto.randomBytes(32).toString('base64'), `x25519-xc20p-v2:${crypto.randomBytes(24).toString('base64')}`] as const;
    se.sendMessage(conv.id, alice.pubKeyHex, ...sealed());

    type Got = { status: number; cc: string | null; vary: string; view: string | null; etag: string | null; body: string };
    async function get(path: string, how: { as?: Id; headers?: Record<string, string> } = {}): Promise<Got> {
        const headers: Record<string, string> = { ...(how.as ? signedHeaders(how.as, 'GET', path) : {}), ...(how.headers ?? {}) };
        const res = await localFetch(`${BASE}${path}`, { headers });
        return {
            status: res.status, cc: res.headers.get('cache-control'), vary: (res.headers.get('vary') ?? '').toLowerCase(),
            view: res.headers.get('x-beanpool-view'), etag: res.headers.get('etag'), body: await res.text(),
        };
    }
    const varies = (g: Got) => ['x-public-key', 'x-signature', 'authorization'].every(h => g.vary.split(',').map(s => s.trim()).includes(h));

    // ── 1. the board and the map ─────────────────────────────────────────────────────────────────────────────────────
    console.log('--- 1. the board and the map ---');
    const BOARD = '/api/marketplace/posts?types=offer,need&limit=50';
    const MAP = '/api/marketplace/posts?types=offer,need&lat=-28.55&lng=153.5&radiusKm=50';
    for (const url of [BOARD, MAP, '/api/marketplace/posts?types=offer,need&q=Lemons', '/api/marketplace/posts?id=gec-post-0']) {
        const guest = await get(url);
        assert(guest.status === 200 && guest.cc === GUEST, `an unsigned ${url} is ${GUEST} (got ${guest.status} ${guest.cc})`);
        assert(varies(guest), `and varies on X-Public-Key, X-Signature and Authorization (Vary: ${guest.vary})`);
    }
    const guestBoard = await get(BOARD);
    const memberBoard = await get(BOARD, { as: alice });
    assert(memberBoard.status === 200 && !sharable(memberBoard.cc) && /private/.test(memberBoard.cc ?? ''),
        `the same URL signed by a member is private (${memberBoard.cc})`);
    assert(memberBoard.body !== guestBoard.body && memberBoard.body.includes(alice.pubKeyHex) && !guestBoard.body.includes(alice.pubKeyHex),
        "and its body is a member's: the authors are in it, and in the visitors' copy nobody is");
    assert(memberBoard.view === 'member' && guestBoard.view === 'guest', `and its view says so (${memberBoard.view} / ${guestBoard.view})`);
    assert(memberBoard.etag !== guestBoard.etag, 'and its tag is its own');
    const memberMap = await get(MAP, { as: alice });
    assert(memberMap.status === 200 && !sharable(memberMap.cc), `a member's map read is private (${memberMap.cc})`);
    const strangerBoard = await get(BOARD, { as: stranger });
    assert(strangerBoard.status === 200 && strangerBoard.view === 'guest' && !sharable(strangerBoard.cc),
        `signed by a key that is no member: the visitors' view, and still private (${strangerBoard.view}, ${strangerBoard.cc})`);
    for (const [label, headers] of [
        ['X-Public-Key alone', { 'X-Public-Key': alice.pubKeyHex }],
        ['X-Signature alone', { 'X-Signature': 'c2ln' }],
        ['an Authorization header', { Authorization: 'Bearer something' }],
        ["the admin's password header", { 'X-Admin-Password': 'not-it' }],
        ["an admin's session cookie", { Cookie: `${ADMIN_SESSION_COOKIE}=whatever` }],
        ["another web origin's request", { Origin: 'https://elsewhere.example' }],
    ] as const) {
        const g = await get(BOARD, { headers: headers as Record<string, string> });
        assert(!sharable(g.cc), `a board read carrying ${label} is never public (${g.status} ${g.cc})`);
    }
    const someCookie = await get(BOARD, { headers: { Cookie: '__cf_bm=edge-cookie' } });
    assert(someCookie.cc === GUEST, `a cookie that names nobody here (an edge's own) leaves it the visitors' (${someCookie.cc})`);
    for (const url of ['/api/marketplace/posts?types=offer,need&sync=true', `/api/marketplace/posts?types=offer,need&updatedAfter=${encodeURIComponent(iso(-3_600_000))}`]) {
        const g = await get(url);
        assert(g.status === 200 && !sharable(g.cc), `an unsigned sync or delta (${url.split('&').pop()}) is one reader's: private (${g.cc})`);
    }
    const refused = await get(`/api/marketplace/posts?author=${alice.pubKeyHex}`);
    assert(refused.status === 403 && !sharable(refused.cc), `an unsigned read of one member's listings is refused, never public (${refused.status} ${refused.cc})`);
    const bad = await get('/api/marketplace/posts?lat=999&lng=0');
    assert(bad.status === 400 && !sharable(bad.cc), `a bad point is a 400, never public (${bad.cc})`);
    const again = await get(BOARD, { headers: { 'If-None-Match': guestBoard.etag ?? '' } });
    assert(again.status === 304 && again.cc === GUEST, `an unsigned read of an unchanged board is a 304 that keeps ${GUEST} (${again.status} ${again.cc})`);

    // ── 2. Home and the global directory ─────────────────────────────────────────────────────────────────────────────
    console.log('--- 2. Home and the global directory ---');
    const HOME = '/api/home?lat=-28.55&lng=153.5';
    const guestHome = await get(HOME);
    assert(guestHome.status === 200 && guestHome.cc === GUEST && varies(guestHome), `the visitors' Home unsigned is ${GUEST} (${guestHome.status} ${guestHome.cc})`);
    const homeAgain = await get(HOME, { headers: { 'If-None-Match': guestHome.etag ?? '' } });
    assert(homeAgain.status === 304 && homeAgain.cc === GUEST, `and unchanged, a 304 that keeps it (${homeAgain.status} ${homeAgain.cc})`);
    const memberHome = await get(HOME, { as: alice });
    assert(memberHome.status === 200 && !sharable(memberHome.cc) && memberHome.body !== guestHome.body,
        `a member's Home is private and their own (${memberHome.cc})`);
    const strangerHome = await get(HOME, { as: stranger });
    assert(strangerHome.status === 200 && !sharable(strangerHome.cc), `signed by a key that is no member, private (${strangerHome.cc})`);
    const DIR = '/api/global/communities?lat=-28.55&lng=153.5';
    const guestDir = await get(DIR);
    assert(guestDir.status === 200 && guestDir.cc === GUEST && varies(guestDir), `the communities unsigned are ${GUEST} (${guestDir.status} ${guestDir.cc})`);
    const memberDir = await get(DIR, { as: alice });
    assert(memberDir.status === 200 && !sharable(memberDir.cc), `signed, private (${memberDir.cc})`);
    const CARD = '/api/global/home?lat=-28.55&lng=153.5';
    const guestCard = await get(CARD);
    assert(guestCard.status === 200 && guestCard.cc === GUEST, `the landing card unsigned is ${GUEST} (${guestCard.status} ${guestCard.cc})`);
    const memberCard = await get(CARD, { as: alice });
    assert(memberCard.status === 200 && !sharable(memberCard.cc) && /no-store/.test(memberCard.cc ?? ''),
        `signed, it holds the member's watches: private, no-store (${memberCard.cc})`);

    // ── 3. members' reads and per-member answers ─────────────────────────────────────────────────────────────────────
    console.log("--- 3. members' reads and per-member answers ---");
    const CONVS = `/api/messages/conversations/${alice.pubKeyHex}`;
    for (const [url, who] of [[CONVS, alice], ['/api/community/me', alice], ['/api/community/info', alice], ['/api/community/info', stranger]] as const) {
        const g = await get(url, { as: who });
        assert(g.status === 200 && !sharable(g.cc), `${url} signed${who === stranger ? ' by a key that is no member' : ''} is never public (${g.status} ${g.cc})`);
    }
    for (const url of [CONVS, '/api/community/me']) {
        const g = await get(url);
        assert(g.status === 401 && !sharable(g.cc), `${url} unsigned is refused, never public (${g.status} ${g.cc})`);
    }
    const PHOTO = '/api/marketplace/posts/gec-post-0/photos/0';
    const photoUnsigned = await get(PHOTO);
    assert(photoUnsigned.status === 200 && /public/.test(photoUnsigned.cc ?? ''), `a public listing's photo, unsigned as an <img> asks, is public as before (${photoUnsigned.cc})`);
    const photoSigned = await get(PHOTO, { as: alice });
    assert(photoSigned.status === 200 && !sharable(photoSigned.cc) && /max-age=31536000/.test(photoSigned.cc ?? '') && /private/.test(photoSigned.cc ?? ''),
        `the same photo signed: whatever its route says, for the reader's own cache only (${photoSigned.cc})`);

    // ── 4. ETags on the conversation list and the community's info ──────────────────────────────────────────────────
    console.log('--- 4. ETags ---');
    const convs1 = await get(CONVS, { as: alice });
    assert(!!convs1.etag, `the conversation list has a tag (${convs1.etag})`);
    const convs304 = await get(CONVS, { as: alice, headers: { 'If-None-Match': convs1.etag ?? '' } });
    assert(convs304.status === 304, `asked again with it, unchanged: 304 (${convs304.status})`);
    se.sendMessage(conv.id, bob.pubKeyHex, ...sealed());
    const convs2 = await get(CONVS, { as: alice, headers: { 'If-None-Match': convs1.etag ?? '' } });
    assert(convs2.status === 200 && !!convs2.etag && convs2.etag !== convs1.etag, `a new line: 200 with a new tag (${convs2.status} ${convs2.etag})`);
    const bobsConvs = await get(`/api/messages/conversations/${bob.pubKeyHex}`, { as: bob, headers: { 'If-None-Match': convs2.etag ?? '' } });
    assert(bobsConvs.status === 200 && bobsConvs.etag !== convs2.etag, "Bob's list is never confirmed with Alice's tag");
    const info1 = await get('/api/community/info');
    assert(info1.status === 200 && !!info1.etag && !sharable(info1.cc), `/api/community/info has a tag and is the reader's (${info1.etag}, ${info1.cc})`);
    const info304 = await get('/api/community/info', { headers: { 'If-None-Match': info1.etag ?? '' } });
    assert(info304.status === 304, `asked again unchanged: 304 (${info304.status})`);
    const infoSigned = await get('/api/community/info', { as: alice, headers: { 'If-None-Match': info1.etag ?? '' } });
    assert(infoSigned.status === 200 && infoSigned.etag !== info1.etag, "a member's (their own counts) is never confirmed with an unsigned reader's tag");

    // ── 5. a node without the visitors' view ─────────────────────────────────────────────────────────────────────────
    console.log("--- 5. without the visitors' view ---");
    setSwitchOverride('guestListingsOnly', false);
    assert(getProfileSwitches().guestListingsOnly === false, 'setup: the visitors\' view is off');
    const localMember = await get(BOARD, { as: alice });
    assert(localMember.status === 200 && !sharable(localMember.cc), `the board is members': a member's read is private (${localMember.status} ${localMember.cc})`);
    const localGuest = await get(BOARD);
    assert(localGuest.status === 401 && !sharable(localGuest.cc), `an unsigned read is refused, never public (${localGuest.status} ${localGuest.cc})`);
    const localHome = await get(HOME, { as: alice });
    assert(localHome.status === 200 && !sharable(localHome.cc), `a member's Home is private (${localHome.cc})`);
    const localHomeGuest = await get(HOME);
    assert(localHomeGuest.status === 401 && !sharable(localHomeGuest.cc), `an unsigned Home is refused, never public (${localHomeGuest.status} ${localHomeGuest.cc})`);
    setSwitchOverride('guestListingsOnly', true);
    assert(getProfileSwitches().guestListingsOnly === true, 'and back on');

    // ── 6. Beans off: the demurrage tick and the pricing aggregator write nothing ────────────────────────────────────
    console.log('--- 6. the jobs that do nothing where Beans are off ---');
    // What the 5-minute timer and the hourly worker run: on origin/main persistDecayAndCommons and runPricingAggregationCycle
    // themselves, with no switch read.
    const decayTick: () => unknown = typeof se.decayFlushTick === 'function' ? se.decayFlushTick : () => se.persistDecayAndCommons();
    const pricingTick: () => { updatedCount: number; totalEvaluated: number } | null =
        typeof pricing.pricingAggregatorTick === 'function' ? pricing.pricingAggregatorTick : pricing.runPricingAggregationCycle;
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    assert(getProfileSwitches().beans === false, 'setup: Beans are off on the global profile');
    const item = db.prepare("SELECT id, price_beans, confidence_count FROM pricing_guide_items WHERE id = 'ls-001'").get() as { id: string; price_beans: number; confidence_count: number } | undefined;
    assert(!!item, 'setup: the pricing guide has its babysitting item');
    const insertPriced = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status)
                VALUES (?, 'offer', 'care', ?, 'Babysitting for the edge suite', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1, 'active')`);
    insertPriced.run('gec-price-1', 'Babysitting evenings', 20, alice.pubKeyHex);
    insertPriced.run('gec-price-2', 'Babysitting weekends', 22, alice.pubKeyHex);
    insertPriced.run('gec-price-3', 'Babysitting after school', 24, alice.pubKeyHex);
    let before = changes();
    decayTick();
    assert(changes() === before, `Beans off: the demurrage tick writes nothing (${changes() - before} rows changed)`);
    before = changes();
    const offCycle = pricingTick();
    assert(changes() === before && offCycle === null, `Beans off: the hourly pricing run reads nothing and writes nothing (${changes() - before} rows changed, ${offCycle?.totalEvaluated ?? 0} items evaluated)`);
    // Last, as switching Beans on may count as the ledger moving, after which they stay on.
    setSwitchOverride('beans', true);
    assert(getProfileSwitches().beans === true, 'setup: Beans switched on');
    before = changes();
    decayTick();
    assert(changes() > before, `Beans on: the tick flushes the Commons pot, as before (${changes() - before} rows changed)`);
    const onCycle = pricingTick();
    assert(!!onCycle && onCycle.updatedCount > 0, `Beans on: the hourly run prices the guide, as before (${onCycle?.updatedCount} updated)`);

    // ── 7. the guard's rewrite ───────────────────────────────────────────────────────────────────────────────────────
    console.log("--- 7. the guard's rewrite ---");
    const privateOnly: ((cc: string) => string) | undefined = guestCache?.privateOnly;
    assert(typeof privateOnly === 'function', 'guest-cache.ts exports privateOnly');
    if (privateOnly) {
        for (const [said, own] of [
            ['public, max-age=31536000, immutable', 'private, max-age=31536000, immutable'],
            [GUEST, 'private, max-age=0'],
            ['public, max-age=0, must-revalidate', 'private, max-age=0, must-revalidate'],
            ['s-maxage=60, proxy-revalidate', 'private'],
            ['private, max-age=0, must-revalidate', 'private, max-age=0, must-revalidate'],
            ['no-store', 'no-store'],
        ] as const) {
            assert(privateOnly(said) === own && !sharable(privateOnly(said)), `"${said}" → "${privateOnly(said)}"`);
        }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
