/**
 * A visitor's board read on the global node costs what the visitor gets, and says exactly what it said before.
 *
 * Found in the global node's load rehearsal (scratch/global-node/REPORT-global-load-rehearsal.md §4, NODE_PROFILE=global,
 * 6,400 members, 2,400 with a photo): one unsigned board read cost about 10 ms of CPU, so the droplet served 35-50 a
 * second. Per post on the page the read compiled the author's trust profile's six statements (`db.prepare` in per-row
 * helpers, 40% of the read), read the author's photo out of their row and hashed it for a keyed face URL (a KeyObject
 * per HMAC, 16%), and counted the author's trades: all of it for a visitor, whose copy (the engine's guestPost) then put
 * a neutral value in place of each. The read now leaves those out for a visitor (@beanpool/engine PostFilter.guest),
 * compiles each statement once per database (statements.ts), and keys faces with one KeyObject (engine/avatar-keys.ts).
 *
 * Boots the real server on the global profile and reads through the real middleware over HTTP, a visitor unsigned:
 *   1. The same bytes: for the board, a deeper page, the map (circles, and one pass with a radius), a search, the whole
 *      feed with polls and events, a sync read (hidden and off-board listings as removals and paused) and a delta, the
 *      visitor's body is the oracle's, byte for byte: the same read without `guest` (as origin/main reads it), then
 *      guestPost on each post, as the route did. The seed has every kind of author (a photo, a badge, a vouch, trades
 *      completed, an enterprise paused) and of listing (photos, a poll, an event, one spoken for, one hidden by reports).
 *   2. What a visitor's read does: a warm board read of 50 posts by 50 authors compiles a handful of statements (on
 *      origin/main one per author per trust-profile query, hundreds), and none of the statements a visitor's reads
 *      compile reads an author's photo (member_photos, or its reference members.avatar_ref). A member's warm read compiles no statement per post, and still
 *      carries each author's standing and keyed face, which follow a change (a tier badge) at once.
 *   3. The CPU a visitor's board read costs, measured over 200 reads in this process (client included) and printed, held
 *      to a loose bound: origin/main measured above it on an M4 Pro (see the PR), this change well under.
 *
 * On origin/main sections 2 and 3 fail; section 1 passes there by design (it pins the bytes).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-guest-board-cost.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { localFetch } from './keepalive-test-fetch.js';

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
function signedHeaders(id: Id, method: string, path: string, body = ''): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}

async function main() {
    console.log("A visitor's board read costs what the visitor gets...\n");
    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { guestPost, ONE_PASS_MAX_MEASURED, setMemberPhoto } = await import('@beanpool/engine');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    const BASE = `http://127.0.0.1:${httpPort}`;
    // Every read below from one address: the gateway's visitor limit is another suite's.
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    // ── the seed ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
    const insertMemberRow = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', ?, 'seed', 'seed')`);
    const insertMember = { run: (pk: string, callsign: string, joinedAt: string, avatar: string) => { insertMemberRow.run(pk, callsign, joinedAt); setMemberPhoto(db, pk, avatar); } };
    const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)');
    // A photo as the apps store one: a JPEG data URL of about 20 KB.
    const photo = () => `data:image/jpeg;base64,/9j/${crypto.randomBytes(15_000).toString('base64')}`;
    const authors: Id[] = [];
    for (let i = 0; i < 50; i++) {
        const id = keypair();
        insertMember.run(id.pubKeyHex, `Author${i}`, iso(-(60 + i) * 86_400_000), photo());
        insertAccount.run(id.pubKeyHex);
        authors.push(id);
    }
    const reader = keypair();
    insertMember.run(reader.pubKeyHex, 'BoardReader', iso(-90 * 86_400_000), photo());
    insertAccount.run(reader.pubKeyHex);
    // Standing: badges, a vouch, ratings.
    for (let i = 0; i < 50; i += 5) se.adminSetTier(authors[i].pubKeyHex, i % 10 === 0 ? 'Resident' : 'Steward');
    db.prepare('UPDATE members SET elder_vouched_by = ?, vouch_credit = 50 WHERE public_key = ?').run(authors[0].pubKeyHex, authors[3].pubKeyHex);

    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at,
                active, status, lat, lng, accepted_by, accepted_at, pending_transaction_id, poll_options, poll_closes_at,
                event_start_at, event_end_at, event_place_name, event_private_note, event_state, hidden_by_reports_at)
                VALUES (@id, @type, @category, @title, @description, @credits, @author, @at, @at, 1, @status, @lat, @lng, @acceptedBy,
                        @acceptedAt, @pendingTx, @pollOptions, @pollClosesAt, @eventStart, @eventEnd, @eventPlace, @eventNote, @eventState, @hidden)`);
    const base = { credits: 0, status: 'active', acceptedBy: null, acceptedAt: null, pendingTx: null, pollOptions: null, pollClosesAt: null,
        eventStart: null, eventEnd: null, eventPlace: null, eventNote: null, eventState: null, hidden: null };
    const cats = ['food', 'goods', 'services', 'skills', 'housing', 'transport'];
    const postIds: string[] = [];
    for (let i = 0; i < 60; i++) {
        const id = `gbc-post-${i}`;
        insertPost.run({ ...base, id, type: i % 4 === 3 ? 'need' : 'offer', category: cats[i % cats.length],
            title: `Listing ${i} lemons and ladders`, description: `A listing written for the guest board suite, number ${i}.`,
            author: authors[i % 50].pubKeyHex, at: iso(-i * 60_000), lat: -28.55 + ((i * 37) % 100) / 100 - 0.5, lng: 153.5 + ((i * 53) % 100) / 100 - 0.5 });
        postIds.push(id);
    }
    const insertPhoto = db.prepare('INSERT INTO post_photos (post_id, order_num, photo_data) VALUES (?, ?, ?)');
    for (let i = 0; i < 60; i += 7) { insertPhoto.run(postIds[i], 0, 'data:image/jpeg;base64,/9j/AAAA'); insertPhoto.run(postIds[i], 1, 'data:image/jpeg;base64,/9j/BBBB'); }
    // Completed trades, so authors have a trade count and a trust profile with value in it.
    const insertTrade = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`);
    for (let i = 0; i < 40; i++) insertTrade.run(`gbc-trade-${i}`, postIds[i], authors[(i + 1) % 50].pubKeyHex, authors[i % 50].pubKeyHex, 10 + i, iso(-86_400_000), iso(-86_400_000));
    // One spoken for, a poll with votes, an event with RSVPs, one hidden by reports, an enterprise paused.
    insertPost.run({ ...base, id: 'gbc-pending', type: 'offer', category: 'goods', title: 'Spoken for', description: 'Pending trade.',
        author: authors[1].pubKeyHex, at: iso(-30_000), lat: -28.6, lng: 153.4, status: 'pending', acceptedBy: authors[2].pubKeyHex, acceptedAt: iso(-20_000), pendingTx: 'gbc-ptx' });
    insertPost.run({ ...base, id: 'gbc-poll', type: 'poll', category: 'general', title: 'Which day for the market?', description: 'A poll.',
        author: authors[4].pubKeyHex, at: iso(-40_000), lat: -28.5, lng: 153.5,
        pollOptions: JSON.stringify([{ id: 'a', text: 'Saturday' }, { id: 'b', text: 'Sunday' }]), pollClosesAt: iso(86_400_000) });
    for (let i = 0; i < 5; i++) db.prepare("INSERT INTO poll_votes (post_id, voter_pubkey, option_id, signature) VALUES ('gbc-poll', ?, ?, 'sig')").run(authors[10 + i].pubKeyHex, i % 2 ? 'a' : 'b');
    insertPost.run({ ...base, id: 'gbc-event', type: 'event', category: 'general', title: 'Seed swap', description: 'An event.',
        author: authors[5].pubKeyHex, at: iso(-50_000), lat: -28.52, lng: 153.48, eventStart: iso(3 * 86_400_000), eventEnd: iso(3 * 86_400_000 + 7_200_000),
        eventPlace: '12 Example Street', eventNote: 'Bring a bag', eventState: 'scheduled' });
    for (let i = 0; i < 4; i++) db.prepare("INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES ('gbc-event', ?, ?, 'sig')").run(authors[20 + i].pubKeyHex, i % 2 ? 'going' : 'interested');
    insertPost.run({ ...base, id: 'gbc-hidden', type: 'offer', category: 'goods', title: 'Reported', description: 'Hidden by reports.',
        author: authors[6].pubKeyHex, at: iso(-10_000), lat: -28.55, lng: 153.5, hidden: iso(-5_000) });
    db.prepare("UPDATE members SET is_treasury = 1, paused = 1 WHERE public_key = ?").run(authors[49].pubKeyHex);

    // ── the oracle: the read without `guest`, then guestPost, as the route did before ────────────────────────────────
    /** The route's listing for an unsigned read of `query` on the global node (routes/marketplace.ts, origin/main). */
    function oracle(query: Record<string, string>): string {
        const lat = query.lat !== undefined ? Number(query.lat) : undefined;
        const lng = query.lng !== undefined ? Number(query.lng) : undefined;
        const point = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
        const radiusKm = query.radiusKm !== undefined ? Number(query.radiusKm) : undefined;
        // distanceSortDefault is on for global: a point and no sort reads nearest first.
        const byDistance = !!point && (query.sort === 'distance' || query.sort === undefined);
        const limitN = Math.floor(Number(query.limit));
        const limit = Number.isFinite(limitN) && limitN > 0 ? Math.min(limitN, 200) : 50;
        const offsetN = Math.floor(Number(query.offset));
        const offset = Number.isFinite(offsetN) && offsetN > 0 ? offsetN : 0;
        const types = query.types ? ['offer', 'need', 'poll', 'event'].filter(t => query.types.split(',').some(q => q.trim() === t)) : undefined;
        const wantsEvents = query.type === 'event' || !!types?.includes('event');
        const posts = se.getPosts({
            id: undefined, type: query.type, types, excludeEvents: !wantsEvents, category: query.category, query: query.q,
            authorPubkey: undefined, viewerPubkey: undefined, beansOnly: false, audienceScope: undefined, targetGroupId: undefined,
            assignedTo: undefined, includeHidden: false, includeVoters: false, coarse: true,
            limit, offset, updatedAfter: query.updatedAfter, sync: query.sync === 'true',
            near: point ? { ...point, radiusKm } : undefined, sortByDistance: byDistance,
            measureAtMost: point ? ONE_PASS_MAX_MEASURED : undefined,
        });
        return JSON.stringify(posts.map(guestPost));
    }
    async function guestRead(query: Record<string, string>): Promise<{ status: number; text: string; view: string | null }> {
        const qs = new URLSearchParams(query).toString();
        const res = await localFetch(`${BASE}/api/marketplace/posts${qs ? `?${qs}` : ''}`, { headers: { 'cf-connecting-ip': '198.51.100.7' } });
        return { status: res.status, text: await res.text(), view: res.headers.get('x-beanpool-view') };
    }
    async function memberRead(id: Id, path = '/api/marketplace/posts'): Promise<{ status: number; text: string }> {
        const res = await localFetch(`${BASE}${path}`, { headers: { 'cf-connecting-ip': '198.51.100.8', ...signedHeaders(id, 'GET', path) } });
        return { status: res.status, text: await res.text() };
    }

    // Every statement compiled from here on, and the text of each.
    const compiled: string[] = [];
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { compiled.push(sql); return prepare(sql); };

    // ── 1. the same bytes ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('— 1. a visitor gets the same bytes as before —');
    const reads: Array<[string, Record<string, string>]> = [
        ['the board', {}],
        ['a deeper page', { limit: '20', offset: '15' }],
        ['the map, nearest first (circles)', { lat: '-28.55', lng: '153.5' }],
        ['the map with a radius (one pass)', { lat: '-28.4', lng: '153.3', radiusKm: '40' }],
        ['the map, most recent first', { lat: '-28.55', lng: '153.5', sort: 'recent' }],
        ['a search', { q: 'lemons' }],
        ['the whole feed with polls and events', { types: 'offer,need,poll,event', limit: '200' }],
        ['a category', { category: 'food' }],
        ['a sync read', { sync: 'true', limit: '200' }],
        ['a delta', { updatedAfter: iso(-35 * 60_000), limit: '200' }],
    ];
    let guestCompiled: string[] = [];
    for (const [what, query] of reads) {
        const before = compiled.length;
        const got = await guestRead(query);
        guestCompiled = guestCompiled.concat(compiled.slice(before));
        const want = oracle(query);
        const n = (() => { try { return JSON.parse(got.text).length; } catch { return -1; } })();
        assert(got.status === 200 && got.view === 'guest' && got.text === want,
            `${what}: the visitor's body is the oracle's, byte for byte (${got.status}, ${n} posts, ${got.text.length} bytes${got.text === want ? '' : `; oracle ${want.length} bytes`})`);
    }
    const allGuest = JSON.parse((await guestRead({ sync: 'true', limit: '200' })).text) as any[];
    assert(allGuest.some(p => p.id === 'gbc-hidden' && p.status === 'cancelled') && allGuest.some(p => p.authorPublicKey === 'hidden'),
        "the sync read holds the hidden listing as a removal, and every author as 'hidden'");

    // ── 2. what a visitor's read does ────────────────────────────────────────────────────────────────────────────────
    console.log("\n— 2. what a visitor's read compiles and reads —");
    const photoReads = guestCompiled.filter(sql => /avatar_url|avatar_ref|avatar_bytes|member_photos/.test(sql));
    assert(photoReads.length === 0,
        `no statement a visitor's reads compiled reads an author's photo (${photoReads.length} did${photoReads.length ? `: ${photoReads[0].replace(/\s+/g, ' ').slice(0, 120)}…` : ''})`);
    await guestRead({});
    let mark = compiled.length;
    const board = await guestRead({});
    const warmGuest = compiled.length - mark;
    assert(board.status === 200 && JSON.parse(board.text).length === 50 && warmGuest <= 10,
        `a warm board read of 50 posts by 50 authors compiles ${warmGuest} statements (at most 10; on origin/main hundreds, six a post for each author's trust profile)`);

    await memberRead(reader);
    mark = compiled.length;
    const mine = await memberRead(reader);
    const warmMember = compiled.length - mark;
    // The signature check and the member's own lookups compile a few of their own on every signed request.
    assert(mine.status === 200 && warmMember <= 25,
        `a member's warm board read compiles ${warmMember} statements, not one a post (at most 25 for 50 posts; on origin/main six a post)`);
    const memberPosts = JSON.parse(mine.text) as any[];
    const badged = memberPosts.find(p => p.authorPublicKey === authors[10].pubKeyHex);
    assert(!!badged && badged.authorEnergyCycled > 0 && typeof badged.authorAvatarUrl === 'string' && /[?&]k=/.test(badged.authorAvatarUrl),
        `a member still reads each author's standing and keyed face (Author10: ${badged?.authorEnergyCycled}, ${badged?.authorAvatarUrl?.slice(0, 40)}…)`);
    const plain = memberPosts.find(p => p.authorPublicKey === authors[11].pubKeyHex);
    const before11 = plain?.authorEnergyCycled;
    se.adminSetTier(authors[11].pubKeyHex, 'Steward');
    const after11 = (JSON.parse((await memberRead(reader)).text) as any[]).find(p => p.authorPublicKey === authors[11].pubKeyHex)?.authorEnergyCycled;
    assert(typeof before11 === 'number' && typeof after11 === 'number' && after11 > before11,
        `and a statement compiled once reads what is there now: a new badge shows at the next read (${before11} → ${after11})`);
    const face = badged?.authorAvatarUrl as string | undefined;
    const faceRes = face ? await localFetch(`${BASE}${face.replace(/^https?:\/\/[^/]+/, '')}`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }) : null;
    assert(!!faceRes && faceRes.status === 200, `the keyed face URL a member reads opens the photo (${faceRes?.status})`);
    if (faceRes) await faceRes.arrayBuffer();
    (db as any).prepare = prepare;

    // ── 3. the CPU a visitor's board read costs ──────────────────────────────────────────────────────────────────────
    console.log("\n— 3. the CPU a visitor's board read costs —");
    // No absolute time: a CPU time in ms doesn't carry from a laptop to a CI runner (6.63 ms on CI against 1.5 to 4.9 ms
    // here, and origin/main's 6.3 ms sits between them). What carries is a ratio inside one process, measured in
    // alternating rounds so a neighbour's burst lands on both: a visitor's read against a member's read of the same
    // board (a member's read still reads each author's standing and keyed face). On the head the ratio is 0.44 to 0.54;
    // on origin/main a visitor's read cost what a member's did (~1.0). The work itself is asserted exactly in §2.
    for (let i = 0; i < 20; i++) { await guestRead({}); await memberRead(reader); }
    const N = 40, ROUNDS = 7;
    const cpuOf = async (fn: () => Promise<unknown>): Promise<number> => {
        const c0 = process.cpuUsage();
        for (let i = 0; i < N; i++) await fn();
        const c = process.cpuUsage(c0);
        return (c.user + c.system) / 1000 / N;
    };
    const ratios: number[] = [], guestMs: number[] = [], memberMs: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
        const g = await cpuOf(() => guestRead({}));
        const m = await cpuOf(() => memberRead(reader));
        guestMs.push(g); memberMs.push(m); ratios.push(g / m);
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    const RATIO_BOUND = 0.85;
    assert(median(ratios) < RATIO_BOUND,
        `a visitor's board read costs ${median(ratios).toFixed(2)} of a member's (median of ${ROUNDS} alternating rounds; ${median(guestMs).toFixed(2)} against ${median(memberMs).toFixed(2)} ms of CPU each, client included), under ${RATIO_BOUND}`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
