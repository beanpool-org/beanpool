/**
 * Test Suite: the door on a copy (DESIGN-reaching-across-fable.md §3 and decisions 1 and 4, slice GD; engine/event-copy.ts).
 * "Take questions about this on the global community": a copy names nobody until its member ticks it, and a tick taken back
 * takes the name and the door away at once. Three leaks of "a copy names nobody" got past a sweep on #2711, so this names
 * every way a post leaves the node, door off and door on, for a member, a visitor and a signed stranger, with a plain
 * listing and an untouched copy as controls. Boots the real server on the global profile, over HTTPS, signed:
 *
 *   1. the tick: off by default, by its own author alone, Offers and Needs only; a mute can't stop an Off
 *   2. every read, door off: nobody named, the existing copies included
 *   3. every read, door on: the name and key for a member and nobody else, field by field
 *   4. sockets, push and the activity feed: no name on either side of the tick
 *   5. what follows an author: blocks, a holiday, a new name, and a re-key, door off and door on
 *   6. a report, moderators, the assistant
 *   7. the door itself: a first line is a request, one line, no friend, no ring; no money route
 *   8. Off: the name and the door go at once on every path, and a request already sent stays the member's to answer
 *   9. removal, hide, pause, delete
 *  10. requests off closes the doors
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-copy-door)
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
import { lockedDm } from './dm-test-payload.js';

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
type Answer = { status: number; body: any; text: string; etag: string | null };
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
    return { status: res.status, body: parsed, text, etag: res.headers.get('etag') };
}

const HOUR = 60 * 60 * 1000;
const EXACT = { lat: -28.68731, lng: 153.52219 };
const ROUNDED = { lat: -28.7, lng: 153.5 };
const HOST = 'mullum.example.org';
const PRICE = { beans: 20, per: 'fixed' };
const TAKES = '/api/marketplace/posts/takes-questions';

async function main() {
    console.log('The door on a copy...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { writeDirectoryRows, normaliseRegistryRow } = await import('./engine/directory-cache.js');
    const { LISTING_COPY_CODE } = await import('./engine/escrow.js');
    const { OWNER_READ_TOOLS } = await import('./agent/owner-reads.js');
    const { setMemberArea } = await import('./engine/member-area.js');
    const { closeCopyDoors } = await import('./engine/event-copy.js');
    const { guestPost, setMemberPhoto } = await import('@beanpool/engine');
    const { moveMemberKeyRows } = await import('./engine/key-move.js');
    const { scrubPostsOf } = await import('./engine/post-scrub.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');

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
    const member = (name: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, updated_at)
                    VALUES (?, ?, 'active', ?, 'genesis', 'TEST', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, name, longAgo);
        setMemberPhoto(db, id.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        return id;
    };
    const robin = member('RobinSeller');
    const sam = member('SamReader');
    const blocker = member('BlockerReader');
    setMemberArea(sam.pubKeyHex, ROUNDED);
    setMemberArea(blocker.pubKeyHex, ROUNDED);
    const stranger = keypair();

    writeDirectoryRows([normaliseRegistryRow({ node_id: `https://${HOST}`, shown_name: 'Mullumbimby Commons', node_url: `https://${HOST}`, last_seen_at: new Date().toISOString(), accepting_knocks: true })!], new Date().toISOString());

    const listing = (who: Id, title: string, extra: Record<string, unknown> = {}, from: Record<string, unknown> = {}) => ({
        id: crypto.randomUUID(), type: 'offer', category: 'food', title, description: 'Fresh this morning', authorPublicKey: who.pubKeyHex,
        ...EXACT, photos: TEST_PHOTOS, tags: [], freeTags: ['sourdough'], shownPrice: PRICE, shownFrom: { host: HOST, postId: crypto.randomUUID(), ...from }, ...extra,
    });
    const postCopy = async (who: Id, title: string, extra: Record<string, unknown> = {}, from: Record<string, unknown> = {}): Promise<string> => {
        const made = await call('POST', '/api/marketplace/posts', who, listing(who, title, extra, from));
        if (made.status !== 200) throw new Error(`setup: ${made.status} ${made.text.slice(0, 200)}`);
        return made.body.post.id;
    };
    const stored = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
    const byId = async (id: string, who: Id | null) => (await call('GET', `/api/marketplace/posts?id=${id}`, who)).body?.[0];
    const tick = (who: Id, id: string, on: unknown) => call('POST', TAKES, who, { id, on });

    /** Every read a listing goes out by, as a path. The two with a body to look into are called out below. */
    const READS = (id: string) => [
        ['by id', `/api/marketplace/posts?id=${id}`],
        ['by ids', `/api/marketplace/posts?ids=${id}`],
        ['the board', '/api/marketplace/posts?types=offer,need,poll,event&limit=100'],
        ['one kind', '/api/marketplace/posts?type=offer&limit=100'],
        ['the map: a point', `/api/marketplace/posts?type=offer&lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&radiusKm=50`],
        ['nearest first', `/api/marketplace/posts?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&sort=distance`],
        ['fill, from elsewhere', '/api/marketplace/posts?lat=52.5&lng=13.4&sort=distance&limit=50'],
        ['search', '/api/marketplace/posts?q=sourdough'],
        ['a typed tag', '/api/marketplace/posts?free=sourdough'],
        ['a category', '/api/marketplace/posts?category=food'],
        ['a sync', '/api/marketplace/posts?sync=true&types=offer,need'],
        ['a delta', `/api/marketplace/posts?sync=true&updatedAfter=${encodeURIComponent(new Date(Date.now() - HOUR).toISOString())}`],
        ['the nearby set', '/api/marketplace/posts?nearby=1&sync=true'],
        ['Home', '/api/home'],
        ['the landing card', `/api/global/home?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}`],
        ['the shops near', `/api/shops?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}`],
        ['the activity feed', '/api/activity/feed'],
        ['the pricing guide', '/api/pricing-guide'],
    ] as const;
    /** Reads that are exactly a listing, where a member with the door open reads the name. Home and the rest carry no author. */
    const NAMING_READS = new Set(['by id', 'by ids', 'the board', 'one kind', 'the map: a point', 'nearest first', 'fill, from elsewhere', 'search', 'a typed tag', 'a category', 'a sync', 'a delta', 'the nearby set']);
    const namesRobin = (text: string) => text.includes(robin.pubKeyHex) || text.includes('RobinSeller');
    const copyRow = (body: any, id: string): any => (Array.isArray(body) ? body : Array.isArray(body?.posts) ? body.posts : []).find((p: any) => p?.id === id);
    /** Every object in an answer that says this post's id: Robin's plain listing names him, so a read is judged by the copy's own rows. */
    const rowsOf = (node: unknown, id: string, found: unknown[] = []): unknown[] => {
        if (Array.isArray(node)) node.forEach((n) => rowsOf(n, id, found));
        else if (node && typeof node === 'object') {
            if (Object.values(node).includes(id)) found.push(node);
            else Object.values(node).forEach((n) => rowsOf(n, id, found));
        }
        return found;
    };
    const sweep = async (id: string, who: string, as: Id | null, wantName: boolean) => {
        for (const [what, path] of READS(id)) {
            const read = await call('GET', path, as);
            const named = namesRobin(JSON.stringify(rowsOf(read.body, id)));
            const expected = wantName && NAMING_READS.has(what);
            assert(named === expected, `${who}, ${what}: ${expected ? 'the name and key' : 'nobody'} (${read.status}, ${rowsOf(read.body, id).length} rows)`);
        }
    };

    // ── 1. The tick ──
    console.log('── 1. The tick ──');
    const plainCopy = await postCopy(robin, 'Sourdough loaves');
    const untouched = await postCopy(robin, 'Rye loaves');
    assert(stored(plainCopy)?.shown_takes_questions === null, 'a copy is made with its door shut');
    const plainPost = await call('POST', '/api/marketplace/posts', robin, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Plain loaves', description: 'On global by hand', authorPublicKey: robin.pubKeyHex, ...ROUNDED, photos: TEST_PHOTOS });
    const plainId: string = plainPost.body?.post?.id;
    const atCreate = await postCopy(robin, 'Ticked at the composer', {}, { takesQuestions: true });
    assert(stored(atCreate)?.shown_takes_questions === 1, 'the composer\'s tick goes with the create');
    for (const [what, value] of [['a string', 'true'], ['a number', 1]] as const) {
        const copy = await postCopy(robin, `Bad tick, ${what}`, {}, { takesQuestions: value });
        assert(stored(copy)?.shown_takes_questions === null, `only \`true\` opens a door on a create: not ${what}`);
    }
    const eventCopyRes = await call('POST', '/api/marketplace/posts', robin, {
        id: crypto.randomUUID(), type: 'event', category: 'community', title: 'A market day', description: 'x', authorPublicKey: robin.pubKeyHex, ...EXACT, photos: TEST_PHOTOS,
        eventStartAt: new Date(Date.now() + 48 * HOUR).toISOString(), eventEndAt: new Date(Date.now() + 49 * HOUR).toISOString(), shownFrom: { host: HOST, takesQuestions: true },
    });
    const eventId: string = eventCopyRes.body?.post?.id;
    assert(!!eventId && stored(eventId)?.shown_takes_questions === null, `an event takes none at the create: the ask is "come" (${eventCopyRes.status})`);
    const eventTick = await tick(robin, eventId, true);
    assert(eventTick.status === 400 && stored(eventId)?.shown_takes_questions === null, `nor by the tick (${eventTick.status} ${eventTick.text.slice(0, 90)})`);
    const others = [await tick(sam, plainCopy, true), await tick(sam, crypto.randomUUID(), true), await tick(robin, plainId, true), await tick(robin, crypto.randomUUID(), false)];
    assert(others.every((a) => a.status === 404) && new Set(others.map((a) => a.text)).size === 1, `another's copy, no post, a post that is no copy: one answer, so a key tests nothing (${others.map((a) => a.status)})`);
    assert(stored(plainCopy)?.shown_takes_questions === null && stored(plainId)?.shown_takes_questions === null, 'and none of them moved anything');
    for (const body of [{ id: plainCopy }, { id: plainCopy, on: 'true' }, { on: true }]) {
        assert((await call('POST', TAKES, robin, body)).status === 400, `a bad request is refused: ${JSON.stringify(body)}`);
    }
    assert((await call('POST', TAKES, null, { id: plainCopy, on: true })).status === 401 && stored(plainCopy)?.shown_takes_questions === null, 'it needs a signature');
    assert((await call('POST', TAKES, stranger, { id: plainCopy, on: true })).status === 403, 'a signed stranger is no member');
    const edited = await call('POST', '/api/marketplace/posts/update', robin, { id: plainCopy, authorPublicKey: robin.pubKeyHex, title: 'Sourdough loaves', takesQuestions: true, shownTakesQuestions: 1 });
    assert(edited.status === 200 && stored(plainCopy)?.shown_takes_questions === null, `an edit can't open a door, whatever it sends: only the tick does (${edited.status})`);
    const stamp = stored(plainCopy)?.updated_at;
    const twice = await tick(robin, plainCopy, false);
    assert(twice.status === 200 && stored(plainCopy)?.updated_at === stamp, 'an Off on a shut door writes nothing');
    await new Promise((r) => setTimeout(r, 5));

    // A mute: an edit is refused and so is opening; an Off never is.
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + HOUR).toISOString(), robin.pubKeyHex);
    const mutedOn = await tick(robin, plainCopy, true);
    assert(mutedOn.status === 403 && stored(plainCopy)?.shown_takes_questions === null, `muted, the door doesn't open (${mutedOn.status} ${mutedOn.text.slice(0, 80)})`);
    const mutedAtCreate = await tick(robin, atCreate, false);
    assert(mutedAtCreate.status === 200 && stored(atCreate)?.shown_takes_questions === null, `muted, it still shuts: an Off is never refused (${mutedAtCreate.status})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(robin.pubKeyHex);

    // ── 2. Every read, door off ──
    console.log('\n── 2. Every read, door off ──');
    for (const [who, as] of [['a member', sam], ['a visitor', null], ['a signed stranger', stranger]] as const) await sweep(plainCopy, who, as, false);
    const beforeTick = await call('GET', `/api/marketplace/posts?id=${plainCopy}`, sam);
    assert(!!beforeTick.etag, 'setup: reads carry an ETag');

    // ── 3. Every read, door on ──
    console.log('\n── 3. Every read, door on ──');
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
    const opened = await tick(robin, plainCopy, true);
    assert(opened.status === 200 && opened.body?.takesQuestions === true && stored(plainCopy)?.shown_takes_questions === 1, `the tick opens it (${opened.status} ${opened.text.slice(0, 100)})`);
    const visitorRead = await byId(plainCopy, null);
    const memberRead = await byId(plainCopy, sam);
    assert(memberRead?.authorPublicKey === robin.pubKeyHex && memberRead?.authorCallsign === 'RobinSeller' && memberRead?.takesQuestions === true, 'a member reads the name and key to write to');
    const { readOfCopy } = await import('./engine/event-copy.js');
    const raw = { ...stored(plainCopy) };
    const engineRow = (over: Record<string, unknown> = {}) => ({ id: plainCopy, type: 'offer', authorPublicKey: robin.pubKeyHex, authorCallsign: 'RobinSeller', status: 'active', active: true, shownFromHost: raw.shown_from_host, takesQuestions: true, ...over }) as any;
    assert(readOfCopy(engineRow(), sam.pubKeyHex).authorPublicKey === robin.pubKeyHex, 'the read by hand, the control: a member gets the name');
    assert(readOfCopy(engineRow(), stranger.pubKeyHex).authorPublicKey === 'hidden', 'a signed stranger reaching this read by any route gets none: the visitors\' view is not all that holds it');
    assert(readOfCopy(engineRow(), null).authorPublicKey === 'hidden' && readOfCopy(engineRow(), undefined).authorPublicKey === 'hidden', 'nor does a read for nobody in particular');
    assert(readOfCopy(engineRow({ status: 'paused' }), sam.pubKeyHex).authorPublicKey === 'hidden', 'off the board there is nothing to ask about');
    assert(readOfCopy(engineRow({ active: false }), sam.pubKeyHex).authorPublicKey === 'hidden', 'nor taken down');
    assert(readOfCopy(engineRow({ hiddenByReportsAt: new Date().toISOString() }), sam.pubKeyHex).authorPublicKey === 'hidden', 'a moderator\'s read of a hidden copy names nobody here either: the queue has the author, from a report');
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(sam.pubKeyHex);
    assert(readOfCopy(engineRow(), sam.pubKeyHex).authorPublicKey === 'hidden', 'a suspended member reads nothing as a member, this included');
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(sam.pubKeyHex);
    const added = Object.keys(memberRead ?? {}).filter((k) => !(k in (visitorRead ?? {})));
    assert(added.join() === 'takesQuestions', `field by field, a member's read is the visitor's and one more field (${added})`);
    const changed = Object.keys(visitorRead ?? {}).filter((k) => JSON.stringify(visitorRead[k]) !== JSON.stringify(memberRead?.[k]));
    assert(changed.sort().join() === 'authorCallsign,authorPublicKey', `and only the name and key differ (${changed})`);
    assert(memberRead?.authorAvatarUrl === null && memberRead?.lat === ROUNDED.lat && !('hiddenByReportsAt' in memberRead) && !('createdVia' in memberRead), 'no face, no place, nothing of moderation');
    assert(!('takesQuestions' in visitorRead) && visitorRead?.authorPublicKey === 'hidden' && visitorRead?.authorCallsign === '', 'a visitor reads what they read before: no name, no sign of a door');
    assert(!('takesQuestions' in guestPost(engineRow())), 'nor does the visitors\' shape itself carry the sign, for a read that reaches it by another way (peek)');
    const own = await byId(plainCopy, robin);
    assert(own?.takesQuestions === true && own?.authorPublicKey === robin.pubKeyHex, 'its author reads the tick back');
    const untouchedRead = await byId(untouched, sam);
    assert(untouchedRead?.authorPublicKey === 'hidden' && !('takesQuestions' in untouchedRead), 'the member\'s other copy stays shut: it is per listing');
    await sweep(plainCopy, 'a member', sam, true);
    for (const [who, as] of [['a visitor', null], ['a signed stranger', stranger]] as const) await sweep(plainCopy, who, as, false);
    const authorList = await call('GET', `/api/marketplace/posts?author=${robin.pubKeyHex}`, sam);
    assert(authorList.status === 200 && !authorList.text.includes(plainCopy), 'one member\'s list leaves it out: a list of theirs would tie it to the rest');
    assert((await call('GET', `/api/marketplace/posts?author=${robin.pubKeyHex}`, null)).status === 403, 'and a visitor is refused that list, as ever');
    const byName = await call('GET', '/api/marketplace/posts?q=RobinSeller', sam);
    assert(!byName.text.includes(plainCopy), 'a search for the name doesn\'t find it: search goes by its words');

    // ── 4. Sockets, push, the feed ──
    console.log('\n── 4. Sockets, push, the feed ──');
    await new Promise((r) => setTimeout(r, 200));
    const frames = samSocket.raw.join('\n');
    assert(frames.includes(plainCopy), `a member near it hears it changed (${samSocket.raw.length} frames)`);
    assert(!namesRobin(frames) && !frames.includes('Sourdough loaves'), 'the socket carries the id and no name, door on as off');

    // ── 5. What follows an author ──
    console.log('\n── 5. What follows an author ──');
    const hasIt = async (id: string, as: Id) => (await call('GET', '/api/marketplace/posts?q=sourdough', as)).text.includes(id);
    assert(await hasIt(plainCopy, blocker) && await hasIt(untouched, blocker), 'setup: the blocker has both copies');
    const block = await call('POST', '/api/blocks', blocker, { targetPubkey: robin.pubKeyHex });
    assert(block.status === 200, `setup: a block (${block.status} ${block.text.slice(0, 100)})`);
    assert(!(await hasIt(plainCopy, blocker)), 'a block holds at this door: the copy that names them goes from the blocker\'s board');
    assert(await hasIt(untouched, blocker), 'the shut copy stays: a read that moved with a block would say whose it is (the leak #2711 found)');
    const blockerSocket = await socketOf(blocker);
    await se.updatePost(plainCopy, robin.pubKeyHex, { title: 'Sourdough loaves' }, robin.pubKeyHex);
    await se.updatePost(untouched, robin.pubKeyHex, { title: 'Rye loaves' }, robin.pubKeyHex);
    await new Promise((r) => setTimeout(r, 200));
    const blockerFrames = blockerSocket.raw.join('\n');
    assert(!blockerFrames.includes(plainCopy), 'the socket keeps the block for the copy that names them');
    assert(blockerFrames.includes(untouched), 'and rings the blocker for the shut one, or that doorbell would say whose it is (the leak #2711 found)');
    blockerSocket.ws.close();
    await call('POST', '/api/blocks/remove', blocker, { targetPubkey: robin.pubKeyHex });

    const cursor = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    db.prepare(`UPDATE members SET board_standing_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(robin.pubKeyHex);
    const delta = await call('GET', `/api/marketplace/posts?sync=true&types=offer,need&updatedAfter=${encodeURIComponent(cursor)}`, sam);
    assert(delta.text.includes(plainCopy), 'a change of standing reaches a copy that names them');
    assert(!delta.text.includes(untouched), 'and never a shut one: a delta that moved with their rows would tie it to them');

    const rekeyed = keypair();
    const named = stored(plainCopy);
    const shut = stored(untouched);
    await new Promise((r) => setTimeout(r, 5));
    moveMemberKeyRows(robin.pubKeyHex, rekeyed.pubKeyHex, new Date().toISOString(), { keepStamps: false });
    assert(stored(plainCopy)?.author_pubkey === rekeyed.pubKeyHex && stored(plainCopy)?.updated_at !== named.updated_at, 'a re-key moves a copy that shows them, stamp and all: its readers need the new key');
    assert(stored(untouched)?.author_pubkey === rekeyed.pubKeyHex && stored(untouched)?.updated_at === shut.updated_at, 'a shut copy keeps its stamp: the same millisecond as their rows would tie it (the leak #2711 found)');
    moveMemberKeyRows(rekeyed.pubKeyHex, robin.pubKeyHex, new Date().toISOString(), { keepStamps: false });

    // ── 6. A report, moderators, the assistant ──
    console.log('\n── 6. A report, moderators, the assistant ──');
    for (const [what, id] of [['door on', plainCopy], ['door off', untouched]] as const) {
        const report = await call('POST', '/api/reports', sam, { reporterPubkey: sam.pubKeyHex, targetPubkey: 'hidden', targetPostId: id, reason: 'spam', details: 'test' });
        assert((report.status === 200 || report.status === 201) && !namesRobin(report.text), `${what}: the reporter's answer names nobody (${report.status})`);
        const again = await call('POST', '/api/reports', sam, { reporterPubkey: sam.pubKeyHex, targetPubkey: 'hidden', targetPostId: id, reason: 'spam', details: 'test' });
        assert(!namesRobin(again.text), `${what}: nor does a repeat`);
        assert((db.prepare('SELECT target_pubkey FROM abuse_reports WHERE target_post_id = ?').get(id) as any)?.target_pubkey === robin.pubKeyHex, `${what}: the moderators' queue has the real author`);
        db.prepare('DELETE FROM abuse_reports WHERE target_post_id = ?').run(id);
    }
    const grant = (who: Id) => ({ id: 'g', name: 'g', member: who.pubKeyHex, role: 'owner', via: 'token', createdAt: 0, expiresAt: null, canPost: true });
    const search = (OWNER_READ_TOOLS as any[]).find((x) => x.name === 'listings_search').run(grant(sam), { q: 'sourdough', include_text: true }, 'B');
    const inSearch = search.ok ? search.result.listings.find((l: any) => l.postId === plainCopy) : null;
    assert(inSearch?.by === 'another member' && !namesRobin(JSON.stringify(search)), `the assistant's read: door on, it still says "another member" (${JSON.stringify(inSearch).slice(0, 90)})`);

    // ── 7. The door itself ──
    console.log('\n── 7. The door itself ──');
    const convo = await call('POST', '/api/messages/conversation', sam, { type: 'dm', participants: [robin.pubKeyHex, sam.pubKeyHex], createdBy: sam.pubKeyHex });
    const convId: string = convo.body?.id ?? convo.body?.conversation?.id;
    assert(convo.status === 200 && !!convId, `a member can open a chat with the key on the copy (${convo.status} ${convo.text.slice(0, 120)})`);
    const sealed = () => ({ conversationId: convId, authorPubkey: sam.pubKeyHex, ...lockedDm() });
    const first = await call('POST', '/api/messages/send', sam, sealed());
    const row = db.prepare('SELECT state FROM dm_requests WHERE conversation_id = ?').get(convId) as { state: string } | undefined;
    assert(first.status === 200 && row?.state === 'pending', `the first line is a request (${first.status} ${first.text.slice(0, 120)} ${row?.state})`);
    const second = await call('POST', '/api/messages/send', sam, sealed());
    assert(second.status === 403 && second.body?.code === 'dm_request_pending', `a second line waits for Accept (${second.status} ${second.text.slice(0, 100)})`);
    assert(!(db.prepare('SELECT 1 FROM friends WHERE owner_pubkey IN (?, ?)').get(sam.pubKeyHex, robin.pubKeyHex)), 'nobody became a friend');
    assert(se.getUnreadAnswer(robin.pubKeyHex).unread === 0 && se.getUnreadAnswer(robin.pubKeyHex).requests === 1, 'it counts as a request and in no unread number: no badge, no ring');

    const doors = [['take it up', '/api/marketplace/posts/accept', { postId: plainCopy, buyerPublicKey: sam.pubKeyHex }], ['ask for it', '/api/marketplace/posts/request', { postId: plainCopy, buyerPublicKey: sam.pubKeyHex }]] as const;
    for (const [what, path, body] of doors) assert((await call('POST', path, sam, body)).status >= 400, `Beans off, door on: ${what} is refused`);
    setSwitch('beans', 'true');
    setSwitch('escrow', 'true');
    for (const [what, path, body] of doors) {
        const refused = await call('POST', path, sam, body);
        assert(refused.status === 409 && refused.body?.code === LISTING_COPY_CODE, `Beans on, door on: ${what} is refused by the copy's guard (${refused.status} ${refused.text.slice(0, 100)})`);
    }
    setSwitch('beans', null);
    setSwitch('escrow', null);

    // ── 8. Off ──
    console.log('\n── 8. Off ──');
    const SYNC = '/api/marketplace/posts?sync=true&types=offer,need';
    const beforeOff = await call('GET', SYNC, sam);
    assert(!!beforeOff.etag && (await call('GET', SYNC, sam, undefined, { 'If-None-Match': beforeOff.etag })).status === 304, 'setup, the control: the same tag on the same read is a 304');
    const offStamp = stored(plainCopy)?.updated_at;
    const othersBefore = (db.prepare('SELECT id, updated_at FROM posts WHERE author_pubkey = ? AND id != ? ORDER BY id').all(robin.pubKeyHex, plainCopy) as any[]).map((r) => `${r.id}:${r.updated_at}`).join();
    const deltaFrom = new Date(Date.now() - 1).toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const closed = await tick(robin, plainCopy, false);
    assert(closed.status === 200 && closed.body?.takesQuestions === false && stored(plainCopy)?.shown_takes_questions === null, `the tick shuts it (${closed.status})`);
    assert(stored(plainCopy)?.updated_at !== offStamp, 'and moves its stamp, so a delta has it');
    assert((db.prepare('SELECT id, updated_at FROM posts WHERE author_pubkey = ? AND id != ? ORDER BY id').all(robin.pubKeyHex, plainCopy) as any[]).map((r) => `${r.id}:${r.updated_at}`).join() === othersBefore, 'and no other row of theirs: a stamp in step would tie them');
    await sweep(plainCopy, 'a member, after Off', sam, false);
    assert((await byId(plainCopy, sam))?.authorPublicKey === 'hidden', 'a read by id names nobody at once');
    const validated = await call('GET', SYNC, sam, undefined, { 'If-None-Match': beforeOff.etag ?? '' });
    assert(validated.status === 200 && !namesRobin(JSON.stringify(copyRow(validated.body, plainCopy))), `a client holding the old tag isn't told 304 (${validated.status})`);
    const offDelta = await call('GET', `/api/marketplace/posts?sync=true&types=offer,need&updatedAfter=${encodeURIComponent(deltaFrom)}`, sam);
    const offRow = copyRow(offDelta.body, plainCopy);
    assert(!!offRow && offRow.authorPublicKey === 'hidden' && !('takesQuestions' in offRow), 'a phone\'s next delta replaces the row it holds with one that names nobody');
    await new Promise((r) => setTimeout(r, 200));
    const aboutIt = samSocket.raw.filter((f) => f.includes(plainCopy));
    assert(aboutIt.length >= 2 && !namesRobin(aboutIt.join('\n')), `the socket said nothing of them either side of it (${aboutIt.length} frames)`);
    samSocket.ws.close();
    assert((await call('POST', '/api/messages/conversation', sam, { type: 'dm', participants: ['hidden', sam.pubKeyHex], createdBy: sam.pubKeyHex })).status === 400, 'the neutral author is nobody to write to');

    // A request already sent: the design puts the door on the author, not the listing (§3). It stays theirs to answer.
    assert(se.getUnreadAnswer(robin.pubKeyHex).requests === 1, 'a request already sent is still theirs to answer');
    const list = await call('GET', `/api/messages/conversations/${robin.pubKeyHex}`, robin);
    assert(list.body?.requests?.count === 1, 'it is in their list');
    const samsView = await call('GET', `/api/messages/conversations/${sam.pubKeyHex}`, sam);
    assert(JSON.stringify(samsView.body).includes(convId), 'the sender reads their chat as they left it: nothing tells them the door shut');
    const stillSecond = await call('POST', '/api/messages/send', sam, sealed());
    assert(stillSecond.status === 403 && stillSecond.body?.code === 'dm_request_pending', 'their next line still waits: Off opens nothing');
    const accepted = await call('POST', '/api/messages/request', robin, { conversationId: convId, decision: 'accept' });
    assert(accepted.status === 200 && accepted.body?.request?.state === 'accepted', `Accept still opens it (${accepted.status} ${accepted.text.slice(0, 100)})`);
    assert((await byId(plainCopy, sam))?.authorPublicKey === 'hidden', 'and the copy still names nobody: a chat is no door');

    // ── 9. Removal, hide, pause, delete ──
    console.log('\n── 9. Removal, hide, pause, delete ──');
    await tick(robin, plainCopy, true);
    db.prepare(`UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(plainCopy);
    const hidden = await call('GET', '/api/marketplace/posts?sync=true&types=offer,need', sam);
    const hiddenRow = copyRow(hidden.body, plainCopy);
    assert(hiddenRow?.title === '' && hiddenRow?.authorPublicKey === 'hidden' && !('takesQuestions' in hiddenRow), 'door on, hidden by reports: a member\'s sync reads a removal that names nobody');
    db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(plainCopy);
    const paused = await call('POST', '/api/marketplace/posts/pause', robin, { id: plainCopy, postId: plainCopy, authorPublicKey: robin.pubKeyHex });
    const pausedSync = copyRow((await call('GET', '/api/marketplace/posts?sync=true&types=offer,need', sam)).body, plainCopy);
    assert(paused.status === 200 && (!pausedSync || pausedSync.authorPublicKey === 'hidden'), `door on, paused: nothing to ask about, and no name (${paused.status} ${pausedSync?.status})`);
    await call('POST', '/api/marketplace/posts/resume', robin, { id: plainCopy, postId: plainCopy, authorPublicKey: robin.pubKeyHex });
    assert((await byId(plainCopy, sam))?.authorPublicKey === robin.pubKeyHex, 'resumed, it reads as it did');
    const standbyRow = ((await se.exportSyncState('test')).posts as any[]).find((p) => p.id === plainCopy);
    assert(standbyRow?.shownTakesQuestions === 1, `a standby's copy carries the tick (${standbyRow?.shownTakesQuestions})`);
    const removed = await call('POST', '/api/marketplace/posts/remove', robin, { id: plainCopy, authorPublicKey: robin.pubKeyHex });
    const gone = copyRow((await call('GET', '/api/marketplace/posts?sync=true&types=offer,need', sam)).body, plainCopy);
    assert(removed.status === 200 && (!gone || gone.authorPublicKey === 'hidden'), `door on, taken down: no name (${removed.status} ${gone?.status})`);
    const toDelete = await postCopy(robin, 'Goes with the account', {}, { takesQuestions: true });
    assert(stored(toDelete)?.shown_takes_questions === 1, 'setup: a copy with its door on');
    scrubPostsOf(robin.pubKeyHex, new Date().toISOString());
    assert(stored(toDelete)?.shown_takes_questions === null && stored(toDelete)?.shown_from_host === '', 'Delete account clears the tick, and the copy stays a copy, so it never starts naming them');

    // ── 10. Requests off closes the doors ──
    console.log('\n── 10. Requests off closes the doors ──');
    const carol = member('CarolSeller');
    const open = await postCopy(carol, 'Door on before requests went off', {}, { takesQuestions: true });
    const noDoorBefore = await postCopy(carol, 'Door off before requests went off');
    const before = stored(noDoorBefore)?.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const tagBefore = (await call('GET', SYNC, sam)).etag;
    applyShapeChanges({ actor: carol.pubKeyHex, actorRole: 'owner' }, { changes: { dmRequests: false } });
    assert(stored(open)?.shown_takes_questions === null, 'Settings turns requests off: nothing would hold a first line, so the doors close with it');
    assert((await call('GET', SYNC, sam, undefined, { 'If-None-Match': tagBefore ?? '' })).status === 200, 'and no client is told 304 for a list that named them');
    assert(closeCopyDoors() === 0, 'and there is none left to close');
    assert(stored(noDoorBefore)?.updated_at === before, 'a shut copy isn\'t touched');
    assert((await tick(carol, noDoorBefore, true)).status === 409 && stored(noDoorBefore)?.shown_takes_questions === null, 'and none opens');
    assert((await tick(carol, noDoorBefore, false)).status === 200, 'an Off stays free');
    const whileOff = await postCopy(carol, 'Ticked while requests are off', {}, { takesQuestions: true });
    assert(stored(whileOff)?.shown_takes_questions === null, 'a create can\'t open one either');
    db.prepare('UPDATE posts SET shown_takes_questions = 1 WHERE id = ?').run(open);
    se.runMarketplaceHygiene();
    assert(stored(open)?.shown_takes_questions === null, 'an operator\'s environment gets there by the hourly sweep, the first a minute after boot');
    setSwitch('dmRequests', null);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
