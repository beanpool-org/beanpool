/**
 * Test Suite: a member's copy of an in-person event on the global community (DESIGN-list-on-global-fable.md §3, §7, §11;
 * DESIGN-reaching-across-fable.md §3; slice G2′; engine/event-copy.ts). Boots the real server on the global profile and
 * goes through the real middleware over HTTPS, signed:
 *
 *   1. the write: the copy keeps its community's host for a shown row; a place name, a note and an exact pin sent anyway
 *      are not stored; the point is the rounded home point
 *   2. the reads, a visitor's and a member's: no key, name, face, exact place, typed place or note, on every read shape and
 *      on the socket; the from-line and the door are the row's words, never what the phone said; only its author reads an author
 *   3. the unlisted host: dropped at write, the answer says so by what it lacks, and the copy is still a copy
 *   4. the row that goes: the line and the door go with it at the next read, and no ETag confirms the old body
 *   5. no RSVP: 409 with the door's words; no chat is made or opened; the activity feed names nobody; a member's own list
 *      read by another leaves it out; a report reaches the moderators with the author and tells the reporter none
 *   6. the kinds: an online or group event is refused, not made in the open; a plain event is as before
 *   7. an edit keeps to the times and the rounded pin; a cancel takes it off the board
 *   8. probation and retention count the copy
 *   9. a local community ignores the field
 *  10. no read goes by who wrote it: a reader's block, the author's holiday or pause and a new name move their listings,
 *      each proved by a control, and leave a copy reading as it did, in every list, delta, count and tag; a block leaves the
 *      frames a real socket hears of a copy as they were, made, edited, rolled on and taken down
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-event-copy)
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
type Answer = { status: number; body: any; etag: string | null };
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
    return { status: res.status, body: parsed, etag: res.headers.get('etag') };
}

const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const PLACE = 'Bangalow Hall, 12 Station Street';
const NOTE = 'Blue gate, code 4321';
const EXACT = { lat: -28.68731, lng: 153.52219 };
const ROUNDED = { lat: -28.7, lng: 153.5 };
const HOST = 'mullum.example.org';
const DOOR_WORDS = 'To go, ask to join Mullumbimby Commons';
const HOME_ID = '5b0d5a3e-5d6c-4f0a-9a57-111111111111';

async function main() {
    console.log('A member\'s copy of an event on the global community...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { writeDirectoryRows, normaliseRegistryRow } = await import('./engine/directory-cache.js');
    const { EVENT_COPY_CODE } = await import('./engine/event-copy.js');

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
    const robin = member('RobinHost');
    const sam = member('SamReader');

    const row = (url: string, name: string, extra: Record<string, unknown> = {}) => normaliseRegistryRow({
        node_id: url, shown_name: name, node_url: url, last_seen_at: new Date().toISOString(), accepting_knocks: true, ...extra,
    })!;
    writeDirectoryRows([row(`https://${HOST}`, 'Mullumbimby Commons'), row('https://byinvite.example.org', 'Quiet Valley', { accepting_knocks: false }),
        row('https://stale.example.org', 'Long Gone', { last_seen_at: new Date(Date.now() - 8 * 24 * HOUR).toISOString() })], new Date().toISOString());

    const postCopy = (who: Id, title: string, extra: Record<string, unknown> = {}) => call('POST', '/api/marketplace/posts', who, {
        id: crypto.randomUUID(), type: 'event', category: 'community', title, description: 'Bring a plate', authorPublicKey: who.pubKeyHex,
        ...EXACT, eventStartAt: inHours(48), eventEndAt: inHours(50), photos: TEST_PHOTOS,
        // Sent here to prove they don't land. The phone sends none of them.
        eventPlaceName: PLACE, eventPrivateNote: NOTE, communityName: 'A name the phone made up',
        shownFrom: { host: HOST, postId: HOME_ID, name: 'A name the phone made up' },
        ...extra,
    });
    const stored = (id: string) => db.prepare('SELECT lat, lng, event_place_name, event_private_note, shown_from_host, shown_from_post_id, author_pubkey, updated_at FROM posts WHERE id = ?').get(id) as any;
    const byId = async (id: string, who: Id | null) => (await call('GET', `/api/marketplace/posts?id=${id}`, who)).body?.[0];

    // A member near the copy, on the socket a new listing goes out on, and one on the socket of its author.
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
    const made = await postCopy(robin, 'Mullum street party');
    const copyId: string = made.body?.post?.id;
    assert(made.status === 200 && !!copyId, `a copy is made by its member's key (${made.status} ${JSON.stringify(made.body).slice(0, 140)})`);
    const kept = stored(copyId);
    assert(kept?.shown_from_host === HOST && kept?.shown_from_post_id === HOME_ID, 'it keeps the host of a shown row and the event\'s id there');
    assert(kept?.lat === ROUNDED.lat && kept?.lng === ROUNDED.lng, `the point stored is the rounded home point, whatever was sent (${kept?.lat}, ${kept?.lng})`);
    assert(kept?.event_place_name === null && kept?.event_private_note === null, 'a place name and a note sent anyway are not stored');
    assert(made.body?.post?.shownCopy === true, 'its author\'s answer says it is a copy: how the phone knows the node took it as one');

    // ── 2. The reads ──
    console.log('\n── 2. The reads ──');
    const leaks = (json: string, who: string) => {
        for (const [what, needle] of [['the key', robin.pubKeyHex], ['the name', 'RobinHost'], ['the typed place', PLACE], ['the note', NOTE],
            ['the exact pin', '153.52219'], ['the phone\'s words', 'A name the phone made up'], ['a face', '/api/avatar/']] as const) {
            assert(!json.includes(needle), `${who}: no ${what}`);
        }
    };
    for (const [who, id] of [['a visitor', null], ['a member', sam]] as const) {
        const one = await byId(copyId, id);
        assert(one?.title === 'Mull'.concat('um street party'), `${who} reads the copy by id`);
        leaks(JSON.stringify(one), `${who}, by id`);
        assert(one?.authorPublicKey === 'hidden' && one?.authorCallsign === '', `${who}: the neutral author`);
        assert(one?.lat === ROUNDED.lat && one?.lng === ROUNDED.lng && one?.eventStartAt && one?.eventEndAt, `${who}: the rounded point and the times`);
        assert(one?.shownCopy === true && one?.shownFrom?.name === 'Mullumbimby Commons' && one?.shownFrom?.door === 'ask'
            && one?.shownFrom?.url === `https://${HOST}` && one?.shownFrom?.postId === HOME_ID, `${who}: the from-line and the door are the directory row's`);
        assert(!('shownFromHost' in one) && !('shownFromPostId' in one), `${who}: never the stored columns`);
        const list = await call('GET', '/api/marketplace/posts?types=offer,need,poll,event&limit=100', id);
        leaks(JSON.stringify(list.body), `${who}, the board`);
        const near = await call('GET', `/api/marketplace/posts?type=event&lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&radiusKm=50`, id);
        leaks(JSON.stringify(near.body), `${who}, by distance`);
        assert(Array.isArray(near.body) && near.body.some((p: any) => p.id === copyId), `${who} finds it from a point`);
    }
    await new Promise((r) => setTimeout(r, 200));
    const onSocket = samSocket.raw.join('\n');
    assert(onSocket.includes(copyId), `a member near it hears that it changed (${samSocket.raw.length} frames)`);
    leaks(onSocket, 'a member, the socket');
    assert(!onSocket.includes('Mull'.concat('um street party')), 'the socket carries the id, and no copy of the listing');
    samSocket.ws.close();
    const own = await byId(copyId, robin);
    assert(own?.authorPublicKey === robin.pubKeyHex && own?.shownCopy === true && own?.shownFrom?.name === 'Mullumbimby Commons', 'its author reads it as theirs, to tend it');
    const home = await call('GET', `/api/global/home?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}`, sam);
    leaks(JSON.stringify(home.body), 'a member, the landing card');
    const hom2 = await call('GET', '/api/home', sam);
    leaks(JSON.stringify(hom2.body), 'a member, Home');
    for (const [who, id] of [['a visitor', null], ['a member', sam]] as const) {
        const onHome = (await call('GET', '/api/home', id)).body?.cards?.events?.items?.find((i: any) => i.id === copyId);
        assert(onHome?.shownCopy === true && onHome?.shownFrom?.name === 'Mullumbimby Commons' && onHome?.place === null, `${who}, Home: says it is a copy and where from, so no app promises a place (${JSON.stringify(onHome)?.slice(0, 160)})`);
    }
    const invite = await postCopy(robin, 'Valley picnic', { shownFrom: { host: 'byinvite.example.org', postId: HOME_ID } });
    assert((await byId(invite.body?.post?.id, sam))?.shownFrom?.door === 'invite', 'a community that takes no requests: the door says by invite');

    // ── 3. The unlisted host ──
    console.log('\n── 3. The unlisted host ──');
    for (const [what, host] of [['a host in no row', 'hidden-valley.example.org'], ['a row not pushed for 8 days', 'stale.example.org']] as const) {
        const bare = await postCopy(robin, `From ${what}`, { shownFrom: { host, postId: HOME_ID } });
        const id: string = bare.body?.post?.id;
        const r = stored(id);
        assert(bare.status === 200 && r?.shown_from_host === '' && r?.shown_from_post_id === null, `${what}: dropped at write, nothing of it kept`);
        assert(!JSON.stringify(db.prepare('SELECT * FROM posts WHERE id = ?').get(id)).includes(host), `${what}: the host is nowhere in the row`);
        assert(bare.body?.post?.shownCopy === true && !bare.body?.post?.shownFrom, `${what}: the answer has no from-line, so the phone can say so once`);
        const read = await byId(id, sam);
        assert(read?.authorPublicKey === 'hidden' && read?.shownCopy === true && !read?.shownFrom, `${what}: still a copy, with no author, no line and no door`);
        const refused = await call('POST', `/api/marketplace/posts/${id}/rsvp`, sam, { status: 'going' });
        assert(refused.status === 409 && refused.body?.code === EVENT_COPY_CODE && typeof refused.body?.error === 'string', `${what}: no RSVP (${refused.status})`);
        assert(!String(refused.body?.error).includes('{'), `${what}: the refusal is a sentence`);
    }

    // ── 4. The row that goes ──
    console.log('\n── 4. The row that goes ──');
    const shown = await call('GET', `/api/marketplace/posts?id=${copyId}`, null);
    writeDirectoryRows([row('https://byinvite.example.org', 'Quiet Valley', { accepting_knocks: false })], new Date().toISOString());
    const gone = await call('GET', `/api/marketplace/posts?id=${copyId}`, null, undefined, shown.etag ? { 'If-None-Match': shown.etag } : {});
    assert(gone.status === 200, `the ETag of the body with the line is not confirmed (${gone.status})`);
    assert(gone.body?.[0]?.shownCopy === true && !gone.body?.[0]?.shownFrom, 'the line and the door go with the row; the copy stays a copy');
    const noDoor = await call('POST', `/api/marketplace/posts/${copyId}/rsvp`, sam, { status: 'going' });
    assert(noDoor.status === 409 && !String(noDoor.body?.error).includes('Mullumbimby'), 'the refusal names no community that has gone');
    assert(stored(copyId)?.shown_from_host === HOST, 'the copy\'s own words are untouched');
    writeDirectoryRows([row(`https://${HOST}`, 'Mullumbimby Commons'), row('https://byinvite.example.org', 'Quiet Valley', { accepting_knocks: false })], new Date().toISOString());
    assert((await byId(copyId, sam))?.shownFrom?.name === 'Mullumbimby Commons', 'and it comes back with the row');

    // ── 5. No RSVP, no chat, nobody named ──
    console.log('\n── 5. No RSVP, no chat, nobody named ──');
    for (const status of ['going', 'interested', null]) {
        const r = await call('POST', `/api/marketplace/posts/${copyId}/rsvp`, sam, { status });
        assert(r.status === 409 && r.body?.error === DOOR_WORDS && r.body?.code === EVENT_COPY_CODE, `RSVP ${status}: 409 with the door's words (${r.status} ${r.body?.error})`);
    }
    const enEspanol = await call('POST', `/api/marketplace/posts/${copyId}/rsvp`, sam, { status: 'going' }, { 'X-Language': 'es' });
    assert(enEspanol.status === 409 && enEspanol.body?.error === 'Para ir, pide unirte a Mullumbimby Commons', `in Spanish, with the community's own name (${enEspanol.body?.error})`);
    const byHost = await call('POST', `/api/marketplace/posts/${copyId}/rsvp`, robin, { status: 'going' });
    assert(byHost.status === 409, 'its author takes no RSVP on it either');
    assert(!db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ?').get(copyId), 'no RSVP row');
    assert(!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(copyId), 'no chat was made');
    for (const who of [sam, robin]) {
        const c = await call('GET', `/api/marketplace/posts/${copyId}/chat`, who);
        assert(c.status === 404, `no chat opens for anyone (${c.status})`);
        const s = await call('POST', `/api/marketplace/posts/${copyId}/chat/message`, who, { text: 'hello' });
        assert(s.status === 404, `no line can be written (${s.status})`);
    }
    assert(!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(copyId), 'and none was made by asking');
    const feed = await call('GET', '/api/activity/feed', sam);
    assert(!JSON.stringify(feed.body ?? '').includes('Mullum street party'), 'the activity feed names no copy');
    const theirs = await call('GET', `/api/marketplace/posts?author=${robin.pubKeyHex}&types=event`, sam);
    assert(Array.isArray(theirs.body) && !theirs.body.some((p: any) => p.id === copyId), 'one member\'s listings, read by another, leave it out');
    const mine = await call('GET', `/api/marketplace/posts?author=${robin.pubKeyHex}&types=event`, robin);
    assert(Array.isArray(mine.body) && mine.body.some((p: any) => p.id === copyId), 'and their own holds it, to tend it');
    const report = await call('POST', '/api/reports', sam, { reporterPubkey: sam.pubKeyHex, targetPubkey: 'hidden', reason: 'spam', targetPostId: copyId });
    assert(report.status === 200 && report.body?.report?.targetPubkey === 'hidden', `a report goes, and tells the reporter no author (${report.status} ${JSON.stringify(report.body).slice(0, 120)})`);
    leaks(JSON.stringify(report.body), 'the reporter\'s answer');
    assert((db.prepare('SELECT target_pubkey AS t FROM abuse_reports WHERE target_post_id = ?').get(copyId) as any)?.t === robin.pubKeyHex, 'the moderators have the author');
    const again = await call('POST', '/api/reports', sam, { reporterPubkey: sam.pubKeyHex, targetPubkey: 'hidden', reason: 'spam', targetPostId: copyId });
    assert(again.body?.duplicate === true && again.body?.report?.targetPubkey === 'hidden', 'nor does the same report sent again');

    // ── 6. The kinds ──
    console.log('\n── 6. The kinds ──');
    const online = await postCopy(robin, 'A call', { eventOnline: true, eventLink: 'https://example.org/call', eventTz: 'Australia/Sydney', lat: undefined, lng: undefined });
    assert(online.status === 400 && !db.prepare("SELECT 1 FROM posts WHERE title = 'A call'").get(), `an online event is refused, not made in the open (${online.status})`);
    const offer = await postCopy(robin, 'An offer', { type: 'offer', category: 'food', credits: 0 });
    assert(offer.status === 400 && !db.prepare("SELECT 1 FROM posts WHERE title = 'An offer'").get(), `an Offer is not this slice: refused (${offer.status})`);
    const plain = await postCopy(robin, 'A plain event', { shownFrom: undefined });
    assert(plain.status === 200 && stored(plain.body?.post?.id)?.shown_from_host === null, 'an event with no shownFrom is no copy');
    assert((await byId(plain.body?.post?.id, sam))?.authorPublicKey === robin.pubKeyHex && !!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(plain.body?.post?.id), 'it reads and chats as it always did');
    assert(!('shownCopy' in (await byId(plain.body?.post?.id, sam))), 'and carries none of this');

    // ── 7. An edit and a cancel ──
    console.log('\n── 7. An edit and a cancel ──');
    const later = inHours(72);
    const edit = await call('POST', '/api/marketplace/posts/update', robin, {
        id: copyId, authorPublicKey: robin.pubKeyHex, eventStartAt: later, eventEndAt: inHours(74), title: 'Mullum street party, moved',
        lat: -28.91234, lng: 153.11111, eventPlaceName: PLACE, eventPrivateNote: NOTE, eventOnline: true,
    });
    const after = stored(copyId);
    assert(edit.status === 200 && after?.lat === -28.9 && after?.lng === 153.1, `an edit moves the rounded pin (${edit.status} ${after?.lat})`);
    assert(after?.event_place_name === null && after?.event_private_note === null, 'an edit adds no place name and no note');
    const moved = await byId(copyId, sam);
    assert(moved?.eventStartAt === later && moved?.title === 'Mullum street party, moved' && moved?.eventOnline === false, 'the new time reads, and it stays at a place');
    const stranger = await call('POST', '/api/marketplace/posts/update', sam, { id: copyId, authorPublicKey: sam.pubKeyHex, title: 'Mine now' });
    assert(stranger.status === 404 && stored(copyId)?.author_pubkey === robin.pubKeyHex, `nobody else edits it (${stranger.status})`);
    const removed = await call('POST', '/api/marketplace/posts/remove', robin, { id: copyId, authorPublicKey: robin.pubKeyHex });
    assert(removed.status === 200 && removed.body?.success === true, 'its author takes it down');
    const board = await call('GET', '/api/marketplace/posts?type=event&limit=100', sam);
    assert(!board.body.some((p: any) => p.id === copyId), 'and it is off the board');

    // ── 8. Probation and retention ──
    console.log('\n── 8. Probation and retention ──');
    setSwitch('probation', null);
    const newcomer = member('Newcomer', new Date(Date.now() - HOUR).toISOString());
    const answers: number[] = [];
    for (let i = 0; i < 5; i++) answers.push((await postCopy(newcomer, `Copy ${i}`)).status);
    assert(answers.includes(429) && answers[0] === 200, `probation counts a copy as any post (${answers.join(' ')})`);
    setSwitch('probation', 'false');
    const old = await postCopy(robin, 'A forgotten copy');
    const oldId: string = old.body?.post?.id;
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', oldId);
    const plainOld = plain.body?.post?.id;
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', plainOld);
    se.archiveStaleListings();
    const archived = db.prepare('SELECT active, status FROM posts WHERE id = ?').get(oldId) as any;
    assert(archived?.active === 0 && archived?.status === 'cancelled', 'retention archives a copy nobody tends any more');
    assert((db.prepare('SELECT active FROM posts WHERE id = ?').get(plainOld) as any)?.active === 1, 'and leaves a plain event as it did');

    // ── 9. A local community ──
    console.log('\n── 9. A community with no directory ──');
    setSwitch('directoryMirror', 'false');
    const ignored = await postCopy(robin, 'On a local community', { eventHostLetsIn: true });
    assert(ignored.status === 200 && stored(ignored.body?.post?.id)?.shown_from_host === null && !ignored.body?.post?.shownCopy,
        'where no directory is kept the field is ignored, and the answer says so by what it lacks');
    assert(stored(ignored.body?.post?.id)?.event_place_name === PLACE, 'and the post is an ordinary one');
    setSwitch('directoryMirror', null);

    // ── 10. No read goes by who wrote it ──
    // A copy shows no author, so a read that changed with its author's row would say whose it is. Each rule is tested on an
    // author who has a copy and an ordinary listing: the listing is the control, proving the rule ran, and the copy of an
    // author it wasn't aimed at is the other, so "reads the same" can't pass on two reads that both lost it.
    console.log('\n── 9b. A copy hidden by reports names nobody ──');
    {
        const author = member('HiddenCopyAuthor');
        const reader = member('SyncReader');
        const hideNow = (id: string) => db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        const when = { eventStartAt: inHours(30), eventEndAt: inHours(32) };
        const copy: string = (await postCopy(author, 'Hidden copy of a market', when)).body?.post?.id;
        const plain: string = (await postCopy(author, 'Hidden ordinary market', { ...when, shownFrom: undefined })).body?.post?.id;
        hideNow(copy); hideNow(plain);
        const cursor = new Date(Date.now() - 86_400_000).toISOString();
        for (const [name, path] of [
            ['a sync', '/api/marketplace/posts?sync=true&types=event&limit=200'],
            ['a delta', `/api/marketplace/posts?sync=true&types=event&limit=200&updatedAfter=${encodeURIComponent(cursor)}`],
        ] as const) {
            const body = (await call('GET', path, reader)).body;
            const list: any[] = Array.isArray(body) ? body : body?.posts ?? [];
            const seenCopy = list.find((p) => p.id === copy);
            const seenPlain = list.find((p) => p.id === plain);
            assert(seenCopy?.authorPublicKey === 'hidden' && seenCopy?.authorCallsign === '', `${name}: a hidden copy names nobody (got ${JSON.stringify([seenCopy?.authorPublicKey, seenCopy?.authorCallsign])})`);
            assert(!JSON.stringify(list).includes(author.pubKeyHex) || seenPlain?.authorPublicKey === author.pubKeyHex, `${name}: the author's key is only on their own ordinary event`);
            assert(seenPlain?.authorPublicKey === author.pubKeyHex, `${name}: the control, a hidden ordinary event, keeps its author (got ${JSON.stringify(seenPlain?.authorPublicKey)})`);
        }
    }

    console.log('\n── 10. No read goes by who wrote it ──');
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const rows = (body: any): any[] => Array.isArray(body) ? body : body?.posts ?? [];
    const writer = member('WriterOfCopies');
    const loner = member('AuthorOfOneCopy');
    const watcher = member('WatchingReader');
    setMemberArea(watcher.pubKeyHex, ROUNDED);
    const soon = { eventStartAt: inHours(20), eventEndAt: inHours(22), freeTags: ['lanternwalk'] };
    const copyA: string = (await postCopy(writer, 'Lantern walk by the river', soon)).body?.post?.id;
    const copyB: string = (await postCopy(loner, 'Lantern walk by the sea', soon)).body?.post?.id;
    const plainA: string = (await postCopy(writer, 'Lantern walk of their own', { ...soon, shownFrom: undefined })).body?.post?.id;
    assert(!!copyA && !!copyB && !!plainA && stored(plainA)?.shown_from_host === null, 'two copies, and one ordinary listing by the first copy\'s author');
    const READS: Array<[string, string]> = [
        ['search', '/api/marketplace/posts?q=lantern&types=event&limit=100'],
        ['a typed tag', '/api/marketplace/posts?free=lanternwalk&types=event&limit=100'],
        ['the board', '/api/marketplace/posts?type=event&limit=100'],
        ['from a point', `/api/marketplace/posts?type=event&lat=${ROUNDED.lat}&lng=${ROUNDED.lng}&radiusKm=50`],
        ['a sync', '/api/marketplace/posts?sync=true&types=event&limit=200'],
        ['the member\'s set', '/api/marketplace/posts?nearby=1&sync=true&types=event'],
        ['Home', '/api/home'],
    ];
    /** What each read gives of these three, as JSON, 'null' where it left one out. */
    const sample = async (who: Id | null) => {
        const seen: Record<string, Record<string, string>> = {};
        for (const [name, path] of READS) {
            const body = (await call('GET', path, who)).body;
            const list: any[] = name === 'Home' ? body?.cards?.events?.items ?? [] : rows(body);
            seen[name] = Object.fromEntries([copyA, copyB, plainA].map(id => [id, JSON.stringify(list.find(p => p.id === id) ?? null)]));
        }
        seen['by id'] = Object.fromEntries(await Promise.all([copyA, copyB].map(async id => [id, JSON.stringify((await byId(id, who)) ?? null)])));
        return seen;
    };
    /** Each read holds `id`, and gives what it gave before. */
    const readsAsItDid = (before: Awaited<ReturnType<typeof sample>>, after: Awaited<ReturnType<typeof sample>>, id: string, what: string) => {
        for (const read of Object.keys(before)) {
            assert(before[read][id] !== 'null' && after[read][id] === before[read][id], `${what}, ${read}: reads as it did${after[read][id] === before[read][id] ? '' : ` (${after[read][id].slice(0, 100)})`}`);
        }
    };
    /** Two copies alike but for who wrote them, and their own words and times. */
    const bare = (json: string) => {
        const { id: _id, title: _title, createdAt: _made, updatedAt: _moved, photos: _photos, ...rest } = JSON.parse(json) ?? {};
        return JSON.stringify(rest);
    };
    const setPath = (cursor: string) => `/api/marketplace/posts?nearby=1&sync=true&types=event&updatedAfter=${encodeURIComponent(cursor)}`;
    const deltaPath = (cursor: string) => `/api/marketplace/posts?sync=true&types=event&limit=200&updatedAfter=${encodeURIComponent(cursor)}`;
    const blockList = (path: string, key: string) => call('POST', path, watcher, { targetPubkey: key });

    // A block: the finding of the review of #2711, with its control. Blocking half the suspects found the author among 8 in 3 rounds.
    const unblocked = await sample(watcher);
    for (const read of ['search', 'the member\'s set']) assert(unblocked[read][plainA] !== 'null', `no block yet, ${read}: the author's ordinary listing is there`);
    assert((await blockList('/api/blocks', robin.pubKeyHex)).status === 200, 'blocking a key that wrote neither');
    const blockedAnother = await sample(watcher);
    readsAsItDid(unblocked, blockedAnother, copyA, 'a block on another key');
    assert((await blockList('/api/blocks', writer.pubKeyHex)).status === 200, 'blocking the copy\'s author');
    const blockedWriter = await sample(watcher);
    assert(blockedWriter.search[plainA] === 'null' && blockedWriter['the member\'s set'][plainA] === 'null', 'control: the block took: their ordinary listing left the search and the set');
    readsAsItDid(unblocked, blockedWriter, copyA, 'a block on the author: their copy');
    readsAsItDid(unblocked, blockedWriter, copyB, 'a block on the author: another\'s copy');
    for (const read of Object.keys(blockedWriter)) assert(bare(blockedWriter[read][copyA]) === bare(blockedWriter[read][copyB]), `${read}: a blocked author's copy reads the same as an unblocked one's`);
    const setTag = (await call('GET', setPath(new Date().toISOString()), watcher)).etag!;
    assert((await blockList('/api/blocks', loner.pubKeyHex)).status === 200, 'blocking the other copy\'s author');
    const quietSet = await call('GET', setPath(new Date().toISOString()), watcher, undefined, { 'If-None-Match': setTag });
    assert(quietSet.status === 304, `the set's tag doesn't move for a block on a copy's author (${quietSet.status})`);
    await blockList('/api/blocks/remove', loner.pubKeyHex);
    await blockList('/api/blocks/remove', writer.pubKeyHex);
    await blockList('/api/blocks/remove', robin.pubKeyHex);
    assert((await sample(watcher)).search[plainA] === unblocked.search[plainA], 'control: unblocked, their ordinary listing is back');

    // The socket, with the same control. A member near a listing hears its events unless they blocked its author (state-engine.ts
    // listingReach): three spare accounts blocking halves of 8 suspects named a copy's author from one edit, in the review of #2711.
    // Each way a copy rings goes through that rule: made, edited, rolled on by the minute tick, and taken down.
    const { rollDueSeries } = await import('./engine/event-series-roll.js');
    const listener = await socketOf(watcher);
    const retitle = (who: Id, id: string, title: string) => call('POST', '/api/marketplace/posts/update', who, { id, authorPublicKey: who.pubKeyHex, title });
    const WEEKLY = {
        eventStartAt: undefined, eventEndAt: undefined, eventStartLocal: '2027-10-01T20:50', eventEndLocal: '2027-10-01T22:50',
        eventTz: 'Australia/Sydney', eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
    };
    let round = 0;
    /** One copy and one ordinary event of the writer's, through all four: what the socket heard of each. */
    const ring = async () => {
        round++;
        const from = listener.raw.length;
        const [copy, plain] = [crypto.randomUUID(), crypto.randomUUID()];
        const made = [await postCopy(writer, `Bell ${round}`, { ...WEEKLY, id: copy }), await postCopy(writer, `Bell ${round}`, { ...WEEKLY, id: plain, shownFrom: undefined })];
        assert(made.every(m => m.status === 200) && stored(copy)?.shown_from_host === HOST && stored(plain)?.shown_from_host === null, `round ${round}: a repeating copy and an ordinary one (${made.map(m => m.status)})`);
        await retitle(writer, copy, `Bell ${round}, moved`);
        await retitle(writer, plain, `Bell ${round}, moved`);
        const dueAt = (db.prepare('SELECT event_end_at FROM posts WHERE id = ?').get(copy) as { event_end_at: string }).event_end_at;
        assert(rollDueSeries(se.broadcast, Date.parse(dueAt) + 1000) >= 2, `round ${round}: the minute tick rolled both on`);
        await call('POST', '/api/marketplace/posts/remove', writer, { id: copy, authorPublicKey: writer.pubKeyHex });
        await call('POST', '/api/marketplace/posts/remove', writer, { id: plain, authorPublicKey: writer.pubKeyHex });
        // A socket's frames keep their order, so a frame from an author this reader never blocks says the ones before it have landed.
        await retitle(loner, copyB, `Lantern walk by the sea, round ${round}`);
        for (let i = 0; i < 500 && !listener.raw.slice(from).some(f => f.includes(copyB)); i++) await tick();
        const frames = listener.raw.slice(from);
        const about = (id: string) => frames.filter(f => f.includes(id));
        return { copy: about(copy).map(f => f.replaceAll(copy, 'ID')).join(' '), plain: about(plain).map(f => JSON.parse(f).type).join(' ') };
    };
    const openFrames = await ring();
    const asId = (type: string) => JSON.stringify({ type, id: 'ID' });
    assert(openFrames.copy === [asId('post_updated'), asId('post_updated'), asId('post_updated')].join(' ').concat(' ', JSON.stringify({ type: 'post_removed', id: 'ID', audienceScope: 'public' })),
        `no block: all four ring for a copy, each with its id and nothing else (${openFrames.copy})`);
    assert(openFrames.plain === 'new_post post_updated post_updated post_removed', `no block, control: and for an ordinary event (${openFrames.plain})`);
    await blockList('/api/blocks', robin.pubKeyHex);
    const otherBlocked = await ring();
    assert(otherBlocked.copy === openFrames.copy && otherBlocked.plain === openFrames.plain, `a block on another key: both as they were (${otherBlocked.plain})`);
    await blockList('/api/blocks', writer.pubKeyHex);
    const authorBlocked = await ring();
    assert(authorBlocked.plain === '', `a block on the author, control: nothing more of their ordinary event (${authorBlocked.plain})`);
    assert(authorBlocked.copy === openFrames.copy, `a block on the author: the frames of their copy are unchanged (${authorBlocked.copy})`);
    await blockList('/api/blocks/remove', writer.pubKeyHex);
    await blockList('/api/blocks/remove', robin.pubKeyHex);
    assert((await ring()).plain === openFrames.plain, 'control: unblocked, the ordinary event rings again');
    listener.ws.close();

    // The board's rule, which an author's row sets: their listings go and come back with it, at one moment, for everyone.
    const standings: Array<[string, () => void, () => void]> = [
        ['a holiday', () => { se.setHolidayMode(writer.pubKeyHex, true); }, () => { se.setHolidayMode(writer.pubKeyHex, false); }],
        ['a paused account', () => se.setUserStatusRow(writer.pubKeyHex, 'disabled'), () => se.setUserStatusRow(writer.pubKeyHex, 'active')],
    ];
    for (const [what, begin, end] of standings) {
        const before = await sample(watcher);
        const beforeVisitor = await sample(null);
        await tick();
        const cursor = new Date().toISOString();
        await tick();
        begin();
        const during = await sample(watcher);
        assert(during['the board'][plainA] === 'null' && during['the member\'s set'][plainA] === 'null' && during.Home[plainA] === 'null', `${what}, control: the ordinary listing left the board, the set and Home`);
        assert(JSON.parse(during['a sync'][plainA])?.status === 'paused', `${what}, control: a sync gives it as paused`);
        readsAsItDid(before, during, copyA, `${what}: a member`);
        readsAsItDid(beforeVisitor, await sample(null), copyA, `${what}: a visitor`);
        const delta = rows((await call('GET', deltaPath(cursor), watcher)).body);
        assert(delta.some(p => p.id === plainA), `${what}, control: a delta sends the ordinary listing again`);
        assert(!delta.some(p => p.id === copyA), `${what}: and not the copy, which would tie the two together`);
        await tick();
        const afterRead = new Date().toISOString();
        await tick();
        await byId(plainA, watcher);
        await byId(copyA, watcher);
        const resent = rows((await call('GET', deltaPath(afterRead), watcher)).body);
        assert(resent.some(p => p.id === plainA && p.resentAt), `${what}, control: an off-board event read by id is sent again`);
        assert(!resent.some(p => p.id === copyA), `${what}: a copy read by id is not`);
        end();
        assert((await sample(watcher))['the board'][plainA] !== 'null', `${what}, control: over, the ordinary listing is back`);
    }

    // A new name or face: a delta sends a listing's row again for it, and the set's tag moves. Neither for a copy.
    await tick();
    const cardCursor = new Date().toISOString();
    await tick();
    const newCard = (who: Id, name: string) => db.prepare(`UPDATE members SET callsign = ?, profile_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(name, who.pubKeyHex);
    const cardTag = (await call('GET', setPath(cardCursor), watcher)).etag!;
    newCard(loner, 'AuthorRenamed');
    const copyOnly = await call('GET', setPath(cardCursor), watcher, undefined, { 'If-None-Match': cardTag });
    assert(copyOnly.status === 304, `a new name on a copy's author moves nothing in the reader's set (${copyOnly.status})`);
    newCard(writer, 'WriterRenamed');
    const named = await call('GET', setPath(cardCursor), watcher, undefined, { 'If-None-Match': cardTag });
    assert(named.status === 200 && rows(named.body).some(p => p.id === plainA), `control: a new name on a listing's author moves the tag and sends the listing (${named.status})`);
    assert(!rows(named.body).some(p => p.id === copyA), 'and leaves their copy out of the delta');

    // A count: Home's "events soon", where a node shows it (guestListingsOnly off). A count that fell by the copy too would say the same.
    setSwitch('guestListingsOnly', 'false');
    const eventsSoon = async () => (await call('GET', '/api/home?cards=community', watcher)).body?.cards?.community?.eventsSoon as number;
    const countBefore = await eventsSoon();
    se.setHolidayMode(writer.pubKeyHex, true);
    const countDuring = await eventsSoon();
    se.setHolidayMode(writer.pubKeyHex, false);
    assert(typeof countBefore === 'number' && countDuring === countBefore - 1, `the events-soon count loses the ordinary listing and not the copy (${countBefore} → ${countDuring})`);
    setSwitch('guestListingsOnly', null);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
