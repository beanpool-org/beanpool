/**
 * Pinning on the global node (scratch/fable-design/DESIGN-pinning-fable.md §2.10, §4): a nearest-first read and a member's set,
 * over HTTP through the real middleware, on the global profile.
 *
 *  1. Nearest first: the live pins lead wherever they are, in the circles' read and past it, and the rest of the page is
 *     the page it was, none repeated. So they do within the node's own radius, what the web's Market reads by default,
 *     the list below them still bounded by it. Within a radius a member chose, a far pin is not there and a near one
 *     leads nothing.
 *  2. Nothing of a place changes: a visitor reads a pin at its area and a whole-km distance, measured from the area; a member
 *     reads it at its neighbourhood, measured from there, as they read it unpinned. The pin's stamps go to a visitor; no name.
 *  3. A member's set holds the live pins wherever they are, kept past the phone's cap (`tied`), under the listing's own rules:
 *     a read that leaves events out holds no pinned event, an author the member blocked is out. It stays within `max`.
 *  4. A pin that ends leaves the set with no sweep, and the set's tag moves. A member's stored area never moves.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-post-pinning-global)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
delete process.env.NEARBY_LISTINGS_MAX;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { getNearbySet, setMemberPhoto } from '@beanpool/engine';
import { TEST_PHOTOS } from './post-test-helper.js';
import { nearbyListingsLimits } from './config/node-profile.js';
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
const TYPES = 'offer,need,poll,event';
const DAY = 86_400_000;

async function signed(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id, extra: Record<string, string> = {}) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${pathAndQuery.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts), 'X-Nonce': nonce, ...extra,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined, code: json?.code as string | undefined, etag: res.headers.get('etag') };
}

async function main(): Promise<void> {
    console.log('\nPinning on the global node\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { pinPost } = await import('./engine/pins.js');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    const memberAt = (callsign: string, area: { lat: number; lng: number } | null): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        const joined = new Date(Date.now() - 60 * DAY).toISOString();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng, area_updated_at)
                    VALUES (?, ?, 'active', ?, 'seed', ?, ?, ?, ?)`)
            .run(pubKeyHex, callsign, joined, `INV-${callsign.toUpperCase()}`, area?.lat ?? null, area?.lng ?? null, area ? joined : null);
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        return { pubKeyHex, privateKey };
    };
    const owner = memberAt('OwnerOl', LAGOS);
    se.grantNodeRole(owner.pubKeyHex, 'owner', 'owner:password');
    const lagosAuthor = memberAt('LagosLu', LAGOS);
    const sydneyAuthor = memberAt('SydneySi', SYDNEY);
    const sydney = memberAt('ReaderRo', SYDNEY);
    const elsewhere = memberAt('NoAreaNi', null);

    let n = 0;
    const post = async (who: Id, place: { lat: number; lng: number }, body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        const r = await signed('POST', '/api/marketplace/posts', {
            type: 'offer', category: 'Food', title: `Listing ${n}`, description: 'Plenty', price_c: 0, authorPublicKey: who.pubKeyHex, photos: TEST_PHOTOS, ...place, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post: ${r.status} ${r.error}`);
        return id;
    };
    const pin = (id: string, days = 3) => signed('POST', `/api/marketplace/posts/${id}/pin`, { days }, owner);
    const unpin = (id: string) => signed('POST', `/api/marketplace/posts/${id}/unpin`, {}, owner);

    const farPin = await post(lagosAuthor, LAGOS);
    const nearOnes: string[] = [];
    for (let i = 0; i < 12; i++) nearOnes.push(await post(sydneyAuthor, { lat: SYDNEY.lat + i * 0.001, lng: SYDNEY.lng }));
    const fromSydney = `lat=${SYDNEY.lat}&lng=${SYDNEY.lng}&types=${TYPES}`;
    const page = async (who: Id, q: string) => {
        const r = await signed('GET', `/api/marketplace/posts?${q}`, null, who);
        return { ...r, rows: (Array.isArray(r.body) ? r.body : []) as any[], ids: (Array.isArray(r.body) ? r.body : []).map((p: any) => p.id as string) };
    };
    const before = await page(sydney, `${fromSydney}&limit=10`);
    assert(before.ids.length === 10 && !before.ids.includes(farPin) && before.rows[0].distanceKm < 5, `nearest first, with nothing pinned (got ${before.ids.length}, first at ${before.rows[0]?.distanceKm} km)`);

    // ── 1. Nearest first ───────────────────────────────────────────────────────────────────────
    console.log('── 1. Nearest first ──');
    const pinned = await pin(farPin);
    assert(pinned.status === 200, `a far post is pinned (got ${pinned.status} ${pinned.error ?? ''})`);
    const led = await page(sydney, `${fromSydney}&limit=10`);
    assert(led.ids[0] === farPin, `a pin leads a nearest-first page from across the world, in the circles' read (first is ${led.ids[0]})`);
    assert(led.ids.slice(1).join() === before.ids.slice(0, 9).join(), 'and the page below it is the page it was');
    assert(led.rows[0].distanceKm > 10_000, `it carries its own distance (${led.rows[0].distanceKm} km)`);
    assert(before.etag !== led.etag, 'the tag moved');
    const second = await page(sydney, `${fromSydney}&limit=5&offset=5`);
    const firstHalf = await page(sydney, `${fromSydney}&limit=5&offset=0`);
    assert([...firstHalf.ids, ...second.ids].join() === led.ids.join(), `pages run on through it (${firstHalf.ids.length}, ${second.ids.length})`);
    const deep = await page(sydney, `${fromSydney}&limit=50`);
    assert(deep.ids[0] === farPin && new Set(deep.ids).size === deep.ids.length && deep.ids.length === 13, `one pass past the circles: first, once (${deep.ids.length} rows)`);
    const nodeRadius = nearbyListingsLimits().radiusKm;
    const defaultRead = await page(sydney, `${fromSydney}&radiusKm=${nodeRadius}&sort=distance&limit=10`);
    assert(defaultRead.ids[0] === farPin && defaultRead.ids.slice(1).join() === before.ids.slice(0, 9).join() && defaultRead.rows[0].distanceKm > nodeRadius,
        `within the node's own radius, the web's default read, a far pin leads and the list below it is the list (first is ${defaultRead.ids[0]})`);
    const defaultPage2 = await page(sydney, `${fromSydney}&radiusKm=${nodeRadius}&sort=distance&limit=10&offset=10`);
    assert(!defaultPage2.ids.includes(farPin) && defaultPage2.rows.every(p => p.distanceKm <= nodeRadius), `and only it comes from past the radius (${defaultPage2.ids.length} on the next page)`);
    const within = await page(sydney, `${fromSydney}&radiusKm=50&limit=50`);
    assert(within.status === 200 && !within.ids.includes(farPin), 'within a radius a member chose, a far pin is not there');
    await unpin(farPin);
    const edge = await post(sydneyAuthor, { lat: SYDNEY.lat + 0.3, lng: SYDNEY.lng });
    await pin(edge);
    const withinNear = await page(sydney, `${fromSydney}&radiusKm=50&limit=50`);
    assert(withinNear.ids.includes(edge) && withinNear.ids[0] !== edge && withinNear.ids[withinNear.ids.length - 1] === edge,
        `and one inside it leads nothing there, last by distance (first is ${withinNear.ids[0]})`);
    await unpin(edge);
    await pin(farPin);

    // ── 2. Nothing of a place changes ──────────────────────────────────────────────────────────
    console.log('\n── 2. Nothing of a place changes ──');
    const res = await localFetch(`${BASE}/api/marketplace/posts?${fromSydney}&limit=10`);
    const guestRows = await res.json() as any[];
    const guestPin = guestRows[0];
    assert(res.status === 200 && guestPin?.id === farPin, `a visitor reads it first too (first is ${guestPin?.id})`);
    assert(guestPin.lat === Math.round(LAGOS.lat * 10) / 10 && guestPin.lng === Math.round(LAGOS.lng * 10) / 10, `at its area, never its place (${guestPin.lat}, ${guestPin.lng})`);
    assert(Number.isInteger(guestPin.distanceKm), `a whole-km distance from the area (${guestPin.distanceKm})`);
    assert(typeof guestPin.pinnedUntil === 'string' && guestPin.authorCallsign === '' && !('createdBy' in guestPin), 'with its end, and nobody in it');
    const asMember = led.rows[0];
    await unpin(farPin);
    const plain = await page(sydney, `${fromSydney}&limit=50`);
    const plainRow = plain.rows.find(p => p.id === farPin);
    assert(asMember.lat === plainRow.lat && asMember.lng === plainRow.lng && asMember.distanceKm === plainRow.distanceKm && asMember.lat !== LAGOS.lat,
        `a member reads it where they read it unpinned, to its neighbourhood (${asMember.lat}, ${asMember.lng}, ${asMember.distanceKm} km)`);
    await pin(farPin);

    // ── 3. A member's set ──────────────────────────────────────────────────────────────────────
    console.log('\n── 3. A member\'s set ──');
    const setOf = async (who: Id, types = TYPES, headers: Record<string, string> = {}) => {
        const r = await signed('GET', `/api/marketplace/posts?limit=200&sync=true&types=${types}&nearby=1`, null, who, headers);
        return { status: r.status, set: new Set<string>(r.body?.set ?? []), tied: new Set<string>(r.body?.tied ?? []), etag: r.etag, rows: (r.body?.posts ?? []) as any[] };
    };
    const farSet = await setOf(sydney);
    assert(farSet.status === 200 && farSet.set.has(farPin), 'a far pin is in the set of a member across the world');
    assert(farSet.tied.has(farPin), 'kept past the phone\'s cap: it is `tied`');
    assert(farSet.rows.find(p => p.id === farPin)?.pinnedUntil !== undefined, 'and its row, with the stamps, comes with the set');
    assert(farSet.set.has(nearOnes[0]) && !farSet.tied.has(nearOnes[0]), 'a near listing is near, and not tied');
    assert((await setOf(elsewhere)).set.has(farPin), 'and in the set of a member with no area');

    const farEvent = await post(lagosAuthor, LAGOS, {
        type: 'event', title: 'Lagos fair', eventStartLocal: `${new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10)}T10:00`, eventTz: 'Africa/Lagos', eventPlaceName: 'The hall',
    });
    await pin(farEvent);
    assert((await setOf(sydney)).set.has(farEvent), 'a pinned event is');
    assert(!(await setOf(sydney, 'offer,need,poll')).set.has(farEvent), 'not for a read that leaves events out');
    db.prepare(`INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at) VALUES (?, ?, ?)`).run(sydney.pubKeyHex, lagosAuthor.pubKeyHex, new Date().toISOString());
    assert(!(await setOf(sydney)).set.has(farPin), 'nor one by an author the member blocked');
    db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ?').run(sydney.pubKeyHex);

    const smallSet = getNearbySet(db, sydney.pubKeyHex, { area: SYDNEY, radiusKm: 250, max: 4, newestWithoutArea: 100 });
    assert(smallSet.near.length === 4 && smallSet.near.includes(farPin) && smallSet.near.includes(farEvent), `the set stays within its max, the pins in it (${smallSet.near.length})`);
    const noRoom = getNearbySet(db, sydney.pubKeyHex, { area: SYDNEY, radiusKm: 250, max: 1, newestWithoutArea: 100 });
    assert(noRoom.near.length === 1, `at a max below the pins, still its max (${noRoom.near.length})`);

    // ── 4. Ending ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. Ending ──');
    await unpin(farEvent);
    const held = await setOf(sydney);
    const areaBefore = JSON.stringify(db.prepare('SELECT area_lat, area_lng, area_updated_at FROM members WHERE public_key = ?').get(sydney.pubKeyHex));
    pinPost(farPin, owner.pubKeyHex, 1, Date.now() - DAY + 800);
    await new Promise(r => setTimeout(r, 900));
    const ended = await setOf(sydney, TYPES, { 'If-None-Match': held.etag ?? '' });
    assert(ended.status === 200 && !ended.set.has(farPin) && !ended.tied.has(farPin), `past its end, with no sweep, it leaves the set and the tag moves (got ${ended.status})`);
    assert(JSON.stringify(db.prepare('SELECT area_lat, area_lng, area_updated_at FROM members WHERE public_key = ?').get(sydney.pubKeyHex)) === areaBefore, "a member's stored area never moved");
    const endedRead = await page(sydney, `${fromSydney}&limit=50`);
    assert(endedRead.ids[0] !== farPin && endedRead.rows[0].distanceKm < 5 && endedRead.rows[endedRead.rows.length - 1].distanceKm > 10_000,
        `and the nearest-first read is back to nearest first (first at ${endedRead.rows[0]?.distanceKm} km)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
