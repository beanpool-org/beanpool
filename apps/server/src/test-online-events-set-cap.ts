/**
 * Test Suite: a member's set holds online events and still never exceeds the node's `max` (review of #1952, finding 2;
 * DESIGN-event-times §9, director amendment 2).
 *
 * A phone keeps at most `max` listings of its set and drops a listing with no place first (apps/native/utils/
 * posts-nearby.ts nearbyPrune, "the node guarantees within the radius; the phone guarantees at most `max`"). So a set
 * that appended online events past `max` lost every one of them on the phone. The node now takes the online events first
 * (at most NEARBY_SET_ONLINE_EVENTS) and the near list gives way to them from its far end. Boots the real server on the
 * global profile with NEARBY_LISTINGS_MAX=3 and reads over signed HTTP through the real middleware:
 *   1. three in-person events near a Sydney member (1, 5 and 10 km) and two online events: her set holds 3 ids, both
 *      online events and the nearest in-person one;
 *   2. the phone's own nearbyPrune, run on the rows of that set with her area and the node's `max`, drops none;
 *   3. with no online events, the set is the three nearest, as before.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-online-events-set-cap)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
process.env.NEARBY_LISTINGS_MAX = '3';
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { setMemberPhoto, NEARBY_SET_ONLINE_EVENTS } from '@beanpool/engine';
import { localFetch } from './keepalive-test-fetch.js';

/** The phone's own rule, run on the node's answer (as test-takeover-keeps-listing-times does with posts-replace). */
const PHONE_RULE = new URL('../../native/utils/posts-nearby.ts', import.meta.url).href;

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const TYPES = 'offer,need,poll,event';

async function signed(method: 'GET' | 'POST', path: string, body: unknown, id: Id) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts), 'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await localFetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main(): Promise<void> {
    console.log('\nA member\'s set with online events stays within max\n');
    const { nearbyPrune } = await import(PHONE_RULE) as {
        nearbyPrune: (held: Array<{ id: string; lat: number | null; lng: number | null; at: string | null; kept: boolean }>, area: { lat: number; lng: number } | null, max: number) => string[];
    };
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getNodeFeatures } = await import('./config/node-profile.js');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

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
    const nearHost = memberAt('NearNia', SYDNEY);
    const onlineHost = memberAt('OnlineOmar', null);
    const reader = memberAt('ReaderRae', SYDNEY);

    const max = getNodeFeatures().nearbyListings?.max;
    assert(max === 3, `the node's max is 3 (NEARBY_LISTINGS_MAX) (got ${max})`);
    assert(NEARBY_SET_ONLINE_EVENTS === 50, `the set holds at most 50 online events (got ${NEARBY_SET_ONLINE_EVENTS})`);

    const clockIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 11) + '20:50';
    const create = async (who: Id, body: Record<string, unknown>) => {
        const r = await signed('POST', '/api/marketplace/posts', {
            type: 'event', title: 'Working bee', description: '', authorPublicKey: who.pubKeyHex, eventTz: 'Australia/Sydney', ...body,
        }, who);
        return { status: r.status, id: (r.body?.post?.id ?? r.body?.id) as string, error: r.error };
    };
    // 1, 5 and 10 km north of the reader's area.
    const kmNorth = (km: number) => ({ lat: SYDNEY.lat + km / 111, lng: SYDNEY.lng });
    const near1 = await create(nearHost, { ...kmNorth(1), eventStartLocal: clockIn(2) });
    const near5 = await create(nearHost, { ...kmNorth(5), eventStartLocal: clockIn(3) });
    const near10 = await create(nearHost, { ...kmNorth(10), eventStartLocal: clockIn(4) });
    assert([near1, near5, near10].every(r => r.status === 200 && !!r.id), `three in-person events near Sydney (got ${[near1, near5, near10].map(r => `${r.status} ${r.error ?? ''}`).join(', ')})`);

    const setOf = async () => {
        const r = await signed('GET', `/api/marketplace/posts?limit=200&sync=true&types=${TYPES}&nearby=1`, null, reader);
        return { status: r.status, set: (r.body?.set ?? []) as string[] };
    };

    // ── 3 first: with no online events, the three nearest ──
    console.log('── With no online events ──');
    const before = await setOf();
    assert(before.status === 200 && before.set.length === 3 && [near1.id, near5.id, near10.id].every(id => before.set.includes(id)),
        `the set is the three in-person events (got ${before.set.length}: ${before.set.join(',')})`);

    // ── 1. Two online events: the set stays at 3 ──
    console.log('\n── Two online events ──');
    const online1 = await create(onlineHost, { eventOnline: true, eventStartLocal: clockIn(5) });
    const online2 = await create(onlineHost, { eventOnline: true, eventStartLocal: clockIn(6) });
    assert(online1.status === 200 && online2.status === 200, `two online events (got ${online1.status} ${online2.status})`);
    const after = await setOf();
    assert(after.set.length === 3, `the set holds 3 ids, the node's max (got ${after.set.length}: ${after.set.join(',')})`);
    assert(after.set.includes(online1.id) && after.set.includes(online2.id), 'both online events are in it');
    assert(after.set.includes(near1.id) && !after.set.includes(near5.id) && !after.set.includes(near10.id),
        'the near list gave way from its far end: the 1 km event stays, the 5 and 10 km ones go');

    // ── 2. The phone's own prune keeps them all ──
    console.log('\n── The phone\'s nearbyPrune on that set ──');
    const read = await signed('GET', `/api/marketplace/posts?limit=200&sync=true&types=${TYPES}&ids=${after.set.join(',')}`, null, reader);
    const rows: any[] = Array.isArray(read.body) ? read.body : read.body?.posts ?? [];
    assert(read.status === 200 && rows.length === 3, `the set's rows read by ids= (got ${read.status}, ${rows.length})`);
    const held = rows.map(p => ({ id: p.id, lat: p.lat ?? null, lng: p.lng ?? null, at: p.updatedAt ?? p.createdAt ?? null, kept: false }));
    const dropped = nearbyPrune(held, SYDNEY, max!);
    assert(dropped.length === 0, `nearbyPrune with her area and max ${max} drops none (dropped ${dropped.join(',') || 'none'})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
