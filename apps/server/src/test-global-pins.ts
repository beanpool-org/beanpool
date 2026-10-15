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
 *      - half a place (one coordinate, the other null): no place at all to another member, both null, in reads and socket
 *        copies; as it is to its author; and on a local community as it is (#1965 round 4: rounding only a whole place
 *        left the one coordinate exact);
 *      - WHICH sockets get a new listing's copy (state-engine.ts listingReach, 250 km from each member's 0.1° area): for 3
 *        listings posted through the route, about 25 members each set their area through the route at the 0.1° grid
 *        points 250 ± 0.8 km from the listing's neighbourhood; the members who get the copy are exactly those within
 *        250 km of the neighbourhood, and for at least one listing that differs from who is within 250 km of the place,
 *        so the check can tell (#1965 deciding review B1: from the place, ~25 such yes-or-no answers put it to ~100 m);
 *      - and a member who has the place exactly (let in to an event whose host lets people in) is reached as their set
 *        holds it, from the place: on a ring point within 250 km of the place but not of its neighbourhood, she gets the
 *        copy, exact, when someone taps Going, and a member there who isn't let in gets nothing, with the sockets' index
 *        on and off (#1965 confirmation finding 2: measuring her from the neighbourhood, or leaving her out of the
 *        index's parties, both passed before);
 *      - a repeating event whose host lets people in (#1945): the place goes by the note's rule, the member's one RSVP
 *        row, this date's or an earlier one's; by id, nearest-first and in socket copies, the host and the member let in
 *        last week have it after the roll and after a cancelled date, the member Going last week and never let in has the
 *        neighbourhood, and "let everyone in" gives it to this date's waiting member alone.
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
/**
 * The neighbourhood, restated from its rule (@beanpool/core neighbourhoodOf; Marty, 15 Oct: "Widen by latitude"): rows of
 * 0.01° of latitude; each 1° band of latitude has ROUND(36000 · cos(its middle)) cells round the Earth, at most 36,000,
 * its middle at most 89.5° from the equator; the centre to six decimals, halves up, never -0.
 */
function lngStepOf(cellLat: number): number {
    const band = Math.min(89, Math.max(-90, Math.floor(cellLat)));
    return 360 / Math.max(1, Math.min(36000, Math.round(36000 * Math.cos(rad(band + 0.5)))));
}
function cellOf(lat: number, lng: number): { lat: number; lng: number } {
    const cellLat = Math.round(lat * 100) / 100 + 0;
    const cells = Math.round(360 / lngStepOf(cellLat));
    let k = Math.round(lng / (360 / cells));
    if (k > cells / 2) k -= cells;
    if (k < -cells / 2) k += cells;
    return { lat: cellLat, lng: Math.max(-180, Math.min(180, Math.round(k * 360 / cells * 1e6) / 1e6 + 0)) };
}

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
    // Half a place: a listing posted with no pin takes its author's area only if they have one (apps/server engine/posts.ts),
    // and the post route takes each coordinate on its own, so a row can hold one coordinate and not the other.
    listing('half-lat', alice, -28.612345, null as unknown as number, 305);
    listing('half-lng', alice, null as unknown as number, 153.512345, 306);
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
    const neighbourhoodOf = (p: any) => { const t = place.get(p.id)!; const c = cellOf(t.lat, t.lng); return p.lat === c.lat && p.lng === c.lng; };

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
        const km = (p: any) => { const t = place.get(p.id)!; return haversine(q.lat, q.lng, cellOf(t.lat, t.lng).lat, cellOf(t.lat, t.lng).lng); };
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
        const want = RANDOM.filter(id => { const t = place.get(id)!; return haversine(q0.lat, q0.lng, cellOf(t.lat, t.lng).lat, cellOf(t.lat, t.lng).lng) <= radiusKm; });
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
    // Half a place is no place to another member: both null, by id and in the list; to its author, as it is.
    for (const id of ['half-lat', 'half-lng']) {
        const other = (await get(`/api/marketplace/posts?id=${id}`, bob)).body?.[0];
        const own = (await get(`/api/marketplace/posts?id=${id}`, alice)).body?.[0];
        const inList = list.find(p => p.id === id);
        assert(!!other && other.lat === null && other.lng === null && !!inList && inList.lat === null && inList.lng === null,
            `global: ${id} (one coordinate) reads to another member as no place, both null, by id and in the list (got ${JSON.stringify(other && [other.lat, other.lng])}, ${JSON.stringify(inList && [inList.lat, inList.lng])})`);
        assert(!!own && exactOf(own), `global: and to its author as it is (${JSON.stringify(own && [own.lat, own.lng])})`);
    }
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
    const homeKmOk = marketRows.every(m => { const t = place.get(m.id)!; return m.distanceKm === Math.round(haversine(q0.lat, q0.lng, cellOf(t.lat, t.lng).lat, cellOf(t.lat, t.lng).lng)); });
    assert(home.status === 200 && marketRows.length > 0 && homeKmOk,
        `global: Home's market card measures each listing from its neighbourhood, whole km (${marketRows.length} rows, ${homeKmOk ? 'all' : 'not all'} as the neighbourhood's)`);

    // The socket copies of a listing's event.
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const aliceSock = await openSocket(`${wsBase}?${signedWsQuery(alice)}`);
    const bobSock = await openSocket(`${wsBase}?${signedWsQuery(bob)}`);
    await sleep(300);
    const t = place.get('pin-011')!;
    // As an RSVP's or a vote's copy is: read for someone else, its place already the neighbourhood.
    se.broadcast({ type: 'post_updated', post: { id: 'pin-011', type: 'offer', authorPublicKey: alice.pubKeyHex, title: 'Listing pin-011', ...cellOf(t.lat, t.lng), audienceScope: 'public' } });
    await sleep(500);
    const aliceCopy = listingCopies(aliceSock).find(e => e.post.id === 'pin-011');
    const bobCopy = listingCopies(bobSock).find(e => e.post.id === 'pin-011');
    assert(!!aliceCopy && aliceCopy.post.lat === t.lat && aliceCopy.post.lng === t.lng,
        `global: a listing's socket copy reaches its author with the place, even sent from someone else's read (got ${JSON.stringify(aliceCopy?.post && [aliceCopy.post.lat, aliceCopy.post.lng])})`);
    assert(!!bobCopy && bobCopy.post.lat === cellOf(t.lat, t.lng).lat && bobCopy.post.lng === cellOf(t.lat, t.lng).lng,
        `global: and another member's socket with the neighbourhood (got ${JSON.stringify(bobCopy?.post && [bobCopy.post.lat, bobCopy.post.lng])})`);
    // A socket copy of half a place, sent to its recipients as a group listing's is (a public one with no whole place
    // reaches its parties alone, so another member gets no copy of it at all): no place to another member, as it is to
    // its author.
    for (const sock of [aliceSock, bobSock]) sock.raw.length = 0;
    se.broadcast({ type: 'post_updated', post: { id: 'half-lat', type: 'offer', authorPublicKey: alice.pubKeyHex, title: 'Listing half-lat', lat: -28.612345, lng: null, audienceScope: 'public' } },
        [alice.pubKeyHex, bob.pubKeyHex]);
    await sleep(500);
    const halfOwn = listingCopies(aliceSock).find(e => e.post.id === 'half-lat');
    const halfOther = listingCopies(bobSock).find(e => e.post.id === 'half-lat');
    assert(!!halfOther && halfOther.post.lat === null && halfOther.post.lng === null,
        `global: a socket copy of half a place reaches another member as no place, both null (got ${JSON.stringify(halfOther?.post && [halfOther.post.lat, halfOther.post.lng])})`);
    assert(!!halfOwn && halfOwn.post.lat === -28.612345 && halfOwn.post.lng === null, `global: and its author as it is (got ${JSON.stringify(halfOwn?.post && [halfOwn.post.lat, halfOwn.post.lng])})`);
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
        const c = cellOf(P.lat, P.lng);
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

    // Which sockets get an event's copy, at Sydney, the equator, 45°, 60° and 70° and on both sides of a band edge (where
    // the longitude step changes): the members on the ring around its neighbourhood are reached as their sets hold it,
    // from the neighbourhood; a member who has the place exactly (let in by its host) is reached from the place, and
    // visited as a party whatever the index finds; a member at her spot who isn't let in, not at all. Index on and off.
    const REACH_SPOTS: Array<{ name: string; lat: number; lng: number; spread: number }> = [
        { name: 'Sydney', lat: -33.9, lng: 151.1, spread: 0.4 },
        { name: 'the equator', lat: 0.3, lng: 32.6, spread: 0.4 },
        { name: '45°N', lat: 45.3, lng: 9.2, spread: 0.4 },
        { name: '60°N', lat: 60.3, lng: 30.3, spread: 0.4 },
        { name: '70°N', lat: 70.3, lng: 25.5, spread: 0.4 },
        { name: 'the last row of the 60° band', lat: 60.99, lng: 40.1, spread: 0.008 },
        { name: 'the first row of the 61° band', lat: 61.0, lng: 50.1, spread: 0.008 },
    ];
    const exactRand = prng(91);
    let firstEvent: { id: string; lin: Id; wes: Id } | null = null;
    for (const [k, spot] of REACH_SPOTS.entries()) {
        let target: { P: { lat: number; lng: number }; A: { lat: number; lng: number } } | null = null;
        for (let tries = 0; tries < 80 && !target; tries++) {
            const P = { lat: six(spot.lat + (exactRand() - 0.5) * spot.spread), lng: six(spot.lng + (exactRand() - 0.5) * 0.4) };
            if (Math.round(P.lat * 100) / 100 !== Math.round(spot.lat * 100) / 100 && spot.spread < 0.01) continue;
            const c = cellOf(P.lat, P.lng);
            const A = ring(c, 0.8).find(a => haversine(a.lat, a.lng, P.lat, P.lng) <= REACH_KM && haversine(a.lat, a.lng, c.lat, c.lng) > REACH_KM);
            if (A) target = { P, A };
        }
        if (!target) throw new Error(`no ring point within reach of a place but not of its neighbourhood at ${spot.name}`);
        const { P, A } = target;
        const c = cellOf(P.lat, P.lng);
        const evId = `ev-reach-${k}`;
        listing(evId, alice, P.lat, P.lng, 400 + k, { note: 'Side gate', letsIn: 1 });
        const lin = member(`Lin ${k}`, null), wes = member(`Wes ${k}`, null);
        for (const who of [lin, wes]) {
            const r = await post('/api/community/me/area', { lat: A.lat, lng: A.lng }, who);
            if (r.status !== 200) throw new Error(`area ${r.status} ${r.text.slice(0, 120)}`);
        }
        insRsvp.run(evId, lin.pubKeyHex, iso(T0 + 7_200_000), alice.pubKeyHex, iso(T0 + 7_200_000));
        firstEvent ??= { id: evId, lin, wes };
        const watchers: Array<{ A: { lat: number; lng: number }; s: Sock }> = [];
        for (const [i, W] of ring(c, 0.8).entries()) {
            const id = member(`Ring ${evId}-${i}`, null);
            const r = await post('/api/community/me/area', { lat: W.lat, lng: W.lng }, id);
            if (r.status !== 200) throw new Error(`area ${r.status} ${r.text.slice(0, 120)}`);
            watchers.push({ A: { lat: r.body.area.lat, lng: r.body.area.lng }, s: await openSocket(`${wsBase}?${signedWsQuery(id)}`) });
        }
        const linSock = await openSocket(`${wsBase}?${signedWsQuery(lin)}`);
        const wesSock = await openSocket(`${wsBase}?${signedWsQuery(wes)}`);
        await sleep(300);
        const copiesOf = (sock: Sock) => sock.raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(e => e?.post?.id === evId);
        const byCell = watchers.map(w => haversine(w.A.lat, w.A.lng, c.lat, c.lng) <= REACH_KM);
        const byPlace = watchers.map(w => haversine(w.A.lat, w.A.lng, P.lat, P.lng) <= REACH_KM);
        for (const [indexOn, status] of [[true, 'going'], [false, 'interested']] as const) {
            se.setListingPushIndex(indexOn);
            for (const sock of [linSock, wesSock, ...watchers.map(w => w.s)]) sock.raw.length = 0;
            const tapped = await post(`/api/marketplace/posts/${evId}/rsvp`, { status }, dan);
            await sleep(800);
            const received = watchers.map(w => copiesOf(w.s).length > 0);
            const linGot = copiesOf(linSock), wesGot = copiesOf(wesSock);
            const index = indexOn ? 'on' : 'off';
            assert(tapped.status === 200 && received.every((g, i) => g === byCell[i]) && received.some(Boolean) && received.some(g => !g)
                && watchers.every(w => copiesOf(w.s).every(e => e.post.lat === c.lat && e.post.lng === c.lng)),
                `global, ${spot.name} (index ${index}): the event's copy reaches exactly the ${byCell.filter(Boolean).length} of ${watchers.length} ring members within ${REACH_KM} km of its neighbourhood, each with the neighbourhood (got ${received.filter(Boolean).length}; from the place: ${byPlace.filter(Boolean).length}; RSVP ${tapped.status})`);
            assert(linGot.length > 0 && linGot.every(e => e.post.lat === P.lat && e.post.lng === P.lng),
                `global, ${spot.name} (index ${index}): a member let in, ${haversine(A.lat, A.lng, P.lat, P.lng).toFixed(2)} km from the place and ${haversine(A.lat, A.lng, c.lat, c.lng).toFixed(2)} km from its neighbourhood, gets it with the place (got ${linGot.length})`);
            assert(wesGot.length === 0, `global, ${spot.name} (index ${index}): a member at her spot who isn't let in gets nothing (got ${wesGot.length})`);
        }
        se.setListingPushIndex(true);
        for (const sock of [linSock, wesSock, ...watchers.map(w => w.s)]) sock.ws.close();
    }
    // The sockets' index looks a degree past the radius, so through sockets a let-in member is visited either way; the
    // rule that she is visited as a party, wherever the index looks, is held here.
    const parties = se.listingReachParties({ type: 'post_updated', post: { id: firstEvent!.id } }) ?? [];
    assert(parties.includes(firstEvent!.lin.pubKeyHex) && parties.includes(alice.pubKeyHex) && !parties.includes(firstEvent!.wes.pubKeyHex),
        `global: the event's copy visits the host and the member let in as parties, wherever the index looks, and not the member who isn't (${parties.length} parties)`);

    // East–west, a neighbourhood is about a kilometre at 60° too (Marty, 15 Oct: "Widen by latitude"): walking east along
    // 60.2°N in 40 steps of 0.002°, another member reads each listing at its neighbourhood's centre, and the centres are
    // at least 0.9 km apart (a fixed 0.01° put them 0.56 km apart).
    const WIDTH_IDS: string[] = [];
    for (let i = 0; i < 40; i++) {
        const id = `wide-${String(i).padStart(2, '0')}`;
        listing(id, alice, 60.2, six(24.9 + i * 0.002), 500 + i);
        WIDTH_IDS.push(id);
    }
    const wide = await get(`/api/marketplace/posts?ids=${WIDTH_IDS.join(',')}&sync=true`, bob);
    const centres = [...new Set(ours(wide.body).map((p: any) => p.lng as number))].sort((x, y) => x - y);
    const gaps = centres.slice(1).map((lng, i) => haversine(60.2, centres[i], 60.2, lng));
    assert(wide.status === 200 && ours(wide.body).length === 40 && gaps.length >= 2 && gaps.every(g => g >= 0.9 && g <= 1.3),
        `global: at 60°N the neighbourhoods are at least 0.9 km apart east–west (${gaps.map(g => g.toFixed(3)).join(', ')} km between ${centres.length} centres)`);
    const wideOwn = await get(`/api/marketplace/posts?ids=${WIDTH_IDS.join(',')}&sync=true`, alice);
    assert(ours(wideOwn.body).length === 40 && ours(wideOwn.body).every(exactOf), 'global: and their author reads each one where she put it');

    // A listing at one corner of its neighbourhood, then at the opposite corner, reads the same to another member, by id and
    // from three points with distances; to its author it moves. At 0°, 45°, 60° and 70°, and in the last row of a band and
    // the first row of the next.
    const CORNER_SPOTS: Array<[string, { lat: number; lng: number }]> = [
        ['the equator', { lat: 0.3, lng: 36.7 }], ['45°N', { lat: 45.3, lng: 13.4 }], ['60°N', { lat: 60.3, lng: 35.6 }],
        ['70°N', { lat: 70.3, lng: 29.9 }], ['the last row of the 60° band', { lat: 60.99, lng: 44.4 }], ['the first row of the 61° band', { lat: 61.0, lng: 54.4 }],
    ];
    for (const [k, [name, spot]] of CORNER_SPOTS.entries()) {
        const c = cellOf(spot.lat, spot.lng);
        const halfLng = lngStepOf(c.lat) / 2 - 1e-4, halfLat = 0.005 - 1e-4;
        const corners = [{ lat: six(c.lat - halfLat), lng: six(c.lng - halfLng) }, { lat: six(c.lat + halfLat), lng: six(c.lng + halfLng) }];
        const id = `corner-${k}`;
        listing(id, alice, corners[0].lat, corners[0].lng, 600 + k);
        const from = [{ lat: c.lat + 0.05, lng: c.lng - 0.07 }, { lat: c.lat - 0.11, lng: c.lng + 0.03 }, { lat: c.lat + 0.002, lng: c.lng + 0.2 }];
        const reads = (who: Id) => Promise.all([
            get(`/api/marketplace/posts?id=${id}`, who),
            ...from.map(q => get(`/api/marketplace/posts?${ALL_TYPES}&lat=${q.lat}&lng=${q.lng}&radiusKm=30&sort=distance&limit=50`, who)),
        ]).then(rs => rs.map(r => r.text));
        const otherAt0 = await reads(bob), ownAt0 = await reads(alice);
        // Moved as nothing else changed: the row's time stays (posts_touch_updated_at stamps a write that leaves it, so the
        // move writes another first and then the same one back).
        const { updated_at: was } = db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(id) as { updated_at: string };
        db.prepare('UPDATE posts SET lat = ?, lng = ?, updated_at = ? WHERE id = ?').run(corners[1].lat, corners[1].lng, '1970-01-01T00:00:00.000Z', id);
        db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(was, id);
        place.set(id, corners[1]);
        const otherAt1 = await reads(bob), ownAt1 = await reads(alice);
        const apartKm = haversine(corners[0].lat, corners[0].lng, corners[1].lat, corners[1].lng);
        assert(otherAt0.every((t, i) => t === otherAt1[i]) && otherAt0[0].includes(id),
            `global, ${name}: another member's 4 reads are the same bytes whether the listing is at one corner of its neighbourhood or the opposite one, ${apartKm.toFixed(2)} km apart`);
        assert(ownAt0.filter((t, i) => t !== ownAt1[i]).length === 4, `global, ${name}: and its author's 4 reads all show it move`);
    }

    // A repeating event whose host lets people in (#1945 beside #1965): the place goes by the note's rule, the member's one
    // RSVP row, this date's or an earlier one's. A roll and a cancelled date move nobody between the place and the
    // neighbourhood; only a let-in does, and "let everyone in" takes this date's Going alone (83f6bd61).
    const { rollDueSeries } = await import('./engine/event-series-roll.js');
    const hana = member('Hana', { lat: -28.6, lng: 153.5 });
    // Her area through the route, as a member sets it (a row written after the server read the areas is not one it knows).
    const rae = member('Rae', null);
    const raeArea = await post('/api/community/me/area', { lat: -28.7, lng: 153.5 }, rae);
    if (raeArea.status !== 200) throw new Error(`area ${raeArea.status} ${raeArea.text.slice(0, 120)}`);
    const SP = { lat: -28.664321, lng: 153.587654 };
    const SC = cellOf(SP.lat, SP.lng);
    const madeSeries = await post('/api/marketplace/posts', {
        type: 'event', title: 'Friday garden working bee', description: 'Bring gloves', credits: 0, authorPublicKey: hana.pubKeyHex,
        lat: SP.lat, lng: SP.lng, eventPrivateNote: 'Side gate, number 7', eventHostLetsIn: true,
        eventStartLocal: '2098-01-03T19:00', eventEndLocal: '2098-01-03T21:00', eventTz: 'Australia/Sydney',
        eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
    }, hana);
    const sid = (madeSeries.body?.id ?? madeSeries.body?.post?.id) as string;
    assert((madeSeries.status === 200 || madeSeries.status === 201) && !!sid && madeSeries.body?.post?.eventRepeat?.byDay === 'FR',
        `global: a weekly event whose host lets people in is posted through the route (got ${madeSeries.status} ${madeSeries.text.slice(0, 120)})`);
    place.set(sid, SP);
    const seriesRow = () => db.prepare('SELECT event_start_local, event_end_at FROM posts WHERE id = ?').get(sid) as { event_start_local: string; event_end_at: string };
    for (const who of [carol, dan]) {
        const r = await post(`/api/marketplace/posts/${sid}/rsvp`, { status: 'going' }, who);
        if (r.status !== 200) throw new Error(`rsvp ${r.status} ${r.text.slice(0, 120)}`);
    }
    const letCarol = await post(`/api/marketplace/posts/${sid}/let-in`, { memberPublicKey: carol.pubKeyHex }, hana);
    assert(letCarol.status === 200 && letCarol.body?.changed === 1, `global, repeating: the host lets Carol in on the first date (got ${letCarol.status} ${letCarol.text.slice(0, 120)})`);
    const seriesFor = (who: Id) => eventFor(sid, who);
    /** Exact for these, the neighbourhood for the rest, by id; and from a point 3 km north, 0.1 km from the place or whole km from the neighbourhood. */
    const placesAre = async (stage: string, exact: Id[], rounded: Id[]) => {
        const named = (who: Id) => [hana, carol, dan, bob, rae].indexOf(who);
        const names = ['Hana', 'Carol', 'Dan', 'Bob', 'Rae'];
        const byIdOk = await Promise.all([...exact.map(async w => exactOf(await seriesFor(w))), ...rounded.map(async w => { const p = await seriesFor(w); return neighbourhoodOf(p) && !exactOf(p); })]);
        const Q = { lat: six(SP.lat + 0.027), lng: SP.lng };
        const nearOf = async (who: Id) => ours((await get(`/api/marketplace/posts?${ALL_TYPES}&lat=${Q.lat}&lng=${Q.lng}&radiusKm=10&sort=distance&limit=200`, who)).body).find(p => p.id === sid);
        const nearOk = await Promise.all([
            ...exact.map(async w => { const p = await nearOf(w); return !!p && exactOf(p) && p.distanceKm === Math.round(haversine(Q.lat, Q.lng, SP.lat, SP.lng) * 10) / 10; }),
            ...rounded.map(async w => { const p = await nearOf(w); return !!p && neighbourhoodOf(p) && p.distanceKm === Math.round(haversine(Q.lat, Q.lng, SC.lat, SC.lng)); }),
        ]);
        assert(byIdOk.every(Boolean) && nearOk.every(Boolean),
            `global, repeating, ${stage}: the place for ${exact.map(w => names[named(w)]).join(', ')}; the neighbourhood for ${rounded.map(w => names[named(w)]).join(', ')}, by id and nearest-first (by id ${byIdOk.map(Number).join('')}, nearest ${nearOk.map(Number).join('')})`);
    };
    await placesAre('on the first date', [hana, carol], [dan, bob, rae]);

    // The roll to the next Friday, with sockets open: its copy is exact for the host and Carol, the neighbourhood for the rest.
    const seriesSocks = new Map<Id, Sock>();
    for (const who of [hana, carol, dan, bob, rae]) seriesSocks.set(who, await openSocket(`${wsBase}?${signedWsQuery(who)}`));
    await sleep(300);
    const copiesOf = (who: Id) => listingCopies(seriesSocks.get(who)!).filter(e => e.post.id === sid);
    const copiesAre = (exact: Id[], rounded: Id[]) =>
        exact.every(w => copiesOf(w).length > 0 && copiesOf(w).every(e => e.post.lat === SP.lat && e.post.lng === SP.lng))
        && rounded.every(w => copiesOf(w).length > 0 && copiesOf(w).every(e => e.post.lat === SC.lat && e.post.lng === SC.lng));
    /** What each socket got: its copies' places, or how many other messages it had. */
    const copiesSeen = () => ['Hana', 'Carol', 'Dan', 'Bob', 'Rae'].map((name, i) => {
        const who = [hana, carol, dan, bob, rae][i];
        const c = copiesOf(who);
        return `${name} ${c.length ? c.map(e => e.post.lat === SP.lat ? 'place' : e.post.lat === SC.lat ? 'nbhd' : `${e.post.lat}`).join('+') : `none of ${seriesSocks.get(who)!.raw.length}`}`;
    }).join(', ');
    const rolled = rollDueSeries(se.broadcast, Date.parse(seriesRow().event_end_at) + 1000);
    await sleep(500);
    assert(rolled >= 1 && seriesRow().event_start_local === '2098-01-10T19:00',
        `global, repeating: it rolls to the next Friday (rolled ${rolled}, now ${seriesRow().event_start_local})`);
    assert(copiesAre([hana, carol], [dan, bob, rae]), `global, repeating: the roll's socket copy is exact for the host and Carol (let in last week), the neighbourhood for Dan, Bob and Rae (${copiesSeen()})`);
    const carolNow = await seriesFor(carol);
    assert(carolNow?.myRsvp === null && carolNow?.myLastRsvp?.status === 'going' && carolNow?.eventPrivateNote === 'Side gate, number 7',
        `global, repeating: after the roll Carol's let-in is last week's and still reads the note (got ${JSON.stringify({ my: carolNow?.myRsvp, last: carolNow?.myLastRsvp?.status })})`);
    await placesAre('after the roll', [hana, carol], [dan, bob, rae]);

    // Rae says Going for this date and waits; "let everyone in" lets her in and not Dan, whose Going was last week's.
    const raeGoing = await post(`/api/marketplace/posts/${sid}/rsvp`, { status: 'going' }, rae);
    assert(raeGoing.status === 200, `global, repeating: Rae says Going for this date (got ${raeGoing.status})`);
    await placesAre('Rae waiting', [hana, carol], [dan, bob, rae]);
    const everyone = await post(`/api/marketplace/posts/${sid}/let-in`, { everyone: true }, hana);
    assert(everyone.status === 200 && everyone.body?.changed === 1, `global, repeating: "let everyone in" lets in this date's one waiting, Rae (got ${everyone.status} changed ${everyone.body?.changed})`);
    await placesAre('after "let everyone in"', [hana, carol, rae], [dan, bob]);

    // The host cancels this date: the event moves to the one after, and nobody moves between the place and the neighbourhood.
    for (const s of seriesSocks.values()) s.raw.length = 0;
    const skipped = await post(`/api/events/${sid}/skip`, { date: '2098-01-10' }, hana);
    await sleep(500);
    assert(skipped.status === 200 && seriesRow().event_start_local === '2098-01-17T19:00',
        `global, repeating: the host cancels this date and the event moves to the next (got ${skipped.status} ${seriesRow().event_start_local})`);
    assert(copiesAre([hana, carol, rae], [dan, bob]), `global, repeating: the cancelled date's socket copy is exact for the host, Carol and Rae, the neighbourhood for Dan and Bob (${copiesSeen()})`);
    await placesAre('after a cancelled date', [hana, carol, rae], [dan, bob]);
    const seriesParties = se.listingReachParties({ type: 'post_updated', post: { id: sid } }) ?? [];
    assert([hana, carol, rae].every(w => seriesParties.includes(w.pubKeyHex)) && ![dan, bob].some(w => seriesParties.includes(w.pubKeyHex)),
        `global, repeating: its copies visit the host, Carol and Rae as parties, not Dan or Bob (${seriesParties.length} parties)`);
    for (const s of seriesSocks.values()) s.ws.close();

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
