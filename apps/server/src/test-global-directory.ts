/**
 * The communities directory on the global node (G5, design §3.1, §3.2, §3.5, §4.2). Over REAL HTTPS through the real
 * signature middleware, with a FIXTURE registry on 127.0.0.1: nothing here talks to the real directory registry, to a
 * BeanPool node, or to Expo (pushes are caught at fetch).
 *
 *   1. local profile: every /api/global route answers 404 feature_off (unsigned and signed), and the mirror never runs
 *   2. the mirror, on the global profile, primary only: it fetches the fixture with the key in the `apikey` header and
 *      nowhere else; a standby, or the switch off, never fetches
 *   3. GET /api/global/communities: nearest first from a point (service_radius), name search (accents and case
 *      forgiven), paging with a total, name order without a point; a row without an address is listed with url null
 *      (no link), a bad address or place is dropped rather than guessed, a row with no id is left out; the key is in
 *      no response; ETag and 304, kept across a run that changes nothing; garbage is a 400
 *   4. a failed mirror keeps the old cache: a 500, a body that isn't an array, broken JSON, nothing listening
 *   5. place watches: stored as the 0.1° cell, never the spot; set, list and remove one's own only; another member's
 *      key in the body is refused by the spoof check; the per-member cap; unsigned, non-member and garbage refused
 *   6. the hourly diff: communities new to the cache near a watch → exactly one push and one announcement per watcher
 *      (two new communities, one push), none for a watch they don't reach, none twice across runs, none for a
 *      community that leaves the registry and comes back, none for a community first seen before the watch was set;
 *      no registry text in any notice; at most one notice a member a day; a flood of new rows tells nobody; a
 *      community that leaves is scrubbed to its key; a pruned member's watches go with them
 *   7. GET /api/global/home in one request: the nearest communities, the nearby post count, the caller's own watches,
 *      the knock seam (null); unsigned gets no watches; with no point, the member's own area
 *   8. the publisher honours publishToDirectory: nothing is sent on the global profile (and its timer is not set), an
 *      operator's override lists it, and on the local profile it runs as it always has
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-global-directory.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import http from 'node:http';
import WebSocket from 'ws';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the fixture registry: GET is the directory the mirror reads, POST is the publisher's register call ───────────
interface Fixture { status: number; body: string }
let fixture: Fixture = { status: 200, body: '[]' };
const registryReads: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const registryWrites: { url: string; body: any }[] = [];
const registry = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        if (req.method === 'POST') {
            let body: any = raw;
            try { body = JSON.parse(raw); } catch { /* as sent */ }
            registryWrites.push({ url: req.url || '', body });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        registryReads.push({ url: req.url || '', headers: req.headers });
        // Pages as PostgREST does, by limit and offset, when the body is a list.
        let body = fixture.body;
        const u = new URL(req.url || '/', 'http://fixture');
        const limit = u.searchParams.get('limit');
        if (fixture.status === 200 && limit !== null) {
            try {
                const rows = JSON.parse(fixture.body);
                const offset = Number(u.searchParams.get('offset') || 0);
                if (Array.isArray(rows)) body = JSON.stringify(rows.slice(offset, offset + Number(limit)));
            } catch { /* served as it is */ }
        }
        res.writeHead(fixture.status, { 'Content-Type': 'application/json' });
        res.end(body);
    });
});
await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
const REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
const MIRROR_KEY = 'sb_publishable_TEST-fixture-key-7c1e';
process.env.DIRECTORY_MIRROR_URL = `${REGISTRY}/rest/v1/directory_nodes?select=*`;
process.env.DIRECTORY_MIRROR_KEY = MIRROR_KEY;
process.env.DIRECTORY_REGISTRY_URL = `${REGISTRY}/functions/v1/directory-register`;
const serve = (rows: unknown[]) => { fixture = { status: 200, body: JSON.stringify(rows) }; };

// ── pushes never leave: Expo is caught at fetch ──────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const pushed: any[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        pushed.push(...JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({}) } as any;
    }
    return realFetch(url, init);
};

// Imported only now, so every module reads the fixture's addresses.
const { initTls } = await import('./services/tls.js');
const { initStateEngine, seedGenesisMember, createPost, setNodeRole, adminPruneUser } = await import('./state-engine.js');
const { startHttpsServer } = await import('./https-server.js');
const { db } = await import('./db/db.js');
const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
const { startP2P } = await import('./p2p.js');
const { updateLocalConfig } = await import('./config/local-config.js');
const publisher = await import('./services/directory-publisher.js');
/** The mirror (G5). A tree without it runs every step anyway, so each one fails as an assertion rather than an abort. */
type MirrorResult = { ran: boolean; ok?: boolean; reason?: string; error?: string; rows?: number; added?: number; updated?: number; removed?: number; notified?: number };
const mirror = await import('./services/directory-mirror.js' as string).catch((e) => {
    console.error(`  (no directory mirror in this tree: ${e?.message})`);
    return null;
}) as { runDirectoryMirror: (opts?: { pageRows?: number }) => Promise<MirrorResult> } | null;
const runMirror = async (opts?: { pageRows?: number }): Promise<MirrorResult> => {
    if (!mirror) return { ran: false, reason: 'missing' };
    try { return await mirror.runDirectoryMirror(opts); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return { ran: false, reason: 'threw' }; }
};
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

