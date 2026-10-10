/**
 * Listing pushes by area (DESIGN-global-sync-by-area §2.5, S2).
 *
 * On a node that syncs listings by area (the profile's `nearbyListings`, the global profile), a public listing's own
 * event (new_post, post_updated, post_removed) goes in full only to the sockets whose member's area is within the set's
 * radius (250 km) of the listing's place, and to its parties always: its author, the member who took it. Every other
 * socket gets nothing, not even a doorbell: one whose member is far, one whose member has no area, one with no member's
 * key. A listing with no place reaches its author alone. state_synced, member_joined, trades and messages are as before.
 * On a local community nothing changes: every member socket gets every listing.
 *
 * The real server in this process, real sockets over TLS, every listing and every area made over HTTP through the
 * signature middleware:
 *   1. sockets: Nia's member 11 km from the listings' place, Fay's 400 km, Noel's with no area, an unsigned one, and the
 *      author Ana's, whose own area is 400 km away
 *   2. a listing posted, edited and taken down: each event reaches Nia and Ana, never Fay, Noel or the unsigned socket
 *   3. an event that carries only the listing's id (a moderation doorbell) is measured the same way
 *   4. Fay moves next to the listings and Nia moves away, over HTTP, in this process: the next listing crosses sides
 *   5. a listing with no place (by Noel, who has no area): it reaches Noel alone
 *   6. the member who took a listing hears it from anywhere, as its author does, and so does an enterprise's keeper
 *   7. a bare doorbell for many listings, state_synced, a transfer, a message: as before
 *   8. a standby's copy in this process: an import of a member row whose area moved updates who hears a listing
 *   9. a member who re-keys: their area follows them to the new key, and their new phone hears the listings near it
 *  10. a member removed: their area leaves the map
 *  11. the cost: 3,500 sockets, the filter on against off, interleaved, with the load printed: a member's listing and an
 *      enterprise's, whose keepers are read once an event, never once a socket
 *  12. the local profile, in its own process: every member socket still gets every listing in full
 *
 * Run: pnpm exec node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-ws-nearby-push.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_ROLE;
delete process.env.NEARBY_LISTINGS_RADIUS_KM;
delete process.env.NEARBY_LISTINGS_MAX;
type Combo = 'global' | 'local';
const COMBO: Combo = (process.env.NEARBY_PUSH_COMBO as Combo | undefined) || 'global';
if (COMBO === 'local') delete process.env.NODE_PROFILE;
else process.env.NODE_PROFILE = 'global';
const BY_AREA = COMBO === 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { setMemberPhoto, haversineKm } from '@beanpool/engine';

const MODE = `[${COMBO}]`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${MODE} ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

// ── what this run started, stopped on any exit (test-visitor-doorbells' pattern) ──────────────────
const children = new Set<ChildProcess>();
const ownedDirs = new Set<string>();
process.on('exit', () => {
    for (const c of children) c.kill('SIGTERM');
    for (const d of ownedDirs) fs.rmSync(d, { recursive: true, force: true });
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
        console.error(`${MODE} ${sig}: stopping this run and every process it started`);
        process.exit(128 + os.constants.signals[sig]);
    });
}
if (process.env.NEARBY_PUSH_CHILD === '1') {
    if (process.env.BEANPOOL_DATA_DIR) ownedDirs.add(process.env.BEANPOOL_DATA_DIR);
    process.on('disconnect', () => process.exit(1));
    process.channel?.unref();
}

// ── members, signed requests and sockets ────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

let BASE = '';
let beforeCall: () => void = () => {};
async function call(id: Id, urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
    beforeCall();
    const raw = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${urlPath}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
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
/** What a socket got since it was last cleared, the connect greeting (state_snapshot) left out. */
function got(s: Sock): any[] {
    return s.raw.map(m => { try { return JSON.parse(m); } catch { return { type: '?' }; } }).filter(e => e.type !== 'state_snapshot');
}
const typesOf = (s: Sock) => new Set(got(s).map(e => e.type));
const show = (s: Sock) => JSON.stringify(got(s).map(e => e.type));
/** Waits until the socket has an event of this type, or 2 s, then for the rest of the same broadcast. */
async function until(s: Sock, type: string): Promise<void> {
    for (let i = 0; i < 40 && !typesOf(s).has(type); i++) await sleep(50);
    await sleep(150);
}
const LISTING_EVENTS = ['new_post', 'post_updated', 'post_removed'];
const listingEvents = (s: Sock) => got(s).filter(e => LISTING_EVENTS.includes(e.type));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// The listings' place, and the areas around it (each rounded to 0.1° by the node, as it stores them).
const PLACE = { lat: -28.5, lng: 153.5 };
const NEAR = { lat: -28.6, lng: 153.5 };   // 11 km
const FAR = { lat: -32.1, lng: 153.5 };    // 400 km
const FAR_W = { lat: -32.1, lng: 151.9 };  // Ana's, 400+ km

