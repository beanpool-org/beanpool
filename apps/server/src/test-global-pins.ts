/**
 * Test Suite: where anyone can join in a minute (`openMembership`, the global node), a member reads other people's listing
 * places to about a kilometre (DESIGN-global-member-privacy-fable.md §4 and §7 slice 4; Marty's call 1, 15 Oct 2026).
 *
 * Boots the real server and reads through the real middleware over HTTPS, signed, as members of different standing:
 *   1. A local community (NODE_PROFILE unset): every member reads every place exactly, as before. With
 *      GLOBAL_PINS_BODIES_OUT set, the status and body of each read is written there, so a run on the base branch and one
 *      on this branch can be compared byte for byte.
 *   2. The global node, 200 listings at random points:
 *      - another member's read, every form (the list, nearest-first from five points, by id, `ids=`, the sync delta, their
 *        own set `nearby=1`): each place is the neighbourhood (lat and lng each to 0.01°), each distance whole km from it,
 *        the nearest-first order is the neighbourhoods' order, and a radius keeps exactly the listings whose
 *        neighbourhood is inside it;
 *      - the author's own read: every place exact, distances to 0.1 km from the place, as before;
 *      - a listing 49.98 km from a point whose neighbourhood is 50.04 km away: out of a member's 50 km radius and out of
 *        their landing card's count, in its author's;
 *      - an event whose host lets people in: exact for the host and the person let in, the neighbourhood for the one still
 *        waiting and for everyone else; let in through the route, the waiting member's next read (If-None-Match their old
 *        ETag) is answered whole, exact; an event whose host switched it off: exact for everyone Going;
 *      - an enterprise's listing: exact for its keeper, the neighbourhood for everyone else;
 *      - the Home screen's market card: whole km from each neighbourhood;
 *      - a listing's socket copy: exact to its author, the neighbourhood to another member, even when the copy was read
 *        for someone else (an RSVP's, already rounded);
 *      - WHICH sockets get a new listing's copy (state-engine.ts listingReach, 250 km from each member's 0.1° area): for 3
 *        listings posted through the route, about 25 members each set their area through the route at the 0.1° grid
 *        points 250 ± 0.8 km from the listing's neighbourhood; the members who get the copy are exactly those within
 *        250 km of the neighbourhood, and for at least one listing that differs from who is within 250 km of the place,
 *        so the check can tell (#1965 deciding review B1: from the place, ~25 such yes-or-no answers put it to ~100 m);
 *      - and a member who has the place exactly (let in to an event whose host lets people in) is reached as their set
 *        holds it, from the place: on a ring point within 250 km of the place but not of its neighbourhood, she gets the
 *        copy, exact, when someone taps Going, and a member there who isn't let in gets nothing, with the sockets' index
 *        on and off (#1965 confirmation finding 2: measuring her from the neighbourhood, or leaving her out of the
 *        index's parties, both passed before).
 *   3. The operator's override `nodeProfile.openMembership = false` on the global node: every place exact again.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-global-pins)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import { localFetch } from './keepalive-test-fetch.js';

// With GLOBAL_PINS_LOG_OUT set, everything this run prints is also written there (the runner keeps no log of a passing run).
if (process.env.GLOBAL_PINS_LOG_OUT) {
    const out = process.env.GLOBAL_PINS_LOG_OUT;
    fs.writeFileSync(out, '');
    for (const k of ['log', 'error'] as const) {
        const write = console[k].bind(console);
        console[k] = (...args: unknown[]) => { write(...args); fs.appendFileSync(out, args.map(String).join(' ') + '\n'); };
    }
}

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

/** A fixed key per name, so two runs (the base branch and this one) seed the same members and answer the same bytes. */
function keypair(name: string): Id {
    const seed = crypto.createHash('sha256').update(`global-pins:${name}`).digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubKeyHex: pub, privateKey };
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