let BASE = '';

// ── members and signed requests ──────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, new Date(Date.now() - 30 * 86_400_000).toISOString(), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(method: 'GET' | 'POST' | 'DELETE', id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const headers: Record<string, string> = { ...extra };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: method === 'POST' ? raw : undefined });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty (304) */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const setOverride = (name: string, value: string | null) => value === null
    ? db.prepare('DELETE FROM node_config WHERE key = ?').run(`nodeProfile.${name}`)
    : db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`nodeProfile.${name}`, value);
const keys = (r: Res): string[] => Array.isArray(r.body?.communities) ? r.body.communities.map((c: any) => c.key) : [];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── signed member sockets, for the announcement ──────────────────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const announcements = (s: Sock) => s.events.filter(e => e.type === 'system_announcement');
const settle = () => new Promise(r => setTimeout(r, 250));

// ── the registry's rows ──────────────────────────────────────────────────────────────────────────────────────────
const BYRON_POINT = { lat: -28.64, lng: 153.61 };
const MULLUM = { node_id: 'peer-mullum', callsign: 'Mullum Node', community_name: 'Mullumbimby Commons', node_url: 'https://mullum.beanpool.org',
    service_radius: { lat: -28.55, lng: 153.50, radiusKm: 25 }, member_count: 40, contact_email: 'hello@mullum.example', contact_phone: null,
    updated_at: '2026-09-20T00:00:00Z' };
// The registry gap (§11): no address until the release. Listed by name and distance, with no link.
const CASTLE = { node_id: 'peer-castle', callsign: 'Castlemaine BeanPool', community_name: null, node_url: null,
    service_radius: { lat: -37.07, lng: 144.22, radiusKm: 30 }, member_count: 12 };
// service_radius as a JSON string, a member count as a string, an address that is no address.
const LISMORE = { node_id: 'peer-lismore', callsign: 'Lismore Exchange', node_url: 'javascript:alert(1)',
    service_radius: JSON.stringify({ lat: -28.81, lng: 153.28, radiusKm: 20 }), member_count: '7' };
const HILLTOP = { node_id: 'peer-hilltop', callsign: 'Hilltop', node_url: 'hilltop.beanpool.org', service_radius: null, member_count: 3 };
const SAO = { node_id: 'peer-sao', community_name: 'São Paulo Solidária', node_url: 'https://saopaulo.beanpool.org',
    service_radius: { lat: -23.55, lng: -46.63, radiusKm: 40 }, member_count: 9 };
const EVIL = { node_id: 'peer-evil', callsign: 'Evil‮\u0007 Name', node_url: 'http://plain.example/path',
    service_radius: { lat: 123, lng: 500, radiusKm: -1 }, member_count: -4, contact_email: 'not an email', contact_phone: '<script>' };
const NO_ID = { callsign: 'Nobody', service_radius: { lat: -28.6, lng: 153.6, radiusKm: 5 } };
const V1 = [MULLUM, CASTLE, LISMORE, HILLTOP, SAO, EVIL, NO_ID];

// New in v2. Byron and Bangalow reach Wes's watch; Kiezpool reaches Wanda's; Grafton is just out of Wes's reach;
// Reykjavik reaches nobody.
const BYRON = { node_id: 'peer-byron', community_name: 'Byron Shire Commons', node_url: 'https://byron.beanpool.org',
    service_radius: { lat: -28.65, lng: 153.56, radiusKm: 15 }, member_count: 5 };
const BANGALOW = { node_id: 'peer-bangalow', community_name: 'Bangalow Pool', node_url: null,
    service_radius: { lat: -28.69, lng: 153.52, radiusKm: 10 }, member_count: 4 };
const KIEZ = { node_id: 'peer-kiez', community_name: 'Kiezpool Berlin', node_url: 'https://kiez.beanpool.org',
    service_radius: { lat: 52.50, lng: 13.42, radiusKm: 10 }, member_count: 6 };
const GRAFTON = { node_id: 'peer-grafton', community_name: 'Grafton Shares', node_url: null,
    service_radius: { lat: -29.69, lng: 152.93, radiusKm: 20 }, member_count: 2 };
const REYKJAVIK = { node_id: 'peer-rvk', community_name: 'Reykjavík Skipti', node_url: 'https://rvk.beanpool.org',
    service_radius: { lat: 64.15, lng: -21.94, radiusKm: 20 }, member_count: 3 };
const V2 = [...V1, BYRON, BANGALOW, KIEZ, GRAFTON, REYKJAVIK];
const SUFFOLK = { node_id: 'peer-suffolk', community_name: 'Suffolk Park Swap', node_url: null,
    service_radius: { lat: -28.70, lng: 153.60, radiusKm: 8 }, member_count: 2 };
const MITTE = { node_id: 'peer-mitte', community_name: 'Mitte Tausch', node_url: null,
    service_radius: { lat: 52.53, lng: 13.39, radiusKm: 5 }, member_count: 2 };
