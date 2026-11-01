/**
 * Test Suite: a member's copy of an Offer or a Need on the global community (DESIGN-reaching-across-fable.md §1 row 4,
 * DESIGN-list-on-global-fable.md §7, §11 G1, Marty's note 2; slice G1′; engine/event-copy.ts). The copy path is the events'
 * (test-event-copy); this holds what a listing adds. Boots the real server on the global profile and goes through the real
 * middleware over HTTPS, signed:
 *
 *   1. the write: 0 Beans in `credits`, the price as words, the rounded point, and nothing of a deal, whatever is sent
 *   2. the reads: every way a listing leaves the node names nobody, for a visitor and a member
 *   3. the price: drawn from `shownPrice`; never a number any read of `credits` or a Beans filter can use
 *   4. no way to pay: every money and deal route refuses with Beans off
 *   5. an edit keeps to it; a listing's kind and price follow; nothing else can put a price on a post
 *   6. no read goes by who wrote it, for the paths a listing has and an event hadn't
 *   7. the kinds: group, direct and placeless listings are refused, not made in the open; a poll stays refused
 *   8. the unlisted host, and the row that goes
 *   9. probation, retention and Delete account count the copy
 *  10. a node that keeps no directory makes a plain post, as an older global would
 *  11. no way to pay with Beans on, where the guard alone stands: a node with a directory and Beans has copies too
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-offer-copy)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { localFetch } from './keepalive-test-fetch.js';
import { TEST_PHOTOS } from './post-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
type Answer = { status: number; body: any; text: string };
async function call(method: 'GET' | 'POST', p: string, id: Id | null, payload?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await localFetch(`${BASE}${p}`, {
        method,
        headers: { ...(id ? signedHeaders(method, p, body, id) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body } : {}),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}

const HOUR = 60 * 60 * 1000;
const EXACT = { lat: -28.68731, lng: 153.52219 };
const ROUNDED = { lat: -28.7, lng: 153.5 };
const HOST = 'mullum.example.org';
const NAME = 'Mullumbimby Commons';
const HOME_ID = '5b0d5a3e-5d6c-4f0a-9a57-222222222222';
const PRICE = { beans: 20, per: 'fixed' };

async function main() {
    console.log('A member\'s copy of an Offer or a Need on the global community...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { listingsForPeer } = await import('./federation-listings.js');
    const { writeDirectoryRows, normaliseRegistryRow } = await import('./engine/directory-cache.js');
    const { LISTING_COPY_CODE } = await import('./engine/escrow.js');
    const { OWNER_READ_TOOLS } = await import('./agent/owner-reads.js');
    const { MONEY_LIMITS } = await import('./config/writer-limits.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    const setSwitch = (name: string, value: string | null) => {
        if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
        else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
    };
    setSwitch('probation', 'false');

    const longAgo = new Date(Date.now() - 400 * 24 * HOUR).toISOString();
    const member = (name: string, joinedAt = longAgo): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, updated_at)
                    VALUES (?, ?, 'active', ?, 'genesis', 'TEST', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, name, joinedAt);
        setMemberPhoto(db, id.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const robin = member('RobinSeller');
    const sam = member('SamReader');

    const row = (url: string, name: string, extra: Record<string, unknown> = {}) => normaliseRegistryRow({
        node_id: url, shown_name: name, node_url: url, last_seen_at: new Date().toISOString(), accepting_knocks: true, ...extra,
    })!;
    const directory = (rows: ReturnType<typeof row>[]) => writeDirectoryRows(rows, new Date().toISOString());
    directory([row(`https://${HOST}`, NAME)]);

    const listing = (who: Id, title: string, extra: Record<string, unknown> = {}) => ({
        id: crypto.randomUUID(), type: 'offer', category: 'food', title, description: 'Fresh this morning', authorPublicKey: who.pubKeyHex,
        ...EXACT, photos: TEST_PHOTOS, tags: [], freeTags: ['sourdough'], shownPrice: PRICE,
        shownFrom: { host: HOST, postId: HOME_ID, name: 'A name the phone made up' },
        ...extra,
    });
    const postCopy = (who: Id, title: string, extra: Record<string, unknown> = {}) => call('POST', '/api/marketplace/posts', who, listing(who, title, extra));
    const stored = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
    const byId = async (id: string, who: Id | null) => (await call('GET', `/api/marketplace/posts?id=${id}`, who)).body?.[0];

    const { setMemberArea } = await import('./engine/member-area.js');
    setMemberArea(sam.pubKeyHex, ROUNDED);
    const socketOf = (id: Id): Promise<{ ws: WebSocket; raw: string[] }> => new Promise((resolve, reject) => {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
        const ws = new WebSocket(`wss://localhost:${port}/ws?pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', (d) => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
    });
    const samSocket = await socketOf(sam);

    // ── 1. The write ──
    console.log('── 1. The write ──');
    const made = await postCopy(robin, 'Sourdough loaves', {
        // Sent here to prove they don't land. The phone sends none of them.
        credits: 20, priceType: 'hourly', repeatable: true, cashAlsoNeeded: true, lendable: true, lendMaxDays: 7, lendTerms: 'Ring 0400 000 000', replacementValue: '50 dollars',
        reach: 'everywhere', shopId: 'a-shop', targetPubkey: sam.pubKeyHex,
    });
    const copyId: string = made.body?.post?.id;
    assert(made.status === 200 && !!copyId, `a copy is made by its member's key, a price in \`credits\` sent or not (${made.status} ${made.text.slice(0, 160)})`);
    const kept = stored(copyId);
    assert(kept?.shown_from_host === HOST && kept?.shown_from_post_id === HOME_ID, 'it keeps the host of a shown row and the listing\'s id there');
    assert(kept?.credits === 0 && kept?.price_type === 'fixed', `\`credits\` is 0: the column every Beans read goes by holds nothing (${kept?.credits} ${kept?.price_type})`);
    assert(kept?.shown_price === '20 fixed', `the price is kept for its words alone (${kept?.shown_price})`);
    assert(kept?.lat === ROUNDED.lat && kept?.lng === ROUNDED.lng, `the point stored is the rounded home point, whatever was sent (${kept?.lat}, ${kept?.lng})`);
    assert(kept?.repeatable === 0 && kept?.cash_also_needed === 0 && !kept?.lendable && kept?.lend_terms === null && kept?.replacement_value === null,
        'nothing of a deal lands: no repeat, no cash, no lending and no lender\'s words');
    assert(kept?.shop_id === null && kept?.reach === 'local' && kept?.target_pubkey === null && kept?.audience_scope === 'public', 'no shop, no reach past this board, nobody named');
    assert(made.body?.post?.shownCopy === true && made.body?.post?.authorPublicKey === robin.pubKeyHex, 'its author\'s answer says it is a copy, and that it is theirs');
    const need = await postCopy(robin, 'Help moving a piano', { type: 'need', shownPrice: { beans: 5, per: 'hourly' } });
    assert(need.status === 200 && stored(need.body?.post?.id)?.shown_price === '5 hourly' && stored(need.body?.post?.id)?.credits === 0, 'a Need is the same, with its unit');
    const loan = await postCopy(robin, 'Post-hole digger', { shownPrice: { beans: 3, per: 'daily' } });
    assert(loan.status === 200 && stored(loan.body?.post?.id)?.shown_price === '3 daily', 'a lendable Offer counts as an Offer: its price and unit, and no lending here');
    const free = await postCopy(robin, 'Free lemons', { shownPrice: { beans: 0, per: 'fixed' } });
    assert(free.status === 200 && (await byId(free.body?.post?.id, sam))?.shownPrice === '0 fixed', 'a free listing says so: a price of nothing is a price');
    for (const [what, price] of [['none', undefined], ['words', { beans: 'twenty', per: 'fixed' }], ['below nothing', { beans: -1, per: 'fixed' }], ['past the most', { beans: 2_000_000, per: 'fixed' }], ['an unknown unit', { beans: 1, per: 'fortnightly' }], ['free text', 'Ring me on 0400 000 000']] as const) {
        const refused = await postCopy(robin, `Bad price, ${what}`, { shownPrice: price });
        assert(refused.status === 400, `a price of ${what} is refused, and the phone's words never stand in for one (${refused.status})`);
    }

    // ── 2. The reads ──
    console.log('\n── 2. The reads ──');
    const leaks = (json: string, who: string) => {
        for (const [what, needle] of [['the key', robin.pubKeyHex], ['the name', 'RobinSeller'], ['the exact pin', '153.52219'], ['the phone\'s words', 'A name the phone made up'],
            ['a face', '/api/avatar/'], ['the lender\'s words', '0400 000 000']] as const) {
            assert(!json.includes(needle), `${who}: no ${what}`);
        }
    };
    const save = await call('POST', '/api/members/preferences', sam, { publicKey: sam.pubKeyHex, preferences: { 'home.layout': { v: 2, cards: [{ id: 'search-loaf', type: 'search', settings: { q: 'sourdough', kind: 'any' } }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: new Date().toISOString() } } });
    assert(save.status === 200, `setup: a saved search (${save.status})`);
    for (const [who, id] of [['a visitor', null], ['a member', sam]] as const) {
        const one = await byId(copyId, id);
        assert(one?.title === 'Sourdough loaves' && one?.authorPublicKey === 'hidden' && one?.authorCallsign === '', `${who} reads it by id, with the neutral author`);
        assert(one?.shownCopy === true && one?.shownFrom?.name === NAME && one?.shownFrom?.door === 'ask' && one?.shownPrice === '20 fixed', `${who}: the from-line is the row's, the price is words`);
        assert(!('shownFromHost' in one) && !('shownFromPostId' in one) && one?.credits === 0, `${who}: never the stored columns, and no price in \`credits\``);
        assert(one?.lat === ROUNDED.lat && one?.lng === ROUNDED.lng, `${who}: the rounded point`);
        leaks(JSON.stringify(one), `${who}, by id`);
        for (const [what, path] of [
            ['the board', '/api/marketplace/posts?types=offer,need,poll,event&limit=100'],
            ['the Market\'s one kind', '/api/marketplace/posts?type=offer&limit=100'],
            ['from a point (the map\'s pins)', `/api/marketplace/posts?type=offer&lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&radiusKm=50`],
            ['nearest first', `/api/marketplace/posts?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&sort=distance`],
            ['fill, from elsewhere', '/api/marketplace/posts?lat=52.5&lng=13.4&sort=distance&limit=50'],
            ['search', '/api/marketplace/posts?q=sourdough'],
            ['a typed tag', '/api/marketplace/posts?free=sourdough'],
            ['a category', '/api/marketplace/posts?category=food'],
            ['a sync', '/api/marketplace/posts?sync=true&types=offer,need'],
            ['a delta', `/api/marketplace/posts?sync=true&updatedAfter=${encodeURIComponent(new Date(Date.now() - HOUR).toISOString())}`],
            ['Home', '/api/home'],
            ['the landing card', `/api/global/home?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}`],
            ['the shops near', `/api/shops?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}`],
            ['the activity feed', '/api/activity/feed'],
            ['the pricing guide', '/api/pricing-guide'],
        ] as const) {
            const read = await call('GET', path, id);
            leaks(read.text, `${who}, ${what}`);
        }
        const found = await call('GET', '/api/marketplace/posts?q=sourdough', id);
        assert(Array.isArray(found.body) && found.body.some((p: any) => p.id === copyId), `${who} finds it by its words`);
        const typed = await call('GET', '/api/marketplace/posts?free=sourdough', id);
        assert(Array.isArray(typed.body) && typed.body.some((p: any) => p.id === copyId), `${who} finds it by a typed tag`);
        const pins = await call('GET', `/api/marketplace/posts?type=offer&lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&radiusKm=50`, id);
        assert(Array.isArray(pins.body) && pins.body.find((p: any) => p.id === copyId)?.distanceKm !== undefined, `${who} finds it from a point`);
        // The newest few: any of the copies made above. Each says the same of itself.
        const onHome = (await call('GET', '/api/home', id)).body?.cards?.market?.items?.find((i: any) => i.title === 'Free lemons');
        assert(onHome?.shownCopy === true && onHome?.shownFrom?.name === NAME && onHome?.shownPrice === '0 fixed' && onHome?.credits === undefined,
            `${who}, Home's Market: says it is a copy, where from and its words (${JSON.stringify(onHome)?.slice(0, 170)})`);
    }
    const nearbySet = await call('GET', '/api/marketplace/posts?nearby=1&sync=true', sam);
    assert(JSON.stringify(nearbySet.body?.posts ?? []).includes(copyId), 'a member near it has it in their set');
    leaks(nearbySet.text, 'a member, their set');
    const saved = (await call('GET', '/api/home', sam)).body?.cards?.['search-loaf']?.items?.find((i: any) => i.id === copyId);
    assert(saved?.shownCopy === true && saved?.shownFrom?.name === NAME && saved?.shownPrice === '20 fixed', `a saved search: says the same (${JSON.stringify(saved)?.slice(0, 160)})`);
    const photo = await localFetch(`${BASE}${(await byId(copyId, null))?.photos?.[0]}`);
    assert(photo.status === 200, `its photo opens for anyone, as a listing's on the board does (${photo.status})`);
    assert(!JSON.stringify(listingsForPeer('any-peer')).includes(copyId), 'no peer is sent it, whatever reach was asked for');
    await new Promise((r) => setTimeout(r, 200));
    const onSocket = samSocket.raw.join('\n');
    assert(onSocket.includes(copyId), `a member near it hears that it changed (${samSocket.raw.length} frames)`);
    leaks(onSocket, 'a member, the socket');
    assert(!onSocket.includes('Sourdough loaves'), 'the socket carries the id, and no copy of the listing');
    samSocket.ws.close();
    const tool = (OWNER_READ_TOOLS as any[]).find((x) => x.name === 'listings_search');
    const search = tool.run({ id: 'g', name: 'g', member: sam.pubKeyHex, role: 'owner', via: 'token', createdAt: 0, expiresAt: null, canPost: true }, { q: 'sourdough', include_text: true }, 'B');
    const inSearch = search.ok ? search.result.listings.find((l: any) => l.postId === copyId) : null;
    assert(inSearch?.by === 'another member', `MCP listings_search finds it, and names nobody (${JSON.stringify(inSearch ?? search).slice(0, 140)})`);
    leaks(JSON.stringify(search), 'MCP listings_search');
    const report = await call('POST', '/api/reports', sam, { reporterPubkey: sam.pubKeyHex, targetPubkey: 'hidden', targetPostId: copyId, reason: 'spam', details: 'test' });
    assert(report.status === 200 || report.status === 201, `a member can report it (${report.status} ${report.text.slice(0, 120)})`);
    leaks(report.text, 'the reporter, the answer');
    assert((db.prepare('SELECT target_pubkey FROM abuse_reports WHERE target_post_id = ?').get(copyId) as any)?.target_pubkey === robin.pubKeyHex, 'the moderators\' queue has the real author');
    db.prepare('DELETE FROM abuse_reports WHERE target_post_id = ?').run(copyId);
    // Hidden by reports: a sync read gives a removal, and a copy's names nobody (hiddenAsRemoved; found on #2711).
    db.prepare(`UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(copyId);
    const hiddenSync = await call('GET', '/api/marketplace/posts?sync=true&types=offer,need', sam);
    const hiddenRow = (hiddenSync.body as any[]).find((p) => p.id === copyId);
    assert(hiddenRow?.authorPublicKey === 'hidden' && hiddenRow?.title === '' && hiddenRow?.status === 'cancelled', `hidden by reports, a member's sync reads a removal that names nobody (${JSON.stringify(hiddenRow)?.slice(0, 120)})`);
    leaks(hiddenSync.text, 'a member, a sync with it hidden');
    assert(!(hiddenRow && 'shownPrice' in hiddenRow), 'and no price');
    db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(copyId);
    const mine = await call('GET', `/api/marketplace/posts?author=${robin.pubKeyHex}`, sam);
    assert(!mine.text.includes(copyId), 'one member\'s list, read by another, leaves it out');
    const own = await byId(copyId, robin);
    assert(own?.authorPublicKey === robin.pubKeyHex && own?.shownCopy === true && own?.shownPrice === '20 fixed', 'its author reads it as theirs, to tend it');
    const plain = await call('POST', '/api/marketplace/posts', robin, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Plain loaves', description: 'On global by hand', authorPublicKey: robin.pubKeyHex, ...ROUNDED, photos: TEST_PHOTOS });
    const plainRead = await byId(plain.body?.post?.id, sam);
    assert(plainRead?.authorPublicKey === robin.pubKeyHex && !plainRead?.shownCopy && !('shownPrice' in plainRead), 'a plain listing reads as it did, with its author (the control)');

    // ── 3. The price is words ──
    console.log('\n── 3. The price is words ──');
    assert((db.prepare('SELECT COUNT(*) AS c FROM posts WHERE id = ? AND credits > 0').get(copyId) as { c: number }).c === 0, 'the pricing guide reads `credits > 0`, and so never reads a copy');
    const refusedPrice = await call('POST', '/api/marketplace/posts', robin, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Priced loaves', description: 'x', authorPublicKey: robin.pubKeyHex, ...ROUNDED, photos: TEST_PHOTOS, credits: 20 });
    assert(refusedPrice.status === 403, `a plain post with a price is refused here as ever (${refusedPrice.status})`);
    const smuggled = await call('POST', '/api/marketplace/posts', robin, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Smuggled words', description: 'x', authorPublicKey: robin.pubKeyHex, ...ROUNDED, photos: TEST_PHOTOS, shownPrice: PRICE });
    assert(smuggled.status === 200 && stored(smuggled.body?.post?.id)?.shown_price === null, 'a price with no `shownFrom` lands nowhere: only a copy holds one');

    // ── 4. No way to pay ──
    console.log('\n── 4. No way to pay ──');
    const deals = () => (db.prepare('SELECT COUNT(*) AS c FROM marketplace_transactions').get() as { c: number }).c;
    const balance = () => (db.prepare('SELECT SUM(balance) AS b FROM accounts').get() as { b: number }).b;
    const before = { deals: deals(), balance: balance() };
    const doors = [
        ['take it up', '/api/marketplace/posts/accept', { postId: copyId, buyerPublicKey: sam.pubKeyHex }],
        ['ask for it', '/api/marketplace/posts/request', { postId: copyId, buyerPublicKey: sam.pubKeyHex }],
    ] as const;
    for (const [what, path, body] of doors) {
        const off = await call('POST', path, sam, body);
        assert(off.status >= 400, `Beans off: ${what} is refused (${off.status} ${off.text.slice(0, 100)})`);
        leaks(off.text, `Beans off, ${what}`);
    }
    // A request row put there by hand, as an older server might have left one. A made-up id would be refused by anything.
    const handMadeRequest = (id: string, seller: string, postId = copyId) => db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                VALUES (?, ?, ?, ?, 20, 'requested', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id, postId, sam.pubKeyHex, seller);
    const requestState = (id: string) => (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(id) as { status: string }).status;
    const dropRequest = (id: string) => db.prepare('DELETE FROM marketplace_transactions WHERE id = ?').run(id);
    handMadeRequest('hand-made-off', robin.pubKeyHex);
    const asApprove = await call('POST', '/api/marketplace/transactions/approve', robin, { transactionId: 'hand-made-off', authorPublicKey: robin.pubKeyHex });
    assert(asApprove.status >= 400 && requestState('hand-made-off') === 'requested', `Beans off: no request can be approved (${asApprove.status} ${asApprove.text.slice(0, 100)})`);
    dropRequest('hand-made-off');
    const rate =await call('POST', '/api/ratings', sam, { raterPubkey: sam.pubKeyHex, targetPubkey: robin.pubKeyHex, stars: 5, comment: 'Lovely', transactionId: copyId });
    assert(rate.status >= 400, `no review: a rating needs a finished deal, and a copy's id is none (${rate.status})`);
    // An older app's Message button on a copy: it knows only the neutral key, and no route takes a post in place of a person.
    const talk = await call('POST', '/api/messages/conversation', sam, { type: 'dm', participants: ['hidden', sam.pubKeyHex], createdBy: sam.pubKeyHex, postId: copyId });
    assert(talk.status === 400 && !talk.text.includes(robin.pubKeyHex), `no message door: the neutral author is nobody to write to (${talk.status} ${talk.text.slice(0, 90)})`);
    assert((db.prepare("SELECT COUNT(*) AS c FROM conversation_participants WHERE public_key = 'hidden'").get() as { c: number }).c === 0, 'and no conversation was made for it');
    const transfer = await call('POST', '/api/ledger/transfer', sam, { from: sam.pubKeyHex, to: robin.pubKeyHex, amount: 20, memo: copyId });
    assert(transfer.status === 403, `no send: Beans are off (${transfer.status} ${transfer.text.slice(0, 100)})`);
    assert(deals() === before.deals && balance() === before.balance, `no deal row, and no Bean moved (${before.deals} → ${deals()})`);

    // ── 5. An edit ──
    console.log('\n── 5. An edit ──');
    const edit = await call('POST', '/api/marketplace/posts/update', robin, {
        id: copyId, authorPublicKey: robin.pubKeyHex, title: 'Rye loaves', description: 'Baked today', category: 'tools', shownPrice: { beans: 25, per: 'hourly' }, lat: -28.61234, lng: 153.41234,
        credits: 25, priceType: 'hourly', reach: 'everywhere', reachPeers: ['peer'], repeatable: true, cashAlsoNeeded: true, lendable: true, lendTerms: 'Ring 0400 000 000', shopId: 'a-shop', audienceScope: 'group', targetGroupId: 'g',
    });
    const after = stored(copyId);
    assert(edit.status === 200 && after?.title === 'Rye loaves' && after?.shown_price === '25 hourly', `words and the price follow (${edit.status} ${edit.text.slice(0, 140)})`);
    assert(after?.category === 'tools', 'its category follows');
    assert(after?.lat === -28.6 && after?.lng === 153.4, `a moved pin is rounded (${after?.lat}, ${after?.lng})`);
    assert(after?.credits === 0 && after?.price_type === 'fixed' && after?.reach === 'local' && after?.repeatable === 0 && after?.cash_also_needed === 0 && !after?.lendable
        && after?.lend_terms === null && after?.shop_id === null && after?.audience_scope === 'public', 'nothing of a deal comes in by an edit');
    const badEdit = await call('POST', '/api/marketplace/posts/update', robin, { id: copyId, authorPublicKey: robin.pubKeyHex, shownPrice: 'Ring me' });
    assert(badEdit.status === 400 && stored(copyId)?.shown_price === '25 hourly', `free text is no price, on an edit too (${badEdit.status})`);
    for (const asked of [PRICE, '20 fixed']) {
        const plainEdit = await call('POST', '/api/marketplace/posts/update', robin, { id: plain.body?.post?.id, authorPublicKey: robin.pubKeyHex, shownPrice: asked });
        assert(plainEdit.status === 200 && stored(plain.body?.post?.id)?.shown_price === null, `an edit puts no price on a post that is no copy (${JSON.stringify(asked)}: ${plainEdit.status})`);
    }
    await call('POST', '/api/marketplace/posts/update', robin, { id: copyId, authorPublicKey: robin.pubKeyHex, shownPrice: PRICE });

    // ── 6. No read goes by who wrote it ──
    console.log('\n── 6. No read goes by who wrote it ──');
    const hasIt = async (path: string) => (await call('GET', path, sam)).text.includes(copyId);
    const paths = ['/api/marketplace/posts?q=Rye', '/api/marketplace/posts?type=offer&limit=100', '/api/marketplace/posts?free=sourdough', `/api/marketplace/posts?type=offer&lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&radiusKm=50`] as const;
    const control = await call('POST', '/api/marketplace/posts/update', robin, { id: plain.body?.post?.id, authorPublicKey: robin.pubKeyHex, title: 'Rye plain' });
    assert(control.status === 200, 'setup: the plain listing matches the same words');
    const block = await call('POST', '/api/blocks', sam, { targetPubkey: robin.pubKeyHex });
    assert(block.status === 200, `setup: Sam blocks Robin (${block.status})`);
    for (const path of paths) assert(await hasIt(path), `a block leaves a copy where it is: ${path.slice(0, 60)}`);
    assert(!(await call('GET', '/api/marketplace/posts?q=Rye', sam)).text.includes(plain.body?.post?.id), 'a block takes their plain listing off a search (the control)');
    await call('POST', '/api/blocks/remove', sam, { targetPubkey: robin.pubKeyHex });
    db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')`).run(robin.pubKeyHex);
    for (const path of paths.slice(1, 2)) assert(await hasIt(path), `a holiday leaves a copy where it is: ${path.slice(0, 60)}`);
    db.prepare(`DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'`).run(robin.pubKeyHex);

    // ── 7. The kinds ──
    console.log('\n── 7. The kinds ──');
    const count = () => (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c;
    for (const [what, extra] of [
        ['a group\'s listing', { audienceScope: 'group', targetGroupId: 'g' }],
        ['a direct listing', { audienceScope: 'direct', targetPubkey: sam.pubKeyHex }],
        ['a listing with no place', { lat: undefined, lng: undefined }],
        ['a poll', { type: 'poll', pollOptions: ['a', 'b'] }],
    ] as const) {
        const n = count();
        const refused = await postCopy(robin, `Not for here: ${what}`, extra);
        assert(refused.status === 400 && count() === n, `${what} is refused, not made in the open (${refused.status} ${refused.text.slice(0, 100)})`);
    }

    // ── 8. The unlisted host, and the row that goes ──
    console.log('\n── 8. The unlisted host, and the row that goes ──');
    const bare = await postCopy(robin, 'From a hidden valley', { shownFrom: { host: 'hidden-valley.example.org', postId: HOME_ID } });
    const bareRow = stored(bare.body?.post?.id);
    assert(bare.status === 200 && bareRow?.shown_from_host === '' && bareRow?.shown_from_post_id === null && !JSON.stringify(bareRow).includes('hidden-valley'), 'an unlisted host is dropped at write, and is nowhere in the row');
    assert(bare.body?.post?.shownCopy === true && !bare.body?.post?.shownFrom, 'the answer has no from-line, so the phone can say so once');
    const bareRead = await byId(bare.body?.post?.id, sam);
    assert(bareRead?.authorPublicKey === 'hidden' && bareRead?.shownCopy === true && !bareRead?.shownFrom && bareRead?.shownPrice === '20 fixed', 'still a copy: no author, no line, and its price in words');
    const withRow = (await byId(copyId, sam));
    directory([]);
    const noRow = await byId(copyId, sam);
    assert(withRow?.shownFrom?.name === NAME && noRow?.shownCopy === true && !noRow?.shownFrom && noRow?.authorPublicKey === 'hidden', 'a row that goes takes its line and door, and the copy stays a copy');
    directory([row(`https://${HOST}`, NAME, { accepting_knocks: false })]);
    assert((await byId(copyId, sam))?.shownFrom?.door === 'invite', 'a community that stops taking requests: the door says by invite at the next read');
    directory([row(`https://${HOST}`, NAME)]);

    // ── 9. Probation, retention, Delete account ──
    console.log('\n── 9. Probation, retention, Delete account ──');
    setSwitch('probation', null);
    const fresh = member('NewNoor', new Date(Date.now() - HOUR).toISOString());
    let allowed = 0;
    for (let i = 0; i < 6; i++) if ((await postCopy(fresh, `Copy ${i}`)).status === 200) allowed++;
    assert(allowed > 0 && allowed < 6, `probation counts a copy as any post (${allowed} of 6 went up)`);
    setSwitch('probation', 'false');
    const old = (await postCopy(robin, 'Left alone')).body?.post?.id;
    const stale = new Date(Date.now() - 100 * 24 * HOUR).toISOString();
    db.prepare('UPDATE posts SET updated_at = ?, created_at = ? WHERE id = ?').run(stale, stale, old);
    se.archiveStaleListings();
    assert(stored(old)?.status === 'cancelled' || stored(old)?.active === 0, `retention archives an untended copy (${stored(old)?.status})`);
    const { scrubPostsOf } = await import('./engine/post-scrub.js') as any;
    const gone = (await postCopy(sam, 'Sam\'s last loaf')).body?.post?.id;
    scrubPostsOf(sam.pubKeyHex, new Date().toISOString());
    assert(stored(gone)?.shown_price === null && stored(gone)?.shown_from_host === '' && stored(gone)?.credits === 0, `Delete account takes the price with the rest (${stored(gone)?.shown_price})`);

    // ── 10. A node that keeps no directory ──
    console.log('\n── 10. A node that keeps no directory ──');
    setSwitch('directoryMirror', 'false');
    const ignored = await postCopy(robin, 'On an older global');
    assert(ignored.status === 200 && !ignored.body?.post?.shownCopy && stored(ignored.body?.post?.id)?.shown_from_host === null && stored(ignored.body?.post?.id)?.shown_price === null,
        'the fields are ignored: a plain post, and the phone sees that and takes it down');
    setSwitch('directoryMirror', null);

    // ── 11. Beans on ── Last: a node that has opened an escrow keeps its money on for good.
    console.log('\n── 11. Beans on ──');
    const deals2 = deals();
    // A node with Beans on and a directory has copies too, and there the switch stops nothing: the refusal stands alone.
    const beforeBalance = balance();
    setSwitch('beans', 'true'); setSwitch('escrow', 'true');
    for (const [what, path, body] of doors) {
        const on = await call('POST', path, sam, body);
        assert(on.status === 409 && on.body?.code === LISTING_COPY_CODE, `Beans on: ${what} is refused with the copy's words (${on.status} ${on.text.slice(0, 120)})`);
        leaks(on.text, `Beans on, ${what}`);
    }
    const inSpanish = await call('POST', '/api/marketplace/posts/accept', sam, { postId: copyId, buyerPublicKey: sam.pubKeyHex }, { 'X-Language': 'es' });
    assert(inSpanish.status === 409 && /otra comunidad/.test(inSpanish.body?.error ?? ''), `the refusal is in the member's language (${inSpanish.text.slice(0, 120)})`);
    // A request row put there by hand: still no approval, and it says why, not merely that something went wrong.
    handMadeRequest('hand-made', robin.pubKeyHex);
    const approved = await call('POST', '/api/marketplace/transactions/approve', robin, { transactionId: 'hand-made', authorPublicKey: robin.pubKeyHex });
    assert(approved.status === 409 && approved.body?.code === LISTING_COPY_CODE && requestState('hand-made') === 'requested', `Beans on: a request on a copy is never approved (${approved.status} ${approved.text.slice(0, 120)})`);
    dropRequest('hand-made');
    // The enterprise's own door to the same approval (routes/treasury.ts), on a copy put under its name by hand.
    const enterprise = member('CopyBakeryCo');
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(enterprise.pubKeyHex);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(enterprise.pubKeyHex, robin.pubKeyHex);
    handMadeRequest('hand-made-enterprise', enterprise.pubKeyHex);
    const byEnterprise = await call('POST', `/api/treasury/${enterprise.pubKeyHex}/approve`, robin, { transactionId: 'hand-made-enterprise' });
    assert(byEnterprise.status === 409 && byEnterprise.body?.code === LISTING_COPY_CODE && requestState('hand-made-enterprise') === 'requested', `Beans on: nor by an enterprise's own door (${byEnterprise.status} ${byEnterprise.text.slice(0, 120)})`);
    leaks(byEnterprise.text, 'Beans on, an enterprise approving');
    dropRequest('hand-made-enterprise');
    assert(balance() === beforeBalance, 'no Bean moved');
    // The money limits count a listing's author as a new person to pay. A copy's is never read: at the day's limit of new
    // people, a 429 for a stranger and a 409 for someone already paid would tell a member whether they had paid its author.
    const addPayment = db.prepare(`INSERT INTO money_acts (account, kind, recipient, new_recipient, made_at) VALUES (?, 'payment', ?, 1, ?)`);
    for (let i = 0; i < MONEY_LIMITS.newRecipientsPerDay; i++) addPayment.run(sam.pubKeyHex, keypair().pubKeyHex, new Date().toISOString());
    const plainAtLimit = await call('POST', '/api/marketplace/posts/accept', sam, { postId: plain.body?.post?.id, buyerPublicKey: sam.pubKeyHex });
    assert(plainAtLimit.status === 429 && plainAtLimit.body?.code === 'money_new_recipients_day', `at the day's limit of new people, a plain listing's author counts (the control: ${plainAtLimit.status} ${plainAtLimit.text.slice(0, 100)})`);
    for (const [what, path, body] of doors) {
        const atLimit = await call('POST', path, sam, body);
        assert(atLimit.status === 409 && atLimit.body?.code === LISTING_COPY_CODE, `at that limit, ${what} on a copy reads no author: the same answer, paid before or not (${atLimit.status} ${atLimit.text.slice(0, 100)})`);
    }
    db.prepare('DELETE FROM money_acts WHERE account = ?').run(sam.pubKeyHex);
    const editPrice =await call('POST', '/api/marketplace/posts/update', robin, { id: copyId, authorPublicKey: robin.pubKeyHex, credits: 20 });
    assert(stored(copyId)?.credits === 0, `Beans on: an edit can't give a copy a price in \`credits\` (${editPrice.status})`);
    const samsOffer = await call('POST', '/api/marketplace/posts', sam, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Sam lists first', description: 'x', authorPublicKey: sam.pubKeyHex, ...ROUNDED, photos: TEST_PHOTOS });
    assert(samsOffer.status === 200, `setup: Sam lists an Offer, as a community with Beans asks (${samsOffer.status})`);
    const before2 = deals();
    const asked = await call('POST', '/api/marketplace/posts/request', sam, { postId: plain.body?.post?.id, buyerPublicKey: sam.pubKeyHex });
    assert(asked.status === 200 && deals() === before2 + 1, `Beans on: a plain listing can be asked for (the control: ${asked.status} ${asked.text.slice(0, 120)})`);

    console.log(`\n${passed}/${run} checks passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
