/**
 * The phone's Market ends each sync holding exactly the listings the board gives the same member: the listings of an
 * author the board leaves out (on holiday, or an enterprise paused, winding up or wound up) leave the phone at its next
 * delta sync, and come back at the next one after the author does.
 *
 * The phone (apps/native services/pillar-sync.ts) reads `GET /api/marketplace/posts?limit=1000&sync=true&types=…` once,
 * then the same with `&updatedAfter=<its last sync, less five minutes>`, signed by the member's key. It writes every row
 * it is sent over the row it holds (utils/db.ts writeSyncedPost) and never deletes one; its Market shows a row by status
 * alone (utils/market-filters.ts feedPostVisible, utils/events.ts isEventInFeed). The sync read skips the board's author
 * filters on purpose, so that a row can reach the phone to take a listing off it; and an author's standing is not on
 * the listing, so a delta read by `posts.updated_at` alone never carried a change of it. The phone, which has no filter
 * of its own, kept those listings on its Market; the web app, which reads the board, did not.
 *
 * Boots the real server and reads the sync route over HTTP, signed, as the phone does, into a model of the phone's
 * cache. After every step the listings on that model's Market are the listings on the board the same member reads.
 *   - a member goes on holiday (POST /api/members/holiday) → gone at the next delta; holiday off → back;
 *   - an enterprise is paused → gone; resumed → back;
 *   - an enterprise starts winding up → gone; the wind-up is cancelled → back;
 *   - a fresh install's first (full) sync while a member is on holiday leaves their listings off;
 *   - the delta after a holiday switch carries that member's listings and no one else's (it stays a delta);
 *   - reading a listing by id for the cache (utils/db.ts getPost, `?id=…&sync=true`) doesn't put it back;
 *   - the author's own phone, and a member with an open deal on the listing, keep it as it is;
 *   - a deferred wage claim paid by processDeferredWageClaims, which completes a one-off listing, reaches the phone;
 *   - on 2,000 members and 20,000 posts, no statement of the delta read walks every post (EXPLAIN QUERY PLAN).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sync-author-off-board.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';

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

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function getJson(path: string, id: Id): Promise<any[]> {
    const res = await fetch(`${BASE}${path}`, { headers: signedHeaders('GET', path, '', id) });
    if (res.status !== 200) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return res.json() as Promise<any[]>;
}

async function postJson(path: string, payload: unknown, id: Id): Promise<{ status: number; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

/** The phone's feed query (apps/native utils/events.ts EVENT_TYPES_QUERY). */
const TYPES = 'types=offer,need,poll,event';

/**
 * The phone's posts cache and its Market, as apps/native has them: every synced row replaces the one held
 * (writeSyncedPost), nothing is ever deleted, and the Market shows a row by its status (feedPostVisible: a poll while
 * active or completed; an event while active, not cancelled and not ended; anything else while active).
 */
class Phone {
    rows = new Map<string, any>();
    private lastSyncMs: number | null = null;
    constructor(readonly id: Id) {}