const BRUNSWICK = { node_id: 'peer-brunswick', community_name: 'Brunswick Swap', node_url: 'https://brunswick.beanpool.org',
    service_radius: { lat: -28.35, lng: 153.55, radiusKm: 10 }, member_count: 3 };
// 26 at once near Nairobi: a flood, not communities starting. Then one more, which is news.
const FLOOD = Array.from({ length: 26 }, (_, i) => ({ node_id: `peer-flood-${i}`, community_name: `Flood ${i}`,
    service_radius: { lat: -1.29 + i * 0.01, lng: 36.82, radiusKm: 5 } }));
const NAIROBI = { node_id: 'peer-nairobi', community_name: 'Nairobi Exchange', service_radius: { lat: -1.28, lng: 36.81, radiusKm: 10 } };

async function main(): Promise<void> {
    console.log('\n=== The communities directory on the global node (G5) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const wes = member('Wes');       // watches near Byron
    const wanda = member('Wanda');   // watches Berlin
    const theo = member('Theo');     // watches Perth, later Byron
    const poster = member('Pat');
    const stranger = newId('Stranger');
    const pushToken = (id: Id) => `ExponentPushToken[g5-${id.name}]`;
    for (const id of [wes, wanda, theo]) db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`).run(id.pk, pushToken(id));
    const pushesTo = (id: Id) => pushed.filter(m => m.to === pushToken(id));

    // ── 1. local profile ────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. local profile: no /api/global, no mirror ──');
    for (const [method, who, path] of [
        ['GET', null, '/api/global/communities'], ['GET', null, `/api/global/communities?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}`],
        ['GET', null, '/api/global/home'], ['GET', wes, '/api/global/home'], ['GET', wes, '/api/global/watches'],
        ['POST', wes, '/api/global/watches'], ['DELETE', wes, '/api/global/watches/some-id'],
    ] as const) {
        const r = await call(method, who, path, method === 'POST' ? BYRON_POINT : undefined);
        assert(r.status === 404 && r.body?.code === 'feature_off', `local: ${method} ${path}${who ? ' (signed)' : ''} → 404 feature_off (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    serve(V1);
    const localRun = await runMirror();
    assert(localRun.ran === false && localRun.reason === 'switched_off' && registryReads.length === 0,
        `local: the mirror does not run and the registry is never contacted (${JSON.stringify(localRun)}, ${registryReads.length} reads)`);

    // ── 2. the mirror on the global profile ─────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the mirror: global, primary only ──');
    process.env.NODE_PROFILE = 'global';
    const empty = await call('GET', null, '/api/global/communities');
    assert(empty.status === 200 && same(empty.body?.communities, []) && empty.body?.total === 0 && empty.body?.fetchedAt === null,
        `global, before any mirror: 200 with no communities and fetchedAt null (got ${empty.status} ${empty.text.slice(0, 160)})`);
    setNodeRole('backup');
    const standbyRun = await runMirror();
    setNodeRole('primary');
    assert(standbyRun.ran === false && standbyRun.reason === 'not_primary' && registryReads.length === 0,
        `a standby never fetches (${JSON.stringify(standbyRun)})`);
    setOverride('directoryMirror', 'false');
    const offRun = await runMirror();
    const offRoute = await call('GET', null, '/api/global/communities');
    setOverride('directoryMirror', null);
    assert(offRun.ran === false && offRun.reason === 'switched_off' && registryReads.length === 0 && offRoute.status === 404,
        `global with nodeProfile.directoryMirror=false: no fetch, and the routes are off (${JSON.stringify(offRun)}, ${offRoute.status})`);

    const first = await runMirror();
    assert(first.ran === true && first.ok === true && first.added === 6, `the first run mirrors the six rows with an id (${JSON.stringify(first)})`);
    assert(registryReads.length >= 1 && registryReads.every(r => r.headers.apikey === MIRROR_KEY),
        `the registry is read with the key in the apikey header (${registryReads.length} reads)`);
    assert(registryReads.length >= 1 && registryReads.every(r => r.url.startsWith('/rest/v1/directory_nodes')), `from DIRECTORY_MIRROR_URL (${registryReads[0]?.url})`);
    const cacheCount = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM directory_cache').get() as any).n);
    assert(cacheCount === 6, `directory_cache holds six rows; the row with no id is left out (got ${cacheCount})`);
    const readsBefore = registryReads.length;
    const paged = await runMirror({ pageRows: 4 });
    const offsets = registryReads.slice(readsBefore).map(r => new URL(r.url, 'http://fixture').searchParams.get('offset')).join(',');
    assert(paged.ok === true && paged.rows === 6 && paged.added === 0 && offsets === '0,4',
        `paged: a full page asks for the next (4 a page: offsets ${offsets}), and the rows are the same six (${JSON.stringify(paged)})`);

    // ── 3. GET /api/global/communities ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. GET /api/global/communities ──');
    const near = await call('GET', null, `/api/global/communities?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}`);
    assert(near.status === 200, `a public read, unsigned: 200 (got ${near.status} ${near.text.slice(0, 200)})`);
    assert(same(keys(near), ['peer-mullum', 'peer-lismore', 'peer-castle', 'peer-sao', 'peer-evil', 'peer-hilltop']),
        `nearest first from Byron by the service_radius centre; the rows with no place last, by name (got ${JSON.stringify(keys(near))})`);
    assert(near.body?.total === 6 && typeof near.body?.fetchedAt === 'string', `total 6 and when it was fetched (${near.body?.total}, ${near.body?.fetchedAt})`);
    const byKey = (r: Res, k: string) => (r.body?.communities ?? []).find((c: any) => c.key === k);
    const mul = byKey(near, 'peer-mullum');
    assert(mul?.name === 'Mullumbimby Commons' && mul?.url === 'https://mullum.beanpool.org' && mul?.memberCount === 40
        && mul?.lat === -28.55 && mul?.lng === 153.5 && mul?.radiusKm === 25 && mul?.contactEmail === 'hello@mullum.example',
        `a full row: community_name before callsign, its address, members, place and contact (${JSON.stringify(mul)})`);
    assert(typeof mul?.distanceKm === 'number' && Math.abs(mul.distanceKm - 14.8) < 1, `and its distance from the point in km (${mul?.distanceKm})`);
    const cas = byKey(near, 'peer-castle');
    assert(cas && cas.url === null && cas.name === 'Castlemaine BeanPool' && typeof cas.distanceKm === 'number',
        `a row with no node_url is listed by name and distance, with url null (${JSON.stringify(cas)})`);
    const lis = byKey(near, 'peer-lismore');
    assert(lis && lis.url === null && lis.memberCount === 7 && lis.lat === -28.81 && lis.radiusKm === 20,
        `javascript: is no address (url null); service_radius as JSON text and a count as text are read (${JSON.stringify(lis)})`);
    const hil = byKey(near, 'peer-hilltop');
    assert(hil && hil.url === 'https://hilltop.beanpool.org' && hil.lat === null && hil.distanceKm === null,
        `a bare hostname is its https address; a row with no place has no distance (${JSON.stringify(hil)})`);
    const evil = byKey(near, 'peer-evil');
    assert(evil && evil.name === 'Evil Name' && evil.url === null && evil.lat === null && evil.lng === null && evil.radiusKm === null
        && evil.memberCount === null && evil.contactEmail === null && evil.contactPhone === null,
        `every bad field dropped, never guessed: control and direction characters out of the name, http, a place off the Earth, a negative count, a non-email (${JSON.stringify(evil)})`);
    assert(!near.text.includes(MIRROR_KEY), 'the registry key is in no response');

    const q1 = await call('GET', null, '/api/global/communities?q=castle');
    assert(same(keys(q1), ['peer-castle']) && q1.body?.total === 1, `q=castle finds Castlemaine by its callsign (${JSON.stringify(keys(q1))})`);
    const q2 = await call('GET', null, `/api/global/communities?q=MULL&lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}`);
    assert(same(keys(q2), ['peer-mullum']), `case is forgiven (${JSON.stringify(keys(q2))})`);
    const q3 = await call('GET', null, '/api/global/communities?q=sao%20paulo');
    assert(same(keys(q3), ['peer-sao']), `accents are forgiven: "sao paulo" finds São Paulo (${JSON.stringify(keys(q3))})`);
    const q4 = await call('GET', null, '/api/global/communities?q=nowhere');
    assert(q4.status === 200 && same(keys(q4), []) && q4.body?.total === 0, 'a name nobody has: none');
    const p1 = await call('GET', null, `/api/global/communities?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}&limit=2`);
    const p2 = await call('GET', null, `/api/global/communities?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}&limit=2&offset=2`);
    const p4 = await call('GET', null, `/api/global/communities?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}&limit=2&offset=6`);
    assert(same(keys(p1), ['peer-mullum', 'peer-lismore']) && same(keys(p2), ['peer-castle', 'peer-sao']) && same(keys(p4), [])
        && p1.body?.total === 6 && p2.body?.total === 6, `paged: limit and offset walk the same order, total on every page (${JSON.stringify([keys(p1), keys(p2), keys(p4)])})`);
    const byName = await call('GET', null, '/api/global/communities');
    assert(same(keys(byName), ['peer-castle', 'peer-evil', 'peer-hilltop', 'peer-lismore', 'peer-mullum', 'peer-sao'])
        && (byName.body?.communities ?? []).every((c: any) => c.distanceKm === null),
        `without a point: by name, no distances (${JSON.stringify(keys(byName))})`);

    const etagUrl = `/api/global/communities?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}`;
    const etag = near.headers.get('etag');
    const again = await call('GET', null, etagUrl, undefined, etag ? { 'If-None-Match': etag } : {});
    assert(!!etag && again.status === 304, `ETag'd: the same read again → 304 (${etag}, ${again.status})`);
    const otherPoint = await call('GET', null, `/api/global/communities?lat=-37&lng=144`, undefined, etag ? { 'If-None-Match': etag } : {});
    assert(otherPoint.status === 200 && otherPoint.headers.get('etag') !== etag && keys(otherPoint)[0] === 'peer-castle',
        `another point → 200, another ETag, Castlemaine first (${otherPoint.status})`);
    const unchanged = await runMirror();
    const afterRun = await call('GET', null, etagUrl, undefined, etag ? { 'If-None-Match': etag } : {});
    assert(unchanged.ok === true && unchanged.added === 0 && unchanged.updated === 0 && unchanged.removed === 0,
        `a run over the same registry changes no row (${JSON.stringify(unchanged)})`);
    assert(afterRun.status === 200 && same(afterRun.body?.communities, near.body?.communities) && afterRun.body?.fetchedAt > near.body?.fetchedAt
        && afterRun.headers.get('etag') !== etag,
        `and the answer is the same communities with a newer fetchedAt, so a new ETag, never a 304 pinning the old time (${afterRun.status})`);

    for (const [query, why] of [['lat=abc&lng=1', 'a latitude that is not a number'], ['lat=-28', 'lat without lng'], ['lat=91&lng=0', 'a latitude past the pole'],
        [`q=${'x'.repeat(81)}`, 'a name search longer than 80 characters'], ['limit=0', 'limit 0'], ['limit=abc', 'a limit that is not a number'], ['offset=-1', 'a negative offset']] as const) {
        const r = await call('GET', null, `/api/global/communities?${query}`);
        assert(r.status === 400 && typeof r.body?.error === 'string', `${why} → 400 (got ${r.status})`);
    }

    // ── 4. a failed mirror keeps the old cache ──────────────────────────────────────────────────────────────────
    console.log('\n── 4. a failed mirror keeps the old cache ──');
    const before = await call('GET', null, etagUrl);
    for (const [label, f] of [
        ['HTTP 500', { status: 500, body: '{"message":"boom"}' }],
        ['a body that is not an array', { status: 200, body: '{"rows":[]}' }],
        ['broken JSON', { status: 200, body: '[{"node_id":' }],
    ] as const) {
        fixture = { ...f };
        const r = await runMirror();
        const after = await call('GET', null, etagUrl);
        assert(r.ran === true && r.ok === false && typeof r.error === 'string', `${label}: the run fails (${JSON.stringify(r)})`);
        assert(same(after.body, before.body), `${label}: the communities and fetchedAt are exactly as before`);
    }
    process.env.DIRECTORY_MIRROR_URL = 'http://127.0.0.1:1/rest/v1/directory_nodes?select=*';
    const refused = await runMirror();
    process.env.DIRECTORY_MIRROR_URL = `${REGISTRY}/rest/v1/directory_nodes?select=*`;
    const afterRefused = await call('GET', null, etagUrl);
    assert(refused.ran === true && refused.ok === false && same(afterRefused.body, before.body), `nothing listening: the run fails and the cache stands (${JSON.stringify(refused)})`);
    const cacheAfterFailures = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM directory_cache WHERE listed = 1').get() as any).n);
    assert(cacheAfterFailures === 6, `and directory_cache still lists six (${cacheAfterFailures})`);
    serve(V1);

    // ── 5. place watches ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. place watches ──');
    const set1 = await call('POST', wes, '/api/global/watches', { lat: -28.643219, lng: 153.612345, radiusKm: 50 });
    assert(set1.status === 200 && set1.body?.created === true && set1.body?.watch?.lat === -28.6 && set1.body?.watch?.lng === 153.6 && set1.body?.watch?.radiusKm === 50,
        `a watch is set on the 0.1° cell, not the spot (${set1.status} ${JSON.stringify(set1.body)})`);
    const wesRows = attempt(() => db.prepare('SELECT * FROM place_watches WHERE pubkey = ?').all(wes.pk) as any[]) ?? [];
    assert(wesRows.length === 1 && wesRows[0].lat === -28.6 && wesRows[0].lng === 153.6 && !JSON.stringify(wesRows).includes('643219') && !JSON.stringify(wesRows).includes('612345'),
        `the row holds the cell and nothing finer (${JSON.stringify(wesRows)})`);
    const setW = await call('POST', wanda, '/api/global/watches', { lat: 52.52, lng: 13.4 });
    assert(setW.status === 200 && setW.body?.watch?.radiusKm === 50, `Wanda watches Berlin, 50 km by default (${setW.status} ${JSON.stringify(setW.body)})`);
    const listWes = await call('GET', wes, '/api/global/watches');
    assert(listWes.status === 200 && listWes.body?.watches?.length === 1 && listWes.body.watches[0].lat === -28.6 && listWes.body?.limit === 3,
        `a member lists their own watches only, with the cap (${JSON.stringify(listWes.body)})`);
    const spoof = await call('POST', wes, '/api/global/watches', { lat: 10, lng: 10, publicKey: wanda.pk });
    const wandaRows = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM place_watches WHERE pubkey = ?').get(wanda.pk) as any).n);
    const wesCount = () => attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM place_watches WHERE pubkey = ?').get(wes.pk) as any).n);
    assert(spoof.status === 403 && wandaRows === 1 && wesCount() === 1, `another member's key in the body is refused by the spoof check, and nothing is written (${spoof.status})`);
    const sameCell = await call('POST', wes, '/api/global/watches', { lat: -28.61, lng: 153.64, radiusKm: 80 });
    assert(sameCell.status === 200 && sameCell.body?.created === false && sameCell.body?.watch?.radiusKm === 80 && wesCount() === 1,
        `the same cell again changes its radius, no second watch (${JSON.stringify(sameCell.body)})`);
    const b = await call('POST', wes, '/api/global/watches', { lat: -27.5, lng: 153.0 });
    const c = await call('POST', wes, '/api/global/watches', { lat: -29.0, lng: 153.3 });
    const over = await call('POST', wes, '/api/global/watches', { lat: -30.0, lng: 153.0 });
    assert(b.status === 200 && c.status === 200 && over.status === 409 && over.body?.code === 'watch_limit' && wesCount() === 3,
        `three watches a member; a fourth → 409 watch_limit (${b.status} ${c.status} ${over.status} ${JSON.stringify(over.body)})`);
    const theirs = await call('DELETE', wanda, `/api/global/watches/${c.body?.watch?.id}`);
    assert(theirs.status === 404 && wesCount() === 3, `nobody removes another member's watch: 404, and it stays (${theirs.status})`);
    const mine = await call('DELETE', wes, `/api/global/watches/${c.body?.watch?.id}`);
    assert(mine.status === 200 && wesCount() === 2, `a member removes their own (${mine.status})`);
    const unsigned = await call('POST', null, '/api/global/watches', BYRON_POINT);
    const nonMember = await call('POST', stranger, '/api/global/watches', BYRON_POINT);
    const unsignedList = await call('GET', null, '/api/global/watches');
    assert(unsigned.status === 401 && nonMember.status === 403 && unsignedList.status === 401,
        `unsigned → 401, a key that is not a member → 403, an unsigned list → 401 (${unsigned.status} ${nonMember.status} ${unsignedList.status})`);
    for (const [body, why] of [[{ lat: 'x', lng: 1 }, 'a latitude that is not a number'], [{ lat: 91, lng: 0 }, 'past the pole'], [{ lng: 1 }, 'no latitude'],
        [{ lat: 1, lng: 1, radiusKm: 5 }, 'a radius under 10 km'], [{ lat: 1, lng: 1, radiusKm: 500 }, 'a radius over 200 km'], [{ lat: 1, lng: 1, radiusKm: '50' }, 'a radius as text']] as const) {
        const r = await call('POST', theo, '/api/global/watches', body);
        assert(r.status === 400, `${why} → 400 (got ${r.status})`);
    }
    const nullRadius = await call('POST', theo, '/api/global/watches', { lat: -31.95, lng: 115.86, radiusKm: null });
    assert(nullRadius.status === 200 && nullRadius.body?.created === true && nullRadius.body?.watch?.radiusKm === 50,
        `a radius of null means the default, 50 km, not a 400 (${nullRadius.status} ${JSON.stringify(nullRadius.body)})`);
    const setT = await call('POST', theo, '/api/global/watches', { lat: -31.95, lng: 115.86 });
    assert(setT.status === 200, `Theo watches Perth (${setT.status})`);

    // ── 6. the hourly diff ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. new communities near a watch: one push per watcher, never twice ──');
    const sWes = await socket(wes);
    const sTheo = await socket(theo);
    const sPat = await socket(poster);
    pushed.length = 0;
    serve(V2);
    const r2 = await runMirror();
    await settle();
    assert(r2.ok === true && r2.added === 5, `five new communities (${JSON.stringify(r2)})`);
    assert(pushesTo(wes).length === 1, `Wes: exactly one push for the run, though two communities reach his watch (got ${pushesTo(wes).length})`);
    const wesPush = pushesTo(wes)[0];
    assert(same([...(wesPush?.data?.communities ?? [])].sort(), ['peer-bangalow', 'peer-byron']),
        `naming Byron and Bangalow, not Grafton (just out of reach) nor anything far away (${JSON.stringify(wesPush?.data)})`);
    assert(/^2 new communities/.test(wesPush?.body ?? '') && /about \d+ km/.test(wesPush?.body ?? '') && wesPush?.categoryId === 'marketplace',
        `in words: how many and how far, on the marketplace channel (${wesPush?.title} / ${wesPush?.body})`);
    const registryText = /Byron Shire|Bangalow Pool|Kiezpool|Grafton|Skipti/;
    assert(pushed.length > 0 && pushed.every(m => !registryText.test(`${m.title} ${m.body}`)) && announcements(sWes).every(e => !registryText.test(`${e.title} ${e.body}`)),
        'and no text from the registry in any push or announcement: anyone with a node key can publish a row'); 
    assert(pushesTo(wanda).length === 1 && same(pushesTo(wanda)[0]?.data?.communities, ['peer-kiez']), `Wanda: one push, for Kiezpool (${JSON.stringify(pushesTo(wanda)[0]?.data)})`);
    assert(pushesTo(theo).length === 0, 'Theo, watching Perth: nothing');
    assert(announcements(sWes).length === 1 && announcements(sWes)[0]?.kind === 'community_near_you',
        `Wes's own socket gets one system_announcement (${JSON.stringify(announcements(sWes))})`);
    assert(announcements(sTheo).length === 0 && announcements(sPat).length === 0, 'nobody else\'s socket hears it');
    assert(r2.notified === 2, `the run says two watchers were told (${r2.notified})`);

    pushed.length = 0;
    const r3 = await runMirror();
    await settle();
    assert(r3.ok === true && r3.added === 0 && pushed.length === 0 && announcements(sWes).length === 1, `the same registry again: nothing new, no push (${pushed.length})`);

    serve(V2.filter(r => r !== BYRON));
    const r4 = await runMirror();
    const gone = attempt(() => db.prepare('SELECT * FROM directory_cache WHERE community_key = ?').get('peer-byron') as any);
    const listedNow = await call('GET', null, `/api/global/communities?q=byron`);
    assert(r4.ok === true && gone?.listed === 0 && gone?.name === null && gone?.node_url === null && gone?.lat === null && gone?.contact_email === null
        && typeof gone?.first_seen_at === 'string' && same(keys(listedNow), []),
        `a community that leaves the registry is unlisted and scrubbed to its key and first sighting (${JSON.stringify(gone)})`);
    pushed.length = 0;
    serve(V2);
    const r5 = await runMirror();
    await settle();
    const back = await call('GET', null, `/api/global/communities?q=byron`);
    assert(r5.ok === true && r5.added === 0 && pushed.length === 0 && same(keys(back), ['peer-byron']),
        `and when it comes back it is listed again, with no second push (${pushed.length})`);

    const theoAtByron = await call('POST', theo, '/api/global/watches', { lat: -28.64, lng: 153.6 });
    pushed.length = 0;
    const r6 = await runMirror();
    await settle();
    assert(theoAtByron.status === 200 && r6.added === 0 && pushesTo(theo).length === 0,
        `a watch set after Byron was first seen is not told about Byron (${pushesTo(theo).length})`);
    serve([...V2, SUFFOLK]);
    const r7 = await runMirror();
    await settle();
    assert(r7.added === 1 && pushesTo(theo).length === 1 && same(pushesTo(theo)[0]?.data?.communities, ['peer-suffolk']),
        `a community new after that watch: Theo hears once (${pushesTo(theo).length})`);
    assert(/^A new community is now in the BeanPool directory, about \d+ km/.test(pushesTo(theo)[0]?.body ?? '') && !/Suffolk/.test(pushesTo(theo)[0]?.body ?? ''),
        `one community: how far, not its name (${pushesTo(theo)[0]?.body})`);
    assert(pushesTo(wes).length === 0 && announcements(sWes).length === 1 && r7.notified === 1,
        `Wes, told less than a day ago, is not told again today: Suffolk is on his card (${pushesTo(wes).length})`);
    const wesHeard = attempt(() => db.prepare('SELECT DISTINCT last_notified_at AS t FROM place_watches WHERE pubkey = ?').all(wes.pk) as any[]) ?? [];
    assert(wesHeard.length === 1 && typeof wesHeard[0]?.t === 'string', `every one of his watches carries when he last heard (${JSON.stringify(wesHeard)})`);

    // A day later he hears again. Wanda is pruned meanwhile.
    db.prepare('UPDATE place_watches SET last_notified_at = ? WHERE pubkey = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), wes.pk);
    adminPruneUser(wanda.pk, owner.pk);
    const wandaLeft = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM place_watches WHERE pubkey = ?').get(wanda.pk) as any).n);
    pushed.length = 0;
    serve([...V2, SUFFOLK, MITTE, BRUNSWICK]);
    const r8 = await runMirror();
    await settle();
    assert(r8.added === 2 && pushesTo(wes).length === 1 && same(pushesTo(wes)[0]?.data?.communities, ['peer-brunswick']) && announcements(sWes).length === 2,
        `a day on, Wes hears about Brunswick, once (${pushesTo(wes).length} ${JSON.stringify(pushesTo(wes)[0]?.data)})`);
    assert(pushesTo(theo).length === 0 && r8.notified === 1, `Theo, whose Byron watch Brunswick also reaches, heard today already (${pushesTo(theo).length})`);
    assert(wandaLeft === 0 && pushesTo(wanda).length === 0, `a pruned member's watches go with them, and they hear nothing about Mitte (${wandaLeft}, ${pushesTo(wanda).length})`);
    for (const s of [sWes, sTheo, sPat]) s.ws.close();

    const fay = member('Fay');
    db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`).run(fay.pk, pushToken(fay));
    const setF = await call('POST', fay, '/api/global/watches', { lat: -1.29, lng: 36.82, radiusKm: 200 });
    pushed.length = 0;
    serve([...V2, SUFFOLK, MITTE, BRUNSWICK, ...FLOOD]);
    const r9 = await runMirror();
    await settle();
    const floodListed = await call('GET', null, '/api/global/communities?q=flood&limit=50');
    assert(setF.status === 200 && r9.added === 26 && r9.notified === 0 && pushed.length === 0 && floodListed.body?.total === 26,
        `26 new communities in one run is a flood: listed, and nobody is told (${JSON.stringify(r9)})`);
    serve([...V2, SUFFOLK, MITTE, BRUNSWICK, ...FLOOD, NAIROBI]);
    const r10 = await runMirror();
    await settle();
    assert(r10.added === 1 && pushesTo(fay).length === 1 && same(pushesTo(fay)[0]?.data?.communities, ['peer-nairobi']),
        `and the next single community near Fay is news: one push (${pushesTo(fay).length})`);

    // ── 7. GET /api/global/home ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. the landing card, one request ──');
    createPost('offer', 'other', 'Near 1', 'Near Byron', 0, 'fixed', poster.pk, -28.645, 153.6);
    createPost('need', 'other', 'Near 2', 'Near Mullum', 0, 'fixed', poster.pk, -28.55, 153.5);
    createPost('offer', 'other', 'Far', 'In Castlemaine', 0, 'fixed', poster.pk, -37.07, 144.22);
    const home = await call('GET', wes, `/api/global/home?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}`);
    assert(home.status === 200, `a signed member: 200 (${home.status} ${home.text.slice(0, 200)})`);
    assert(same(keys(home), ['peer-byron', 'peer-suffolk', 'peer-bangalow']) && home.body?.point === 'request',
        `the three nearest communities from the point sent (${JSON.stringify(keys(home))})`);
    assert(home.body?.communityCount === 41, `and how many are listed in all (${home.body?.communityCount})`);
    assert(home.body?.nearbyPosts?.count === 2 && home.body?.nearbyPosts?.radiusKm === 50 && home.body?.nearbyPosts?.more === false,
        `posts within 50 km: 2, not the one in Castlemaine (${JSON.stringify(home.body?.nearbyPosts)})`);
    assert(Array.isArray(home.body?.watches) && home.body.watches.length === 2 && home.body.watches.every((w: any) => typeof w.id === 'string'),
        `the caller's own watches (${JSON.stringify(home.body?.watches)})`);
    assert(typeof home.body === 'object' && home.body !== null && 'knock' in home.body && home.body.knock === null, 'the knock seam is there, and null: no knock exists before G6');
    assert(typeof home.body?.directoryFetchedAt === 'string', 'and when the directory was fetched');
    const guest = await call('GET', null, `/api/global/home?lat=${BYRON_POINT.lat}&lng=${BYRON_POINT.lng}`);
    assert(guest.status === 200 && guest.body?.watches === null && same(keys(guest), keys(home)) && guest.body?.nearbyPosts?.count === 2,
        `unsigned: the same communities and posts, no watches (${guest.status} ${JSON.stringify(guest.body?.watches)})`);
    const noPoint = await call('GET', wes, '/api/global/home');
    assert(noPoint.status === 200 && noPoint.body?.point === null && same(keys(noPoint), []) && noPoint.body?.nearbyPosts === null && noPoint.body?.watches?.length === 2,
        `no point and no area: no nearest list and no post count, watches still there (${JSON.stringify(noPoint.body)})`);
    const area = await call('POST', wes, '/api/community/me/area', { lat: -37.07, lng: 144.22 });
    const fromArea = await call('GET', wes, '/api/global/home');
    assert(area.status === 200 && fromArea.body?.point === 'area' && keys(fromArea)[0] === 'peer-castle' && fromArea.body?.nearbyPosts?.count === 1,
        `no point, but the member's own area: measured from there (${JSON.stringify(keys(fromArea))}, ${JSON.stringify(fromArea.body?.nearbyPosts)})`);
    const badHome = await call('GET', wes, '/api/global/home?lat=1');
    assert(badHome.status === 400, `a half point → 400 (${badHome.status})`);

    // ── 8. the publisher honours publishToDirectory ─────────────────────────────────────────────────────────────
    console.log('\n── 8. the publisher: never on global, as today on local ──');
    const p2p = await startP2P(0, 0);
    updateLocalConfig({ communityName: 'The Lobby' });
    const writesBefore = registryWrites.length;
    const globalPush = await publisher.pushDirectoryNow();
    const globalInit = publisher.initDirectoryPublisher() as unknown;
    assert(globalPush.success === false && /publishToDirectory|not listed/i.test(String(globalPush.error)) && registryWrites.length === writesBefore,
        `global: a push is refused and nothing reaches the registry (${JSON.stringify(globalPush)})`);
    assert(globalInit === false, `global: the publisher's timer is not set (${String(globalInit)})`);
    setOverride('publishToDirectory', 'true');
    const overridden = await publisher.pushDirectoryNow();
    setOverride('publishToDirectory', null);
    assert(overridden.success === true && registryWrites.length === writesBefore + 1,
        `global with the operator's nodeProfile.publishToDirectory=true: listed as the operator decides (${JSON.stringify(overridden)})`);
    delete process.env.NODE_PROFILE;
    const localPush = await publisher.pushDirectoryNow();
    const localWrite = registryWrites[registryWrites.length - 1];
    assert(localPush.success === true && registryWrites.length === writesBefore + 2 && localWrite?.body?.callsign === 'The Lobby'
        && localWrite?.url === '/functions/v1/directory-register',
        `local: a push goes to the registry as it always has (${JSON.stringify(localPush)})`);
    const localInit = publisher.initDirectoryPublisher() as unknown;
    assert(localInit !== false, `local: the publisher's timer is set as it always was (${String(localInit)})`);
    await p2p.stop();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Global directory (G5) checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
