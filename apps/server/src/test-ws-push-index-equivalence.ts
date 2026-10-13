/**
 * Listing pushes by area through the sockets' index (ws-area-index.ts, #1791 item 5) against the full loop over every
 * socket that came before it: the same sockets get the same frames, push after push, while the world changes under them.
 *
 * In this process, on the global profile (listings sync by area), fake sockets in the real set (addWsClient), the real
 * broadcast, and every change through the code that makes it on a node:
 *   1. a seeded world: 3,000 members, areas anywhere, on and either side of the antimeridian and at and around both
 *      poles, a tenth with no area; 3,500+ sockets: a member's, two of one member's, keyless ones, ones mid-join
 *   2. 1,200 pushes of a listing (new_post with the post, post_updated and post_removed by id, some with parties of a
 *      removal), each sent once through the full loop and once through the index, the frames each socket got compared;
 *      between pushes, at random: a socket connects, disconnects, dies on a send; a member sets, moves or clears their
 *      area; an area changes under the map's refresh as an import's does; a member re-keys and connects with the new
 *      key; a member is removed; someone mid-join joins; rows change behind the map and it loads again whole.
 *      After every change and every push, the index's rules (WsClients.inspect): every open socket with a key is filed
 *      under exactly that key and nothing else is; with the cells built, they hold exactly the keys with an open socket
 *      and an area, each in its own cell. Then every socket closes, and the index is empty
 *   2b. no code writes a socket's key but the connect (before the socket is in the set) and wsClients.setKey: a key
 *      written any other way would leave the socket filed under the old one (#1809 review, NB-1)
 *   3. the cost at 3,500 and 10,000 sockets: a push near a dense spot and one in an empty ocean, the full loop against
 *      the index, interleaved, with the host's load (`uptime`) printed with each
 *
 * Run with a radius (NEARBY_LISTINGS_RADIUS_KM) other than the default by its variants in scripts/server-suites.mjs.
 * Seed: PUSH_INDEX_SEED (printed). Run: SERVER_SUITES_ONLY=test-ws-push-index-equivalence node scripts/run-server-suites.mjs
 */
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_ROLE;
delete process.env.NEARBY_LISTINGS_MAX;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// PUSH_INDEX_REPORT: a file each line below is also appended to (the runner keeps no log of a passing run).
const REPORT = process.env.PUSH_INDEX_REPORT;
const RADIUS_TAG = process.env.NEARBY_LISTINGS_RADIUS_KM || 'default';
function say(line: string, failed = false): void {
    if (failed) console.error(line); else console.log(line);
    if (REPORT) fs.appendFileSync(REPORT, `[radius ${RADIUS_TAG}] ${line}\n`);
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; say(`✓ ${msg}`); } else say(`✗ ${msg}`, true);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// A seeded generator, so a failure is repeated by its seed.
const SEED = Number(process.env.PUSH_INDEX_SEED) || crypto.randomInt(1, 2 ** 31);
let state = SEED >>> 0;
function rand(): number {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const round = (x: number) => Math.round(x * 10) / 10;
const HUBS = [{ lat: -28.5, lng: 153.5 }, { lat: 51.5, lng: -0.1 }, { lat: -17.8, lng: 178.4 }, { lat: 64.1, lng: -21.9 }];

/** A place on the Earth as areas and listings are stored: anywhere, at the antimeridian, at the poles, near a hub. */
function randomPoint(): { lat: number; lng: number } {
    const r = rand();
    if (r < 0.3) return { lat: round(-90 + rand() * 180), lng: round(-180 + rand() * 360) };
    if (r < 0.45) return { lat: round(-60 + rand() * 120), lng: rand() < 0.5 ? round(178 + rand() * 2) : round(-180 + rand() * 2) };
    if (r < 0.6) {
        const lat = rand() < 0.2 ? 90 : round(84 + rand() * 6);
        return { lat: rand() < 0.5 ? lat : -lat, lng: round(-180 + rand() * 360) };
    }
    const hub = pick(HUBS);
    let lng = round(hub.lng + (rand() - 0.5) * 8);
    if (lng > 180) lng = round(lng - 360);
    if (lng < -180) lng = round(lng + 360);
    return { lat: Math.max(-90, Math.min(90, round(hub.lat + (rand() - 0.5) * 6))), lng };
}

async function main(): Promise<void> {
    console.log(`\n=== Listing pushes by area: the index against the full loop (seed ${SEED}) ===\n`);
    const se = await import('./state-engine.js');
    const { db, initSchema } = await import('./db/db.js');
    const area = await import('./engine/member-area.js');
    const { getProfileSwitches, nearbyListingsLimits } = await import('./config/node-profile.js');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    initSchema();
    se.initStateEngine();
    assert(getProfileSwitches().nearbyListings === true, 'setup: listings sync by area');
    const radiusKm = nearbyListingsLimits().radiusKm;
    say(`   radius ${radiusKm} km, seed ${SEED}`);

    // ── 1. the world ────────────────────────────────────────────────────────────────────────────
    const members: string[] = [];
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, area_lat, area_lng)
                                     VALUES (?, ?, ?, 'seed', 'seed', 'active', ?, ?)`);
    const newMember = (): string => {
        const pk = crypto.randomBytes(32).toString('hex');
        const p = rand() < 0.1 ? null : randomPoint();
        insertMember.run(pk, `Eq${members.length}`, '2020-01-01T00:00:00.000Z', p?.lat ?? null, p?.lng ?? null);
        members.push(pk);
        return pk;
    };
    db.transaction(() => { for (let i = 0; i < 3000; i++) newMember(); })();
    const posts: string[] = [];
    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, accepted_by, lat, lng)
                                   VALUES (?, 'offer', 'other', ?, 'equivalence', ?, ?, ?, ?)`);
    db.transaction(() => {
        for (let i = 0; i < 400; i++) {
            const id = crypto.randomUUID();
            const p = rand() < 0.1 ? null : randomPoint();
            insertPost.run(id, `Listing ${i}`, pick(members), rand() < 0.2 ? pick(members) : null, p?.lat ?? null, p?.lng ?? null);
            posts.push(id);
        }
    })();
    area.loadMemberAreas();

    // Every frame any fake socket got, as `<socket>|<frame>`.
    let frames: string[] = [];
    const sockets: any[] = [];
    let nextId = 0;
    const connect = (memberKey: string | null, pending: string | null = null): any => {
        const id = nextId++;
        const ws: any = {
            id, readyState: 1, dies: false,
            _memberPubkey: memberKey, _visitor: false, _memberFeed: !!memberKey, _openFeed: false, _pendingMemberPubkey: pending,
            send(m: string) { if (this.dies) throw new Error('gone'); frames.push(`${id}|${m}`); },
        };
        se.addWsClient(ws);
        sockets.push(ws);
        return ws;
    };
    const live = () => sockets.filter(s => !s.closed);
    // The members with an open socket, for the picks below: a Set, so a pick is not members × sockets (NB-4).
    const liveMembers = () => { const keys = new Set(live().map(s => s._memberPubkey)); return members.filter(pk => keys.has(pk)); };
    // The index's rules, after every change and every push: what broke, and after what.
    let inspections = 0;
    const broken: Record<string, number> = {};
    const brokenExamples: string[] = [];
    const inspect = (after: string) => {
        inspections++;
        for (const problem of se.inspectWsClients().problems) {
            broken[after] = (broken[after] ?? 0) + 1;
            if (brokenExamples.length < 5) brokenExamples.push(`after "${after}": ${problem}`);
        }
    };
    for (const pk of members) connect(pk);
    for (let i = 0; i < 400; i++) connect(pick(members));          // a member's second (or third) device
    for (let i = 0; i < 80; i++) connect(null);                     // no member's key
    for (let i = 0; i < 40; i++) connect(null, newMemberLater());   // signed before their membership existed
    function newMemberLater(): string { return crypto.randomBytes(32).toString('hex'); }
    const pendingKeys = sockets.filter(s => s._pendingMemberPubkey).map(s => s._pendingMemberPubkey as string);
    assert(sockets.length >= 3500, `setup: ${sockets.length} sockets, ${members.length} members`);

    // ── 2. pushes, the two side by side, while the world changes ───────────────────────────────
    const changes: Record<string, number> = {};
    let lastChange = 'nothing';
    const did = (what: string) => { changes[what] = (changes[what] ?? 0) + 1; lastChange = what; };
    const close = (ws: any) => { ws.closed = true; se.removeWsClient(ws); };
    const change = () => {
        const r = rand();
        if (r < 0.12) { connect(rand() < 0.9 ? pick(members) : null); did('connect'); }
        else if (r < 0.22) { const ws = pick(live()); if (ws) { close(ws); did('disconnect'); } }
        else if (r < 0.27) {
            // A socket that dies on a send leaves the set from inside broadcast (wsClients.delete).
            const ws = pick(live().filter(s => s._memberPubkey));
            if (ws) { ws.dies = true; ws.closed = true; se.broadcast({ type: 'equivalence_probe' }, [ws._memberPubkey]); did('dies on a send'); }
        }
        else if (r < 0.45) { area.setMemberArea(pick(members), randomPoint()); did('area set or moved'); }
        else if (r < 0.52) { area.setMemberArea(pick(members), null); did('area cleared'); }
        else if (r < 0.6) {
            // As a standby's import writes it (engine/sync.ts): the row inside a transaction, the map after it commits.
            const pk = pick(members), p = rand() < 0.2 ? null : randomPoint();
            db.transaction(() => {
                db.prepare('UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?').run(p?.lat ?? null, p?.lng ?? null, pk);
                area.refreshMemberAreas([pk]);
            })();
            did('area imported');
        }
        else if (r < 0.7) {
            const old = pick(liveMembers());
            if (!old) return;
            const fresh = crypto.randomBytes(32).toString('hex');
            try {
                completeRekey(old, fresh, issueRekeyCode(old, 'owner:password').code, 'owner:password');
            } catch (e: any) { did(`re-key refused: ${e?.message}`); return; }
            members[members.indexOf(old)] = fresh;
            connect(fresh);
            did('re-key, the new phone connects');
        }
        else if (r < 0.76) {
            const pk = pick(liveMembers());
            if (!pk) return;
            se.adminPruneUser(pk, 'owner:password');
            members.splice(members.indexOf(pk), 1);
            did('member removed');
        }
        else if (r < 0.84) {
            const pk = pendingKeys.pop();
            if (!pk) return;
            const p = rand() < 0.2 ? null : randomPoint();
            insertMember.run(pk, `Joiner${pk.slice(0, 12)}`, new Date().toISOString(), p?.lat ?? null, p?.lng ?? null);
            members.push(pk);
            area.refreshMemberAreas([pk]);
            se.broadcast({ type: 'member_joined', member: { publicKey: pk } });
            did('mid-join socket joins');
        }
        else if (r < 0.88) {
            // Rows written behind the map (as a database is before a boot), then the map loaded again whole, as at boot.
            for (let k = 0; k < 20; k++) {
                const p = rand() < 0.3 ? null : randomPoint();
                db.prepare('UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?').run(p?.lat ?? null, p?.lng ?? null, pick(members));
            }
            area.loadMemberAreas();
            did('map loaded again whole');
        }
        else { did('nothing'); }
    };

    const push = () => {
        const id = pick(posts);
        const kind = rand();
        const row = db.prepare('SELECT author_pubkey, lat, lng FROM posts WHERE id = ?').get(id) as { author_pubkey: string; lat: number | null; lng: number | null };
        const event = kind < 0.4 ? { type: 'new_post', post: { id, authorPublicKey: row.author_pubkey, title: 'x', lat: row.lat, lng: row.lng } }
            : kind < 0.8 ? { type: 'post_updated', id } : { type: 'post_removed', id };
        const opts = rand() < 0.15 ? { listingParties: [pick(members), pick(members)] } : undefined;
        return { event, opts };
    };
    const through = (index: boolean, p: { event: any; opts?: any }) => {
        se.setListingPushIndex(index);
        frames = [];
        const sent = se.broadcast(p.event, undefined, p.opts);
        return { sent, frames: [...frames].sort() };
    };

    const PUSHES = Number(process.env.PUSH_INDEX_PUSHES) || 1200;
    let differ = 0, reached = 0, emptyPushes = 0;
    const firstDiffs: string[] = [];
    inspect('setup');
    for (let i = 0; i < PUSHES; i++) {
        if (rand() < 0.5) { lastChange = 'nothing'; change(); inspect(lastChange); }
        const p = push();
        const full = through(false, p), indexed = through(true, p);
        inspect(`a ${p.event.type} push`);
        reached += full.frames.length;
        if (full.frames.length === 0) emptyPushes++;
        if (full.sent !== indexed.sent || full.frames.join('\n') !== indexed.frames.join('\n')) {
            differ++;
            if (firstDiffs.length < 3) {
                const a = new Set(full.frames), b = new Set(indexed.frames);
                firstDiffs.push(`push ${i} ${p.event.type} ${p.event.id ?? p.event.post?.id}: full ${full.frames.length}, index ${indexed.frames.length}; ` +
                    `missed ${full.frames.filter(f => !b.has(f)).length}, extra ${indexed.frames.filter(f => !a.has(f)).length}`);
            }
        }
    }
    se.setListingPushIndex(true);
    say(`   changes between pushes: ${JSON.stringify(changes)}`);
    for (const d of firstDiffs) say(`   ${d}`, true);
    for (const what of ['connect', 'disconnect', 'dies on a send', 'area set or moved', 'area cleared', 'area imported',
        're-key, the new phone connects', 'member removed', 'mid-join socket joins', 'map loaded again whole']) {
        assert((changes[what] ?? 0) > 0, `the run made the change "${what}" (${changes[what] ?? 0} times)`);
    }
    assert(reached > PUSHES, `the pushes reached sockets: ${reached} frames over ${PUSHES} pushes (${emptyPushes} reached none)`);
    assert(differ === 0, `${PUSHES} pushes: the index and the full loop send the same frames to the same sockets (${differ} differ; seed ${SEED})`);
    for (const e of brokenExamples) say(`   ${e}`, true);
    assert(Object.keys(broken).length === 0,
        `the index kept its rules after each of ${inspections} changes and pushes (broken after: ${JSON.stringify(broken)}; seed ${SEED})`);

    // Every socket closes: nothing stays filed. A push by area first, so the cells are built and hold keys.
    se.broadcast({ type: 'post_updated', id: posts.find(id => (db.prepare('SELECT lat FROM posts WHERE id = ?').get(id) as any).lat != null)! });
    const before = se.inspectWsClients();
    assert(before.filed > 0 && before.keys > 0, `before the close: ${before.sockets} sockets, ${before.keys} keys, ${before.filed} filed in ${before.bands} bands`);
    for (const ws of live()) close(ws);
    const after = se.inspectWsClients();
    assert(after.sockets === 0 && after.keys === 0 && after.filed === 0 && after.bands === 0 && after.problems.length === 0,
        `every socket closed: the index is empty (${after.sockets} sockets, ${after.keys} keys, ${after.filed} filed, ${after.bands} bands; ${after.problems.length} problems)`);

    // ── 2b. who writes a socket's key ───────────────────────────────────────────────────────────
    // Outside the tests, only the connect (https-server.ts, before addWsClient) and setKey (ws-area-index.ts) may.
    const KEY_WRITE = /_memberPubkey['"`\]]{0,2}\s*(=(?!=)|\?\?=|\|\|=|&&=)|defineProperty\([^)]*_memberPubkey|Object\.assign\(\s*ws\b|Object\.assign\([^)]*_memberPubkey/;
    // The scan is only as good as its pattern: every shape of write is caught, and no read is (#1809's check, N1: the
    // bracket forms and an Object.assign onto another name slipped past it).
    const writeShapes = [
        `ws._memberPubkey = k;`,
        `(ws as any)._memberPubkey = k;`,
        `ws._memberPubkey ??= k;`,
        `Object.assign(ws, { _memberPubkey: k });`,
        `ws['_memberPubkey'] = k;`,
        `(ws as any)['_memberPubkey'] = k;`,
        `Object.assign(sock, { _memberPubkey: k });`,
    ];
    const readShapes = [`if (ws._memberPubkey === k) return;`, `const k = (ws as any)['_memberPubkey'];`, `if (ws['_memberPubkey'] !== k) return;`];
    const missed = writeShapes.filter(l => !KEY_WRITE.test(l)), misread = readShapes.filter(l => KEY_WRITE.test(l));
    assert(missed.length === 0 && misread.length === 0,
        `the scan's pattern catches all ${writeShapes.length} shapes of write and none of ${readShapes.length} reads (missed: ${missed.join(' | ') || 'none'}; read as a write: ${misread.join(' | ') || 'none'})`);
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const writes: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full); continue; }
            if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || entry.name.startsWith('test-')) continue;
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, n) => {
                if (KEY_WRITE.test(line)) {
                    writes.push(`${path.relative(srcDir, full)}:${n + 1}`);
                }
            });
        }
    };
    walk(srcDir);
    const allowed = writes.filter(w => /^(https-server|ws-area-index)\.ts:/.test(w));
    assert(writes.length === 2 && allowed.length === 2,
        `a socket's key is written only at the connect and by wsClients.setKey: ${writes.join(', ')}`);

    // ── 3. the cost ─────────────────────────────────────────────────────────────────────────────
    if (process.env.PUSH_INDEX_COST !== '0') {
        const hubPost = crypto.randomUUID(), oceanPost = crypto.randomUUID();
        insertPost.run(hubPost, 'At a dense spot', pick(members), null, HUBS[0].lat, HUBS[0].lng);
        insertPost.run(oceanPost, 'In the South Pacific', pick(members), null, -48.9, -123.4);
        const costAt = (n: number) => {
            while (live().length < n) connect(pick(members));
            while (live().length > n) close(live()[live().length - 1]);
            const uptime = execFileSync('uptime', { encoding: 'utf8' }).trim();
            for (const [what, id] of [['a dense spot', hubPost], ['an empty ocean', oceanPost]] as const) {
                const times: Record<'full' | 'index', number[]> = { full: [], index: [] };
                let sentFull = 0, sentIndex = 0;
                for (let i = 0; i < 41; i++) {
                    for (const index of i % 2 === 0 ? [false, true] : [true, false]) {
                        se.setListingPushIndex(index);
                        frames = [];
                        const t0 = process.hrtime.bigint();
                        const sent = se.broadcast({ type: 'post_updated', id });
                        (index ? times.index : times.full).push(Number(process.hrtime.bigint() - t0) / 1e6);
                        if (index) sentIndex = sent; else sentFull = sent;
                    }
                }
                se.setListingPushIndex(true);
                const full = median(times.full), idx = median(times.index);
                say(`   ${n.toLocaleString('en')} sockets, ${what}: full loop ${full.toFixed(3)} ms a push, index ${idx.toFixed(3)} ms (reached ${sentIndex}); medians of 41, interleaved; ${uptime}`);
                assert(sentFull === sentIndex, `${n} sockets, ${what}: both reach ${sentIndex}`);
            }
        };
        costAt(3500);
        costAt(10000);
    }

    say(`${passed}/${run} checks passed (seed ${SEED}).`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ listing pushes through the index equal the full loop: PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
