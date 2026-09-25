/**
 * Distance search (global node G4, design §3.2 and §7): posts by distance on every profile, nearest-first by default on
 * the global profile, and an opt-in coarse area for people. Over REAL HTTPS through the real signature middleware.
 *
 *   1. haversine_km, the SQL function the listing runs: Mullumbimby to Castlemaine ≈ 1,280 km, a pair across the
 *      antimeridian (Suva to Apia), a pair either side of the North Pole, a zero distance, NULL for a missing place
 *   2. /api/community/info reports distanceSearch true on both profiles
 *   3. a radius query returns exactly the posts inside it, nearest-first with sort=distance, each with distanceKm to
 *      0.1 km; a post with no place is out of a radius query and last in a distance sort; distance order pages cleanly
 *   4. order: a point and no sort is nearest-first on global and today's order on local; without a point both keep
 *      today's order and carry no distanceKm; sort=recent and an operator's override keep today's order on global
 *   5. the boxes near the antimeridian and the poles lose nothing a brute-force haversine over every post keeps
 *   6. every other filter still applies with a point: a post hidden by reports, a group post the caller can't see, a
 *      removed post
 *   7. ETag: the same request twice → 304; another point or radius → 200 and a new ETag; the order changing with the
 *      profile's switch → 200 and a new ETag
 *   8. 400 for each garbage parameter, 200 at the edges
 *   9. EXPLAIN QUERY PLAN: the radius query the route runs uses idx_posts_lat_lng
 *  10. people: an area set with 6 decimals is stored rounded to 0.1° (the row, and nothing more precise anywhere in the
 *      database files); the member reads it back; another member's People list (both routes) shows a whole-km
 *      distanceKm and no coordinates, members without an area last; clearing works; unsigned, another actor, a
 *      non-member and garbage are refused; a member's area never touches members.lat/lng (an enterprise's map
 *      location); a People list with a point needs a signed member; deleting an account, or a prune, clears the area
 *  11. replication: the export carries the area and a standby importing it (update and insert) holds it; a write of the
 *      area alone moves updated_at; no other response carries it (profile, directory, map, activity, info)
 *
 * scripts/test-all.sh runs it twice: as a node ships (read auth on), and with the operator's ENFORCE_READ_AUTH=false,
 * where nothing stands in front of the People list and its own refusal of a distance to a non-member is what holds.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-distance-search.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createPost, removePost, createGroup, getPosts,
    exportSyncState, importRemoteState, setNodeRole, adminPruneUser, bumpPostsVersion,
} from './state-engine.js';
import { NEAREST_FIRST_MATCHES_PROBE } from '@beanpool/engine';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without G4 (no such column, no such function) must fail its assertion, not abort the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

let BASE = '';

// ── the reference: the haversine every app already uses (PWA lib/geo.ts, native market-filters.ts) ──────────────
const R_KM = 6371;
const rad = (d: number) => d * Math.PI / 180;
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return R_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
/** A second, independent formula (spherical law of cosines) for the known pairs. */
function lawOfCosines(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const c = Math.sin(rad(lat1)) * Math.sin(rad(lat2)) + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
    return R_KM * Math.acos(Math.max(-1, Math.min(1, c)));
}
/** Kilometres north (negative: south) along a meridian, in degrees of latitude. */
const kmNorth = (km: number) => km / (R_KM * Math.PI / 180);

/** Seeded, so a failure reproduces. */
function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, new Date(Date.now() - 60 * 86_400_000).toISOString(), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(method: 'GET' | 'POST', id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty (304) */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const list = async (viewer: Id | null, query: string) => {
    const r = await call('GET', viewer, `/api/marketplace/posts?${query}`);
    return Array.isArray(r.body) ? r.body as any[] : [];
};
/** Every page of a listing, 200 at a time (the route's most). */
async function listAll(viewer: Id | null, query: string): Promise<any[]> {
    const out: any[] = [];
    for (let offset = 0; ; offset += 200) {
        const page = await list(viewer, `${query}&limit=200&offset=${offset}`);
        out.push(...page);
        if (page.length < 200) return out;
    }
}
const ids = (posts: any[]) => posts.map(p => p.id as string);
/** The order `wanted` appears in within `got` (the other posts in the listing are left out). */
const relative = (got: string[], wanted: string[]) => got.filter(id => wanted.includes(id));
const same = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

function place(author: Id, title: string, lat?: number, lng?: number, extra?: Parameters<typeof createPost>[13]): string {
    return createPost('offer', 'other', title, `${title} description`, 0, 'fixed', author.pk, lat, lng, undefined, false, undefined, false, extra)!.id;
}
const setOverride = (name: string, value: string | null) => value === null
    ? db.prepare('DELETE FROM node_config WHERE key = ?').run(`nodeProfile.${name}`)
    : db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`nodeProfile.${name}`, value);
const info = async () => (await call('GET', null, '/api/community/info')).body;

