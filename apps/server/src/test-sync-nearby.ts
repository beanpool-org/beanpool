/**
 * Test Suite: a member's phone asks the global node for its own set of listings (`nearby=1`, DESIGN-global-sync-by-area
 * §2.2-2.3, slice S1).
 *
 * On a node whose profile switch `nearbyListings` is on (the global profile), a member's sync read with `nearby=1` is
 * answered with their set S = the nearest 500 listings within 250 km of their stored area (members.area_lat / area_lng)
 * under the listing's own rules ∪ their own listings ∪ the ones they are tied to (an open deal, a conversation), as
 * `{ posts, set, setHash }`, with an ETag that describes S alone. Boots the real server on the global profile and reads
 * over HTTP, signed by members' keys, through the real middleware:
 *   1. brute force: for 30 members at three densities (a busy town with more than 500 listings within 250 km, a small
 *      town, nothing within 700 km), the set the node names is the brute-force S, the near part in NEAREST order; an
 *      author on holiday and a paused or winding-up enterprise are off it; with the bound (measureAtMost) below the
 *      listings in the box, the engine's set is the nearest of the newest that many; and every statement of a set reads
 *      an index (the box, the authors off the board, on holiday, and whose standing moved), never a table of people;
 *   2. a whole read in pages (paged=1, X-Posts-Next) brings exactly the rows of S, each once;
 *   3. after random writes, moves and removals, and one member moving their area, a delta from the old cursor plus the
 *      `set` (drop what is held outside it, fetch what is missing by `ids=`) gives the phone exactly the new S;
 *   4. the 304 holds while listings 300 km away change, and ends on a nearby change, an author's holiday, an area change;
 *   5. own and tied are kept: a paused own listing far away, an open deal far away, a conversation about one far away;
 *   6. a visitor's and an unsigned read with nearby=1 are answered byte for byte as without it; so is a member's read on
 *      a node with the switch off;
 *   7. `ids=` answers exactly what `id=` answers for each id (a group listing the reader isn't in, a hidden one);
 *   8. every nearby answer carries the identity epoch header, the 304 included;
 *   9. a member with no area gets the newest 100 listings; a listing posted with no place takes its author's area (Q4):
 *      an offer, and a poll (which never keeps a pin of its own, so one sent with a pin takes the area too);
 *  10. a member's set leaves out the authors she blocked: blocking the author of her 60 nearest listings fills it with
 *      the next nearest.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-sync-nearby)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
delete process.env.NEARBY_LISTINGS_MAX;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { haversineKm, boundingBox, getNearbySet } from '@beanpool/engine';
import { localFetch } from './keepalive-test-fetch.js';

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

const TYPES = 'offer,need,poll,event';
/** The phone's sync read (pillar-sync.ts), by area. */
const SYNC = `/api/marketplace/posts?limit=200&sync=true&types=${TYPES}`;
const EPOCH = 'x-beanpool-epoch';

type Row = { id: string; title: string; status: string; lat: number | null; lng: number | null };
type Answer = { status: number; next: string | null; etag: string | null; epoch: string | null; text: string; posts: Row[]; set: string[]; setHash: string };

async function get(path: string, id: Id | null, headers: Record<string, string> = {}): Promise<Answer> {
    const res = await localFetch(`${BASE}${path}`, { headers: { ...(id ? signedHeaders('GET', path, '', id) : {}), ...headers } });
    const text = await res.text();
    const body = res.status === 200 ? JSON.parse(text) : null;
    return {
        status: res.status,
        next: res.headers.get('x-posts-next'),
        etag: res.headers.get('etag'),
        epoch: res.headers.get(EPOCH),
        text,
        posts: Array.isArray(body) ? body : body?.posts ?? [],
        set: body?.set ?? [],
        setHash: body?.setHash ?? '',
    };
}

/** Every page of a nearby read: the rows in the order they came, the last page's set, each answer. */
async function readNearby(id: Id, since?: string) {
    const cursor = since ? `&updatedAfter=${encodeURIComponent(since)}` : '';
    const answers: Answer[] = [];
    let page = await get(`${SYNC}&nearby=1${cursor}&paged=1`, id);
    answers.push(page);
    while (page.status === 200 && page.next) {
        page = await get(`${SYNC}&nearby=1${cursor}&pageAfter=${encodeURIComponent(page.next)}`, id);
        answers.push(page);
    }
    if (answers.some(a => a.status !== 200)) throw new Error(`a nearby page answered ${answers.map(a => a.status).join(',')}`);
    return { rows: answers.flatMap(a => a.posts), set: page.set, answers };
}