type Answer = { status: number; text: string; body: any; headers: Headers };
async function get(p: string, id: Id | null, extra: Record<string, string> = {}): Promise<Answer> {
    const res = await localFetch(`${BASE}${p}`, { headers: { ...(id ? signedHeaders('GET', p, '', id) : {}), ...extra } });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, headers: res.headers };
}
async function post(p: string, payload: unknown, id: Id): Promise<Answer> {
    const raw = JSON.stringify(payload);
    const res = await localFetch(`${BASE}${p}`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', p, raw, id) } });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, headers: res.headers };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}
interface Sock { ws: WebSocket; raw: string[] }
function openSocket(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', (d) => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}
const listingCopies = (s: Sock) => s.raw.map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(e => e && (e.type === 'new_post' || e.type === 'post_updated') && e.post);

/** Seeded, so a failure reproduces. */
function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const R_KM = 6371;
const rad = (d: number) => d * Math.PI / 180;
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return R_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
/** The neighbourhood, as the node rounds it: 0.01° to the nearest step, halves up, never -0. */
const nbhd = (deg: number) => Math.round(deg * 100) / 100 + 0;

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const STARTED = Date.now() - 60_000;
const FUTURE_START = '2099-06-01T10:00:00.000Z';
const FUTURE_END = '2099-06-01T12:00:00.000Z';

async function main() {
    console.log('Where anyone can join in a minute, a member reads other people\'s places to about a kilometre...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    // ── Seed: the same members and listings on every run ──
    const insMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury,
                                   area_lat, area_lng, area_updated_at, profile_updated_at)
                               VALUES (@pk, @callsign, 'active', @joined, 'genesis', 'TEST', @treasury, @lat, @lng, @areaAt, NULL)`);
    let n = 0;
    const member = (name: string, area: { lat: number; lng: number } | null, treasury = 0): Id => {
        const id = keypair(name);
        insMember.run({ pk: id.pubKeyHex, callsign: name, joined: iso(T0 + 60_000 * n++), treasury,
            lat: area?.lat ?? null, lng: area?.lng ?? null, areaAt: area ? iso(T0) : null });
        return id;
    };
    const alice = member('Alice', { lat: -28.6, lng: 153.5 });
    const bob = member('Bob', { lat: -28.6, lng: 153.6 });
    const carol = member('Carol', { lat: -28.7, lng: 153.6 });
    const dan = member('Dan', { lat: -28.7, lng: 153.5 });
    const kim = member('Kim', { lat: -28.6, lng: 153.6 });
    const shop = member('Bangalow Bakery', null, 1);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at) VALUES (?, ?, 'lead', ?)").run(shop.pubKeyHex, kim.pubKeyHex, iso(T0));

    const insPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng,
                                                   event_start_at, event_end_at, event_private_note, event_host_lets_in, audience_scope)
                                VALUES (@id, @type, 'general', @title, '', 0, @author, @at, @at, @lat, @lng, @start, @end, @note, @letsIn, 'public')`);
    const place = new Map<string, { lat: number; lng: number }>();
    const listing = (id: string, author: Id, lat: number, lng: number, i: number, ev?: { note: string; letsIn: number }) => {
        insPost.run({ id, type: ev ? 'event' : i % 3 === 0 ? 'need' : 'offer', title: `Listing ${id}`, author: author.pubKeyHex, at: iso(T0 + 3_600_000 + i * 60_000),
            lat, lng, start: ev ? FUTURE_START : null, end: ev ? FUTURE_END : null, note: ev?.note ?? null, letsIn: ev ? ev.letsIn : null });
        place.set(id, { lat, lng });
    };
    // 200 places at random within about 55 km of the hinterland, to six decimals as a phone sends them.
    const rand = prng(20261015);
    const six = (x: number) => Math.round(x * 1e6) / 1e6;
    const RANDOM: string[] = [];
    for (let i = 0; i < 200; i++) {
        const id = `pin-${String(i).padStart(3, '0')}`;
        listing(id, alice, six(-28.65 + (rand() - 0.5)), six(153.55 + (rand() - 0.5)), i);
        RANDOM.push(id);
    }
    // 49.98 km due north of EDGE_FROM, its neighbourhood 50.04 km: inside a 50 km radius exactly, outside it by neighbourhood.
    const EDGE_FROM = { lat: 10, lng: 20 };
    listing('edge', alice, 10.4495, 20, 300);
    // The bakery's listing (its keeper's to edit), and two events of Alice's: one where she lets people in, one where she
    // switched it off.
    listing('bakery', shop, -28.642371, 153.561234, 301);
    listing('ev-gate', alice, -28.661234, 153.598765, 302, { note: 'Blue gate, number 12', letsIn: 1 });
    listing('ev-park', alice, -28.633333, 153.577777, 303, { note: 'Bring gloves', letsIn: 0 });
    const insRsvp = db.prepare("INSERT INTO event_rsvps (post_id, member_pubkey, status, signature, let_in_at, let_in_by, updated_at) VALUES (?, ?, 'going', 'test', ?, ?, ?)");
    insRsvp.run('ev-gate', carol.pubKeyHex, iso(T0 + 7_200_000), alice.pubKeyHex, iso(T0 + 7_200_000));
    insRsvp.run('ev-gate', dan.pubKeyHex, null, null, iso(T0 + 7_200_000));
    insRsvp.run('ev-park', dan.pubKeyHex, null, null, iso(T0 + 7_200_000));
    const ALL_TYPES = 'types=offer,need,poll,event';
    const POINTS = [{ lat: -28.65, lng: 153.55 }, { lat: -28.3, lng: 153.2 }, { lat: -29.1, lng: 153.9 }, { lat: -28.649, lng: 153.551 }, { lat: -27.5, lng: 153.0 }];

    /** Every listing of these answers: the posts whose place the suite set. */
    const ours = (body: any): any[] => (Array.isArray(body) ? body : body?.posts ?? []).filter((p: any) => place.has(p.id));
    const pageAll = async (base: string, who: Id) => {
        const out: any[] = [];
        for (const offset of [0, 200]) {
            const r = await get(`${base}${base.includes('?') ? '&' : '?'}limit=200&offset=${offset}`, who);
            if (r.status !== 200) throw new Error(`${base} → ${r.status} ${r.text.slice(0, 120)}`);
            out.push(...(Array.isArray(r.body) ? r.body : []));
        }
        return out;
    };
    const exactOf = (p: any) => { const t = place.get(p.id)!; return p.lat === t.lat && p.lng === t.lng; };
    const neighbourhoodOf = (p: any) => { const t = place.get(p.id)!; return p.lat === nbhd(t.lat) && p.lng === nbhd(t.lng); };

    /** The bytes of a run that change from run to run: the node's own key and the times this run wrote, named, not printed. */
    const runOwn = (db.prepare("SELECT public_key FROM members WHERE public_key != 'SYSTEM'").all() as { public_key: string }[]).map(r => r.public_key)
        .filter(k => ![alice, bob, carol, dan, kim, shop].some(m => m.pubKeyHex === k));
    const normalise = (text: string) => {
        let s = text;
        runOwn.forEach((v, i) => { s = s.split(v).join(`<run-own-${i}>`); });
        return s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, (t) => {
            const ms = Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
            return Number.isFinite(ms) && ms >= STARTED ? '<this-run>' : t;
        });
    };
    const q0 = POINTS[0];
    const READS: Array<[string, string, Id]> = [
        ['list', `/api/marketplace/posts?${ALL_TYPES}&limit=200`, bob],
        ['nearest-first', `/api/marketplace/posts?${ALL_TYPES}&lat=${q0.lat}&lng=${q0.lng}&sort=distance&limit=200`, bob],
        ['radius 20 km', `/api/marketplace/posts?${ALL_TYPES}&lat=${q0.lat}&lng=${q0.lng}&radiusKm=20&sort=distance&limit=200`, bob],
        ['by id', '/api/marketplace/posts?id=pin-007', bob],
        ['ids sync', '/api/marketplace/posts?ids=pin-001,pin-002,ev-gate&sync=true', bob],
        ['delta', `/api/marketplace/posts?${ALL_TYPES}&updatedAfter=1970-01-01T00:00:00.000Z&sync=true&limit=200`, bob],
        ['author list', `/api/marketplace/posts?${ALL_TYPES}&limit=200`, alice],
        ['waiting event', '/api/marketplace/posts?id=ev-gate', dan],
        ['home', `/api/home?cards=market,events&lat=${q0.lat}&lng=${q0.lng}`, bob],
        ['landing', `/api/global/home?lat=${EDGE_FROM.lat}&lng=${EDGE_FROM.lng}`, bob],
    ];

    // ── 1. A local community: every place exact ──
    console.log('── 1. A local community (NODE_PROFILE unset) ──');
    const localBodies: Record<string, { status: number; body: string }> = {};
    for (const [label, p, who] of READS) {
        const r = await get(p, who);
        localBodies[label] = { status: r.status, body: normalise(r.text) };
    }
    if (process.env.GLOBAL_PINS_BODIES_OUT) {
        fs.writeFileSync(process.env.GLOBAL_PINS_BODIES_OUT, JSON.stringify(localBodies, null, 1));
        console.log(`  (every local read's status and body written to ${process.env.GLOBAL_PINS_BODIES_OUT})`);
    }
    const localList = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}`, bob));
    assert(localList.length === place.size && localList.every(exactOf),
        `local: another member reads every place exactly (${localList.filter(exactOf).length} of ${localList.length}, ${place.size} seeded)`);
    const localEdge = await get(`/api/marketplace/posts?${ALL_TYPES}&lat=${EDGE_FROM.lat}&lng=${EDGE_FROM.lng}&radiusKm=50&sort=distance`, bob);
    assert(ours(localEdge.body).some(p => p.id === 'edge'), 'local: the listing 49.98 km away is inside another member\'s 50 km radius, as before');

    // ── 2. The global node ──
    console.log('\n── 2. The global node (NODE_PROFILE=global) ──');
    process.env.NODE_PROFILE = 'global';
    const info = (await get('/api/community/info', bob)).body?.features ?? {};
    assert(info.openMembership === true, 'global: features.openMembership is true');

    // The list, read whole.
    const list = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}`, bob));
    const randomRead = list.filter(p => RANDOM.includes(p.id));
    const wrongPlaces = randomRead.filter(p => !neighbourhoodOf(p)).map(p => `${p.id} ${p.lat},${p.lng}`);
    assert(randomRead.length === 200 && wrongPlaces.length === 0,
        `global: another member reads each of the 200 random places as its neighbourhood, lat and lng to 0.01° (${200 - wrongPlaces.length} of ${randomRead.length}${wrongPlaces.length ? `; e.g. ${wrongPlaces.slice(0, 3).join('; ')}` : ''})`);
    assert(randomRead.some(p => !exactOf(p)), 'global: and that is not the place itself (the check can tell)');
    const authorList = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}`, alice)).filter(p => RANDOM.includes(p.id));
    assert(authorList.length === 200 && authorList.every(exactOf), `global: the author reads every one of her own exactly (${authorList.filter(exactOf).length} of ${authorList.length})`);

    // Nearest-first from five points: whole km from each neighbourhood, in the neighbourhoods' order; the author's to 0.1 km.
    for (const q of POINTS) {
        const rows = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}&lat=${q.lat}&lng=${q.lng}&sort=distance`, bob)).filter(p => RANDOM.includes(p.id));
        const km = (p: any) => { const t = place.get(p.id)!; return haversine(q.lat, q.lng, nbhd(t.lat), nbhd(t.lng)); };
        const badKm = rows.filter(p => !Number.isInteger(p.distanceKm) || p.distanceKm !== Math.round(km(p)));
        let ordered = true;
        for (let i = 1; i < rows.length; i++) if (km(rows[i]) + 1e-9 < km(rows[i - 1])) ordered = false;
        assert(rows.length === 200 && rows.every(neighbourhoodOf) && badKm.length === 0 && ordered,
            `global, from (${q.lat}, ${q.lng}): 200 places to the neighbourhood, each distance whole km from it, in its order (${rows.length} rows, ${badKm.length} distances off, ordered ${ordered})`);
        const own = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}&lat=${q.lat}&lng=${q.lng}&sort=distance`, alice)).filter(p => RANDOM.includes(p.id));
        const ownKm = own.filter(p => { const t = place.get(p.id)!; return p.distanceKm === Math.round(haversine(q.lat, q.lng, t.lat, t.lng) * 10) / 10; });
        assert(own.length === 200 && own.every(exactOf) && ownKm.length === 200,
            `global, from (${q.lat}, ${q.lng}): the author's own are exact, distances to 0.1 km from the place (${ownKm.length} of ${own.length})`);
    }
    // A radius keeps the listings whose neighbourhood is inside it.
    for (const radiusKm of [5, 20, 40]) {
        const rows = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}&lat=${q0.lat}&lng=${q0.lng}&radiusKm=${radiusKm}&sort=distance`, bob)).filter(p => RANDOM.includes(p.id));
        const want = RANDOM.filter(id => { const t = place.get(id)!; return haversine(q0.lat, q0.lng, nbhd(t.lat), nbhd(t.lng)) <= radiusKm; });
        assert(JSON.stringify(rows.map(p => p.id).sort()) === JSON.stringify(want.sort()),
            `global: a ${radiusKm} km radius keeps exactly the ${want.length} listings whose neighbourhood is inside it (got ${rows.length})`);
    }
    const edgeOther = await get(`/api/marketplace/posts?${ALL_TYPES}&lat=${EDGE_FROM.lat}&lng=${EDGE_FROM.lng}&radiusKm=50&sort=distance`, bob);
    const edgeOwn = await get(`/api/marketplace/posts?${ALL_TYPES}&lat=${EDGE_FROM.lat}&lng=${EDGE_FROM.lng}&radiusKm=50&sort=distance`, alice);
    assert(edgeOther.status === 200 && !ours(edgeOther.body).some(p => p.id === 'edge'),
        `global: the listing 49.98 km away (its neighbourhood 50.04 km) is outside another member's 50 km radius (got ${edgeOther.status} ${ours(edgeOther.body).map(p => p.id)})`);
    assert(ours(edgeOwn.body).some(p => p.id === 'edge' && p.distanceKm === 50), `global: and inside its author's (${JSON.stringify(ours(edgeOwn.body).map(p => [p.id, p.distanceKm]))})`);
    // The landing card's count from the same point: the neighbourhood for another member, the place for the author.
    const landOther = await get(`/api/global/home?lat=${EDGE_FROM.lat}&lng=${EDGE_FROM.lng}`, bob);
    const landOwn = await get(`/api/global/home?lat=${EDGE_FROM.lat}&lng=${EDGE_FROM.lng}`, alice);
    assert(landOther.status === 200 && landOther.body?.nearbyPosts?.count === 0,
        `global: another member's landing card counts 0 listings within 50 km there, from the neighbourhood (got ${landOther.status} ${JSON.stringify(landOther.body?.nearbyPosts)})`);
    assert(landOwn.body?.nearbyPosts?.count === 1, `global: the author's counts her own, 1 (got ${JSON.stringify(landOwn.body?.nearbyPosts)})`);

    // By id, ids=, the sync delta, and the member's own set.
    const byId = await get('/api/marketplace/posts?id=pin-007', bob);
    assert(byId.status === 200 && byId.body.length === 1 && neighbourhoodOf(byId.body[0]) && !exactOf(byId.body[0]),
        `global: by id, another member reads the neighbourhood (${JSON.stringify(byId.body?.[0] && [byId.body[0].lat, byId.body[0].lng])}, the place ${JSON.stringify(place.get('pin-007'))})`);
    const byIdOwn = await get('/api/marketplace/posts?id=pin-007', alice);
    assert(byIdOwn.status === 200 && exactOf(byIdOwn.body[0]), 'global: by id, the author reads the place (her edit form loads the exact pin)');
    const idsSync = await get('/api/marketplace/posts?ids=pin-001,pin-002,pin-003&sync=true', bob);
    assert(idsSync.status === 200 && ours(idsSync.body).length === 3 && ours(idsSync.body).every(neighbourhoodOf),
        `global: ids= (the phone's fetch of what it lacks) reads each neighbourhood (got ${idsSync.status} ${ours(idsSync.body).length})`);
    const delta = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}&updatedAfter=1970-01-01T00:00:00.000Z&sync=true`, bob)).filter(p => RANDOM.includes(p.id));
    assert(delta.length === 200 && delta.every(neighbourhoodOf), `global: the phone's sync delta reads each neighbourhood (${delta.filter(neighbourhoodOf).length} of ${delta.length})`);
    const set = await get(`/api/marketplace/posts?nearby=1&${ALL_TYPES}&limit=200`, bob);
    const setRows = ours(set.body).filter((p: any) => RANDOM.includes(p.id));
    assert(set.status === 200 && setRows.length > 0 && setRows.every(neighbourhoodOf),
        `global: a member's own set (nearby=1) reads each neighbourhood (got ${set.status}, ${setRows.filter(neighbourhoodOf).length} of ${setRows.length})`);
    const ownSet = await get(`/api/marketplace/posts?nearby=1&${ALL_TYPES}&limit=200`, alice);
    assert(ownSet.status === 200 && ours(ownSet.body).filter((p: any) => RANDOM.includes(p.id)).every(exactOf), 'global: and the author\'s own set reads her places');

    // Events: the host and the people let in have the spot, the people still waiting and everyone else the neighbourhood.
    const eventFor = async (id: string, who: Id) => (await get(`/api/marketplace/posts?id=${id}`, who)).body?.[0];
    const gateHost = await eventFor('ev-gate', alice), gateIn = await eventFor('ev-gate', carol), gateWaiting = await eventFor('ev-gate', dan), gateOther = await eventFor('ev-gate', bob);
    assert(exactOf(gateHost) && exactOf(gateIn), 'global: an event whose host lets people in: exact for the host and for the person let in');
    assert(neighbourhoodOf(gateWaiting) && !exactOf(gateWaiting) && gateWaiting.eventPrivateNote === undefined,
        `global: the neighbourhood for the one still waiting, and no note (${JSON.stringify([gateWaiting?.lat, gateWaiting?.lng, gateWaiting?.myLetIn])})`);
    assert(neighbourhoodOf(gateOther) && !exactOf(gateOther), 'global: and for a member not going');
    const park = await eventFor('ev-park', dan), parkOther = await eventFor('ev-park', bob);
    assert(exactOf(park) && park.eventPrivateNote === 'Bring gloves', 'global: where the host switched letting in off, everyone Going has the spot and the note (the one rule)');
    assert(neighbourhoodOf(parkOther), 'global: and a member not going the neighbourhood');
    // An enterprise's listing: its keeper edits it, so its keeper has it exactly.
    assert(exactOf(await eventFor('bakery', kim)), 'global: an enterprise\'s listing is exact for its keeper');
    assert(neighbourhoodOf(await eventFor('bakery', bob)), 'global: and the neighbourhood for everyone else');

    // Let in through the route: the waiting member's copy, held with its ETag, is never confirmed; the next read is exact.
    const LIST = `/api/marketplace/posts?${ALL_TYPES}&limit=200`;
    const held = await get(LIST, dan);
    const heldTag = held.headers.get('etag') ?? '';
    assert(held.status === 200 && neighbourhoodOf(ours(held.body).find(p => p.id === 'ev-gate')), 'global: Dan\'s list holds the gate event\'s neighbourhood while he waits');
    const unchanged = await get(LIST, dan, { 'If-None-Match': heldTag });
    assert(unchanged.status === 304, `global: nothing changed, so his copy is confirmed (got ${unchanged.status})`);
    const letIn = await post('/api/marketplace/posts/ev-gate/let-in', { memberPublicKey: dan.pubKeyHex }, alice);
    assert(letIn.status === 200, `global: the host lets Dan in (got ${letIn.status} ${letIn.text.slice(0, 120)})`);
    const after = await get(LIST, dan, { 'If-None-Match': heldTag });
    assert(after.status === 200 && exactOf(ours(after.body).find(p => p.id === 'ev-gate')),
        `global: his next read with the old ETag is answered whole, with the spot (got ${after.status})`);

    // The Home screen's market card (listings of the last 14 days): whole km from each neighbourhood.
    db.prepare(`UPDATE posts SET created_at = ? WHERE id IN (${RANDOM.slice(0, 10).map(() => '?').join(',')})`).run(iso(Date.now() - 30_000), ...RANDOM.slice(0, 10));
    const home =await get(`/api/home?cards=market,events&lat=${q0.lat}&lng=${q0.lng}`, bob);
    const market = (home.body?.cards?.market?.items ?? home.body?.cards?.market ?? []) as any[];
    const marketRows = Array.isArray(market) ? market.filter(m => RANDOM.includes(m.id)) : [];
    const homeKmOk = marketRows.every(m => { const t = place.get(m.id)!; return m.distanceKm === Math.round(haversine(q0.lat, q0.lng, nbhd(t.lat), nbhd(t.lng))); });
    assert(home.status === 200 && marketRows.length > 0 && homeKmOk,
        `global: Home's market card measures each listing from its neighbourhood, whole km (${marketRows.length} rows, ${homeKmOk ? 'all' : 'not all'} as the neighbourhood's)`);

    // The socket copies of a listing's event.
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const aliceSock = await openSocket(`${wsBase}?${signedWsQuery(alice)}`);
    const bobSock = await openSocket(`${wsBase}?${signedWsQuery(bob)}`);
    await sleep(300);
    const t = place.get('pin-011')!;
    // As an RSVP's or a vote's copy is: read for someone else, its place already the neighbourhood.
    se.broadcast({ type: 'post_updated', post: { id: 'pin-011', type: 'offer', authorPublicKey: alice.pubKeyHex, title: 'Listing pin-011', lat: nbhd(t.lat), lng: nbhd(t.lng), audienceScope: 'public' } });
    await sleep(500);
    const aliceCopy = listingCopies(aliceSock).find(e => e.post.id === 'pin-011');
    const bobCopy = listingCopies(bobSock).find(e => e.post.id === 'pin-011');
    assert(!!aliceCopy && aliceCopy.post.lat === t.lat && aliceCopy.post.lng === t.lng,
        `global: a listing's socket copy reaches its author with the place, even sent from someone else's read (got ${JSON.stringify(aliceCopy?.post && [aliceCopy.post.lat, aliceCopy.post.lng])})`);
    assert(!!bobCopy && bobCopy.post.lat === nbhd(t.lat) && bobCopy.post.lng === nbhd(t.lng),
        `global: and another member's socket with the neighbourhood (got ${JSON.stringify(bobCopy?.post && [bobCopy.post.lat, bobCopy.post.lng])})`);
    aliceSock.ws.close();
    bobSock.ws.close();

    // Which sockets get a new listing's copy at all: measured from its neighbourhood, never from the place.
    const REACH_KM = 250;
    /** The 0.1° grid points (areas are stored on it) whose distance to `c` is within `band` km of the radius. */
    const ring = (c: { lat: number; lng: number }, band: number) => {
        const out: Array<{ lat: number; lng: number }> = [];
        const dLat = REACH_KM / 111.2 + 0.2, dLng = dLat / Math.cos(rad(c.lat)) + 0.2;
        for (let la = Math.round((c.lat - dLat) * 10); la <= Math.round((c.lat + dLat) * 10); la++) {
            for (let lo = Math.round((c.lng - dLng) * 10); lo <= Math.round((c.lng + dLng) * 10); lo++) {
                const A = { lat: la / 10, lng: lo / 10 };
                if (Math.abs(haversine(A.lat, A.lng, c.lat, c.lng) - REACH_KM) < band) out.push(A);
            }
        }
        return out;
    };
    const reachRand = prng(77);
    let tellsApart = 0;
    for (let k = 0; k < 3; k++) {
        const P = { lat: six(-33.9 + (reachRand() - 0.5) * 0.4), lng: six(151.1 + (reachRand() - 0.5) * 0.4) };
        const c = { lat: nbhd(P.lat), lng: nbhd(P.lng) };
        const watchers: Array<{ A: { lat: number; lng: number }; s: Sock }> = [];
        for (const [i, A] of ring(c, 0.8).entries()) {
            const id = member(`Ring ${k}-${i}`, null);
            const r = await post('/api/community/me/area', { lat: A.lat, lng: A.lng }, id);
            if (r.status !== 200) throw new Error(`area ${r.status} ${r.text.slice(0, 120)}`);
            watchers.push({ A: { lat: r.body.area.lat, lng: r.body.area.lng }, s: await openSocket(`${wsBase}?${signedWsQuery(id)}`) });
        }
        const authorSock = await openSocket(`${wsBase}?${signedWsQuery(alice)}`);
        await sleep(300);
        const made = await post('/api/marketplace/posts', { type: 'offer', category: 'general', title: `Reach ${k}`, description: 'Spare seedlings',
            credits: 0, authorPublicKey: alice.pubKeyHex, lat: P.lat, lng: P.lng }, alice);
        const newId = made.body?.id ?? made.body?.post?.id;
        await sleep(800);
        const got = (s: Sock) => s.raw.some(x => { try { const e = JSON.parse(x); return (e.post?.id ?? e.id) === newId; } catch { return false; } });
        const byCell = watchers.map(w => haversine(w.A.lat, w.A.lng, c.lat, c.lng) <= REACH_KM);
        const byPlace = watchers.map(w => haversine(w.A.lat, w.A.lng, P.lat, P.lng) <= REACH_KM);
        const received = watchers.map(w => got(w.s));
        const asCell = received.every((g, i) => g === byCell[i]);
        if (byCell.some((b, i) => b !== byPlace[i])) tellsApart++;
        const copies = watchers.flatMap(w => w.s.raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(e => e?.post?.id === newId));
        assert((made.status === 200 || made.status === 201) && !!newId && watchers.length >= 15 && asCell && received.some(Boolean) && received.some(g => !g),
            `global: listing ${k} posted through the route reaches exactly the ${byCell.filter(Boolean).length} of ${watchers.length} members within ${REACH_KM} km of its neighbourhood (got ${received.filter(Boolean).length}; within ${REACH_KM} km of the place: ${byPlace.filter(Boolean).length}; ${made.status})`);
        assert(copies.every(e => e.post.lat === c.lat && e.post.lng === c.lng) && got(authorSock),
            `global: and each of them gets the neighbourhood, the author her copy (${[...new Set(copies.map(e => `${e.post.lat},${e.post.lng}`))].join(' ')})`);
        for (const w of watchers) w.s.ws.close();
        authorSock.ws.close();
    }
    assert(tellsApart >= 1, `global: for ${tellsApart} of 3 listings who is within ${REACH_KM} km of the neighbourhood differs from who is within it of the place, so the check can tell`);

    // A member who has the place exactly is measured from the place, and visited as a party whatever the index finds.
    const exactRand = prng(91);
    let target: { P: { lat: number; lng: number }; A: { lat: number; lng: number } } | null = null;
    for (let tries = 0; tries < 40 && !target; tries++) {
        const P = { lat: six(-33.9 + (exactRand() - 0.5) * 0.4), lng: six(151.1 + (exactRand() - 0.5) * 0.4) };
        const c = { lat: nbhd(P.lat), lng: nbhd(P.lng) };
        const A = ring(c, 0.8).find(a => haversine(a.lat, a.lng, P.lat, P.lng) <= REACH_KM && haversine(a.lat, a.lng, c.lat, c.lng) > REACH_KM);
        if (A) target = { P, A };
    }
    if (!target) throw new Error('no ring point within reach of the place but not of its neighbourhood');
    listing('ev-ring', alice, target.P.lat, target.P.lng, 304, { note: 'Side gate', letsIn: 1 });
    const lin = member('Lin', null), wes = member('Wes', null);
    for (const who of [lin, wes]) {
        const r = await post('/api/community/me/area', { lat: target.A.lat, lng: target.A.lng }, who);
        if (r.status !== 200) throw new Error(`area ${r.status} ${r.text.slice(0, 120)}`);
    }
    insRsvp.run('ev-ring', lin.pubKeyHex, iso(T0 + 7_200_000), alice.pubKeyHex, iso(T0 + 7_200_000));
    const linSock = await openSocket(`${wsBase}?${signedWsQuery(lin)}`);
    const wesSock = await openSocket(`${wsBase}?${signedWsQuery(wes)}`);
    await sleep(300);
    const ringCopies = (s: Sock) => s.raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(e => e?.post?.id === 'ev-ring');
    for (const [indexOn, status] of [[true, 'going'], [false, 'interested']] as const) {
        se.setListingPushIndex(indexOn);
        linSock.raw.length = 0; wesSock.raw.length = 0;
        const tapped = await post('/api/marketplace/posts/ev-ring/rsvp', { status }, dan);
        await sleep(800);
        const linGot = ringCopies(linSock), wesGot = ringCopies(wesSock);
        assert(tapped.status === 200 && linGot.length > 0 && linGot.every(e => e.post.lat === target!.P.lat && e.post.lng === target!.P.lng),
            `global (index ${indexOn ? 'on' : 'off'}): a member let in, ${haversine(target.A.lat, target.A.lng, target.P.lat, target.P.lng).toFixed(2)} km from the place and ${haversine(target.A.lat, target.A.lng, nbhd(target.P.lat), nbhd(target.P.lng)).toFixed(2)} km from its neighbourhood, gets the event's copy when someone taps Going, with the place (got ${linGot.length}; RSVP ${tapped.status})`);
        assert(wesGot.length === 0, `global (index ${indexOn ? 'on' : 'off'}): a member at the same spot who isn't let in gets nothing, as her set holds the neighbourhood (got ${wesGot.length})`);
    }
    se.setListingPushIndex(true);
    linSock.ws.close();
    wesSock.ws.close();
    // The sockets' index looks a degree past the radius, so through sockets a let-in member is visited either way; the
    // rule that she is visited as a party, wherever the index looks, is held here.
    const parties = se.listingReachParties({ type: 'post_updated', post: { id: 'ev-ring' } }) ?? [];
    assert(parties.includes(lin.pubKeyHex) && parties.includes(alice.pubKeyHex) && !parties.includes(wes.pubKeyHex),
        `global: the event's copy visits the host and the member let in as parties, wherever the index looks, and not the member who isn't (${parties.length} parties)`);

    // ── 3. The operator's override on the global node: every place exact again ──
    console.log('\n── 3. nodeProfile.openMembership = false on the global node ──');
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.openMembership`, 'false');
    const off = ours(await pageAll(`/api/marketplace/posts?${ALL_TYPES}`, bob)).filter(p => RANDOM.includes(p.id));
    assert(off.length === 200 && off.every(exactOf), `override: another member reads every place exactly again (${off.filter(exactOf).length} of ${off.length})`);
    db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.openMembership`);
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
