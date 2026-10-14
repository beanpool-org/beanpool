/**
 * Event times, slice 1 (scratch/global-node/DESIGN-event-times-fable.md §2, §6, §9, §10 and Director amendment 1), over
 * REAL HTTP — through the signature middleware — wherever a route exists, and on the engine for the sweep, the copy and
 * the scrub, which no route drives.
 *
 * Verifies:
 *  1. A clock + zone body stores the instant the node resolved: Sydney 20:50 → 09:50Z, with the clock and zone kept.
 *  2. An old client's instant-only body gets its clock read off the instant in the PIN's zone (pin → Africa/Lagos).
 *  3. A zone the node does not know is refused in the form's words; a malformed clock is refused, and so is one with the
 *     shape but no such date or time (30 Feb, 24:00, minute 60), rather than rolled into another date.
 *     3b. A clock the zone skips (DST gap) or repeats (overlap) is answered as eventTimeAdjusted, next to the post and never
 *     on it, from create and edit; never for a clock that exists as typed, nor for an old client's instant-only body.
 *  4. GET /api/events/zone: the pin's zone, its words and offset; GET /api/events/zones: the picker list, ETag 304, a 401
 *     unsigned, and every zone the node can store (each a pin answers, UTC, Etc/GMT±n), by its current name (Europe/Kyiv,
 *     not Kiev), which is also what a create stores.
 *  5. Online: accepted with no pin (lat/lng NULL, no place name); the join link is http(s) only, with no user name or
 *     password, stored as the URL parser writes it; the link reaches the host and Going and NOT Interested, a visitor's
 *     view (GUEST_FIELDS) or a broadcast; an online event from an old client with no zone falls back to UTC, and a clock
 *     with no zone is refused.
 *  6. Edit: a new zone with the clock kept moves the instant and marks UPDATED; moving the pin with no zone sent takes
 *     the new pin's zone when it is another zone, and a nudge within the zone keeps a zone the host picked; a title-only
 *     edit leaves the stored clocks alone, and fills them in on an event from before them; switching to in person clears
 *     the link.
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
import { setMemberPhoto, guestPost, publicBroadcastPost, canonicalZone } from '@beanpool/engine';
import tzLookup from '@photostructure/tz-lookup';
import { offsetZones } from './engine/event-zone.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const ACCRA = { lat: 5.6037, lng: -0.187 };
const KYIV = { lat: 50.4501, lng: 30.5234 };

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
    // More hosts, each under the five-upcoming-events cap (engine/posts.ts EVENT_UPCOMING_CAP).
    const dst = makeIdentity('DstDara');
    const kyivHost = makeIdentity('KyivKira');
    const picker = makeIdentity('PickerPia');
    const linker = makeIdentity('LinkerLev');
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
    assert(!!syd.body && !('eventTimeAdjusted' in syd.body), 'a clock that exists as typed answers no eventTimeAdjusted');

    // ── 2. An old client's instant ───────────────────────────────────────────────────────────
    console.log('\n── 2. An old client sends only the instant ──');
    const old = await create(host, { ...LAGOS, eventStartAt: '2027-01-16T19:50:00.000Z' });
    const oldId = old.body?.post?.id ?? old.body?.id;
    assert(old.status === 200 && !!oldId, `an instant-only body is still accepted (got ${old.status} ${old.error ?? ''})`);
    const oldRow = oldId ? row(oldId) : {};
    assert(oldRow.event_tz === 'Africa/Lagos', `the pin gives the zone: Africa/Lagos (got ${oldRow.event_tz})`);
    assert(oldRow.event_start_local === '2027-01-16T20:50' && oldRow.event_start_at === '2027-01-16T19:50:00.000Z',
        `the clock is read off the instant in that zone: 20:50 (got ${oldRow.event_start_local})`);
    assert(!!old.body && !('eventTimeAdjusted' in old.body), "an old client's instant-only body never answers eventTimeAdjusted");

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
    // The shape is right but the date or time does not exist: refused, not rolled into 2 Mar, the next day or the next hour.
    for (const impossible of ['2027-02-30T20:50', '2027-01-15T24:00', '2027-01-15T25:00', '2027-01-15T20:60', '2027-13-01T10:00']) {
        const r = await create(host, { ...SYDNEY, eventStartLocal: impossible, eventTz: 'Australia/Sydney' });
        assert(r.status === 400 && /^Start time must be a valid date and time/.test(r.error ?? ''), `${impossible} is refused (got ${r.status} ${r.error})`);
    }
    const badEnd = await create(host, { ...SYDNEY, eventStartLocal: '2027-01-15T20:50', eventEndLocal: '2027-01-15T22:60', eventTz: 'Australia/Sydney' });
    assert(badEnd.status === 400 && /^End time must be a valid date and time/.test(badEnd.error ?? ''), `an end at 22:60 is refused (got ${badEnd.status} ${badEnd.error})`);

    // ── 3b. A clock the zone skips or repeats ──────────────────────────────────────────────────
    console.log('\n── 3b. A DST gap or overlap is said, next to the post ──');
    const gap = await create(dst, { ...SYDNEY, eventStartLocal: '2027-10-03T02:30', eventTz: 'Australia/Sydney' });
    const gapId = gap.body?.post?.id;
    const gapRow = gapId ? row(gapId) : {};
    assert(gap.status === 200 && JSON.stringify(gap.body?.eventTimeAdjusted) === JSON.stringify({ start: { kind: 'gap', asked: '2027-10-03T02:30', saved: '2027-10-03T03:30' }, end: null })
        && gapRow.event_start_local === '2027-10-03T03:30' && gapRow.event_start_at === '2027-10-02T16:30:00.000Z',
        `Sydney 3 Oct 2027 02:30 does not exist: saved 03:30, and the answer says so (got ${gap.status} ${JSON.stringify(gap.body?.eventTimeAdjusted)} ${gapRow.event_start_local})`);
    assert(!!gap.body?.post && !('eventTimeAdjusted' in gap.body.post), 'it rides next to the post, never on it (a post is broadcast, cached and copied)');
    const overlap = await create(dst, { ...SYDNEY, eventStartLocal: '2027-04-04T02:30', eventEndLocal: '2027-04-04T04:00', eventTz: 'Australia/Sydney' });
    const overlapId = overlap.body?.post?.id;
    const overlapRow = overlapId ? row(overlapId) : {};
    assert(overlap.status === 200 && JSON.stringify(overlap.body?.eventTimeAdjusted) === JSON.stringify({ start: { kind: 'overlap', asked: '2027-04-04T02:30', saved: '2027-04-04T02:30' }, end: null })
        && overlapRow.event_start_at === '2027-04-03T15:30:00.000Z',
        `Sydney 4 Apr 2027 02:30 happens twice: the earlier (15:30Z), and the answer says so (got ${overlap.status} ${JSON.stringify(overlap.body?.eventTimeAdjusted)} ${overlapRow.event_start_at})`);
    const endGap = await create(dst, { ...SYDNEY, eventStartLocal: '2027-10-03T01:00', eventEndLocal: '2027-10-03T02:15', eventTz: 'Australia/Sydney' });
    assert(endGap.status === 200 && JSON.stringify(endGap.body?.eventTimeAdjusted) === JSON.stringify({ start: null, end: { kind: 'gap', asked: '2027-10-03T02:15', saved: '2027-10-03T03:15' } }),
        `an end in the gap is said as the end (got ${endGap.status} ${JSON.stringify(endGap.body?.eventTimeAdjusted)})`);
    if (overlapId) {
        const editGap = await signed('POST', '/api/marketplace/posts/update', { id: overlapId, authorPublicKey: dst.pubKeyHex, eventStartLocal: '2027-10-03T02:30', eventEndLocal: '2027-10-03T05:00' }, dst);
        assert(editGap.status === 200 && JSON.stringify(editGap.body?.eventTimeAdjusted) === JSON.stringify({ start: { kind: 'gap', asked: '2027-10-03T02:30', saved: '2027-10-03T03:30' }, end: null })
            && !('eventTimeAdjusted' in (editGap.body?.post ?? {})) && row(overlapId).event_start_local === '2027-10-03T03:30',
            `the edit route answers it too (got ${editGap.status} ${JSON.stringify(editGap.body?.eventTimeAdjusted)} ${editGap.error ?? ''})`);
        const editTitle = await signed('POST', '/api/marketplace/posts/update', { id: overlapId, authorPublicKey: dst.pubKeyHex, title: 'Renamed' }, dst);
        const editInstant = await signed('POST', '/api/marketplace/posts/update', { id: overlapId, authorPublicKey: dst.pubKeyHex, eventStartAt: '2027-10-02T17:00:00.000Z' }, dst);
        assert(editTitle.status === 200 && !('eventTimeAdjusted' in (editTitle.body ?? {})) && editInstant.status === 200 && !('eventTimeAdjusted' in (editInstant.body ?? {})),
            `an edit that sends no clock (a title, an old client's instant) answers none (got ${editTitle.status} ${editInstant.status})`);
    }

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
    assert(unsignedZones.status === 401, `an unsigned read is refused, 401, like every member read (got ${unsignedZones.status})`);
    // Every zone this node can store is in the list: each a pin can answer (zoneOfPin is canonicalZone over tz-lookup,
    // walked here on a 0.5° grid), UTC (an old client's online event) and Etc/GMT-14 … +12 (an app may send any of them).
    const listed = new Set<string>((zones.body?.zones ?? []).map((x: any) => x.tz));
    const answered = new Set<string>();
    for (let la = -89.75; la < 90; la += 0.5) for (let lo = -179.75; lo < 180; lo += 0.5) answered.add(tzLookup(la, lo));
    const storable = new Set<string>();
    for (const tz of [...answered, ...offsetZones()]) storable.add(canonicalZone(tz)!);
    const missing = [...storable].filter(tz => !listed.has(tz));
    assert(missing.length === 0 && storable.size > 400 && listed.has('UTC') && listed.has('Etc/GMT+2') && listed.has('Etc/GMT-14'),
        `the list holds every zone the node can store: ${storable.size}, with UTC and Etc/GMT±n (missing ${JSON.stringify(missing)})`);
    const gmtMinus1 = (zones.body?.zones ?? []).find((x: any) => x.tz === 'Etc/GMT-1');
    assert(gmtMinus1?.label === 'UTC+1 time' && gmtMinus1?.offsetMinutes === 60, `an offset zone reads as its offset (got ${JSON.stringify(gmtMinus1)})`);
    assert(listed.has('Europe/Kyiv') && !listed.has('Europe/Kiev') && listed.has('Asia/Kolkata') && !listed.has('Asia/Calcutta')
        && listed.has('America/Atikokan') && !listed.has('America/Coral_Harbour'),
        'the list spells zones by their current names, as the node stores them (Kyiv, Kolkata, Atikokan)');
    const kz = await signed('GET', `/api/events/zone?lat=${KYIV.lat}&lng=${KYIV.lng}`, null, kyivHost);
    assert(kz.status === 200 && kz.body?.tz === 'Europe/Kyiv' && kz.body?.label === 'Kyiv time', `a Kyiv pin is Europe/Kyiv (got ${JSON.stringify(kz.body)})`);
    const kyivOld = await create(kyivHost, { ...KYIV, eventStartLocal: '2027-01-15T20:50', eventTz: 'Europe/Kiev' });
    const kyivOldRow = kyivOld.body?.post?.id ? row(kyivOld.body.post.id) : {};
    assert(kyivOld.status === 200 && kyivOldRow.event_tz === 'Europe/Kyiv' && kyivOldRow.event_start_at === '2027-01-15T18:50:00.000Z',
        `a create that sends the old spelling stores Europe/Kyiv (got ${kyivOld.status} ${kyivOldRow.event_tz} ${kyivOldRow.event_start_at})`);
    const kyivPin = await create(kyivHost, { ...KYIV, eventStartAt: '2027-01-22T18:50:00.000Z' });
    const kyivPinRow = kyivPin.body?.post?.id ? row(kyivPin.body.post.id) : {};
    assert(kyivPin.status === 200 && kyivPinRow.event_tz === 'Europe/Kyiv' && kyivPinRow.event_start_local === '2027-01-22T20:50',
        `an old client's Kyiv pin stores Europe/Kyiv too (got ${kyivPin.status} ${kyivPinRow.event_tz})`);
    const atikokan = await create(kyivHost, { lat: 48.7584, lng: -91.6215, eventStartLocal: '2027-01-15T20:50', eventTz: 'America/Atikokan' });
    const atikokanRow = atikokan.body?.post?.id ? row(atikokan.body.post.id) : {};
    assert(atikokan.status === 200 && atikokanRow.event_tz === 'America/Atikokan', `America/Atikokan is stored as sent, not as Coral_Harbour (got ${atikokanRow.event_tz})`);

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
    // A clock means "this zone's clock", and online the node cannot know which: refused, not read as UTC.
    const clockNoZone = await create(linker, { eventOnline: true, eventStartLocal: '2027-01-15T20:50' });
    assert(clockNoZone.status === 400 && /Pick a time zone from the list/.test(clockNoZone.error ?? ''),
        `an online event with a clock and no zone is refused (got ${clockNoZone.status} ${clockNoZone.error})`);
    const endClockNoZone = await create(linker, { eventOnline: true, eventStartAt: '2027-02-05T09:50:00.000Z', eventEndLocal: '2027-02-05T22:50' });
    assert(endClockNoZone.status === 400 && /Pick a time zone from the list/.test(endClockNoZone.error ?? ''),
        `and so is one with only an end clock (got ${endClockNoZone.status} ${endClockNoZone.error})`);
    // The link: no user name or password (a look-alike), stored as the URL parser writes it.
    const onlineAt = { eventOnline: true, eventStartLocal: '2027-02-12T20:50', eventTz: 'Australia/Sydney' };
    for (const bad of ['https://user:pw@meet.example/x', 'https://zoom.us@evil.example/j/1']) {
        const r = await create(linker, { ...onlineAt, eventLink: bad });
        assert(r.status === 400 && /user name or password/.test(r.error ?? ''), `a link with a user name is refused: ${bad} (got ${r.status} ${r.error})`);
    }
    const spaced = await create(linker, { ...onlineAt, eventLink: 'https://meet.example/a b' });
    const upper = await create(linker, { ...onlineAt, eventLink: 'HTTPS://Meet.Example/Up' });
    const spacedRow = spaced.body?.post?.id ? row(spaced.body.post.id) : {};
    const upperRow = upper.body?.post?.id ? row(upper.body.post.id) : {};
    assert(spaced.status === 200 && spacedRow.event_link === 'https://meet.example/a%20b' && upper.status === 200 && upperRow.event_link === 'https://meet.example/Up',
        `a link is stored as the URL parser writes it (got ${spacedRow.event_link} ${upperRow.event_link})`);

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
    // A zone the host picked that is not the pin's (Brisbane, at a Sydney pin): an old client's nudge within Sydney's zone
    // keeps it, and the clock.
    const picked = await create(picker, { ...SYDNEY, eventStartLocal: '2027-01-15T20:50', eventTz: 'Australia/Brisbane', eventPlaceName: 'Hall' });
    const pickedId = picked.body?.post?.id;
    if (pickedId) {
        const p0 = row(pickedId);
        const titleOnly = await signed('POST', '/api/marketplace/posts/update', { id: pickedId, authorPublicKey: picker.pubKeyHex, title: 'Title only' }, picker);
        const p1 = row(pickedId);
        const nudged = await signed('POST', '/api/marketplace/posts/update', { id: pickedId, authorPublicKey: picker.pubKeyHex, lat: SYDNEY.lat + 0.001, lng: SYDNEY.lng }, picker);
        const p2 = row(pickedId);
        assert(p0.event_tz === 'Australia/Brisbane' && p0.event_start_at === '2027-01-15T10:50:00.000Z' && titleOnly.status === 200 && p1.event_tz === 'Australia/Brisbane',
            `a Brisbane-picked event at a Sydney pin is stored so, and a title edit keeps it (got ${p0.event_tz} ${p0.event_start_at} ${p1.event_tz})`);
        assert(nudged.status === 200 && p2.event_tz === 'Australia/Brisbane' && p2.event_start_local === '2027-01-15T20:50' && p2.event_start_at === '2027-01-15T10:50:00.000Z',
            `a pin nudged within the same zone keeps the zone the host picked, and 20:50 (got ${nudged.status} ${p2.event_tz} ${p2.event_start_local} ${nudged.error ?? ''})`);
        // A zone's rules change after the event was set (simulated: the stored clock no longer matches the instant). A
        // title-only edit leaves the clocks as the host set them; the boot re-resolve owns that case.
        db.prepare(`UPDATE posts SET event_start_local = '2027-01-15T21:50', event_state = 'scheduled' WHERE id = ?`).run(pickedId);
        const renamed = await signed('POST', '/api/marketplace/posts/update', { id: pickedId, authorPublicKey: picker.pubKeyHex, title: 'Renamed again' }, picker);
        const p3 = row(pickedId);
        assert(renamed.status === 200 && p3.event_start_local === '2027-01-15T21:50' && p3.event_start_at === '2027-01-15T10:50:00.000Z' && p3.event_state === 'scheduled',
            `a title-only edit does not rewrite the clock from the instant (got ${p3.event_start_local} ${p3.event_state})`);
        // An event from before the clocks: a title-only edit fills them in from the pin, and marks nothing.
        db.prepare(`UPDATE posts SET event_start_local = NULL, event_end_local = NULL, event_tz = NULL, event_online = NULL WHERE id = ?`).run(pickedId);
        const legacy = await signed('POST', '/api/marketplace/posts/update', { id: pickedId, authorPublicKey: picker.pubKeyHex, title: 'Legacy renamed' }, picker);
        const p4 = row(pickedId);
        assert(legacy.status === 200 && p4.event_tz === 'Australia/Sydney' && p4.event_start_local === '2027-01-15T21:50' && p4.event_end_local === '2027-01-15T23:50'
            && p4.event_online === 0 && p4.event_state === 'scheduled',
            `an event from before the clocks gets them on a title-only edit, from its pin (got ${JSON.stringify({ tz: p4.event_tz, s: p4.event_start_local, e: p4.event_end_local, on: p4.event_online, st: p4.event_state })})`);
    } else {
        assert(false, `the Brisbane-picked event is created (got ${picked.status} ${picked.error})`);
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
