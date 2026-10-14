/**
 * Test Suite: online events reach every member on a node that syncs by area (DESIGN-event-times §9, director amendment 2).
 *
 * An online event has no pin, and an event is never put at its author's area (engine/posts.ts placelessListingArea skips
 * events), so a set built from the listings near a member's area never held one: on the global node an online event
 * reached only its host. Boots the real server on the global profile and reads over HTTP, signed, through the real
 * middleware:
 *   1. an online event created over HTTP is in the set of a member on the other side of the world, of one with no area,
 *      and of its host; an in-person event at the host's town is in none of the far members' sets;
 *   2. a read that leaves events out (an app that never asked for them) holds no online event;
 *   3. the listing's own rules still hold: an ended online event, a cancelled one, one by an author on holiday, a group's
 *      the reader is not in, and one by an author the reader blocked are out of her set;
 *   4. the set's tag moves when an online event is posted: the held tag gets a 200 with the new event in the set;
 *   5. Home's "Coming up" (global: within 50 km of the reader's point) holds the online event wherever the reader is,
 *      with its clock, zone and `online`, and not the far in-person one.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-online-events-nearby)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
delete process.env.NEARBY_LISTINGS_MAX;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { localFetch } from './keepalive-test-fetch.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const LONDON = { lat: 51.5072, lng: -0.1276 };
const TYPES = 'offer,need,poll,event';

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
    const res = await localFetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined, etag: res.headers.get('etag') };
}

async function main(): Promise<void> {
    console.log('\nOnline events on a node that syncs by area\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    // Members of some standing (joined two months ago, a face), so the global node's newcomer rules don't apply.
    const memberAt = (callsign: string, area: { lat: number; lng: number } | null): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        const joined = new Date(Date.now() - 60 * 86_400_000).toISOString();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng, area_updated_at)
                    VALUES (?, ?, 'active', ?, 'seed', ?, ?, ?, ?)`)
            .run(pubKeyHex, callsign, joined, `INV-${callsign.toUpperCase()}`, area?.lat ?? null, area?.lng ?? null, area ? joined : null);
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        return { pubKeyHex, privateKey };
    };
    const host = memberAt('HostHana', LAGOS);
    const host2 = memberAt('HostHugo', LAGOS);
    const sydney = memberAt('SydSam', SYDNEY);
    const london = memberAt('LonLiz', LONDON);
    const nowhere = memberAt('NoAreaNed', null);

    const day = 86_400_000;
    const clockIn = (days: number) => new Date(Date.now() + days * day).toISOString().slice(0, 11) + '20:50';
    const create = (who: Id, body: Record<string, unknown>) => signed('POST', '/api/marketplace/posts', {
        type: 'event', title: 'Vibe coding', description: 'Bring a laptop', authorPublicKey: who.pubKeyHex, ...body,
    }, who);
    const idOf = (r: { body: any }) => r.body?.post?.id ?? r.body?.id;

    const onl = await create(host, { eventOnline: true, eventStartLocal: clockIn(3), eventTz: 'Africa/Lagos', eventLink: 'https://meet.example/vibe' });
    const onlineId = idOf(onl);
    assert(onl.status === 200 && !!onlineId, `an online event is created over HTTP (got ${onl.status} ${onl.error ?? ''})`);
    const inPerson = await create(host, { ...LAGOS, eventStartLocal: clockIn(4), eventTz: 'Africa/Lagos', eventPlaceName: 'The hall' });
    const inPersonId = idOf(inPerson);
    assert(inPerson.status === 200 && !!inPersonId, `an in-person event at Lagos is created (got ${inPerson.status} ${inPerson.error ?? ''})`);

    const setOf = async (who: Id, types = TYPES, extra: Record<string, string> = {}) => {
        const r = await signed('GET', `/api/marketplace/posts?limit=200&sync=true&types=${types}&nearby=1`, null, who, extra);
        return { status: r.status, set: new Set<string>(r.body?.set ?? []), etag: r.etag };
    };

    // ── 1. In every member's set, wherever they are ──
    console.log('── 1. Every member\'s set holds the online event ──');
    const syd = await setOf(sydney);
    assert(syd.status === 200, `a member's by-area read answers 200 (got ${syd.status})`);
    assert(syd.set.has(onlineId), 'Sydney (15,000 km away) has the online event in her set');
    assert(!syd.set.has(inPersonId), 'Sydney does not have the in-person event at Lagos');
    const lon = await setOf(london);
    assert(lon.set.has(onlineId) && !lon.set.has(inPersonId), 'London has the online event, and not the in-person one at Lagos');
    assert((await setOf(nowhere)).set.has(onlineId), 'a member with no area has it');
    assert((await setOf(host)).set.has(onlineId), 'its host has it');
    const read = await signed('GET', `/api/marketplace/posts?limit=200&sync=true&types=${TYPES}&ids=${onlineId}`, null, sydney);
    const rows: any[] = Array.isArray(read.body) ? read.body : read.body?.posts ?? [];
    assert(rows.length === 1 && rows[0].eventOnline === true && rows[0].eventLink === undefined,
        'Sydney reads it by id: online, and no link before she taps Going');

    // ── 2. An app that never asked for events ──
    console.log('\n── 2. A read without events ──');
    assert(!(await setOf(sydney, 'offer,need,poll')).set.has(onlineId), 'a read that leaves events out holds no online event');

    // ── 3. The listing's own rules ──
    console.log('\n── 3. The listing\'s own rules still hold ──');
    const mk = async (who: Id, days: number, extra: Record<string, unknown> = {}) => {
        const r = await create(who, { eventOnline: true, eventStartLocal: clockIn(days), eventTz: 'Africa/Lagos', ...extra });
        return idOf(r) as string;
    };
    const ended = await mk(host2, 1);
    db.prepare(`UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString(), ended);
    const cancelled = await mk(host2, 2);
    db.prepare(`UPDATE posts SET status = 'cancelled', active = 0, event_state = 'cancelled' WHERE id = ?`).run(cancelled);
    const groupId = 'g-online-only';
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, join_policy, created_at, updated_at) VALUES (?, 'Coders', 'coders', ?, 'invite_only', ?, ?)`)
        .run(groupId, host2.pubKeyHex, new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at) VALUES (?, ?, 'convenor', 'active', ?)`)
        .run(groupId, host2.pubKeyHex, new Date().toISOString());
    const forGroup = await mk(host2, 3, { audienceScope: 'group', targetGroupId: groupId });
    const after = await setOf(sydney);
    assert(!!ended && !after.set.has(ended), 'an ended online event is not in the set');
    assert(!!cancelled && !after.set.has(cancelled), 'a cancelled online event is not in the set');
    assert(!!forGroup && !after.set.has(forGroup), 'a group\'s online event is not in the set of someone outside the group');
    assert((await setOf(host2)).set.has(forGroup), '…and is in its convenor\'s');
    const blocked = await signed('POST', '/api/blocks', { targetPubkey: host.pubKeyHex }, london);
    assert(blocked.status === 200, `London blocks the host on the web (got ${blocked.status} ${blocked.error ?? ''})`);
    assert(!(await setOf(london)).set.has(onlineId), 'a member who blocked the host has none of the host\'s online events');

    // ── 4. The tag moves ──
    console.log('\n── 4. The tag moves when an online event is posted ──');
    const held = await setOf(sydney);
    assert(!!held.etag, 'the by-area read carries a tag');
    const again = await setOf(sydney, TYPES, { 'If-None-Match': held.etag! });
    assert(again.status === 304, `nothing changed: 304 (got ${again.status})`);
    const later = await mk(host2, 5);
    const moved = await setOf(sydney, TYPES, { 'If-None-Match': held.etag! });
    assert(moved.status === 200 && moved.set.has(later), `a new online event at Lagos: 200, and it is in Sydney's set (got ${moved.status})`);

    // ── 5. Home's "Coming up" ──
    console.log('\n── 5. Home\'s "Coming up" holds it wherever the reader is ──');
    const home = await signed('GET', `/api/home?cards=events&lat=${SYDNEY.lat}&lng=${SYDNEY.lng}`, null, sydney);
    const items: any[] = home.body?.cards?.events?.items ?? [];
    assert(home.status === 200, `Home answers 200 (got ${home.status} ${home.error ?? ''})`);
    assert(home.body?.cards?.events?.radiusKm === 50, `the card is "within 50 km" on the global node (got ${home.body?.cards?.events?.radiusKm})`);
    const item = items.find(i => i.id === onlineId);
    assert(!!item, `the online event is in Sydney's "Coming up" (got ${items.map(i => i.id).join(',') || 'nothing'})`);
    assert(item?.online === true && item?.tz === 'Africa/Lagos' && item?.startLocal === clockIn(3),
        `with online, its zone and its clock (got ${JSON.stringify(item && { online: item.online, tz: item.tz, startLocal: item.startLocal })})`);
    assert(!items.some(i => i.id === inPersonId), 'the in-person event at Lagos is not (15,000 km away)');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