    /** One sync as performSync does it: full the first time, then since the last one less five minutes' drift. */
    async sync(): Promise<any[]> {
        const since = this.lastSyncMs === null ? '' : `&updatedAfter=${encodeURIComponent(new Date(this.lastSyncMs - 300_000).toISOString())}`;
        const page = await getJson(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}${since}`, this.id);
        for (const p of page) this.rows.set(p.id, p);
        this.lastSyncMs = Date.now();
        return page;
    }

    /** The by-id refresh a listing's page runs (utils/db.ts getPost). */
    async openListing(postId: string): Promise<any> {
        const page = await getJson(`/api/marketplace/posts?id=${encodeURIComponent(postId)}&sync=true`, this.id);
        if (page[0]) this.rows.set(page[0].id, page[0]);
        return page[0];
    }

    market(): Set<string> {
        const now = Date.now();
        const on = [...this.rows.values()].filter(p => {
            if ((p.audienceScope ?? 'public') !== 'public') return false;
            if (p.type === 'poll') return p.status === 'active' || p.status === 'completed';
            if (p.type === 'event') {
                return p.status === 'active' && p.active !== false && p.eventState !== 'cancelled'
                    && !(p.eventEndAt && Date.parse(p.eventEndAt) <= now);
            }
            return p.status === 'active';
        });
        return new Set(on.map(p => p.id));
    }
}

async function main() {
    console.log('The phone\'s Market after a sync is the board, whatever the authors\' standing...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
    const seed = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const keep = (enterprise: string, keeper: Id, role = 'keeper') => {
        db.prepare(`INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, ?, 'admin')`)
            .run(enterprise, keeper.pubKeyHex, role);
        db.prepare(`UPDATE members SET can_operate = 1 WHERE public_key = ?`).run(keeper.pubKeyHex);
    };
    const offer = (author: string, title: string, repeatable = true) =>
        se.createPost('offer', 'food', title, '', 5, 'fixed', author, undefined, undefined, undefined, repeatable)!.id;
    const need = (author: string, title: string, credits = 5) =>
        se.createPost('need', 'work', title, '', credits, 'fixed', author)!.id;

    // ── Who is who ──
    const carol = seed('ReaderCarol');   // reads the board, and syncs her phone
    const hana = seed('HolidayHana');    // goes on holiday
    const olly = seed('OtherOlly');      // nobody changes: his listing is in no delta
    const bob = seed('BuyerBob');        // has an open deal on the paused enterprise's listing
    const pat = seed('KeeperPat');       // keeps the enterprises
    const dora = seed('WorkerDora');     // a keeper paid by a deferred wage claim
    const cass = seed('CustomerCass');   // buys from the bakery, which pays Dora's claim

    const hanaPosts = [
        offer(hana.pubKeyHex, 'Lemons'),
        need(hana.pubKeyHex, 'A ladder'),
        se.createPost('poll', 'community', 'Where should the tool library go?', '', 0, 'fixed', hana.pubKeyHex,
            undefined, undefined, undefined, false, undefined, false,
            { pollOptions: [{ id: 'a', text: 'The hall' }, { id: 'b', text: 'The shed' }] })!.id,
        se.createPost('event', 'community', 'Seed swap', '', 0, 'fixed', hana.pubKeyHex, -37.06, 144.21,
            undefined, false, undefined, false, {
                eventStartAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
                eventEndAt: new Date(Date.now() + 3 * 86_400_000 + 7_200_000).toISOString(),
                eventPlaceName: 'The hall',
            } as any)!.id,
    ];
    const ollyPost = offer(olly.pubKeyHex, 'Firewood');
    offer(bob.pubKeyHex, 'Bike repairs');
    offer(cass.pubKeyHex, 'Gardening');

    const { publicKey: farm } = se.createTreasury('PausedFarm', AVATAR, 100);
    keep(farm, pat, 'lead');
    const farmOffer = offer(farm, 'Eggs');
    const farmNeed = need(farm, 'Fence mending');
    const { publicKey: mill } = se.createTreasury('WindingMill', AVATAR, 100);
    keep(mill, pat, 'lead');
    const millPosts = [offer(mill, 'Flour'), need(mill, 'Sacks')];

    // Bob asks for the farm's eggs before the farm pauses: his deal stays open while it is paused.
    se.transfer('genesis', bob.pubKeyHex, 50, 'seed', 'direct', true);
    const bobDeal = se.requestPost(farmOffer, bob.pubKeyHex);
    assert(!!bobDeal?.id, 'Bob has an open request on the farm\'s eggs');

    // The bakery owes Dora a wage it can't yet pay: a deferred claim on its one-off need.
    const { publicKey: bakery } = se.createTreasury('Bakery', AVATAR, 100);
    keep(bakery, pat, 'lead');
    keep(bakery, dora);
    se.transfer('genesis', bakery, 50, 'grant', 'direct', true);
    // 40 Beans: the sale earns the surplus the 20-Bean claim needs.
    const bread = se.createPost('offer', 'food', 'Sourdough', '', 40, 'fixed', bakery, undefined, undefined, undefined, true)!.id;
    const shift = se.createPost('need', 'work', 'Bake shift', '', 20, 'fixed', bakery)!.id;
    const doraBid = se.requestPost(shift, dora.pubKeyHex);
    let refused = false;
    try { se.approvePostRequest(doraBid.id, bakery); } catch { refused = true; }
    const claim = db.prepare('SELECT status FROM deferred_wage_claims WHERE post_id = ?').get(shift) as any;
    assert(refused && claim?.status === 'pending', 'the bakery can\'t pay Dora yet: a deferred wage claim on its Bake shift');

    // A node that has been up a while: nothing has changed in the last hour, so a delta is what the steps below change.
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    db.prepare('UPDATE posts SET updated_at = ?').run(anHourAgo);
    db.prepare('UPDATE members SET updated_at = ?').run(anHourAgo);

    const ours = new Set<string>([...hanaPosts, ollyPost, farmOffer, farmNeed, ...millPosts, bread, shift]);
    const mine = (ids: Iterable<string>) => new Set([...ids].filter(id => ours.has(id)));
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));
    const show = (s: Set<string>) => [...s].map(id => (db.prepare('SELECT title FROM posts WHERE id = ?').get(id) as any)?.title).sort().join(', ');
    const board = async (id: Id) => mine((await getJson(`/api/marketplace/posts?limit=200&${TYPES}`, id)).map(p => p.id));

    /** After a sync: the phone's Market (of this test's listings) is the board the same member reads. */
    const matchesBoard = async (phone: Phone, label: string) => {
        const onBoard = await board(phone.id);
        const onPhone = mine(phone.market());
        assert(same(onBoard, onPhone), `${label}: the phone's Market is the board (board: ${show(onBoard)} | phone: ${show(onPhone)})`);
        return onPhone;
    };

    console.log('── the first sync ──');
    const phone = new Phone(carol);
    await phone.sync();
    const start = await matchesBoard(phone, 'first sync');
    assert(hanaPosts.every(id => start.has(id)) && start.has(farmOffer) && millPosts.every(id => start.has(id)),
        'everyone\'s listings are on the phone to begin with');

    console.log('\n── holiday ──');
    const on = await postJson('/api/members/holiday', { enabled: true }, hana);
    assert(on.status === 200 && on.body?.success === true, `Hana goes on holiday over HTTP (got ${on.status})`);
    const holidayDelta = await phone.sync();
    const afterHoliday = await matchesBoard(phone, 'Hana on holiday, next delta');
    assert(hanaPosts.every(id => !afterHoliday.has(id)), 'none of Hana\'s four listings (offer, need, poll, event) is on the phone\'s Market');
    assert(same(mine(holidayDelta.map(p => p.id)), new Set(hanaPosts)),
        `the delta carries Hana's listings and no one else's (got: ${show(mine(holidayDelta.map(p => p.id)))})`);
    assert(!holidayDelta.some(p => p.id === ollyPost), 'Olly\'s listing, which nothing changed, is not in the delta');

    // Opening one of Hana's listings (a chat's "View Post") refreshes the cached row by id: it must not come back.
    const opened = await phone.openListing(hanaPosts[0]);
    assert(!!opened && opened.id === hanaPosts[0] && opened.title === 'Lemons' && opened.status === 'paused',
        `the phone can still open Hana's listing by id, whole, and it reads as paused (status ${opened?.status})`);
    assert(!phone.market().has(hanaPosts[0]), 'opening it by id doesn\'t put it back on the phone\'s Market');

    // A fresh install's first sync while she is away.
    const fresh = new Phone(carol);
    await fresh.sync();
    await matchesBoard(fresh, 'a fresh install\'s full sync while Hana is on holiday');

    // Hana's own phone keeps her listings as they are: the node's read of her own listings shows them to her.
    const hanaPhone = new Phone(hana);
    await hanaPhone.sync();
    assert(hanaPosts.every(id => hanaPhone.rows.get(id)?.status === 'active'),
        'Hana\'s own phone holds her listings as they are (status active)');

    const off = await postJson('/api/members/holiday', { enabled: false }, hana);
    assert(off.status === 200 && off.body?.success === true, `Hana is back: holiday off over HTTP (got ${off.status})`);
    await phone.sync();
    const back = await matchesBoard(phone, 'Hana back, next delta');
    assert(hanaPosts.every(id => back.has(id)), 'all four of Hana\'s listings are back on the phone\'s Market, without a full resync');
    assert(phone.rows.get(hanaPosts[0])?.title === 'Lemons', 'and they are the real listings');

    console.log('\n── a paused enterprise ──');
    const bobPhone = new Phone(bob);
    await bobPhone.sync();
    se.pauseEnterprise(farm, 'admin');
    await phone.sync();
    const paused = await matchesBoard(phone, 'the farm paused, next delta');
    assert(!paused.has(farmOffer) && !paused.has(farmNeed), 'the paused farm\'s listings are off the phone\'s Market');
    await bobPhone.sync();
    const bobsCopy = bobPhone.rows.get(farmOffer);
    assert(bobsCopy?.status === 'active' && bobsCopy?.title === 'Eggs',
        `Bob, who has an open deal on the eggs, keeps the listing as it is (status ${bobsCopy?.status})`);

    se.resumeEnterprise(farm, 'admin');
    await phone.sync();
    const resumed = await matchesBoard(phone, 'the farm resumed, next delta');
    assert(resumed.has(farmOffer) && resumed.has(farmNeed), 'the farm\'s listings are back on the phone\'s Market');

    console.log('\n── an enterprise winding up ──');
    se.initiateWindUp(mill, pat.pubKeyHex);
    await phone.sync();
    const winding = await matchesBoard(phone, 'the mill winding up, next delta');
    assert(millPosts.every(id => !winding.has(id)), 'the winding-up mill\'s listings are off the phone\'s Market');
    se.cancelWindUp(mill, pat.pubKeyHex);
    await phone.sync();
    const unwound = await matchesBoard(phone, 'the mill\'s wind-up cancelled, next delta');
    assert(millPosts.every(id => unwound.has(id)), 'the mill\'s listings are back on the phone\'s Market');

    console.log('\n── a deferred wage claim ──');
    assert(phone.market().has(shift), 'the bakery\'s Bake shift is on the phone\'s Market while Dora\'s claim waits');
    se.transfer('genesis', cass.pubKeyHex, 100, 'seed', 'direct', true);
    const cassBid = se.requestPost(bread, cass.pubKeyHex);
    se.approvePostRequest(cassBid.id, bakery);
    se.completePostTransaction(cassBid.id, cass.pubKeyHex);
    const paid = db.prepare('SELECT status FROM deferred_wage_claims WHERE post_id = ?').get(shift) as any;
    assert(paid?.status === 'paid', 'Cass\'s purchase lets processDeferredWageClaims pay Dora\'s claim');
    await phone.sync();
    const afterClaim = await matchesBoard(phone, 'the claim paid, next delta');
    assert(!afterClaim.has(shift), 'the completed Bake shift is off the phone\'s Market');
    assert(phone.rows.get(shift)?.status === 'completed', 'the delta carried it as completed');

    console.log('\n── the delta read searches its indexes, on a node\'s worth of posts ──');
    // 2,000 members and 20,000 posts that nothing has changed in a year, and twenty members on holiday with an upcoming
    // event each. Like a node, no sqlite_stat1: nothing runs ANALYZE.
    // Walking idx_posts_updated_at for the ORDER BY read every post and tested the OR on each (5 ms a delta here).
    const aYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    db.transaction(() => {
        const member = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, updated_at)
                                   VALUES (?, ?, 'active', ?, 'seed', ?, ?)`);
        const post = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active,
                                 created_at, updated_at, event_start_at, event_end_at) VALUES (?, ?, 'food', ?, '', 5, ?, 'active', 1, ?, ?, ?, ?)`);
        const keys = Array.from({ length: 2000 }, (_, i) => {
            const k = crypto.randomBytes(32).toString('hex');
            member.run(k, `Bulk${i}`, aYearAgo, `INV-BULK${i}`, aYearAgo);
            return k;
        });
        for (let i = 0; i < 20_000; i++) post.run(crypto.randomUUID(), i % 2 ? 'offer' : 'need', `Bulk ${i}`, keys[i % keys.length], aYearAgo, aYearAgo, null, null);
        for (const k of keys.slice(0, 20)) {
            db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')`).run(k);
            post.run(crypto.randomUUID(), 'event', 'Holiday event', k, aYearAgo, aYearAgo, nextWeek, nextWeek);
        }
    })();
    // Every statement the phone's delta read prepares, with what it ran it with.
    const ran: Array<{ sql: string; params: any[] }> = [];
    const prepare = db.prepare;
    (db as any).prepare = (sql: string) => new Proxy(prepare.call(db, sql), {
        get(stmt, prop) {
            const value = Reflect.get(stmt, prop, stmt);
            if (typeof value !== 'function') return value;
            if (prop !== 'all' && prop !== 'get') return value.bind(stmt);
            return (...params: any[]) => { ran.push({ sql, params }); return value.apply(stmt, params); };
        },
    });
    let bulkDelta: any[];
    try { bulkDelta = await phone.sync(); } finally { (db as any).prepare = prepare; }
    const deltaRead = ran.find(r => /\bFROM posts p\b/.test(r.sql) && r.sql.includes('p.updated_at >= ?'));
    assert(!!deltaRead, 'the phone\'s delta read ran');
    assert(bulkDelta.length < 100 && !bulkDelta.some(r => /^Bulk \d/.test(r.title)),
        `it is still a delta: none of the 20,000 unchanged offers and needs is in it (${bulkDelta.length} rows)`);
    const plans = ran.filter(r => /\bFROM posts p\b/.test(r.sql)).map(r => ({
        sql: r.sql.replace(/\s+/g, ' ').trim().slice(0, 70),
        plan: (db.prepare(`EXPLAIN QUERY PLAN ${r.sql}`).all(...r.params) as Array<{ detail: string }>).map(p => p.detail),
    }));
    const walks = plans.filter(p => p.plan.some(d => /^SCAN p\b/.test(d)));
    assert(plans.length >= 1 && walks.length === 0,
        `no statement of the delta read walks every post (${walks.map(w => `${w.sql}…: ${w.plan.join('; ')}`).join(' | ') || `${plans.length} statements, none has SCAN p`})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The phone\'s Market after a sync is the board.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