async function main(): Promise<void> {
    console.log(`\n=== Listing pushes by area ${MODE} ===\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const https = await import('./https-server.js');
    const { db, initSchema } = await import('./db/db.js');
    const { getProfileSwitches, nearbyListingsLimits } = await import('./config/node-profile.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    beforeCall = () => resetGatewayRateLimit();

    initSchema();
    await initTls();
    se.initStateEngine();
    const port = await https.startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    assert(getProfileSwitches().nearbyListings === BY_AREA, `setup: listings sync by area: ${getProfileSwitches().nearbyListings}`);
    const radiusKm = nearbyListingsLimits().radiusKm;
    assert(radiusKm === 250, `setup: the radius is ${radiusKm} km`);
    const km = (a: { lat: number; lng: number }) => haversineKm(a.lat, a.lng, PLACE.lat, PLACE.lng);
    assert(km(NEAR) < 15 && km(FAR) > 380 && km(FAR_W) > 380, `setup: Nia's area ${km(NEAR).toFixed(0)} km from the place, Fay's ${km(FAR).toFixed(0)}, Ana's ${km(FAR_W).toFixed(0)}`);

    const member = (callsign: string): Id => {
        const id = newId();
        // A profile photo, because posting needs one; joined long ago, so no new account's limits apply.
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, earned_credit)
                    VALUES (?, ?, ?, 'seed', 'seed', 'active', 10)`)
            .run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString());
        setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const setArea = async (id: Id, who: string, point: { lat: number; lng: number } | null) => {
        const r = await call(id, '/api/community/me/area', point ?? { lat: null, lng: null });
        assert(r.status === 200 && r.body?.success === true, `${who} sets an area over HTTP (got ${r.status} ${JSON.stringify(r.body).slice(0, 100)})`);
    };
    const ana = member('NearbyAna');
    const nia = member('NearbyNia');
    const fay = member('NearbyFay');
    const noel = member('NearbyNoel');
    await setArea(ana, 'Ana, 400 km away', FAR_W);
    await setArea(nia, 'Nia, 11 km away', NEAR);
    await setArea(fay, 'Fay, 400 km away', FAR);

    // ── 1. sockets ──────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the sockets ──');
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const S = {
        ana: await openSocket(`${wsBase}?${signedWsQuery(ana)}`),
        nia: await openSocket(`${wsBase}?${signedWsQuery(nia)}`),
        fay: await openSocket(`${wsBase}?${signedWsQuery(fay)}`),
        noel: await openSocket(`${wsBase}?${signedWsQuery(noel)}`),
        unsigned: await openSocket(wsBase),
    };
    const clear = () => { for (const s of Object.values(S)) s.raw.length = 0; };
    await sleep(200);
    clear();
    se.broadcast({ type: 'system_announcement', title: 'Nearby check', body: 'members only', level: 'info' });
    await until(S.noel, 'system_announcement');
    for (const who of ['ana', 'nia', 'fay', 'noel'] as const) assert(typesOf(S[who]).has('system_announcement'), `setup: ${who}'s socket is a member's`);
    assert(got(S.unsigned).length === 0, 'setup: the unsigned socket is no member\'s');

    /** Who of the five got this listing event, in full (with its post) or as an id. */
    const heard = (type: string, postId: string) => Object.fromEntries((Object.keys(S) as (keyof typeof S)[]).map(k =>
        [k, got(S[k]).some(e => e.type === type && (e.post?.id === postId || e.id === postId || (e.type === type && !e.post && !e.id)))]));
    const reachIs = (what: string, type: string, postId: string, expected: Record<string, boolean>) => {
        const h = heard(type, postId);
        const ok = Object.entries(expected).every(([k, v]) => h[k] === v);
        assert(ok, `${what}: ${Object.entries(expected).map(([k, v]) => `${k} ${v ? 'hears it' : 'nothing'}`).join(', ')} (got ${JSON.stringify(h)})`);
    };
    const everyone = { ana: true, nia: true, fay: true, noel: true };
    const near = BY_AREA ? { ana: true, nia: true, fay: false, noel: false, unsigned: false } : { ...everyone, unsigned: false };

    // ── 2. a listing posted, edited and taken down ──────────────────────────────────────────────
    console.log('\n── 2. a listing posted, edited and taken down over HTTP ──');
    clear();
    const made = await call(ana, '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Nearby offer', description: 'A nearby push offer', authorPublicKey: ana.pk, lat: PLACE.lat, lng: PLACE.lng,
    });
    const postId = made.body?.post?.id as string;
    assert(made.status === 200 && !!postId, `Ana posts at the place (got ${made.status} ${JSON.stringify(made.body).slice(0, 120)})`);
    await until(S.ana, 'new_post');
    reachIs('new_post', 'new_post', postId, near);
    assert(got(S.nia).some(e => e.type === 'new_post' && e.post?.title === 'Nearby offer'), 'Nia gets the listing itself, in full');
    assert(got(S.ana).some(e => e.type === 'new_post' && e.post?.title === 'Nearby offer'), "Ana's far socket gets her own listing, in full");
    if (BY_AREA) for (const who of ['fay', 'noel', 'unsigned'] as const) assert(listingEvents(S[who]).length === 0, `${who}'s socket gets no listing event at all, not even a doorbell (${show(S[who])})`);
    clear();
    const edited = await call(ana, '/api/marketplace/posts/update', { id: postId, authorPublicKey: ana.pk, description: 'A nearby push offer, edited' });
    assert(edited.status === 200, `Ana edits it (got ${edited.status})`);
    await until(S.ana, 'post_updated');
    reachIs('post_updated', 'post_updated', postId, near);
    if (BY_AREA) for (const who of ['fay', 'noel', 'unsigned'] as const) assert(listingEvents(S[who]).length === 0, `${who}'s socket gets nothing of the edit (${show(S[who])})`);

    // ── 3. an event that carries only the id ────────────────────────────────────────────────────
    console.log('\n── 3. an event with the id alone ──');
    clear();
    se.broadcast({ type: 'post_updated', id: postId });
    await until(S.ana, 'post_updated');
    reachIs('post_updated { id }', 'post_updated', postId, near);

    // ── 4. members who move cross sides ─────────────────────────────────────────────────────────
    console.log('\n── 4. Fay moves next to the listings, Nia moves away ──');
    await setArea(fay, 'Fay, now 11 km away', NEAR);
    await setArea(nia, 'Nia, now 400 km away', FAR);
    clear();
    const made2 = await call(ana, '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Nearby offer two', description: 'A second nearby push offer', authorPublicKey: ana.pk, lat: PLACE.lat, lng: PLACE.lng,
    });
    const post2 = made2.body?.post?.id as string;
    assert(made2.status === 200 && !!post2, `Ana posts a second listing (got ${made2.status})`);
    await until(S.ana, 'new_post');
    reachIs('after the moves, new_post', 'new_post', post2, BY_AREA ? { ana: true, nia: false, fay: true, noel: false, unsigned: false } : { ...everyone, unsigned: false });
    clear();
    const removed = await call(ana, '/api/marketplace/posts/remove', { id: postId, authorPublicKey: ana.pk });
    assert(removed.status === 200 && removed.body?.success === true, `Ana takes the first down (got ${removed.status})`);
    await until(S.ana, 'post_removed');
    reachIs('after the moves, post_removed', 'post_removed', postId, BY_AREA ? { ana: true, nia: false, fay: true, noel: false, unsigned: false } : { ...everyone, unsigned: false });

    // ── 5. a listing with no place ──────────────────────────────────────────────────────────────
    console.log('\n── 5. a listing with no place, by Noel, who has no area ──');
    clear();
    const placeless = await call(noel, '/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Placeless offer', description: 'An offer with no place', authorPublicKey: noel.pk,
    });
    const post3 = placeless.body?.post?.id as string;
    assert(placeless.status === 200 && !!post3, `Noel posts with no place (got ${placeless.status} ${JSON.stringify(placeless.body).slice(0, 120)})`);
    const row3 = db.prepare('SELECT lat, lng FROM posts WHERE id = ?').get(post3) as { lat: number | null; lng: number | null };
    assert(row3.lat === null && row3.lng === null, 'it is stored with no place');
    await until(S.noel, 'new_post');
    reachIs('a placeless new_post', 'new_post', post3, BY_AREA ? { ana: false, nia: false, fay: false, noel: true, unsigned: false } : { ...everyone, unsigned: false });

    // ── 6. the member who took a listing ────────────────────────────────────────────────────────
    console.log('\n── 6. the member who took a listing hears it from anywhere ──');
    db.prepare('UPDATE posts SET accepted_by = ?, status = ? WHERE id = ?').run(nia.pk, 'pending', post2);
    clear();
    se.broadcast({ type: 'post_updated', post: { id: post2, authorPublicKey: ana.pk, acceptedBy: nia.pk, title: 'Nearby offer two', lat: PLACE.lat, lng: PLACE.lng } });
    await until(S.ana, 'post_updated');
    reachIs('a taken listing\'s post_updated', 'post_updated', post2, BY_AREA ? { ana: true, nia: true, fay: true, noel: false, unsigned: false } : { ...everyone, unsigned: false });
    assert(got(S.nia).some(e => e.type === 'post_updated' && e.post?.acceptedBy === nia.pk), 'Nia, who took it, 400 km away, gets it with the deal on it');
    if (BY_AREA) assert(got(S.fay).some(e => e.type === 'post_updated' && e.post?.id === post2 && !e.post.acceptedBy), 'Fay, near it, gets it without the deal, as before');
    // An enterprise's listing at the place, and its keeper Kay 400 km away (the row as an enterprise's post makes it:
    // enterprises are off on the global profile, so not over HTTP).
    const ent = member('NearbyEnterprise');
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(ent.pk);
    const kay = member('NearbyKay');
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(kay.pk);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'keeper')").run(ent.pk, kay.pk);
    await setArea(kay, 'Kay, the enterprise\'s keeper, 400 km away', FAR);
    const entPost = `nearby-enterprise-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare("INSERT INTO posts (id, type, category, title, description, author_pubkey, lat, lng) VALUES (?, 'offer', 'other', 'Enterprise offer', 'An offer by an enterprise', ?, ?, ?)")
        .run(entPost, ent.pk, PLACE.lat, PLACE.lng);
    const kaySock = await openSocket(`${wsBase}?${signedWsQuery(kay)}`);
    await sleep(200);
    kaySock.raw.length = 0;
    clear();
    se.broadcast({ type: 'post_updated', id: entPost });
    await until(kaySock, 'post_updated');
    assert(got(kaySock).some(e => e.type === 'post_updated' && e.id === entPost), `Kay, the enterprise's keeper, 400 km away, hears its listing (${JSON.stringify(got(kaySock)).slice(0, 120)})`);
    reachIs("the enterprise's listing", 'post_updated', entPost, BY_AREA ? { ana: false, nia: false, fay: true, noel: false, unsigned: false } : { ...everyone, unsigned: false });
    kaySock.ws.close();

    // ── 7. what stays as before ─────────────────────────────────────────────────────────────────
    console.log('\n── 7. a bare listing doorbell, state_synced, a transfer, a message ──');
    clear();
    se.broadcast({ type: 'post_removed' });
    await until(S.noel, 'post_removed');
    for (const who of ['ana', 'nia', 'fay', 'noel'] as const) assert(typesOf(S[who]).has('post_removed'), `a bare post_removed (many listings, no one place) reaches ${who}, as before`);
    clear();
    se.broadcast({ type: 'state_synced', counts: {} });
    await until(S.noel, 'state_synced');
    for (const who of ['ana', 'nia', 'fay', 'noel', 'unsigned'] as const) assert(typesOf(S[who]).has('state_synced'), `state_synced reaches ${who}, as before`);
    clear();
    se.broadcast({ type: 'transaction', txn: { id: 'nearby-tx', from: noel.pk, to: fay.pk, amount: 1 } }, [noel.pk, fay.pk]);
    await until(S.fay, 'transaction');
    assert(typesOf(S.noel).has('transaction') && typesOf(S.fay).has('transaction'), 'a transfer reaches both its parties, area or none');
    assert(!typesOf(S.ana).has('transaction') && !typesOf(S.nia).has('transaction') && !typesOf(S.unsigned).has('transaction'), 'and no one else');
    clear();
    se.broadcast({ type: 'new_message', conversationId: 'nearby-conv', message: { id: 'm1', text: 'hi' } }, [noel.pk, nia.pk]);
    await until(S.nia, 'new_message');
    assert(typesOf(S.noel).has('new_message') && typesOf(S.nia).has('new_message'), 'a message reaches both its people, area or none');
    assert(!typesOf(S.ana).has('new_message') && !typesOf(S.fay).has('new_message'), 'and no one else');

    if (BY_AREA) {
        // ── 8. a standby's copy ─────────────────────────────────────────────────────────────────
        console.log("\n── 8. a standby's copy in this process: an imported member row moves who hears a listing ──");
        const { exportSyncState, importRemoteState, setNodeRole } = se;
        const { startP2P } = await import('./p2p.js');
        const { addConnector, removeConnector } = await import('./connector-manager.js');
        const p2p = await startP2P(0, 0);
        const nodeId = p2p.peerId.toString();
        const trusted = `/ip4/127.0.0.1/tcp/4019/p2p/${nodeId}`;
        // The main server's row: Noel's area near the listings.
        await setArea(noel, 'Noel, on the main server, 11 km away', NEAR);
        const payload = await exportSyncState(nodeId);
        assert((payload.members ?? []).some((m: any) => m.publicKey === noel.pk), "the copy carries Noel's row");
        // The standby's own row before the copy: no area, older; the map as a standby booted with it holds.
        db.prepare("UPDATE members SET area_lat = NULL, area_lng = NULL, area_updated_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?").run(noel.pk);
        const area = await import('./engine/member-area.js') as any;
        if (typeof area.loadMemberAreas === 'function') area.loadMemberAreas();
        clear();
        se.broadcast({ type: 'post_updated', id: post2 });
        await until(S.ana, 'post_updated');
        assert(!heard('post_updated', post2).noel, 'before the copy, Noel (no area on this standby) hears nothing of a listing');
        addConnector(trusted, 'mirror', 'nearby-self-test');
        setNodeRole('backup');
        await importRemoteState(payload);
        setNodeRole('primary');
        removeConnector(trusted);
        const stored = db.prepare('SELECT area_lat, area_lng FROM members WHERE public_key = ?').get(noel.pk) as { area_lat: number | null; area_lng: number | null };
        assert(stored.area_lat === NEAR.lat && stored.area_lng === NEAR.lng, `the import wrote Noel's area (${stored.area_lat}, ${stored.area_lng})`);
        clear();
        se.broadcast({ type: 'post_updated', id: post2 });
        await until(S.ana, 'post_updated');
        assert(heard('post_updated', post2).noel, 'after the copy, Noel hears the listing near his imported area');
        await p2p.stop();

        // ── 9. a member who re-keys ─────────────────────────────────────────────────────────────
        console.log('\n── 9. a member who re-keys, near the listings ──');
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const rex = member('NearbyRex');
        await setArea(rex, 'Rex, 11 km away', NEAR);
        const rexNew = newId();
        completeRekey(rex.pk, rexNew.pk, issueRekeyCode(rex.pk, 'owner:password').code, 'owner:password');
        await sleep(100);
        const mapOld = area.memberAreaFor?.(rex.pk), mapNew = area.memberAreaFor?.(rexNew.pk);
        assert(mapOld === undefined && mapNew?.lat === NEAR.lat && mapNew?.lng === NEAR.lng,
            `the map follows Rex's area to his new key (old ${JSON.stringify(mapOld)}, new ${JSON.stringify(mapNew)})`);
        const rexSock = await openSocket(`${wsBase}?${signedWsQuery(rexNew)}`);
        await sleep(200);
        rexSock.raw.length = 0;
        clear();
        const made4 = await call(ana, '/api/marketplace/posts', {
            type: 'offer', category: 'other', title: 'Nearby offer four', description: 'An offer after a re-key', authorPublicKey: ana.pk, lat: PLACE.lat, lng: PLACE.lng,
        });
        const post4 = made4.body?.post?.id as string;
        assert(made4.status === 200 && !!post4, `Ana posts at the place after Rex's re-key (got ${made4.status})`);
        await until(rexSock, 'new_post');
        assert(got(rexSock).some(e => e.type === 'new_post' && e.post?.id === post4 && e.post?.title === 'Nearby offer four'),
            `Rex's new phone, 11 km away, hears the listing in full (${show(rexSock)})`);
        rexSock.ws.close();

        // ── 10. a member removed ────────────────────────────────────────────────────────────────
        console.log('\n── 10. a member removed ──');
        const before = typeof area.memberAreaFor === 'function' ? area.memberAreaFor(fay.pk) : undefined;
        se.adminPruneUser(fay.pk, 'owner:password');
        await sleep(100);
        const after = typeof area.memberAreaFor === 'function' ? area.memberAreaFor(fay.pk) : 'no map';
        assert(!!before && after === undefined, `Fay's area leaves the map with her removal (${JSON.stringify(before)} → ${JSON.stringify(after)})`);

        // ── 11. the cost at 3,500 sockets ───────────────────────────────────────────────────────
        console.log('\n── 11. the cost: 3,500 member sockets, the filter on against off ──');
        for (const s of Object.values(S)) s.ws.close();
        await sleep(200);
        const fakes: any[] = [];
        const keys: string[] = [];
        const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, area_lat, area_lng)
                                   VALUES (?, ?, ?, 'seed', 'seed', 'active', ?, ?)`);
        db.transaction(() => {
            for (let i = 0; i < 3500; i++) {
                const pk = crypto.randomBytes(32).toString('hex');
                keys.push(pk);
                // Spread over the world, a tenth of them within 250 km of the place.
                const lat = i % 10 === 0 ? PLACE.lat + (Math.random() - 0.5) * 3 : -60 + Math.random() * 120;
                const lng = i % 10 === 0 ? PLACE.lng + (Math.random() - 0.5) * 3 : -180 + Math.random() * 360;
                insert.run(pk, `Load${i}`, new Date().toISOString(), Math.round(lat * 10) / 10, Math.round(lng * 10) / 10);
            }
        })();
        if (typeof area.loadMemberAreas === 'function') area.loadMemberAreas();
        let sends = 0;
        for (const pk of keys) {
            const f = { readyState: 1, _memberPubkey: pk, _memberFeed: true, send: () => { sends++; } };
            fakes.push(f);
            se.addWsClient(f);
        }
        const setSwitch = (on: boolean) => db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('nodeProfile.nearbyListings', ?)").run(on ? 'true' : 'false');
        const nearCount = keys.filter(pk => { const a = area.memberAreaFor?.(pk); return a && haversineKm(a.lat, a.lng, PLACE.lat, PLACE.lng) <= radiusKm; }).length;
        const costOf = (what: string, event: unknown) => {
            const timesOn: number[] = [], timesOff: number[] = [];
            let sentOn = 0, sentOff = 0;
            for (let i = 0; i < 31; i++) {
                for (const on of i % 2 === 0 ? [true, false] : [false, true]) {
                    setSwitch(on);
                    sends = 0;
                    const t0 = process.hrtime.bigint();
                    se.broadcast(event);
                    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                    (on ? timesOn : timesOff).push(ms);
                    if (on) sentOn = sends; else sentOff = sends;
                }
            }
            const load = os.loadavg()[0].toFixed(1);
            const on = median(timesOn), off = median(timesOff);
            console.log(`   ${what}: 3,500 sockets, ${nearCount} within ${radiusKm} km: on ${on.toFixed(2)} ms an event (sent ${sentOn}), off ${off.toFixed(2)} ms (sent ${sentOff}); medians of 31, interleaved; load ${load}`);
            assert(sentOff === 3500, `${what}, the switch off: every one of the 3,500 sockets gets it (${sentOff})`);
            assert(sentOn === nearCount, `${what}, the switch on: exactly the ${nearCount} within ${radiusKm} km get it (${sentOn})`);
            // The design's estimate is 2 ms an event (§2.5); a bound that load can't trip, and that a read per socket would.
            assert(on < 25, `${what}: the filter costs ${on.toFixed(2)} ms an event at 3,500 sockets (bound 25 ms; off ${off.toFixed(2)} ms; load ${load})`);
        };
        costOf("a member's listing", { type: 'post_updated', post: { id: post2, authorPublicKey: ana.pk, title: 'Nearby offer two', lat: PLACE.lat, lng: PLACE.lng } });
        costOf("an enterprise's listing", { type: 'post_updated', id: entPost });
        db.prepare("DELETE FROM node_config WHERE key = 'nodeProfile.nearbyListings'").run();
        for (const f of fakes) se.removeWsClient(f);
    } else {
        for (const s of Object.values(S)) s.ws.close();
    }

    // ── 12. the local profile, in its own process ───────────────────────────────────────────────
    if (process.env.NEARBY_PUSH_CHILD !== '1') {
        console.log('\n── 12. the local node, in its own process ──');
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-nearby-push-local-'));
        ownedDirs.add(dataDir);
        const env: NodeJS.ProcessEnv = { ...process.env, NEARBY_PUSH_COMBO: 'local', NEARBY_PUSH_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        children.add(child);
        const status = await new Promise<number | null>(resolve => {
            child.on('exit', code => resolve(code));
            child.on('error', () => resolve(null));
        });
        children.delete(child);
        fs.rmSync(dataDir, { recursive: true, force: true });
        ownedDirs.delete(dataDir);
        assert(status === 0, `the local run passed (exit ${status})`);
    }

    console.log(`\n${MODE} ${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ ${MODE} listing pushes by area: PASSED.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(`❌ ${MODE} Test failed:`, e); process.exit(1); });