const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
    const x = new Set(a), y = new Set(b);
    return x.size === y.size && [...x].every(v => y.has(v));
};

// A seeded random, so a failure reproduces.
let seedState = 0x5eed;
function rand(): number {
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
}

async function main() {
    console.log('A member\'s set of nearby listings (nearby=1)...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    const memberAt = (callsign: string, area: { lat: number; lng: number } | null): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng, area_updated_at)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, area?.lat ?? null, area?.lng ?? null, area ? new Date().toISOString() : null);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };

    // ── The world: a busy town, a small town, far places; authors among them ──
    const BUSY = { lat: -33.9, lng: 151.2 };
    const SMALL = { lat: -37.1, lng: 144.2 };
    const EMPTY = { lat: 10.0, lng: -150.0 };   // the Pacific: nothing within 700 km
    const authors = Array.from({ length: 40 }, (_, i) => memberAt(`Author${i}`, null));
    const iso = (ms: number) => new Date(ms).toISOString();
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    let n = 0;
    const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active,
                               created_at, updated_at, lat, lng) VALUES (?, ?, 'food', ?, '', 5, ?, 'active', 1, ?, ?, ?, ?)`);
    const around = (c: { lat: number; lng: number }, km: number) => {
        const r = km * Math.sqrt(rand()) / 111;
        const t = rand() * 2 * Math.PI;
        return { lat: c.lat + r * Math.sin(t), lng: c.lng + r * Math.cos(t) / Math.cos(c.lat * Math.PI / 180) };
    };
    const post = (place: { lat: number; lng: number } | null, author = authors[Math.floor(rand() * authors.length)], type = rand() < 0.7 ? 'offer' : 'need') => {
        const id = `p-${String(n++).padStart(5, '0')}`;
        const t = base + Math.floor(rand() * 30 * 86_400_000);
        insert.run(id, type, `Listing ${id}`, author.pubKeyHex, iso(t), iso(t + Math.floor(rand() * 1000)), place?.lat ?? null, place?.lng ?? null);
        return id;
    };
    db.transaction(() => {
        for (let i = 0; i < 1100; i++) post(around(BUSY, 300));        // ~750 within 250 km of the centre
        for (let i = 0; i < 90; i++) post(around(SMALL, 120));
        for (let i = 0; i < 400; i++) post(around({ lat: 51.5, lng: -0.1 }, 2000));
        for (let i = 0; i < 200; i++) post(around({ lat: 40.7, lng: -74 }, 1500));
        for (let i = 0; i < 60; i++) post(null);                        // no place
        // Ties of the millisecond near the busy town: the order ends on the id.
        const t = iso(base + 40 * 86_400_000);
        for (let i = 0; i < 12; i++) insert.run(`tie-${i}`, 'offer', `Tie ${i}`, authors[0].pubKeyHex, t, t, BUSY.lat + 0.01, BUSY.lng + 0.01);
    })();

    // The listing's own rules near the busy town: a group listing, a hidden one, an off-board author, a taken-off one.
    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Closed', 'closed', ?)`).run(groupId, authors[1].pubKeyHex);
    const grouped = post(around(BUSY, 5), authors[1]);
    db.prepare(`UPDATE posts SET audience_scope = 'group', target_group_id = ? WHERE id = ?`).run(groupId, grouped);
    const hidden = post(around(BUSY, 5), authors[2]);
    db.prepare(`UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?`).run(iso(Date.now()), hidden);
    const holidayAuthor = authors[3];
    se.setHolidayMode(holidayAuthor.pubKeyHex, true);
    const offBoard = post(around(BUSY, 5), holidayAuthor);
    const removed = post(around(BUSY, 5), authors[4]);
    db.prepare(`UPDATE posts SET active = 0, status = 'cancelled' WHERE id = ?`).run(removed);
    // An enterprise paused and one winding up: their listings are off the board (read on the author's key, not their row).
    db.prepare(`UPDATE members SET paused = 1 WHERE public_key = ?`).run(authors[10].pubKeyHex);
    db.prepare(`UPDATE members SET status = 'winding_up' WHERE public_key = ?`).run(authors[11].pubKeyHex);
    const pausedEnterprise = post(around(BUSY, 5), authors[10]);
    const windingUp = post(around(BUSY, 5), authors[11]);

    // 30 members: ten at each density (each 0.1° area), and a few kinds of ties for the first.
    const placeNear = (c: { lat: number; lng: number }) => {
        const p = around(c, 60);
        return { lat: Math.round(p.lat * 10) / 10, lng: Math.round(p.lng * 10) / 10 };
    };
    const members = [
        ...Array.from({ length: 10 }, (_, i) => ({ id: memberAt(`Busy${i}`, placeNear(BUSY)), kind: 'busy' })),
        ...Array.from({ length: 10 }, (_, i) => ({ id: memberAt(`Small${i}`, placeNear(SMALL)), kind: 'small' })),
        ...Array.from({ length: 10 }, (_, i) => ({ id: memberAt(`Empty${i}`, placeNear(EMPTY)), kind: 'empty' })),
    ];
    const ana = members[0].id;
    const farOwn = post({ lat: 51.5, lng: -0.1 }, ana);
    db.prepare(`UPDATE posts SET status = 'paused' WHERE id = ?`).run(farOwn);
    const farDeal = post({ lat: 40.7, lng: -74 }, authors[5]);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                VALUES (?, ?, ?, ?, 5, 'requested', ?)`).run(crypto.randomUUID(), farDeal, ana.pubKeyHex, authors[5].pubKeyHex, iso(Date.now()));
    const farTalk = post({ lat: 48.8, lng: 2.3 }, authors[6]);
    const conv = crypto.randomUUID();
    db.prepare(`INSERT INTO conversations (id, type, post_id, created_by) VALUES (?, 'dm', ?, ?)`).run(conv, farTalk, ana.pubKeyHex);
    db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?), (?, ?)`).run(conv, ana.pubKeyHex, conv, authors[6].pubKeyHex);
    // A deal of someone else's on a far listing is no tie of Ana's; a closed deal is none either.
    const doneDeal = post({ lat: 40.7, lng: -74 }, authors[7]);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                VALUES (?, ?, ?, ?, 5, 'completed', ?)`).run(crypto.randomUUID(), doneDeal, ana.pubKeyHex, authors[7].pubKeyHex, iso(Date.now()));

    // ── The brute force: every post, every rule, in JavaScript ──
    const nowIso = () => new Date().toISOString();
    /** With `bound`: the nearest of the newest `bound` listings in the radius's box (the engine's measureAtMost). */
    function bruteSet(m: Id, bound?: number): { near: string[]; all: Set<string> } {
        const me = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(m.pubKeyHex) as { area_lat: number | null; area_lng: number | null };
        const rows = db.prepare(`SELECT p.id, p.type, p.status, p.active, p.lat, p.lng, p.updated_at, p.created_at, p.author_pubkey, p.audience_scope,
                    p.target_group_id, p.target_pubkey, p.assigned_to, p.hidden_by_reports_at, p.event_end_at, p.origin_node FROM posts p`).all() as any[];
        const onHoliday = new Set((db.prepare(`SELECT public_key FROM member_preferences WHERE pref_key = 'holiday_mode' AND pref_value = 'true'`).all() as any[]).map(r => r.public_key));
        const offEnterprise = new Set((db.prepare(`SELECT public_key FROM members WHERE NOT ((paused IS NULL OR paused = 0) AND (status IS NULL OR status NOT IN ('winding_up', 'completed')))`).all() as any[]).map(r => r.public_key));
        const blocked = new Set((db.prepare('SELECT blocked_pubkey FROM member_blocks WHERE owner_pubkey = ?').all(m.pubKeyHex) as any[]).map(r => r.blocked_pubkey));
        const myGroups = new Set((db.prepare(`SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'`).all(m.pubKeyHex) as any[]).map(r => r.group_id));
        const mayRead = (p: any) => !p.audience_scope || p.audience_scope === 'public'
            || (p.audience_scope === 'group' && (p.author_pubkey === m.pubKeyHex || myGroups.has(p.target_group_id)))
            || (p.audience_scope === 'direct' && [p.author_pubkey, p.target_pubkey, p.assigned_to].includes(m.pubKeyHex));
        const types = TYPES.split(',');
        const now = nowIso();
        const listed = rows.filter(p => types.includes(p.type) && p.active === 1
            && (['active', 'pending'].includes(p.status) || (p.type === 'poll' && p.status === 'completed'))
            && !(p.type === 'event' && p.event_end_at && p.event_end_at <= now)
            && !onHoliday.has(p.author_pubkey) && !offEnterprise.has(p.author_pubkey)
            && mayRead(p) && (!p.hidden_by_reports_at || p.author_pubkey === m.pubKeyHex) && !blocked.has(p.author_pubkey));
        let near: string[];
        if (me.area_lat == null || me.area_lng == null) {
            near = listed.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id.localeCompare(a.id))
                .slice(0, 100).map(p => p.id);
        } else {
            const box = boundingBox(me.area_lat!, me.area_lng!, 250);
            const placed = listed.filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            const inBox = bound === undefined ? placed : placed
                .filter(p => p.lat >= box.latMin && p.lat <= box.latMax && box.lngRanges.some(([a, b]) => p.lng >= a && p.lng <= b))
                .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || (b.created_at ?? '').localeCompare(a.created_at ?? '') || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
                .slice(0, bound);
            near = inBox
                .map(p => ({ p, d: haversineKm(me.area_lat!, me.area_lng!, p.lat, p.lng) }))
                .filter(x => x.d <= 250)
                .sort((a, b) => a.d - b.d || (b.p.updated_at ?? '').localeCompare(a.p.updated_at ?? '') || (b.p.created_at ?? '').localeCompare(a.p.created_at ?? '') || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))
                .slice(0, 500).map(x => x.p.id);
        }
        const deals = new Set((db.prepare(`SELECT post_id FROM marketplace_transactions WHERE (buyer_pubkey = ? OR seller_pubkey = ?) AND status IN ('requested', 'pending')`).all(m.pubKeyHex, m.pubKeyHex) as any[]).map(r => r.post_id));
        const talks = new Set((db.prepare(`SELECT c.post_id FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id WHERE cp.public_key = ? AND c.post_id IS NOT NULL`).all(m.pubKeyHex) as any[]).map(r => r.post_id));
        const extra = rows.filter(p => types.includes(p.type) && mayRead(p)
            && ((p.author_pubkey === m.pubKeyHex && !p.origin_node) || deals.has(p.id) || talks.has(p.id))).map(p => p.id);
        return { near, all: new Set([...near, ...extra]) };
    }

    // ── 1. brute force, 30 members, three densities ──
    console.log('── 1. the set is the brute-force set, for 30 members at three densities ──');
    let equal = 0, orderEqual = 0;
    const sizes: Record<string, number[]> = { busy: [], small: [], empty: [] };
    for (const m of members) {
        const want = bruteSet(m.id);
        const got = await get(`${SYNC}&nearby=1&paged=1`, m.id);
        if (got.status === 200 && sameSet(got.set, want.all)) equal++;
        else console.error(`  ${m.kind}: ${got.status}, ${got.set.length} named, ${want.all.size} wanted`);
        if (got.set.slice(0, want.near.length).join() === want.near.join()) orderEqual++;
        sizes[m.kind].push(want.near.length);
    }
    assert(equal === 30, `each of the 30 members is named exactly the brute-force set (${equal}/30)`);
    assert(orderEqual === 30, `its near part comes nearest first, in the brute-force order (${orderEqual}/30)`);
    assert(sizes.busy.every(s => s === 500) && sizes.small.every(s => s > 0 && s < 500) && sizes.empty.every(s => s === 0),
        `the three densities are what they claim: busy ${sizes.busy.join('/')}, small ${sizes.small.join('/')}, empty ${sizes.empty.join('/')}`);
    const anaSet = new Set((await get(`${SYNC}&nearby=1`, ana)).set);
    assert(![grouped, offBoard, pausedEnterprise, windingUp, removed].some(x => anaSet.has(x)) && !anaSet.has(doneDeal),
        'a group listing she is not in, an author on holiday, a paused and a winding-up enterprise, a taken-off listing and a finished deal are not in it');
    // The plans of a set's statements, as it runs them (each statement as it ran, with its arguments): the box on
    // idx_posts_lat_lng, the authors off the board, on holiday and whose standing moved each from its partial index,
    // and no statement reads every member's row or every member's preferences (2026-10-10: the join per listing was 14
    // of 18 ms at 100k posts; the preferences, 1.5 ms of every read at 20,000 members).
    {
        const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
        const ran: Array<{ sql: string; args: unknown[] }> = [];
        const { all, get } = proto;
        proto.all = function (this: { source: string }, ...args: unknown[]) { ran.push({ sql: this.source, args }); return all.apply(this, args); };
        proto.get = function (this: { source: string }, ...args: unknown[]) { ran.push({ sql: this.source, args }); return get.apply(this, args); };
        try {
            const me = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(ana.pubKeyHex) as { area_lat: number; area_lng: number };
            getNearbySet(db, ana.pubKeyHex, { area: { lat: me.area_lat, lng: me.area_lng }, radiusKm: 250, max: 500, newestWithoutArea: 100,
                types: TYPES.split(','), excludeEvents: false, measureAtMost: 10_000 });
        } finally {
            proto.all = all;
            proto.get = get;
        }
        const plan = ran.filter(r => !r.sql.startsWith('SELECT is_visitor'))
            .flatMap(r => (db.prepare(`EXPLAIN QUERY PLAN ${r.sql}`).all(...r.args) as Array<{ detail: string }>).map(p => p.detail));
        const uses = (index: string) => plan.some(d => d.includes(index));
        const wholeTable = plan.filter(d => /^SCAN (members|member_preferences|member_blocks|m|cp)\b/.test(d) && !/USING (COVERING )?INDEX/.test(d));
        assert(uses('idx_posts_lat_lng') && uses('idx_members_off_board') && uses('idx_member_preferences_on_holiday')
            && uses('idx_members_standing_by_key') && wholeTable.length === 0,
            `each statement of a set reads an index: the box, the authors off the board, on holiday, whose standing moved; no table of people (${wholeTable.join('; ') || 'none read whole'})`);
    }
    // The bound below the listings in the box: the engine measures the newest that many, and the set is the nearest of
    // them. Once with the box holding more than the bound (the pass again, newest first), once with it holding fewer.
    for (const bound of [40, 5000]) {
        let same = 0;
        for (const m of members.filter(x => x.kind !== 'empty')) {
            const me = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(m.id.pubKeyHex) as { area_lat: number; area_lng: number };
            const got = getNearbySet(db, m.id.pubKeyHex, { area: { lat: me.area_lat, lng: me.area_lng }, radiusKm: 250, max: 500, newestWithoutArea: 100,
                types: TYPES.split(','), excludeEvents: false, measureAtMost: bound });
            if (got.near.join() === bruteSet(m.id, bound).near.join()) same++;
        }
        assert(same === 20, `with the bound at ${bound}, each placed member's near part is the nearest of the newest ${bound} in the box, in order (${same}/20)`);
    }
    const author2 = members.find(m => m.kind === 'busy')!.id;
    assert(!(await get(`${SYNC}&nearby=1`, author2)).set.includes(hidden), 'a listing hidden by reports is in nobody\'s near set but its author\'s');

    // ── 5. own and tied ──
    console.log('\n── 5. own and tied are kept ──');
    assert(anaSet.has(farOwn), 'her own paused listing 16,000 km away is in her set');
    assert(anaSet.has(farDeal), 'a listing 16,000 km away she has an open deal on is in her set');
    assert(anaSet.has(farTalk), 'a listing 17,000 km away she has a conversation about is in her set');

    // ── 2. whole in pages ──
    console.log('\n── 2. a whole read in pages brings the set ──');
    for (const m of [members[1], members[11], members[21]]) {
        const whole = await readNearby(m.id);
        const ids = whole.rows.map(r => r.id);
        assert(new Set(ids).size === ids.length && sameSet(ids, whole.set) && sameSet(ids, bruteSet(m.id).all),
            `${m.kind}: ${whole.answers.length} page(s) of ${whole.answers.map(a => a.posts.length).join(', ')}: each row of S once, and only S`);
        assert(whole.answers.every(a => a.posts.length <= 200 && a.set.join() === whole.set.join()), `${m.kind}: every page ≤ 200 rows and names the same set`);
    }

    // ── 8. the epoch on every answer ──
    const ep = await readNearby(members[2].id);
    const ep304 = await get(`${SYNC}&nearby=1&paged=1`, members[2].id, { 'If-None-Match': ep.answers[0].etag || '' });
    assert(ep.answers.every(a => !!a.epoch) && ep304.status === 304 && !!ep304.epoch,
        `the identity epoch header is on every page and on the 304 (${ep.answers.length} pages, 304: ${ep304.status})`);

    // ── 3. delta ∪ set reconstructs S ──
    console.log('\n── 3. after random writes, moves and removals, a delta and the set give the phone the new S ──');
    const phones = [members[3], members[4], members[12], members[22], members[0]];
    const held = new Map<string, Map<string, Row>>();
    for (const m of phones) held.set(m.id.pubKeyHex, new Map((await readNearby(m.id)).rows.map(r => [r.id, r])));
    const cursor = iso(Date.now() - 1000);
    await new Promise(r => setTimeout(r, 20));
    const all = (db.prepare('SELECT id FROM posts WHERE lat IS NOT NULL').all() as Array<{ id: string }>).map(r => r.id);
    const later = () => iso(Date.now() + Math.floor(rand() * 1000));
    for (let i = 0; i < 120; i++) {
        const r = rand();
        const id = all[Math.floor(rand() * all.length)];
        if (r < 0.3) post(around(rand() < 0.5 ? BUSY : SMALL, 250));
        else if (r < 0.6) db.prepare('UPDATE posts SET lat = ?, lng = ?, updated_at = ? WHERE id = ?').run(...Object.values(around(rand() < 0.5 ? BUSY : SMALL, 400)), later(), id);
        else if (r < 0.8) db.prepare(`UPDATE posts SET active = 0, status = 'cancelled', updated_at = ? WHERE id = ?`).run(later(), id);
        else db.prepare(`UPDATE posts SET title = 'Edited', updated_at = ? WHERE id = ?`).run(later(), id);
    }
    db.prepare('UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?').run(SMALL.lat, SMALL.lng, members[4].id.pubKeyHex);
    se.setHolidayMode(authors[8].pubKeyHex, true);
    let rebuilt = 0, fetched = 0;
    for (const m of phones) {
        const h = held.get(m.id.pubKeyHex)!;
        const delta = await readNearby(m.id, cursor);
        for (const r of delta.rows) h.set(r.id, r);
        const set = new Set(delta.set);
        for (const id of [...h.keys()]) if (!set.has(id)) h.delete(id);
        const missing = delta.set.filter(id => !h.has(id));
        for (let i = 0; i < missing.length; i += 100) {
            const got = await get(`/api/marketplace/posts?sync=true&ids=${missing.slice(i, i + 100).join(',')}`, m.id);
            for (const r of got.posts) h.set(r.id, r);
            fetched += got.posts.length;
        }
        const want = bruteSet(m.id).all;
        if (sameSet(h.keys(), want)) rebuilt++;
        else console.error(`  ${m.kind}: held ${h.size}, wanted ${want.size}`);
        // Every row held is the node's row as it is now: the delta brought what changed.
        const stale = [...h.values()].filter(r => {
            const now = db.prepare('SELECT title FROM posts WHERE id = ?').get(r.id) as { title: string };
            return now.title !== r.title;
        });
        if (stale.length > 0) console.error(`  ${m.kind}: ${stale.length} stale rows`);
    }
    assert(rebuilt === phones.length, `each of ${phones.length} phones holds exactly the new S after one delta, its set and ${fetched} fetched by ids= (${rebuilt}/${phones.length})`);

    // ── 4. the 304 ──
    console.log('\n── 4. the ETag describes the set ──');
    const bea = members[5].id;
    const first = await get(`${SYNC}&nearby=1&paged=1`, bea);
    const tagged = (a: Answer) => get(`${SYNC}&nearby=1&paged=1`, bea, { 'If-None-Match': a.etag || '' });
    const beaArea = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(bea.pubKeyHex) as { area_lat: number; area_lng: number };
    const far = (db.prepare('SELECT id, lat, lng FROM posts WHERE lat IS NOT NULL AND active = 1').all() as Array<{ id: string; lat: number; lng: number }>)
        .find(p => haversineKm(beaArea.area_lat, beaArea.area_lng, p.lat, p.lng) > 300)!;
    db.prepare(`UPDATE posts SET title = 'Far change', updated_at = ? WHERE id = ?`).run(iso(Date.now() + 5000), far.id);
    post({ lat: 51.5, lng: -0.1 });
    const held304 = await tagged(first);
    assert(held304.status === 304, `a listing 300 km+ away edited and a new one in London: still 304 (${held304.status})`);
    const nearOne = first.set.find(id => !id.startsWith('tie-') && (db.prepare('SELECT author_pubkey FROM posts WHERE id = ?').get(id) as any)?.author_pubkey !== ana.pubKeyHex)!;
    db.prepare(`UPDATE posts SET title = 'Near change', updated_at = ? WHERE id = ?`).run(iso(Date.now() + 6000), nearOne);
    const afterNear = await tagged(first);
    assert(afterNear.status === 200 && afterNear.etag !== first.etag, `a nearby listing edited: 200 with a new tag (${afterNear.status})`);
    const nearAuthor = (db.prepare('SELECT author_pubkey FROM posts WHERE id = ?').get(first.set[10]) as { author_pubkey: string }).author_pubkey;
    se.setHolidayMode(nearAuthor, true);
    const afterHoliday = await tagged(afterNear);
    assert(afterHoliday.status === 200 && !afterHoliday.set.includes(first.set[10]), `an author near her goes on holiday: 200, their listing out of the set (${afterHoliday.status})`);
    se.setHolidayMode(nearAuthor, false);
    const back = await get(`${SYNC}&nearby=1&paged=1`, bea);
    db.prepare('UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?').run(SMALL.lat, SMALL.lng, bea.pubKeyHex);
    const afterMove = await tagged(back);
    assert(afterMove.status === 200 && afterMove.etag !== back.etag, `she moves her area: 200 with a new tag (${afterMove.status})`);

    // ── 6. a visitor's, an unsigned and a switched-off read unchanged ──
    console.log('\n── 6. reads that aren\'t a member\'s by-area sync are answered as before ──');
    const visitor = keypair();
    for (const [who, id] of [['unsigned', null], ['a signed key that is no member', visitor]] as const) {
        const plain = await get(SYNC, id);
        const asked = await get(`${SYNC}&nearby=1`, id);
        assert(plain.status === 200 && asked.status === plain.status && asked.text === plain.text,
            `${who}: nearby=1 answers byte for byte as without it (${asked.status}, ${asked.text.length} bytes)`);
    }
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.nearbyListings`, 'false');
    const offPlain = await get(SYNC, bea);
    const offAsked = await get(`${SYNC}&nearby=1`, bea);
    const info = await (await localFetch(`${BASE}/api/community/info`)).json() as any;
    assert(offAsked.status === 200 && offAsked.text === offPlain.text && Array.isArray(JSON.parse(offAsked.text)) && info.features?.nearbyListings === undefined,
        'with the switch off (a local community), a member\'s nearby=1 is the plain list byte for byte, and features says nothing');
    db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.nearbyListings`);
    const infoOn = await (await localFetch(`${BASE}/api/community/info`)).json() as any;
    assert(JSON.stringify(infoOn.features?.nearbyListings) === JSON.stringify({ radiusKm: 250, max: 500 }), `on the global profile features.nearbyListings is ${JSON.stringify(infoOn.features?.nearbyListings)}`);

    // ── 7. ids= obeys id= ──
    console.log('\n── 7. ids= reads each listing as id= does ──');
    const mixed = [grouped, hidden, offBoard, removed, farOwn, farDeal, 'no-such-id', first.set[0]];
    for (const [who, id] of [['a member', ana], ['the group\'s author', authors[1]], ['an unsigned reader', null]] as const) {
        for (const sync of ['', '&sync=true']) {
            const one: string[] = [];
            for (const x of mixed) one.push(...(await get(`/api/marketplace/posts?id=${x}${sync}`, id)).posts.map(r => JSON.stringify(r)));
            const many = (await get(`/api/marketplace/posts?ids=${mixed.join(',')}${sync}`, id)).posts.map(r => JSON.stringify(r));
            assert(sameSet(one, many) && one.length === many.length, `${who}${sync ? ', sync' : ''}: ids= answers the ${one.length} rows id= answers, row for row`);
        }
    }
    const tooMany = await get(`/api/marketplace/posts?ids=${Array.from({ length: 101 }, (_, i) => `x${i}`).join(',')}`, ana);
    assert(tooMany.status === 400, `101 ids is a 400 (${tooMany.status})`);

    // ── 9. no area; a listing with no place ──
    console.log('\n── 9. a member with no area; a listing posted with no place ──');
    const noArea = memberAt('NoArea', null);
    const newest = await get(`${SYNC}&nearby=1`, noArea);
    const wantNewest = bruteSet(noArea);
    assert(newest.status === 200 && newest.set.length === 100 && newest.set.join() === wantNewest.near.join(),
        `no area: the newest 100 listings on the node, wherever they are (${newest.set.length})`);
    const posted = await postPlaceless(members[7].id);
    const stored = db.prepare('SELECT lat, lng FROM posts WHERE id = ?').get(posted.id ?? '') as { lat: number | null; lng: number | null } | undefined;
    const area7 = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(members[7].id.pubKeyHex) as { area_lat: number; area_lng: number };
    assert(posted.status === 200 || posted.status === 201 ? stored?.lat === area7.area_lat && stored?.lng === area7.area_lng : false,
        `a listing posted with no place takes its author's area (${posted.status}, ${stored?.lat},${stored?.lng} vs ${area7.area_lat},${area7.area_lng})`);
    const inHerSet = (await get(`${SYNC}&nearby=1`, members[7].id)).set.includes(posted.id ?? '');
    assert(inHerSet, 'and is in the set of a member at that area');
    // A poll has no place of its own (the engine's poll isolation drops any pin), so on a by-area node the engine gives
    // it its author's area too: the polls a member sees are the ones made near them (§3.4).
    const POLL = { type: 'poll', title: 'Market day?', description: 'Saturday or Sunday', pollOptions: ['Saturday', 'Sunday'], durationDays: 7 };
    for (const [k, [what, who, extra]] of ([['a poll posted with no place', members[7].id, {}], ['a poll posted with a pin far away', members[8].id, { lat: 51.5, lng: -0.1 }]] as const).entries()) {
        const poll = await postPlaceless(who, { ...POLL, ...extra });
        const at = db.prepare('SELECT lat, lng FROM posts WHERE id = ?').get(poll.id ?? '') as { lat: number | null; lng: number | null } | undefined;
        const area = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(who.pubKeyHex) as { area_lat: number; area_lng: number };
        assert((poll.status === 200 || poll.status === 201) && at?.lat === area.area_lat && at?.lng === area.area_lng,
            `${what} takes its author's area (${poll.status}, ${at?.lat},${at?.lng} vs ${area.area_lat},${area.area_lng})`);
        const neighbour = memberAt(`PollNear${k}`, { lat: area.area_lat, lng: area.area_lng });
        assert((await get(`${SYNC}&nearby=1`, neighbour)).set.includes(poll.id ?? ''), `and is in the set of another member in that area (${what})`);
    }

    // ── 10. blocks ──
    console.log('\n── 10. a member\'s set leaves out the authors she blocked ──');
    const { addBlocks } = await import('./engine/member-blocks.js');
    const crowd = memberAt('Crowd', null);
    const anaAt = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(ana.pubKeyHex) as { area_lat: number; area_lng: number };
    const crowded = db.transaction(() => Array.from({ length: 60 }, () => post(around({ lat: anaAt.area_lat, lng: anaAt.area_lng }, 1), crowd, 'offer')))();
    const unblocked = await get(`${SYNC}&nearby=1&paged=1`, ana);
    const nearUnblocked = unblocked.set.slice(0, 500);
    assert(unblocked.status === 200 && nearUnblocked.join() === bruteSet(ana).near.join() && crowded.every(id => nearUnblocked.slice(0, 70).includes(id)),
        `one author's 60 listings within 1 km of her take 60 of the first places of her near set (${unblocked.status}, ${crowded.filter(id => nearUnblocked.includes(id)).length} of them in it)`);
    addBlocks(ana.pubKeyHex, [crowd.pubKeyHex]);
    const blockedRead = await get(`${SYNC}&nearby=1&paged=1`, ana, { 'If-None-Match': unblocked.etag || '' });
    const wantBlocked = bruteSet(ana);
    const keptNear = nearUnblocked.filter(id => !crowded.includes(id));
    assert(blockedRead.status === 200 && !crowded.some(id => blockedRead.set.includes(id)) && wantBlocked.near.length === 500
        && blockedRead.set.slice(0, 500).join() === wantBlocked.near.join() && sameSet(blockedRead.set, wantBlocked.all)
        && blockedRead.set.slice(0, keptNear.length).join() === keptNear.join(),
        `she blocks that author: 200, none of the 60 in her set, which is the nearest 500 of everyone else's (${blockedRead.status}, ${blockedRead.set.filter(id => crowded.includes(id)).length} of the 60 left)`);
    const otherBusy = members[1].id;
    assert(sameSet((await get(`${SYNC}&nearby=1`, otherBusy)).set, bruteSet(otherBusy).all), 'another member\'s set is untouched by her blocks');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A member\'s phone gets exactly the listings near them.');

    async function postPlaceless(id: Id, fields: Record<string, unknown> = {}): Promise<{ status: number; id?: string; error?: string }> {
        db.prepare("UPDATE members SET avatar_ref = 'seeded-face' WHERE public_key = ?").run(id.pubKeyHex);
        const path = '/api/marketplace/posts';
        const body = JSON.stringify({ type: 'offer', category: 'food', title: 'Eggs, no pin', description: 'A dozen', credits: 0, ...fields, authorPublicKey: id.pubKeyHex });
        const res = await localFetch(`${BASE}${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) } });
        const out = await res.json().catch(() => ({})) as any;
        if (res.status >= 300) console.error('  POST:', res.status, JSON.stringify(out).slice(0, 200));
        return { status: res.status, id: out?.id ?? out?.post?.id, error: out?.error };
    }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
