/**
 * Test Suite: a phone can ask the node for just the members it needs, and search on the node (DESIGN-global-members-by-
 * area §2.1 and §5's M1 row, #1792).
 *
 * On the global node a phone stops reading the whole member directory (20,000 strangers, 1.6 MB gzipped): it holds the
 * cards it has a reason to show and asks for the rest. GET /api/members gains three small forms, each straight past the
 * heavy-read cap, and the by-area listings carry what a phone with no card for their authors needs. Boots the real server
 * (NODE_PROFILE=global, read auth on, the fresh-download default) and reads through the real middleware, signed:
 *   1. features: `membersOnDemand: true` on global, absent on a local node, and an operator's override turns it off.
 *   2. `keys=`: the whole directory's rows of those keys, byte for byte, in the order asked, a pruned member, a treasury
 *      and an unknown key left out, a repeated key once; 100 keys answered, 101 refused, a key spelled any other way
 *      refused; with `updatedAfter` only those changed since, as the old delta has them, with the epoch header.
 *   3. `q=`: under 2 characters refused; a prefix of the name (case forgiven), never a substring, shortest first, at
 *      most 20 or `limit`; `%` and `_` are characters, not wildcards; 64 hexadecimal characters are one member's key;
 *      the statement's plan searches idx_members_callsign_unique.
 *   4. `lat&lng&limit=n` (n at most 50): exactly the first n of today's nearest-first list, with the null-distance tail
 *      while fewer than n have an area, at a busy place, a small one and nowhere; a non-member refused.
 *   5. An unsigned read of each form gets the read gate's answer, as the whole directory does; a visitor is refused.
 *   6. 200 reads of each form leave heavyReadStats().admitted where it was: none waits under the cap.
 *   7. No log line, console or file, names a key looked up or a name searched.
 *   8. `nearby=1` rows carry the author's face (`authorAvatarUrl`, as the directory's avatarUrl) for a member; a
 *      visitor's read carries none. An author renames: the next by-area delta carries their listings, with the new
 *      name, and nobody else's.
 *  8b. A local community with membersOnDemand on and nearbyListings off: an author removes their photo, and the next
 *      plain delta (revalidated with the tag held before) carries their listings with no face, and nobody else's, and so
 *      does a delta answered whole by a photo heal; a visitor's delta (the visitors' view on too) carries none; with
 *      the switch off, a rename leaves the plain delta byte for byte as it was.
 *   9. Faces heal: once the face URLs change shape (engine/avatar-keys.ts), a `keys=` delta from before is answered with
 *      every key asked, and a by-area delta from before is the whole set; one from after is as before.
 *  10. At 30,000 more members: `q` and `keys` p95 ≤ 5 ms, `near` ≤ 20 ms over HTTP (×3 on a loaded machine; the load is
 *      printed), and the whole directory and the old delta still answer (their bytes are test-members-snapshot's and
 *      test-members-directory-cost's to prove).
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-members-on-demand)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// The open-reads run (scripts/server-suites.mjs VARIANTS, MEMBERS_OPEN_READS=1): a node with read auth off, where the read
// gate lets an unsigned read of the whole directory through, so only the route's own check keeps keys= and q= signed
// (#1847 review NB2). It runs that check and stops, on a local node: the worldwide one will not start with read auth off
// (its guest view, config/node-profile.ts), and the forms answer on every node whatever the switch says.
const OPEN_READS = process.env.MEMBERS_OPEN_READS === '1';
if (OPEN_READS) process.env.ENFORCE_READ_AUTH = 'false'; else delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
delete process.env.NEARBY_LISTINGS_MAX;
process.env.NODE_PROFILE = OPEN_READS ? 'local' : 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localFetch } from './keepalive-test-fetch.js';

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

type Answer = { status: number; text: string; body: any; headers: Headers; ms: number };
async function get(p: string, id: Id | null): Promise<Answer> {
    const t0 = performance.now();
    const res = await localFetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, '', id) : {} });
    const text = await res.text();
    const ms = performance.now() - t0;
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, headers: res.headers, ms };
}

/** A line of the timings: printed, and kept in MEMBERS_ON_DEMAND_REPORT when set (a passing run's log is not kept). */
function note(line: string): void {
    console.log(line);
    if (process.env.MEMBERS_ON_DEMAND_REPORT) fs.appendFileSync(process.env.MEMBERS_ON_DEMAND_REPORT, line + '\n');
}

const p95 = (xs: number[]) => xs.length === 0 ? Infinity : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

let seedState = 0x5eed;
function rand(): number {
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
}

