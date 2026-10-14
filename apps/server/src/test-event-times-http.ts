/**
 * Event times, slice 1 (scratch/global-node/DESIGN-event-times-fable.md §2, §6, §9, §10 and Director amendment 1), over
 * REAL HTTP — through the signature middleware — wherever a route exists, and on the engine for the sweep, the copy and
 * the scrub, which no route drives.
 *
 * Verifies:
 *  1. A clock + zone body stores the instant the node resolved: Sydney 20:50 → 09:50Z, with the clock and zone kept.
 *  2. An old client's instant-only body gets its clock read off the instant in the PIN's zone (pin → Africa/Lagos).
 *  3. A zone the node does not know is refused in the form's words; a malformed clock is refused.
 *  4. GET /api/events/zone: the pin's zone, its words and offset; GET /api/events/zones: the picker list, ETag 304.
 *  5. Online: accepted with no pin (lat/lng NULL, no place name); the join link is http(s) only; the link reaches the
 *     host and Going and NOT Interested, a visitor's view (GUEST_FIELDS) or a broadcast; an online event with no zone
 *     falls back to UTC.
 *  6. Edit: a new zone with the clock kept moves the instant and marks UPDATED; moving the pin with no zone sent takes
 *     the new pin's zone; switching to in person clears the link.
 *  7. A copy carries the clock, zone, online and link, and an import restores them (REPLICA_FORMAT 10).
 *  8. The reminder push names the place's clock for an in-person event ("Starts in 1 day · Sat 20:50 Lagos time") and
 *     stays relative for an online one.
 *  9. The scrub that clears the note clears the link.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-event-times-http.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState, importRemoteState, setNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { rsvpEvent } from './engine/posts.js';
import { runEventReminderSweep } from './engine/event-reminders.js';
import { scrubPostsOf } from './engine/post-scrub.js';
import { setMemberPhoto, guestPost, publicBroadcastPost } from '@beanpool/engine';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const ACCRA = { lat: 5.6037, lng: -0.187 };

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

/** The replay-proof scheme the real middleware requires: method + path (no query) + timestamp + nonce + body. */
async function signed(method: 'GET' | 'POST', path: string, body: unknown, id: Id, extra: Record<string, string> = {}) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts), 'X-Nonce': nonce, ...extra,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined, etag: res.headers.get('etag') };
}

const row = (id: string) => db.prepare(`SELECT lat, lng, event_start_at, event_end_at, event_start_local, event_end_local, event_tz,
    event_online, event_link, event_place_name, event_private_note, event_state FROM posts WHERE id = ?`).get(id) as any;

/** One event read by id, as `who` reads it over HTTP. */
async function readEvent(id: string, who: Id): Promise<any> {
    const r = await signed('GET', `/api/marketplace/posts?id=${id}&types=offer,need,poll,event`, null, who);
    const b = r.body;
    return Array.isArray(b) ? b[0] : (b?.posts?.[0] ?? b?.post ?? b);
}

