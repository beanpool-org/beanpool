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
 * Boots the real server and reads the sync route over HTTP, signed, as the phone does, into a model of the 1.2.56
 * phone's cache: its fingerprint gate (a posts or deals page the same as the last one applied is skipped) and its deal
 * heal (applying a changed deals page writes the listings of cancelled deals, and of completed deals on repeatable
 * listings, back as active, after the posts). After every step the listings on that model's Market are the listings
 * on the board the same member reads.
 *   - a member goes on holiday (POST /api/members/holiday) → gone at the next delta; holiday off → back;
 *   - an enterprise is paused → gone; resumed → back;
 *   - an enterprise starts winding up → gone; the wind-up is cancelled → back; it winds up again and is finalised →
 *     its keeper's next delta carries what he held as it was (a closed poll), now as paused, since he keeps it no more;
 *   - a fresh install's first (full) sync while a member is on holiday leaves their listings off;
 *   - the delta after a holiday switch carries that member's listings and no one else's (it stays a delta);
 *   - reading a listing by id for the cache (utils/db.ts getPost, `?id=…&sync=true`) doesn't put it back;
 *   - an idle delta is the same page as the one before, and the phone's gate skips it;
 *   - the event page's own read (fetchEventDetail, by id with no `sync`), which changes nothing on the node, writes the
 *     event as the node has it over the held row; the next delta takes it off again (a member Going, and one who came
 *     from a shared link with no RSVP), and the one after an idle one; the read counts until the phone's cursor passes
 *     it, then the deltas are idle again; opened again after that, with nothing written on the node in between (the
 *     platform's HTTP cache sends the first read's ETag), the next delta takes it off again. A poll vote does the same
 *     with the vote's answer, and the next delta too;
 *   - the author's own phone, a keeper's of the enterprise, and a member with an open deal on the listing keep it as it
 *     is; the member withdraws the request: the next delta carries the listing as paused, but the heal in the same sync
 *     puts it back, and the delta after that takes it off their phone; the same after a cold start;
 *   - a deferred wage claim paid by processDeferredWageClaims, which completes a one-off listing, reaches the phone;
 *   - a change of who sees an off-board author's listings as they are, which moves no listing and no standing: a keeper
 *     steps down from a paused enterprise (over HTTP) → their next delta carries its listings as paused; an admin binds a
 *     keeper to it → theirs carries them as they are; and unbinds them → as paused again. Binding a keeper it already
 *     has stamps nothing. A keeper bound to and unbound from an enterprise on the board: no delta carries its listings,
 *     signed or not, so none tells anyone its keepers changed. A request crowded out by another's approval (which the
 *     node refuses an off-board author, so it moves the listing's own row on the board) → the requester's next delta
 *     carries the listing as paused once the enterprise pauses; a request the paused enterprise declines, which moves
 *     nothing → the same, and the delta after that and after a cold start (a declined deal's heal writes nothing);
 *   - what the board never shows moves no author's listings into a delta: a member's bio edit, a contact change, a
 *     moderator's mute (three removals on the global profile) and its lift each move members.updated_at, and neither
 *     the member's next delta nor an unsigned delta from just before the change carries their listings. A delta
 *     carries an author for members.board_standing_changed_at, which only a change of standing moves; a re-key keeps it;
 *   - on 2,000 members, 20,000 posts and 5,000 ended deals, no statement of the delta read walks every post, the
 *     authors whose standing changed are found by idx_members_board_standing_changed_at, and the heal's deals are
 *     looked up by the reader's own indexes (EXPLAIN QUERY PLAN).
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

async function getText(path: string, id: Id): Promise<string> {
    const res = await fetch(`${BASE}${path}`, { headers: signedHeaders('GET', path, '', id) });
    if (res.status !== 200) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return res.text();
}

async function getJson(path: string, id: Id): Promise<any[]> {
    return JSON.parse(await getText(path, id));
}

/** A read nobody signs: what any stranger gets. */
async function getUnsigned(path: string): Promise<any[]> {
    const res = await fetch(`${BASE}${path}`);
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

/** The phone's payload fingerprint (apps/native services/pillar-sync.ts _fingerprint, djb2). */
function fingerprint(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
}

/**
 * The phone's posts cache and its Market, as the apps in the stores (1.2.56, at 5805f367) have them. A sync (services/pillar-sync.ts
 * performSync) reads the posts and the member's last 50 deals, and applies each only when its raw body differs from the
 * last one applied (parseIfChanged: a fingerprint per node and table, in memory, so a cold start forgets them). Applying
 * writes every synced row over the one held (utils/db.ts writeSyncedPost) and deletes none; then, after the posts, the
 * deal heal: each deal cancelled, or completed on a repeatable listing, writes its listing back as active, and each
 * completed on a one-off listing as completed (applyDelta), unless the phone holds the deal as ended and the node sends
 * it as open. The Market shows a row by its status (feedPostVisible: a poll while active or completed; an event while
 * active, not cancelled and not ended; anything else while active).
 */
class Phone {
    rows = new Map<string, any>();
    private deals = new Map<string, string>();
    private fingerprints = new Map<string, number>();
    private lastSyncMs: number | null = null;
    /** What the last sync applied: its posts page, its deals page. */
    applied = { posts: false, deals: false };
    /** How far this phone's clock runs ahead of the node's. */
    clockAheadMs = 0;
    constructor(readonly id: Id) {}

    /** The body, parsed, if it differs from the last one applied for this table; undefined if the gate skips it. */
    private gate(table: string, raw: string): any[] | undefined {
        const fp = fingerprint(raw);
        if (this.fingerprints.get(table) === fp) return undefined;
        this.fingerprints.set(table, fp);
        return JSON.parse(raw);
    }

    /** The app is killed and opened again: the gate's fingerprints are gone, the cache and the cursor stay. */
    coldStart(): void {
        this.fingerprints.clear();
    }

    /**
     * One sync as performSync does it: full the first time (or with an empty cache), then since the last one less five
     * minutes' drift. Returns the posts page as the node sent it, whether or not the gate let the phone apply it.
     */
    async sync(): Promise<any[]> {
        const since = this.lastSyncMs === null || this.rows.size === 0 ? ''
            : `&updatedAfter=${encodeURIComponent(new Date(this.lastSyncMs - 300_000).toISOString())}`;
        const rawPosts = await getText(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}${since}`, this.id);
        const rawDeals = await getText(`/api/marketplace/transactions?publicKey=${this.id.pubKeyHex}&limit=50`, this.id);
        const posts = this.gate('posts', rawPosts);
        const deals = this.gate('marketplaceTransactions', rawDeals);
        this.applied = { posts: posts !== undefined, deals: deals !== undefined };
        for (const p of posts ?? []) this.rows.set(p.id, p);
        for (const tx of deals ?? []) {
            const status = tx.status ?? 'pending';
            const held = this.deals.get(tx.id);
            if (held && ['completed', 'cancelled'].includes(held) && ['pending', 'requested'].includes(status)) continue;
            this.deals.set(tx.id, status);
            const row = this.rows.get(tx.postId);
            if (!row) continue;
            if (status === 'completed' && !row.repeatable) {
                this.rows.set(tx.postId, { ...row, status: 'completed', active: false });
            } else if (status === 'completed' || status === 'cancelled') {
                this.rows.set(tx.postId, { ...row, status: 'active', acceptedBy: null, pendingTransactionId: null });
            }
        }
        this.lastSyncMs = Date.now() + this.clockAheadMs;
        return JSON.parse(rawPosts);
    }

    /** The by-id refresh a listing's page runs (utils/db.ts getPost). */
    async openListing(postId: string): Promise<any> {
        const page = await getJson(`/api/marketplace/posts?id=${encodeURIComponent(postId)}&sync=true`, this.id);
        if (page[0]) this.rows.set(page[0].id, page[0]);
        return page[0];
    }

    /**
     * The platform's HTTP cache under the app's fetch (RN 0.83.6: OkHttp's disk cache on Android, NSURLCache on iOS), for
     * the event page's URL, which never changes: it keeps the last 200 with its ETag, sends that ETag as `If-None-Match`
     * on the next GET of the URL by itself, and hands the app the stored body on a 304. A delta's URL carries a new
     * cursor each sync, so the cache never revalidates one.
     */
    private httpCache = new Map<string, { etag: string; body: string }>();
    /** The last event page's read: the ETag this phone's cache sent, and the one the node answered with. */
    eventPageEtags: { sent?: string; answered?: string } = {};

    /**
     * The event page's own read (utils/db.ts fetchEventDetail): by id with no `sync`, through the platform's cache, written
     * over the held row by persistEventView (`status = COALESCE(?, status)`, `updated_at` likewise, and the event's columns).
     */
    async openEventDetail(postId: string): Promise<any> {
        const path = `/api/marketplace/posts?id=${encodeURIComponent(postId)}`;
        const stored = this.httpCache.get(path);
        const res = await fetch(`${BASE}${path}`, {
            headers: { ...signedHeaders('GET', path, '', this.id), ...(stored ? { 'If-None-Match': stored.etag } : {}) },
        });
        let raw: string;
        if (res.status === 304 && stored) raw = stored.body;
        else if (res.status === 200) raw = await res.text();
        else throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
        const etag = res.headers.get('etag') ?? undefined;
        if (res.status === 200 && etag) this.httpCache.set(path, { etag, body: raw });
        this.eventPageEtags = { sent: stored?.etag, answered: etag };
        const post = JSON.parse(raw)[0];
        const held = this.rows.get(postId);
        if (post?.type === 'event' && held) {
            this.rows.set(postId, {
                ...held, status: post.status ?? held.status, updatedAt: post.updatedAt ?? held.updatedAt,
                eventStartAt: post.eventStartAt, eventEndAt: post.eventEndAt, eventState: post.eventState,
            });
        }
        return post;
    }

    /** A vote as votePoll casts it: the route's answer is written over the held row (`status = ?`, `updated_at = ?`). */
    async vote(postId: string, optionId: string): Promise<{ status: number; body: any }> {
        const res = await postJson(`/api/marketplace/posts/${encodeURIComponent(postId)}/vote`,
            { postId, optionId, voterPublicKey: this.id.pubKeyHex }, this.id);
        const held = this.rows.get(postId);
        if (res.body?.post && held) {
            this.rows.set(postId, { ...held, pollOptions: res.body.post.pollOptions, status: res.body.post.status, updatedAt: res.body.post.updatedAt });
        }
        return res;
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
    const { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { moveMemberKeyRows } = await import('./engine/key-move.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // Time passing, for a member: their row last changed at `at`, whatever changed it. On a node from before
    // members.board_standing_changed_at there is only updated_at.
    const hasStanding = (db.prepare('PRAGMA table_info(members)').all() as Array<{ name: string }>).some(c => c.name === 'board_standing_changed_at');
    const age = (key: string, at: string) => {
        db.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?').run(at, key);
        if (hasStanding) db.prepare('UPDATE members SET board_standing_changed_at = ? WHERE public_key = ? AND board_standing_changed_at IS NOT NULL').run(at, key);
    };

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
    // Olly is Going to Hana's seed swap: "Your events" on his phone lists it, whatever the Market shows.
    se.rsvpEvent(hanaPosts[3], olly.pubKeyHex, 'going');
    offer(bob.pubKeyHex, 'Bike repairs');
    offer(cass.pubKeyHex, 'Gardening');

    const { publicKey: farm } = se.createTreasury('PausedFarm', AVATAR, 100);
    keep(farm, pat, 'lead');
    const farmOffer = offer(farm, 'Eggs');
    const farmNeed = need(farm, 'Fence mending');
    const { publicKey: mill } = se.createTreasury('WindingMill', AVATAR, 100);
    keep(mill, pat, 'lead');
    const millPosts = [offer(mill, 'Flour'), need(mill, 'Sacks')];
    // A poll the mill ran and closed: on the board (a closed poll is) for as long as the mill is.
    const millPoll = se.createPost('poll', 'community', 'Mill open day?', '', 0, 'fixed', mill,
        undefined, undefined, undefined, false, undefined, false,
        { pollOptions: [{ id: 'a', text: 'Saturday' }, { id: 'b', text: 'Sunday' }] })!.id;
    se.closePoll(millPoll, mill);

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

    const ours = new Set<string>([...hanaPosts, ollyPost, farmOffer, farmNeed, ...millPosts, millPoll, bread, shift]);
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
    const ollyPhone = new Phone(olly);
    await ollyPhone.sync();

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

    // The event page reads the event outside a sync and writes what it gets over the held row. Carol comes to Hana's
    // seed swap from a link someone sent her (no RSVP); Olly from "Your events" (Going). Until the next delta the row
    // is as the node has it; the next delta takes it off again, though neither the event nor Hana has changed since.
    const seedSwap = hanaPosts[3];
    await ollyPhone.sync();
    // Time passes: Hana's switch is older than any cursor from here on (each phone asks from its last sync less
    // five minutes), so no delta below carries her listings for her own standing's sake.
    age(hana.pubKeyHex, new Date(Date.now() - 600_000).toISOString());
    for (const [who, p] of [['Carol, from a shared link', phone], ['Olly, Going, from "Your events"', ollyPhone]] as const) {
        // Nothing changes for a while: the first idle delta differs from the holiday one, the next is the same page,
        // and the phone's gate skips it. A member with nothing to send again gets the same page every time.
        await p.sync();
        const idle = await p.sync();
        assert(!p.applied.posts && idle.length === 0, `${who}: an idle delta is the page before, and the phone's gate skips it`);
        const detail = await p.openEventDetail(seedSwap);
        assert(detail?.status === 'active' && p.rows.get(seedSwap)?.status === 'active',
            `${who}: the event page's read writes the event as the node has it (status ${p.rows.get(seedSwap)?.status})`);
        const delta = await p.sync();
        assert(delta.some(r => r.id === seedSwap && r.status === 'paused' && typeof r.resentAt === 'string'),
            `${who}: the next delta carries the event again, as paused, with the read's resentAt`);
        assert(p.applied.posts, `${who}: that page is not the one before, so the phone's gate applies it`);
        const after = await matchesBoard(p, `${who}, opened the event page, next delta`);
        assert(!after.has(seedSwap), `${who}: Hana's event is off the phone's Market again`);
    }

    // The read counts until the phone has synced a quarter of an hour past it (the node keeps it in memory for that
    // member alone); after that its deltas are idle again, and the gate skips them.
    const laterPhone = new Phone(carol);
    await laterPhone.sync();
    await laterPhone.openEventDetail(seedSwap);
    const soon = await laterPhone.sync();
    assert(soon.some(r => r.id === seedSwap && r.status === 'paused') && laterPhone.applied.posts,
        'Carol on another phone opens the event page: her next delta carries it again, and the gate applies it');
    laterPhone.clockAheadMs = 16 * 60_000;
    const stillSoon = await laterPhone.sync();
    assert(stillSoon.some(r => r.id === seedSwap && r.status === 'paused') && laterPhone.applied.posts,
        'every delta until her cursor passes the read carries it, each applied (a new resentAt)');
    const past = await laterPhone.sync();
    assert(!past.some(r => r.id === seedSwap), 'once her cursor is past the read, her delta no longer carries the event');
    await laterPhone.sync();
    assert(!laterPhone.applied.posts, 'and the delta after that is the page before: the gate skips it again');
    await matchesBoard(laterPhone, 'Carol\'s other phone, a quarter of an hour of syncs after the event page');

    // The next day she opens the event page again, with nothing written on the node since. Her phone's platform cache
    // sends the first read's ETag by itself and, on a 304, hands the app its stored body, with the event `active`. The
    // node answers a signed by-id read that isn't a sync in full, so the read is noted like the first. (Her phone's clock
    // ran ahead only to age the first read; it is right again from here, and one sync moves her cursor back to now.)
    laterPhone.clockAheadMs = 0;
    await laterPhone.sync();
    await laterPhone.openEventDetail(seedSwap);
    const { sent, answered } = laterPhone.eventPageEtags;
    assert(!!sent && sent === answered,
        `Carol opens the event page again: her phone sends the first read's ETag, and nothing on the node has changed since (sent ${sent}, node's ${answered})`);
    assert(laterPhone.rows.get(seedSwap)?.status === 'active',
        `the event page writes the event over the held row as active (status ${laterPhone.rows.get(seedSwap)?.status})`);
    const reopenedDelta = await laterPhone.sync();
    assert(reopenedDelta.some(r => r.id === seedSwap && r.status === 'paused' && typeof r.resentAt === 'string') && laterPhone.applied.posts,
        'the next delta carries the event again, as paused, and the gate applies it');
    const reopened = await matchesBoard(laterPhone, 'Carol opened the event page again the next day, next delta');
    assert(!reopened.has(seedSwap), 'Hana\'s event is off her phone\'s Market again');
    // Only that read skips the 304: asked twice with nothing written in between, every other read is confirmed.
    const revalidated = async (path: string, id: Id | null): Promise<number> => {
        const first = await fetch(`${BASE}${path}`, { headers: id ? signedHeaders('GET', path, '', id) : {} });
        await first.text();
        const again = await fetch(`${BASE}${path}`, {
            headers: { ...(id ? signedHeaders('GET', path, '', id) : {}), 'If-None-Match': first.headers.get('etag') ?? '' },
        });
        return again.status;
    };
    const stillConfirmed: [string, string, Id | null][] = [
        ['the board', `/api/marketplace/posts?limit=200&${TYPES}`, carol],
        ['a delta', `/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(new Date(Date.now() - 300_000).toISOString())}`, carol],
        ['the by-id refresh of a sync (getPost)', `/api/marketplace/posts?id=${encodeURIComponent(seedSwap)}&sync=true`, carol],
        ['an unsigned read of the event by id', `/api/marketplace/posts?id=${encodeURIComponent(seedSwap)}`, null],
    ];
    for (const [what, path, id] of stillConfirmed) {
        const status = await revalidated(path, id);
        assert(status === 304, `${what}, asked again with its ETag and nothing changed, is still a 304 (got ${status})`);
    }
    // The node notes a read only for a key with a member row, so a key that merely signs can't fill what it keeps.
    const stranger = keypair();
    const strangerRead = (await getJson(`/api/marketplace/posts?id=${encodeURIComponent(seedSwap)}`, stranger))[0];
    const strangerDelta = await getJson(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(new Date(Date.now() - 300_000).toISOString())}`, stranger);
    assert(strangerRead?.id === seedSwap && !strangerDelta.some(r => r.id === seedSwap),
        'a key with no member row reads the event page too, and nothing is noted for it: its next delta doesn\'t carry the event');

    // A vote in Hana's poll writes the vote route's answer over the held row the same way (votePoll). The vote moves the
    // poll's updated_at, so the next delta carries it for that alone; it has to go as paused.
    const poll = hanaPosts[2];
    const voted = await phone.vote(poll, 'a');
    assert(voted.status === 200 && phone.rows.get(poll)?.status === 'active',
        `Carol votes in Hana's poll; the vote's answer writes it as the node has it (got ${voted.status}, status ${phone.rows.get(poll)?.status})`);
    await phone.sync();
    const afterVote = await matchesBoard(phone, 'Carol voted in Hana\'s poll, next delta');
    assert(!afterVote.has(poll) && phone.rows.get(poll)?.status === 'paused', 'Hana\'s poll is off the phone\'s Market again');

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

    // Pat keeps the farm. His phone counts its listings as his own (post/[id].tsx isOperatorOfAuthor, from the node's
    // keeperOf) and offers Activate on one that reads paused, which the node refuses for a listing that is live.
    const patPhone = new Phone(pat);
    await patPhone.sync();
    assert([farmOffer, farmNeed].every(id => patPhone.rows.get(id)?.status === 'active'),
        `Pat, who keeps the paused farm, holds its listings as they are (status ${patPhone.rows.get(farmOffer)?.status}, ${patPhone.rows.get(farmNeed)?.status})`);
    const patOpened = await patPhone.openListing(farmOffer);
    assert(patOpened?.status === 'active', `and opening the eggs by id gives them to him as they are (status ${patOpened?.status})`);

    // Bob withdraws his request. That writes no listing row, and the farm's own row hasn't changed since before his
    // cursor: his phone still holds the eggs as they were while his deal was open. The sync after it applies his
    // deals too (the withdrawn one changed them), and the phone's heal writes the eggs back as active after the posts.
    // The delta after that takes them off: its page differs (a new resentAt) and his deals don't, so no heal.
    age(farm, new Date(Date.now() - 600_000).toISOString());
    const withdrawn = se.cancelPostRequest(bobDeal.id, bob.pubKeyHex);
    assert(withdrawn?.status === 'cancelled', `Bob withdraws his request for the eggs (status ${withdrawn?.status})`);
    const firstAfter = await bobPhone.sync();
    assert(bobPhone.applied.posts && bobPhone.applied.deals
        && firstAfter.some(r => r.id === farmOffer && r.status === 'paused' && typeof r.resentAt === 'string'),
        'Bob\'s next delta carries the eggs again, as paused, and the phone applies it and his changed deals');
    assert(bobPhone.rows.get(farmOffer)?.status === 'active',
        `in that same sync the 1.2.56 phone's deal heal writes the eggs back as active (status ${bobPhone.rows.get(farmOffer)?.status})`);
    const secondAfter = await bobPhone.sync();
    assert(bobPhone.applied.posts && !bobPhone.applied.deals && secondAfter.some(r => r.id === farmOffer && r.status === 'paused'),
        'the delta after that carries them again with a new resentAt: the gate applies it, and his deals are the same, so no heal');
    const bobAfter = await matchesBoard(bobPhone, 'Bob withdrew his request, the second delta');
    assert(!bobAfter.has(farmOffer) && bobPhone.rows.get(farmOffer)?.status === 'paused',
        `the farm's eggs are off Bob's Market (status ${bobPhone.rows.get(farmOffer)?.status})`);

    // A cold start forgets the gate's fingerprints: the first sync after it applies Bob's deals again, and the heal
    // with them. The delta after that takes the eggs off again.
    bobPhone.coldStart();
    await bobPhone.sync();
    assert(bobPhone.applied.deals && bobPhone.rows.get(farmOffer)?.status === 'active',
        'Bob\'s phone is opened again: its first sync applies his deals again, and the heal puts the eggs back');
    await bobPhone.sync();
    const bobCold = await matchesBoard(bobPhone, 'Bob\'s phone after a cold start, the second delta');
    assert(!bobCold.has(farmOffer), 'the delta after that takes them off his Market again');

    se.resumeEnterprise(farm, 'admin');
    await phone.sync();
    const resumed = await matchesBoard(phone, 'the farm resumed, next delta');
    assert(resumed.has(farmOffer) && resumed.has(farmNeed), 'the farm\'s listings are back on the phone\'s Market');
    await bobPhone.sync();
    const bobResumed = await matchesBoard(bobPhone, 'the farm resumed, Bob\'s next delta');
    assert(bobResumed.has(farmOffer), 'the eggs are back on Bob\'s Market');

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

    console.log('\n── an enterprise wound up ──');
    // The mill winds up again. Pat keeps it, so his phone holds its listings as they are while it does: the closed poll
    // is on his Market. Finalising cancels its open listings (their own rows move) and ends his keeping, but the closed
    // poll's row stays as it was: only the mill's standing tells his phone to take it off.
    se.initiateWindUp(mill, pat.pubKeyHex);
    await phone.sync();
    const patMill = new Phone(pat);
    await patMill.sync();
    assert(patMill.market().has(millPoll), 'Pat, who keeps the winding-up mill, holds its closed poll as it is');
    // Time passes: the week of grace (finalise reads when it started), and the start is older than Pat's cursor.
    db.prepare('UPDATE members SET wind_up_initiated_at = ? WHERE public_key = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString(), mill);
    age(mill, new Date(Date.now() - 600_000).toISOString());
    const wound = se.finaliseWindUp(mill, pat.pubKeyHex);
    assert(wound?.status === 'completed', `the mill's wind-up is finalised (status ${wound?.status})`);
    const patDelta = await patMill.sync();
    assert(patDelta.some(r => r.id === millPoll && r.status === 'paused'),
        'Pat\'s next delta carries the closed poll, as paused: he keeps the mill no more');
    const patAfter = await matchesBoard(patMill, 'the mill wound up, Pat\'s next delta');
    assert(![...millPosts, millPoll].some(id => patAfter.has(id)), 'none of the mill\'s listings is on Pat\'s Market');
    await phone.sync();
    await matchesBoard(phone, 'the mill wound up, next delta');

    console.log('\n── who sees an off-board author\'s listings as they are changes ──');
    // This test syncs far faster than a phone does: each member's gateway allowance (120 a minute) starts afresh here
    // and at each section below.
    resetGatewayRateLimit();
    // Nothing on the listings or the author's standing moves when a keeper comes or goes, or when a request ends
    // declined: only the reader's own exemption changes. Ada signs in as an admin with her key, as Mo does below.
    const ada = seed('AdminAda');
    se.grantNodeRole(ada.pubKeyHex, 'admin', 'owner:password');
    const adaChal = createAdminChallenge();
    const adaSolved = verifyAndSolveChallenge({
        challengeId: adaChal.challengeId, memberPubkey: ada.pubKeyHex,
        signature: crypto.sign(null, Buffer.from(adaChal.challenge, 'utf-8'), ada.privateKey).toString('hex'),
    });
    const adaSession = adaSolved.ok ? consumeHandshakeToken(adaSolved.handshakeToken!).sessionId : undefined;
    assert(!!adaSession, 'Ada signs in as an admin with her key');
    const asAdmin = async (method: 'POST' | 'DELETE', path: string, payload?: unknown): Promise<number> => {
        const res = await fetch(`${BASE}${path}`, {
            method, headers: { 'Content-Type': 'application/json', 'x-admin-session': adaSession ?? '' },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        await res.text();
        return res.status;
    };
    const kim = seed('KeeperKim');       // keeps the shut orchard, then steps down
    const nell = seed('NewKeeperNell');  // an admin binds her to the shut orchard, then unbinds her
    const rita = seed('RequesterRita');  // her requests to the apiary end crowded out and declined
    const ron = seed('RivalRon');        // his request is approved over Rita's
    const { publicKey: shut } = se.createTreasury('ShutOrchard', AVATAR, 100);
    keep(shut, pat, 'lead');
    keep(shut, kim);
    const shutPosts = [offer(shut, 'Apples'), need(shut, 'Pruning')];
    const { publicKey: open } = se.createTreasury('OpenOrchard', AVATAR, 100);
    keep(open, pat, 'lead');
    const pears = offer(open, 'Pears');
    const { publicKey: apiary } = se.createTreasury('Apiary', AVATAR, 100);
    keep(apiary, pat, 'lead');
    const honey = offer(apiary, 'Honey');
    const jam = offer(apiary, 'Jam', false);
    for (const id of [...shutPosts, pears, honey, jam]) ours.add(id);
    offer(rita.pubKeyHex, 'Mending');
    offer(ron.pubKeyHex, 'Tutoring');
    se.transfer('genesis', rita.pubKeyHex, 50, 'seed', 'direct', true);
    se.transfer('genesis', ron.pubKeyHex, 50, 'seed', 'direct', true);
    const ritaHoney = se.requestPost(honey, rita.pubKeyHex);
    const ritaJam = se.requestPost(jam, rita.pubKeyHex);
    const ronJam = se.requestPost(jam, ron.pubKeyHex);
    assert(!!ritaHoney?.id && !!ritaJam?.id && !!ronJam?.id, 'Rita asks for the apiary\'s Honey and its one-off Jam; Ron asks for the Jam too');
    se.pauseEnterprise(shut, 'admin');
    const ritaPhone = new Phone(rita);
    await ritaPhone.sync();
    await phone.sync();
    // Time passes: the orchards and their listings are older than any cursor from here on.
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    for (const key of [shut, open]) age(key, tenMinutesAgo);
    db.prepare('UPDATE posts SET updated_at = ? WHERE author_pubkey IN (?, ?)').run(tenMinutesAgo, shut, open);
    const standing = (key: string) =>
        (db.prepare('SELECT board_standing_changed_at AS s FROM members WHERE public_key = ?').get(key) as { s: string | null } | undefined)?.s ?? null;
    const carries = (delta: Array<{ id: string }>, ids: string[]) => ids.filter(id => delta.some(r => r.id === id));
    const deltaFrom = (since: string) => getUnsigned(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(since)}`);

    // Keepers. Kim keeps the paused orchard, so her phone holds its listings as they are; Nell's, as paused.
    const kimPhone = new Phone(kim);
    await kimPhone.sync();
    const nellPhone = new Phone(nell);
    await nellPhone.sync();
    assert(shutPosts.every(id => kimPhone.rows.get(id)?.status === 'active') && shutPosts.every(id => nellPhone.rows.get(id)?.status === 'paused'),
        `Kim, who keeps the paused orchard, holds its listings as they are; Nell holds them as paused (${shutPosts.map(id => `${kimPhone.rows.get(id)?.status}/${nellPhone.rows.get(id)?.status}`).join(', ')})`);
    const kimIdle = await kimPhone.sync();
    assert(carries(kimIdle, shutPosts).length === 0, 'nothing has changed since: Kim\'s next delta doesn\'t carry them');

    // Kim steps down (over HTTP, signed). The orchard's listings and its standing are as they were.
    const kimSince = new Date(Date.now() - 1).toISOString();
    await new Promise(r => setTimeout(r, 5));
    const steppedDown = await postJson(`/api/treasury/${shut}/keepers/step-down`, {}, kim);
    assert(steppedDown.status === 200, `Kim steps down from the paused orchard over HTTP (got ${steppedDown.status})`);
    const kimDelta = await kimPhone.sync();
    assert(shutPosts.every(id => kimDelta.some(r => r.id === id && r.status === 'paused')),
        `Kim's next delta carries the orchard's listings, as paused: she keeps it no more (${kimDelta.filter(r => r.authorPublicKey === shut).map(r => `${r.title} ${r.status}`).join(', ') || 'none of them'})`);
    const kimAfter = await matchesBoard(kimPhone, 'Kim stepped down from the paused orchard, next delta');
    assert(shutPosts.every(id => !kimAfter.has(id)), 'the orchard\'s listings are off Kim\'s Market');
    const strangerSaw = await deltaFrom(kimSince);
    assert(shutPosts.every(id => strangerSaw.some(r => r.id === id && r.status === 'paused')) && !strangerSaw.some(r => r.authorPublicKey === shut && r.status !== 'paused'),
        'an unsigned delta from just before gets them too, as paused only');

    // An admin binds Nell (over HTTP): her next delta carries them as they are.
    const bound = await asAdmin('POST', `/api/local/admin/treasury/${shut}/operators`, { pubkey: nell.pubKeyHex });
    assert(bound === 200, `an admin binds Nell to the paused orchard over HTTP (got ${bound})`);
    const nellDelta = await nellPhone.sync();
    assert(shutPosts.every(id => nellDelta.some(r => r.id === id && r.status === 'active')) && shutPosts.every(id => nellPhone.rows.get(id)?.status === 'active'),
        `Nell's next delta carries the orchard's listings as they are, as a keeper's phone holds them (${nellDelta.filter(r => r.authorPublicKey === shut).map(r => `${r.title} ${r.status}`).join(', ') || 'none of them'})`);
    // Binding her again with a pledge changes no one's view: nothing is stamped.
    const nellStanding = standing(shut);
    se.adminAssignTreasuryOperator(shut, nell.pubKeyHex, 'admin', 0);
    assert(standing(shut) === nellStanding, `binding a keeper the orchard already has stamps nothing (${nellStanding} → ${standing(shut)})`);

    // And unbinds her (over HTTP): her next delta takes them off again.
    const unbound = await asAdmin('DELETE', `/api/local/admin/treasury/${shut}/operators/${nell.pubKeyHex}`);
    assert(unbound === 200, `an admin unbinds Nell over HTTP (got ${unbound})`);
    const nellAgain = await nellPhone.sync();
    assert(shutPosts.every(id => nellAgain.some(r => r.id === id && r.status === 'paused')),
        `Nell's next delta carries them again, as paused (${nellAgain.filter(r => r.authorPublicKey === shut).map(r => `${r.title} ${r.status}`).join(', ') || 'none of them'})`);
    const nellAfter = await matchesBoard(nellPhone, 'Nell unbound from the paused orchard, next delta');
    assert(shutPosts.every(id => !nellAfter.has(id)), 'the orchard\'s listings are off Nell\'s Market');

    // The other ways a keeper comes or goes move it the same way (in process): the lead approves a request to keep it
    // (at once while it has one keeper), and the community removes its lead by a Decision.
    const { createDecision, executeDecision } = await import('./decisions-engine.js');
    for (const [what, change] of [
        ['Pat approves Kim\'s request to keep the paused orchard again', () =>
            se.approveKeeperRequest(se.requestToJoinEnterprise(shut, kim.pubKeyHex, 0).id, pat.pubKeyHex).applied],
        ['a Decision removes Pat as its lead', () => executeDecision(createDecision({
            authorPubkey: ada.pubKeyHex, title: 'Remove the orchard\'s lead', description: 'exemptions', touches: 'member',
            effect: 'remove_lead_keeper', subject: pat.pubKeyHex, params: { enterprisePubkey: shut, leadPubkey: pat.pubKeyHex },
        }).id).success],
    ] as const) {
        const before = standing(shut);
        await new Promise(r => setTimeout(r, 5));
        const done = change();
        const after = standing(shut);
        assert(done === true && !!after && !!before && after > before, `${what}: the orchard's standing moves (${before} → ${after})`);
    }

    // A keeper change on an enterprise on the board: everyone gets its listings as they are anyway, so no delta carries
    // them, and none tells anyone the keepers changed.
    await phone.sync();
    await kimPhone.sync();
    for (const [what, change] of [
        ['an admin binds Kim to the open orchard', () => asAdmin('POST', `/api/local/admin/treasury/${open}/operators`, { pubkey: kim.pubKeyHex })],
        ['an admin unbinds her', () => asAdmin('DELETE', `/api/local/admin/treasury/${open}/operators/${kim.pubKeyHex}`)],
    ] as const) {
        const before = standing(open);
        const since = new Date(Date.now() - 1).toISOString();
        await new Promise(r => setTimeout(r, 5));
        const status = await change();
        assert(status === 200 && standing(open) === before, `${what} (over HTTP): its standing doesn't move (${before} → ${standing(open)})`);
        const carolDelta = await phone.sync();
        const kimOpen = await kimPhone.sync();
        const unsigned = await deltaFrom(since);
        assert(!carolDelta.some(r => r.id === pears) && !kimOpen.some(r => r.id === pears) && !unsigned.some(r => r.id === pears),
            `${what}: neither Carol's next delta, nor Kim's, nor an unsigned delta from just before carries its Pears`);
    }
    await matchesBoard(phone, 'keepers changed on both orchards, Carol\'s next delta');

    // Deals. A member on holiday has no open deal (holiday is refused with one), and approving or accepting is refused
    // for an author off the board; declining isn't. The apiary's lead approves Ron's request for its one-off Jam (over
    // HTTP), which crowds Rita's out; then the apiary is paused, with Rita's request for its Honey still open.
    const approved = await postJson(`/api/treasury/${apiary}/approve`, { transactionId: ronJam.id }, pat);
    const ritaJamNow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(ritaJam.id) as { status: string } | undefined;
    assert(approved.status === 200 && ritaJamNow?.status === 'rejected',
        `Pat approves Ron's request for the Jam over HTTP; Rita's is crowded out (got ${approved.status}, Rita's ${ritaJamNow?.status})`);
    se.pauseEnterprise(apiary, 'admin');
    const ritaCrowded = await ritaPhone.sync();
    assert(ritaCrowded.some(r => r.id === jam && r.status === 'paused') && ritaPhone.rows.get(jam)?.status === 'paused',
        `crowded out: Rita's next delta carries the Jam, as paused (${ritaPhone.rows.get(jam)?.status})`);
    assert(ritaPhone.rows.get(honey)?.status === 'active', `her request for the Honey is still open, so she holds it as it is (${ritaPhone.rows.get(honey)?.status})`);
    await phone.sync();
    // Time passes: the pause and the apiary's listings are older than Rita's cursor.
    age(apiary, tenMinutesAgo);
    db.prepare('UPDATE posts SET updated_at = ? WHERE author_pubkey = ?').run(tenMinutesAgo, apiary);
    const ritaIdle = await ritaPhone.sync();
    assert(!ritaIdle.some(r => r.id === honey), 'nothing about the Honey has changed since: Rita\'s next delta doesn\'t carry it');

    // Pat declines Rita's request for the Honey (over HTTP). That writes no listing row, and the apiary's standing is as it was.
    const declined = await postJson(`/api/treasury/${apiary}/reject`, { transactionId: ritaHoney.id }, pat);
    assert(declined.status === 200 && declined.body?.transaction?.status === 'rejected', `Pat declines Rita's request for the Honey over HTTP (got ${declined.status})`);
    const ritaDeclined = await ritaPhone.sync();
    assert(ritaDeclined.some(r => r.id === honey && r.status === 'paused' && typeof r.resentAt === 'string'),
        `declined: Rita's next delta carries the Honey again, as paused (${ritaDeclined.filter(r => r.id === honey).map(r => r.status).join(', ') || 'not carried'})`);
    const ritaAfter = await matchesBoard(ritaPhone, 'Rita crowded out and declined, next delta');
    assert(!ritaAfter.has(honey) && !ritaAfter.has(jam), 'neither the Honey nor the Jam is on Rita\'s Market');
    await ritaPhone.sync();
    await matchesBoard(ritaPhone, 'Rita crowded out and declined, the delta after that');
    // A cold start applies her deals again; a declined deal's heal writes nothing.
    ritaPhone.coldStart();
    await ritaPhone.sync();
    await matchesBoard(ritaPhone, 'Rita\'s phone after a cold start');
    await phone.sync();
    await matchesBoard(phone, 'the apiary paused, Carol\'s next delta');

    console.log('\n── what the board doesn\'t show moves nobody\'s listings ──');
    resetGatewayRateLimit();
    // Olly's row changes in ways no listing shows and the board doesn't read. Each moves members.updated_at (delta sync
    // takes it to a standby by that), and none may put his listings in a delta: any delta reader, unsigned included,
    // would learn when it happened.
    const mo = seed('ModeratorMo');
    se.grantNodeRole(mo.pubKeyHex, 'moderator', 'owner:password');
    const chal = createAdminChallenge();
    const solved = verifyAndSolveChallenge({
        challengeId: chal.challengeId, memberPubkey: mo.pubKeyHex,
        signature: crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), mo.privateKey).toString('hex'),
    });
    const modSession = solved.ok ? consumeHandshakeToken(solved.handshakeToken!).sessionId : undefined;
    assert(!!modSession, 'Mo signs in as a moderator with his key');
    const moderator = async (path: string): Promise<number> => {
        const res = await fetch(`${BASE}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-session': modSession ?? '' }, body: JSON.stringify({ reasonCategory: 'spam' }),
        });
        await res.text();
        return res.status;
    };
    const ollyRow = () => db.prepare('SELECT * FROM members WHERE public_key = ?').get(olly.pubKeyHex) as Record<string, any>;
    const spam = [1, 2, 3].map(i => offer(olly.pubKeyHex, `Olly spam ${i}`));
    const changes: Array<[string, () => Promise<boolean>]> = [
        ['Olly edits his bio', async () => (await postJson('/api/profile/update', { bio: 'Splits and stacks it too' }, olly)).status === 200],
        ['Olly changes his contact', async () =>
            (await postJson('/api/profile/update', { contact: { value: 'olly@example.test', visibility: 'community' } }, olly)).status === 200],
        ['a moderator\'s third removal mutes Olly', async () => {
            // Auto-mute runs on the global profile only.
            process.env.NODE_PROFILE = 'global';
            try {
                for (const id of spam) {
                    const reported = await postJson('/api/reports', { reporterPubkey: carol.pubKeyHex, targetPubkey: olly.pubKeyHex, targetPostId: id, reason: 'spam' }, carol);
                    if (reported.status !== 200 || await moderator(`/api/local/admin/posts/${encodeURIComponent(id)}/delete`) !== 200) return false;
                }
            } finally {
                delete process.env.NODE_PROFILE;
            }
            return Date.parse(ollyRow().moderation_muted_until ?? '') > Date.now();
        }],
        ['a moderator lifts his mute', async () => await moderator(`/api/local/admin/members/${olly.pubKeyHex}/unmute`) === 200],
    ];
    for (const [what, change] of changes) {
        await phone.sync();
        const before = ollyRow();
        const since = new Date(Date.now() - 1).toISOString();
        await new Promise(r => setTimeout(r, 5));
        const done = await change();
        const after = ollyRow();
        assert(done && after.updated_at > before.updated_at && after.board_standing_changed_at === before.board_standing_changed_at,
            `${what} (over HTTP): his updated_at moves (${before.updated_at} → ${after.updated_at}), his standing doesn't (${after.board_standing_changed_at})`);
        const delta = await phone.sync();
        assert(!delta.some(r => r.id === ollyPost), `${what}: Carol's next delta doesn't carry his listing (${delta.filter(r => r.authorPublicKey === olly.pubKeyHex).map(r => r.title).join(', ') || 'none of his'})`);
        const open = await getUnsigned(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(since)}`);
        assert(!open.some(r => r.id === ollyPost), `${what}: nor does an unsigned delta from just before it`);
        await matchesBoard(phone, `${what}, next delta`);
    }

    // A re-key moves the member's row to the new key, the stamp with it (engine/key-move.ts).
    // (Every column, so a node without it fails the check rather than the run.)
    const standingOf = (key: string) => (db.prepare('SELECT * FROM members WHERE public_key = ?').get(key) as any)?.board_standing_changed_at;
    const hanaStanding = standingOf(hana.pubKeyHex);
    const hanaAgain = keypair();
    moveMemberKeyRows(hana.pubKeyHex, hanaAgain.pubKeyHex, new Date().toISOString(), { keepStamps: false });
    const moved = standingOf(hanaAgain.pubKeyHex);
    assert(!!hanaStanding && moved === hanaStanding,
        `a re-key moves Hana's standing with her to her new key (${hanaStanding} → ${moved})`);

    console.log('\n── the delta read searches its indexes, on a node\'s worth of posts ──');
    resetGatewayRateLimit();
    // 2,000 members, 20,000 posts and 5,000 ended deals that nothing has changed in a year, and twenty members on holiday
    // with an upcoming event each. Like a node, no sqlite_stat1: nothing runs ANALYZE.
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
        // 5,000 ended deals between other members: what the node holds that the heal's lookup must not read.
        const deal = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                                 VALUES (?, ?, ?, ?, 5, ?, ?)`);
        const bulkPosts = (db.prepare(`SELECT id, author_pubkey FROM posts WHERE title LIKE 'Bulk %' LIMIT 500`).all() as Array<{ id: string; author_pubkey: string }>);
        for (let i = 0; i < 5000; i++) {
            const p = bulkPosts[i % bulkPosts.length];
            deal.run(crypto.randomUUID(), p.id, keys[(i * 7) % keys.length], p.author_pubkey, i % 3 ? 'completed' : 'cancelled', aYearAgo);
        }
    })();
    // Carol opens each of the twenty events' pages (the event page's read, by id with no `sync`).
    const holidayEvents = (db.prepare(`SELECT id FROM posts WHERE title = 'Holiday event'`).all() as Array<{ id: string }>).map(r => r.id);
    for (const id of holidayEvents) await getJson(`/api/marketplace/posts?id=${encodeURIComponent(id)}`, carol);
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
    assert(!!deltaRead?.sql.includes('json_each') && bulkDelta.filter(r => r.title === 'Holiday event' && r.status === 'paused').length === 20,
        'it sends again, as paused, the twenty upcoming events of hosts on holiday, whose pages Carol opened (the most it keeps for her)');
    const plans = ran.filter(r => /\bFROM posts p\b/.test(r.sql)).map(r => ({
        sql: r.sql.replace(/\s+/g, ' ').trim().slice(0, 70),
        plan: (db.prepare(`EXPLAIN QUERY PLAN ${r.sql}`).all(...r.params) as Array<{ detail: string }>).map(p => p.detail),
    }));
    const walks = plans.filter(p => p.plan.some(d => /^SCAN p\b/.test(d)));
    assert(plans.length >= 2 && walks.length === 0,
        `no statement of the delta read walks every post (${walks.map(w => `${w.sql}…: ${w.plan.join('; ')}`).join(' | ') || `${plans.length} statements, none has SCAN p`})`);
    // Its author half finds the authors whose standing changed since the cursor on their own index: never every member,
    // and never members.updated_at, which a bio or a mute moves.
    const deltaPlan = deltaRead ? (db.prepare(`EXPLAIN QUERY PLAN ${deltaRead.sql}`).all(...deltaRead.params) as Array<{ detail: string }>).map(p => p.detail) : [];
    assert(deltaPlan.some(d => /^SEARCH members USING COVERING INDEX idx_members_board_standing_changed_at \(board_standing_changed_at>\?\)/.test(d))
        && !deltaPlan.some(d => /^SCAN members\b|idx_members_updated_at/.test(d)),
        `the delta read finds the authors whose standing changed by idx_members_board_standing_changed_at alone (${deltaPlan.join('; ')})`);
    // The heal's deals are the reader's own, found by the buyer and seller indexes: never every ended deal on the node
    // (folded into one query, the planner picks idx_marketplace_transactions_status_completed).
    const dealsRead = ran.find(r => /FROM marketplace_transactions WHERE buyer_pubkey = @viewer OR seller_pubkey = @viewer/.test(r.sql));
    const dealsPlan = dealsRead ? (db.prepare(`EXPLAIN QUERY PLAN ${dealsRead.sql}`).all(...dealsRead.params) as Array<{ detail: string }>).map(p => p.detail) : [];
    assert(dealsPlan.some(d => /idx_marketplace_transactions_buyer_status_created \(buyer_pubkey=\?\)/.test(d))
        && dealsPlan.some(d => /idx_marketplace_transactions_seller_status_created \(seller_pubkey=\?\)/.test(d))
        && !dealsPlan.some(d => /status_completed|^SCAN marketplace_transactions/.test(d)),
        `the lookup of the heal's deals searches the reader's own deals by their indexes (${dealsPlan.join('; ') || 'it did not run'})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The phone\'s Market after a sync is the board.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
