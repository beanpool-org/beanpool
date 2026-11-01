/**
 * Test Suite: a member's copy of an in-person event on the global community (DESIGN-list-on-global-fable.md §3, §7, §11;
 * DESIGN-reaching-across-fable.md §3; slice G2′; engine/event-copy.ts). Boots the real server on the global profile and
 * goes through the real middleware over HTTPS, signed:
 *
 *   1. the write: the copy keeps its community's host for a shown row; a place name, a note and an exact pin sent anyway
 *      are not stored; the point is the rounded home point
 *   2. the reads, a visitor's and a member's: no key, name, face, exact place, typed place or note, on every read shape;
 *      the from-line and the door are the row's words, never what the phone said; only its author reads an author
 *   3. the unlisted host: dropped at write, the answer says so by what it lacks, and the copy is still a copy
 *   4. the row that goes: the line and the door go with it at the next read, and no ETag confirms the old body
 *   5. no RSVP: 409 with the door's words; no chat is made or opened; the activity feed names nobody; a member's own list
 *      read by another leaves it out; a report reaches the moderators with the author and tells the reporter none
 *   6. the kinds: an online or group event is refused, not made in the open; a plain event is as before
 *   7. an edit keeps to the times and the rounded pin; a cancel takes it off the board
 *   8. probation and retention count the copy
 *   9. a local community ignores the field
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-event-copy)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
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
    const own = await byId(copyId, robin);
    assert(own?.authorPublicKey === robin.pubKeyHex && own?.shownCopy === true && own?.shownFrom?.name === 'Mullumbimby Commons', 'its author reads it as theirs, to tend it');
    const home = await call('GET', `/api/global/home?lat=${ROUNDED.lat}&lng=${ROUNDED.lng}`, sam);
    leaks(JSON.stringify(home.body), 'a member, the landing card');
    const hom2 = await call('GET', '/api/home', sam);
    leaks(JSON.stringify(hom2.body), 'a member, Home');
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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