async function main(): Promise<void> {
    console.log('\nEvent times over real HTTP\n');
    await initTls();
    initStateEngine();
    // The copy in section 7 is signed by this node's own key, read from a peer the node knows, as test-events.ts does it.
    const p2pNode = await startP2P(0, 0);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`, 'mirror', 'self-test-peer');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const host = makeIdentity('HostHana');
    const online = makeIdentity('OnlineOli');
    const goer = makeIdentity('GoingGus');
    const maybe = makeIdentity('MaybeMai');
    const create = (who: Id, body: Record<string, unknown>) => signed('POST', '/api/marketplace/posts', {
        type: 'event', title: 'Working bee', description: 'Bring gloves', authorPublicKey: who.pubKeyHex, ...body,
    }, who);

    // ── 1. Clock + zone ──────────────────────────────────────────────────────────────────────
    console.log('── 1. A clock and a zone ──');
    const syd = await create(host, { ...SYDNEY, eventStartLocal: '2027-01-15T20:50', eventTz: 'Australia/Sydney', eventPlaceName: 'The hall' });
    const sydId = syd.body?.post?.id ?? syd.body?.id;
    assert(syd.status === 200 && !!sydId, `a clock + zone event is accepted (got ${syd.status} ${syd.error ?? ''})`);
    const sydRow = sydId ? row(sydId) : {};
    assert(sydRow.event_start_at === '2027-01-15T09:50:00.000Z', `Sydney 20:50 (AEDT) is stored as 09:50Z (got ${sydRow.event_start_at})`);
    assert(sydRow.event_start_local === '2027-01-15T20:50' && sydRow.event_tz === 'Australia/Sydney',
        `the clock and zone are kept (got ${sydRow.event_start_local} ${sydRow.event_tz})`);
    assert(sydRow.event_end_at === '2027-01-15T11:50:00.000Z' && sydRow.event_end_local === '2027-01-15T22:50',
        `no end given: start + 2 hours, clock too (got ${sydRow.event_end_at} ${sydRow.event_end_local})`);
    assert(sydRow.event_online === 0 && sydRow.event_link === null, 'in person: not online, no link');

    // ── 2. An old client's instant ───────────────────────────────────────────────────────────
    console.log('\n── 2. An old client sends only the instant ──');
    const old = await create(host, { ...LAGOS, eventStartAt: '2027-01-16T19:50:00.000Z' });
    const oldId = old.body?.post?.id ?? old.body?.id;
    assert(old.status === 200 && !!oldId, `an instant-only body is still accepted (got ${old.status} ${old.error ?? ''})`);
    const oldRow = oldId ? row(oldId) : {};
    assert(oldRow.event_tz === 'Africa/Lagos', `the pin gives the zone: Africa/Lagos (got ${oldRow.event_tz})`);
    assert(oldRow.event_start_local === '2027-01-16T20:50' && oldRow.event_start_at === '2027-01-16T19:50:00.000Z',
        `the clock is read off the instant in that zone: 20:50 (got ${oldRow.event_start_local})`);

    // ── 3. Refusals ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Refusals ──');
    const mars = await create(host, { ...SYDNEY, eventStartLocal: '2027-01-15T20:50', eventTz: 'Mars/Olympus' });
    assert(mars.status === 400 && /Pick a time zone from the list/.test(mars.error ?? ''), `an unknown zone is refused in the form's words (got ${mars.status} ${mars.error})`);
    const badClock = await create(host, { ...SYDNEY, eventStartLocal: '15/01/2027 8:50pm', eventTz: 'Australia/Sydney' });
    assert(badClock.status === 400 && /Start time must be a valid date and time/.test(badClock.error ?? ''), `a malformed clock is refused (got ${badClock.status} ${badClock.error})`);
    const past = await create(host, { ...SYDNEY, eventStartLocal: '2020-01-15T20:50', eventTz: 'Australia/Sydney' });
    assert(past.status === 400 && /future/.test(past.error ?? ''), `a clock in the past is refused (got ${past.status} ${past.error})`);
    const noPin = await create(host, { eventStartLocal: '2027-01-15T20:50', eventTz: 'Australia/Sydney' });
    assert(noPin.status === 400 && /place on the map/.test(noPin.error ?? ''), `in person still needs a pin (got ${noPin.status} ${noPin.error})`);

    // ── 4. The zone routes ───────────────────────────────────────────────────────────────────
    console.log('\n── 4. /api/events/zone and /api/events/zones ──');
    const z = await signed('GET', `/api/events/zone?lat=${LAGOS.lat}&lng=${LAGOS.lng}`, null, host);
    assert(z.status === 200 && z.body?.tz === 'Africa/Lagos' && z.body?.label === 'Lagos time' && z.body?.offsetMinutes === 60,
        `a Lagos pin is Africa/Lagos, "Lagos time", +60 (got ${z.status} ${JSON.stringify(z.body)})`);
    const ocean = await signed('GET', '/api/events/zone?lat=0&lng=-30', null, host);
    assert(ocean.status === 200 && /^Etc\/GMT/.test(ocean.body?.tz ?? '') && /^UTC.* time$/.test(ocean.body?.label ?? ''),
        `a pin in the ocean reads as an offset (got ${JSON.stringify(ocean.body)})`);
    const badPoint = await signed('GET', '/api/events/zone?lat=abc&lng=3', null, host);
    assert(badPoint.status === 400, `a point that is not one is a 400 (got ${badPoint.status})`);
    const zones = await signed('GET', '/api/events/zones', null, host);
    const sydZone = (zones.body?.zones ?? []).find((x: any) => x.tz === 'Australia/Sydney');
    assert(zones.status === 200 && (zones.body?.zones?.length ?? 0) > 300 && sydZone?.label === 'Sydney time',
        `the picker list holds every zone the node accepts, labelled (got ${zones.body?.zones?.length})`);
    const again = await signed('GET', '/api/events/zones', null, host, { 'If-None-Match': zones.etag ?? '' });
    assert(!!zones.etag && again.status === 304, `the list is ETag-cached (got ${again.status}, etag ${zones.etag})`);
    const unsignedZones = await fetch(`${BASE}/api/events/zones`);
    assert(unsignedZones.status === 401 || unsignedZones.status === 403 || unsignedZones.status === 200,
        `an unsigned read is answered by the middleware's rule for member reads (got ${unsignedZones.status})`);

    // ── 5. Online ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Online events ──');
    const on = await create(online, {
        eventOnline: true, eventStartLocal: '2027-01-15T20:50', eventTz: 'Australia/Sydney',
        eventLink: '  https://meet.example/vibe  ', eventPlaceName: 'ignored', eventPrivateNote: 'Bring a mic',
    });
    const onId = on.body?.post?.id ?? on.body?.id;
    assert(on.status === 200 && !!onId, `an online event with no pin is accepted (got ${on.status} ${on.error ?? ''})`);
    const onRow = onId ? row(onId) : {};
    assert(onRow.lat === null && onRow.lng === null && onRow.event_online === 1 && onRow.event_place_name === null,
        'stored with no pin and no place name, marked online');
    assert(onRow.event_link === 'https://meet.example/vibe', `the link is stored trimmed (got ${onRow.event_link})`);
    const withPin = await create(online, { ...SYDNEY, eventOnline: true, eventStartLocal: '2027-01-22T20:50', eventTz: 'Australia/Sydney' });
    const withPinRow = withPin.body?.post?.id ? row(withPin.body.post.id) : {};
    assert(withPin.status === 200 && withPinRow.lat === null && withPinRow.lng === null, 'an online event sent with a pin keeps none');
    const js = await create(online, { eventOnline: true, eventStartLocal: '2027-01-29T20:50', eventTz: 'Australia/Sydney', eventLink: 'javascript:alert(1)' });
    assert(js.status === 400 && /https:\/\/ or http:\/\//.test(js.error ?? ''), `a link that is not http(s) is refused (got ${js.status} ${js.error})`);
    const long = await create(online, { eventOnline: true, eventStartLocal: '2027-01-29T20:50', eventTz: 'Australia/Sydney', eventLink: `https://x.example/${'a'.repeat(500)}` });
    assert(long.status === 400 && /500 characters/.test(long.error ?? ''), `a link over 500 characters is refused (got ${long.status})`);
    const noZone = await create(online, { eventOnline: true, eventStartAt: '2027-02-05T09:50:00.000Z' });
    const noZoneRow = noZone.body?.post?.id ? row(noZone.body.post.id) : {};
    assert(noZone.status === 200 && noZoneRow.event_tz === 'UTC' && noZoneRow.event_start_local === '2027-02-05T09:50',
        `an online event from an old client with no zone falls back to UTC (got ${noZoneRow.event_tz} ${noZoneRow.event_start_local})`);

    if (onId) {
        rsvpEvent(() => {}, onId, goer.pubKeyHex, 'going');
        rsvpEvent(() => {}, onId, maybe.pubKeyHex, 'interested');
        const asHost = await readEvent(onId, online);
        const asGoing = await readEvent(onId, goer);
        const asMaybe = await readEvent(onId, maybe);
        assert(asHost?.eventLink === 'https://meet.example/vibe', `the host sees the link (got ${asHost?.eventLink})`);
        assert(asGoing?.eventLink === 'https://meet.example/vibe', `Going sees the link (got ${asGoing?.eventLink})`);
        assert(!!asMaybe && asMaybe.eventLink === undefined && !JSON.stringify(asMaybe).includes('meet.example'),
            'Interested does not see the link');
        assert(asMaybe?.eventOnline === true && asMaybe?.eventTz === 'Australia/Sydney' && asMaybe?.eventStartLocal === '2027-01-15T20:50',
            'everyone reads online, the zone and the clock');
        const guest = guestPost(asHost);
        assert(guest.eventLink === undefined && guest.eventTz === 'Australia/Sydney' && guest.eventOnline === true && guest.eventStartLocal === '2027-01-15T20:50',
            "a visitor's view keeps the zone, clock and online, and drops the link (GUEST_FIELDS)");
        assert(publicBroadcastPost(asHost).eventLink === undefined, 'a broadcast to every socket carries no link');
    }

    // ── 6. Edit ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. Edit ──');
    if (oldId) {
        const moved = await signed('POST', '/api/marketplace/posts/update', { id: oldId, authorPublicKey: host.pubKeyHex, ...ACCRA }, host);
        const movedRow = row(oldId);
        assert(moved.status === 200 && movedRow.event_tz === 'Africa/Accra',
            `moving the pin with no zone sent takes the new pin's zone (got ${moved.status} ${movedRow.event_tz} ${moved.error ?? ''})`);
        assert(movedRow.event_start_at === '2027-01-16T19:50:00.000Z' && movedRow.event_start_local === '2027-01-16T19:50',
            `an old client's move keeps the instant; the clock is re-read in the new zone (got ${movedRow.event_start_local})`);
    }
    if (sydId) {
        db.prepare(`UPDATE posts SET event_state = 'scheduled' WHERE id = ?`).run(sydId);
        const rezoned = await signed('POST', '/api/marketplace/posts/update', { id: sydId, authorPublicKey: host.pubKeyHex, eventTz: 'Australia/Perth' }, host);
        const rz = row(sydId);
        assert(rezoned.status === 200 && rz.event_tz === 'Australia/Perth' && rz.event_start_local === '2027-01-15T20:50'
            && rz.event_start_at === '2027-01-15T12:50:00.000Z' && rz.event_state === 'updated',
            `a new zone with the clock kept moves the instant and marks UPDATED (got ${rz.event_start_at} ${rz.event_state} ${rezoned.error ?? ''})`);
        const local2 = await signed('POST', '/api/marketplace/posts/update', { id: sydId, authorPublicKey: host.pubKeyHex, eventStartLocal: '2027-01-15T19:00', eventEndLocal: '2027-01-15T21:30' }, host);
        const l2 = row(sydId);
        assert(local2.status === 200 && l2.event_start_at === '2027-01-15T11:00:00.000Z' && l2.event_end_local === '2027-01-15T21:30',
            `an edited clock resolves in the event's zone (got ${l2.event_start_at} ${l2.event_end_local})`);
        const badTz = await signed('POST', '/api/marketplace/posts/update', { id: sydId, authorPublicKey: host.pubKeyHex, eventTz: 'Nowhere/Land' }, host);
        assert(badTz.status === 400 && /Pick a time zone/.test(badTz.error ?? '') && row(sydId).event_tz === 'Australia/Perth',
            `an edit to an unknown zone is refused and stores nothing (got ${badTz.status})`);
    }
    if (onId) {
        const toPlace = await signed('POST', '/api/marketplace/posts/update', { id: onId, authorPublicKey: online.pubKeyHex, eventOnline: false, ...SYDNEY }, online);
        const tp = row(onId);
        assert(toPlace.status === 200 && tp.event_online === 0 && tp.event_link === null && tp.lat === SYDNEY.lat,
            `switching to in person clears the link and takes the pin (got ${toPlace.status} ${tp.event_link} ${toPlace.error ?? ''})`);
        const back = await signed('POST', '/api/marketplace/posts/update', { id: onId, authorPublicKey: online.pubKeyHex, eventOnline: true, eventLink: 'https://meet.example/vibe' }, online);
        const bk = row(onId);
        assert(back.status === 200 && bk.event_online === 1 && bk.lat === null && bk.event_link === 'https://meet.example/vibe',
            `and back to online with a link (got ${back.status} ${back.error ?? ''})`);
    }

    // ── 7. The copy ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. A copy carries the new fields ──');
    if (onId) {
        const payload = await exportSyncState(nodeId);
        const exported = (payload.posts ?? []).find(p => p.id === onId) as any;
        assert(exported?.eventTz === 'Australia/Sydney' && exported?.eventStartLocal === '2027-01-15T20:50'
            && exported?.eventOnline === true && exported?.eventLink === 'https://meet.example/vibe',
            `the exported post carries the clock, zone, online and link (got ${JSON.stringify({ tz: exported?.eventTz, on: exported?.eventOnline, link: exported?.eventLink })})`);
        db.prepare(`UPDATE posts SET event_start_local = NULL, event_end_local = NULL, event_tz = NULL, event_online = NULL, event_link = NULL,
                    updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(onId);
        setNodeRole('backup');
        await importRemoteState(payload as any);
        setNodeRole('primary');
        const imp = row(onId);
        assert(imp.event_tz === 'Australia/Sydney' && imp.event_start_local === '2027-01-15T20:50' && imp.event_online === 1
            && imp.event_link === 'https://meet.example/vibe',
            `an import restores them (got ${JSON.stringify({ tz: imp.event_tz, local: imp.event_start_local, on: imp.event_online, link: imp.event_link })})`);
    }

    // ── 8. Reminders ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. Reminder words ──');
    const lagosEv = await create(host, { ...LAGOS, eventStartLocal: '2027-03-06T20:50', eventTz: 'Africa/Lagos' });
    const lagosId = lagosEv.body?.post?.id;
    const onlineEv = await create(online, { eventOnline: true, eventStartLocal: '2027-03-06T20:50', eventTz: 'Africa/Lagos' });
    const onlineEvId = onlineEv.body?.post?.id;
    assert(!!lagosId && !!onlineEvId, `two events for the sweep (got ${lagosEv.status} ${onlineEv.status})`);
    if (lagosId && onlineEvId) {
        db.prepare(`UPDATE event_rsvps SET reminder_offsets = NULL WHERE member_pubkey = ?`).run(goer.pubKeyHex);
        rsvpEvent(() => {}, lagosId, goer.pubKeyHex, 'going');
        rsvpEvent(() => {}, onlineEvId, goer.pubKeyHex, 'going');
        db.prepare(`UPDATE event_rsvps SET reminder_offsets = '[1440]' WHERE member_pubkey = ? AND post_id IN (?, ?)`).run(goer.pubKeyHex, lagosId, onlineEvId);
        const sent: Array<{ body: string; postId: string }> = [];
        const push = ((_t: string[], _f: string, _title: string, body: string, data: any) => { sent.push({ body, postId: data?.postId }); }) as any;
        const dueMs = Date.parse('2027-03-06T19:50:00.000Z') - 24 * 60 * 60 * 1000 + 1000;
        runEventReminderSweep(push, dueMs);
        const inPerson = sent.find(s => s.postId === lagosId);
        const onl = sent.find(s => s.postId === onlineEvId);
        assert(inPerson?.body === 'Starts in 1 day · Sat 20:50 Lagos time', `in person: "Starts in 1 day · Sat 20:50 Lagos time" (got ${JSON.stringify(inPerson?.body)})`);
        assert(onl?.body === 'Starts in 1 day', `online: the relative words only (got ${JSON.stringify(onl?.body)})`);
    }

    // ── 9. The scrub ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. The scrub clears the link ──');
    if (onId) {
        scrubPostsOf(online.pubKeyHex, new Date().toISOString());
        const sc = row(onId);
        assert(sc.event_link === null && sc.event_private_note === null, `the link goes with the note (got ${sc.event_link})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Event times over HTTP PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