async function main(): Promise<void> {
    console.log('\n=== Distance search (G4) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');   // posts near Mullumbimby
    const bea = member('Bea');   // the viewer
    const cal = member('Cal');   // convenes a group
    const dee = member('Dee');   // an area far away
    const eve = member('Eve');   // an author with a hidden post

    // ── 1. haversine_km ──────────────────────────────────────────────────────────────────────────
    console.log('── 1. haversine_km, as registered on the node\'s database ──');
    const sql = (a: number | null, b: number | null, c: number | null, d: number | null) =>
        attempt(() => (db.prepare('SELECT haversine_km(?, ?, ?, ?) AS d').get(a, b, c, d) as any).d as number | null);
    const mullum = [-28.55, 153.50] as const, castle = [-37.07, 144.22] as const;
    const mc = sql(...mullum, ...castle);
    assert(typeof mc === 'number' && Math.abs(mc - 1280) / 1280 < 0.01,
        `Mullumbimby to Castlemaine is ≈ 1,280 km great-circle, within 1% (got ${mc})`);
    const suva = [-18.14, 178.44] as const, apia = [-13.83, -171.76] as const;
    const sa = sql(...suva, ...apia);
    const saRef = lawOfCosines(...suva, ...apia);
    assert(typeof sa === 'number' && Math.abs(sa - saRef) / saRef < 0.01 && sa < 1300,
        `across the antimeridian, Suva to Apia is ≈ ${saRef.toFixed(1)} km, not the long way round (got ${sa})`);
    const pole = sql(89.9, 0, 89.9, 180);
    const poleRef = 0.2 * Math.PI / 180 * R_KM;
    assert(typeof pole === 'number' && Math.abs(pole - poleRef) / poleRef < 0.01,
        `either side of the North Pole, 89.9°N 0° to 89.9°N 180° is ≈ ${poleRef.toFixed(2)} km across the pole (got ${pole})`);
    assert(sql(...mullum, ...mullum) === 0 && sql(-90, 0, -90, 123) !== undefined && (sql(-90, 0, -90, 123) ?? 1) < 1e-9,
        `a point to itself is 0, and the South Pole to itself under another longitude is 0 (got ${sql(...mullum, ...mullum)}, ${sql(-90, 0, -90, 123)})`);
    assert(sql(...mullum, null, 144.22) === null && sql(null, null, ...castle) === null,
        'a missing coordinate is NULL, not 0 (a post with no place has no distance)');
    const fromSql = sql(...mullum, ...castle) ?? NaN;
    assert(Math.abs(fromSql - haversine(...mullum, ...castle)) < 1e-9, 'and it agrees with the apps\' own haversine');

    // ── 2. features ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. /api/community/info ──');
    const localInfo = await info();
    process.env.NODE_PROFILE = 'global';
    const globalInfo = await info();
    delete process.env.NODE_PROFILE;
    assert(localInfo?.features?.distanceSearch === true && globalInfo?.features?.distanceSearch === true && globalInfo?.profile === 'global',
        `distanceSearch is true on local and on global (got ${localInfo?.features?.distanceSearch}, ${globalInfo?.features?.distanceSearch})`);

    // ── 3. a radius query ────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. a radius query and a distance sort ──');
    const [hLat, hLng] = mullum;
    const hub = `lat=${hLat}&lng=${hLng}`;
    const P05 = place(ann, 'Half a km', hLat + kmNorth(0.5), hLng);
    const P5 = place(ann, 'Five km', hLat + kmNorth(5), hLng);
    const P20 = place(ann, 'Twenty km', hLat - kmNorth(20), hLng);
    const P60 = place(ann, 'Sixty km', hLat + kmNorth(60), hLng);
    const PC = place(ann, 'Castlemaine', ...castle);
    const PN = place(ann, 'Nowhere in particular');
    // Most recent first is NOT nearest first here, so the two orders can be told apart.
    const recency = [PC, P60, PN, P20, P5, P05];
    const nearest = [P05, P5, P20, P60, PC, PN];
    recency.forEach((id, i) => db.prepare('UPDATE posts SET updated_at = ?, created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - (i + 1) * 60_000).toISOString(), new Date(Date.now() - (i + 1) * 60_000).toISOString(), id));

    const inside = await list(bea, `${hub}&radiusKm=50&sort=distance&limit=200`);
    assert(same(ids(inside), [P05, P5, P20]),
        `radius 50 km, sort=distance: exactly the three posts inside, nearest first (got ${JSON.stringify(inside.map(p => p.title))})`);
    assert(same(inside.map(p => p.distanceKm), [0.5, 5, 20]),
        `each carries distanceKm to 0.1 km (got ${JSON.stringify(inside.map(p => p.distanceKm))})`);
    const wide = await list(bea, `${hub}&radiusKm=1300&sort=distance&limit=200`);
    assert(same(relative(ids(wide), nearest), [P05, P5, P20, P60, PC]) && wide.find(p => p.id === PC)?.distanceKm === Math.round(haversine(hLat, hLng, ...castle) * 10) / 10,
        `radius 1,300 km reaches Castlemaine (${wide.find(p => p.id === PC)?.distanceKm} km) and still leaves out the post with no place`);
    const all = await list(bea, `${hub}&sort=distance&limit=200`);
    const firstNull = all.findIndex(p => p.distanceKm === null);
    assert(same(relative(ids(all), nearest), nearest) && all.find(p => p.id === PN)?.distanceKm === null,
        'sort=distance without a radius: every post, nearest first, the post with no place last with distanceKm null');
    assert(firstNull >= 0 && all.slice(firstNull).every(p => p.distanceKm === null) && all.slice(0, firstNull).every(p => typeof p.distanceKm === 'number'),
        'and every post with no place comes after every post with one');
    const sorted = all.slice(0, firstNull).map(p => p.distanceKm as number);
    assert(sorted.every((d, i) => i === 0 || sorted[i - 1] <= d), 'distances never go down the list');
    const paged: string[] = [];
    for (let offset = 0; offset < all.length; offset += 2) paged.push(...ids(await list(bea, `${hub}&sort=distance&limit=2&offset=${offset}`)));
    assert(paged.length > 0 && same(paged, ids(all)), `distance order pages with limit and offset: pages of 2 put together are the whole list (${paged.length} posts)`);

    // ── 4. order by profile ──────────────────────────────────────────────────────────────────────
    console.log('\n── 4. which order, on which profile ──');
    const localPoint = await list(bea, `${hub}&limit=200`);
    assert(same(relative(ids(localPoint), recency), recency) && localPoint.find(p => p.id === P05)?.distanceKm === 0.5,
        'local, a point and no sort: today\'s order (most recently updated first), each post with its distanceKm');
    const localPlain = await list(bea, 'limit=200');
    assert(same(relative(ids(localPlain), recency), recency) && localPlain.every(p => !('distanceKm' in p)),
        'local, no point: today\'s order, and no distanceKm on anything');
    const localDistance = await list(bea, `${hub}&sort=distance&limit=200`);
    assert(same(relative(ids(localDistance), nearest), nearest), 'local, sort=distance: nearest first (every profile understands it)');
    process.env.NODE_PROFILE = 'global';
    const globalPoint = await list(bea, `${hub}&limit=200`);
    assert(same(relative(ids(globalPoint), nearest), nearest),
        `global, a point and no sort: nearest first (got ${JSON.stringify(relative(ids(globalPoint), nearest).map(id => nearest.indexOf(id)))})`);
    const globalPlain = await list(bea, 'limit=200');
    assert(same(ids(globalPlain), ids(localPlain)) && globalPlain.every(p => !('distanceKm' in p)),
        'global, no point: exactly the local listing, today\'s order, no distanceKm');
    const globalRecent = await list(bea, `${hub}&sort=recent&limit=200`);
    assert(same(relative(ids(globalRecent), recency), recency), 'global, a point and sort=recent: today\'s order, as the caller asked');
    setOverride('distanceSortDefault', 'false');
    const overridden = await list(bea, `${hub}&limit=200`);
    setOverride('distanceSortDefault', null);
    assert(same(relative(ids(overridden), recency), recency), 'global with the operator\'s override distanceSortDefault=false: today\'s order');
    delete process.env.NODE_PROFILE;

    // ── 5. the antimeridian and the poles ────────────────────────────────────────────────────────
    console.log('\n── 5. boxes across the antimeridian and around the poles ──');
    const rand = prng(20260925);
    const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
    const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
    for (let i = 0; i < 120; i++) {
        const lng = rand() < 0.5 ? between(168, 180) : between(-180, -168);
        place(ann, `Pacific ${i}`, round5(between(-26, -8)), round5(lng));
    }
    place(ann, 'On the antimeridian, east', -17, 180);
    place(ann, 'On the antimeridian, west', -17, -180);
    for (let i = 0; i < 110; i++) place(ann, `Arctic ${i}`, round5(between(80, 90)), round5(between(-180, 180)));
    place(ann, 'The North Pole', 90, 0);
    for (let i = 0; i < 60; i++) place(ann, `Antarctic ${i}`, round5(between(-90, -84)), round5(between(-180, 180)));
    place(ann, 'The South Pole', -90, 45);

    const visible = getPosts({ viewerPubkey: bea.pk, excludeEvents: true });
    const located = visible.filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
    const cases: Array<[string, number, number, number]> = [
        ['Fiji, the box split across the antimeridian', -17.7, 178.0, 800],
        ['west of the antimeridian, reaching east over it', -16, -179.5, 500],
        ['on the antimeridian itself', -12, 180, 400],
        ['around the North Pole (the box covers every longitude)', 88, 45, 600],
        ['near the North Pole, not over it (a wide longitude span)', 85, -120, 300],
        ['the North Pole itself', 90, 0, 250],
        ['near the South Pole', -89.5, 0, 100],
        ['the South Pole with a long reach', -86, 170, 1200],
    ];
    for (const [what, lat, lng, r] of cases) {
        const got = await list(bea, `lat=${lat}&lng=${lng}&radiusKm=${r}&sort=distance&limit=200`);
        // A post a hair's breadth from the edge could fall either way in floating point; none is that close here.
        const expected = located.filter(p => haversine(lat, lng, p.lat!, p.lng!) <= r).map(p => p.id).sort();
        const gotIds = ids(got).sort();
        const missing = expected.filter(id => !gotIds.includes(id));
        const extra = gotIds.filter(id => !expected.includes(id));
        assert(expected.length > 0 && got.length < 200 && missing.length === 0 && extra.length === 0,
            `${what}: the radius query holds exactly what a brute-force haversine over every post keeps (${expected.length} expected, ${got.length} got, ${missing.length} missing, ${extra.length} extra)`);
    }
    const everything = await listAll(bea, 'lat=0&lng=0&radiusKm=20037&sort=distance');
    assert(located.length > 200 && same(ids(everything).sort(), located.map(p => p.id).sort()) && everything.every(p => typeof p.distanceKm === 'number'),
        `radius 20,037 km (half the Earth round), paged: every placed post and none without a place (${everything.length} of ${located.length})`);

    // ── 6. every other filter still applies ──────────────────────────────────────────────────────
    console.log('\n── 6. the listing\'s other rules, with a point ──');
    process.env.NODE_PROFILE = 'global';
    const hidden = place(eve, 'Hidden by reports', hLat + kmNorth(1), hLng);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), hidden);
    const group = createGroup({ name: 'Cal club', createdBy: cal.pk });
    const groupPost = place(cal, 'For the club only', hLat + kmNorth(2), hLng, { audienceScope: 'group', targetGroupId: group.id });
    const removed = place(ann, 'Taken down', hLat + kmNorth(3), hLng);
    removePost(removed, ann.pk);
    const near = `${hub}&radiusKm=50&sort=distance&limit=200`;
    const forBea = ids(await list(bea, near));
    const forStranger = ids(await list(null, near));
    assert(!forBea.includes(hidden) && !forStranger.includes(hidden), 'a post hidden by reports is in nobody else\'s distance query');
    assert(ids(await list(eve, near)).includes(hidden), 'but its author still has it');
    assert(!forBea.includes(groupPost) && !forStranger.includes(groupPost), 'a group post is not in the query of someone outside the group');
    assert(ids(await list(cal, near)).includes(groupPost), 'but is in its convenor\'s');
    assert(![forBea, forStranger, ids(await list(ann, near))].some(l => l.includes(removed)), 'a removed post is in nobody\'s, its author\'s included');
    assert(same(forBea, [P05, P5, P20]) && same(forStranger, [P05, P5, P20]), 'and nothing else changed in the answer');
    const beaPinned = ids(await list(bea, `${hub}&radiusKm=50&audienceScope=group&limit=200`));
    assert(beaPinned.length === 0, 'audienceScope=group with a point: still only groups the caller is in (none)');
    delete process.env.NODE_PROFILE;

    // ── 7. ETag ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. ETag and 304 ──');
    const q = `/api/marketplace/posts?${hub}&radiusKm=50&sort=distance`;
    const first = await call('GET', bea, q);
    const etag = first.headers.get('etag') ?? '';
    const again = await call('GET', bea, q, undefined, { 'If-None-Match': etag });
    assert(first.status === 200 && !!etag && again.status === 304, `the same request twice → 304 (${first.status}, ${again.status})`);
    const moved = await call('GET', bea, `/api/marketplace/posts?lat=-28.56&lng=${hLng}&radiusKm=50&sort=distance`, undefined, { 'If-None-Match': etag });
    assert(moved.status === 200 && !!moved.headers.get('etag') && moved.headers.get('etag') !== etag, `another point → 200 and another ETag (${moved.status})`);
    const wider = await call('GET', bea, `/api/marketplace/posts?${hub}&radiusKm=51&sort=distance`, undefined, { 'If-None-Match': etag });
    assert(wider.status === 200 && !!wider.headers.get('etag') && wider.headers.get('etag') !== etag, `another radius → 200 and another ETag (${wider.status})`);
    process.env.NODE_PROFILE = 'global';
    // A radius keeps this to the fixture near the hub, which is older than the hundreds of posts made since; it has no
    // say in the order, which is still the profile's to choose (no sort).
    const qDefault = `/api/marketplace/posts?${hub}&radiusKm=1300&limit=200`;
    const recencyPlaced = recency.filter(id => id !== PN);
    const byDistance = await call('GET', bea, qDefault);
    const tagDistance = byDistance.headers.get('etag') ?? '';
    setOverride('distanceSortDefault', 'false');
    const byRecency = await call('GET', bea, qDefault, undefined, { 'If-None-Match': tagDistance });
    setOverride('distanceSortDefault', null);
    assert(Array.isArray(byDistance.body) && same(ids(byDistance.body), [P05, P5, P20, P60, PC]), 'setup: global, a point and no sort, nearest first');
    assert(byRecency.status === 200 && byRecency.headers.get('etag') !== tagDistance && Array.isArray(byRecency.body)
        && same(ids(byRecency.body), recencyPlaced),
        `the same URL after the order switch changed → 200, a new ETag and today's order, never a stale 304 (${byRecency.status})`);
    delete process.env.NODE_PROFILE;

    // ── 8. garbage ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. garbage parameters ──');
    const garbage = [
        'lat=91&lng=0', 'lat=-91&lng=0', 'lat=0&lng=181', 'lat=0&lng=-181', 'lat=abc&lng=0', 'lat=&lng=0', 'lat=0&lng=',
        'lat=0', 'lng=0', 'lat=NaN&lng=0', 'lat=Infinity&lng=0', 'lat=1e999&lng=0', 'lat=0x10&lng=0', 'lat=1&lat=2&lng=0',
        'lat=0&lng=0&radiusKm=0', 'lat=0&lng=0&radiusKm=-5', 'lat=0&lng=0&radiusKm=20038', 'lat=0&lng=0&radiusKm=abc',
        'lat=0&lng=0&radiusKm=', 'radiusKm=10', 'sort=distance', 'lat=0&lng=0&sort=nearest', 'sort=',
    ];
    for (const g of garbage) {
        const r = await call('GET', bea, `/api/marketplace/posts?${g}`);
        assert(r.status === 400 && typeof r.body?.error === 'string', `${g} → 400 (${r.status} ${r.body?.error ?? ''})`);
    }
    const edges = ['lat=90&lng=180&radiusKm=20037', 'lat=-90&lng=-180&radiusKm=0.001&sort=distance', 'lat=1e-7&lng=-0.5&radiusKm=1', 'sort=recent'];
    for (const e of edges) {
        const r = await call('GET', bea, `/api/marketplace/posts?${e}`);
        assert(r.status === 200 && Array.isArray(r.body), `${e} → 200 (${r.status})`);
    }

    // ── 9. the index ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. EXPLAIN QUERY PLAN ──');
    const prepare = db.prepare.bind(db);
    let captured: { sql: string; params: unknown[] } | null = null;
    (db as any).prepare = (text: string) => {
        const st = prepare(text);
        if (/FROM posts p/.test(text) && /haversine_km/.test(text)) {
            const allRows = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { captured = { sql: text, params }; return allRows(...params); };
        }
        return st;
    };
    try { await call('GET', bea, `/api/marketplace/posts?${hub}&radiusKm=25&sort=distance`); } finally { delete (db as any).prepare; }
    const c = captured as { sql: string; params: unknown[] } | null;
    const plan = c ? attempt(() => db.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...c.params) as { detail: string }[]) ?? [] : [];
    assert(!!c && plan.some(r => /idx_posts_lat_lng/.test(r.detail)),
        `the radius query the route runs searches posts with idx_posts_lat_lng (${plan.filter(r => /\bposts\b|\bp\b/.test(r.detail)).map(r => r.detail).join(' | ') || 'no query captured'})`);

    // ── 10. people ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 10. a person\'s coarse area ──');
    const areaOf = (id: Id) => attempt(() => db.prepare('SELECT area_lat, area_lng, area_updated_at, lat, lng FROM members WHERE public_key = ?').get(id.pk) as any);
    const setArea = (id: Id | null, body: unknown) => call('POST', id, '/api/community/me/area', body);
    const peopleBefore = await call('GET', bea, '/api/community/members');
    const preciseLat = -37.123456, preciseLng = 144.654321;
    const set = await setArea(ann, { lat: preciseLat, lng: preciseLng });
    assert(set.status === 200 && set.body?.area?.lat === -37.1 && set.body?.area?.lng === 144.7,
        `Ann sets her area with 6 decimals → 200, and the answer is the rounded area (${set.status} ${JSON.stringify(set.body)})`);
    const annRow = areaOf(ann);
    assert(annRow?.area_lat === -37.1 && annRow?.area_lng === 144.7 && typeof annRow?.area_updated_at === 'string',
        `the database row holds -37.1, 144.7 (got ${annRow?.area_lat}, ${annRow?.area_lng}, ${annRow?.area_updated_at})`);
    assert(annRow?.lat == null && annRow?.lng == null, 'and members.lat/lng (an enterprise\'s precise map location) are untouched');
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const files = ['state.db', 'state.db-wal'].map(f => path.join(dataDir, f)).filter(f => fs.existsSync(f));
    const bytes = Buffer.concat(files.map(f => fs.readFileSync(f)));
    const be = (x: number) => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b; };
    assert(bytes.includes(be(-37.1)) && bytes.includes(be(144.7)), `the rounded area is in the database files (the search below can find a REAL): ${files.map(f => path.basename(f)).join(', ')}`);
    assert(!bytes.includes(be(preciseLat)) && !bytes.includes(be(preciseLng)) && !bytes.includes(Buffer.from('37.123456')) && !bytes.includes(Buffer.from('144.654321')),
        'the precise coordinate is nowhere in the database or its write-ahead log, as a number or as text');
    const annMe = await call('GET', ann, '/api/community/me');
    assert(annMe.status === 200 && annMe.body?.area?.lat === -37.1 && annMe.body?.area?.lng === 144.7 && typeof annMe.body?.area?.updatedAt === 'string',
        `Ann reads her own area back from /api/community/me (${JSON.stringify(annMe.body?.area)})`);
    const beaMe = await call('GET', bea, '/api/community/me');
    assert(beaMe.status === 200 && beaMe.body?.area === null, `Bea, who set none, reads null (${JSON.stringify(beaMe.body?.area)})`);
    const deeSet = await setArea(dee, { lat: 51.507222, lng: -0.1275 });
    assert(deeSet.status === 200 && deeSet.body?.area?.lat === 51.5 && deeSet.body?.area?.lng === -0.1, `Dee sets hers in London (${JSON.stringify(deeSet.body?.area)})`);

    const [cLat, cLng] = castle;
    const annKm = Math.round(haversine(cLat, cLng, -37.1, 144.7));
    const deeKm = Math.round(haversine(cLat, cLng, 51.5, -0.1));
    for (const route of ['/api/community/members', '/api/members']) {
        const people = await call('GET', bea, `${route}?lat=${cLat}&lng=${cLng}`);
        const rows = Array.isArray(people.body) ? people.body as any[] : [];
        const at = (id: Id) => rows.findIndex(m => m.publicKey === id.pk);
        const firstNone = rows.findIndex(m => m.distanceKm === null);
        assert(people.status === 200 && rows[at(ann)]?.distanceKm === annKm && rows[at(dee)]?.distanceKm === deeKm,
            `${route} with a point: Ann is ${annKm} km and Dee ${deeKm} km away, in whole km (got ${rows[at(ann)]?.distanceKm}, ${rows[at(dee)]?.distanceKm})`);
        assert(at(ann) === 0 && at(dee) === 1 && firstNone === 2 && rows.slice(2).every(m => m.distanceKm === null),
            `${route}: nearest first, and everyone without an area after them with distanceKm null (Ann ${at(ann)}, Dee ${at(dee)}, first without ${firstNone})`);
        const keys = [...new Set(rows.flatMap(m => Object.keys(m)))];
        assert(!keys.some(k => /area|^lat$|^lng$/i.test(k)) && !people.text.includes('144.7') && !people.text.includes('-37.1,'),
            `${route}: no coordinates of anyone's area, under any name (keys: ${keys.join(', ')})`);
        const plain = await call('GET', bea, route);
        const plainRows = Array.isArray(plain.body) ? plain.body as any[] : [];
        assert(plain.status === 200 && plainRows.every(m => !('distanceKm' in m)) && !plain.text.includes('144.7'),
            `${route} without a point: no distanceKm and no area`);
        const unsigned = await call('GET', null, `${route}?lat=${cLat}&lng=${cLng}`);
        assert(unsigned.status === 401, `${route} with a point, unsigned → 401 (${unsigned.status})`);
        const stranger = await call('GET', newId('Passer-by'), `${route}?lat=${cLat}&lng=${cLng}`);
        assert(stranger.status === 403, `${route} with a point, signed by a key that is not a member → 403 (${stranger.status})`);
        const bad = await call('GET', bea, `${route}?lat=95&lng=0`);
        assert(bad.status === 400, `${route} with lat=95 → 400 (${bad.status})`);
    }
    const plainNow = await call('GET', bea, '/api/community/members');
    assert(same((plainNow.body as any[]).map(m => m.publicKey), (peopleBefore.body as any[]).map(m => m.publicKey)),
        'the People list without a point keeps its order after areas are set');

    const noSig = await setArea(null, { lat: 1, lng: 1 });
    const spoof = await setArea(bea, { publicKey: ann.pk, lat: 10, lng: 10 });
    const outsider = await setArea(newId('Outsider'), { lat: 10, lng: 10 });
    const afterRefusals = areaOf(ann);
    assert(noSig.status === 401, `setting an area unsigned → 401 (${noSig.status})`);
    assert(spoof.status === 403 && afterRefusals?.area_lat === -37.1 && afterRefusals?.area_lng === 144.7,
        `Bea signing with Ann's key in the body → 403, and Ann's area is unchanged (${spoof.status})`);
    assert(outsider.status === 403, `a signed key that is not a member → 403 (${outsider.status})`);
    const beaAfter = areaOf(bea);
    assert(beaAfter?.area_lat == null && beaAfter?.area_lng == null, 'nobody\'s area was written by the refused requests');
    for (const body of [{ lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: '12', lng: 3 }, { lat: 1 }, { lat: 1, lng: null }, {}, { lat: true, lng: 1 }]) {
        const r = await setArea(bea, body);
        assert(r.status === 400, `${JSON.stringify(body)} → 400 (${r.status} ${r.body?.error ?? ''})`);
    }
    const cleared = await setArea(ann, { lat: null, lng: null });
    const annCleared = areaOf(ann);
    assert(cleared.status === 200 && cleared.body?.area === null && annCleared?.area_lat === null && annCleared?.area_lng === null && annCleared?.area_updated_at === null,
        `Ann clears her area → 200, and all three columns are NULL (${cleared.status})`);
    const afterClear = (await call('GET', bea, `/api/community/members?lat=${cLat}&lng=${cLng}`)).body as any[];
    const annNow = Array.isArray(afterClear) ? afterClear.find(m => m.publicKey === ann.pk) : undefined;
    assert(Array.isArray(afterClear) && afterClear[0]?.publicKey === dee.pk && annNow?.distanceKm === null,
        'after clearing, Ann has no distance and Dee is the nearest');
    // Leaving takes the area with it: a deleted or pruned account can't sign the request that would clear it.
    const gus = member('Gus'), hal = member('Hal');
    await setArea(gus, { lat: 10.1, lng: 20.2 });
    await setArea(hal, { lat: 30.3, lng: 40.4 });
    assert(areaOf(gus)?.area_lat === 10.1 && areaOf(hal)?.area_lat === 30.3, 'setup: Gus and Hal have areas');
    const purged = await call('POST', gus, '/api/member/purge', {});
    const gusRow = areaOf(gus);
    assert(purged.status === 200 && gusRow?.area_lat === null && gusRow?.area_lng === null && gusRow?.area_updated_at === null,
        `a member who deletes their account leaves no area behind (${purged.status})`);
    attempt(() => adminPruneUser(hal.pk, owner.pk));
    const halRow = areaOf(hal);
    assert(halRow?.area_lat === null && halRow?.area_lng === null && halRow?.area_updated_at === null, 'nor does a member an owner prunes');
    const halAgain = await setArea(hal, { lat: 30.3, lng: 40.4 });
    const gusAgain = await setArea(gus, { lat: 10.1, lng: 20.2 });
    assert(halAgain.status === 403 && gusAgain.status === 403 && areaOf(hal)?.area_lat === null && areaOf(gus)?.area_lat === null,
        `and neither key can set one again afterwards (${halAgain.status}, ${gusAgain.status})`);
    // Nor read anyone else's distance: the key still signs and its row is still there, but it is out of the community.
    for (const route of ['/api/community/members', '/api/members']) {
        const halPeople = await call('GET', hal, `${route}?lat=${cLat}&lng=${cLng}`);
        const gusPeople = await call('GET', gus, `${route}?lat=${cLat}&lng=${cLng}`);
        assert(halPeople.status === 403 && gusPeople.status === 403 && !halPeople.text.includes('distanceKm') && !gusPeople.text.includes('distanceKm'),
            `${route} with a point, signed by the pruned or the deleted key → 403, no distances (${halPeople.status}, ${gusPeople.status})`);
    }

    // ── 11. replication, and nowhere else ────────────────────────────────────────────────────────
    console.log('\n── 11. a standby keeps the area, and nothing else carries it ──');
    await setArea(ann, { lat: preciseLat, lng: preciseLng });
    const annAt = areaOf(ann)?.area_updated_at;
    const p2p = await startP2P(4292, 4293);
    const nodeId = p2p.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4293/p2p/${nodeId}`, 'mirror', 'self-test-peer');
    const payload: any = await exportSyncState(nodeId);
    const exAnn = (payload.members ?? []).find((m: any) => m.publicKey === ann.pk);
    const exDee = (payload.members ?? []).find((m: any) => m.publicKey === dee.pk);
    assert(exAnn?.areaLat === -37.1 && exAnn?.areaLng === 144.7 && exAnn?.areaUpdatedAt === annAt && exDee?.areaLat === 51.5,
        `the replication export carries areaLat, areaLng and areaUpdatedAt (${JSON.stringify({ lat: exAnn?.areaLat, lng: exAnn?.areaLng, at: exAnn?.areaUpdatedAt })})`);
    // A standby holding an older copy of Ann (the update path), and none of Dee (the insert path).
    attempt(() => db.prepare(`UPDATE members SET area_lat = NULL, area_lng = NULL, area_updated_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?`).run(ann.pk));
    db.prepare('DELETE FROM members WHERE public_key = ?').run(dee.pk);
    db.prepare('DELETE FROM accounts WHERE public_key = ?').run(dee.pk);
    setNodeRole('backup');
    try { await importRemoteState(payload); } catch (e: any) { console.error(`  (import threw: ${e?.message})`); }
    setNodeRole('primary');
    const annBack = areaOf(ann), deeBack = areaOf(dee);
    assert(annBack?.area_lat === -37.1 && annBack?.area_lng === 144.7 && annBack?.area_updated_at === annAt, 'the standby holds Ann\'s area (update)');
    assert(deeBack?.area_lat === 51.5 && deeBack?.area_lng === -0.1, 'and Dee\'s, whom it never had (insert)');
    await p2p.stop();
    const fay = member('Fay');
    db.prepare(`UPDATE members SET updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?`).run(fay.pk);
    attempt(() => db.prepare('UPDATE members SET area_lat = 10, area_lng = 20 WHERE public_key = ?').run(fay.pk));
    const fayTouched = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(fay.pk) as any)?.updated_at;
    assert(fayTouched > '2000-01-01T00:00:00.000Z', `an UPDATE that sets only the area moves updated_at, so delta sync carries it (${fayTouched})`);

    const leaks: string[] = [];
    for (const [who, route] of [
        [bea, `/api/profile/${ann.pk}`], [null, `/api/community/membership/${ann.pk}`], [bea, '/api/community/members'],
        [bea, '/api/members'], [null, '/api/community/info'], [null, '/api/node/info'], [null, '/api/directory/info'],
        [null, '/api/enterprises/map'], [bea, '/api/activity/feed'], [bea, '/api/invite/tree'], [bea, '/api/community/me'],
    ] as Array<[Id | null, string]>) {
        const r = await call('GET', who, route);
        if (r.status !== 200) leaks.push(`${route} answered ${r.status}`);
        else if (/area_?lat|area_?lng|areaUpdatedAt|area_updated_at/i.test(r.text)) leaks.push(`${route} names an area field`);
        else if (route.includes(ann.pk) && (r.text.includes('144.7') || r.text.includes('-37.1'))) leaks.push(`${route} holds Ann's coordinates`);
    }
    assert(leaks.length === 0, `no other response carries a member's area: profile, membership, both People lists, info, node info, directory, map, activity, invite tree, someone else's /me (${leaks.join('; ') || 'none'})`);
    const replication = await call('GET', null, '/api/local/admin/sync-delta');
    assert(replication.status === 401, `the replication export itself needs the replication token (${replication.status})`);

    // ── 12. the default order, page by page ──────────────────────────────────────────────────────
    // Global's default (a point, no sort, no radius) is searched in widening circles (engine posts.ts). Through the
    // route, each reader's pages are the pages a brute-force haversine over everything that reader may see gives: the
    // hidden post only for its author, the group post only for the group, the removed post for nobody, the posts with
    // no place last.
    console.log('\n── 12. global, a point and no sort: each page is the brute-force page ──');
    process.env.NODE_PROFILE = 'global';
    const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const nearestFor = (viewer: Id, lat: number, lng: number) => getPosts({ viewerPubkey: viewer.pk, excludeEvents: true })
        .map(p => ({ id: p.id, u: p.updatedAt ?? '', c: p.createdAt, d: typeof p.lat === 'number' && typeof p.lng === 'number' ? haversine(lat, lng, p.lat, p.lng) : null }))
        .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    const readers: Array<[Id, Array<[string, number, number]>]> = [
        [bea, [['Mullumbimby', hLat, hLng], ['Fiji', -17.7, 178], ['near the North Pole', 88, 45], ['near the South Pole', -89.5, 0]]],
        [cal, [['Mullumbimby', hLat, hLng], ['on the antimeridian', -12, 180]]],
        [eve, [['Mullumbimby', hLat, hLng]]],
    ];
    for (const [viewer, places] of readers) {
        for (const [where, lat, lng] of places) {
            const ref = nearestFor(viewer, lat, lng);
            const located = ref.filter(r => r.d !== null).length;
            const offsets = new Set<number>([ref.length + 3]);
            for (let o = 0; o < 84; o += 7) offsets.add(o);
            for (const o of [located - 10, located - 4, located]) if (o >= 0) offsets.add(o);
            const wrong: number[] = [];
            let compared = 0;
            for (const offset of offsets) {
                const got = await list(viewer, `lat=${lat}&lng=${lng}&limit=7&offset=${offset}`);
                const want = ref.slice(offset, offset + 7);
                compared++;
                if (!same(ids(got), want.map(r => r.id)) || !same(got.map(p => p.distanceKm), want.map(r => r.d === null ? null : Math.round(r.d * 10) / 10))) wrong.push(offset);
            }
            assert(ref.length > 84 && wrong.length === 0,
                `${viewer.name} at ${where}: ${compared} pages of 7, each the brute-force page, the ${ref.length - located} post(s) with no place last (${wrong.length ? `wrong at offsets ${wrong.join(', ')}` : 'none wrong'})`);
        }
    }
    const firstPage = async (viewer: Id) => ids(await list(viewer, `${hub}&limit=50`));
    assert((await firstPage(eve)).includes(hidden) && !(await firstPage(bea)).includes(hidden), 'the post hidden by reports is on its author\'s first page and nobody else\'s');
    assert((await firstPage(cal)).includes(groupPost) && !(await firstPage(bea)).includes(groupPost), 'the group post is on its convenor\'s first page and not on an outsider\'s');
    const withRemoved: string[] = [];
    for (const v of [bea, cal, eve, ann]) if ((await firstPage(v)).includes(removed)) withRemoved.push(v.name);
    assert(withRemoved.length === 0, `the removed post is on nobody's first page, its author's included (${withRemoved.join(', ') || 'nobody'})`);
    delete process.env.NODE_PROFILE;

    // ── 13. a filter, on either side of the count ────────────────────────────────────────────────
    // With a filter, the circles ask how many posts the listing matches before reading posts near the reader the filter
    // may not match (engine posts.ts, the second deciding review of #1140): fewer than NEAREST_FIRST_MATCHES_PROBE, and
    // that read is the page; as many, and the circles or one pass give it. Through the route, each reader's pages are the
    // brute-force pages of what that reader may see, on both sides of it: 'bikes' is 460 posts to Bea, and 510 to Eve
    // (her 50 hidden by reports) and to Cal (his club's 50); 'garden' is over 600 to everyone, all near Mullumbimby.
    // 150 of the gardens are within 600 m, so the first circle holds more than a page and the count is asked; what it
    // finds is what the route shows each reader.
    console.log('\n── 13. global, a point and a filter: each page is the brute-force page, on either side of the count ──');
    process.env.NODE_PROFILE = 'global';
    const K = NEAREST_FIRST_MATCHES_PROBE;
    let seedState = 13;
    const rand13 = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; };
    /** `km` from a point on a random bearing, on the sphere. */
    const toward = (lat: number, lng: number, km: number): [number, number] => {
        const d = km / R_KM, b = rand13() * 2 * Math.PI, φ = lat * Math.PI / 180, λ = lng * Math.PI / 180;
        const φ2 = Math.asin(Math.sin(φ) * Math.cos(d) + Math.cos(φ) * Math.sin(d) * Math.cos(b));
        const λ2 = λ + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ), Math.cos(d) - Math.sin(φ) * Math.sin(φ2));
        return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180];
    };
    const insFiltered = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng,
                                                       audience_scope, target_group_id, hidden_by_reports_at, event_start_at, event_end_at)
                                    VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let seeded = 0;
    const seedFiltered = (author: Id, type: string, category: string, [lat, lng]: [number, number], extra: { group?: string; hidden?: boolean; ended?: boolean } = {}) => {
        const at = new Date(Date.UTC(2026, 5, 1, 0, seeded % 29)).toISOString();
        insFiltered.run(`g4-filtered-${seeded++}`, type, category, `Filtered ${seeded}`, author.pk, at, at, lat, lng,
            extra.group ? 'group' : 'public', extra.group ?? null, extra.hidden ? at : null,
            type === 'event' ? '2099-01-01T10:00:00.000Z' : null, type === 'event' ? (extra.ended ? '2020-01-01T12:00:00.000Z' : '2099-01-01T12:00:00.000Z') : null);
    };
    db.transaction(() => {
        for (let i = 0; i < 150; i++) seedFiltered(ann, 'offer', 'garden', toward(hLat, hLng, rand13() * 0.6));
        for (let i = 0; i < 470; i++) seedFiltered(ann, 'offer', 'garden', toward(hLat, hLng, 1 + rand13() * 24));
        for (let i = 0; i < 30; i++) seedFiltered(eve, 'offer', 'garden', toward(hLat, hLng, rand13() * 25), { hidden: true });
        for (let i = 0; i < 460; i++) seedFiltered(ann, 'offer', 'bikes', toward(hLat, hLng, 5 + rand13() * 3000));
        for (let i = 0; i < 50; i++) seedFiltered(eve, 'offer', 'bikes', toward(hLat, hLng, 5 + rand13() * 3000), { hidden: true });
        for (let i = 0; i < 50; i++) seedFiltered(cal, 'offer', 'bikes', toward(hLat, hLng, 5 + rand13() * 3000), { group: group.id });
        for (let i = 0; i < 40; i++) seedFiltered(ann, 'event', 'community', toward(hLat, hLng, rand13() * 4000));
        for (let i = 0; i < 10; i++) seedFiltered(ann, 'event', 'community', toward(hLat, hLng, rand13() * 40), { ended: true });
    })();
    bumpPostsVersion();
    const filteredFor = (viewer: Id, filter: { type?: string; category?: string }, lat: number, lng: number) =>
        getPosts({ viewerPubkey: viewer.pk, excludeEvents: filter.type !== 'event', ...filter })
            .map(p => ({ id: p.id, u: p.updatedAt ?? '', c: p.createdAt, d: typeof p.lat === 'number' && typeof p.lng === 'number' ? haversine(lat, lng, p.lat, p.lng) : null }))
            .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    const filters: Array<[string, { type?: string; category?: string }, string]> = [
        ['garden', { category: 'garden' }, 'category=garden'],
        ['bikes', { category: 'bikes' }, 'category=bikes'],
        ['events', { type: 'event' }, 'type=event'],
        ['a category with no posts', { category: 'nothing' }, 'category=nothing'],
    ];
    const filteredReaders: Array<[Id, Array<[string, number, number]>]> = [
        [bea, [['Mullumbimby', hLat, hLng], ['Fiji', -17.7, 178]]],
        [cal, [['Mullumbimby', hLat, hLng]]],
        [eve, [['Mullumbimby', hLat, hLng]]],
    ];
    for (const [viewer, places] of filteredReaders) {
        for (const [where, lat, lng] of places) {
            for (const [name, filter, query] of filters) {
                const ref = filteredFor(viewer, filter, lat, lng);
                const pages: Array<[number, number]> = [[50, 0], [7, 0], [7, 7], [7, 49], [7, ref.length - 3], [7, ref.length + 2]];
                for (const o of [K - 56, K - 7, K - 1, K]) pages.push([7, o]);
                pages.push([50, K - 50]);
                const wrong: string[] = [];
                for (const [limit, offset] of pages) {
                    if (offset < 0) continue;
                    const got = await list(viewer, `lat=${lat}&lng=${lng}&${query}&limit=${limit}&offset=${offset}`);
                    const want = ref.slice(offset, offset + limit);
                    if (!same(ids(got), want.map(r => r.id)) || !same(got.map(p => p.distanceKm), want.map(r => r.d === null ? null : Math.round(r.d * 10) / 10))) wrong.push(`${limit}@${offset}`);
                }
                assert(wrong.length === 0,
                    `${viewer.name} at ${where}, ${name} (${ref.length} ${ref.length < K ? 'fewer' : 'no fewer'} than ${K}): every page is the brute-force page (${wrong.length ? `wrong: ${wrong.join(', ')}` : 'none wrong'})`);
            }
        }
    }
    // What the count found, read by read, from Mullumbimby.
    const counted = async (viewer: Id, query: string) => {
        const prepare = db.prepare.bind(db);
        const found: Array<{ cap: number; matched: number | undefined }> = [];
        (db as any).prepare = (sql: string) => {
            const st = prepare(sql);
            if (/WITH matches AS MATERIALIZED/.test(sql)) {
                const all = st.all.bind(st);
                (st as any).all = (...params: unknown[]) => {
                    const out = all(...params) as Array<{ matched: number }>;
                    found.push({ cap: params[params.length - 5] as number, matched: out[0]?.matched });
                    return out;
                };
            }
            return st;
        };
        try { await list(viewer, `${hub}&${query}&limit=50`); } finally { delete (db as any).prepare; }
        return found;
    };
    const told = (f: Array<{ cap: number; matched: number | undefined }>) => f.map(c => `asked for ${c.cap}, found ${c.matched === undefined ? 'none' : c.matched === c.cap ? `${c.cap} (as many)` : c.matched}`).join('; ') || 'not asked';
    const beaBikes = await counted(bea, 'category=bikes'), eveBikes = await counted(eve, 'category=bikes'), calBikes = await counted(cal, 'category=bikes');
    assert(beaBikes.length === 1 && beaBikes[0].cap === K && beaBikes[0].matched === 460,
        `the count sees what the route shows Bea: 460 bikes, fewer than ${K}, so that read is her page (${told(beaBikes)})`);
    assert([eveBikes, calBikes].every(f => f.length === 1 && f[0].matched === K),
        `and Eve's hidden posts and Cal's club posts are in theirs: it stops at ${K} (Eve: ${told(eveBikes)}; Cal: ${told(calBikes)})`);
    const garden = await counted(bea, 'category=garden'), events = await counted(bea, 'type=event'), nothing = await counted(bea, 'category=nothing');
    assert(garden.length === 1 && garden[0].matched === K && events.length === 1 && events[0].matched === 40 && nothing.length === 1 && nothing[0].matched === undefined,
        `garden stops at ${K}, the events still to come are 40, and the empty category is none (${told(garden)}; ${told(events)}; ${told(nothing)})`);
    const bikesFor = (viewer: Id) => filteredFor(viewer, { category: 'bikes' }, hLat, hLng).length;
    assert(bikesFor(bea) < K && bikesFor(eve) >= K && bikesFor(cal) >= K && filteredFor(bea, { category: 'garden' }, hLat, hLng).length >= K,
        `the reads fall on both sides of ${K}: bikes is ${bikesFor(bea)} to Bea, ${bikesFor(eve)} to Eve and ${bikesFor(cal)} to Cal; garden is ${filteredFor(bea, { category: 'garden' }, hLat, hLng).length}`);
    const eventsSeen = filteredFor(bea, { type: 'event' }, hLat, hLng).length;
    assert(eventsSeen === 40, `the events that have ended are in no page (${eventsSeen} of the 50 seeded)`);
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Posts are found by distance, the lobby sorts nearest-first, and a person is never placed better than a 10 km area.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