async function main() {
    console.log('A phone asks the node for just the members it needs...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getNodeFeatures, NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { heavyReadStats } = await import('./heavy-reads.js');
    const { noteFaceUrlShapeNow } = await import('./engine/avatar-keys.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { bumpMembersVersion } = await import('./engine/versions.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { PHOTO_KEYS_SINCE_ROW, notePhotoUrlShapeNow } = await import('./engine/photo-keys.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    // About 1,500 signed reads from one address: the gateway's minute throttle is another suite's (test-global-server-limits).
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    const insert = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury,
                                   area_lat, area_lng, area_updated_at, profile_updated_at)
                               VALUES (@pk, @callsign, @status, @joined, 'seed', 'TEST', @treasury, @lat, @lng, @areaAt, @profile)`);
    const iso = (ms: number) => new Date(ms).toISOString();
    const t0 = Date.parse('2026-09-01T00:00:00.000Z');
    let joinedN = 0;
    const member = (callsign: string, o: { status?: string; treasury?: number; area?: { lat: number; lng: number } | null; pk?: string } = {}): Id => {
        const id = keypair();
        const pk = o.pk ?? id.pubKeyHex;
        insert.run({
            pk, callsign, status: o.status ?? 'active', joined: iso(t0 + 1000 * joinedN++), treasury: o.treasury ?? 0,
            lat: o.area?.lat ?? null, lng: o.area?.lng ?? null, areaAt: o.area ? iso(t0) : null, profile: null,
        });
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
        return { ...id, pubKeyHex: pk };
    };
    const area = (c: { lat: number; lng: number }, km: number) => {
        const r = km * Math.sqrt(rand()) / 111;
        const t = rand() * 2 * Math.PI;
        return { lat: Math.round((c.lat + r * Math.sin(t)) * 10) / 10, lng: Math.round((c.lng + r * Math.cos(t) / Math.cos(c.lat * Math.PI / 180)) * 10) / 10 };
    };
    const BUSY = { lat: -33.9, lng: 151.2 };
    const SMALL = { lat: -37.1, lng: 144.2 };
    const NOWHERE = { lat: 10.0, lng: -150.0 };

    // ── The world: readers, the kinds of row the directory leaves out, names that share prefixes ──
    const reader = member('Reader', { area: BUSY });
    const second = member('Second', { area: SMALL });
    // The rows the directory leaves out have an area at the busy place, right where a reader stands, so only the near
    // form's own people filter keeps them out of "near you" (#1847 review NB3: an older or replicated pruned row can
    // keep its area; a treasury, escrow or project row never should have one, and must never show if it does).
    const pruned = member('Abpruned', { status: 'pruned', area: BUSY });
    const treasury = member('Abtreasury', { treasury: 1, area: BUSY });
    const migrated = member('Abmigrated', { status: 'migrated' });
    const escrowRow = member('escrow-row', { pk: 'escrow_' + crypto.randomBytes(8).toString('hex'), area: BUSY });
    const projectRow = member('project-row', { pk: 'project_' + crypto.randomBytes(8).toString('hex'), area: BUSY });
    const pct = member('ab%cd');
    const und = member('ab_cd');
    const plain = member('abxcd');
    const upper = member('ABBA');
    const inner = member('Xabby');  // "ab" inside, not at the start
    const people: Id[] = [];
    const syllables = ['ab', 'ka', 'mi', 'to', 'ru', 'le', 'sa', 'no', 'vi', 'de'];
    for (let i = 0; i < 260; i++) {
        const name = syllables[i % 10] + syllables[Math.floor(i / 10) % 10] + (i >= 100 ? String(i) : '');
        // The first 25 that have a place are in it before the tail: fewer than 50 placed at first (§4's null tail).
        people.push(member(name.charAt(0).toUpperCase() + name.slice(1), { area: i < 25 ? area(i % 2 ? BUSY : SMALL, 80) : null }));
    }
    const face = 'data:image/jpeg;base64,' + crypto.randomBytes(600).toString('base64');
    setMemberPhoto(db as any, people[3].pubKeyHex, face);
    bumpMembersVersion();

    const whole = async () => {
        const r = await get('/api/members', reader);
        return new Map((r.body as any[]).map(m => [m.publicKey, m]));
    };
    let W = await whole();
    assert(W.size >= 268 && !W.has(pruned.pubKeyHex) && !W.has(treasury.pubKeyHex) && W.has(migrated.pubKeyHex),
        `the whole directory: ${W.size} people, the pruned member and the treasury left out, the migrated one in`);

    if (OPEN_READS) {
        console.log('\n── read auth off: keys= and q= still need a signed request (NB2) ──');
        const open = await get('/api/members', null);
        assert(open.status === 200 && Array.isArray(open.body) && open.body.length === W.size,
            `unsigned whole read on a node with read auth off: 200 with every person (${open.status}, ${open.body?.length})`);
        for (const q of [`keys=${reader.pubKeyHex}`, 'q=ab', `keys=${reader.pubKeyHex}&updatedAfter=${encodeURIComponent(iso(t0))}`]) {
            const r = await get(`/api/members?${q}`, null);
            assert(r.status === 401, `unsigned ${q.split('=')[0]}= on a node with read auth off: 401 (${r.status})`);
            const signed = await get(`/api/members?${q}`, reader);
            assert(signed.status === 200 && Array.isArray(signed.body), `…signed: 200 (${signed.status})`);
        }
        console.log(`\n${passed}/${run} passed`);
        process.exit(passed === run ? 0 : 1);
    }

    // ── 1. features ──
    console.log('\n── 1. features.membersOnDemand ──');
    const info = await get('/api/community/info', reader);
    assert(info.body?.features?.membersOnDemand === true, `global: /api/community/info says membersOnDemand: true (${JSON.stringify(info.body?.features?.membersOnDemand)})`);
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(`${NODE_PROFILE_KEY}.membersOnDemand`, 'false');
    assert(!('membersOnDemand' in getNodeFeatures()), 'an operator\'s override membersOnDemand=false takes it out of features');
    db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.membersOnDemand`);
    process.env.NODE_PROFILE = 'local';
    const localFeatures = getNodeFeatures();
    process.env.NODE_PROFILE = 'global';
    assert(!('membersOnDemand' in localFeatures), 'a local node\'s features say nothing of it, byte for byte as before');
    assert(getNodeFeatures().membersOnDemand === true, 'the override gone, global says it again');

    // ── 2. keys= ──
    console.log('\n── 2. keys= ──');
    const unknown = crypto.randomBytes(32).toString('hex');
    const asked = [people[40], people[2], pct, people[3], people[200]].map(x => x.pubKeyHex);
    const withOut = [asked[0], pruned.pubKeyHex, asked[1], treasury.pubKeyHex, unknown, asked[2], asked[3], asked[0], asked[4]];
    const byKeys = await get(`/api/members?keys=${withOut.join(',')}`, reader);
    const expected = asked.map(k => W.get(k));
    assert(byKeys.status === 200 && byKeys.text === JSON.stringify(expected),
        `keys=: the whole directory's rows of those keys, byte for byte, in the order asked; pruned, treasury, unknown out, a repeat once (${byKeys.status}, ${byKeys.body?.length} rows)`);
    assert(byKeys.headers.get('cache-control') === 'private, no-store' && !byKeys.headers.get('etag'), `…kept by no cache, and no ETag (${byKeys.headers.get('cache-control')})`);
    const hundred = people.slice(0, 100).map(x => x.pubKeyHex);
    const r100 = await get(`/api/members?keys=${hundred.join(',')}`, reader);
    assert(r100.status === 200 && r100.body.length === 100 && r100.text.length < 40_000, `100 keys answered: ${r100.body?.length} rows, ${r100.text.length} bytes`);
    const r101 = await get(`/api/members?keys=${[...hundred, unknown].join(',')}`, reader);
    assert(r101.status === 400, `101 keys refused (${r101.status})`);
    for (const [label, q] of [
        ['a key in capitals', `keys=${asked[0].toUpperCase()}`], ['63 characters', `keys=${asked[0].slice(1)}`], ['an escrow_ key', 'keys=escrow_ab'],
        ['empty', 'keys='], ['twice', `keys=${asked[0]}&keys=${asked[1]}`], ['with q', `keys=${asked[0]}&q=ab`],
        ['with a limit', `keys=${asked[0]}&limit=5`], ['an empty part', `keys=${asked[0]},`],
    ] as const) {
        const r = await get(`/api/members?${q}`, reader);
        assert(r.status === 400, `keys= ${label}: refused (${r.status})`);
    }
    const cursor = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    const changedAt = new Date().toISOString();
    for (const x of [people[2], people[200]]) db.prepare('UPDATE members SET profile_updated_at = ? WHERE public_key = ?').run(changedAt, x.pubKeyHex);
    bumpMembersVersion();
    const delta = await get(`/api/members?keys=${asked.join(',')}&updatedAfter=${encodeURIComponent(cursor)}`, reader);
    const oldDelta = await get(`/api/members?updatedAfter=${encodeURIComponent(cursor)}`, reader);
    const oldRows = new Map((oldDelta.body as any[]).map(m => [m.publicKey, m]));
    assert(delta.status === 200 && delta.text === JSON.stringify([people[2], people[200]].map(x => oldRows.get(x.pubKeyHex))),
        `keys=&updatedAfter: only the two changed since, as the old delta has them (${delta.body?.map((m: any) => m.callsign).join(', ')})`);
    assert(!!delta.headers.get('x-beanpool-epoch') && delta.headers.get('x-beanpool-epoch') === oldDelta.headers.get('x-beanpool-epoch'),
        `…with the identity epoch, as the delta (${delta.headers.get('x-beanpool-epoch')})`);
    for (const q of [`updatedAfter=${encodeURIComponent(cursor)}&q=ab`, `updatedAfter=&keys=${asked[0]}`]) {
        const r = await get(`/api/members?${q}`, reader);
        assert(r.status === 400, `updatedAfter goes with keys only: ${q.slice(0, 40)}… refused (${r.status})`);
    }
    W = await whole();

    // ── 3. q= ──
    console.log('\n── 3. q= ──');
    const searchable = [...W.values()].filter(m => m.publicKey !== migrated.pubKeyHex);
    const lowerAscii = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
    const oracle = (prefix: string, n = 20) => searchable.filter(m => lowerAscii(m.callsign).startsWith(lowerAscii(prefix)))
        .sort((a, b) => a.callsign.length - b.callsign.length || (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0)).slice(0, n);
    for (const q of ['a', ' a ', '', 'A']) {
        const r = await get(`/api/members?q=${encodeURIComponent(q)}`, reader);
        assert(r.status === 400, `q=${JSON.stringify(q)}: refused, under 2 characters (${r.status})`);
    }
    const ab = await get('/api/members?q=ab', reader);
    const abWant = oracle('ab');
    assert(ab.status === 200 && ab.text === JSON.stringify(abWant) && ab.body.length === 20,
        `q=ab: the 20 shortest names that start with "ab", case forgiven, as the directory has them (${ab.body?.slice(0, 6).map((m: any) => m.callsign).join(', ')}…)`);
    assert(oracle('ab', 100).length > 20, `…of ${oracle('ab', 100).length} that match: limit 20 held`);
    assert(!ab.body.some((m: any) => m.publicKey === inner.pubKeyHex) && ab.body.some((m: any) => m.publicKey === upper.pubKeyHex),
        'a prefix, never a substring: "Xabby" is not in it; "ABBA" is');
    assert(!ab.body.some((m: any) => [pruned, treasury, migrated].some(x => x.pubKeyHex === m.publicKey)), 'never a pruned, a migrated member or a treasury');
    const five = await get('/api/members?q=AB&limit=5', reader);
    assert(five.status === 200 && five.text === JSON.stringify(oracle('ab', 5)), `q=AB&limit=5: the first 5, the same in capitals (${five.body?.length})`);
    for (const l of ['0', '21', 'x', '5.5', '-1']) {
        const r = await get(`/api/members?q=ab&limit=${l}`, reader);
        assert(r.status === 400, `q= limit=${l}: refused (${r.status})`);
    }
    const pctR = await get(`/api/members?q=${encodeURIComponent('ab%')}`, reader);
    const undR = await get(`/api/members?q=${encodeURIComponent('ab_')}`, reader);
    const wild = await get(`/api/members?q=${encodeURIComponent('%%')}`, reader);
    assert(pctR.status === 200 && pctR.body.length === 1 && pctR.body[0].publicKey === pct.pubKeyHex, `q=ab%: "ab%cd" alone, % is a character (${pctR.body?.map((m: any) => m.callsign)})`);
    assert(undR.status === 200 && undR.body.length === 1 && undR.body[0].publicKey === und.pubKeyHex, `q=ab_: "ab_cd" alone, not "abxcd" (${undR.body?.map((m: any) => m.callsign)})`);
    assert(wild.status === 200 && wild.body.length === 0, `q=%%: nobody (${wild.body?.length})`);
    const byKeyQ = await get(`/api/members?q=${plain.pubKeyHex.toUpperCase()}`, reader);
    assert(byKeyQ.status === 200 && byKeyQ.text === JSON.stringify([W.get(plain.pubKeyHex)]), `q=<64 hex>: that one member's row, in any case (${byKeyQ.body?.length})`);
    // The plan of the very statement the route runs: caught at prepare.
    const prepare = db.prepare.bind(db);
    let searchSql = '';
    (db as any).prepare = (sql: string) => { if (sql.includes('lower(callsign) >=')) searchSql = sql; return prepare(sql); };
    // Absent on a server from before the search (origin/main, fail-first): the plan check then fails, and the suite goes on.
    (se as any).searchMemberDirectoryRows?.('ab', 20);
    (db as any).prepare = prepare;
    const plan = !searchSql ? '(no search statement)' : (prepare(`EXPLAIN QUERY PLAN ${searchSql}`).all({ p: 'ab', like: 'ab%', limit: 20 }) as Array<{ detail: string }>).map(r => r.detail).join(' | ');
    assert(!!searchSql && plan.includes('idx_members_callsign_unique') && !/SCAN members\b(?! USING)/.test(plan), `the search's plan searches idx_members_callsign_unique (${plan})`);

    // ── 4. lat&lng&limit= ──
    console.log('\n── 4. lat&lng&limit= ──');
    const nearCheck = async (label: string) => {
        for (const [name, c] of [['the busy place', BUSY], ['the small place', SMALL], ['nowhere', NOWHERE]] as const) {
            for (const n of [50, 7]) {
                const q = `lat=${c.lat}&lng=${c.lng}`;
                const today = await get(`/api/members?${q}`, reader);
                const cut = await get(`/api/members?${q}&limit=${n}`, reader);
                assert(cut.status === 200 && cut.text === JSON.stringify((today.body as any[]).slice(0, n)),
                    `${label}, ${name}, limit=${n}: today's nearest-first list cut to ${n}, byte for byte (${cut.body?.filter((m: any) => m.distanceKm !== null).length} placed, ${cut.body?.filter((m: any) => m.distanceKm === null).length} not)`);
            }
        }
    };
    await nearCheck('27 placed');
    const leftOut = [pruned, treasury, escrowRow, projectRow].map(m => m.pubKeyHex);
    for (const n of [50, 7]) {
        const near = await get(`/api/members?lat=${BUSY.lat}&lng=${BUSY.lng}&limit=${n}`, reader);
        assert(near.status === 200 && !(near.body as any[]).some((m: any) => leftOut.includes(m.publicKey)),
            `limit=${n} at the busy place: the pruned member, the treasury, an escrow and a project row placed right there are not near anyone (NB3)`);
    }
    db.transaction(() => { for (let i = 0; i < 300; i++) member(`Near${i}`, { area: area(i % 3 === 0 ? SMALL : BUSY, i % 5 === 0 ? 3 : 200) }); })();
    bumpMembersVersion();
    await nearCheck('327 placed, many in one area');
    W = await whole();
    for (const q of ['lat=1&lng=2&limit=51', 'lat=1&lng=2&limit=0', 'limit=5', `lat=1&lng=2&limit=5&updatedAfter=${encodeURIComponent(cursor)}`, 'lat=1&lng=2&limit=5&q=ab']) {
        const r = await get(`/api/members?${q}`, reader);
        assert(r.status === 400, `${q}: refused (${r.status})`);
    }

    // ── 5. the read gate ──
    console.log('\n── 5. unsigned, and a visitor ──');
    const gate = await get('/api/members', null);
    const visitorId = keypair();
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor) VALUES (?, 'Visitor', 'active', ?, 'seed', 'TEST', 1)`)
        .run(visitorId.pubKeyHex, iso(Date.now()));
    const visitorWhole = await get('/api/members', visitorId);
    for (const q of [`keys=${asked[0]}`, 'q=ab', `lat=${BUSY.lat}&lng=${BUSY.lng}&limit=50`]) {
        const u = await get(`/api/members?${q}`, null);
        assert(u.status === gate.status && u.status >= 400 && !u.text.includes(asked[0]), `unsigned ${q.split('=')[0]}=: the read gate's answer, as the whole directory (${u.status} = ${gate.status})`);
        const v = await get(`/api/members?${q}`, visitorId);
        assert(v.status === 403 && visitorWhole.status === 403, `a visitor's ${q.split('=')[0]}=: refused, as the whole directory is (${v.status}, ${visitorWhole.status})`);
    }

    // ── 6. never under the cap ── and 7. never in a log ──
    console.log('\n── 6. straight past the heavy-read cap; 7. no log line names a key or a name ──');
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => { written.push(String(chunk)); return out(chunk, ...rest); };
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => { written.push(String(chunk)); return err(chunk, ...rest); };
    const secretName = people[7].pubKeyHex;
    const before = heavyReadStats().admitted;
    const forms = [`keys=${secretName},${asked[1]}`, 'q=Zqxv', `lat=${BUSY.lat}&lng=${BUSY.lng}&limit=50`];
    let ok = 0;
    for (const f of forms) for (let i = 0; i < 200; i++) if ((await get(`/api/members?${f}`, i % 2 ? reader : second)).status === 200) ok++;
    (process.stdout as any).write = out;
    (process.stderr as any).write = err;
    const after = heavyReadStats().admitted;
    assert(ok === 600 && after === before, `600 reads, 200 of each form, all answered: heavyReadStats().admitted ${before} → ${after}`);
    const wholeAdmits = heavyReadStats().admitted;
    await get('/api/members', reader);
    assert(heavyReadStats().admitted === wholeAdmits + 1, 'the whole directory still waits under the cap (admitted +1)');
    const fileHits: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (!/\.(db|sqlite)(-wal|-shm)?$|state\.db/.test(e.name) && fs.statSync(p).size < 50_000_000) {
                const text = fs.readFileSync(p, 'latin1');
                if (text.includes(secretName) || text.includes('Zqxv')) fileHits.push(p);
            }
        }
    };
    if (process.env.BEANPOOL_DATA_DIR) walk(process.env.BEANPOOL_DATA_DIR);
    assert(!written.some(l => l.includes(secretName) || l.includes('Zqxv')) && fileHits.length === 0,
        `nothing written while they ran names the key looked up or the name searched (${written.length} lines, files: ${fileHits.join(', ') || 'none'})`);

    // ── 8. by-area listings: the author's face, and a renamed author's rows ──
    console.log('\n── 8. nearby=1 rows ──');
    const SYNC = '/api/marketplace/posts?limit=200&sync=true&types=offer,need,poll,event&nearby=1';
    const author = people[3];      // has a face
    const other = people[1];
    const postInsert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, lat, lng)
                                   VALUES (?, 'offer', 'food', ?, '', 5, ?, 'active', 1, ?, ?, ?, ?)`);
    const old = iso(Date.now() - 3 * 86_400_000);
    for (let i = 0; i < 3; i++) postInsert.run(`face-${i}`, `Bread ${i}`, author.pubKeyHex, old, old, BUSY.lat + 0.01 * i, BUSY.lng);
    for (let i = 0; i < 3; i++) postInsert.run(`other-${i}`, `Jam ${i}`, other.pubKeyHex, old, old, BUSY.lat - 0.01 * i, BUSY.lng);
    const { bumpPostsVersion } = await import('./engine/versions.js');
    bumpPostsVersion();
    const readSet = async (since?: string) => {
        const r = await get(`${SYNC}${since ? `&updatedAfter=${encodeURIComponent(since)}` : ''}`, reader);
        return { r, posts: (r.body?.posts ?? []) as any[] };
    };
    const first = await readSet();
    W = await whole();
    const faceRows = first.posts.filter(p => p.authorPublicKey === author.pubKeyHex);
    assert(first.r.status === 200 && faceRows.length === 3 && !!W.get(author.pubKeyHex)?.avatarUrl
        && faceRows.every(p => p.authorAvatarUrl === W.get(author.pubKeyHex).avatarUrl && p.authorCallsign === W.get(author.pubKeyHex).callsign),
        `nearby=1: each of the author's rows carries their name and face, as the directory has them (${faceRows[0]?.authorAvatarUrl?.slice(0, 40)}…)`);
    const guest = await get('/api/marketplace/posts?limit=200&sync=true&types=offer,need', null);
    const guestRows = (Array.isArray(guest.body) ? guest.body : guest.body?.posts ?? []).filter((p: any) => String(p.id).startsWith('face-'));
    assert(guest.status === 200 && guestRows.length === 3 && guestRows.every((p: any) => !p.authorAvatarUrl && !p.authorCallsign),
        `a visitor's read carries no author: no face, no name (${guestRows.map((p: any) => JSON.stringify(p.authorAvatarUrl ?? null)).join(',')})`);
    const since = new Date().toISOString();
    const quiet = await readSet(since);
    assert(quiet.r.status === 200 && !quiet.posts.some(p => String(p.id).startsWith('face-')), `before the rename, a delta from now carries none of them (${quiet.posts.length} rows)`);
    await new Promise(r => setTimeout(r, 5));
    const renamed = se.updateProfile(author.pubKeyHex, { callsign: 'Renamed Baker' });
    const stamp = (db.prepare('SELECT profile_updated_at AS at FROM members WHERE public_key = ?').get(author.pubKeyHex) as { at: string }).at;
    assert(!!renamed && stamp > since, `the author renames (profile_updated_at ${stamp})`);
    const next = await readSet(since);
    const again = next.posts.filter(p => p.authorPublicKey === author.pubKeyHex);
    assert(next.r.status === 200 && again.length === 3 && again.every(p => p.authorCallsign === 'Renamed Baker'),
        `the next by-area delta carries their 3 listings, with the new name (${again.map(p => p.authorCallsign).join(', ')})`);
    assert(!next.posts.some(p => p.authorPublicKey === other.pubKeyHex), 'and nobody else\'s');
    const plainSync = await get(`/api/marketplace/posts?limit=200&sync=true&types=offer,need,poll,event&updatedAfter=${encodeURIComponent(since)}`, reader);
    const plainRows = (Array.isArray(plainSync.body) ? plainSync.body : []).filter((p: any) => p.authorPublicKey === author.pubKeyHex);
    assert(plainSync.status === 200 && plainRows.length === 0, `a sync read without nearby=1 is as before: the rename sends no listing again (${plainRows.length})`);

    // ── 8b. members on demand without by-area listings: the plain delta sends again a changed author's listings ──
    // A self-hosted community may turn membersOnDemand on and leave nearbyListings off (config/node-profile.ts): its
    // phones hold no card for most listing authors and sync with the plain delta, so a card edit must re-send that
    // author's listings there (opus-1859-confirm1 NB-2). With the switch off, the delta is byte for byte as before.
    console.log('\n── 8b. membersOnDemand on, nearbyListings off: the plain delta ──');
    // The reader's (signed) unless `unsigned`: then a visitor's, where the visitors' view lets one read the listings.
    const plainDelta = async (from: string, etag?: string, o: { unsigned?: boolean; limit?: number } = {}) => {
        const p = `/api/marketplace/posts?limit=${o.limit ?? 200}&sync=true&types=offer,need,poll,event&updatedAfter=${encodeURIComponent(from)}`;
        const res = await localFetch(`${BASE}${p}`, { headers: { ...(o.unsigned ? {} : signedHeaders('GET', p, '', reader)), ...(etag ? { 'If-None-Match': etag } : {}) } });
        const text = await res.text();
        let rows: any[] = [];
        try { rows = JSON.parse(text); } catch { /* a 304 has no body */ }
        return { status: res.status, text, rows: Array.isArray(rows) ? rows : [], etag: res.headers.get('etag') ?? '', view: res.headers.get('x-beanpool-view') ?? '' };
    };
    const overrideKey = `${NODE_PROFILE_KEY}.membersOnDemand`;
    process.env.NODE_PROFILE = 'local';
    try {
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(overrideKey, 'true');
        const { getProfileSwitches } = await import('./config/node-profile.js');
        const sw = getProfileSwitches();
        assert(sw.membersOnDemand && !sw.nearbyListings && getNodeFeatures().membersOnDemand === true,
            `a local community with membersOnDemand on and nearbyListings off (${sw.membersOnDemand}, ${sw.nearbyListings})`);
        const since2 = new Date().toISOString();
        const quiet2 = await plainDelta(since2);
        assert(quiet2.status === 200 && !quiet2.rows.some(p => p.authorPublicKey === author.pubKeyHex),
            `before the edit, a plain delta from now carries none of the author's listings (${quiet2.rows.length} rows)`);
        await new Promise(r => setTimeout(r, 5));
        se.updateProfile(author.pubKeyHex, { avatar: null });
        W = await whole();
        assert(W.get(author.pubKeyHex)?.avatarUrl == null, `the author removes their photo (directory avatarUrl ${JSON.stringify(W.get(author.pubKeyHex)?.avatarUrl ?? null)})`);
        // The phone revalidates with the tag it held: the edit moved the listings' version, so it is answered, never 304.
        // Its statements are kept, to read their plans.
        const ran: Array<{ sql: string; params: any[] }> = [];
        const prepare = db.prepare;
        (db as any).prepare = (sql: string) => new Proxy(prepare.call(db, sql), {
            get(stmt, prop) {
                const value = Reflect.get(stmt, prop, stmt);
                if (typeof value !== 'function') return value;
                if (prop !== 'all' && prop !== 'get') return value.bind(stmt);
                return (...params: any[]) => { ran.push({ sql, params }); return value.apply(stmt, params); };
            },
        });
        let sent: Awaited<ReturnType<typeof plainDelta>>;
        try { sent = await plainDelta(since2, quiet2.etag); } finally { (db as any).prepare = prepare; }
        const theirs = sent.rows.filter(p => p.authorPublicKey === author.pubKeyHex);
        assert(sent.status === 200 && theirs.length === 3 && theirs.every(p => p.authorAvatarUrl == null && p.authorCallsign === 'Renamed Baker'),
            `the next plain delta (revalidated with the old tag) carries their 3 listings, with no face (${sent.status}, ${theirs.length}: ${theirs.map(p => JSON.stringify(p.authorAvatarUrl ?? null)).join(',')})`);
        assert(!sent.rows.some(p => p.authorPublicKey === other.pubKeyHex), 'and nobody else\'s');
        const later = await plainDelta(new Date(Date.now() + 1000).toISOString());
        assert(later.status === 200 && later.rows.length === 0, `a delta from after the edit sends nothing again (${later.rows.length} rows)`);
        // Not kept to a set, so it must stay an index search: the authors whose card changed by their own index, and no
        // statement of the read walks every post.
        const deltaRead = ran.find(r => /\bFROM posts p\b/.test(r.sql) && r.sql.includes('profile_updated_at >= ?'));
        const deltaPlan = deltaRead ? (db.prepare(`EXPLAIN QUERY PLAN ${deltaRead.sql}`).all(...deltaRead.params) as Array<{ detail: string }>).map(p => p.detail) : [];
        assert(deltaPlan.some(d => /^SEARCH members USING (COVERING )?INDEX idx_members_profile_updated_at \(profile_updated_at>\?\)/.test(d))
            && !deltaPlan.some(d => /^SCAN (p|members)\b/.test(d)),
            `the delta finds the authors whose card changed by idx_members_profile_updated_at, and walks no table (${deltaPlan.join('; ')})`);

        // With the visitors' view on too (an operator's choice), a visitor's delta never says whose card changed: it sends
        // nothing again, while a member's at the same moment does (review of #1899, NB-B).
        const guestKey = `${NODE_PROFILE_KEY}.guestListingsOnly`;
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(guestKey, 'true');
        try {
            const memberNow = await plainDelta(since2);
            const visitorNow = await plainDelta(since2, undefined, { unsigned: true });
            assert(getProfileSwitches().guestListingsOnly && memberNow.rows.filter(p => p.authorPublicKey === author.pubKeyHex).length === 3
                && visitorNow.status === 200 && visitorNow.view === 'guest' && visitorNow.rows.length === 0,
                `the visitors' view on too: a visitor's delta sends nothing again (${visitorNow.status} ${visitorNow.view}: ${visitorNow.rows.map(p => p.id).join(', ') || 'none'}); a member's carries the 3`);
        } finally {
            db.prepare('DELETE FROM node_config WHERE key = ?').run(guestKey);
        }

        // A delta from before the listing photos' URLs last changed is answered whole (engine/photo-keys.ts photoHealFor):
        // its delta part sends the author's listings again too, ahead of the heal's page (review of #1899, NB-B). A page
        // of 3 keeps the heal's own rows to 3, so the author's come only from the delta: theirs, then the heal's page (the
        // other's listings rank first there: no photo, on the board and stamped alike, then by id).
        const sinceRow = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(PHOTO_KEYS_SINCE_ROW) as { value: string } | undefined)?.value;
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(PHOTO_KEYS_SINCE_ROW, new Date().toISOString());
        notePhotoUrlShapeNow();
        try {
            const healed = await plainDelta(since2, undefined, { limit: 3 });
            const healRow = db.prepare('SELECT 1 FROM photo_url_heals WHERE viewer = ?').get(reader.pubKeyHex);
            assert(healed.status === 200 && !!healRow && healed.rows.length === 6
                && healed.rows.slice(0, 3).every(p => p.authorPublicKey === author.pubKeyHex && p.authorAvatarUrl == null)
                && healed.rows.slice(3).every(p => p.authorPublicKey === other.pubKeyHex),
                `a delta from before the listing photos' URLs changed (answered whole): the author's 3 listings, then the heal's page (${healed.rows.map(p => p.id).join(', ')})`);
        } finally {
            if (sinceRow === undefined) db.prepare('DELETE FROM node_config WHERE key = ?').run(PHOTO_KEYS_SINCE_ROW);
            else db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(sinceRow, PHOTO_KEYS_SINCE_ROW);
            notePhotoUrlShapeNow();
        }

        // The switch off (the local default): the same edit leaves the delta byte for byte as it was before the edit.
        db.prepare('DELETE FROM node_config WHERE key = ?').run(overrideKey);
        assert(!getProfileSwitches().membersOnDemand, 'the switch off again: a local community as shipped');
        const since3 = new Date().toISOString();
        // One listing that did change, so the answer compared is not an empty one.
        await new Promise(r => setTimeout(r, 5));
        db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), 'other-0');
        bumpPostsVersion();
        const before3 = await plainDelta(since3);
        await new Promise(r => setTimeout(r, 5));
        se.updateProfile(author.pubKeyHex, { callsign: 'Baker Again' });
        const after3 = await plainDelta(since3);
        assert(after3.status === 200 && before3.rows.length === 1 && after3.text === before3.text && !after3.rows.some(p => p.authorPublicKey === author.pubKeyHex),
            `membersOnDemand off: the delta after a rename is byte for byte the one before it (${after3.text.length} = ${before3.text.length} bytes)`);
    } finally {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(overrideKey);
        process.env.NODE_PROFILE = 'global';
    }

    // ── 9. faces heal ──
    console.log('\n── 9. faces heal ──');
    const beforeShape = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('avatarKeysShape', 'open')").run();
    noteFaceUrlShapeNow();
    const healKeys = await get(`/api/members?keys=${asked.join(',')}&updatedAfter=${encodeURIComponent(beforeShape)}`, reader);
    W = await whole();
    assert(healKeys.status === 200 && healKeys.text === JSON.stringify(asked.map(k => W.get(k))),
        `a keys= delta from before the face URLs changed: every key asked, as the whole directory has them (${healKeys.body?.length} of ${asked.length})`);
    const afterShape = new Date(Date.now() + 1000).toISOString();
    const healedNot = await get(`/api/members?keys=${asked.join(',')}&updatedAfter=${encodeURIComponent(afterShape)}`, reader);
    assert(healedNot.status === 200 && healedNot.body.length === 0, `one from after: only what changed, nothing (${healedNot.body?.length})`);
    const wholeSet = await readSet();
    const healSet = await readSet(beforeShape);
    const ids = (x: { posts: any[] }) => x.posts.map(p => p.id).sort().join(',');
    assert(healSet.r.status === 200 && healSet.posts.length === wholeSet.posts.length && ids(healSet) === ids(wholeSet) && healSet.posts.length >= 6,
        `a by-area delta from before: the whole set (${healSet.posts.length} rows = ${wholeSet.posts.length})`);
    const notHealSet = await readSet(afterShape);
    assert(notHealSet.r.status === 200 && notHealSet.posts.length === 0, `one from after: as before (${notHealSet.posts.length} rows)`);

    // ── 10. at 30,000 more members ──
    console.log('\n── 10. at 30,000 more members ──');
    const many: string[] = [];
    db.transaction(() => {
        for (let i = 0; i < 30_000; i++) {
            const name = syllables[i % 10] + syllables[Math.floor(i / 10) % 10] + syllables[Math.floor(i / 100) % 10] + i;
            const pk = crypto.randomBytes(32).toString('hex');
            many.push(pk);
            const at = i % 4 ? area(i % 3 ? BUSY : SMALL, 400) : null;
            insert.run({ pk, callsign: name, status: 'active', joined: iso(t0 + 1000 * joinedN++), treasury: 0,
                lat: at?.lat ?? null, lng: at?.lng ?? null, areaAt: at ? iso(t0) : null, profile: null });
        }
    })();
    bumpMembersVersion();
    // Over HTTP, signed, through the middleware. The Mac these run on is shared with other runs, so a round taken while
    // it is busy is taken again, up to three: each gate holds on the best round's p95, and every round's load is printed.
    const round = async () => {
        const times = { q: [] as number[], keys: [] as number[], near: [] as number[] };
        for (let i = 0; i < 60; i++) {
            const qs = ['ka', 'mito', 'Rule', 'sano1', 'abab'][i % 5];
            const q = await get(`/api/members?q=${qs}`, reader);
            if (q.status === 200) times.q.push(q.ms);
            const ks = many.slice((i * 100) % 29_900, (i * 100) % 29_900 + 100);
            const k = await get(`/api/members?keys=${ks.join(',')}`, i % 2 ? reader : second);
            if (k.status === 200 && k.body.length === 100) times.keys.push(k.ms);
            const c = [BUSY, SMALL, NOWHERE][i % 3];
            const n = await get(`/api/members?lat=${c.lat}&lng=${c.lng}&limit=50`, reader);
            if (n.status === 200 && n.body.length === 50) times.near.push(n.ms);
        }
        return { load: os.loadavg()[0], all: times.q.length === 60 && times.keys.length === 60 && times.near.length === 60,
            q: p95(times.q), keys: p95(times.keys), near: p95(times.near) };
    };
    const best = { q: Infinity, keys: Infinity, near: Infinity, all: true };
    let slack = 1;
    for (let r = 1; r <= 3; r++) {
        const t = await round();
        best.q = Math.min(best.q, t.q); best.keys = Math.min(best.keys, t.keys); best.near = Math.min(best.near, t.near); best.all &&= t.all;
        // ×3 where the machine is busier than half its cores (the design's allowance for the droplet).
        if (t.load > os.cpus().length / 2) slack = 3;
        note(`   round ${r}: load ${t.load.toFixed(1)} on ${os.cpus().length} cores; p95 q ${t.q.toFixed(2)} ms, keys ${t.keys.toFixed(2)} ms, near ${t.near.toFixed(2)} ms`);
        // A round whose forms did not answer as asked (a server from before them) is not taken again.
        if (!t.all || (best.q <= 5 && best.keys <= 5 && best.near <= 20)) break;
    }
    const load = os.loadavg().map(x => x.toFixed(1)).join(' ');
    assert(best.all && best.q <= 5 * slack, `q at ${W.size + 30_000} members: p95 ${best.q.toFixed(2)} ms ≤ ${5 * slack} ms (load ${load})`);
    assert(best.all && best.keys <= 5 * slack, `keys (100) at ${W.size + 30_000} members: p95 ${best.keys.toFixed(2)} ms ≤ ${5 * slack} ms`);
    assert(best.all && best.near <= 20 * slack, `near (50) at ${W.size + 30_000} members: p95 ${best.near.toFixed(2)} ms ≤ ${20 * slack} ms`);
    const bigToday = await get(`/api/members?lat=${BUSY.lat}&lng=${BUSY.lng}`, reader);
    const bigCut = await get(`/api/members?lat=${BUSY.lat}&lng=${BUSY.lng}&limit=50`, reader);
    note(`   at 30k: today's whole nearest-first list ${(bigToday.text.length / 1e6).toFixed(1)} MB in ${bigToday.ms.toFixed(0)} ms; limit=50 ${bigCut.text.length} bytes in ${bigCut.ms.toFixed(1)} ms`);
    assert(bigCut.text === JSON.stringify((bigToday.body as any[]).slice(0, 50)), `…and still today's list cut to 50, byte for byte (today's whole: ${(bigToday.text.length / 1e6).toFixed(1)} MB in ${bigToday.ms.toFixed(0)} ms; cut: ${bigCut.text.length} bytes in ${bigCut.ms.toFixed(1)} ms)`);
    const bigQ = await get('/api/members?q=kami', reader);
    searchable.splice(0, searchable.length, ...[...(await whole()).values()].filter(m => m.publicKey !== migrated.pubKeyHex));
    assert(bigQ.status === 200 && bigQ.body.length === 20 && bigQ.text === JSON.stringify(oracle('kami')),
        `q=kami at 30k: the 20 the whole directory gives, shortest first (${bigQ.body?.slice(0, 3).map((m: any) => m.callsign).join(', ')}…)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
